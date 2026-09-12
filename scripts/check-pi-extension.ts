import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { loadExtensions } from "../pi/packages/coding-agent/src/core/extensions/loader.ts";
import type { ExtensionContext } from "../pi/packages/coding-agent/src/core/extensions/types.ts";

const root = mkdtempSync(join(tmpdir(), "grapher-extension-"));
process.env.GRAPHER_GRAPH_PATH = join(root, "graph.json");
process.env.GRAPHER_COMPILER_PATH = resolve("backend/target/debug/grapher");
process.env.GRAPHER_MODE = "planner";
writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({ originalGoal: "Test", nodes: [], edges: [] }));

try {
  const loaded = await loadExtensions([resolve("backend/resources/planner.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()].sort(), ["edge", "node"]);
  const context = {} as ExtensionContext;
  async function call(name: string, parameters: Record<string, unknown>) {
    return extension.tools.get(name)!.definition.execute("test", parameters, undefined, undefined, context);
  }
  await call("node", { name: "build", task: "Build it" });
  await call("node", { name: "review", task: "Review it" });
  await call("edge", { from: "build", to: "review", feedback: false });
  const before = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
  const rejected = await call("edge", { from: "review", to: "build", feedback: false });
  assert.match(JSON.stringify(rejected), /E101/);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), before);
  await call("edge", { from: "review", to: "build", feedback: true });
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges.length, 2);
  await call("node", { name: "build", task: "Updated task" });
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).nodes.length, 2);
  const handlers = extension.handlers.get("tool_call")!;
  assert.equal((await handlers[0]({ toolName: "bash", input: { command: "touch forbidden" } }) as { block: boolean }).block, true);
  assert.equal(await handlers[0]({ toolName: "bash", input: { command: "git status --short" } }), undefined);
  await call("node", { name: "build", delete: true });
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges.length, 0);
  process.env.GRAPHER_MODE = "partition";
  const partition = await loadExtensions([resolve("backend/resources/planner.ts")], process.cwd());
  assert.deepEqual(partition.errors, []);
  assert.deepEqual([...partition.extensions[0].tools.keys()], ["route_task"]);
  console.log("Pi extension smoke passed: loading, tool surface, mutation rollback, upsert, deletion, read-only Bash, partitioner.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
