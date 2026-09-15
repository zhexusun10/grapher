import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Graph = { originalGoal: string; nodes: { name: string; task: string }[]; edges: { from: string; to: string; relation: string; feedback: boolean }[] };

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
  // Capture once; node tasks must be portable to their execution worktrees.
  const repository = realpathSync(process.cwd());
  const repositoryRoots = [...new Set([resolve(process.cwd()), repository])];
  function mutate(change: (graph: Graph) => void) {
    const saved: Graph = JSON.parse(readFileSync(graphPath, "utf8"));
    const graph: Graph = structuredClone(saved);
    const rejected = (diagnostics: { code: string; message: string }[]) => result(JSON.stringify({
      mutationApplied: false,
      structuralCheck: "failed",
      diagnostics,
      savedTopology: { nodes: saved.nodes.map(node => node.name), edges: saved.edges },
    }), true);
    change(graph);
    for (const node of graph.nodes) {
      if (repositoryRoots.some((root) => node.task.includes(root))) {
        return rejected([{ code: "workspace-portability", message: `Node ${node.name} contains the planner repository absolute path. Execution uses a different worktree; use repository-relative paths. The saved graph was not changed.` }]);
      }
    }
    const checked = spawnSync(process.env.GRAPHER_COMPILER_PATH!, ["--compile"], { input: JSON.stringify({ graph, finalCheck: false }), encoding: "utf8", timeout: 10000 });
    if (checked.error || checked.status !== 0) return rejected([{ code: "compiler-unavailable", message: checked.error?.message || checked.stderr || `Compiler exited with status ${checked.status}` }]);
    let output;
    try { output = JSON.parse(checked.stdout); }
    catch { return rejected([{ code: "compiler-response", message: "Compiler returned invalid JSON. The saved graph was not changed." }]); }
    if (output.diagnostics?.length) return rejected(output.diagnostics);
    if (!output.plan) return rejected([{ code: "compiler-response", message: "Compiler returned no plan. The saved graph was not changed." }]);
    writeFileSync(graphPath, JSON.stringify(graph));
    // Echo topology, not every task accumulated so far on every mutation.
    // The planner already authored the tasks; repeated full graphs grow its
    // context quadratically without adding information.
    // This validates one intermediate mutation. It does not establish that the
    // graph covers the user's full goal; the host performs final compilation
    // after the planner exits.
    return result(JSON.stringify({ mutationApplied: true, structuralCheck: "passed", nodes: graph.nodes.map(node => node.name), edges: graph.edges, plan: output.plan }));
  }
  pi.registerTool(defineTool({
    name: "node", label: "Graph node",
    description: `Create or replace a node's task by stable name. A node is a work outcome executed later in a fresh session; it receives this task and upstream filesystem changes, not the planner conversation. Include the context, constraints and completion evidence the worker needs. Paths refer to the worker's repository; the planner checkout and shared Git metadata are unavailable there.

Updating a name replaces its entire task and preserves edges. Deleting a node also removes its incident edges. To rename, create the new node, reconnect its edges and delete the old one. Mutations are atomic: compiler errors leave the saved graph unchanged and return diagnostics plus saved topology. Success returns topology and a structural plan with warnings; it does not certify goal coverage. Independent terminals are allowed.`,
    parameters: Type.Object({
      name: Type.String({ description: "Stable identifier: 1–64 ASCII letters, digits, _ or -." }),
      task: Type.Optional(Type.String({ description: "Complete standalone task. Required and nonempty when creating or replacing a node." })),
      delete: Type.Optional(Type.Boolean({ description: "Remove this node and all its incident edges; task is ignored." })),
    }),
    async execute(_id, parameters) {
      return mutate((graph) => {
        graph.nodes = graph.nodes.filter((node) => node.name !== parameters.name);
        if (parameters.delete) graph.edges = graph.edges.filter((edge) => edge.from !== parameters.name && edge.to !== parameters.name);
        else graph.nodes.push({ name: parameters.name, task: parameters.task ?? "" });
      });
    },
  }));
  pi.registerTool(defineTool({
    name: "edge", label: "Graph edge",
    description: `Create or replace a directed edge between existing nodes. There is one edge per ordered pair; updating it replaces its relation and feedback flag. Delete removes only that ordered pair.

feedback=false is a dependency: the target waits for successful source completion and receives its filesystem state. A failed source blocks its dependents. Dependency edges must form a DAG; a dependency expresses required state or ordering, not just a topical relationship.

feedback=true is a bounded revision route from a reviewer to a dependency ancestor. Create the dependency path first. The runtime automatically gives every feedback source the required final verdict protocol and interprets its verdict; do not restate marker wording or placement in the node task. Define the review criteria and the actionable corrections it must report. Feedback alone supplies no ordering or inputs. Choose targets that own the rejected files and can apply those corrections; all outgoing feedback targets are retried together and affected downstream work is invalidated.

Each mutation is checked atomically. A rejection returns diagnostics and the unchanged saved topology so you can correct endpoints, ordering or edge type. Successful checks return the current plan and warnings; they do not judge task semantics.`,
    parameters: Type.Object({
      from: Type.String({ description: "Existing source node name." }),
      to: Type.String({ description: "Existing target node name, different from source." }),
      relation: Type.Optional(Type.String({ description: "Human-readable reason for the relationship; runtime behavior is determined by feedback." })),
      feedback: Type.Boolean({ description: "false: dependency carrying filesystem state; true: host-managed bounded review that can rerun an authorized ancestor." }),
      delete: Type.Optional(Type.Boolean({ description: "Remove the ordered pair regardless of its current feedback flag." })),
    }),
    async execute(_id, parameters) {
      return mutate((graph) => {
        graph.edges = graph.edges.filter((edge) => edge.from !== parameters.from || edge.to !== parameters.to);
        if (!parameters.delete) graph.edges.push({ from: parameters.from, to: parameters.to, relation: parameters.relation ?? "", feedback: parameters.feedback });
      });
    },
  }));
}
