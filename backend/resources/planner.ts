import { Type } from "typebox";
import { defineTool, formatSize, truncateHead, truncateLine, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

type Graph = { originalGoal: string; nodes: { id: string; task: string }[]; edges: { from: string; to: string; feedback: boolean }[] };

type NodeEdit = { id: string; task?: string; delete?: boolean };
type EdgeEdit = { from: string; to: string; feedback?: boolean; delete?: boolean };
type GraphEdit = { nodes?: NodeEdit[]; edges?: EdgeEdit[] };
type MutationTool = "edit_graph";
type Diagnostic = { code: string; message: string; dependencyPath?: string[] };
type FailedNodeCall = { nodeId: string; toolCallId: string };
// A change either succeeds with a summary or is rejected before compilation.
type Change = { summary: string; notes?: string[]; createdDependencies?: Pick<EdgeEdit, "from" | "to">[] };
// Structured effects for logs and the UI. The model reads `content`; failure is
// carried by the result's `isError`, as in Pi's bash tool.
type GraphToolDetails = {
  diagnosticCodes?: string[];
  diagnostics?: string[];
  warnings?: string[];
  notes?: string[];
  relatedFailures?: FailedNodeCall[];
  truncation?: ReturnType<typeof truncateHead>;
  fullOutputPath?: string;
};

function stripDiagnosticCode(message: string): string {
  return message.replace(/^(?:\[?[A-Za-z]{1,5}[-_]?\d+\]?[:\-]?\s*)/, "");
}

// Disabled tools still validate the complete saved graph. Preserve the error
// (and its internal code), but do not reintroduce an unavailable protocol in a
// repair instruction. Existing routes must never be silently dropped to pass.
function diagnosticText(diagnostic: Diagnostic, feedbackEnabled: boolean): string {
  if (!feedbackEnabled && diagnostic.code === "E207") {
    return "This batch removes a dependency path required by a retained graph constraint. Preserve the required path, including any replacement path in the same batch. If the constraint cannot be preserved, ask the user to repair the graph in the Graph IR editor. The graph is unchanged.";
  }
  if (!feedbackEnabled && diagnostic.code === "E208") {
    return "The saved graph contains incompatible retained routes. Ask the user to repair the graph in the Graph IR editor before continuing. The graph is unchanged.";
  }
  return stripDiagnosticCode(diagnostic.message);
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiagnostic(value: unknown): value is Diagnostic {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string"
    && (value.dependencyPath === undefined || (Array.isArray(value.dependencyPath) && value.dependencyPath.every(id => typeof id === "string")));
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Like Pi's edit, tolerate stringified collections and single collection items.
// Field types, nullable optionals and unknown fields remain Pi's responsibility.
function graphArguments(raw: unknown): GraphEdit {
  const value = parseArguments(raw);
  if (!isRecord(value)) return value as GraphEdit;
  const prepared = { ...value };
  for (const key of ["nodes", "edges"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const parsed = parseArguments(value[key]);
    const items = isRecord(parsed) ? [parsed] : parsed;
    prepared[key] = items;
  }
  return prepared as GraphEdit;
}

// Lifecycle start events precede Pi's validator. Record only unambiguous
// identity/deletion intent using the same primitive meanings, never task text.
function nodeIntent(value: unknown): NodeEdit | undefined {
  if (!isRecord(value) || !Object.hasOwn(value, "id")) return;
  const id = value.id;
  if (id !== null && typeof id !== "string" && typeof id !== "boolean"
    && !(typeof id === "number" && Number.isFinite(id))) return;
  let deleting = false;
  const flag = typeof value.delete === "string" ? value.delete.toLowerCase() : value.delete;
  if (flag === true || flag === 1 || flag === "true" || flag === "1") deleting = true;
  else if (flag !== undefined && flag !== null && flag !== false && flag !== 0 && flag !== "false" && flag !== "0") return;
  return String(id) ? { id: String(id), delete: deleting } : undefined;
}

function duplicateTargets(label: string, targets: string[]): Diagnostic[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const target of targets) {
    if (seen.has(target)) duplicates.add(target);
    seen.add(target);
  }
  return [...duplicates].map(target => ({ code: "duplicate-target", message: `Duplicate ${label} target ${target}. Include each target only once per batch.` }));
}

function applyNode(graph: Graph, edit: NodeEdit): Graph["edges"] {
  graph.nodes = graph.nodes.filter(node => node.id !== edit.id);
  if (edit.delete) {
    const removed = graph.edges.filter(edge => edge.from === edit.id || edge.to === edit.id);
    if (removed.length > 0) {
      graph.edges = graph.edges.filter(edge => edge.from !== edit.id && edge.to !== edit.id);
    }
    return removed;
  }
  graph.nodes.push({ id: edit.id, task: edit.task ?? "" });
  return [];
}

type EdgeEffect = { kind: "created" | "deleted" | "missing" | "unchanged" } | { kind: "updated"; previousFeedback: boolean };

function applyEdge(graph: Graph, edit: EdgeEdit): EdgeEffect {
  const existing = graph.edges.find(edge => edge.from === edit.from && edge.to === edit.to);
  if (edit.delete) {
    if (!existing) return { kind: "missing" };
    graph.edges = graph.edges.filter(edge => edge !== existing);
    return { kind: "deleted" };
  }
  const feedback = edit.feedback ?? false;
  if (existing && existing.feedback === feedback) return { kind: "unchanged" };
  graph.edges = graph.edges.filter(edge => edge !== existing);
  graph.edges.push({ from: edit.from, to: edit.to, feedback });
  return existing ? { kind: "updated", previousFeedback: existing.feedback } : { kind: "created" };
}

export default function grapherPlanner(pi: ExtensionAPI) {
  const graphPath = process.env.GRAPHER_GRAPH_PATH!;
  const feedbackEnabled = process.env.GRAPHER_FEEDBACK_ENABLED === "true";
  // Runtime-owned constraint: node IDs this run may not remove because their
  // results are already published. Graph structure cannot express it, so the
  // server passes it beside the graph and the edit is rejected where the
  // Planner can still react instead of failing the commit afterwards.
  const unremovableNodes: string[] = JSON.parse(process.env.GRAPHER_UNREMOVABLE_NODES ?? '[]');
  // Only read_graph returns graph contents. Mutations follow Pi's native tools:
  // concise feedback, with structured local effects/diagnostics for UI and logs.
  const outputFilePath = (tool: MutationTool | "read_graph") => join(dirname(graphPath),
    tool === "read_graph" ? `planner-graph-snapshot-${randomUUID()}.json` : `planner-${tool}-result-${randomUUID()}.txt`,
  ).replaceAll("\\", "/");
  const outputNotice = (path: string, truncation: ReturnType<typeof truncateHead>, text: string) => {
    // Pi's read-style head ranges with bash's full-output file handoff. Graph
    // tools have no offset parameter; further inspection uses read or bash.
    if (truncation.firstLineExceedsLimit) {
      const lineSize = formatSize(Buffer.byteLength(text.split("\n", 1)[0], "utf8"));
      return `[Line 1 is ${lineSize}, exceeds ${formatSize(truncation.maxBytes)} limit. Full output: ${path}]`;
    }
    const limit = truncation.truncatedBy === "bytes" ? ` (${formatSize(truncation.maxBytes)} limit)` : "";
    return `[Showing lines 1-${truncation.outputLines} of ${truncation.totalLines}${limit}. Full output: ${path}]`;
  };
  // Prepare output before publishing the candidate: a report-write failure must
  // never turn an already-committed edit into an apparent rejection/rollback.
  const result = (tool: MutationTool, text: string, details: GraphToolDetails, isError = false, rerunRisk?: number) => {
    const truncation = truncateHead(text);
    if (!truncation.truncated) return { content: [{ type: "text" as const, text }], details };
    const fullOutputPath = outputFilePath(tool);
    try {
      writeFileSync(fullOutputPath, text, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        try { unlinkSync(fullOutputPath); } catch { /* Clean up a partial report. */ }
      }
      throw error;
    }
    // Pin status and bounded cumulative risk outside the truncated body. A long
    // node id or diagnostic must not hide either; affected-node lists stay in it.
    const status = isError
      ? "Edit rejected. The graph is unchanged. Earlier successful edits remain."
      : "The edit succeeded.";
    const risk = rerunRisk === undefined ? ""
      : `\nWarning: Current draft will invalidate and rerun ${rerunRisk} completed ${rerunRisk === 1 ? "node" : "nodes"} since this draft changes their tasks or execution inputs. Nodes with changed tasks use the new tasks; other affected nodes use their original tasks and the latest workspace after dependencies complete. See the full output for grouped node lists.`;
    const preview = truncation.content || truncateLine(text.split("\n", 1)[0], 512).text;
    return {
      content: [{ type: "text" as const, text: `${status}${risk}\n\n${preview}\n\n${outputNotice(fullOutputPath, truncation, text)}` }],
      // Do not put the unbounded report back into details. Small results retain
      // their ordinary structured messages; overflow results carry a file link.
      details: {
        ...(details.diagnosticCodes ? { diagnosticCodes: [...new Set(details.diagnosticCodes)] } : {}),
        truncation, fullOutputPath,
      } as GraphToolDetails,
    };
  };
  const discardReport = (details: GraphToolDetails) => {
    if (details.fullOutputPath) {
      try { unlinkSync(details.fullOutputPath); } catch { /* Best-effort cleanup of an unpublished result. */ }
    }
  };
  // Failures use the result's own `isError`: the model sees `content` as an
  // error like a thrown one, while `details` stays available to logs and UI.
  const rejection = (tool: MutationTool, diagnostics: Diagnostic[], relatedFailures: FailedNodeCall[] = []) => {
    const messages = diagnostics.map(diagnostic => diagnosticText(diagnostic, feedbackEnabled));
    const text = messages.join("\n");
    const related = relatedFailures.map(({ nodeId, toolCallId }) =>
      `Earlier edit_graph call ${JSON.stringify(toolCallId)} failed to create node ${JSON.stringify(nodeId)}; this endpoint is still absent.`);
    const diagnosticCodes = diagnostics.map(diagnostic => diagnostic.code);
    try {
      return {
        ...result(tool, [
          text.endsWith("The graph is unchanged.") ? text : `${text}\nThe graph is unchanged.`,
          ...related,
          "Earlier successful edits remain.",
        ].join("\n"), {
          diagnostics: messages, diagnosticCodes,
          ...(relatedFailures.length ? { relatedFailures } : {}),
        }, true),
        isError: true,
      };
    } catch (error) {
      // The edit was already rejected. Keep that fact and the primary reason
      // visible even when the full diagnostic report cannot be persisted.
      const summary = truncateLine(text.split("\n", 1)[0], 512).text;
      const reportError = `Cannot save the full diagnostic report: ${(error as NodeJS.ErrnoException).code ?? "file write failed"}.`;
      return {
        content: [{ type: "text" as const, text: `Edit rejected. The graph is unchanged. Earlier successful edits remain.\n${summary}\n${reportError}` }],
        details: { diagnostics: [summary, reportError], diagnosticCodes: [...new Set([...diagnosticCodes, "graph-report"])] },
        isError: true,
      };
    }
  };
  // Pi reports finalized calls even when argument validation prevented execute().
  // Remember only identifiable node targets within this assistant turn. Never
  // infer a dependency on the last error, parse compiler prose, or retain tasks.
  const pendingNodes = new Map<string, NodeEdit[]>();
  const failedNodes = new Map<string, FailedNodeCall>();
  pi.on("turn_start", () => { pendingNodes.clear(); failedNodes.clear(); });
  pi.on("tool_execution_start", event => {
    if (event.toolName !== "edit_graph") return;
    try {
      const edits = graphArguments(event.args)?.nodes;
      if (!Array.isArray(edits)) return;
      // Keep only identity and deletion intent, never tasks or raw arguments.
      pendingNodes.set(event.toolCallId, edits.flatMap(edit => {
        const intent = nodeIntent(edit);
        return intent ? [intent] : [];
      }));
    } catch { /* Ambiguous/invalid targets cannot explain a later missing endpoint. */ }
  });
  pi.on("tool_execution_end", event => {
    if (event.toolName !== "edit_graph") return;
    const edits = pendingNodes.get(event.toolCallId);
    pendingNodes.delete(event.toolCallId);
    for (const edit of edits ?? []) {
      if (!event.isError) failedNodes.delete(edit.id);
      else if (!edit.delete) failedNodes.set(edit.id, { nodeId: edit.id, toolCallId: event.toolCallId });
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
  // Without the snapshot the compiler cannot report revision impact, so a
  // timeout fails the call instead of silently validating with less context.
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
    throw new Error("Timed out waiting for the runtime's graph snapshot. Retry the call. The graph is unchanged.");
  }
  function readCandidate(): Graph {
    let graph: unknown;
    try {
      graph = JSON.parse(readFileSync(graphPath, "utf8"));
    } catch (error) {
      const reason = error instanceof SyntaxError ? "invalid JSON"
        : (error as NodeJS.ErrnoException).code ?? "unreadable file";
      throw new Error(`Cannot read the current planning candidate: ${reason}.`);
    }
    // Check the stored shape, not topology: even an invalid graph must remain
    // inspectable. Reading never invokes the compiler or repairs saved data.
    if (!isRecord(graph) || typeof graph.originalGoal !== "string"
      || !Array.isArray(graph.nodes) || !graph.nodes.every(node => isRecord(node) && Object.keys(node).every(key => key === "id" || key === "task") && typeof node.id === "string" && typeof node.task === "string")
      || !Array.isArray(graph.edges) || !graph.edges.every(edge => isRecord(edge) && Object.keys(edge).every(key => key === "from" || key === "to" || key === "feedback")
        && typeof edge.from === "string" && typeof edge.to === "string" && typeof edge.feedback === "boolean")) {
      throw new Error("Cannot read the current planning candidate: invalid Graph IR structure.");
    }
    return graph as Graph;
  }
  // Same-directory replacement publishes a complete candidate to external
  // preview readers too. Never truncate the authoritative file or unlink it
  // before rename; a failed write/rename leaves the previous candidate intact.
  function saveCandidate(graph: Graph) {
    const temporary = `${graphPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(graph), { flag: "wx", mode: 0o600 });
      renameSync(temporary, graphPath);
    } finally {
      try { unlinkSync(temporary); } catch { /* Renamed or best-effort cleanup after failure. */ }
    }
  }
  pi.registerTool(defineTool({
    name: "read_graph", label: "Read graph",
    promptSnippet: "Read the current planning candidate",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    description: "Read the graph you have planned as JSON containing nodes and edges.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _parameters, signal) {
      return withFileMutationQueue(graphPath, async () => {
        if (signal?.aborted) throw new Error("Operation aborted");
        const { nodes, edges } = readCandidate();
        // Return only the editable graph contents, not the stored user goal.
        // Inline output and overflow snapshots share this same projection.
        const text = JSON.stringify({ nodes, edges }, null, 2);
        const truncation = truncateHead(text);
        const details: { truncation?: typeof truncation; fullOutputPath?: string } = {};
        let content = truncation.content;
        if (truncation.truncated) {
          // Follow Pi's large-output convention, not a second live graph mirror.
          // This per-read snapshot lives with the planning attempt, outside project
          // snapshots; editing it can never modify the authoritative candidate.
          const fullOutputPath = outputFilePath("read_graph");
          writeFileSync(fullOutputPath, text, { flag: "wx", mode: 0o600 });
          Object.assign(details, { truncation, fullOutputPath });
          content += `\n\n${outputNotice(fullOutputPath, truncation, text)}`;
        }
        return { content: [{ type: "text", text: content }], details };
      });
    },
  }));
  // Compilation must yield to Pi's abort/RPC events. Keep the queue until the
  // child closes, including cancellation, timeout, early exit and output overflow.
  function compileCandidate(input: string, signal?: AbortSignal): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
    return new Promise(resolve => {
      const child = spawn(process.env.GRAPHER_COMPILER_PATH!, ["--compile"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let error: Error | undefined;
      let outputBytes = 0;
      const stop = (reason: Error) => {
        error ??= reason;
        child.kill("SIGKILL");
      };
      const collect = (target: Buffer[], chunk: Buffer) => {
        if (error) return;
        outputBytes += chunk.length;
        if (outputBytes > 1024 * 1024) stop(new Error("Compiler output exceeded 1 MiB."));
        else target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", reason => { error ??= reason; });
      child.stdin.on("error", stop);
      const abort = () => stop(new Error("Operation aborted"));
      const timeout = setTimeout(() => stop(new Error("Compiler timed out after 10000 ms.")), 10000);
      child.once("close", status => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), error });
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else child.stdin.end(input);
    });
  }
  // The shared engine policy owns file read/bash and their stable path view.
  // Graph reads and edits share Pi's native file-mutation queue, even for direct
  // SDK callers that bypass agent-loop scheduling. Hold it through revision
  // waits and compilation, including cancellation/failure.
  function mutate(tool: MutationTool, id: string, signal: AbortSignal | undefined, change: (graph: Graph) => Change | Diagnostic[], endpoints: readonly string[] = []) {
    return withFileMutationQueue(graphPath, async () => {
      const throwIfAborted = () => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };
      throwIfAborted();
      const revision = await revisionContext(id, signal);
      throwIfAborted();
      const previousGraph = readCandidate();
      const graph = structuredClone(previousGraph);
      const rejected = (diagnostics: Diagnostic[]) => rejection(tool, diagnostics,
        diagnostics.some(diagnostic => diagnostic.code === "E204")
          ? [...new Set(endpoints)].filter(endpoint => !graph.nodes.some(node => node.id === endpoint))
            .flatMap(endpoint => failedNodes.has(endpoint) ? [failedNodes.get(endpoint)!] : [])
          : []);
      const changed = change(graph);
      if (Array.isArray(changed)) return rejected(changed);
      const checked = await compileCandidate(JSON.stringify({ graph, previousGraph, finalCheck: false, unremovableNodes, ...(revision ? { revisionContext: revision } : {}) }), signal);
      throwIfAborted();
      if (checked.error || checked.status !== 0) return rejected([{ code: "compiler-unavailable", message: checked.error?.message || checked.stderr || `Compiler exited with status ${checked.status}` }]);
      let output: unknown;
      try { output = JSON.parse(checked.stdout); }
      catch { return rejected([{ code: "compiler-response", message: "Compiler returned invalid JSON." }]); }
      if (!isRecord(output)) return rejected([{ code: "compiler-response", message: "Compiler returned an invalid response object." }]);
      const diagnostics = output.diagnostics ?? [];
      if (!Array.isArray(diagnostics) || !diagnostics.every(isDiagnostic)) {
        return rejected([{ code: "compiler-response", message: "Compiler returned invalid diagnostics." }]);
      }
      if (diagnostics.length) {
        return rejected(diagnostics.map(diagnostic => {
          const path = diagnostic.dependencyPath;
          const added = changed.createdDependencies?.find(edge => path && path[0] === edge.from && path.at(-1) === edge.to);
          // The compiler describes the rejected candidate. A redundant edge
          // created by this call was never saved, so do not ask to delete it.
          // Keep repair hints for other, already-saved redundant edges intact.
          if (diagnostic.code === "E209" && added && path) {
            return { ...diagnostic, message: `No need to add dependency ${added.from} → ${added.to}: ${path.join(" → ")} already provides this dependency. Omit this edge.` };
          }
          return diagnostic;
        }));
      }
      const plan = output.plan;
      const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
      if (!isRecord(plan) || Object.keys(plan).some(key => !["executionBatches", "rootNodes", "terminals", "warnings"].includes(key))
        || !Array.isArray(plan.executionBatches) || !plan.executionBatches.every(stringList)
        || !stringList(plan.rootNodes) || !stringList(plan.terminals)) {
        return rejected([{ code: "compiler-response", message: "Compiler returned no valid plan." }]);
      }
      if (!Array.isArray(output.mutationWarnings) || !output.mutationWarnings.every(isDiagnostic)
        || !stringList(plan.warnings)) {
        return rejected([{ code: "compiler-response", message: "Compiler returned invalid warnings." }]);
      }
      // Risk counts are structured Runtime evidence, never warning-prose parsing.
      const hasRerunRisk = output.mutationWarnings.some(warning => warning.code === "W304");
      let rerunRisk: number | undefined;
      if (hasRerunRisk || output.revisionImpact !== undefined) {
        const impact = output.revisionImpact;
        if (!isRecord(impact) || typeof impact.rerunCount !== "number"
          || !Number.isSafeInteger(impact.rerunCount) || impact.rerunCount <= 0 || !hasRerunRisk) {
          return rejected([{ code: "compiler-response", message: "Compiler returned invalid revision impact." }]);
        }
        rerunRisk = impact.rerunCount;
      }
      // Compare advisory facts with the saved candidate, not a session cache.
      // W304 remains cumulative against the runtime's committed graph.
      const warnings = output.mutationWarnings
        .filter(warning => warning.code !== "W303" && (feedbackEnabled || warning.code !== "W302"))
        .map(warning => warning.message);
      const notes = changed.notes ?? [];
      throwIfAborted();
      let response;
      try {
        // Keep the cascade count and cumulative risk ahead of unbounded lists.
        response = result(tool, [changed.summary, ...notes.slice(0, 1), ...warnings.map(warning => `Warning: ${warning}`), ...notes.slice(1)].join("\n"), {
          ...(warnings.length ? { warnings } : {}),
          ...(notes.length ? { notes } : {}),
        }, false, rerunRisk);
      } catch (error) {
        return rejected([{ code: "graph-report", message: `Cannot save the operation report: ${(error as NodeJS.ErrnoException).code ?? "file write failed"}.` }]);
      }
      try {
        throwIfAborted();
        saveCandidate(graph);
      } catch (error) {
        discardReport(response.details);
        if (signal?.aborted) throw error;
        return rejected([{ code: "graph-write", message: `Cannot save the planning candidate: ${(error as NodeJS.ErrnoException).code ?? "file replacement failed"}.` }]);
      }
      return response;
    });
  }
  const nodeSchema = Type.Object({
    id: Type.String({ description: "Stable unique identifier for referencing this node in the graph" }),
    task: Type.Optional(Type.String({ description: "Complete non-empty task (required unless deleting)" })),
    delete: Type.Optional(Type.Boolean({ description: "Delete the node and its connected edges (default: false)" })),
  }, { additionalProperties: false });
  // Compose complete schemas so feedback stays optional in TypeBox's inference.
  const edgeSchema = Type.Object({
    from: Type.String({ description: "Source node id" }),
    to: Type.String({ description: "Target node id (must differ from source)" }),
    feedback: Type.Optional(Type.Boolean({ description: "True for a feedback edge (default: false)" })),
    delete: Type.Optional(Type.Boolean({ description: "Delete the edge (default: false)" })),
  }, { additionalProperties: false });
  pi.registerTool(defineTool({
    name: "edit_graph", label: "Edit graph",
    promptSnippet: "Create, replace, or delete one or more graph nodes, dependency edges, or both",
    promptGuidelines: ["Batch related node and edge changes in one edit_graph call. Supply the complete task when creating or replacing a node."],
    executionMode: "sequential",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    description:
      "Create, replace, or delete one or more graph nodes, dependency edges, or both. Only one edge per ordered pair. For a dependency edge, the `to` node depends on the `from` node and waits for it to complete."
      + (feedbackEnabled ? " With feedback: true, the `from` node can optionally send a feedback message to the `to` node, which must be an ancestor of the `from` node. Each feedback source has at most one target. When feedback is sent, the target receives the source's completed workspace and feedback, and continues from its own context to improve its previous work. The source and other previously run descendants retain their own context and recheck their tasks using the updated workspace after their dependencies complete." : "")
      + " Replacing a node overwrites its entire task; an existing ordered edge pair is replaced. Deleting a node removes its incident edges; deleting a missing node or edge, or a published node, is an error. Include each node id and ordered edge pair only once. Edges may reference nodes created in the same batch. Only the final graph is validated: dependency cycles and redundant direct dependencies are rejected, never auto-removed. The batch is committed together or leaves the graph unchanged.",
    parameters: Type.Object({
      nodes: Type.Optional(Type.Array(nodeSchema, { description: "Node creations, complete task replacements, or deletions" })),
      edges: Type.Optional(Type.Array(feedbackEnabled ? edgeSchema : Type.Omit(edgeSchema, ["feedback"], { additionalProperties: false }), { description: feedbackEnabled ? "Dependency or feedback edge creations, replacements, or deletions" : "Dependency edge creations, replacements, or deletions" })),
    }, { additionalProperties: false }),
    prepareArguments: graphArguments,
    async execute(id, parameters, signal) {
      const nodes: NodeEdit[] = parameters.nodes ?? [];
      const edges: EdgeEdit[] = parameters.edges ?? [];
      if (nodes.length + edges.length === 0) throw new Error("edit_graph requires at least one node or edge edit.");
      return mutate("edit_graph", id, signal, graph => {
        const duplicates = [
          ...duplicateTargets("node", nodes.map(edit => JSON.stringify(edit.id))),
          ...duplicateTargets("edge", edges.map(edit => JSON.stringify([edit.from, edit.to]))),
        ];
        if (duplicates.length) return duplicates;
        const missing: Diagnostic[] = [];
        for (const edit of nodes) {
          if (edit.delete && !graph.nodes.some(node => node.id === edit.id)) {
            missing.push({ code: "not-found", message: `Node ${JSON.stringify(edit.id)} does not exist; nothing to delete.` });
          }
        }
        // Resolve deletion targets against the saved graph, before cascades.
        // Explicit edge deletion plus deletion of its endpoint is not an error.
        for (const edit of edges) {
          if (edit.delete && !graph.edges.some(edge => edge.from === edit.from && edge.to === edit.to)) {
            missing.push({ code: "not-found", message: `Edge ${JSON.stringify(edit.from)} → ${JSON.stringify(edit.to)} does not exist; nothing to delete.` });
          }
        }
        if (missing.length) return missing;
        const summaries: string[] = [];
        for (const edit of edges.filter(edit => edit.delete)) {
          applyEdge(graph, edit);
          summaries.push(`Successfully deleted edge ${JSON.stringify(edit.from)} → ${JSON.stringify(edit.to)}.`);
        }
        const removedEdges: Graph["edges"] = [];
        for (const edit of nodes) {
          const existed = graph.nodes.some(node => node.id === edit.id);
          removedEdges.push(...applyNode(graph, edit));
          summaries.push(`Successfully ${edit.delete ? "deleted" : existed ? "updated" : "created"} node ${JSON.stringify(edit.id)}.`);
        }
        const createdDependencies: NonNullable<Change["createdDependencies"]> = [];
        for (const edit of edges.filter(edit => !edit.delete)) {
          const label = `${JSON.stringify(edit.from)} → ${JSON.stringify(edit.to)}`;
          const effect = applyEdge(graph, edit);
          if (effect.kind === "unchanged") summaries.push(`Edge ${label} already exists with these settings; no change.`);
          else if (effect.kind === "updated") summaries.push(`Successfully updated edge ${label}${feedbackEnabled ? ` (feedback: ${effect.previousFeedback} → ${edit.feedback ?? false})` : ""}.`);
          else {
            summaries.push(`Successfully created edge ${label}${feedbackEnabled && edit.feedback ? " (feedback)" : ""}.`);
            if (!edit.feedback) createdDependencies.push({ from: edit.from, to: edit.to });
          }
        }
        const visibleRemovals = removedEdges.filter(edge => feedbackEnabled || !edge.feedback);
        return {
          summary: summaries.length === 1 ? summaries[0] : `Successfully applied ${nodes.length} node edit(s) and ${edges.length} edge edit(s).`,
          notes: visibleRemovals.length ? [`Removed ${visibleRemovals.length} incident ${visibleRemovals.length === 1 ? "edge" : "edges"}:`,
            ...visibleRemovals.map(edge => `${edge.from} → ${edge.to}${edge.feedback ? " (feedback)" : ""}`)] : [],
          createdDependencies,
        };
      }, edges.flatMap(edit => [edit.from, edit.to]));
    },
  }));
}
