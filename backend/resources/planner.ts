import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type Graph = { originalGoal: string; nodes: { name: string; task: string }[]; edges: { from: string; to: string; feedback: boolean }[] };

type NodeEdit = { id: string; task?: string; delete?: boolean };
type EdgeEdit = { from: string; to: string; feedback?: boolean; delete?: boolean };
type Diagnostic = { code: string; message: string };

function stripDiagnosticCode(message: string): string {
  return message.replace(/^(?:\[?[A-Za-z]{1,5}[-_]?\d+\]?[:\-]?\s*)/, "");
}

function topology(graph: Graph, feedbackEnabled: boolean) {
  // Keep ordinary edges in the edge tool's from -> to direction, including
  // every node so an empty list explicitly means no outgoing ordinary edges.
  // Map is safe for arbitrary node names, including __proto__ and constructor.
  const ordinaryTo = new Map(graph.nodes.map(node => [node.name, [] as string[]]));
  const feedbackTo = new Map<string, string>();
  const unrepresentedEdges: Graph["edges"] = [];
  for (const edge of graph.edges) {
    if (edge.feedback && !feedbackEnabled) continue;
    // Valid graphs always have known endpoints and at most one feedback target
    // per source. Preserve anomalous saved/legacy edges rather than hiding them
    // if a rejected edit has to report an invalid pre-existing candidate.
    if (!ordinaryTo.has(edge.from) || !ordinaryTo.has(edge.to)
      || (edge.feedback && feedbackTo.has(edge.from))) {
      unrepresentedEdges.push(edge);
    } else if (edge.feedback) {
      feedbackTo.set(edge.from, edge.to);
    } else {
      ordinaryTo.get(edge.from)!.push(edge.to);
    }
  }
  return {
    "from: [to]": Object.fromEntries(ordinaryTo),
    ...(feedbackEnabled ? { feedbackTo: Object.fromEntries(feedbackTo) } : {}),
    ...(unrepresentedEdges.length ? { unrepresentedEdges: feedbackEnabled ? unrepresentedEdges
      : unrepresentedEdges.map(({ from, to }) => ({ from, to })) } : {}),
  };
}

// Disabled tools still validate the complete saved graph. Preserve the error
// (and its internal code), but do not reintroduce an unavailable protocol in a
// repair instruction. Existing routes must never be silently dropped to pass.
function diagnosticText(diagnostic: Diagnostic, feedbackEnabled: boolean): string {
  if (!feedbackEnabled && diagnostic.code === "E207") {
    return "This edit removes a dependency path required by a retained graph constraint. Add replacement dependency paths before removing existing ones, or ask the user to review the graph in the Graph IR editor. The graph is unchanged.";
  }
  if (!feedbackEnabled && diagnostic.code === "E208") {
    return "The saved graph contains incompatible retained routes. Ask the user to repair the graph in the Graph IR editor before continuing. The graph is unchanged.";
  }
  return stripDiagnosticCode(diagnostic.message)
    .replace(/^Node names\b/, "Node ids")
    .replace(/^Node name\b/, "Node id");
}

function duplicateTargets(field: "nodes" | "edges", targets: string[]): Diagnostic[] {
  const firstIndex = new Map<string, number>();
  const diagnostics: Diagnostic[] = [];
  targets.forEach((target, index) => {
    const first = firstIndex.get(target);
    if (first === undefined) firstIndex.set(target, index);
    else diagnostics.push({
      code: "duplicate-target",
      message: `${field}[${index}] repeats target ${target} from ${field}[${first}]. Supply one edit per target.`,
    });
  });
  return diagnostics;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseEditString(value: unknown): unknown[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (isRecord(parsed)) return [parsed];
  } catch { }
  return undefined;
}

function singleEdit(raw: JsonRecord, fields: readonly string[]): JsonRecord {
  const edit: JsonRecord = {};
  for (const field of fields) {
    if (raw[field] !== undefined) edit[field] = raw[field];
  }
  return edit;
}

function normalizeEdits(raw: unknown, key: "nodes" | "edges", required: readonly string[], fields: readonly string[]): unknown {
  if (Array.isArray(raw)) return { [key]: raw };
  if (!isRecord(raw)) return raw;
  const value = raw[key];
  const hasSingle = required.every(field => raw[field] !== undefined && raw[field] !== null);
  let list: unknown[] | undefined;
  if (Array.isArray(value)) list = value;
  else if (isRecord(value)) list = [value];
  else list = parseEditString(value);
  // Models often omit the one-element batch wrapper, or send a bare edit next
  // to an empty batch. Treat the single edit as the intended payload.
  if (hasSingle && (list === undefined || list.length === 0)) list = [singleEdit(raw, fields)];
  return list === undefined ? raw : { [key]: list };
}

// Older Planner sessions may replay node calls using `name`. Keep that
// input compatible without exposing it in the current tool schema.
function nodeIdAlias(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, "name")) return value;
  if (Object.hasOwn(value, "id")) throw new Error('Invalid node edit: supply "id", not both "id" and legacy "name".');
  const { name, ...rest } = value;
  return { ...rest, id: name };
}

// Project old tool-call arguments to the current Planner vocabulary without
// rewriting stored sessions or interpreting task text as graph metadata.
function plannerHistoryArguments(value: unknown, tool: "node" | "switch_workspace"): unknown {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      const projected = plannerHistoryArguments(parsed, tool);
      return projected === parsed ? value : JSON.stringify(projected);
    } catch { return value; }
  }
  if (Array.isArray(value)) {
    const items = value.map(item => plannerHistoryArguments(item, tool));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!isRecord(value)) return value;
  let projected = value;
  const legacy = tool === "node" ? "name" : "node";
  if (Object.hasOwn(value, legacy)) {
    const { [legacy]: oldId, ...rest } = value;
    projected = { ...rest, id: Object.hasOwn(value, "id") ? value.id : oldId };
  }
  if (tool === "node" && Object.hasOwn(value, "nodes")) {
    const nodes = plannerHistoryArguments(value.nodes, tool);
    if (nodes !== value.nodes) projected = { ...projected, nodes };
  }
  return projected;
}

function describeShape(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return keys.length ? `an object with keys ${keys.join(", ")}` : "an empty object";
  }
  return value === null ? "null" : typeof value;
}

// Keep this item-level pass in sync with the TypeBox schema: it runs before
// Pi's validator so invalid edits never reach the generic error path.
function normalizeEdit(
  raw: unknown,
  label: string,
  required: readonly string[],
  fields: readonly string[],
  booleanFields: readonly string[],
  example: string,
): JsonRecord {
  if (!isRecord(raw)) {
    throw new Error(`Invalid ${label} edit. Expected an object. Received ${describeShape(raw)}.`);
  }
  const allowed = new Set(fields);
  const unsupported = Object.keys(raw).filter(field => !allowed.has(field));
  if (unsupported.length) {
    throw new Error(`Invalid ${label} edit: unsupported field(s) ${unsupported.join(", ")}. Allowed fields: ${fields.join(", ")}. Expected ${example}.`);
  }
  const optionalStrings = fields.filter(field => !required.includes(field) && !booleanFields.includes(field));
  const edit: JsonRecord = {};
  for (const field of required) {
    const value = raw[field];
    if (typeof value === "string") edit[field] = value;
    else if (typeof value === "number" || typeof value === "boolean") edit[field] = String(value);
    else throw new Error(`Invalid ${label} edit: "${field}" must be a string. Expected ${example}.`);
  }
  for (const field of optionalStrings) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") edit[field] = value;
    else if (typeof value === "number" || typeof value === "boolean") edit[field] = String(value);
    else throw new Error(`Invalid ${label} edit: "${field}" must be a string. Expected ${example}.`);
  }
  for (const field of booleanFields) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") edit[field] = value;
    else if (value === "true" || value === "false") edit[field] = value === "true";
    else if (value === 1 || value === 0) edit[field] = value === 1;
    else throw new Error(`Invalid ${label} edit: "${field}" must be a boolean. Expected ${example}.`);
  }
  return edit;
}

// Pi validates parameters before execute(), and its generic validator reports
// shape mismatches as `schema is false` / `must have required properties`.
// Normalize the common single-edit variants here so the model's intent wins,
// and keep the canonical wire schema array-only so strict providers still
// generate the batch shape.
function editArguments(
  raw: unknown,
  key: "nodes" | "edges",
  required: readonly string[],
  fields: readonly string[],
  example: string,
): any {
  const label = key === "nodes" ? "node" : "edge";
  const parsed = key === "nodes" ? nodeIdAlias(parseArguments(raw)) : parseArguments(raw);
  if (isRecord(parsed)) {
    const allowed = new Set([key, ...fields]);
    const unsupported = Object.keys(parsed).filter(field => !allowed.has(field));
    if (unsupported.length) {
      throw new Error(`Invalid ${label} call: unsupported field(s) ${unsupported.join(", ")}. Expected ${example}.`);
    }
  }
  const normalized = normalizeEdits(parsed, key, required, fields);
  if (!isRecord(normalized) || !Array.isArray(normalized[key])) {
    throw new Error(`Invalid ${label} call. Expected ${example}. Received ${describeShape(parsed)}.`);
  }
  if (normalized[key].length === 0) {
    throw new Error(`Invalid ${label} call: ${key} must contain at least one edit. Expected ${example}.`);
  }
  const booleanFields = fields.filter(field => field === "feedback" || field === "delete");
  const edits = normalized[key].map(edit => normalizeEdit(key === "nodes" ? nodeIdAlias(edit) : edit, label, required, fields, booleanFields, example));
  return { [key]: edits };
}

function applyNode(graph: Graph, edit: NodeEdit): Graph["edges"] {
  graph.nodes = graph.nodes.filter(node => node.name !== edit.id);
  if (edit.delete) {
    const removed = graph.edges.filter(edge => edge.from === edit.id || edge.to === edit.id);
    if (removed.length > 0) {
      graph.edges = graph.edges.filter(edge => edge.from !== edit.id && edge.to !== edit.id);
    }
    return removed;
  }
  graph.nodes.push({ name: edit.id, task: edit.task ?? "" });
  return [];
}

function applyEdge(graph: Graph, edit: EdgeEdit): boolean {
  const before = graph.edges.length;
  graph.edges = graph.edges.filter(edge => edge.from !== edit.from || edge.to !== edit.to);
  if (!edit.delete) {
    graph.edges.push({ from: edit.from, to: edit.to, feedback: edit.feedback ?? false });
    return true;
  }
  return graph.edges.length < before;
}

function alternateDependencyPath(edges: Graph["edges"], from: string, to: string): string[] | undefined {
  const queue = [from];
  const previous = new Map<string, string | undefined>([[from, undefined]]);
  while (queue.length > 0) {
    const name = queue.shift()!;
    const neighbors = Array.from(new Set(
      edges
        .filter(edge => !edge.feedback && edge.from === name && !(edge.from === from && edge.to === to))
        .map(edge => edge.to),
    )).sort();
    for (const next of neighbors) {
      if (previous.has(next)) continue;
      previous.set(next, name);
      if (next === to) {
        const path = [next];
        let current: string | undefined = next;
        while ((current = previous.get(current)) !== undefined) path.push(current);
        path.reverse();
        return path;
      }
      queue.push(next);
    }
  }
  return undefined;
}

function isDependencyDag(graph: Graph): boolean {
  const names = new Set(graph.nodes.map(node => node.name));
  if (names.size !== graph.nodes.length) return false;
  const degrees = new Map<string, number>(graph.nodes.map(node => [node.name, 0]));
  const outgoing = new Map<string, string[]>(graph.nodes.map(node => [node.name, []]));
  for (const edge of graph.edges) {
    if (!names.has(edge.from) || !names.has(edge.to) || edge.from === edge.to) return false;
    if (edge.feedback) continue;
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const ready = Array.from(degrees.entries()).filter(([, degree]) => degree === 0).map(([name]) => name);
  let visited = 0;
  while (ready.length > 0) {
    const name = ready.shift()!;
    visited++;
    for (const next of outgoing.get(name) ?? []) {
      const remaining = degrees.get(next)! - 1;
      degrees.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  return visited === names.size;
}

function pruneRedundantEdges(graph: Graph): { from: string; to: string; path: string[] }[] {
  if (!isDependencyDag(graph)) return [];
  const removed: { from: string; to: string }[] = [];
  const kept: Graph["edges"] = [];
  const candidates = graph.edges.slice();
  for (let index = 0; index < candidates.length; index++) {
    const edge = candidates[index];
    if (edge.feedback) {
      kept.push(edge);
      continue;
    }
    const remaining = [...kept, ...candidates.slice(index + 1)];
    if (alternateDependencyPath(remaining, edge.from, edge.to)) {
      removed.push({ from: edge.from, to: edge.to });
    } else {
      kept.push(edge);
    }
  }
  if (removed.length === 0) return [];
  graph.edges = kept;
  // Recompute alternate paths against the final reduced graph so every edge
  // cited in the explanation exists in the returned topology.
  return removed.map(edge => ({
    ...edge,
    path: alternateDependencyPath(kept, edge.from, edge.to) ?? [edge.from, edge.to],
  }));
}

export default function grapherPlanner(pi: ExtensionAPI) {
  const graphPath = process.env.GRAPHER_GRAPH_PATH!;
  const feedbackEnabled = process.env.GRAPHER_FEEDBACK_ENABLED === "true";
  // Runtime-owned constraint: node names this run may not remove because their
  // results are already published. Graph structure cannot express it, so the
  // server passes it beside the graph and the edit is rejected where the
  // Planner can still react instead of failing the commit afterwards.
  const unremovableNodes: string[] = JSON.parse(process.env.GRAPHER_UNREMOVABLE_NODES ?? '[]');
  const result = (text: string, diagnosticCodes?: string[]) => ({
    content: [{ type: "text" as const, text }],
    ...(diagnosticCodes ? { details: { diagnosticCodes } } : {}),
  } as any);
  // Pi derives execution errors from tool_result hooks, not an isError property
  // returned by execute. Keep diagnostic codes in internal details only.
  pi.on("context", event => {
    let changed = false;
    // Provider signatures can bind an assistant turn's original content. Do
    // not change any of its tool calls, or their corresponding tool results.
    const signedCalls = new Set<string>();
    for (const message of event.messages) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      if (!message.content.some(part => isRecord(part)
        && ["thoughtSignature", "thinkingSignature", "textSignature"].some(key => typeof part[key] === "string" && part[key] !== ""))) continue;
      for (const part of message.content) if (part.type === "toolCall") signedCalls.add(part.id);
    }
    const messages = event.messages.map(message => {
      if (message.role === "toolResult" && message.toolName === "switch_workspace"
        && !signedCalls.has(message.toolCallId) && Array.isArray(message.content)) {
        let edited = false;
        const content = message.content.map(part => {
          if (part.type !== "text") return part;
          try {
            const value: unknown = JSON.parse(part.text);
            if (!isRecord(value) || (!Object.hasOwn(value, "requestedNode") && !Object.hasOwn(value, "actualNode"))) return part;
            const { requestedNode, actualNode, ...rest } = value;
            edited = true;
            return {
              ...part, text: JSON.stringify({
                ...rest,
                ...(requestedNode !== undefined ? { requestedId: requestedNode } : {}),
                ...(actualNode !== undefined ? { actualId: actualNode } : {}),
              })
            };
          } catch { return part; }
        });
        if (!edited) return message;
        changed = true;
        return { ...message, content };
      }
      if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
      let edited = false;
      const content = message.content.map(part => {
        if (part.type !== "toolCall" || signedCalls.has(part.id)
          || (part.name !== "node" && part.name !== "switch_workspace")) return part;
        const args = plannerHistoryArguments(part.arguments, part.name);
        if (args === part.arguments) return part;
        edited = true;
        return { ...part, arguments: args as typeof part.arguments };
      });
      if (!edited) return message;
      changed = true;
      return { ...message, content };
    });
    return changed ? { messages } : undefined;
  });
  pi.on("tool_result", async event => {
    if ((event.toolName === "node" || event.toolName === "edge")
      && (event.details as { diagnosticCodes?: string[] } | undefined)?.diagnosticCodes) {
      return { isError: true };
    }
  });
  // Runtime publishes one live committed-graph snapshot per tool start. The
  // filename is bounded even for provider IDs containing separators or very
  // long strings; the response also carries the full ID to detect collisions.
  function revisionContextPath(id: string): string {
    let hash = 0xcbf29ce484222325n;
    for (const byte of Buffer.from(id, "utf8")) {
      hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    }
    return `${graphPath}.impact-${hash.toString(16).padStart(16, "0")}.json`;
  }
  async function revisionContext(id: string, signal?: AbortSignal): Promise<unknown | undefined> {
    if (!process.env.GRAPHER_PLANNER_RUN_ID) return;
    const path = revisionContextPath(id);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Operation aborted");
      try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (isRecord(value) && value.toolCallId === id && isRecord(value.revisionContext)) {
          try { unlinkSync(path); } catch { }
          return value.revisionContext;
        }
      } catch { }
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  // The shared engine policy owns read/bash and their stable path view.
  // Keep this extension limited to graph mutations, regardless of cwd.
  async function mutate(id: string, signal: AbortSignal | undefined, kind: "node" | "edge", change: (graph: Graph, editNotes: string[]) => Diagnostic[] | void) {
    const revision = await revisionContext(id, signal);
    const saved: Graph = JSON.parse(readFileSync(graphPath, "utf8"));
    const graph: Graph = structuredClone(saved);
    const rejected = (diagnostics: Diagnostic[]) => result(JSON.stringify({
      applied: false,
      topology: topology(saved, feedbackEnabled),
      diagnostics: diagnostics.map(diagnostic => diagnosticText(diagnostic, feedbackEnabled)),
    }), diagnostics.map(diagnostic => diagnostic.code));
    const editNotes: string[] = [];
    const inputErrors = change(graph, editNotes);
    if (inputErrors?.length) return rejected(inputErrors);
    const pruned = kind === "edge" ? pruneRedundantEdges(graph) : [];
    const checked = spawnSync(process.env.GRAPHER_COMPILER_PATH!, ["--compile"], { input: JSON.stringify({ graph, finalCheck: false, unremovableNodes, ...(revision ? { revisionContext: revision } : {}) }), encoding: "utf8", timeout: 10000 });
    if (checked.error || checked.status !== 0) return rejected([{ code: "compiler-unavailable", message: checked.error?.message || checked.stderr || `Compiler exited with status ${checked.status}` }]);
    let output;
    try { output = JSON.parse(checked.stdout); }
    catch { return rejected([{ code: "compiler-response", message: "Compiler returned invalid JSON." }]); }
    if (output.diagnostics?.length) return rejected(output.diagnostics);
    if (!output.plan) return rejected([{ code: "compiler-response", message: "Compiler returned no plan." }]);
    writeFileSync(graphPath, JSON.stringify(graph));
    // Omit conditional feedback rerun-scope descriptions from both tools.
    // Keep actionable warnings, including actual graph-revision impact (W304).
    const warnings = ((output.plan.warnings ?? []) as string[])
      .filter(warning => !warning.startsWith("W303:")
        && (feedbackEnabled || !warning.startsWith("W302:")))
      .map(stripDiagnosticCode);
    // The first node batch has no edges yet, so its compiler roots merely repeat
    // every node and can be mistaken for the intended final roots. Later edits
    // expose the compiler's sorted list as rootNodes to make extra roots visible.
    const initialNodeBatch = kind === "node" && saved.nodes.length === 0
      && saved.edges.length === 0 && graph.nodes.length > 0;
    const pruneNotes = pruned.length > 0
      ? [`Auto-removed redundant direct ${pruned.length === 1 ? "edge" : "edges"} implied by indirect paths (saved, no retry needed): ${pruned.map(item => `${item.from} → ${item.to} (via ${item.path.join(" → ")})`).join("; ")}.`]
      : [];
    const notes = [...editNotes, ...pruneNotes];
    return result(JSON.stringify({
      applied: true,
      topology: { ...(initialNodeBatch ? {} : { rootNodes: output.plan.rootNodes ?? output.plan.roots }), ...topology(graph, feedbackEnabled) },
      ...(warnings.length ? { warnings } : {}),
      ...(notes.length ? { notes } : {}),
    }));
  }
  // Argument errors happen before execute(), so no mutation or graph read has
  // occurred. State that invariant without echoing the graph or task text.
  function prepareWithContext<T>(prepare: () => T): T {
    try {
      return prepare();
    } catch (error) {
      if (error instanceof Error) throw new Error(`${error.message}\nThe graph is unchanged.`);
      throw error;
    }
  }
  pi.registerTool(defineTool({
    name: "node", label: "Graph node",
    // Pi normalizes nullable optional edit fields before local validation.
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    description:
      "Create, replace, or delete graph nodes.",
    parameters: Type.Object({
      nodes: Type.Array(Type.Object({
        id: Type.String({ description: "Stable unique identifier for referencing this node in the graph" }),
        task: Type.Optional(Type.String({ description: "Task to execute (required unless deleting)" })),
        delete: Type.Optional(Type.Boolean({ description: "Delete the node and its connected edges (default: false)" })),
      }, { additionalProperties: false }), { minItems: 1, description: "One or more node edits, applied in order" }),
    }, { additionalProperties: false }),
    prepareArguments: raw => prepareWithContext(() => editArguments(raw, "nodes", ["id"], ["id", "task", "delete"], '{"nodes":[{"id":"...","task":"..."}]}')),
    async execute(id, parameters, signal) {
      return mutate(id, signal, "node", (graph, editNotes) => {
        const duplicates = duplicateTargets("nodes", parameters.nodes.map(edit => edit.id));
        if (duplicates.length) return duplicates;
        for (const edit of parameters.nodes) {
          const removedEdges = applyNode(graph, edit).filter(edge => feedbackEnabled || !edge.feedback);
          if (removedEdges.length > 0) {
            editNotes.push(
              `Deleted node ${edit.id} also removed its incident ${removedEdges.length === 1 ? "edge" : "edges"}: ${removedEdges.map(edge => `${edge.from} → ${edge.to}${edge.feedback ? " (feedback)" : ""}`).join(", ")}.`,
            );
          }
        }
      });
    },
  }));
  pi.registerTool(defineTool({
    name: "edge", label: "Graph edge",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    description:
      "Create, replace, or delete directed edges between existing nodes. Only one edge per ordered pair. By default, the `to` node depends on the `from` node and waits for it to complete. Multiple dependencies' workspace states are merged before the `to` node runs."
      + (feedbackEnabled ? " With feedback: true, the `from` node can optionally send a feedback message to the `to` node, which must be an ancestor of the `from` node. Each feedback source has at most one target. When feedback is sent, the target receives the source's completed workspace state and feedback, and continues from its own context to improve its previous work. The source and other previously run descendants retain their own context and recheck their tasks using updated workspace state after their dependencies complete." : ""),
    parameters: Type.Object({
      edges: Type.Array(Type.Object({
        from: Type.String({ description: "Source node id" }),
        to: Type.String({ description: "Target node id (differ from source)" }),
        ...(feedbackEnabled ? { feedback: Type.Optional(Type.Boolean({ description: "True for a feedback edge (default: false)" })) } : {}),
        delete: Type.Optional(Type.Boolean({ description: "Delete the edge (default: false)" })),
      }, { additionalProperties: false }), { minItems: 1, description: "One or more edge edits, applied in order" }),
    }, { additionalProperties: false }),
    prepareArguments: raw => prepareWithContext(() => editArguments(raw, "edges", ["from", "to"], feedbackEnabled ? ["from", "to", "feedback", "delete"] : ["from", "to", "delete"], '{"edges":[{"from":"...","to":"..."}]}')),
    async execute(id, parameters, signal) {
      return mutate(id, signal, "edge", (graph, editNotes) => {
        const duplicates = duplicateTargets("edges", parameters.edges.map(edit => JSON.stringify([edit.from, edit.to])));
        if (duplicates.length) return duplicates;
        const missingDeletes: EdgeEdit[] = [];
        for (const edit of parameters.edges) {
          if (!applyEdge(graph, edit)) missingDeletes.push(edit);
        }
        if (missingDeletes.length > 0) {
          editNotes.push(
            `Ignored delete for non-existent ${missingDeletes.length === 1 ? "edge" : "edges"}: ${missingDeletes.map(edge => `${edge.from} → ${edge.to}`).join(", ")}.`,
          );
        }
      });
    },
  }));
}
