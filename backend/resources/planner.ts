import { Type } from "@earendil-works/pi-ai";
import { defineTool, createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type Graph = { originalGoal: string; nodes: { name: string; task: string }[]; edges: { from: string; to: string; relation: string; feedback: boolean }[] };

type NodeEdit = { name: string; task?: string; delete?: boolean };
type EdgeEdit = { from: string; to: string; relation?: string; feedback?: boolean; delete?: boolean };
type Diagnostic = { code: string; message: string; path?: string };

function duplicateTargets(field: "nodes" | "edges", targets: string[]): Diagnostic[] {
  const firstIndex = new Map<string, number>();
  const diagnostics: Diagnostic[] = [];
  targets.forEach((target, index) => {
    const first = firstIndex.get(target);
    if (first === undefined) firstIndex.set(target, index);
    else diagnostics.push({
      code: "duplicate-target",
      path: `${field}[${index}]`,
      message: `${field}[${index}] repeats target ${target} from ${field}[${first}]. Supply one edit per target. The saved graph was not changed.`,
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
  const result = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: { grapherRejected: isError }, isError });
  // Pi derives execution errors from throws or tool_result hooks, not an
  // arbitrary isError property returned by execute. Preserve diagnostics while
  // making rejected graph mutations visible as errors in its event stream.
  pi.on("tool_result", async event => {
    if ((event.details as { grapherRejected?: boolean } | undefined)?.grapherRejected) {
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
    const rejected = (diagnostics: { code: string; message: string }[]) => result(JSON.stringify({
      mutationApplied: false,
      structuralCheck: "failed",
      diagnostics,
      attemptedTopology: { nodes: graph.nodes.map(node => node.name), edges: graph.edges },
      savedTopology: { nodes: saved.nodes.map(node => node.name), edges: saved.edges },
    }), true);
    const inputErrors = change(graph);
    if (inputErrors?.length) return rejected(inputErrors);
    const checked = spawnSync(process.env.GRAPHER_COMPILER_PATH!, ["--compile"], { input: JSON.stringify({ graph, finalCheck: false }), encoding: "utf8", timeout: 10000 });
    if (checked.error || checked.status !== 0) return rejected([{ code: "compiler-unavailable", message: checked.error?.message || checked.stderr || `Compiler exited with status ${checked.status}` }]);
    let output;
    try { output = JSON.parse(checked.stdout); }
    catch { return rejected([{ code: "compiler-response", message: "Compiler returned invalid JSON. The saved graph was not changed." }]); }
    if (output.diagnostics?.length) return rejected(output.diagnostics);
    if (!output.plan) return rejected([{ code: "compiler-response", message: "Compiler returned no plan. The saved graph was not changed." }]);
    writeFileSync(graphPath, JSON.stringify(graph));
    // Return only new information. The planner authored the graph, while the
    // compiler plan tells it whether the current structure is executable.
    // Failure responses retain savedTopology because correction needs it.
    return result(JSON.stringify({ mutationApplied: true, structuralCheck: "passed", plan: output.plan }));
  }
  pi.registerTool(defineTool({
    name: "node", label: "Graph node",
    // Pi normalizes nullable optional edit fields before local validation.
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    description: `Create, replace, or delete graph nodes. Supply a nonempty 'nodes' array; use one element for a single edit. Each node name may appear only once per call. Each task is passed to a later fresh session with completed dependency filesystem state; the planner conversation is not passed. Updating a name replaces its task and preserves edges. Deleting a node removes its incident edges. Edits are applied in order, then compiled once. A failure leaves the saved graph unchanged.`,
    parameters: Type.Object({
      nodes: Type.Array(Type.Object({
        name: Type.String({ description: "Stable node identifier, 1–64 ASCII letters, digits, _ or -." }),
        task: Type.Optional(Type.String({ description: "Task for a fresh execution; required unless deleting." })),
        delete: Type.Optional(Type.Boolean({ description: "Delete this node and its incident edges." })),
      }, { additionalProperties: false }), { minItems: 1, description: "Batch node edits, applied in order." }),
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
    description: `Create, replace, or delete directed edges between existing nodes. Supply a nonempty 'edges' array; use one element for a single edit. Each ordered pair may appear only once per call. There is one edge per ordered pair. Edits are applied in order, then compiled once; a failure leaves the saved graph unchanged. Omitted or false feedback creates a dependency: the target waits for the source to complete successfully and receives its filesystem state. True feedback creates a route to a dependency ancestor without execution ordering or filesystem input.`,
    parameters: Type.Object({
      edges: Type.Array(Type.Object({
        from: Type.String({ description: "Existing source node name." }),
        to: Type.String({ description: "Existing target node name, different from source." }),
        relation: Type.Optional(Type.String({ description: "Human-readable relationship; feedback determines runtime behavior." })),
        feedback: Type.Optional(Type.Boolean({ description: "True for feedback; otherwise a dependency." })),
        delete: Type.Optional(Type.Boolean({ description: "Remove the ordered pair." })),
      }, { additionalProperties: false }), { minItems: 1, description: "Batch edge edits, applied in order." }),
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
