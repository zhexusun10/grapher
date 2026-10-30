import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type Graph = { originalGoal: string; nodes: { name: string; task: string }[]; edges: { from: string; to: string; feedback: boolean }[] };

type NodeEdit = { name: string; task?: string; delete?: boolean };
type EdgeEdit = { from: string; to: string; feedback?: boolean; delete?: boolean };
type Diagnostic = { code: string; message: string };

function stripDiagnosticCode(message: string): string {
  return message.replace(/^(?:\[?[A-Za-z]{1,5}[-_]?\d+\]?[:\-]?\s*)/, "");
}

function topology(graph: Graph) {
  return { nodes: graph.nodes.map(node => node.name), edges: graph.edges };
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
  const parsed = parseArguments(raw);
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
  const booleanFields = key === "nodes" ? ["delete"] : ["feedback", "delete"];
  const edits = normalized[key].map(edit => normalizeEdit(edit, label, required, fields, booleanFields, example));
  return { [key]: edits };
}

function applyNode(graph: Graph, edit: NodeEdit) {
  graph.nodes = graph.nodes.filter(node => node.name !== edit.name);
  if (edit.delete) graph.edges = graph.edges.filter(edge => edge.from !== edit.name && edge.to !== edit.name);
  else graph.nodes.push({ name: edit.name, task: edit.task ?? "" });
}

function applyEdge(graph: Graph, edit: EdgeEdit) {
  graph.edges = graph.edges.filter(edge => edge.from !== edit.from || edge.to !== edit.to);
  if (!edit.delete) graph.edges.push({ from: edit.from, to: edit.to, feedback: edit.feedback ?? false });
}

export default function grapherPlanner(pi: ExtensionAPI) {
  const graphPath = process.env.GRAPHER_GRAPH_PATH!;
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
  pi.on("tool_result", async event => {
    if ((event.toolName === "node" || event.toolName === "edge")
      && (event.details as { diagnosticCodes?: string[] } | undefined)?.diagnosticCodes) {
      return { isError: true };
    }
  });
  // The shared engine policy owns read/bash and their stable path view.
  // Keep this extension limited to graph mutations, regardless of cwd.
  function mutate(change: (graph: Graph) => Diagnostic[] | void) {
    const saved: Graph = JSON.parse(readFileSync(graphPath, "utf8"));
    const graph: Graph = structuredClone(saved);
    const rejected = (diagnostics: Diagnostic[]) => result(JSON.stringify({
      applied: false,
      topology: topology(saved),
      diagnostics: diagnostics.map(diagnostic => stripDiagnosticCode(diagnostic.message)),
    }), diagnostics.map(diagnostic => diagnostic.code));
    const inputErrors = change(graph);
    if (inputErrors?.length) return rejected(inputErrors);
    const checked = spawnSync(process.env.GRAPHER_COMPILER_PATH!, ["--compile"], { input: JSON.stringify({ graph, finalCheck: false, unremovableNodes }), encoding: "utf8", timeout: 10000 });
    if (checked.error || checked.status !== 0) return rejected([{ code: "compiler-unavailable", message: checked.error?.message || checked.stderr || `Compiler exited with status ${checked.status}` }]);
    let output;
    try { output = JSON.parse(checked.stdout); }
    catch { return rejected([{ code: "compiler-response", message: "Compiler returned invalid JSON." }]); }
    if (output.diagnostics?.length) return rejected(output.diagnostics);
    if (!output.plan) return rejected([{ code: "compiler-response", message: "Compiler returned no plan." }]);
    writeFileSync(graphPath, JSON.stringify(graph));
    return result(JSON.stringify({
      applied: true,
      topology: topology(graph),
      ...(output.plan.warnings?.length ? { warnings: output.plan.warnings.map(stripDiagnosticCode) } : {}),
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
        name: Type.String({ description: "Stable unique node name" }),
        task: Type.Optional(Type.String({ description: "Task to execute (required unless deleting)" })),
        delete: Type.Optional(Type.Boolean({ description: "Delete the node and its connected edges (default: false)" })),
      }, { additionalProperties: false }), { minItems: 1, description: "One or more node edits, applied in order" }),
    }, { additionalProperties: false }),
    prepareArguments: raw => prepareWithContext(() => editArguments(raw, "nodes", ["name"], ["name", "task", "delete"], '{"nodes":[{"name":"...","task":"..."}]}')),
    async execute(_id, parameters) {
      return mutate(graph => {
        const duplicates = duplicateTargets("nodes", parameters.nodes.map(edit => edit.name));
        if (duplicates.length) return duplicates;
        for (const edit of parameters.nodes) applyNode(graph, edit);
      });
    },
  }));
  pi.registerTool(defineTool({
    name: "edge", label: "Graph edge",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    description:
      "Create, replace, or delete directed edges between existing nodes. Only one edge per ordered pair. By default, A -> B makes B depend on A. B waits for A to complete and receives A's workspace state. Multiple dependencies' workspace states are merged before B runs. With feedback: true, B -> A lets B optionally send a feedback message to A, which must be an ancestor of B. Each feedback source has at most one target. When feedback is sent, A receives B's completed workspace state and feedback, and continues from A's own context to improve its previous work. A's descendants wait and run again using updated workspace state.",
    parameters: Type.Object({
      edges: Type.Array(Type.Object({
        from: Type.String({ description: "Source node name" }),
        to: Type.String({ description: "Target node name (differ from source)" }),
        feedback: Type.Optional(Type.Boolean({ description: "True for a feedback edge (default: false)" })),
        delete: Type.Optional(Type.Boolean({ description: "Delete the edge (default: false)" })),
      }, { additionalProperties: false }), { minItems: 1, description: "One or more edge edits, applied in order" }),
    }, { additionalProperties: false }),
    prepareArguments: raw => prepareWithContext(() => editArguments(raw, "edges", ["from", "to"], ["from", "to", "feedback", "delete"], '{"edges":[{"from":"...","to":"..."}]}')),
    async execute(_id, parameters) {
      return mutate(graph => {
        const duplicates = duplicateTargets("edges", parameters.edges.map(edit => JSON.stringify([edit.from, edit.to])));
        if (duplicates.length) return duplicates;
        for (const edit of parameters.edges) applyEdge(graph, edit);
      });
    },
  }));
}
