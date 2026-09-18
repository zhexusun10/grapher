import { Type } from "@earendil-works/pi-ai";
import { defineTool, createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { registerWorkspacePaths } from "./workspace-paths.mjs";
import { spawnSync } from "node:child_process";

export function repositoryPath(root: string, input = '.', fileOnly = false) {
  root = realpathSync(root);
  if (input === '/workspace' || input.startsWith('/workspace/')) input = root + input.slice('/workspace'.length);
  const path = resolve(root, input);
  const child = relative(root, path);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('path is outside this repository');
  let current = root;
  for (const part of child.split(sep).filter(Boolean)) {
    if (part === '.git') throw new Error('Git metadata is not an inspection input');
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('symlinks are not inspection inputs');
  }
  const stat = lstatSync(path);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('only regular files and directories are readable');
  if (fileOnly && !stat.isFile()) throw new Error('expected a regular file');
  return path;
}

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
  const paths = registerWorkspacePaths(pi, process.env.GRAPHER_WORKSPACE_ROOT || process.cwd(), { shellCommands: true });
  const repository = paths.root;
  const nativeBash = createBashToolDefinition(repository);
  pi.registerTool(defineTool({
    ...nativeBash,
    label: "Read-only inspection",
    description: "Execute a read-only bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
    async execute(id, parameters, signal, onUpdate, ctx) {
      const command = parameters.command;
      const writePattern = /(^|\s|;|&|\|)(>|>>|touch|mkdir|rm|rmdir|mv|cp|tee)(\s|$)/;
      if (writePattern.test(command)) {
        return {
          content: [{ type: "text", text: "Write command rejected. Write operations are forbidden in Planner. Please use 'node' to define a task instead of writing directly." }],
          details: { grapherRejected: true, inspectionRejected: true },
          isError: true
        };
      }
      return nativeBash.execute(id, parameters, signal, onUpdate, ctx);
    }
  }));
  pi.on("tool_call", async event => {
    if (event.toolName === "read") {
      try { repositoryPath(repository, String(event.input.path ?? ""), true); }
      catch { return { block: true, reason: "Planner may read only regular repository files, without symlinks or Git metadata." }; }
    }
  });
  function mutate(change: (graph: Graph) => Diagnostic[] | void) {
    const saved: Graph = JSON.parse(readFileSync(graphPath, "utf8"));
    const graph: Graph = structuredClone(saved);
    const rejected = (diagnostics: { code: string; message: string }[]) => result(JSON.stringify({
      mutationApplied: false,
      structuralCheck: "failed",
      diagnostics,
      savedTopology: { nodes: saved.nodes.map(node => node.name), edges: saved.edges },
    }), true);
    const inputErrors = change(graph);
    if (inputErrors?.length) return rejected(inputErrors);
    for (const node of graph.nodes) node.task = paths.visible(node.task);
    for (const edge of graph.edges) edge.relation = paths.visible(edge.relation);
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
    description: `Create or replace a node's task by stable name. A node is a work outcome executed later in a fresh session; it receives this task and upstream filesystem changes, not the planner conversation. Include the context, constraints and completion evidence the worker needs. Workspace paths use /workspace for every agent; the host maps them to each agent's own checkout.

Updating a name replaces its entire task and preserves edges. Deleting a node also removes its incident edges. To rename, create the new node, reconnect its edges and delete the old one. Independent terminals are allowed.

For a complete graph or related edits, use nodes and edges arrays in ONE call, without top-level name/task/delete. At least one edit is required. Node edits run in array order first, then edge edits in array order; later edits of the same name or ordered pair replace earlier ones. Omitted arrays are empty. Only the resulting graph is compiled, once; intermediate states need not compile. Edges may reference nodes created in this batch; feedback is checked against the final dependency paths. Any failure rejects the whole batch. Existing nodes/edges not edited are retained. Edge fields have the same semantics as the edge tool: omitted feedback is false, omitted relation is empty, delete removes the ordered pair.`,
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Single-node mode: stable identifier, 1–64 ASCII letters, digits, _ or -. Omit in batch mode." })),
      task: Type.Optional(Type.String({ description: "Concise standalone outcome, constraints, owned files or artifacts, authoritative inputs, and observable completion evidence. Required and nonempty unless deleting." })),
      delete: Type.Optional(Type.Boolean({ description: "Remove this node and all its incident edges; task is ignored." })),
      nodes: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        task: Type.Optional(Type.String()),
        delete: Type.Optional(Type.Boolean()),
      }), { description: "Batch node edits, applied before all edge edits." })),
      edges: Type.Optional(Type.Array(Type.Object({
        from: Type.String(),
        to: Type.String(),
        relation: Type.Optional(Type.String()),
        feedback: Type.Optional(Type.Boolean()),
        delete: Type.Optional(Type.Boolean()),
      }), { description: "Batch edge edits, applied after all node edits." })),
    }),
    async execute(_id, parameters) {
      return mutate((graph) => {
        const batch = parameters.nodes !== undefined || parameters.edges !== undefined;
        if (batch) {
          if (parameters.name !== undefined || parameters.task !== undefined || parameters.delete !== undefined) {
            return [{ code: "mutation-input", message: "Use either single-node name/task/delete or batch nodes/edges, not both. The saved graph was not changed." }];
          }
          if (!(parameters.nodes?.length || parameters.edges?.length)) {
            return [{ code: "mutation-input", message: "A batch requires at least one node or edge edit. The saved graph was not changed." }];
          }
          for (const edit of parameters.nodes ?? []) applyNode(graph, edit);
          for (const edit of parameters.edges ?? []) applyEdge(graph, edit);
        } else {
          if (parameters.name === undefined) {
            return [{ code: "mutation-input", message: "Provide a node name or a batch of nodes/edges. The saved graph was not changed." }];
          }
          applyNode(graph, { ...parameters, name: parameters.name });
        }
      });
    },
  }));
  pi.registerTool(defineTool({
    name: "edge", label: "Graph edge",
    description: `Create or replace a directed edge between existing nodes. There is one edge per ordered pair; updating it replaces its relation and feedback flag. Delete removes only that ordered pair.

feedback omitted or false is a dependency: the target waits for successful source completion and receives its filesystem state. A failed source blocks its dependents. A dependency expresses required state or ordering, not just a topical relationship.

feedback=true is a feedback route from a downstream node to one dependency ancestor. Feedback supplies no ordering or filesystem input.`,
    parameters: Type.Object({
      from: Type.String({ description: "Existing source node name." }),
      to: Type.String({ description: "Existing target node name, different from source." }),
      relation: Type.Optional(Type.String({ description: "Human-readable reason for the relationship; runtime behavior is determined by feedback." })),
      feedback: Type.Optional(Type.Boolean({ description: "Omit or false for a dependency carrying filesystem state. True creates a feedback route from this source to one dependency ancestor." })),
      delete: Type.Optional(Type.Boolean({ description: "Remove the ordered pair regardless of its current feedback flag." })),
    }),
    async execute(_id, parameters) {
      return mutate(graph => applyEdge(graph, parameters));
    },
  }));
}
