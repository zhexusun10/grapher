import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

type Graph = { originalGoal: string; nodes: { name: string; task: string }[]; edges: { from: string; to: string; relation: string; feedback: boolean }[] };

export default function grapherPlanner(pi: ExtensionAPI) {
  const graphPath = process.env.GRAPHER_GRAPH_PATH!;
  const result = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: {}, isError });
  if (process.env.GRAPHER_MODE === "partition") {
    pi.registerTool(defineTool({
      name: "route_task", label: "Route task", description: "Choose serial for linear work, graph only for multiple substantial independent workstreams.",
      parameters: Type.Object({ plan_type: Type.Union([Type.Literal("serial"), Type.Literal("graph")]), reasoning: Type.String() }),
      async execute(_id, parameters) {
        writeFileSync(graphPath, JSON.stringify(parameters));
        return result("Route saved. Finish your response now.");
      },
    }));
    return;
  }
  function mutate(change: (graph: Graph) => void) {
    const graph: Graph = JSON.parse(readFileSync(graphPath, "utf8"));
    change(graph);
    const checked = spawnSync(process.env.GRAPHER_COMPILER_PATH!, ["--compile"], { input: JSON.stringify({ graph, finalCheck: false }), encoding: "utf8", timeout: 10000 });
    if (checked.error || checked.status !== 0) return result(checked.error?.message ?? checked.stderr, true);
    const output = JSON.parse(checked.stdout);
    if (output.diagnostics?.length) return result(JSON.stringify(output.diagnostics), true);
    writeFileSync(graphPath, JSON.stringify(graph));
    return result(JSON.stringify({ accepted: true, graph, plan: output.plan }));
  }
  pi.registerTool(defineTool({
    name: "node", label: "Graph node", description: "Upsert a semantic node name and standalone specific task; delete also removes its edges.",
    parameters: Type.Object({ name: Type.String(), task: Type.Optional(Type.String()), delete: Type.Optional(Type.Boolean()) }),
    async execute(_id, parameters) {
      return mutate((graph) => {
        graph.nodes = graph.nodes.filter((node) => node.name !== parameters.name);
        if (parameters.delete) graph.edges = graph.edges.filter((edge) => edge.from !== parameters.name && edge.to !== parameters.name);
        else graph.nodes.push({ name: parameters.name, task: parameters.task ?? "" });
      });
    },
  }));
  pi.registerTool(defineTool({
    name: "edge", label: "Graph edge", description: "Upsert a (from,to) edge; explicit feedback=true routes bounded revisions to a dependency ancestor.",
    parameters: Type.Object({ from: Type.String(), to: Type.String(), relation: Type.Optional(Type.String()), feedback: Type.Boolean(), delete: Type.Optional(Type.Boolean()) }),
    async execute(_id, parameters) {
      return mutate((graph) => {
        graph.edges = graph.edges.filter((edge) => edge.from !== parameters.from || edge.to !== parameters.to);
        if (!parameters.delete) graph.edges.push({ from: parameters.from, to: parameters.to, relation: parameters.relation ?? "", feedback: parameters.feedback });
      });
    },
  }));
  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash") {
      const command = String(event.input.command ?? "").trim();
      if (!/^(pwd|ls(?: -[lah]+)?|git status(?: --short)?|git ls-files|rg --files)$/.test(command)) {
        return { block: true, reason: "Planning is inspection-only. Bash supports pwd, ls [-lah], git status [--short], git ls-files, rg --files. Use read for file contents." };
      }
    }
    if (event.toolName === "read") {
      try {
        const path = realpathSync(resolve(process.cwd(), String(event.input.path ?? "")));
        const child = relative(realpathSync(process.cwd()), path);
        if (child.startsWith("..") || isAbsolute(child)) return { block: true, reason: "Planner may read only this repository." };
      } catch { return { block: true, reason: "File is not readable inside this repository." }; }
    }
  });
}
