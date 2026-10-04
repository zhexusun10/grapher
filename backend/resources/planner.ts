import { Type } from "@earendil-works/pi-ai";
import { defineTool, createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type Graph = { originalGoal: string; nodes: { name: string; task: string }[]; edges: { from: string; to: string; relation: string; feedback: boolean }[] };

type NodeEdit = { name: string; task?: string; delete?: boolean };
type EdgeEdit = { from: string; to: string; relation?: string; feedback?: boolean; delete?: boolean };
type Diagnostic = { code: string; message: string };

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

function applyNode(graph: Graph, edit: NodeEdit) {
  graph.nodes = graph.nodes.filter(node => node.name !== edit.name);
  if (edit.delete) graph.edges = graph.edges.filter(edge => edge.from !== edit.name && edge.to !== edit.name);
  else graph.nodes.push({ name: edit.name, task: edit.task ?? "" });
}

function applyEdge(graph: Graph, edit: EdgeEdit) {
  graph.edges = graph.edges.filter(edge => edge.from !== edit.from || edge.to !== edit.to);
  if (!edit.delete) graph.edges.push({ from: edit.from, to: edit.to, relation: edit.relation ?? "", feedback: edit.feedback ?? false });
}

export default function grapherPlanner(pi: ExtensionAPI) {
  const graphPath = process.env.GRAPHER_GRAPH_PATH!;
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
  // Planner runs natively at the source project path. Commands and file
  // contents are passed unchanged; this role needs no private mapping.
  const repository = process.cwd();
  const nativeBash = createBashToolDefinition(repository);
  // Use native bash without write-command filtering.
  pi.registerTool(defineTool(nativeBash));
  function mutate(change: (graph: Graph) => Diagnostic[] | void) {
    const saved: Graph = JSON.parse(readFileSync(graphPath, "utf8"));
    const graph: Graph = structuredClone(saved);
    const rejected = (diagnostics: Diagnostic[]) => result(JSON.stringify({
      applied: false,
      topology: topology(saved),
      diagnostics: diagnostics.map(diagnostic => diagnostic.message),
    }), diagnostics.map(diagnostic => diagnostic.code));
    const inputErrors = change(graph);
    if (inputErrors?.length) return rejected(inputErrors);
    const checked = spawnSync(process.env.GRAPHER_COMPILER_PATH!, ["--compile"], { input: JSON.stringify({ graph, finalCheck: false }), encoding: "utf8", timeout: 10000 });
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
      ...(output.plan.warnings?.length ? { warnings: output.plan.warnings } : {}),
    }));
  }
  pi.registerTool(defineTool({
    name: "node", label: "Graph node",
    // Pi normalizes nullable optional edit fields before local validation.
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    description:
      "Create, replace, or delete graph nodes. Provide a nonempty nodes array; use one element for a single edit. Each nodes[].name must be unique within the call. Replacing a node updates its task and preserves its edges. Deleting a node removes its connected edges. A node's first execution starts a fresh session with its task and completed dependencies' filesystem state. Edits are applied in order and validated together. If validation fails, the saved graph is unchanged.",
    parameters: Type.Object({
      nodes: Type.Array(Type.Object({
        name: Type.String({ description: "Stable node name" }),
        task: Type.Optional(Type.String({ description: "Task to execute (required unless deleting)" })),
        delete: Type.Optional(Type.Boolean({ description: "Delete the node and its connected edges (default: false)" })),
      }, { additionalProperties: false }), { minItems: 1, description: "One or more node edits, applied in order" }),
    }, { additionalProperties: false }),
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
      "Create, replace, or delete directed edges between existing nodes. Provide a nonempty edges array; use one element for a single edit. Each ordered (from, to) pair must be unique within the call. Only one edge is stored per ordered pair. With feedback omitted or false, A -> B means B depends on A. B waits for A to complete successfully and receives A's filesystem state. Multiple dependencies' filesystem states are merged before B runs. Dependency edges must form a DAG. With feedback: true, B -> A lets B optionally send an additional instruction to A, which must be an ancestor of B in the dependency DAG. Each feedback source may have at most one feedback target. When an additional instruction is sent, it is appended as a new message in A's existing conversation. A continues its existing session and workspace to improve its previous work. B's conversation is not copied into A's session. A's dependency descendants wait for the updated results; those that have already completed run again using updated dependency inputs. Other branches remain valid. Feedback edges provide no filesystem input and do not affect dependency ordering or cycle detection. Edits are applied in order and validated together. If validation fails, the saved graph is unchanged.",
    parameters: Type.Object({
      edges: Type.Array(Type.Object({
        from: Type.String({ description: "Source node name (must exist)" }),
        to: Type.String({ description: "Target node name (must exist and differ from source)" }),
        relation: Type.Optional(Type.String({ description: "Brief description of what the target needs from the source or what feedback communicates" })),
        feedback: Type.Optional(Type.Boolean({ description: "True for a feedback edge (default: false)" })),
        delete: Type.Optional(Type.Boolean({ description: "Delete the edge (default: false)" })),
      }, { additionalProperties: false }), { minItems: 1, description: "One or more edge edits, applied in order" }),
    }, { additionalProperties: false }),
    async execute(_id, parameters) {
      return mutate(graph => {
        const duplicates = duplicateTargets("edges", parameters.edges.map(edit => JSON.stringify([edit.from, edit.to])));
        if (duplicates.length) return duplicates;
        for (const edit of parameters.edges) applyEdge(graph, edit);
      });
    },
  }));
}
