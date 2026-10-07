import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { loadExtensions } from "../pi/packages/coding-agent/src/core/extensions/loader.ts";
import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from "../pi/packages/coding-agent/src/core/system-prompt.ts";
import { createBashToolDefinition } from "../pi/packages/coding-agent/src/core/tools/bash.ts";
import { convertResponsesTools } from "../pi/packages/ai/src/api/openai-responses-shared.ts";
import { validateToolArguments } from "../pi/packages/ai/src/utils/validation.ts";
import type { ExtensionContext } from "../pi/packages/coding-agent/src/core/extensions/types.ts";
import { ensureTool } from "../pi/packages/coding-agent/src/utils/tools-manager.ts";

// Exercise the real search tools, but resolve their prerequisites before the
// graph mutations. Unlike the built-ins, retain download/offline diagnostics.
for (const tool of ["fd", "rg"] as const) {
  const binary = await ensureTool(tool, status => console.error(`[Pi tools] ${status.message}`));
  if (!binary) {
    throw new Error(`Pi extension smoke requires ${tool}. Install ripgrep and fd on PATH (Windows: choco install ripgrep fd -y; macOS: brew install ripgrep fd; Debian/Ubuntu: apt-get install ripgrep fd-find), or allow Pi's managed download. Search assertions are not skipped.`);
  }
  execFileSync(binary, ["--version"], { stdio: "inherit", timeout: 10_000 });
}

const source = process.cwd();
const root = realpathSync(mkdtempSync(join(tmpdir(), "grapher-extension-")));
const repository = join(root, "repository");
mkdirSync(repository);
writeFileSync(join(repository, "sample.txt"), "planner fixture\n");
writeFileSync(join(root, "rubric.json"), "hidden criteria");
symlinkSync(root, join(repository, "outside"), process.platform === "win32" ? "junction" : "dir");
process.env.GRAPHER_GRAPH_PATH = join(root, "graph.json");
process.env.GRAPHER_COMPILER_PATH ||= join(resolve(process.env.CARGO_TARGET_DIR || 'backend/target'), `debug/grapher${process.platform === "win32" ? ".exe" : ""}`);
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
  const edgeDescription = extension.tools.get("edge")!.definition.description;
  assert.match(edgeDescription, /Each feedback source may have at most one feedback target\./);
  assert.doesNotMatch(edgeDescription, /maxFeedback|retry budget|reviewer|ignored|non-Git|drain|fork|workspace/i);
  const context = { cwd: repository, sessionManager: { getSessionId: () => "planner-test", getSessionFile: () => undefined } } as unknown as ExtensionContext;
  async function call(name: string, parameters: Record<string, unknown>) {
    const tool = extension.tools.get(name)!.definition;
    const args = validateToolArguments(tool, { type: "toolCall", id: "test", name, arguments: parameters });
    const response = await tool.execute("test", args, undefined, undefined, context);
    if (name === "node" || name === "edge") {
      const feedback = JSON.parse(response.content[0].text);
      const saved = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"));
      for (const edge of saved.edges) assert.deepEqual(Object.keys(edge), ["from", "to", "feedback"]);
      assert.equal(typeof feedback.applied, "boolean");
      const hasWarnings = Object.hasOwn(feedback, "warnings");
      assert.deepEqual(Object.keys(feedback), feedback.applied
        ? ["applied", "topology", ...(hasWarnings ? ["warnings"] : [])]
        : ["applied", "topology", "diagnostics"]);
      assert.deepEqual(feedback.topology, {
        nodes: saved.nodes.map((node: { name: string }) => node.name),
        edges: saved.edges,
      }, "Every result must describe the saved graph, never a rejected candidate or task text");
      if (hasWarnings) {
        assert.ok(Array.isArray(feedback.warnings));
        assert.ok(feedback.warnings.length > 0, "Empty warnings must be omitted from the result");
        assert.ok(feedback.warnings.every((warning: unknown) => typeof warning === "string"));
      }
    }
    return response;
  }
  const node = (edit: Record<string, unknown>) => call("node", { nodes: [edit] });
  const edge = (edit: Record<string, unknown>) => call("edge", { edges: [edit] });
  const feedbackWarning = (from: string, to: string, nodes: string[]) =>
    `W303: If <FEEDBACK> from ${from} to ${to} is applied, the target and dependency descendants will be invalidated: ${nodes.join(", ")}. Completed results must be recomputed; ${to} continues its conversation. Nodes outside this set are unaffected.`;
  // Regression: run 72feb3ad repeatedly supplied both single and batch fields.
  // Verify the actual provider schema, then exercise nullable wire arguments
  // through Pi's validator and the real compiler (not direct execute alone).
  for (const name of ["node", "edge"]) {
    const tool = extension.tools.get(name)!.definition;
    const wire = convertResponsesTools([tool])[0] as any;
    assert.equal(wire.strict, true);
    assert.equal(wire.description, tool.description);
    assert.doesNotMatch(tool.description, /Returns applied|topology|warnings|\bplan\b|executionBatches|dependencyLayers/);
    const key = name === "node" ? "nodes" : "edges";
    assert.deepEqual(Object.keys(wire.parameters.properties), [key]);
    assert.deepEqual(wire.parameters.required, [key]);
    assert.equal(wire.parameters.additionalProperties, false);
    assert.equal(wire.parameters.properties[key].type, "array");
    const item = wire.parameters.properties[key].items;
    assert.deepEqual(Object.keys(item.properties), name === "node" ? ["name", "task", "delete"] : ["from", "to", "feedback", "delete"]);
    for (const field of name === "node" ? ["task", "delete"] : ["feedback", "delete"]) {
      assert.ok(item.properties[field].anyOf.some((variant: any) => variant.type === "null"));
    }
  }
  const nullableNodes = JSON.parse((await call("node", {
    nodes: [{ name: "nullable-build", task: "Build", delete: null }, { name: "nullable-review", task: "Review", delete: null }],
  })).content[0].text);
  assert.equal(nullableNodes.applied, true);
  const nullableEdge = JSON.parse((await call("edge", {
    edges: [{ from: "nullable-build", to: "nullable-review", feedback: null, delete: null }],
  })).content[0].text);
  assert.equal(nullableEdge.applied, true);
  assert.equal(JSON.parse((await node({ name: "nullable-build", task: "Updated", delete: null })).content[0].text).applied, true);
  assert.equal(JSON.parse((await edge({
    from: "nullable-build", to: "nullable-review", feedback: null, delete: true,
  })).content[0].text).applied, true);
  await node({ name: "nullable-build", task: null, delete: true });
  const emptyGraph = JSON.parse((await node({ name: "nullable-review", delete: true })).content[0].text);
  assert.equal(emptyGraph.applied, true, "Mutation checks are not final graph validation");
  assert.deepEqual(emptyGraph.topology, { nodes: [], edges: [] });
  assert.equal(emptyGraph.warnings, undefined);
  const firstMutation = await node({ name: "build", task: "Build it" });
  assert.deepEqual(Object.keys(firstMutation), ["content"]);
  const firstResult = JSON.parse(firstMutation.content[0].text);
  assert.deepEqual(firstResult, {
    applied: true,
    topology: { nodes: ["build"], edges: [] },
  });
  await node({ name: "review", task: "Review it" });
  const beforeFeedback = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  const prematureFeedback = JSON.parse((await edge({ from: "review", to: "build", feedback: true })).content[0].text);
  assert.equal(prematureFeedback.applied, false);
  assert.deepEqual(Object.keys(prematureFeedback), ["applied", "topology", "diagnostics"]);
  assert.match(prematureFeedback.diagnostics[0], /dependency path from build to review/);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), beforeFeedback);
  const missingEndpoint = JSON.parse((await edge({ from: "build", to: "missing", feedback: false })).content[0].text);
  assert.match(missingEndpoint.diagnostics[0], /Missing: missing/);
  assert.match(missingEndpoint.diagnostics[0], /Existing nodes: build, review/);
  const dependency = await edge({ from: "build", to: "review" });
  assert.deepEqual(Object.keys(dependency), ["content"]);
  assert.deepEqual(JSON.parse(dependency.content[0].text), {
    applied: true,
    topology: {
      nodes: ["build", "review"],
      edges: [{ from: "build", to: "review", feedback: false }],
    },
  });
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges[0].feedback, false);
  const before = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
  const rejected = await edge({ from: "review", to: "build", feedback: false });
  assert.deepEqual(Object.keys(rejected), ["content", "details"]);
  assert.deepEqual(rejected.details.diagnosticCodes, ["E101"]);
  assert.doesNotMatch(rejected.content[0].text, /E101/);
  const cycle = JSON.parse(rejected.content[0].text);
  assert.equal(cycle.applied, false);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), before);
  assert.match(cycle.diagnostics[0], /build → review/);
  assert.match(cycle.diagnostics[0], /review → build/);
  const toolResultHook = extension.handlers.get("tool_result")![0];
  assert.deepEqual(await toolResultHook({ toolName: "edge", details: rejected.details, isError: false }), { isError: true });
  const accepted = await node({ name: "review", task: "Review it" });
  assert.equal(await toolResultHook({ toolName: "node", details: accepted.details, isError: false }), undefined);
  assert.equal(JSON.parse(accepted.content[0].text).applied, true);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), before);
  const duplicateTask = await node({ name: "review", task: "Build it" });
  const duplicateTaskFeedback = JSON.parse(duplicateTask.content[0].text);
  assert.equal(duplicateTaskFeedback.applied, true);
  assert.deepEqual(duplicateTaskFeedback.warnings, ["W301: Nodes build, review have identical task text; they may duplicate work. Confirm that this is intentional."]);
  assert.equal(await toolResultHook({ toolName: "node", details: duplicateTask.details, isError: false }), undefined, "Duplicate tasks are advisory, not rejected edits");
  assert.equal(JSON.parse((await node({ name: "review", task: "Review it" })).content[0].text).warnings, undefined);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), before);
  const warning = await node({ name: "review", task: "Review it; return <FEEDBACK> when needed." });
  const warningFeedback = JSON.parse(warning.content[0].text);
  assert.equal(warningFeedback.applied, true);
  assert.deepEqual(warningFeedback.warnings, ["W302: review mentions <FEEDBACK> but has no outgoing feedback edge; the marker cannot send feedback."]);
  assert.equal(await toolResultHook({ toolName: "node", details: warning.details, isError: false }), undefined, "Warnings do not reject mutations");
  const repaired = await edge({ from: "review", to: "build", feedback: true });
  const repairedFeedback = JSON.parse(repaired.content[0].text);
  assert.equal(repairedFeedback.applied, true);
  assert.deepEqual(repairedFeedback.topology.edges, [
    { from: "build", to: "review", feedback: false },
    { from: "review", to: "build", feedback: true },
  ]);
  assert.deepEqual(repairedFeedback.warnings, [feedbackWarning("review", "build", ["build", "review"])], "Adding a feedback route replaces the missing-route warning with its conditional invalidation scope");
  assert.equal(await toolResultHook({ toolName: "edge", details: repaired.details, isError: false }), undefined, "Feedback scope warnings do not reject mutations");
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
  const deletedBuild = JSON.parse((await node({ name: "build", delete: true })).content[0].text);
  assert.deepEqual(deletedBuild.topology, { nodes: ["review"], edges: [] });
  assert.equal(deletedBuild.warnings.length, 1);
  assert.match(deletedBuild.warnings[0], /review mentions <FEEDBACK>/, "Deleting the feedback target removes the scope warning and exposes the missing-route warning again");
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges.length, 0);
  // Each tool compiles its own batch once.
  const compilerPath = process.env.GRAPHER_COMPILER_PATH!;
  const countedCompiler = join(root, process.platform === "win32" ? "counted-compiler.exe" : "counted-compiler.mjs");
  const compilerCalls = join(root, "compiler-calls.txt");
  if (process.platform === "win32") {
    // Windows CreateProcess cannot execute a shebang script. Keep the Planner
    // unchanged and use a test-owned native executable for compile counting.
    const wrapper = join(root, "counted_compiler.rs");
    writeFileSync(wrapper, `use std::io::Write;
fn main() {
  let mut count = std::fs::OpenOptions::new().create(true).append(true).open(${JSON.stringify(compilerCalls)}).unwrap();
  count.write_all(b"compile\\n").unwrap();
  let result = std::process::Command::new(${JSON.stringify(compilerPath)}).args(std::env::args().skip(1)).stdin(std::process::Stdio::inherit()).output().unwrap();
  std::io::stdout().write_all(&result.stdout).unwrap();
  std::io::stderr().write_all(&result.stderr).unwrap();
  std::process::exit(result.status.code().unwrap_or(1));
}
`);
    execFileSync("rustc", ["--crate-name", "counted_compiler", wrapper, "-o", countedCompiler], { stdio: "pipe" });
  } else {
    writeFileSync(countedCompiler, `#!${process.execPath}\nimport { appendFileSync, readFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nappendFileSync(${JSON.stringify(compilerCalls)}, 'compile\\n');\nconst result = spawnSync(${JSON.stringify(compilerPath)}, process.argv.slice(2), { input: readFileSync(0), encoding: 'utf8' });\nprocess.stdout.write(result.stdout || '');\nprocess.stderr.write(result.stderr || '');\nprocess.exit(result.status ?? 1);\n`);
    chmodSync(countedCompiler, 0o755);
  }
  process.env.GRAPHER_COMPILER_PATH = countedCompiler;
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({ originalGoal: "Batch fixture", nodes: [], edges: [] }));
  const batchNodes = ["contract", "parser", "search", "integration", "verification"].map(name => ({ name, task: `Complete ${name}` }));
  const batchEdges = [
    { from: "contract", to: "parser" }, { from: "contract", to: "search" },
    { from: "parser", to: "integration" }, { from: "search", to: "integration" },
    { from: "integration", to: "verification" },
  ];
  const nodeBatch = JSON.parse((await call("node", { nodes: batchNodes })).content[0].text);
  assert.equal(nodeBatch.applied, true);
  assert.deepEqual(nodeBatch.topology, { nodes: batchNodes.map(node => node.name), edges: [] });
  assert.equal(nodeBatch.warnings, undefined);
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges.length, 0);
  const batchResult = JSON.parse((await call("edge", { edges: batchEdges })).content[0].text);
  assert.equal(batchResult.applied, true);
  assert.deepEqual(batchResult.topology, {
    nodes: batchNodes.map(node => node.name),
    edges: batchEdges.map(edge => ({ ...edge, feedback: false })),
  });
  assert.equal(batchResult.warnings, undefined);
  assert.equal(readFileSync(compilerCalls, "utf8"), "compile\ncompile\n");
  const batchSaved = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  assert.equal(JSON.parse(batchSaved).originalGoal, "Batch fixture");
  assert.ok(JSON.parse(batchSaved).edges.every((edge: { feedback: boolean }) => edge.feedback === false));
  const redundant = await call("edge", { edges: [
    { from: "contract", to: "integration" },
    { from: "contract", to: "verification" },
  ] });
  const redundantResult = JSON.parse(redundant.content[0].text);
  assert.equal(redundantResult.applied, false);
  assert.equal(redundantResult.diagnostics.length, 2);
  assert.deepEqual(redundant.details.diagnosticCodes, ["E209", "E209"]);
  assert.match(redundantResult.diagnostics[0], /contract → parser → integration/);
  assert.equal(redundantResult.retryHint, undefined);
  assert.deepEqual(Object.keys(redundantResult), ["applied", "topology", "diagnostics"]);
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
    assert.equal(rejectedBatch.applied, false);
    assert.equal(typeof rejectedBatch.diagnostics[0], "string");
    assert.equal(response.details.diagnosticCodes[0], code);
    if (code === "E208") {
      assert.match(rejectedBatch.diagnostics[0], /Consider restructuring feedback ownership rather than merely dropping routes/);
      assert.match(rejectedBatch.diagnostics[0], /possible approaches include separate feedback sources/);
      assert.match(rejectedBatch.diagnostics[0], /a shared owner responsible for reworking the combined result/);
      assert.match(rejectedBatch.diagnostics[0], /node tasks remain consistent with the resulting feedback routes/);
    }
    assert.deepEqual(Object.keys(rejectedBatch), ["applied", "topology", "diagnostics"]);
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
    assert.equal(rejectedDuplicate.applied, false);
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
    ["edge", { from: "", to: "", feedback: false, delete: false, edges: batchEdges }],
    ["edge", { edges: [{ from: "contract", to: "parser", relation: "removed" }] }],
    ["edge", { edges: [{ from: "contract", to: "parser", relation: null }] }],
    ["edge", { edges: [] }],
    ["edge", { edges: batchEdges, nodes: batchNodes }],
  ] as const) {
    const tool = extension.tools.get(toolName)!.definition;
    assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "invalid", name: toolName, arguments: invalid }));
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), batchSaved);
  }
  // A single edit uses the same array interface.
  const single = JSON.parse((await node({ name: "single", task: "Single task" })).content[0].text);
  assert.equal(single.applied, true);
  await node({ name: "single", delete: true });
  // Reversing an edge creates a temporary cycle; only the final batch must compile.
  const rewired = JSON.parse((await call("edge", { edges: [
    { from: "parser", to: "contract" },
    { from: "contract", to: "parser", delete: true },
    { from: "parser", to: "integration", delete: true },
    { from: "verification", to: "parser", feedback: true },
  ] })).content[0].text);
  assert.equal(rewired.applied, true);
  assert.deepEqual(rewired.topology, {
    nodes: batchNodes.map(node => node.name),
    edges: [
      { from: "contract", to: "search", feedback: false },
      { from: "search", to: "integration", feedback: false },
      { from: "integration", to: "verification", feedback: false },
      { from: "parser", to: "contract", feedback: false },
      { from: "verification", to: "parser", feedback: true },
    ],
  });
  assert.deepEqual(rewired.warnings, [feedbackWarning("verification", "parser", ["contract", "integration", "parser", "search", "verification"])]);
  // Node deletion removes incident edges; other targets can be replaced atomically.
  assert.equal(JSON.parse((await call("node", { nodes: [
    { name: "contract", delete: true },
    { name: "search", task: "Final replacement" },
  ] })).content[0].text).applied, false);
  // The failed mutation leaves the saved graph untouched; add a direct path
  // around the deleted node in the same batch before removing it.
  assert.equal(JSON.parse((await call("edge", { edges: [
    { from: "parser", to: "integration" },
    { from: "parser", to: "contract", delete: true },
  ] })).content[0].text).applied, true);
  assert.equal(JSON.parse((await call("node", { nodes: [
    { name: "contract", delete: true },
    { name: "search", task: "Final replacement" },
  ] })).content[0].text).applied, true);
  const afterDeletion = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"));
  assert.equal(afterDeletion.nodes.find((n: { name: string }) => n.name === "search").task, "Final replacement");
  assert.ok(afterDeletion.edges.every((e: { from: string; to: string }) => e.from !== "contract" && e.to !== "contract"));
  // A dependency and its feedback route can be created in one edge batch.
  assert.equal(JSON.parse((await call("node", { nodes: [{ name: "fix", task: "Fix" }, { name: "check", task: "Check" }] })).content[0].text).applied, true);
  assert.equal(JSON.parse((await call("edge", { edges: [
    { from: "check", to: "fix", feedback: true }, { from: "fix", to: "check" },
  ] })).content[0].text).applied, true);
  const beforeUnavailable = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  process.env.GRAPHER_COMPILER_PATH = join(root, "missing-compiler");
  const unavailable = await call("node", { nodes: [{ name: "fix", task: "Changed" }] });
  assert.equal(JSON.parse(unavailable.content[0].text).applied, false);
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
  const plannerOptions = normalizeBuildSystemPromptOptions({ customPrompt: "base", cwd: repository });
  assert.equal(await extracted.extensions[1].handlers.get("before_agent_start")![0]({ systemPromptOptions: plannerOptions }), undefined);
  assert.equal(plannerOptions.forceSystemPrompt, undefined, "Path guidance must not bypass request-time prompt trimming");
  const plannerPrompt = buildSystemPrompt(plannerOptions);
  assert.match(plannerPrompt, /Use project-root-relative paths in Bash commands, project files, and node task handoffs/);
  assert.doesNotMatch(plannerPrompt, /generated configuration/);

  // Partitioner and Merger use the same namespace without the Planner extension.
  for (const mode of ["partition", "merger"]) {
    process.env.GRAPHER_MODE = mode;
    const roleExtension = await loadExtensions([adapterPath], repository);
    assert.deepEqual(roleExtension.errors, []);
    const hooks = roleExtension.extensions[0].handlers;
    assert.equal(hooks.has("before_agent_start"), mode !== "partition", "Working roles receive the relative-path convention");
    assert.equal(hooks.has("context"), false, "No content rewriting");
    if (mode === "partition") assert.equal(roleExtension.extensions[0].tools.size, 0);
    else {
      assert.ok(roleExtension.extensions[0].tools.has("bash"));
      const mergerOptions = normalizeBuildSystemPromptOptions({ customPrompt: "base", cwd: repository });
      assert.equal(await hooks.get("before_agent_start")![0]({ systemPromptOptions: mergerOptions }), undefined);
      assert.equal(mergerOptions.forceSystemPrompt, undefined);
      const mergerPrompt = buildSystemPrompt(mergerOptions);
      assert.match(mergerPrompt, /Use project-root-relative paths in Bash commands and project files/);
      assert.doesNotMatch(mergerPrompt, /handoffs|generated configuration/);
    }
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
  const nativePwdResult = await createBashToolDefinition(repository).execute("native-pwd", { command: "pwd" }, undefined, undefined, context);
  const nativePwd = nativePwdResult.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
  assert.ok(JSON.stringify(shellResult).includes(nativePwd), "Native output is not rewritten");
  assert.ok(updates.some(update => JSON.stringify(update).includes(nativePwd)));
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
    // Pi 1.0 returns nonzero exits as error results; only timeout/abort throws.
    for (const [command, exitCode] of [["exit 17", 17], ["set -e; false; printf unreachable", 1]] as const) {
      const result = await bash.execute(`${mode}-failure-${exitCode}`, { command }, undefined, undefined, context);
      assert.equal(result.isError, true);
      assert.equal(result.details?.exitCode, exitCode);
      assert.equal((result.structuredContent as { exit_code: number }).exit_code, exitCode);
      assert.match(JSON.stringify(result.content), new RegExp(`exited with code ${exitCode}`));
      assert.doesNotMatch(JSON.stringify(result.content), /unreachable/);
    }
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
