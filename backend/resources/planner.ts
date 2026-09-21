import { Type } from "@earendil-works/pi-ai";
import { defineTool, createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type Graph = { originalGoal: string; nodes: { name: string; task: string }[]; edges: { from: string; to: string; relation: string; feedback: boolean }[] };

type NodeEdit = { name: string; task?: string; delete?: boolean };
type EdgeEdit = { from: string; to: string; relation?: string; feedback?: boolean; delete?: boolean };
type Diagnostic = { code: string; message: string };

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
    description: `Create, replace, or delete graph nodes. Supply one or more edits in 'nodes' (batch mode), or single-node fields 'name'/'task'/'delete'. Each task is passed to a later fresh session with completed dependency filesystem state; the planner conversation is not passed. Updating a name replaces its task and preserves edges. Deleting a node removes its incident edges. Edits are applied in order, then compiled once. A failure leaves the saved graph unchanged.`,
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Single-node mode: stable identifier, 1–64 ASCII letters, digits, _ or -." })),
      task: Type.Optional(Type.String({ description: "Task text passed verbatim to the node execution. Required and nonempty unless deleting." })),
      delete: Type.Optional(Type.Boolean({ description: "Remove this node and all its incident edges; task is ignored." })),
      nodes: Type.Optional(Type.Array(Type.Object({
        name: Type.String({ description: "Stable node identifier." }),
        task: Type.Optional(Type.String({ description: "Task for a fresh execution; required unless deleting." })),
        delete: Type.Optional(Type.Boolean({ description: "Delete this node and its incident edges." })),
      }, { additionalProperties: false }), { minItems: 1, description: "Batch node edits, applied in order." })),
    }, { additionalProperties: false }),
    async execute(_id, parameters) {
      return mutate((graph) => {
        let edits: NodeEdit[] = [];
        if (parameters.nodes !== undefined) {
          if (parameters.name !== undefined || parameters.task !== undefined || parameters.delete !== undefined) {
            return [{ code: "mutation-input", message: "Use either single-node name/task/delete or batch nodes, not both. The saved graph was not changed." }];
          }
          if (!parameters.nodes.length) {
            return [{ code: "mutation-input", message: "A batch requires at least one node edit. The saved graph was not changed." }];
          }
          edits = parameters.nodes;
        } else if (parameters.name !== undefined) {
          edits = [{ name: parameters.name, task: parameters.task, delete: parameters.delete }];
        }
        if (!edits.length) return [{ code: "mutation-input", message: "Provide a node name or a non-empty nodes array. The saved graph was not changed." }];
        for (const edit of edits) applyNode(graph, edit);
      });
    },
  }));
  pi.registerTool(defineTool({
    name: "edge", label: "Graph edge",
    description: `Create, replace, or delete directed edges between existing nodes. Supply one or more edits in 'edges' (batch mode), or single-edge fields 'from'/'to'/'relation'/'feedback'/'delete'. There is one edge per ordered pair. Edits are applied in order, then compiled once; a failure leaves the saved graph unchanged. Omitted or false feedback creates a dependency: the target waits for the source to complete successfully and receives its filesystem state. True feedback creates a route to a dependency ancestor without execution ordering or filesystem input.`,
    parameters: Type.Object({
      from: Type.Optional(Type.String({ description: "Single-edge mode: existing source node name." })),
      to: Type.Optional(Type.String({ description: "Single-edge mode: existing target node name, different from source." })),
      relation: Type.Optional(Type.String({ description: "Human-readable relationship; feedback determines runtime behavior." })),
      feedback: Type.Optional(Type.Boolean({ description: "True for feedback; otherwise a dependency." })),
      delete: Type.Optional(Type.Boolean({ description: "Remove the ordered pair." })),
      edges: Type.Optional(Type.Array(Type.Object({
        from: Type.String({ description: "Existing source node name." }),
        to: Type.String({ description: "Existing target node name, different from source." }),
        relation: Type.Optional(Type.String({ description: "Human-readable relationship; feedback determines runtime behavior." })),
        feedback: Type.Optional(Type.Boolean({ description: "True for feedback; otherwise a dependency." })),
        delete: Type.Optional(Type.Boolean({ description: "Remove the ordered pair." })),
      }, { additionalProperties: false }), { minItems: 1, description: "Batch edge edits, applied in order." })),
    }, { additionalProperties: false }),
    async execute(_id, parameters) {
      return mutate(graph => {
        let edits: EdgeEdit[] = [];
        if (parameters.edges !== undefined) {
          if (parameters.from !== undefined || parameters.to !== undefined || parameters.relation !== undefined || parameters.feedback !== undefined || parameters.delete !== undefined) {
            return [{ code: "mutation-input", message: "Use either single-edge fields or batch edges, not both. The saved graph was not changed." }];
          }
          if (!parameters.edges.length) {
            return [{ code: "mutation-input", message: "A batch requires at least one edge edit. The saved graph was not changed." }];
          }
          edits = parameters.edges;
        } else if (parameters.from !== undefined || parameters.to !== undefined) {
          if (!parameters.from || !parameters.to) {
            return [{ code: "mutation-input", message: "Provide both 'from' and 'to' for single-edge mode. The saved graph was not changed." }];
          }
          edits = [{ from: parameters.from, to: parameters.to, relation: parameters.relation, feedback: parameters.feedback, delete: parameters.delete }];
        }
        if (!edits.length) return [{ code: "mutation-input", message: "Provide edge endpoints or a non-empty edges array. The saved graph was not changed." }];
        for (const edit of edits) applyEdge(graph, edit);
      });
    },
  }));
}
