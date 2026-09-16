import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { loadExtensions } from "../pi/packages/coding-agent/src/core/extensions/loader.ts";
import { validateToolArguments } from "../pi/packages/ai/src/utils/validation.ts";
import type { ExtensionContext } from "../pi/packages/coding-agent/src/core/extensions/types.ts";

const source = process.cwd();
const root = realpathSync(mkdtempSync(join(tmpdir(), "grapher-extension-")));
const repository = join(root, "repository");
mkdirSync(repository);
writeFileSync(join(repository, "sample.txt"), "planner fixture\n");
writeFileSync(join(root, "rubric.json"), "hidden criteria");
symlinkSync(root, join(repository, "outside"));
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
  assert.deepEqual([...extension.tools.keys()].sort(), ["bash", "edge", "node"]);
  const context = {} as ExtensionContext;
  async function call(name: string, parameters: Record<string, unknown>) {
    const tool = extension.tools.get(name)!.definition;
    const args = validateToolArguments(tool, { type: "toolCall", id: "test", name, arguments: parameters });
    return tool.execute("test", args, undefined, undefined, context);
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
    await call("node", { name: "build", task });
    const savedTask = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).nodes.find((n: { name: string }) => n.name === "build").task;
    assert.equal(savedTask, task.replaceAll(repository, "/workspace"));
  }
  await call("node", { name: "build", task: "In your assigned worktree, update sample.txt and verify it." });
  const handlers = extension.handlers.get("tool_call")!.slice(-1);
  assert.equal(await handlers[0]({ toolName: "read", input: { path: "sample.txt" } }), undefined);
  for (const path of ["../rubric.json", "outside/rubric.json", root, "missing", ".", ".git/config"]) {
    assert.equal((await handlers[0]({ toolName: "read", input: { path } }) as { block: boolean }).block, true);
  }
  assert.match(JSON.stringify(await call("bash", { command: "cat sample.txt" })), /planner fixture/);
  for (const command of ["cat ../rubric.json", "cat outside/rubric.json", "touch changed", "curl file:///etc/passwd", "ls; rm -rf ."]) {
    const response = await call("bash", { command });
    assert.equal((response as { isError: boolean }).isError, true, command);
    assert.deepEqual(await toolResultHook({ toolName: "bash", details: response.details, isError: false }), { isError: true });
  }
  for (const file of ["backend/src/server.rs", "benchmark/planning-host.rs"]) {
    const text = readFileSync(join(source, file), "utf8");
    assert.ok(text.includes('"node,edge,read,bash"'), `${file}: tool surface`);
    assert.ok(!text.includes('"node,edge,inspect"'));
  }
  assert.match(readFileSync(join(source, "backend/src/server.rs"), "utf8"), /include_str!\("\.\.\/resources\/planning-inspection\.mjs"\)/);
  await call("node", { name: "build", delete: true });
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges.length, 0);
  // A real five-node graph is committed with one compiler invocation.
  const compilerPath = process.env.GRAPHER_COMPILER_PATH!;
  const countedCompiler = join(root, "counted-compiler.mjs");
  const compilerCalls = join(root, "compiler-calls.txt");
  writeFileSync(countedCompiler, `#!${process.execPath}\nimport { appendFileSync, readFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nappendFileSync(${JSON.stringify(compilerCalls)}, 'compile\\n');\nconst result = spawnSync(${JSON.stringify(compilerPath)}, process.argv.slice(2), { input: readFileSync(0), encoding: 'utf8' });\nprocess.stdout.write(result.stdout || '');\nprocess.stderr.write(result.stderr || '');\nprocess.exit(result.status ?? 1);\n`);
  chmodSync(countedCompiler, 0o755);
  process.env.GRAPHER_COMPILER_PATH = countedCompiler;
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({ originalGoal: "Batch fixture", nodes: [], edges: [] }));
  const batchNodes = ["contract", "parser", "search", "integration", "verification"].map(name => ({ name, task: `Complete ${name}` }));
  const batchEdges = [
    { from: "contract", to: "parser" }, { from: "contract", to: "search" },
    { from: "parser", to: "integration" }, { from: "search", to: "integration" },
    { from: "integration", to: "verification" },
  ];
  const batchResult = JSON.parse((await call("node", { nodes: batchNodes, edges: batchEdges })).content[0].text);
  assert.equal(batchResult.mutationApplied, true);
  assert.deepEqual(batchResult.plan.executionBatches, [["contract"], ["parser", "search"], ["integration"], ["verification"]]);
  assert.equal(readFileSync(compilerCalls, "utf8"), "compile\n");
  const batchSaved = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  assert.equal(JSON.parse(batchSaved).originalGoal, "Batch fixture");
  assert.ok(JSON.parse(batchSaved).edges.every((edge: { feedback: boolean }) => edge.feedback === false));
  for (const [edits, code] of [
    [{ nodes: [{ name: "new", task: "New task" }], edges: [{ from: "verification", to: "contract" }] }, "E101"],
    [{ nodes: [{ name: "new", task: "New task" }], edges: [{ from: "new", to: "missing" }] }, "E204"],
    [{ edges: [{ from: "parser", to: "search", feedback: true }] }, "E207"],
    [{ nodes: [{ name: "new" }] }, "E203"],
    [{ nodes: [], edges: [] }, "mutation-input"],
    [{ name: "contract", nodes: batchNodes }, "mutation-input"],
    [{ task: "orphan" }, "mutation-input"],
  ] as const) {
    const response = await call("node", edits);
    const rejectedBatch = JSON.parse(response.content[0].text);
    assert.equal(rejectedBatch.mutationApplied, false);
    assert.equal(rejectedBatch.diagnostics[0].code, code);
    assert.deepEqual(rejectedBatch.savedTopology, { nodes: batchNodes.map(n => n.name), edges: JSON.parse(batchSaved).edges });
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), batchSaved);
    assert.deepEqual(await toolResultHook({ toolName: "node", details: response.details, isError: false }), { isError: true });
  }
  // Reversing an edge creates a temporary cycle; only the final batch must compile.
  const rewired = JSON.parse((await call("node", { edges: [
    { from: "parser", to: "contract" },
    { from: "contract", to: "parser", delete: true },
    { from: "verification", to: "parser", feedback: true },
  ] })).content[0].text);
  assert.equal(rewired.mutationApplied, true);
  assert.deepEqual(rewired.plan.roots, ["parser"]);
  // Node deletion removes incident edges; replacements and repeated edits follow array order.
  assert.equal(JSON.parse((await call("node", { nodes: [
    { name: "contract", delete: true },
    { name: "search", task: "First replacement" },
    { name: "search", task: "Final replacement" },
  ] })).content[0].text).mutationApplied, true);
  const afterDeletion = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"));
  assert.equal(afterDeletion.nodes.find((n: { name: string }) => n.name === "search").task, "Final replacement");
  assert.ok(afterDeletion.edges.every((e: { from: string; to: string }) => e.from !== "contract" && e.to !== "contract"));
  // A dependency and its feedback route can be created in one batch, in either edge order.
  assert.equal(JSON.parse((await call("node", { nodes: [{ name: "fix", task: "Fix" }, { name: "check", task: "Check" }], edges: [
    { from: "check", to: "fix", feedback: true }, { from: "fix", to: "check" },
  ] })).content[0].text).mutationApplied, true);
  const beforeUnavailable = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  process.env.GRAPHER_COMPILER_PATH = join(root, "missing-compiler");
  assert.match((await call("node", { nodes: [{ name: "fix", task: "Changed" }] })).content[0].text, /compiler-unavailable/);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), beforeUnavailable);
  process.env.GRAPHER_COMPILER_PATH = compilerPath;

  // Production extracts the extension and its inspection module together.
  process.env.GRAPHER_MODE = "planner";
  writeFileSync(join(root, "grapher-planner.ts"), readFileSync(join(source, "backend/resources/planner.ts")));
  writeFileSync(join(root, "workspace-paths.mjs"), readFileSync(join(source, "backend/resources/workspace-paths.mjs")));
  writeFileSync(join(root, "planning-inspection.mjs"), readFileSync(join(source, "backend/resources/planning-inspection.mjs")));
  const extracted = await loadExtensions([join(root, "grapher-planner.ts"), adapterPath], repository);
  assert.deepEqual(extracted.errors, []);
  assert.deepEqual([...extracted.extensions[0].tools.keys()].sort(), ["bash", "edge", "node"]);
  const listed = await extracted.extensions[0].tools.get("bash")!.definition.execute("extracted", { command: "ls" }, undefined, undefined, context);
  assert.match(JSON.stringify(listed), /sample.txt/);
  const visibleListing = await extracted.extensions[0].tools.get("bash")!.definition.execute("visible", { command: "ls /workspace && cat /workspace/sample.txt" }, undefined, undefined, context);
  assert.match(JSON.stringify(visibleListing), /planner fixture/);
  // Partitioner and Merger use the same namespace without the Planner extension.
  for (const mode of ["partition", "merger"]) {
    process.env.GRAPHER_MODE = mode;
    const roleExtension = await loadExtensions([adapterPath], repository);
    assert.deepEqual(roleExtension.errors, []);
    const hooks = roleExtension.extensions[0].handlers;
    const prompt = await hooks.get("before_agent_start")![0]({ systemPrompt: `Current working directory: ${repository}` });
    assert.equal(prompt.systemPrompt, "Current working directory: /workspace");
    if (mode === "partition") assert.equal(roleExtension.extensions[0].tools.size, 0);
    else assert.ok(roleExtension.extensions[0].tools.has("bash"));
  }
  // Exercise the production node adapter with real read/write/edit/bash tools.
  process.env.GRAPHER_MODE = "node";
  const worker = await loadExtensions([adapterPath], repository);
  assert.deepEqual(worker.errors, []);
  const workerExtension = worker.extensions[0];
  const { createReadToolDefinition } = await import("../pi/packages/coding-agent/src/core/tools/read.ts");
  const { createWriteToolDefinition } = await import("../pi/packages/coding-agent/src/core/tools/write.ts");
  const { createEditToolDefinition } = await import("../pi/packages/coding-agent/src/core/tools/edit.ts");
  const { createLsToolDefinition } = await import("../pi/packages/coding-agent/src/core/tools/ls.ts");
  const builtins = new Map([
    ["read", createReadToolDefinition(repository)],
    ["write", createWriteToolDefinition(repository)],
    ["edit", createEditToolDefinition(repository)],
    ["ls", createLsToolDefinition(repository)],
  ]);
  async function workerCall(name: string, input: Record<string, unknown>, onUpdate?: (update: any) => void) {
    for (const hook of workerExtension.handlers.get("tool_call") ?? []) await hook({ toolName: name, input });
    const definition = workerExtension.tools.get(name)?.definition ?? builtins.get(name)!;
    let response = await definition.execute("worker-test", input, undefined, onUpdate, { cwd: repository, sessionManager: { getSessionId: () => "mapped-worker", getSessionFile: () => undefined } } as unknown as ExtensionContext);
    for (const hook of workerExtension.handlers.get("tool_result") ?? []) {
      const replacement = await hook({ toolName: name, toolCallId: "worker-test", input, content: response.content, details: response.details, isError: false });
      if (replacement) response = { ...response, ...replacement };
    }
    return response;
  }
  await workerCall("write", { path: "/workspace/mapped.txt", content: "before\n" });
  await workerCall("edit", { path: "/workspace/mapped.txt", edits: [{ oldText: "before", newText: "after" }] });
  assert.match(JSON.stringify(await workerCall("read", { path: "/workspace/mapped.txt" })), /after/);
  const updates: any[] = [];
  const shellResult = await workerCall("bash", { command: "pwd; cat /workspace/mapped.txt" }, update => updates.push(update));
  assert.match(JSON.stringify(shellResult), /after/);
  assert.match(JSON.stringify(shellResult), /\/workspace/);
  assert.ok(!JSON.stringify(shellResult).includes(repository));
  assert.ok(updates.some(update => JSON.stringify(update).includes("/workspace")));
  assert.ok(updates.every(update => !JSON.stringify(update).includes(repository)));
  assert.match(JSON.stringify(await workerCall("ls", { path: "/workspace" })), /mapped.txt/);
  assert.equal(readFileSync(join(repository, "mapped.txt"), "utf8"), "after\n");
  console.log("Pi extension smoke passed: restricted tools, read guards, extracted resources, atomic batches, worker path mapping and rollback.");
} finally {
  process.chdir(source);
  rmSync(root, { recursive: true, force: true });
}
