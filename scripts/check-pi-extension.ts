import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { loadExtensions } from "../pi/packages/coding-agent/src/core/extensions/loader.ts";
import type { ExtensionContext } from "../pi/packages/coding-agent/src/core/extensions/types.ts";

const source = process.cwd();
const root = realpathSync(mkdtempSync(join(tmpdir(), "grapher-extension-")));
const repository = join(root, "repository");
mkdirSync(repository);
writeFileSync(join(repository, "sample.txt"), "inspection marker\n");
writeFileSync(join(root, "rubric.json"), "hidden grading criteria");
symlinkSync(root, join(repository, "outside"));
process.env.GRAPHER_GRAPH_PATH = join(root, "graph.json");
process.env.GRAPHER_COMPILER_PATH = resolve("backend/target/debug/grapher");
process.env.GRAPHER_MODE = "planner";
writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({ originalGoal: "Test", nodes: [], edges: [] }));
process.chdir(repository);

try {
  const loaded = await loadExtensions([join(source, "backend/resources/planner.ts")], repository);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()].sort(), ["bash", "edge", "node"]);
  const context = {} as ExtensionContext;
  async function call(name: string, parameters: Record<string, unknown>) {
    return extension.tools.get(name)!.definition.execute("test", parameters, undefined, undefined, context);
  }
  const firstMutation = await call("node", { name: "build", task: "Build it" });
  const firstResult = JSON.parse(firstMutation.content[0].text);
  assert.equal(firstResult.mutationApplied, true);
  assert.equal(firstResult.structuralCheck, "passed");
  assert.equal(firstResult.accepted, undefined);
  assert.equal(firstResult.graphCompiled, undefined);
  await call("node", { name: "review", task: "Review it" });
  await call("edge", { from: "build", to: "review", feedback: false });
  const before = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
  const rejected = await call("edge", { from: "review", to: "build", feedback: false });
  assert.match(JSON.stringify(rejected), /E101/);
  const toolResultHook = extension.handlers.get("tool_result")![0];
  assert.deepEqual(await toolResultHook({ toolName: "edge", details: rejected.details, isError: false }), { isError: true });
  const accepted = await call("node", { name: "review", task: "Review it" });
  assert.equal(await toolResultHook({ toolName: "node", details: accepted.details, isError: false }), undefined);
  assert.equal(JSON.parse(accepted.content[0].text).graph, undefined);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), before);
  await call("edge", { from: "review", to: "build", feedback: true });
  const portableGraph = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  for (const task of [`Work at ${repository}.`, `Read ${repository}/sample.txt`]) {
    assert.match(JSON.stringify(await call("node", { name: "build", task })), /workspace-portability/);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), portableGraph);
  }
  await call("node", { name: "build", task: "In your assigned worktree, update sample.txt and verify it." });
  const handlers = extension.handlers.get("tool_call")!;
  assert.equal(await handlers[0]({ toolName: "read", input: { path: "sample.txt" } }), undefined);
  for (const path of ["../rubric.json", "outside/rubric.json", root, "missing", "."]) {
    assert.equal((await handlers[0]({ toolName: "read", input: { path } }) as { block: boolean }).block, true);
  }
  const inspected = await call("bash", { command: 'grep -n "inspection marker" sample.txt' });
  assert.match(JSON.stringify(inspected), /sample.txt:1:inspection marker/);
  assert.match(JSON.stringify(inspected), /repository-inspection-v1/);
  for (const command of ["cat ../rubric.json", "cat outside/rubric.json", "touch changed", "curl file:///etc/passwd", "ls; rm -rf ."]) {
    const response = await call("bash", { command });
    assert.equal((response as { isError: boolean }).isError, true, command);
  }
  for (const file of ["backend/src/server.rs", "benchmark/planning-host.rs"]) {
    const text = readFileSync(join(source, file), "utf8");
    assert.ok(text.includes('"node,edge,read,bash"'), `${file}: tool surface`);
    assert.ok(!text.includes('"node,edge,read,ls,find,grep"'));
  }
  assert.match(readFileSync(join(source, "backend/src/server.rs"), "utf8"), /include_str!\("\.\.\/resources\/planning-inspection.mjs"\)/);
  await call("node", { name: "build", delete: true });
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges.length, 0);
  // Production extracts both resources outside the source tree.
  process.env.GRAPHER_MODE = "planner";
  writeFileSync(join(root, "grapher-planner.ts"), readFileSync(join(source, "backend/resources/planner.ts")));
  writeFileSync(join(root, "planning-inspection.mjs"), readFileSync(join(source, "backend/resources/planning-inspection.mjs")));
  const extracted = await loadExtensions([join(root, "grapher-planner.ts")], repository);
  assert.deepEqual(extracted.errors, []);
  const listed = await extracted.extensions[0].tools.get("bash")!.definition.execute("extracted", { command: "ls" }, undefined, undefined, context);
  assert.match(JSON.stringify(listed), /sample.txt/);
  console.log("Pi extension smoke passed: mutation rollback, portability, read-only bash override, repository guards.");
} finally {
  process.chdir(source);
  rmSync(root, { recursive: true, force: true });
}
