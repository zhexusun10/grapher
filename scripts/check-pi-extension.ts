import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { loadExtensions } from "../pi/packages/coding-agent/src/core/extensions/loader.ts";
import type { ExtensionContext } from "../pi/packages/coding-agent/src/core/extensions/types.ts";

const source = process.cwd();
const root = realpathSync(mkdtempSync(join(tmpdir(), "grapher-extension-")));
const repository = join(root, "repository");
mkdirSync(repository);
writeFileSync(join(repository, "sample.txt"), "planner fixture\n");
process.env.GRAPHER_GRAPH_PATH = join(root, "graph.json");
process.env.GRAPHER_COMPILER_PATH = resolve("backend/target/debug/grapher");
process.env.GRAPHER_MODE = "planner";
writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({ originalGoal: "Test", nodes: [], edges: [] }));
process.chdir(repository);

try {
  const adapterPath = join(source, "engine/prompt-extension.ts");
  const loaded = await loadExtensions([join(source, "backend/resources/planner.ts"), adapterPath], repository);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions[1].tools.size, 0, "Planner adapter must not add execution tools");
  assert.equal(loaded.extensions[1].handlers.has("tool_call"), false, "Planner graph tools must not get shell hooks");
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()].sort(), ["edge", "node"]);
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
  const beforeFeedback = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  const prematureFeedback = JSON.parse((await call("edge", { from: "review", to: "build", feedback: true })).content[0].text);
  assert.equal(prematureFeedback.mutationApplied, false);
  assert.equal(prematureFeedback.structuralCheck, "failed");
  assert.equal(prematureFeedback.diagnostics[0].code, "E207");
  assert.match(prematureFeedback.diagnostics[0].message, /dependency path from build to review/);
  assert.deepEqual(prematureFeedback.savedTopology.edges, []);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), beforeFeedback);
  const missingEndpoint = JSON.parse((await call("edge", { from: "build", to: "missing", feedback: false })).content[0].text);
  assert.equal(missingEndpoint.diagnostics[0].code, "E204");
  assert.match(missingEndpoint.diagnostics[0].message, /Missing: missing/);
  assert.deepEqual(missingEndpoint.savedTopology.nodes.sort(), ["build", "review"]);
  const dependency = JSON.parse((await call("edge", { from: "build", to: "review" })).content[0].text);
  assert.equal(dependency.mutationApplied, true);
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges[0].feedback, false);
  const before = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
  const rejected = await call("edge", { from: "review", to: "build", feedback: false });
  assert.match(JSON.stringify(rejected), /E101/);
  const cycle = JSON.parse(rejected.content[0].text);
  assert.equal(cycle.mutationApplied, false);
  assert.deepEqual(cycle.savedTopology.edges, JSON.parse(before).edges);
  assert.match(cycle.diagnostics[0].message, /build → review/);
  assert.match(cycle.diagnostics[0].message, /review → build/);
  const toolResultHook = extension.handlers.get("tool_result")![0];
  assert.deepEqual(await toolResultHook({ toolName: "edge", details: rejected.details, isError: false }), { isError: true });
  const accepted = await call("node", { name: "review", task: "Review it" });
  assert.equal(await toolResultHook({ toolName: "node", details: accepted.details, isError: false }), undefined);
  assert.equal(JSON.parse(accepted.content[0].text).graph, undefined);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), before);
  const repairedFeedback = JSON.parse((await call("edge", { from: "review", to: "build", feedback: true })).content[0].text);
  assert.equal(repairedFeedback.mutationApplied, true);
  assert.equal(repairedFeedback.structuralCheck, "passed");
  const portableGraph = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  for (const task of [`Work at ${repository}.`, `Read ${repository}/sample.txt`]) {
    assert.match(JSON.stringify(await call("node", { name: "build", task })), /workspace-portability/);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), portableGraph);
  }
  await call("node", { name: "build", task: "In your assigned worktree, update sample.txt and verify it." });
  for (const file of ["backend/src/server.rs", "benchmark/planning-host.rs"]) {
    const text = readFileSync(join(source, file), "utf8");
    assert.ok(text.includes('"node,edge"'), `${file}: tool surface`);
    assert.ok(!text.includes('"node,edge,inspect"'));
    assert.ok(!text.includes('"node,edge,read,bash"'));
  }
  assert.doesNotMatch(readFileSync(join(source, "backend/src/server.rs"), "utf8"), /include_str!\("\.\.\/resources\/planning-inspection\.mjs"\)/);
  await call("node", { name: "build", delete: true });
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges.length, 0);
  // Production extracts one self-contained Planner extension outside the source tree.
  process.env.GRAPHER_MODE = "planner";
  writeFileSync(join(root, "grapher-planner.ts"), readFileSync(join(source, "backend/resources/planner.ts")));
  const extracted = await loadExtensions([join(root, "grapher-planner.ts"), adapterPath], repository);
  assert.deepEqual(extracted.errors, []);
  assert.deepEqual([...extracted.extensions[0].tools.keys()].sort(), ["edge", "node"]);
  console.log("Pi extension smoke passed: graph-only tool surface, compiler rejection and repair, saved topology, mutation rollback, portability.");
} finally {
  process.chdir(source);
  rmSync(root, { recursive: true, force: true });
}
