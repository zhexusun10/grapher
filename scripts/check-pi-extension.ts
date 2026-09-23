import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { loadExtensions } from "../pi/packages/coding-agent/src/core/extensions/loader.ts";
import { convertResponsesTools } from "../pi/packages/ai/src/api/openai-responses-shared.ts";
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
process.env.GRAPHER_COMPILER_PATH ||= resolve("backend/target/debug/grapher");
process.env.GRAPHER_MODE = "planner";
// Planner behavior must not depend on the host's feedback retry setting.
process.env.GRAPHER_MAX_FEEDBACK = "0";
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
  const bashDescription = extension.tools.get("bash")!.definition.description;
  assert.match(bashDescription, /Execute a bash command/);
  assert.equal(extension.handlers.has("tool_call"), false, "Planner has no path or read guards");
  assert.doesNotMatch(extension.tools.get("edge")!.definition.description, /maxFeedback|retry budget|reviewer/i);
  const context = { cwd: repository, sessionManager: { getSessionId: () => "planner-test", getSessionFile: () => undefined } } as unknown as ExtensionContext;
  async function call(name: string, parameters: Record<string, unknown>) {
    const tool = extension.tools.get(name)!.definition;
    const args = validateToolArguments(tool, { type: "toolCall", id: "test", name, arguments: parameters });
    return tool.execute("test", args, undefined, undefined, context);
  }
  const node = (edit: Record<string, unknown>) => call("node", { nodes: [edit] });
  const edge = (edit: Record<string, unknown>) => call("edge", { edges: [edit] });
  // Regression: run 72feb3ad repeatedly supplied both single and batch fields.
  // Verify the actual provider schema, then exercise nullable wire arguments
  // through Pi's validator and the real compiler (not direct execute alone).
  for (const name of ["node", "edge"]) {
    const tool = extension.tools.get(name)!.definition;
    const wire = convertResponsesTools([tool])[0] as any;
    assert.equal(wire.strict, true);
    assert.equal(wire.description, tool.description);
    const key = name === "node" ? "nodes" : "edges";
    assert.deepEqual(Object.keys(wire.parameters.properties), [key]);
    assert.deepEqual(wire.parameters.required, [key]);
    assert.equal(wire.parameters.additionalProperties, false);
    assert.equal(wire.parameters.properties[key].type, "array");
    const item = wire.parameters.properties[key].items;
    for (const field of name === "node" ? ["task", "delete"] : ["relation", "feedback", "delete"]) {
      assert.ok(item.properties[field].anyOf.some((variant: any) => variant.type === "null"));
    }
  }
  const nullableNodes = JSON.parse((await call("node", {
    nodes: [{ name: "nullable-build", task: "Build", delete: null }, { name: "nullable-review", task: "Review", delete: null }],
  })).content[0].text);
  assert.equal(nullableNodes.mutationApplied, true);
  const nullableEdge = JSON.parse((await call("edge", {
    edges: [{ from: "nullable-build", to: "nullable-review", relation: null, feedback: null, delete: null }],
  })).content[0].text);
  assert.equal(nullableEdge.mutationApplied, true);
  assert.equal(JSON.parse((await node({ name: "nullable-build", task: "Updated", delete: null })).content[0].text).mutationApplied, true);
  assert.equal(JSON.parse((await edge({
    from: "nullable-build", to: "nullable-review", relation: null, feedback: null, delete: true,
  })).content[0].text).mutationApplied, true);
  await node({ name: "nullable-build", task: null, delete: true });
  await node({ name: "nullable-review", delete: true });
  const firstMutation = await node({ name: "build", task: "Build it" });
  assert.deepEqual(Object.keys(firstMutation), ["content"]);
  const firstResult = JSON.parse(firstMutation.content[0].text);
  assert.deepEqual(firstResult, { mutationApplied: true });
  await node({ name: "review", task: "Review it" });
  const beforeFeedback = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  const prematureFeedback = JSON.parse((await edge({ from: "review", to: "build", feedback: true })).content[0].text);
  assert.equal(prematureFeedback.mutationApplied, false);
  assert.deepEqual(Object.keys(prematureFeedback), ["mutationApplied", "diagnostics"]);
  assert.match(prematureFeedback.diagnostics[0], /dependency path from build to review/);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), beforeFeedback);
  const missingEndpoint = JSON.parse((await edge({ from: "build", to: "missing", feedback: false })).content[0].text);
  assert.match(missingEndpoint.diagnostics[0], /Missing: missing/);
  assert.match(missingEndpoint.diagnostics[0], /Existing nodes: build, review/);
  const dependency = await edge({ from: "build", to: "review" });
  assert.deepEqual(Object.keys(dependency), ["content"]);
  assert.deepEqual(JSON.parse(dependency.content[0].text), { mutationApplied: true });
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges[0].feedback, false);
  const before = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
  const rejected = await edge({ from: "review", to: "build", feedback: false });
  assert.deepEqual(Object.keys(rejected), ["content", "details"]);
  assert.deepEqual(rejected.details.diagnosticCodes, ["E101"]);
  assert.doesNotMatch(rejected.content[0].text, /E101/);
  const cycle = JSON.parse(rejected.content[0].text);
  assert.equal(cycle.mutationApplied, false);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), before);
  assert.match(cycle.diagnostics[0], /build → review/);
  assert.match(cycle.diagnostics[0], /review → build/);
  const toolResultHook = extension.handlers.get("tool_result")![0];
  assert.deepEqual(await toolResultHook({ toolName: "edge", details: rejected.details, isError: false }), { isError: true });
  const accepted = await node({ name: "review", task: "Review it" });
  assert.equal(await toolResultHook({ toolName: "node", details: accepted.details, isError: false }), undefined);
  assert.deepEqual(JSON.parse(accepted.content[0].text), { mutationApplied: true });
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), before);
  const repairedFeedback = JSON.parse((await edge({ from: "review", to: "build", feedback: true })).content[0].text);
  assert.deepEqual(repairedFeedback, { mutationApplied: true });
  const portableGraph = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  for (const task of [`Work at ${repository}.`, `Read ${repository}/sample.txt`]) {
    await node({ name: "build", task });
    const savedTask = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).nodes.find((n: { name: string }) => n.name === "build").task;
    assert.equal(savedTask, task, "Task content is not rewritten");
  }
  await node({ name: "build", task: "In your assigned worktree, update sample.txt and verify it." });
  assert.match(JSON.stringify(await call("bash", { command: "cat sample.txt" })), /planner fixture/);
  for (const command of ["cat ../rubric.json", "cat outside/rubric.json", "printf changed > changed"]) {
    await call("bash", { command });
  }
  assert.equal(readFileSync(join(repository, "changed"), "utf8"), "changed");
  assert.equal(extension.handlers.has("context"), false, "Planner must preserve file contents and tool results");
  await node({ name: "build", delete: true });
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges.length, 0);
  // Each tool compiles its own batch once.
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
  const nodeBatch = JSON.parse((await call("node", { nodes: batchNodes })).content[0].text);
  assert.deepEqual(nodeBatch, { mutationApplied: true });
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges.length, 0);
  const batchResult = JSON.parse((await call("edge", { edges: batchEdges })).content[0].text);
  assert.deepEqual(batchResult, { mutationApplied: true });
  assert.equal(readFileSync(compilerCalls, "utf8"), "compile\ncompile\n");
  const batchSaved = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  assert.equal(JSON.parse(batchSaved).originalGoal, "Batch fixture");
  assert.ok(JSON.parse(batchSaved).edges.every((edge: { feedback: boolean }) => edge.feedback === false));
  const redundant = await call("edge", { edges: [
    { from: "contract", to: "integration", relation: "Integration uses the contract" },
    { from: "contract", to: "verification", relation: "Verification uses the contract" },
  ] });
  const redundantResult = JSON.parse(redundant.content[0].text);
  assert.equal(redundantResult.mutationApplied, false);
  assert.equal(redundantResult.diagnostics.length, 2);
  assert.deepEqual(redundant.details.diagnosticCodes, ["E209", "E209"]);
  assert.match(redundantResult.diagnostics[0], /contract → parser → integration/);
  assert.equal(redundantResult.retryHint, undefined);
  assert.deepEqual(Object.keys(redundantResult), ["mutationApplied", "diagnostics"]);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), batchSaved);
  assert.deepEqual(await toolResultHook({ toolName: "edge", details: redundant.details, isError: false }), { isError: true });
  for (const [toolName, edits, code] of [
    ["edge", { edges: [{ from: "verification", to: "contract" }] }, "E101"],
    ["edge", { edges: [{ from: "contract", to: "missing" }] }, "E204"],
    ["edge", { edges: [{ from: "parser", to: "search", feedback: true }] }, "E207"],
    ["edge", { edges: [
      { from: "verification", to: "parser", feedback: true },
      { from: "verification", to: "search", feedback: true },
    ] }, "E208"],
    ["node", { nodes: [{ name: "new", task: "New task" }, { name: "invalid" }] }, "E203"],
    ["node", { nodes: [{ name: "new" }] }, "E203"],

  ] as const) {
    const response = await call(toolName, edits);
    const rejectedBatch = JSON.parse(response.content[0].text);
    assert.equal(rejectedBatch.mutationApplied, false);
    assert.equal(typeof rejectedBatch.diagnostics[0], "string");
    assert.equal(response.details.diagnosticCodes[0], code);
    assert.deepEqual(Object.keys(rejectedBatch), ["mutationApplied", "diagnostics"]);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), batchSaved);
    assert.deepEqual(await toolResultHook({ toolName, details: response.details, isError: false }), { isError: true });
  }
  // Duplicate targets are rejected before applying even the first valid edit
  // or invoking the compiler. Identical repeats and delete+replace also fail.
  const beforeDuplicates = readFileSync(compilerCalls, "utf8");
  for (const [toolName, key, edits] of [
    ["node", "nodes", [{ name: "new", task: "New" }, { name: "contract", task: "First" }, { name: "contract", task: "Last" }]],
    ["node", "nodes", [{ name: "new", task: "New" }, { name: "contract", delete: true }, { name: "contract", task: "Recreate" }]],
    ["node", "nodes", [{ name: "new", task: "New" }, { name: "contract", task: "Same" }, { name: "contract", task: "Same" }]],
    ["edge", "edges", [{ from: "contract", to: "search", delete: true }, { from: "contract", to: "parser", delete: true }, { from: "contract", to: "parser" }]],
    ["edge", "edges", [{ from: "contract", to: "search", delete: true }, { from: "contract", to: "parser" }, { from: "contract", to: "parser", feedback: true }]],
    ["edge", "edges", [{ from: "contract", to: "search", delete: true }, { from: "contract", to: "parser" }, { from: "contract", to: "parser" }]],
  ] as const) {
    const response = await call(toolName, { [key]: edits });
    const rejectedDuplicate = JSON.parse(response.content[0].text);
    assert.equal(rejectedDuplicate.mutationApplied, false);
    assert.deepEqual(response.details.diagnosticCodes, ["duplicate-target"]);
    assert.match(rejectedDuplicate.diagnostics[0], new RegExp(`${key}\\[2\\]`));
    assert.ok(rejectedDuplicate.diagnostics[0].includes(`${key}[1]`));
    assert.match(rejectedDuplicate.diagnostics[0], /contract/);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), batchSaved);
    assert.equal(readFileSync(compilerCalls, "utf8"), beforeDuplicates);
    assert.deepEqual(await toolResultHook({ toolName, details: response.details, isError: false }), { isError: true });
  }
  for (const [toolName, invalid] of [
    ["node", {}],
    ["node", { nodes: null }],
    ["node", { name: "contract", task: "Legacy single edit" }],
    ["node", { name: "contract", nodes: batchNodes }],
    ["node", { name: "", task: "", delete: false, nodes: batchNodes }],
    ["node", { nodes: [] }],
    ["node", { nodes: batchNodes, edges: batchEdges }],
    ["edge", {}],
    ["edge", { edges: null }],
    ["edge", { from: "contract", to: "parser" }],
    ["edge", { from: "contract", edges: batchEdges }],
    ["edge", { from: "", to: "", relation: "", feedback: false, delete: false, edges: batchEdges }],
    ["edge", { edges: [] }],
    ["edge", { edges: batchEdges, nodes: batchNodes }],
  ] as const) {
    const tool = extension.tools.get(toolName)!.definition;
    assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "invalid", name: toolName, arguments: invalid }));
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), batchSaved);
  }
  // A single edit uses the same array interface.
  const single = JSON.parse((await node({ name: "single", task: "Single task" })).content[0].text);
  assert.equal(single.mutationApplied, true);
  await node({ name: "single", delete: true });
  // Reversing an edge creates a temporary cycle; only the final batch must compile.
  const rewired = JSON.parse((await call("edge", { edges: [
    { from: "parser", to: "contract" },
    { from: "contract", to: "parser", delete: true },
    { from: "parser", to: "integration", delete: true },
    { from: "verification", to: "parser", feedback: true },
  ] })).content[0].text);
  assert.equal(rewired.mutationApplied, true);
  assert.deepEqual(rewired, { mutationApplied: true });
  // Node deletion removes incident edges; other targets can be replaced atomically.
  assert.equal(JSON.parse((await call("node", { nodes: [
    { name: "contract", delete: true },
    { name: "search", task: "Final replacement" },
  ] })).content[0].text).mutationApplied, false);
  // The failed mutation leaves the saved graph untouched; add a direct path
  // around the deleted node in the same batch before removing it.
  assert.equal(JSON.parse((await call("edge", { edges: [
    { from: "parser", to: "integration" },
    { from: "parser", to: "contract", delete: true },
  ] })).content[0].text).mutationApplied, true);
  assert.equal(JSON.parse((await call("node", { nodes: [
    { name: "contract", delete: true },
    { name: "search", task: "Final replacement" },
  ] })).content[0].text).mutationApplied, true);
  const afterDeletion = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"));
  assert.equal(afterDeletion.nodes.find((n: { name: string }) => n.name === "search").task, "Final replacement");
  assert.ok(afterDeletion.edges.every((e: { from: string; to: string }) => e.from !== "contract" && e.to !== "contract"));
  // A dependency and its feedback route can be created in one edge batch.
  assert.equal(JSON.parse((await call("node", { nodes: [{ name: "fix", task: "Fix" }, { name: "check", task: "Check" }] })).content[0].text).mutationApplied, true);
  assert.equal(JSON.parse((await call("edge", { edges: [
    { from: "check", to: "fix", feedback: true }, { from: "fix", to: "check" },
  ] })).content[0].text).mutationApplied, true);
  const beforeUnavailable = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  process.env.GRAPHER_COMPILER_PATH = join(root, "missing-compiler");
  const unavailable = await call("node", { nodes: [{ name: "fix", task: "Changed" }] });
  assert.deepEqual(unavailable.details.diagnosticCodes, ["compiler-unavailable"]);
  assert.match(unavailable.content[0].text, /missing-compiler ENOENT/);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), beforeUnavailable);
  process.env.GRAPHER_COMPILER_PATH = compilerPath;

  // The Planner extension is self-contained; no path adapter is needed.
  process.env.GRAPHER_MODE = "planner";
  writeFileSync(join(root, "grapher-planner.ts"), readFileSync(join(source, "backend/resources/planner.ts")));
  const extracted = await loadExtensions([join(root, "grapher-planner.ts"), adapterPath], repository);
  assert.deepEqual(extracted.errors, []);
  assert.deepEqual([...extracted.extensions[0].tools.keys()].sort(), ["bash", "edge", "node"]);
  const listed = await extracted.extensions[0].tools.get("bash")!.definition.execute("extracted", { command: "ls" }, undefined, undefined, context);
  assert.match(JSON.stringify(listed), /sample.txt/);

  // Partitioner and Merger use the same namespace without the Planner extension.
  for (const mode of ["partition", "merger"]) {
    process.env.GRAPHER_MODE = mode;
    const roleExtension = await loadExtensions([adapterPath], repository);
    assert.deepEqual(roleExtension.errors, []);
    const hooks = roleExtension.extensions[0].handlers;
    assert.equal(hooks.has("before_agent_start"), mode !== "partition", "Working roles receive the relative-path convention");
    assert.equal(hooks.has("context"), false, "No content rewriting");
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
  const { createFindToolDefinition } = await import("../pi/packages/coding-agent/src/core/tools/find.ts");
  const { createGrepToolDefinition } = await import("../pi/packages/coding-agent/src/core/tools/grep.ts");
  const builtins = new Map([
    ["read", createReadToolDefinition(repository)],
    ["write", createWriteToolDefinition(repository)],
    ["edit", createEditToolDefinition(repository)],
    ["ls", createLsToolDefinition(repository)],
    ["find", createFindToolDefinition(repository)],
    ["grep", createGrepToolDefinition(repository)],
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
  await workerCall("write", { path: "mapped.txt", content: "before\n" });
  await workerCall("edit", { path: "mapped.txt", edits: [{ oldText: "before", newText: "after" }] });
  assert.match(JSON.stringify(await workerCall("read", { path: "mapped.txt" })), /after/);
  const updates: any[] = [];
  const shellResult = await workerCall("bash", { command: "pwd; cat mapped.txt" }, update => updates.push(update));
  assert.match(JSON.stringify(shellResult), /after/);
  assert.ok(JSON.stringify(shellResult).includes(repository), "Native output is not rewritten");
  assert.ok(updates.some(update => JSON.stringify(update).includes(repository)));
  assert.match(JSON.stringify(await workerCall("ls", { path: "." })), /mapped.txt/);
  assert.equal(readFileSync(join(repository, "mapped.txt"), "utf8"), "after\n");
  assert.match(JSON.stringify(await workerCall("find", { pattern: "*.txt", path: repository })), /mapped.txt/);
  assert.match(JSON.stringify(await workerCall("grep", { pattern: "after", path: repository })), /mapped.txt/);
  const externalFile = join(root, "external space ' quote.txt");
  await workerCall("write", { path: externalFile, content: "external before\n" });
  await workerCall("edit", { path: externalFile, edits: [{ oldText: "before", newText: "after" }] });
  assert.match(JSON.stringify(await workerCall("read", { path: externalFile })), /external after/);
  assert.match(JSON.stringify(await workerCall("read", { path: "outside/external space ' quote.txt" })), /external after/);

  // Ordinary shell programs must have native semantics, for Node and Merger.
  for (const mode of ["node", "merger"]) {
    process.env.GRAPHER_MODE = mode;
    const loaded = await loadExtensions([adapterPath], repository);
    assert.deepEqual(loaded.errors, []);
    const adapter = loaded.extensions[0];
    assert.equal(adapter.handlers.has("tool_call"), false, "No implicit shell command rewriting");
    const bash = adapter.tools.get("bash")!.definition;
    for (const command of [
      "false; printf continued",
      "false | cat; printf continued",
      "grep 'not-present' mapped.txt; printf continued",
    ]) {
      const input = { command };
      const result = await bash.execute(`${mode}-${command}`, input, undefined, undefined, context);
      assert.match(JSON.stringify(result), /continued/);
      assert.equal(input.command, command, "Caller parameters remain unchanged");
      assert.equal(result.details?.exitCode, 0);
    }
    await assert.rejects(() => bash.execute(`${mode}-failure`, { command: "exit 17" }, undefined, undefined, context), /code 17/);
    await assert.rejects(() => bash.execute(`${mode}-strict`, { command: "set -e; false; printf unreachable" }, undefined, undefined, context), /code 1/);
    await assert.rejects(() => bash.execute(`${mode}-timeout`, { command: "sleep 5", timeout: 0.1 }, undefined, undefined, context), /timed out/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => bash.execute(`${mode}-abort`, { command: "sleep 5" }, controller.signal, undefined, context), /abort/i);
    const results = await Promise.all(["first", "second"].map(value => bash.execute(`${mode}-${value}`, { command: `printf ${value}` }, undefined, undefined, context)));
    for (const [index, value] of ["first", "second"].entries()) {
      assert.match(JSON.stringify(results[index].content), new RegExp(value));
      assert.equal(results[index].details?.command, `printf ${value}`);
    }
  }
  // This proves native macOS execution in this tool-adapter smoke only.
  if (process.platform === "darwin") {
    const native = await workerCall("bash", { command: "/usr/bin/uname -s; /usr/bin/sw_vers -productVersion; /usr/bin/xcrun --find clang" });
    assert.match(JSON.stringify(native.content), /Darwin/);
  }
  console.log(`Pi extension smoke passed on ${process.platform}: read/write/edit/ls/find/grep/bash, external paths and symlinks, shell semantics, failures/cancellation, Planner graph tools. This is not a production launcher or transparent mapping test.`);
} finally {
  process.chdir(source);
  rmSync(root, { recursive: true, force: true });
}
