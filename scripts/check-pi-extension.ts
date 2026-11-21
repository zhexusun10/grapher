import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, symlinkSync, mkdirSync, realpathSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../pi/packages/coding-agent/src/core/tools/truncate.ts";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, join } from "node:path";
import { loadExtensions } from "../pi/packages/coding-agent/src/core/extensions/loader.ts";
import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from "../pi/packages/coding-agent/src/core/system-prompt.ts";
import { createBashToolDefinition } from "../pi/packages/coding-agent/src/core/tools/bash.ts";
import { convertResponsesTools } from "../pi/packages/ai/src/api/openai-responses-shared.ts";
import { validateToolArguments } from "../pi/packages/ai/src/utils/validation.ts";
import { runToolCall } from "../pi/packages/agent/src/agent-loop.ts";
import { plannerNodeEdits, plannerEdgeEdits } from "../src/lib/plannerGraphEdits.ts";
import { applyPlannerNodeEditsToState, applyPlannerEdgeEditsToState } from "../src/services/plannerStream.ts";
import type { ExtensionContext } from "../pi/packages/coding-agent/src/core/extensions/types.ts";

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
process.env.GRAPHER_PLANNER_WRITE_TOOLS = "true";
// Planner behavior must not depend on the host's feedback retry setting.
process.env.GRAPHER_MAX_FEEDBACK = "0";
writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({ originalGoal: "Test", nodes: [], edges: [] }));
process.chdir(repository);

function readGraph() {
  return JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"));
}

function graphReadView(graph: any, feedbackEnabled = process.env.GRAPHER_FEEDBACK_ENABLED === "true") {
  return {
    nodes: graph.nodes,
    edges: feedbackEnabled
      ? graph.edges
      : graph.edges.filter((edge: any) => !edge.feedback).map(({ from, to }: any) => ({ from, to })),
  };
}

// Item-level shorthands below exercise the real edit_graph declaration and
// executor; node/edge are not registered as production tools.
function graphInput(kind: string, raw: any): any {
  if (kind !== "node" && kind !== "edge") return raw;
  if (typeof raw === "string") raw = JSON.parse(raw);
  const key = kind === "node" ? "nodes" : "edges";
  if (raw && !Array.isArray(raw) && Object.hasOwn(raw, key)) return raw;
  return { [key]: Array.isArray(raw) ? raw : [raw] };
}
function itemTool(tools: Map<string, any>, kind: string): any {
  const registered = tools.get("edit_graph")!;
  const tool = registered.definition ?? registered;
  return {
    ...tool,
    prepareArguments: (raw: unknown) => tool.prepareArguments(graphInput(kind, raw)),
    execute: (id: string, raw: unknown, ...rest: any[]) => tool.execute(id, tool.prepareArguments(graphInput(kind, raw)), ...rest),
  };
}

function assertOutputFile(response: any, kind: "edit_graph-result" | "graph-snapshot") {
  const path = response.details.fullOutputPath;
  assert.equal(typeof path, "string");
  const extension = kind === "graph-snapshot" ? "json" : "txt";
  assert.match(basename(path), new RegExp(`^planner-${kind}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.${extension}$`));
  assert.equal(dirname(resolve(path)), dirname(resolve(process.env.GRAPHER_GRAPH_PATH!)), "Output stays in the bound Planner directory");
  const text = response.content.map((part: any) => part.text ?? "").join("\n");
  const truncation = response.details.truncation;
  const fullText = readFileSync(path, "utf8");
  let notice: string;
  if (truncation.firstLineExceedsLimit) {
    const lineSize = formatSize(Buffer.byteLength(fullText.split("\n", 1)[0], "utf8"));
    notice = `[Line 1 is ${lineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Full output: ${path}]`;
  } else {
    const limit = truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
    notice = `[Showing lines 1-${truncation.outputLines} of ${truncation.totalLines}${limit}. Full output: ${path}]`;
  }
  assert.ok(text.endsWith(notice), "Overflow notices identify the Pi-style head range or oversized line and the complete output file");
  assert.doesNotMatch(notice, /Showing lines 1-0|Use offset=/, "Do not invent a line range or a graph-tool paging parameter");
  assert.doesNotMatch(text, /Output truncated\. Full output:|Full report:|Full snapshot:/);
}

function graphResult(response: any) {
  const text = response.content.map((part: any) => part.text ?? "").join("\n");
  assert.ok(text.trim(), "Graph tools return an operation result, not an empty acknowledgement");
  assert.throws(() => JSON.parse(text), "Model-facing graph results are Pi-style text, not JSON snapshots");
  // Like Pi's bash tool, failure is the result's own isError flag; details
  // carry structured diagnostics but no duplicate success flag.
  assert.ok(response.isError === undefined || response.isError === true);
  const applied = response.isError !== true;
  assert.equal(Object.hasOwn(response.details ?? {}, "applied"), false, "isError replaces details.applied");
  assert.equal(Object.hasOwn(response.details ?? {}, "removedEdges"), false, "Edits never change more than they were asked to");
  if (!applied) assert.ok(response.details.diagnosticCodes?.length > 0
    && (response.details.diagnostics?.length > 0 || response.details.fullOutputPath));
  if (response.details.truncation?.truncated) {
    assert.ok(response.details.fullOutputPath);
    assert.ok(response.details.truncation.outputLines <= DEFAULT_MAX_LINES);
    assert.ok(response.details.truncation.outputBytes <= DEFAULT_MAX_BYTES);
    assert.ok(Buffer.byteLength(text) < DEFAULT_MAX_BYTES + 2048);
    assert.match(text, /Full output:/);
    for (const field of ["diagnostics", "warnings", "notes", "relatedFailures"]) {
      assert.equal(response.details[field], undefined, "Overflow reports must not be duplicated in details");
    }
  }
  for (const field of ["topology", "graph", "rootNodes", "plan", "nodes", "edges"]) {
    assert.equal(Object.hasOwn(response.details, field), false, `${field} must not be returned in tool details either`);
  }
  for (const field of ["diagnostics", "warnings", "notes"]) {
    if (response.details[field] !== undefined) {
      assert.ok(response.details[field].length > 0);
      for (const message of response.details[field]) assert.ok(text.includes(message), `${field} must remain visible to the model`);
    }
  }
  return { ...response.details, applied, text };
}

try {
  const adapterPath = join(source, "engine/prompt-extension.ts");
  // Opt-in is independent of the retry budget. Recreate the extension in both
  // directions, as cold and prepared Planner launches do for each turn.
  for (const enabled of [undefined, "true", "false", "true", undefined]) {
    if (enabled === undefined) delete process.env.GRAPHER_FEEDBACK_ENABLED;
    else process.env.GRAPHER_FEEDBACK_ENABLED = enabled;
    const probe = await loadExtensions([join(source, "backend/resources/planner.ts")], repository);
    assert.deepEqual(probe.errors, []);
    const tools = probe.extensions[0].tools;
    const edgeTool = itemTool(tools, "edge");
    assert.equal(edgeTool.parameters.additionalProperties, false,
      "Both capability states must reject unknown properties even without provider strict mode");
    assert.deepEqual(edgeTool.parameters.properties.edges.items.required, ["from", "to"]);
    const wire = convertResponsesTools([edgeTool])[0] as any;
    const fields = wire.parameters.properties.edges.anyOf.find((item: any) => item.type === "array").items.properties;
    assert.deepEqual(Object.keys(fields), enabled === "true" ? ["from", "to", "feedback", "delete"] : ["from", "to", "delete"]);
    if (enabled === "true") {
      assert.match(edgeTool.description, /feedback/);
      continue;
    }
    assert.doesNotMatch(JSON.stringify([...tools.values()].map(tool => tool.definition)), /feedback/i);
    // Pi's own schema validation rejects hidden fields inside the batch.
    for (const args of [{ from: "a", to: "b", feedback: true }, { edges: [{ from: "a", to: "b", feedback: false }] }]) {
      assert.throws(() => validateToolArguments(edgeTool, { type: "toolCall", id: "off-feedback", name: "edge", arguments: edgeTool.prepareArguments!(args) as any }), /feedback/);
    }
    writeFileSync(process.env.GRAPHER_GRAPH_PATH!, JSON.stringify({ originalGoal: "Test", nodes: [
      { id: "a", task: "Build" }, { id: "b", task: "Review" },
    ], edges: [] }));
    const args = edgeTool.prepareArguments!({ from: "a", to: "b" }) as any;
    const result = await edgeTool.execute("off", args, undefined, undefined, {} as ExtensionContext);
    assert.equal(graphResult(result).applied, true);
    assert.doesNotMatch(result.content[0].text, /feedback/i);
    assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8")).edges[0].feedback, false);
    const legacy = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"));
    legacy.nodes[1].task = "Review and use <FEEDBACK> if needed";
    const nodeTool = itemTool(tools, "node");
    const edit = nodeTool.prepareArguments!({ id: "a", task: "Build updated" }) as any;
    for (const withRoute of [false, true]) {
      legacy.edges = [{ from: "a", to: "b", feedback: false }, ...(withRoute ? [{ from: "b", to: "a", feedback: true }] : [])];
      writeFileSync(process.env.GRAPHER_GRAPH_PATH!, JSON.stringify(legacy));
      const edited = await nodeTool.execute("off-node", edit, undefined, undefined, {} as ExtensionContext);
      assert.equal(graphResult(edited).applied, true);
      assert.doesNotMatch(edited.content[0].text, /feedback/i, "Legacy routes and marker warnings stay out of disabled tool projections");
      assert.deepEqual(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8")).edges, legacy.edges, "Projection never rewrites committed legacy routes");
    }
    const beforeRejected = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
    const inspected = await tools.get("read_graph")!.definition.execute("off-read", {}, undefined, undefined, {} as ExtensionContext);
    assert.doesNotMatch(inspected.content[0].text, /"feedback"/,
      "Read must not expose the feedback field or retained feedback routes when Feedback is disabled");
    const inspectedGraph = JSON.parse(inspected.content[0].text);
    assert.deepEqual(inspectedGraph.edges, [{ from: "a", to: "b" }]);
    assert.deepEqual(inspectedGraph, graphReadView(JSON.parse(beforeRejected), false));
    assert.deepEqual(
      validateToolArguments(edgeTool, { type: "toolCall", id: "off-read-reuse", name: "edit_graph", arguments: { edges: inspectedGraph.edges } }),
      { edges: [{ from: "a", to: "b" }] },
      "Edges returned by read_graph when Feedback is disabled must conform to edit_graph's disabled edge schema",
    );
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), beforeRejected);
    const rejected = await edgeTool.execute("off-remove-path", edgeTool.prepareArguments!({ from: "a", to: "b", delete: true }) as any, undefined, undefined, {} as ExtensionContext);
    const rejectedBody = graphResult(rejected);
    assert.equal(rejectedBody.applied, false);
    assert.equal(rejected.isError, true);
    assert.deepEqual(rejected.details.diagnosticCodes, ["E207"]);
    assert.match(rejectedBody.diagnostics[0], /Preserve the required path.*Graph IR editor/);
    assert.doesNotMatch(rejected.content[0].text, /feedback|<ACCEPT>/i, "Rejected edits must not reintroduce the disabled protocol");
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), beforeRejected);
    // An ordinary replacement path is still actionable without editing a hidden route.
    await nodeTool.execute("off-add-node", nodeTool.prepareArguments!({ id: "middle", task: "Intermediate work" }) as any, undefined, undefined, {} as ExtensionContext);
    const addedPath = await edgeTool.execute("off-rewire", edgeTool.prepareArguments!({ from: "a", to: "middle" }) as any, undefined, undefined, {} as ExtensionContext);
    assert.equal(graphResult(addedPath).applied, true);
    // Completing the indirect path automatically removes the now-redundant
    // direct edge while preserving the retained hidden feedback route.
    const redundant = await edgeTool.execute("off-redundant", edgeTool.prepareArguments!({ from: "middle", to: "b" }) as any, undefined, undefined, {} as ExtensionContext);
    assert.equal(graphResult(redundant).applied, true);
    assert.equal(redundant.isError, undefined);
    assert.deepEqual(graphResult(redundant).notes, [
      "Auto-removed 1 redundant direct dependency (already provided by indirect path):",
      "a → b (via a → middle → b)",
    ]);
    assert.doesNotMatch(redundant.content[0].text, /feedback/i);
    assert.ok(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8")).edges.some((edge: any) => edge.feedback && edge.from === "b" && edge.to === "a"));
    assert.ok(!JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8")).edges.some((edge: any) => !edge.feedback && edge.from === "a" && edge.to === "b"));
    const valid = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
    const unnecessary = await edgeTool.execute("off-unnecessary", { from: "a", to: "b" }, undefined, undefined, {} as ExtensionContext);
    assert.equal(unnecessary.isError, undefined);
    assert.equal(graphResult(unnecessary).applied, true);
    assert.match(graphResult(unnecessary).text, /automatically removed/i);
    assert.deepEqual(graphResult(unnecessary).notes, [
      "Auto-removed 1 redundant direct dependency (already provided by indirect path):",
      "a → b (via a → middle → b)",
    ]);
    assert.doesNotMatch(unnecessary.content[0].text, /The graph is unchanged|feedback/i);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), valid);
    const invalid = JSON.parse(valid);
    invalid.edges.push({ from: "b", to: "middle", feedback: true });
    writeFileSync(process.env.GRAPHER_GRAPH_PATH!, JSON.stringify(invalid));
    const multiple = await nodeTool.execute("off-multiple", edit, undefined, undefined, {} as ExtensionContext);
    assert.equal(graphResult(multiple).applied, false);
    assert.ok(multiple.details.diagnosticCodes.includes("E208"));
    assert.doesNotMatch(multiple.content[0].text, /feedback/i);
    writeFileSync(process.env.GRAPHER_GRAPH_PATH!, valid);
    const deleted = await nodeTool.execute("off-delete", nodeTool.prepareArguments!({ id: "a", delete: true }) as any, undefined, undefined, {} as ExtensionContext);
    assert.doesNotMatch(deleted.content[0].text, /feedback/i);
  }
  process.env.GRAPHER_FEEDBACK_ENABLED = "true";
  writeFileSync(process.env.GRAPHER_GRAPH_PATH!, JSON.stringify({ originalGoal: "Test", nodes: [], edges: [] }));
  const loaded = await loadExtensions([join(source, "backend/resources/planner.ts"), adapterPath], repository);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual([...loaded.extensions[1].tools.keys()].sort(), ["bash", "edit", "read", "write"], "Planner adapter preserves its tool surface");
  assert.equal(loaded.extensions[1].handlers.has("tool_call"), false, "Planner graph tools must not get shell hooks");
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()].sort(), ["edit_graph", "read_graph"]);
  const bashDescription = loaded.extensions[1].tools.get("bash")!.definition.description;
  assert.match(bashDescription, /Execute a bash command/);
  assert.equal(extension.handlers.has("tool_call"), false, "Planner has no path or read guards");
  assert.equal(extension.handlers.has("context"), false, "No retired Planner history translation");
  // Pi-style tool mechanics supplement the domain contract, not replace it.
  // Keep edge direction and feedback continuation explicit; the bundled prompt
  // owns dependency-workspace merging, and diagnostics own repair recipes.
  const editTool = extension.tools.get("edit_graph")!.definition;
  const edgeDescription = editTool.description;
  assert.match(edgeDescription, /Only one edge per ordered pair/);
  assert.match(edgeDescription, /the `to` node depends on the `from` node and waits for it to complete/);
  assert.match(edgeDescription, /Create, replace, or delete one or more graph nodes, dependency edges, or both\./);
  assert.doesNotMatch(edgeDescription, /By default|Multiple dependencies'|directed edges|Output is truncated|Separate calls apply/i);
  assert.match(edgeDescription, /the `from` node can optionally send a feedback message to the `to` node, which must be an ancestor of the `from` node/);
  assert.match(edgeDescription, /Each feedback source has at most one target/);
  assert.match(edgeDescription, /the target receives the source's completed workspace and feedback, and continues from its own context to improve its previous work/);
  assert.match(edgeDescription, /source and other previously run descendants retain their own context and recheck their tasks using the updated workspace after their dependencies complete/);
  assert.doesNotMatch(edgeDescription, /workspace state/);
  assert.match(edgeDescription, /ordered edge pair.*replaced/);
  assert.match(edgeDescription, /cycles are rejected.*redundant direct dependencies.*automatically removed/);
  assert.match(edgeDescription, /missing node or edge.*error/);
  const nodeDescription = editTool.description;
  assert.match(nodeDescription, /overwrites.*entire task/);
  assert.match(nodeDescription, /Deleting.*removes.*incident edges/);
  assert.match(nodeDescription, /published node.*error/);
  assert.match(editTool.description, /Only the final graph is validated/);
  assert.match(editTool.description, /batch is committed together or leaves the graph unchanged/);
  assert.match(editTool.parameters.properties.nodes.items.properties.task.description, /Complete non-empty task.*required unless deleting/);
  assert.equal(editTool.executionMode, "sequential");
  assert.equal(extension.handlers.has("tool_result"), false, "Rejections use the result's own isError, not a result hook");
  // Mutation prompt contracts omit promptSnippet so Planner graph tools stay out
  // of Pi's generated <tools> list while keeping edit_graph guidelines.
  const readTool = extension.tools.get("read_graph")!.definition;
  const graphDefinitions = [editTool, readTool];
  const graphPromptOptions = {
    cwd: repository,
    selectedTools: graphDefinitions.map(tool => tool.name),
    toolSnippets: Object.fromEntries(graphDefinitions.flatMap(tool => tool.promptSnippet ? [[tool.name, tool.promptSnippet]] : [])),
    toolGuidelines: Object.fromEntries(graphDefinitions.flatMap(tool => tool.promptGuidelines?.length ? [[tool.name, tool.promptGuidelines]] : [])),
  };
  assert.equal(editTool.promptSnippet, undefined);
  assert.ok(editTool.promptGuidelines?.length);
  const generatedPrompt = buildSystemPrompt(graphPromptOptions);
  assert.doesNotMatch(generatedPrompt, /- (?:edit_graph|read_graph):/);
  assert.match(generatedPrompt, /Supply the complete task/);
  assert.match(generatedPrompt, /Batch related node and edge changes/);
  const bundledPrompt = readFileSync(join(source, "backend/resources/prompts/planner.md"), "utf8");
  const customPrompt = buildSystemPrompt({ ...graphPromptOptions, customPrompt: bundledPrompt });
  assert.equal(customPrompt, buildSystemPrompt({ cwd: repository, customPrompt: bundledPrompt }),
    "The bundled Planner prompt follows Pi's custom-prompt behavior without extra tool rules");
  assert.doesNotMatch(buildSystemPrompt({ ...graphPromptOptions, customPrompt: "User-owned Planner instructions" }), /Supply the complete task|Create nodes before/,
    "Pi does not inject tool guidelines into user-owned custom prompts");
  assert.doesNotMatch(edgeDescription, /->|maxFeedback|retry budget|reviewer|ignored|non-Git|drain|fork/i);
  const context = { cwd: repository, sessionManager: { getSessionId: () => "planner-test", getSessionFile: () => undefined } } as unknown as ExtensionContext;
  async function call(name: string, parameters: Record<string, unknown>) {
    if (name === "node" || name === "edge") {
      parameters = graphInput(name, parameters);
      name = "edit_graph";
    }
    const tool = (extension.tools.get(name) ?? loaded.extensions[1].tools.get(name))!.definition;
    const prepared = tool.prepareArguments ? tool.prepareArguments(parameters) as Record<string, unknown> : parameters;
    const args = validateToolArguments(tool, { type: "toolCall", id: "test", name, arguments: prepared });
    const before = name === "edit_graph"
      ? JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8")) : undefined;
    const response = await tool.execute("test", args, undefined, undefined, context);
    if (name === "edit_graph") {
      const feedback = graphResult(response);
      const saved = readGraph();
      for (const edge of saved.edges) assert.deepEqual(Object.keys(edge), ["from", "to", "feedback"]);
      if (!feedback.applied) assert.deepEqual(saved, before, "Rejected edits must leave the saved candidate unchanged");
    }
    return response;
  }
  const node = (edit: Record<string, unknown>) => call("node", edit);
  const edge = (edit: Record<string, unknown>) => call("edge", edit);
  const snapshot = async () => JSON.parse((await call("read_graph", {})).content[0].text);
  const readWire = convertResponsesTools([readTool])[0] as any;
  assert.equal(readWire.strict, true);
  assert.deepEqual(readWire.parameters.properties, {});
  assert.equal(readWire.parameters.additionalProperties, false);
  assert.throws(() => validateToolArguments(readTool, { type: "toolCall", id: "read-path", name: "read_graph", arguments: { path: "other.json" } }));
  assert.equal(readTool.promptGuidelines, undefined, "Discovery belongs to the tool description, not an extra reading workflow");
  assert.equal(readTool.promptSnippet, undefined, "read_graph must not inject a <tools> snippet into generated system prompts");
  assert.doesNotMatch(readWire.description, /truncat|full snapshot|full output/i,
    "Overflow guidance belongs to truncated results, not the standing tool description");
  assert.doesNotMatch(readFileSync(join(source, "backend/resources/prompts/planner.md"), "utf8"), /read_graph/);

  // Reads bind to this planning attempt, not cwd, a previous response, or the
  // current environment of some other loaded Planner. No compiler/runtime
  // impact snapshot is needed, including when inspecting an invalid topology.
  const emptyCandidate = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
  const readCompiler = process.env.GRAPHER_COMPILER_PATH;
  const readRun = process.env.GRAPHER_PLANNER_RUN_ID;
  process.env.GRAPHER_COMPILER_PATH = join(root, "no-compiler-for-reads");
  process.env.GRAPHER_PLANNER_RUN_ID = "read-without-impact-context";
  try {
    assert.deepEqual(await snapshot(), { nodes: [], edges: [] });
    const candidate = { originalGoal: "Private original goal: " + "g".repeat(DEFAULT_MAX_BYTES), nodes: [{ id: "new", task: 'Pending work; keep {"name":"literal"} unchanged.' }],
      edges: [{ from: "new", to: "absent", feedback: false }] };
    const candidateBytes = JSON.stringify(candidate);
    writeFileSync(process.env.GRAPHER_GRAPH_PATH!, candidateBytes);
    const inspectedResult = await call("read_graph", {});
    const inspected = JSON.parse(inspectedResult.content[0].text);
    assert.deepEqual(inspected, {
      nodes: [{ id: "new", task: candidate.nodes[0].task }], edges: candidate.edges },
      "Read returns only nodes and edges without rewriting tasks or validating topology");
    assert.deepEqual(inspectedResult.details, {}, "A long stored goal must not trigger output truncation or a snapshot file");
    const reusable = validateToolArguments(editTool, { type: "toolCall", id: "read-node-ids", name: "edit_graph",
      arguments: { nodes: inspected.nodes } });
    assert.deepEqual(reusable.nodes, inspected.nodes, "Read node entries fit edit_graph without renaming fields");
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), candidateBytes, "Read leaves the stored graph and original goal untouched");
    const savedPath = process.env.GRAPHER_GRAPH_PATH!;
    const nextPath = join(root, "next-planning-attempt.json");
    const nextCandidate = { originalGoal: "Next attempt", nodes: [], edges: [] };
    writeFileSync(nextPath, JSON.stringify(nextCandidate));
    process.env.GRAPHER_GRAPH_PATH = nextPath;
    process.chdir(root);
    try {
      const sameBinding = await readTool.execute("moved", {}, undefined, undefined, { ...context, cwd: root });
      assert.deepEqual(JSON.parse(sameBinding.content[0].text), graphReadView(candidate));
      const next = await loadExtensions([join(source, "backend/resources/planner.ts")], root);
      assert.deepEqual(next.errors, []);
      const rebound = await next.extensions[0].tools.get("read_graph")!.definition.execute("resumed", {}, undefined, undefined, context);
      assert.deepEqual(JSON.parse(rebound.content[0].text), graphReadView(nextCandidate));
    } finally {
      process.env.GRAPHER_GRAPH_PATH = savedPath;
      process.chdir(repository);
    }
    for (const invalid of ["{", "null", '{"originalGoal":"x","nodes":{},"edges":[]}',
      JSON.stringify({ originalGoal: "x", nodes: [{ name: "old", task: "Unsupported" }], edges: [] }),
      JSON.stringify({ originalGoal: "x", nodes: [{ id: "new", name: "old", task: "Unsupported" }], edges: [] }),
      JSON.stringify({ originalGoal: "x", nodes: [], edges: [{ from: "a", to: "b", feedback: false, relation: "Unsupported" }] }),
    ]) {
      writeFileSync(savedPath, invalid);
      await assert.rejects(call("read_graph", {}), /Cannot read the current planning candidate/);
      assert.equal(readFileSync(savedPath, "utf8"), invalid, "Read errors never repair or replace the file");
    }
    rmSync(savedPath);
    await assert.rejects(call("read_graph", {}), /ENOENT/);
    assert.equal(fs.existsSync(savedPath), false, "Missing candidates must not become empty graphs");
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(readTool.execute("aborted-read", {}, aborted.signal, undefined, context), /Operation aborted/);
  } finally {
    process.env.GRAPHER_COMPILER_PATH = readCompiler;
    if (readRun === undefined) delete process.env.GRAPHER_PLANNER_RUN_ID; else process.env.GRAPHER_PLANNER_RUN_ID = readRun;
    writeFileSync(process.env.GRAPHER_GRAPH_PATH!, emptyCandidate);
  }

  // Pi's bounded-output convention also handles an individually oversized
  // task string: the complete per-read snapshot is available to read/Bash,
  // without exposing the mutable candidate as a file editing entrypoint.
  for (const [nodes, truncatedBy] of [
    [Array.from({ length: 600 }, (_, i) => ({ id: `n${i}`, task: "work" })), "lines"],
    [[{ id: "long", task: "文".repeat(DEFAULT_MAX_BYTES) }], "bytes"],
  ] as const) {
    const candidate = { originalGoal: "Large graph", nodes, edges: [] };
    const bytes = JSON.stringify(candidate);
    writeFileSync(process.env.GRAPHER_GRAPH_PATH!, bytes);
    const response = await call("read_graph", {});
    assert.equal(response.details.truncation.truncatedBy, truncatedBy);
    assert.ok(response.details.truncation.outputLines <= DEFAULT_MAX_LINES);
    assert.ok(Buffer.byteLength(response.content[0].text) < DEFAULT_MAX_BYTES + 1024);
    const outputPath = response.details.fullOutputPath;
    assert.notEqual(outputPath, process.env.GRAPHER_GRAPH_PATH);
    const fullSnapshot = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.deepEqual(fullSnapshot, graphReadView(candidate));
    assert.deepEqual(Object.keys(fullSnapshot), ["nodes", "edges"], "Full snapshots must omit originalGoal too");
    assert.deepEqual(Object.keys(fullSnapshot.nodes[0]), ["id", "task"], "Overflow uses the same node fields as inline reads");
    assertOutputFile(response, "graph-snapshot");
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), bytes);
    const fileRead = await call("read", { path: outputPath, offset: 1, limit: 4 });
    assert.match(fileRead.content[0].text, /"id"/);
    assert.doesNotMatch(fileRead.content[0].text, /originalGoal|Large graph/);
    const quoted = `'${outputPath.replaceAll("'", "'\\''")}'`;
    const shellRead = await call("bash", { command: `wc -c < ${quoted}` });
    assert.equal(Number(shellRead.content[0].text.trim()), Buffer.byteLength(readFileSync(outputPath)));
    writeFileSync(process.env.GRAPHER_GRAPH_PATH!, emptyCandidate);
    assert.deepEqual(await snapshot(), { nodes: [], edges: [] });
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), graphReadView(candidate), "Later graph changes never rewrite a read's overflow snapshot");
    writeFileSync(outputPath, "{}");
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), emptyCandidate, "Overflow files are never imported as candidates");
  }

  // Mutation output follows the same bounded-content/file-report convention.
  // A high-degree deletion is one edit, not a reason to flood model context.
  const reportFileName = /^planner-edit_graph-result-.*\.txt$/;
  const reportFiles = () => readdirSync(root).filter(name => reportFileName.test(name)).sort();
  const leaves = Array.from({ length: DEFAULT_MAX_LINES + 20 }, (_, i) => ({ id: `n${i}`, task: `Work ${i}` }));
  const fanout = { originalGoal: "Large local effect", nodes: [{ id: "hub", task: "Hub" }, ...leaves],
    edges: leaves.map(node => ({ from: "hub", to: node.id, feedback: false })) };
  writeFileSync(process.env.GRAPHER_GRAPH_PATH!, JSON.stringify(fanout));
  const removedHub = await node({ id: "hub", delete: true });
  assert.equal(graphResult(removedHub).applied, true);
  assertOutputFile(removedHub, "edit_graph-result");
  assert.equal(removedHub.details.truncation.truncatedBy, "lines");
  assert.match(removedHub.content[0].text, /^The edit succeeded\./);
  assert.match(removedHub.content[0].text, new RegExp(`Removed ${leaves.length} incident edges`));
  const cascadeReport = readFileSync(removedHub.details.fullOutputPath, "utf8");
  assert.ok(cascadeReport.includes(`hub → n${leaves.length - 1}`));
  assert.equal(cascadeReport.split("\n").length, leaves.length + 2);
  assert.equal(readGraph().edges.length, 0);
  assert.equal(readGraph().nodes.length, leaves.length);
  const reportRead = await call("read", { path: removedHub.details.fullOutputPath, offset: 1, limit: 2 });
  assert.match(reportRead.content[0].text, /Successfully deleted node/);
  const reportQuote = `'${removedHub.details.fullOutputPath.replaceAll("'", "'\\''")}'`;
  assert.equal(Number((await call("bash", { command: `wc -c < ${reportQuote}` })).content[0].text.trim()), Buffer.byteLength(cascadeReport));
  const filesBeforeSmall = reportFiles();
  await node({ id: "small", task: "A small unrelated change" });
  assert.deepEqual(reportFiles(), filesBeforeSmall, "Small results create no report files");
  assert.equal(readFileSync(removedHub.details.fullOutputPath, "utf8"), cascadeReport, "Reports are immutable per-call evidence, not live graph mirrors");
  writeFileSync(removedHub.details.fullOutputPath, "Not a candidate");
  assert.ok(readGraph().nodes.some((node: any) => node.id === "small"));

  // A changed large advisory group spills too, but cumulative execution risk
  // precedes it. The next independent edit retains W304 without repeating W301.
  const warningGraph = { originalGoal: "Large advisory", nodes: [
    ...leaves.map(node => ({ ...node, task: "PRIVATE_SHARED_TASK" })),
    { id: "focus", task: "Independent task" },
  ], edges: [] };
  writeFileSync(process.env.GRAPHER_GRAPH_PATH!, JSON.stringify(warningGraph));
  const warningRun = process.env.GRAPHER_PLANNER_RUN_ID;
  const warningContext = `${process.env.GRAPHER_GRAPH_PATH}.impact-f9e6e6ef197c2b25.json`; // tool id "test"
  const warningRevision = () => writeFileSync(warningContext, JSON.stringify({ toolCallId: "test",
    revisionContext: { graph: warningGraph, completedNodes: ["focus"], approved: true } }));
  process.env.GRAPHER_PLANNER_RUN_ID = "large-warning-test";
  try {
    warningRevision();
    const longWarning = await node({ id: "focus", task: "PRIVATE_SHARED_TASK" });
    assert.equal(graphResult(longWarning).applied, true);
    assert.equal(longWarning.details.truncation.truncatedBy, "lines");
    assert.match(longWarning.content[0].text, /Current draft will invalidate and rerun 1 completed node/);
    assert.ok(longWarning.content[0].text.indexOf("Current draft") < longWarning.content[0].text.indexOf("identical task text"));
    const warningReport = readFileSync(longWarning.details.fullOutputPath, "utf8");
    assert.ok(warningReport.includes(`- n${leaves.length - 1}`));
    assert.doesNotMatch(warningReport, /PRIVATE_SHARED_TASK/, "Warning evidence never echoes task bodies");
    const reportsBeforeIndependent = reportFiles();
    warningRevision();
    const independentEdit = graphResult(await edge({ from: "n0", to: "n1" }));
    assert.equal(independentEdit.warnings.length, 1);
    assert.match(independentEdit.warnings[0], /Current draft will invalidate and rerun 1 completed node/);
    assert.doesNotMatch(independentEdit.text, /identical task text/);
    assert.deepEqual(reportFiles(), reportsBeforeIndependent);
  } finally {
    if (warningRun === undefined) delete process.env.GRAPHER_PLANNER_RUN_ID;
    else process.env.GRAPHER_PLANNER_RUN_ID = warningRun;
    rmSync(warningContext, { force: true });
  }

  // Byte overflow and an individually oversized first line both retain status.
  const longId = "文".repeat(Math.ceil(DEFAULT_MAX_BYTES / 3) + 100);
  writeFileSync(process.env.GRAPHER_GRAPH_PATH!, emptyCandidate);
  const oversizedNode = await node({ id: longId, task: "Long identity" });
  assert.equal(graphResult(oversizedNode).applied, true);
  assertOutputFile(oversizedNode, "edit_graph-result");
  assert.equal(oversizedNode.details.truncation.truncatedBy, "bytes");
  assert.equal(oversizedNode.details.truncation.firstLineExceedsLimit, true);
  assert.match(oversizedNode.content[0].text, /^The edit succeeded\./);
  assert.doesNotMatch(oversizedNode.content[0].text, /\uFFFD/);
  assert.ok(readFileSync(oversizedNode.details.fullOutputPath, "utf8").includes(longId));
  await node({ id: "sink", task: "Consume the result" });
  const oversizedEdge = await edge({ from: longId, to: "sink" });
  assert.equal(graphResult(oversizedEdge).applied, true);
  assertOutputFile(oversizedEdge, "edit_graph-result");
  assert.notEqual(oversizedEdge.details.fullOutputPath, oversizedNode.details.fullOutputPath);
  const beforeOversizedError = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
  const oversizedError = await edge({ from: "absent", to: longId });
  assert.equal(graphResult(oversizedError).applied, false);
  assertOutputFile(oversizedError, "edit_graph-result");
  assert.notEqual(oversizedError.details.fullOutputPath, oversizedEdge.details.fullOutputPath, "Each call keeps its own output, including failures");
  assert.deepEqual(oversizedError.details.diagnosticCodes, ["E204"]);
  assert.match(oversizedError.content[0].text, /^Edit rejected\. The graph is unchanged\. Earlier successful edits remain\./);
  assert.match(oversizedError.content[0].text, /Unknown endpoint/);
  assert.ok(readFileSync(oversizedError.details.fullOutputPath, "utf8").includes(longId));
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), beforeOversizedError);

  // Combine an oversized operation summary with cumulative revision risk.
  // Neither moving W304 ahead of lists nor retaining it only on disk is enough.
  const oversizedRiskGraph = JSON.parse(beforeOversizedError);
  const oversizedRiskRun = process.env.GRAPHER_PLANNER_RUN_ID;
  process.env.GRAPHER_PLANNER_RUN_ID = "oversized-risk-test";
  const oversizedRevision = { graph: oversizedRiskGraph, completedNodes: [longId, "sink"], approved: true };
  const oversizedContext = () => writeFileSync(warningContext, JSON.stringify({ toolCallId: "test", revisionContext: oversizedRevision }));
  try {
    oversizedContext();
    const risky = await node({ id: longId, task: "Changed completed work" });
    assert.equal(graphResult(risky).applied, true);
    assert.equal(risky.details.truncation.firstLineExceedsLimit, true);
    assert.match(risky.content[0].text, /^The edit succeeded\.\nWarning: Current draft will invalidate and rerun 2 completed nodes since /);
    assert.ok(risky.content[0].text.includes("Nodes with changed tasks use the new tasks; other affected nodes use their original tasks and the latest workspace after dependencies complete."), "Overflow retains the new-task versus original-task distinction");
    assertOutputFile(risky, "edit_graph-result");
    const riskReport = readFileSync(risky.details.fullOutputPath, "utf8");
    assert.ok(riskReport.includes(longId));
    assert.match(riskReport, /Current draft will invalidate and rerun 2 completed nodes since:/);
    assert.ok(riskReport.includes('Tasks changed; rerun these nodes with their updated tasks:\n- ' + JSON.stringify(longId)));
    assert.ok(riskReport.includes('Graph changes affect these nodes; after their dependencies complete, they will rerun their original tasks using the latest workspace, incorporating workspaces passed down by their dependencies:\n- "sink"'));
    assert.doesNotMatch(riskReport, /workspace state/);
    const compilerReply = JSON.parse(execFileSync(process.env.GRAPHER_COMPILER_PATH!, ["--compile"], {
      input: JSON.stringify({ graph: readGraph(), previousGraph: oversizedRiskGraph, revisionContext: oversizedRevision, finalCheck: false }), encoding: "utf8",
    }));
    assert.deepEqual(compilerReply.revisionImpact, { rerunCount: 2 }, "Risk counts come from structured Runtime evidence, not warning prose");
    oversizedContext();
    const restored = await node({ id: longId, task: "Long identity" });
    assert.equal(graphResult(restored).applied, true);
    assert.equal(restored.details.truncation.firstLineExceedsLimit, true);
    assert.doesNotMatch(restored.content[0].text, /invalidate and rerun/, "Restoring the draft must not retain a stale risk header");
  } finally {
    if (oversizedRiskRun === undefined) delete process.env.GRAPHER_PLANNER_RUN_ID;
    else process.env.GRAPHER_PLANNER_RUN_ID = oversizedRiskRun;
    rmSync(warningContext, { force: true });
  }
  writeFileSync(process.env.GRAPHER_GRAPH_PATH!, emptyCandidate);

  // Observe complete candidate publication and inject filesystem failures at
  // the actual fs boundary. A failed stage/rename must never truncate the old
  // candidate, leave a temporary file, or poison subsequent queued edits.
  // Use native ESM bindings for deterministic fs fault injection; the normal
  // extension loader may retain copies of builtin exports across reloads.
  const { default: atomicPlanner } = await import("../backend/resources/planner.ts");
  const atomicTools = new Map<string, any>();
  atomicPlanner({ registerTool(tool: any) { atomicTools.set(tool.name, tool); }, on() {} } as any);
  const atomicNode = (args: Record<string, unknown>) => itemTool(atomicTools, "node").execute("atomic-write", args, undefined, undefined, context);
  const nativeRename = fs.renameSync;
  const nativeWrite = fs.writeFileSync;
  let expectedBefore = emptyCandidate;
  let failRename = false;
  let observeRename = true;
  let replacements = 0;
  fs.renameSync = (from, to) => {
    if (observeRename && String(to) === process.env.GRAPHER_GRAPH_PATH) {
      replacements++;
      assert.equal(readFileSync(to, "utf8"), expectedBefore);
      assert.ok(JSON.parse(readFileSync(from, "utf8")).nodes.some((node: any) => node.id === "atomic"));
      if (failRename) throw Object.assign(new Error("Injected replacement failure"), { code: "EACCES" });
    }
    nativeRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(graphResult(await atomicNode({ id: "atomic", task: "Published completely" })).applied, true);
    expectedBefore = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
    failRename = true;
    const denied = await atomicNode({ id: "atomic", task: "Not published" });
    assert.equal(denied.isError, true);
    assert.deepEqual(denied.details.diagnosticCodes, ["graph-write"]);
    assert.deepEqual(await snapshot(), graphReadView(JSON.parse(expectedBefore)));
    assert.equal(replacements, 2, "Both successful and refused writes use same-directory replacement");
  } finally {
    // Loaded extensions may retain a reference to an instrumented export.
    observeRename = false;
    failRename = false;
    fs.renameSync = nativeRename;
    syncBuiltinESMExports();
  }
  let failWrite = true;
  fs.writeFileSync = ((path: any, data: any, options: any) => {
    if (failWrite && String(path).startsWith(`${process.env.GRAPHER_GRAPH_PATH}.`) && String(path).endsWith(".tmp")) {
      nativeWrite(path, "{partial", options);
      throw Object.assign(new Error("Injected short write"), { code: "EIO" });
    }
    return nativeWrite(path, data, options);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try {
    const shortWrite = await atomicNode({ id: "atomic", task: "Also not published" });
    assert.equal(shortWrite.isError, true);
    assert.deepEqual(shortWrite.details.diagnosticCodes, ["graph-write"]);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), expectedBefore);
    assert.equal(readdirSync(root).some(path => path.endsWith(".tmp")), false);
  } finally {
    failWrite = false;
    fs.writeFileSync = nativeWrite;
    syncBuiltinESMExports();
  }
  const recoveredWrite = await atomicNode({ id: "atomic", task: "Recovered" });
  assert.equal(graphResult(recoveredWrite).applied, true, JSON.stringify(recoveredWrite));
  assert.equal((await snapshot()).nodes[0].task, "Recovered");
  writeFileSync(process.env.GRAPHER_GRAPH_PATH!, emptyCandidate);

  // Output preparation is inside the mutation transaction, before publication.
  // Report failures, cancellation and graph replacement failures leave no report
  // claiming that an unpublished edit succeeded, and never poison the queue.
  const beforeReportFailures = reportFiles();
  const reportAbort = new AbortController();
  let reportFault: "write" | "abort" | undefined = "write";
  fs.writeFileSync = ((path: any, data: any, options: any) => {
    if (reportFault && reportFileName.test(basename(String(path)))) {
      nativeWrite(path, reportFault === "write" ? "partial report" : data, options);
      if (reportFault === "write") throw Object.assign(new Error("Injected report failure"), { code: "ENOSPC" });
      reportAbort.abort();
      return;
    }
    return nativeWrite(path, data, options);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try {
    const deniedReport = await atomicNode({ id: longId, task: "Must not be saved" });
    assert.equal(graphResult(deniedReport).applied, false);
    assert.deepEqual(deniedReport.details.diagnosticCodes, ["graph-report"]);
    assert.match(deniedReport.content[0].text, /ENOSPC/);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), emptyCandidate);
    const deniedErrorReport = await itemTool(atomicTools, "edge").execute("error-report", { from: "absent", to: longId }, undefined, undefined, context);
    assert.equal(graphResult(deniedErrorReport).applied, false);
    assert.deepEqual(deniedErrorReport.details.diagnosticCodes, ["E204", "graph-report"]);
    assert.match(deniedErrorReport.content[0].text, /Unknown endpoint/);
    assert.equal(deniedErrorReport.details.fullOutputPath, undefined);
    assert.deepEqual(reportFiles(), beforeReportFailures, "Failed partial report files are removed");
    reportFault = "abort";
    await assert.rejects(itemTool(atomicTools, "node").execute("report-abort", { id: longId, task: "Cancelled" }, reportAbort.signal, undefined, context), /Operation aborted/);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), emptyCandidate);
    assert.deepEqual(reportFiles(), beforeReportFailures, "Cancellation discards the prepared success report");
  } finally {
    reportFault = undefined;
    fs.writeFileSync = nativeWrite;
    syncBuiltinESMExports();
  }
  let denyReportedReplacement = true;
  let observedPreparedReport = false;
  fs.renameSync = (from, to) => {
    if (String(to) === process.env.GRAPHER_GRAPH_PATH) {
      const fresh = reportFiles().filter(name => !beforeReportFailures.includes(name));
      assert.equal(fresh.length, 1, "Full output exists before the candidate is published");
      assert.ok(readFileSync(join(root, fresh[0]), "utf8").includes(longId));
      observedPreparedReport = true;
      if (denyReportedReplacement) throw Object.assign(new Error("Injected replacement failure"), { code: "EACCES" });
    }
    nativeRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const deniedCommit = await atomicNode({ id: longId, task: "Not committed" });
    assert.deepEqual(deniedCommit.details.diagnosticCodes, ["graph-write"]);
    assert.equal(deniedCommit.isError, true);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), emptyCandidate);
    assert.deepEqual(reportFiles(), beforeReportFailures, "Failed publication discards its prepared success report");
    denyReportedReplacement = false;
    const recoveredReport = await atomicNode({ id: longId, task: "Committed" });
    assert.equal(graphResult(recoveredReport).applied, true);
    assert.equal(readGraph().nodes[0].id, longId);
    assert.ok(fs.existsSync(recoveredReport.details.fullOutputPath));
    assert.equal(observedPreparedReport, true);
  } finally {
    fs.renameSync = nativeRename;
    syncBuiltinESMExports();
  }
  writeFileSync(process.env.GRAPHER_GRAPH_PATH!, emptyCandidate);

  // Pi lifecycle events include calls rejected by its argument validator.
  // Attribution uses the target and call id, not whichever error happened last.
  async function turnStart() {
    for (const hook of extension.handlers.get("turn_start") ?? []) await hook({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  }
  async function lifecycleCall(kind: "node" | "edge", id: string, raw: Record<string, unknown>) {
    const name = "edit_graph";
    raw = graphInput(kind, raw);
    for (const hook of extension.handlers.get("tool_execution_start") ?? []) await hook({ type: "tool_execution_start", toolName: name, toolCallId: id, args: raw });
    const tool = extension.tools.get(name)!.definition;
    let response: any;
    try {
      const args = validateToolArguments(tool, { type: "toolCall", id, name, arguments: tool.prepareArguments!(raw) });
      response = await tool.execute(id, args, undefined, undefined, context);
    } catch (error) {
      response = { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
    }
    for (const hook of extension.handlers.get("tool_execution_end") ?? []) await hook({ type: "tool_execution_end", toolName: name, toolCallId: id, result: response, isError: response.isError === true });
    return response;
  }
  await turnStart();
  assert.equal((await lifecycleCall("node", "bad-create", { nodes: [{ id: "missing", task: "" }] })).isError, true);
  assert.equal((await lifecycleCall("node", "independent", { id: "survivor", task: "Keep successful work" })).isError, undefined);
  assert.equal((await lifecycleCall("node", "unrelated-error", { id: "elsewhere", task: "" })).isError, true);
  const dependent = await lifecycleCall("edge", "dependent-edge", { from: "survivor", to: "missing" });
  assert.deepEqual(dependent.details.relatedFailures, [{ nodeId: "missing", toolCallId: "bad-create" }]);
  assert.match(dependent.content[0].text, /bad-create/);
  assert.doesNotMatch(dependent.content[0].text, /unrelated-error|elsewhere/);
  assert.match(dependent.content[0].text, /Earlier successful edits remain/);
  assert.deepEqual((await snapshot()).nodes, [{ id: "survivor", task: "Keep successful work" }]);
  const unrelatedMissing = await lifecycleCall("edge", "unrelated-missing", { from: "survivor", to: "never-created" });
  assert.equal(unrelatedMissing.details.relatedFailures, undefined);
  const invalidArgs = await lifecycleCall("node", "schema-error", { id: "bad-schema", task: {} });
  assert.equal(invalidArgs.isError, true);
  assert.equal(invalidArgs.details.diagnosticCodes, undefined, "Pi rejected this before the compiler");
  const afterSchema = await lifecycleCall("edge", "after-schema", { from: "survivor", to: "bad-schema" });
  assert.deepEqual(afterSchema.details.relatedFailures, [{ nodeId: "bad-schema", toolCallId: "schema-error" }]);
  // Start events carry raw arguments, before Pi's boolean/string coercion.
  for (const [id, target] of [["false-intent", "boolean-target"], ["numeric-id", 123], ["null-id", null]] as const) {
    const failed = await lifecycleCall("node", id, { nodes: [{ id: target, task: {}, delete: "FALSE" }] });
    assert.equal(failed.isError, true);
    const cause = await lifecycleCall("edge", `after-${id}`, { from: "survivor", to: String(target) });
    assert.deepEqual(cause.details.relatedFailures, [{ nodeId: String(target), toolCallId: id }]);
  }
  const beforeFailedBatch = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
  const rejectedSiblings = await lifecycleCall("node", "failed-batch", {
    nodes: [{ id: "batch-first", task: "First" }, { id: "batch-second", task: "Second" }],
    edges: [{ from: "batch-first", to: "never-created" }],
  });
  assert.equal(rejectedSiblings.isError, true);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), beforeFailedBatch);
  const afterBatch = await lifecycleCall("edge", "after-batch", { from: "batch-first", to: "batch-second" });
  assert.deepEqual(afterBatch.details.relatedFailures, [
    { nodeId: "batch-first", toolCallId: "failed-batch" }, { nodeId: "batch-second", toolCallId: "failed-batch" },
  ]);
  await lifecycleCall("node", "repair", { id: "missing", task: "Now present" });
  assert.equal((await lifecycleCall("edge", "after-repair", { from: "survivor", to: "missing" })).isError, undefined);
  await lifecycleCall("node", "remove", { id: "missing", delete: true });
  assert.equal((await lifecycleCall("edge", "after-delete", { from: "survivor", to: "missing" })).details.relatedFailures, undefined);
  await lifecycleCall("node", "failed-delete", { id: "never-created", delete: true });
  assert.equal((await lifecycleCall("edge", "after-failed-delete", { from: "survivor", to: "never-created" })).details.relatedFailures, undefined);
  await turnStart();
  assert.equal((await lifecycleCall("edge", "next-turn", { from: "survivor", to: "bad-schema" })).details.relatedFailures, undefined,
    "Attribution must not carry stale failures into another assistant turn");
  writeFileSync(process.env.GRAPHER_GRAPH_PATH!, emptyCandidate);
  // Fixture setup exercises real edit_graph batches.
  async function applyEdits(name: "node" | "edge", edits: Record<string, unknown>[]) {
    const response = await call("edit_graph", graphInput(name, edits));
    assert.equal(graphResult(response).applied, true, JSON.stringify(response));
    return response;
  }
  // Verify the actual provider schema, then exercise nullable wire arguments
  // through Pi's validator and the real compiler (not direct execute alone).
  const editWire = convertResponsesTools([editTool])[0] as any;
  assert.equal(editWire.strict, true);
  assert.equal(editWire.description, editTool.description);
  assert.doesNotMatch(editTool.description, /Returns applied|topology|warnings|\bplan\b|executionBatches|dependencyLayers/);
  assert.deepEqual(Object.keys(editTool.parameters.properties), ["nodes", "edges"]);
  assert.deepEqual(editTool.parameters.required ?? [], []);
  assert.equal(editTool.parameters.additionalProperties, false);
  assert.deepEqual(editWire.parameters.required, ["nodes", "edges"]);
  assert.equal(editWire.parameters.additionalProperties, false);
  for (const key of ["nodes", "edges"]) {
    const item = editTool.parameters.properties[key].items;
    const wireArray = editWire.parameters.properties[key].anyOf.find((variant: any) => variant.type === "array");
    assert.ok(editWire.parameters.properties[key].anyOf.some((variant: any) => variant.type === "null"));
    const fields = key === "nodes" ? ["id", "task", "delete"] : ["from", "to", "feedback", "delete"];
    assert.deepEqual(Object.keys(item.properties), fields);
    assert.deepEqual(item.required, key === "nodes" ? ["id"] : ["from", "to"]);
    assert.equal(item.additionalProperties, false);
    assert.deepEqual(wireArray.items.required, fields);
    assert.equal(wireArray.items.additionalProperties, false);
    for (const field of key === "nodes" ? ["task", "delete"] : ["feedback", "delete"]) {
      assert.ok(wireArray.items.properties[field].anyOf.some((variant: any) => variant.type === "null"));
    }
  }
  // Pi-style argument preparation tolerates stringified collections and
  // singleton collection items without exposing another provider schema.
  async function preparedCall(name: string, raw: unknown) {
    const tool = name === "node" || name === "edge" ? itemTool(extension.tools, name) : editTool;
    assert.equal(typeof tool.prepareArguments, "function", "edit_graph must normalize arguments");
    const prepared = tool.prepareArguments!(raw);
    const args = validateToolArguments(tool, { type: "toolCall", id: "test-prepared", name, arguments: prepared as Record<string, unknown> });
    return await tool.execute("test-prepared", args, undefined, undefined, context);
  }
  function captureError(fn: () => unknown): string {
    try {
      fn();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    assert.fail("Expected the call to be rejected");
  }
  for (const raw of [
    { nodes: [{ id: "tolerant-array", task: "Array node" }] },
    { nodes: { id: "tolerant-object", task: "Object node" } },
    { nodes: '[{"id":"tolerant-string","task":"String node"}]' },
    JSON.stringify({ nodes: [{ id: "tolerant-json", task: "JSON arguments" }] }),
  ]) assert.equal(graphResult(await preparedCall("edit_graph", raw)).applied, true);
  assert.equal(graphResult(await preparedCall("edit_graph", {
    edges: [{ from: "tolerant-array", to: "tolerant-object" }, { from: "tolerant-object", to: "tolerant-string" }],
  })).applied, true);
  function validated(raw: unknown) {
    return validateToolArguments(editTool, { type: "toolCall", id: "test-validate", name: "edit_graph", arguments: editTool.prepareArguments!(raw) as any });
  }
  assert.match(captureError(() => validated({ nodes: [{ id: "a", name: "b", task: "x" }] })), /name/);
  assert.match(captureError(() => validated({ nodes: [{ name: "a", task: "x" }] })), /id|name/);
  for (const [raw, field] of [
    [{ nodes: [5] }, "nodes"], [{ nodes: [{}] }, "id"],
    [{ nodes: [{ id: "x", extra: true }] }, "extra"],
    [{ edges: [{ from: "x" }] }, "to"],
    [{ edges: [{ from: "x", to: "y", relation: "removed" }] }, "relation"],
    [{ nodes: [{ id: "x", task: "X" }], id: "ambiguous" }, "id"],
  ] as const) assert.ok(captureError(() => validated(raw)).includes(field));
  // Pi's validator, not this extension, coerces primitives and drops nested nulls.
  assert.deepEqual(validated({ nodes: [{ id: 123, task: 456, delete: 0 }], edges: null }), { nodes: [{ id: "123", task: "456", delete: false }] });
  assert.deepEqual(validated({ nodes: [{ id: "nullable-args", task: null, delete: null }] }), { nodes: [{ id: "nullable-args" }] });
  for (const empty of [{}, { nodes: [] }, { nodes: null, edges: null }, { nodes: [], edges: [] }]) {
    await assert.rejects(call("edit_graph", empty), /requires at least one node or edge edit/);
  }
  assert.equal(graphResult(await applyEdits("node", ["tolerant-array", "tolerant-object", "tolerant-string", "tolerant-json"].map(id => ({ id, delete: true })))).applied, true);
  assert.deepEqual(readGraph().nodes, []);
  assert.deepEqual(readGraph().edges, []);

  // Compare raw-event previews with the actual Pi validator and compiler, not
  // with a hand-maintained copy of the provider schema.
  const coercionBase = { originalGoal: "Pi coercion", nodes: [
    { id: "build", task: "Build" }, { id: "check", task: "Check" }, { id: "remove", task: "Remove" },
  ], edges: [{ from: "build", to: "check", feedback: false }] };
  for (const raw of [
    { nodes: [{ id: "remove", delete: "TRUE" }] },
    { nodes: [{ id: "remove", delete: "1" }] },
    { edges: [{ from: "check", to: "build", feedback: "True" }] },
    { edges: [{ from: "check", to: "build", feedback: "1" }] },
    { nodes: [{ id: null, task: "Literal null identity" }], edges: [{ from: null, to: "check" }] },
    // A batch may delete nodes, explicitly delete cascade edges, and rewire
    // other endpoints. The preview must match the final committed arrays too.
    { nodes: [{ id: "remove", delete: true }, { id: "阶段", task: "Intermediate stage" }], edges: [
      { from: "build", to: "check", delete: true }, { from: "build", to: "阶段" }, { from: "阶段", to: "check" },
    ] },
    { nodes: [{ id: "build", task: "Updated build" }, { id: "check", delete: true }, { id: "review", task: "Review" }], edges: [
      { from: "build", to: "check", delete: true }, { from: "build", to: "review" }, { from: "review", to: "build", feedback: true },
    ] },
    { nodes: [{ id: "__proto__", task: "Literal prototype-like id" }], edges: [
      { from: "build", to: "__proto__" }, { from: "build", to: "check", delete: true }, { from: "__proto__", to: "check" },
    ] },
    // Redundant direct edges are auto-removed in both the saved graph and the live preview.
    { nodes: [{ id: "mid", task: "Intermediate stage" }], edges: [
      { from: "build", to: "mid" }, { from: "mid", to: "check" },
    ] },
  ]) {
    writeFileSync(process.env.GRAPHER_GRAPH_PATH!, JSON.stringify(coercionBase));
    assert.equal(graphResult(await preparedCall("edit_graph", raw)).applied, true);
    const preview = applyPlannerEdgeEditsToState(applyPlannerNodeEditsToState(
      { graph: coercionBase, plan: null } as any, plannerNodeEdits(raw)), plannerEdgeEdits(raw));
    assert.deepEqual(preview.graph, readGraph(), `Raw preview diverged from Pi's accepted edit: ${JSON.stringify(raw)}`);
  }
  writeFileSync(process.env.GRAPHER_GRAPH_PATH!, emptyCandidate);

  // Arbitrary node ids remain safe, without echoing unrelated tasks or graph
  // state. Check the saved IR rather than making it part of every tool result.
  const unusualNames = ["__proto__", "constructor", "toString", "任务•完成"];
  await applyEdits("node", unusualNames.map(id => ({ id, task: `Work on ${id}` })));
  const unusual = graphResult(await applyEdits("edge", [
    { from: "__proto__", to: "constructor" },
    { from: "constructor", to: "任务•完成" },
    { from: "__proto__", to: "toString" },
    { from: "任务•完成", to: "__proto__", feedback: true },
  ]));
  assert.doesNotMatch(unusual.text, /Work on/);
  assert.equal(readGraph().edges.length, 4);
  await edge({ from: "__proto__", to: "toString", delete: true });
  assert.deepEqual(readGraph().edges.filter((edge: any) => edge.from === "__proto__").map((edge: any) => edge.to), ["constructor"],
    "Deleting one outgoing edge preserves other targets");
  await applyEdits("node", unusualNames.map(id => ({ id, delete: true })));

  // Reject an invalid pre-existing candidate without altering its graph or
  // exposing a full snapshot in the error result.
  const emptyBeforeLegacy = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  const invalidLegacy = {
    originalGoal: "Legacy", nodes: ["a", "b", "c"].map(name => ({ id: name, task: name })),
    edges: [
      { from: "a", to: "b", feedback: false }, { from: "b", to: "c", feedback: false },
      { from: "c", to: "a", feedback: true }, { from: "c", to: "b", feedback: true },
      { from: "missing", to: "a", feedback: false },
    ],
  };
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(invalidLegacy));
  const invalidSaved = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  const legacy = graphResult(await preparedCall("node", { id: "new", task: "new" }));
  assert.equal(legacy.applied, false);
  assert.match(legacy.text, /The graph is unchanged/);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), invalidSaved);
  // Replacing an edge type can repair an invalid saved graph. The return must
  // describe the changed flag, not generically acknowledge an "edge edit".
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({
    originalGoal: "Repair edge type", nodes: [{ id: "a", task: "Build" }, { id: "b", task: "Check" }],
    edges: [{ from: "a", to: "b", feedback: false }, { from: "b", to: "a", feedback: false }],
  }));
  const repairedType = graphResult(await edge({ from: "b", to: "a", feedback: true }));
  assert.equal(repairedType.applied, true);
  assert.equal(repairedType.text, 'Successfully updated edge "b" → "a" (feedback: false → true).');
  assert.deepEqual(readGraph().edges, [{ from: "a", to: "b", feedback: false }, { from: "b", to: "a", feedback: true }]);
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, emptyBeforeLegacy);

  const nullableNodes = graphResult(await applyEdits("node", [
    { id: "nullable-build", task: "Build", delete: null }, { id: "nullable-review", task: "Review", delete: null },
  ]));
  assert.equal(nullableNodes.applied, true);
  assert.equal(graphResult(await call("edge", {
    edges: [{ from: "nullable-build", to: "nullable-review", feedback: null, delete: null }],
  })).applied, true);
  assert.equal(graphResult(await node({ id: "nullable-build", task: "Updated", delete: null })).applied, true);
  assert.equal(graphResult(await edge({
    from: "nullable-build", to: "nullable-review", feedback: null, delete: true,
  })).applied, true);
  await node({ id: "nullable-build", task: null, delete: true });
  const emptyGraph = graphResult(await node({ id: "nullable-review", delete: true }));
  assert.equal(emptyGraph.applied, true, "Mutation checks are not final graph validation");
  assert.deepEqual(readGraph().nodes, []);
  assert.equal(emptyGraph.warnings, undefined);
  const initialWarnings = graphResult(await applyEdits("node", [
    { id: "initial-a", task: "Same task" }, { id: "initial-b", task: "Same task" },
  ]));
  assert.deepEqual(initialWarnings.warnings, ["2 nodes have identical task text; they may duplicate work. Confirm that this is intentional.\n- initial-a\n- initial-b"]);
  await applyEdits("node", [{ id: "initial-a", delete: true }, { id: "initial-b", delete: true }]);
  const rejectedFirst = graphResult(await node({ id: "build" }));
  assert.equal(rejectedFirst.applied, false);
  assert.deepEqual(readGraph().nodes, []);
  const firstMutation = await node({ id: "build", task: "Build it" });
  assert.deepEqual(firstMutation.details, {});
  assert.equal((firstMutation as any).isError, undefined);
  assert.match(graphResult(firstMutation).text, /created node "build"/);
  assert.doesNotMatch(graphResult(firstMutation).text, /Output truncated|Full output:/);
  const secondMutation = graphResult(await node({ id: "review", task: "Review it" }));
  assert.doesNotMatch(secondMutation.text, /Build it|"build"/, "A result must not echo unrelated nodes/tasks");
  const beforeFeedback = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  const prematureFeedback = graphResult(await edge({ from: "review", to: "build", feedback: true }));
  assert.equal(prematureFeedback.applied, false);
  assert.match(prematureFeedback.diagnostics[0], /dependency path from build to review/);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), beforeFeedback);
  const missingEndpoint = graphResult(await edge({ from: "build", to: "missing", feedback: false }));
  assert.match(missingEndpoint.diagnostics[0], /Missing: missing/);
  assert.match(missingEndpoint.diagnostics[0], /Existing nodes: build, review/);
  const dependency = await edge({ from: "build", to: "review" });
  assert.deepEqual(dependency.details, {});
  assert.equal(graphResult(dependency).text, 'Successfully created edge "build" → "review".');
  assert.equal(readGraph().edges[0].feedback, false);
  await node({ id: "leftover", task: "Leftover" });
  await edge({ from: "build", to: "leftover" });
  const removedAgain = graphResult(await node({ id: "leftover", delete: true }));
  assert.match(removedAgain.text, /deleted node "leftover"/);
  assert.deepEqual(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges,
    [{ from: "build", to: "review", feedback: false }]);
  const before = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
  const rejected = await edge({ from: "review", to: "build", feedback: false });
  assert.deepEqual(Object.keys(rejected), ["content", "details", "isError"]);
  assert.equal(rejected.isError, true);
  assert.deepEqual(rejected.details.diagnosticCodes, ["E101"]);
  assert.doesNotMatch(rejected.content[0].text, /E101/);
  const cycle = graphResult(rejected);
  assert.equal(cycle.applied, false);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), before);
  assert.match(cycle.diagnostics[0], /build → review/);
  assert.match(cycle.diagnostics[0], /review → build/);
  const accepted = await node({ id: "review", task: "Review it" });
  assert.equal((accepted as any).isError, undefined);
  assert.equal(graphResult(accepted).applied, true);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), before);
  const duplicateTask = await node({ id: "review", task: "Build it" });
  const duplicateTaskFeedback = graphResult(duplicateTask);
  assert.equal(duplicateTaskFeedback.applied, true);
  assert.deepEqual(duplicateTaskFeedback.warnings, ["2 nodes have identical task text; they may duplicate work. Confirm that this is intentional.\n- build\n- review"]);
  assert.equal((duplicateTask as any).isError, undefined, "Duplicate tasks are advisory, not rejected edits");
  assert.equal(graphResult(await node({ id: "review", task: "Review it" })).warnings, undefined);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), before);
  const warning = await node({ id: "review", task: "Review it; return <FEEDBACK> when needed." });
  const warningFeedback = graphResult(warning);
  assert.equal(warningFeedback.applied, true);
  assert.deepEqual(warningFeedback.warnings, ["review mentions <FEEDBACK> but has no outgoing feedback edge; the marker cannot send feedback."]);
  assert.equal((warning as any).isError, undefined, "Warnings do not reject mutations");
  const repaired = await edge({ from: "review", to: "build", feedback: true });
  const repairedFeedback = graphResult(repaired);
  assert.equal(repairedFeedback.applied, true);
  assert.ok(readGraph().edges.some((edge: any) => edge.from === "review" && edge.to === "build" && edge.feedback));
  assert.equal(repairedFeedback.warnings, undefined);
  assert.equal(repairedFeedback.notes, undefined, "Adding a feedback route resolves the missing-route warning without returning a rerun-scope note");
  assert.equal((repaired as any).isError, undefined, "A valid feedback route remains accepted");
  const portableGraph = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  for (const task of [`Work at ${repository}.`, `Read ${repository}/sample.txt`]) {
    await node({ id: "build", task });
    const savedTask = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).nodes.find((n: { id: string }) => n.id === "build").task;
    assert.equal(savedTask, task, "Task content is not rewritten");
  }
  await node({ id: "build", task: "In your assigned worktree, update sample.txt and verify it." });
  assert.match(JSON.stringify(await call("bash", { command: "cat sample.txt" })), /planner fixture/);
  for (const command of ["cat ../rubric.json", "cat outside/rubric.json", "printf changed > changed"]) {
    await call("bash", { command });
  }
  assert.equal(readFileSync(join(repository, "changed"), "utf8"), "changed");
  const deletedBuild = graphResult(await node({ id: "build", delete: true }));
  assert.deepEqual(readGraph().nodes.map((node: any) => node.id), ["review"]);
  assert.deepEqual(readGraph().edges, []);
  assert.equal(deletedBuild.warnings.length, 1);
  assert.match(deletedBuild.warnings[0], /review mentions <FEEDBACK>/, "Deleting the feedback target exposes the missing-route warning again");
  assert.deepEqual(deletedBuild.notes, [
    "Removed 2 incident edges:", "build → review", "review → build (feedback)",
  ]);
  // Deleting something that does not exist is an error, like Pi's edit when its
  // target text is missing; it is reported before the compiler runs.
  const missingDelete = await edge({ from: "review", to: "build", delete: true });
  assert.equal(graphResult(missingDelete).applied, false);
  assert.deepEqual(missingDelete.details.diagnosticCodes, ["not-found"]);
  assert.match(graphResult(missingDelete).text, /^Edge "review" → "build" does not exist; nothing to delete\.\nThe graph is unchanged\./);
  const missingNode = await node({ id: "ghost", delete: true });
  assert.equal(missingNode.isError, true);
  assert.match(graphResult(missingNode).text, /^Node "ghost" does not exist; nothing to delete\./);
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).edges.length, 0);
  // Edge results distinguish what actually happened to the ordered pair.
  await node({ id: "left", task: "Left work" });
  await node({ id: "right", task: "Right work" });
  await edge({ from: "left", to: "right" });
  assert.equal(graphResult(await edge({ from: "left", to: "right" })).text.split("\n")[0], 'Edge "left" → "right" already exists with these settings; no change.');
  const deleteRight = graphResult(await edge({ from: "left", to: "right", delete: true }));
  assert.equal(deleteRight.text.split("\n")[0], 'Successfully deleted edge "left" → "right".');
  await edge({ from: "left", to: "right" });
  await edge({ from: "right", to: "left", feedback: true });
  assert.equal(graphResult(await edge({ from: "right", to: "left", feedback: true })).text.split("\n")[0], 'Edge "right" → "left" already exists with these settings; no change.');
  assert.equal(graphResult(await edge({ from: "right", to: "left", feedback: false })).applied, false, "Replacing a feedback edge with an ordinary one is validated like any other edit");
  await edge({ from: "right", to: "left", delete: true });
  await node({ id: "left", delete: true });
  await node({ id: "right", delete: true });
  // Runtime-state constraint is read when the extension loads: a node whose
  // result this run already published cannot be deleted, but its task can be
  // reworked. The rejection must reach the Planner as an actionable tool
  // diagnostic instead of failing the whole commit inside Runtime.
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({
    originalGoal: "Published fixture",
    nodes: [{ id: "published", task: "Original" }, { id: "fresh", task: "New work" }],
    edges: [],
  }));
  process.env.GRAPHER_UNREMOVABLE_NODES = JSON.stringify(["published"]);
  const publishedLoaded = await loadExtensions([join(source, "backend/resources/planner.ts")], repository);
  assert.deepEqual(publishedLoaded.errors, []);
  const publishedExtension = publishedLoaded.extensions[0];
  const publishedCall = async (name: string, parameters: Record<string, unknown>) => {
    const tool = itemTool(publishedExtension.tools, name);
    const prepared = tool.prepareArguments ? tool.prepareArguments(parameters) as Record<string, unknown> : parameters;
    const args = validateToolArguments(tool, { type: "toolCall", id: "test-published", name, arguments: prepared });
    return await tool.execute("test-published", args, undefined, undefined, context);
  };
  const publishedBefore = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  const publishedDelete = await publishedCall("node", { nodes: [{ id: "published", delete: true }, { id: "fresh", task: "Must not be saved" }] });
  const publishedDeleteResult = graphResult(publishedDelete);
  assert.equal(publishedDeleteResult.applied, false);
  assert.match(publishedDeleteResult.diagnostics[0], /Cannot remove node 'published'/);
  assert.match(publishedDeleteResult.diagnostics[0], /already published/);
  assert.deepEqual(publishedDelete.details.diagnosticCodes, ["E210"]);
  assert.equal(publishedDelete.isError, true);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), publishedBefore, "A rejected edit leaves the saved graph unchanged");
  const rework = graphResult(await publishedCall("node", { nodes: [{ id: "published", task: "Reworked" }] }));
  assert.equal(rework.applied, true, "Reworking a published node's task stays allowed");
  assert.equal(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")).nodes.find((n: { id: string }) => n.id === "published").task, "Reworked");
  const deleteFresh = graphResult(await publishedCall("node", { nodes: [{ id: "fresh", delete: true }] }));
  assert.equal(deleteFresh.applied, true, "Nodes without published results stay deletable");
  delete process.env.GRAPHER_UNREMOVABLE_NODES;
  // Each whole batch compiles once, irrespective of the number of edits.
  const compilerPath = process.env.GRAPHER_COMPILER_PATH!;
  const countedCompiler = join(root, process.platform === "win32" ? "counted-compiler.exe" : "counted-compiler.mjs");
  const compilerCalls = join(root, "compiler-calls.txt");
  if (process.platform === "win32") {
    // Windows CreateProcess cannot execute a shebang script. Keep the Planner
    // unchanged and use a test-owned native executable for compile counting.
    const wrapper = join(root, "counted_compiler.rs");
    writeFileSync(wrapper, `use std::io::{Read, Write};
fn main() {
  if let Ok(fault) = std::env::var("GRAPHER_TEST_COMPILE_FAULT") {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    match fault.as_str() {
      "invalid-json" => print!("{{"),
      "null-json" => print!("null"),
      "bad-plan" => print!("{}", r#"{"plan":true,"diagnostics":[]}"#),
      "retired-plan" => print!("{}", r#"{"plan":{"executionBatches":[],"roots":[],"terminals":[],"warnings":[]},"diagnostics":[],"mutationWarnings":[]}"#),
      "bad-diagnostics" => print!("{}", r#"{"plan":{},"diagnostics":{}}"#),
      "missing-warnings" => print!("{}", r#"{"plan":{"executionBatches":[],"rootNodes":[],"terminals":[],"warnings":[]},"diagnostics":[]}"#),
      "missing-impact" => print!("{}", r#"{"plan":{"executionBatches":[],"rootNodes":[],"terminals":[],"warnings":[]},"diagnostics":[],"mutationWarnings":[{"code":"W304","message":"Completed work is affected."}]}"#),
      "bad-impact" => print!("{}", r#"{"plan":{"executionBatches":[],"rootNodes":[],"terminals":[],"warnings":[]},"diagnostics":[],"mutationWarnings":[{"code":"W304","message":"Completed work is affected."}],"revisionImpact":{"rerunCount":-1}}"#),
      "orphan-impact" => print!("{}", r#"{"plan":{"executionBatches":[],"rootNodes":[],"terminals":[],"warnings":[]},"diagnostics":[],"mutationWarnings":[],"revisionImpact":{"rerunCount":2}}"#),
      "early-exit" => std::process::exit(7),
      "overflow" => { let _ = std::io::stdout().write_all(&vec![b'x'; 2 * 1024 * 1024]); },
      _ => panic!("Unknown fixture mode"),
    }
    return;
  }
  if let Ok(marker) = std::env::var("GRAPHER_TEST_COMPILE_MARKER") {
    std::fs::write(&marker, b"started").unwrap();
    while !std::path::Path::new(&format!("{marker}.release")).exists() {
      std::thread::sleep(std::time::Duration::from_millis(5));
    }
  }
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
    writeFileSync(countedCompiler, `#!${process.execPath}\nimport { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nif (process.env.GRAPHER_TEST_COMPILE_FAULT) { readFileSync(0); switch (process.env.GRAPHER_TEST_COMPILE_FAULT) { case 'invalid-json': process.stdout.write('{'); break; case 'null-json': process.stdout.write('null'); break; case 'bad-plan': process.stdout.write('{"plan":true,"diagnostics":[]}'); break; case 'retired-plan': process.stdout.write('{"plan":{"executionBatches":[],"roots":[],"terminals":[],"warnings":[]},"diagnostics":[],"mutationWarnings":[]}'); break; case 'bad-diagnostics': process.stdout.write('{"plan":{},"diagnostics":{}}'); break; case 'missing-warnings': process.stdout.write('{"plan":{"executionBatches":[],"rootNodes":[],"terminals":[],"warnings":[]},"diagnostics":[]}'); break; case 'missing-impact': process.stdout.write('{"plan":{"executionBatches":[],"rootNodes":[],"terminals":[],"warnings":[]},"diagnostics":[],"mutationWarnings":[{"code":"W304","message":"Completed work is affected."}]}'); break; case 'bad-impact': process.stdout.write('{"plan":{"executionBatches":[],"rootNodes":[],"terminals":[],"warnings":[]},"diagnostics":[],"mutationWarnings":[{"code":"W304","message":"Completed work is affected."}],"revisionImpact":{"rerunCount":-1}}'); break; case 'orphan-impact': process.stdout.write('{"plan":{"executionBatches":[],"rootNodes":[],"terminals":[],"warnings":[]},"diagnostics":[],"mutationWarnings":[],"revisionImpact":{"rerunCount":2}}'); break; case 'early-exit': process.exit(7); break; case 'overflow': process.stdout.write('x'.repeat(2 * 1024 * 1024)); break; } } else {\nif (process.env.GRAPHER_TEST_COMPILE_MARKER) { const marker = process.env.GRAPHER_TEST_COMPILE_MARKER; writeFileSync(marker, 'started'); while (!existsSync(marker + '.release')) await new Promise(resolve => setTimeout(resolve, 5)); }\nappendFileSync(${JSON.stringify(compilerCalls)}, 'compile\\n');\nconst result = spawnSync(${JSON.stringify(compilerPath)}, process.argv.slice(2), { input: readFileSync(0), encoding: 'utf8' });\nprocess.stdout.write(result.stdout || '');\nprocess.stderr.write(result.stderr || '');\nprocess.exit(result.status ?? 1);\n}\n`);
    chmodSync(countedCompiler, 0o755);
  }
  process.env.GRAPHER_COMPILER_PATH = countedCompiler;
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({ originalGoal: "Single-call fixture", nodes: [], edges: [] }));
  const batchNodes = ["contract", "parser", "search", "integration", "verification"].map(name => ({ id: name, task: `Complete ${name}` }));
  const batchEdges = [
    { from: "contract", to: "parser" }, { from: "contract", to: "search" },
    { from: "parser", to: "integration" }, { from: "search", to: "integration" },
    { from: "integration", to: "verification" },
  ];
  const nodeBatch = graphResult(await applyEdits("node", batchNodes));
  assert.equal(nodeBatch.applied, true);
  assert.equal(readGraph().nodes.length, batchNodes.length);
  assert.equal(nodeBatch.warnings, undefined);
  const initialGraph = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"));
  assert.equal(initialGraph.edges.length, 0);
  const initialFinalPlan = JSON.parse(execFileSync(compilerPath, ["--compile"], {
    input: JSON.stringify({ graph: initialGraph, finalCheck: true }), encoding: "utf8",
  }));
  assert.deepEqual(initialFinalPlan.plan.rootNodes, ["contract", "integration", "parser", "search", "verification"],
    "A deliberately edgeless final graph must still compile with all roots");
  const batchResult = graphResult(await applyEdits("edge", batchEdges));
  assert.equal(batchResult.applied, true);
  assert.deepEqual(readGraph().edges, batchEdges.map(edge => ({ ...edge, feedback: false })));
  assert.equal(batchResult.warnings, undefined);
  assert.equal(readFileSync(compilerCalls, "utf8"), "compile\n".repeat(2));
  const batchSaved = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  // Exercise cancellation through Pi's real prepare/validate/execute pipeline
  // while the compiler is running, not only before execute or while queued.
  const compileMarker = join(root, "compiler-started");
  const compileAbort = new AbortController();
  process.env.GRAPHER_TEST_COMPILE_MARKER = compileMarker;
  try {
    const toolCall = { type: "toolCall" as const, id: "cancel-compile", name: "edit_graph",
      arguments: { nodes: [{ id: "cancelled-compile", task: "Must not be committed" }] } };
    const cancelled = runToolCall(toolCall, { tools: [editTool] as any,
      assistantMessage: { role: "assistant", content: [toolCall] } as any,
      context: { messages: [], tools: [editTool] } as any, signal: compileAbort.signal });
    const abortStartedCompiler = async () => {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(compileMarker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(fs.existsSync(compileMarker), "Compiler must actually start before cancellation");
      let readSettled = false;
      const queuedRead = snapshot().then(graph => { readSettled = true; return graph; });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(readSettled, false, "Reads remain queued while the compiler is active");
      compileAbort.abort();
      return queuedRead;
    };
    const [outcome, afterAbort] = await Promise.all([cancelled, abortStartedCompiler()]);
    assert.deepEqual(afterAbort, graphReadView(JSON.parse(batchSaved)));
    assert.equal(outcome.isError, true, "Pi must observe cancellation, not a committed success");
    assert.match(outcome.result.content[0].text, /Operation aborted/);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), batchSaved);
  } finally {
    writeFileSync(`${compileMarker}.release`, "release");
    delete process.env.GRAPHER_TEST_COMPILE_MARKER;
  }
  assert.equal(graphResult(await node({ id: "after-compiler-cancel", task: "Queue recovered" })).applied, true);
  await node({ id: "after-compiler-cancel", delete: true });
  writeFileSync(process.env.GRAPHER_GRAPH_PATH!, batchSaved);
  // Compiler transport/protocol failures must fail closed and leave the shared
  // queue usable. A truthy non-plan must never authorize a graph write.
  try {
    for (const [fault, code] of [
      ["bad-plan", "compiler-response"], ["retired-plan", "compiler-response"], ["bad-diagnostics", "compiler-response"],
      ["invalid-json", "compiler-response"], ["null-json", "compiler-response"],
      ["missing-warnings", "compiler-response"], ["missing-impact", "compiler-response"],
      ["bad-impact", "compiler-response"], ["orphan-impact", "compiler-response"],
      ["early-exit", "compiler-unavailable"], ["overflow", "compiler-unavailable"],
    ]) {
      process.env.GRAPHER_TEST_COMPILE_FAULT = fault;
      const response = await call("edit_graph", { nodes: [{ id: "bad-compiler", task: "Must not be saved" }] });
      assert.equal(response.isError, true, fault);
      assert.deepEqual(response.details.diagnosticCodes, [code], fault);
      assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), batchSaved, fault);
    }
  } finally {
    delete process.env.GRAPHER_TEST_COMPILE_FAULT;
  }
  const beforeMissingDeletes = readFileSync(compilerCalls, "utf8");
  assert.equal((await node({ id: "missing", delete: true })).isError, true);
  assert.equal((await edge({ from: "contract", to: "missing", delete: true })).isError, true);
  assert.equal(readFileSync(compilerCalls, "utf8"), beforeMissingDeletes, "Missing deletions are rejected before compilation");
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), batchSaved);
  assert.equal(JSON.parse(batchSaved).originalGoal, "Single-call fixture");
  assert.ok(JSON.parse(batchSaved).edges.every((edge: { feedback: boolean }) => edge.feedback === false));
  // Redundant direct dependencies are automatically removed and reported as
  // successful notes instead of failing with E209.
  for (const [to, path] of [
    ["integration", "contract → parser → integration"],
    ["verification", "contract → parser → integration → verification"],
  ] as const) {
    const redundant = await edge({ from: "contract", to });
    const redundantResult = graphResult(redundant);
    assert.equal(redundantResult.applied, true);
    assert.equal(redundant.isError, undefined);
    assert.equal(redundant.details.diagnosticCodes, undefined);
    assert.match(redundantResult.text, /Edit succeeded; redundant direct dependency was automatically removed\./);
    assert.deepEqual(redundantResult.notes, [
      "Auto-removed 1 redundant direct dependency (already provided by indirect path):",
      `contract → ${to} (via ${path})`,
    ]);
    assert.doesNotMatch(redundantResult.text, /The graph is unchanged/);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), batchSaved);
  }
  // A mixed batch commits valid nodes and edges while auto-removing redundant
  // direct dependencies in the same call.
  const mixedBatch = await call("edit_graph", {
    nodes: [{ id: "release", task: "Release package" }],
    edges: [
      { from: "verification", to: "release" },
      { from: "contract", to: "release" },
    ],
  });
  assert.equal(mixedBatch.isError, undefined);
  assert.equal(graphResult(mixedBatch).applied, true);
  assert.deepEqual(graphResult(mixedBatch).notes, [
    "Auto-removed 1 redundant direct dependency (already provided by indirect path):",
    "contract → release (via contract → parser → integration → verification → release)",
  ]);
  assert.ok(readGraph().nodes.some((node: any) => node.id === "release"));
  assert.ok(readGraph().edges.some((edge: any) => edge.from === "verification" && edge.to === "release"));
  assert.ok(!readGraph().edges.some((edge: any) => edge.from === "contract" && edge.to === "release"));
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, batchSaved);
  // Pre-existing redundant edges (including ids containing arrows) are also
  // auto-removed and reported against surviving indirect paths.
  const retainedRedundant = JSON.parse(batchSaved);
  const literalSource = "contract → alias";
  retainedRedundant.nodes.find((node: any) => node.id === "contract").id = literalSource;
  for (const edge of retainedRedundant.edges) if (edge.from === "contract") edge.from = literalSource;
  retainedRedundant.edges.push({ from: literalSource, to: "integration", feedback: false });
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(retainedRedundant));
  const mixedRedundancy = graphResult(await edge({ from: literalSource, to: "verification" }));
  assert.equal(mixedRedundancy.applied, true);
  assert.deepEqual(mixedRedundancy.notes, [
    "Auto-removed 2 redundant direct dependencies (already provided by indirect paths):",
    `${literalSource} → integration (via ${literalSource} → parser → integration)`,
    `${literalSource} → verification (via ${literalSource} → parser → integration → verification)`,
  ]);
  assert.ok(!readGraph().edges.some((edge: any) => edge.from === literalSource && (edge.to === "integration" || edge.to === "verification")));
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, batchSaved);
  // Warnings never wedge between an auto-removed note header and its edge list.
  const warnAndPrune = graphResult(await call("edit_graph", {
    nodes: [{ id: "dup", task: batchNodes[0].task }],
    edges: [{ from: "contract", to: "integration" }],
  }));
  assert.equal(warnAndPrune.applied, true);
  assert.equal(warnAndPrune.warnings.length, 1);
  assert.ok(warnAndPrune.text.includes(
    "Auto-removed 1 redundant direct dependency (already provided by indirect path):\ncontract → integration (via contract → parser → integration)",
  ));
  assert.ok(warnAndPrune.text.indexOf("Warning:") < warnAndPrune.text.indexOf("Auto-removed 1 redundant direct dependency"));
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, batchSaved);
  // Fanout DAG pruning stays fast (O(V*(V+E))) in both tool and preview.
  const fanoutLeaves = leaves.slice(0, 150);
  const fanoutGraph = {
    originalGoal: "Fanout prune",
    nodes: [{ id: "hub", task: "Hub" }, ...fanoutLeaves],
    edges: fanoutLeaves.map(leaf => ({ from: "hub", to: leaf.id, feedback: false })),
  };
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(fanoutGraph));
  const pruneStart = Date.now();
  const fanoutPruned = graphResult(await edge({ from: "n0", to: "n1" }));
  assert.equal(fanoutPruned.applied, true);
  assert.deepEqual(fanoutPruned.notes, [
    "Auto-removed 1 redundant direct dependency (already provided by indirect path):",
    "hub → n1 (via hub → n0 → n1)",
  ]);
  assert.ok(Date.now() - pruneStart < 5000, "Fanout redundant-edge pruning stays fast");
  const fanoutPreview = applyPlannerEdgeEditsToState(
    { graph: fanoutGraph, plan: null } as any,
    [{ from: "n0", to: "n1", feedback: false, delete: false }],
  );
  assert.deepEqual(fanoutPreview.graph, readGraph());
  const hugeFanout = {
    originalGoal: "Huge fanout preview prune",
    nodes: [{ id: "hub", task: "Hub" }, ...leaves],
    edges: leaves.map(leaf => ({ from: "hub", to: leaf.id, feedback: false })),
  };
  const previewStart = Date.now();
  const hugePreview = applyPlannerEdgeEditsToState(
    { graph: hugeFanout, plan: null } as any,
    [{ from: "n0", to: "n1", feedback: false, delete: false }],
  );
  assert.ok(Date.now() - previewStart < 500, "Large fanout preview pruning stays fast");
  assert.ok(!hugePreview.graph.edges.some(item => item.from === "hub" && item.to === "n1"));
  assert.ok(hugePreview.graph.edges.some(item => item.from === "n0" && item.to === "n1"));
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, batchSaved);

  // Every rejected call leaves the saved graph unchanged.
  for (const [toolName, edits, code] of [
    ["edge", { from: "verification", to: "contract" }, "E101"],
    ["edge", { from: "contract", to: "missing" }, "E204"],
    ["edge", { from: "parser", to: "search", feedback: true }, "E207"],
    ["edge", { from: "verification", to: "search", feedback: true }, "E208"],
    ["node", { id: "invalid" }, "E203"],
  ] as const) {
    if (code === "E208") await edge({ from: "verification", to: "parser", feedback: true });
    const beforeCall = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
    const response = await call(toolName, edits);
    const rejectedBatch = graphResult(response);
    assert.equal(rejectedBatch.applied, false);
    assert.equal(typeof rejectedBatch.diagnostics[0], "string");
    assert.equal(response.details.diagnosticCodes[0], code);
    if (code === "E208") {
      assert.match(rejectedBatch.diagnostics[0], /Consider restructuring feedback ownership rather than merely dropping routes/);
      assert.match(rejectedBatch.diagnostics[0], /possible approaches include separate feedback sources/);
      assert.match(rejectedBatch.diagnostics[0], /a shared owner responsible for reworking the combined result/);
      assert.match(rejectedBatch.diagnostics[0], /node tasks remain consistent with the resulting feedback routes/);
    }
    assert.deepEqual(Object.keys(response.details), ["diagnostics", "diagnosticCodes"]);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), beforeCall);
    assert.equal(response.isError, true);
    if (code === "E208") await edge({ from: "verification", to: "parser", delete: true });
  }
  // Duplicate targets are ambiguous, not an order-dependent edit language.
  const beforeDuplicates = readFileSync(compilerCalls, "utf8");
  for (const raw of [
    { nodes: [{ id: "contract", task: "Changed" }, { id: "contract", delete: true }] },
    { edges: [{ from: "contract", to: "parser", delete: true }, { from: "contract", to: "parser" }] },
  ]) {
    const duplicate = await call("edit_graph", raw);
    assert.deepEqual(duplicate.details.diagnosticCodes, ["duplicate-target"]);
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), batchSaved);
    assert.equal(readFileSync(compilerCalls, "utf8"), beforeDuplicates);
  }
  for (const invalid of [
    { id: "contract", task: "Bare item" }, { nodes: batchNodes, name: "ambiguous" },
    { edges: [{ from: "contract" }] }, { nodes: [{ task: "Missing id" }] },
    { edges: [{ from: "contract", to: "parser", relation: "removed" }] },
    { nodes: batchNodes, extra: true },
  ]) {
    assert.throws(() => validated(invalid));
    assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), batchSaved);
  }
  // Node and edge changes form one transaction, including compiler failure.
  const beforeMixedCompiles = readFileSync(compilerCalls, "utf8");
  const failedMixed = await call("edit_graph", {
    nodes: [{ id: "atomic-new", task: "New work" }, { id: "contract", task: "Changed" }],
    edges: [{ from: "atomic-new", to: "absent" }],
  });
  assert.equal(failedMixed.isError, true);
  assert.deepEqual(failedMixed.details.diagnosticCodes, ["E204"]);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), batchSaved, "No node update leaks from a rejected edge");
  assert.equal(readFileSync(compilerCalls, "utf8"), `${beforeMixedCompiles}compile\n`);
  const mixed = await call("edit_graph", {
    nodes: [{ id: "atomic-new", task: "New work" }, { id: "atomic-check", task: "Check work" }],
    edges: [{ from: "atomic-new", to: "atomic-check" }, { from: "atomic-check", to: "atomic-new", feedback: true }],
  });
  assert.equal(graphResult(mixed).applied, true);
  assert.equal(readFileSync(compilerCalls, "utf8"), `${beforeMixedCompiles}compile\ncompile\n`);
  assert.ok(readGraph().edges.some((edge: any) => edge.from === "atomic-check" && edge.feedback));
  // Explicit edge deletion may overlap a node's implicit cascade.
  assert.equal(graphResult(await call("edit_graph", {
    nodes: [{ id: "atomic-new", delete: true }, { id: "atomic-check", delete: true }],
    edges: [{ from: "atomic-new", to: "atomic-check", delete: true }],
  })).applied, true);
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, batchSaved);

  // Final-state validation can preserve a retained constraint even when no
  // sequence of individually valid edits can rewire its dependency path.
  const retainedRoute = { originalGoal: "Atomic rewire", nodes: [{ id: "a", task: "A" }, { id: "c", task: "C" }],
    edges: [{ from: "a", to: "c", feedback: false }, { from: "c", to: "a", feedback: true }] };
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(retainedRoute));
  assert.equal(graphResult(await call("edit_graph", {
    nodes: [{ id: "b", task: "B" }],
    edges: [{ from: "b", to: "c" }, { from: "a", to: "b" }, { from: "a", to: "c", delete: true }],
  })).applied, true);
  assert.deepEqual(readGraph().edges, [{ from: "c", to: "a", feedback: true }, { from: "b", to: "c", feedback: false }, { from: "a", to: "b", feedback: false }]);
  const beforeCycleBatch = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  assert.equal((await call("edit_graph", { nodes: [{ id: "b", task: "Unsaved" }], edges: [{ from: "c", to: "a" }] })).isError, true);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), beforeCycleBatch);
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, batchSaved);
  // A single change is a one-item batch.
  const single = graphResult(await node({ id: "single", task: "Single task" }));
  assert.equal(single.applied, true);
  await node({ id: "single", delete: true });
  // Inserting a node across an existing direct edge: adding the second leg
  // automatically removes the bypassed direct edge and reports the surviving path.
  await applyEdits("node", [
    { id: "bypass_a", task: "Step A" },
    { id: "bypass_b", task: "Step B" },
    { id: "bypass_c", task: "Step C" },
  ]);
  await edge({ from: "bypass_a", to: "bypass_c" });
  await edge({ from: "bypass_a", to: "bypass_b" });
  const insertedMiddle = await edge({ from: "bypass_b", to: "bypass_c" });
  const insertedMiddleResult = graphResult(insertedMiddle);
  assert.equal(insertedMiddleResult.applied, true);
  assert.equal(insertedMiddle.isError, undefined);
  assert.deepEqual(readGraph().edges.filter((edge: any) => edge.from.startsWith("bypass_")).map((edge: any) => `${edge.from}>${edge.to}`), ["bypass_a>bypass_b", "bypass_b>bypass_c"]);
  assert.equal(insertedMiddleResult.warnings, undefined);
  assert.deepEqual(insertedMiddleResult.notes, [
    "Auto-removed 1 redundant direct dependency (already provided by indirect path):",
    "bypass_a → bypass_c (via bypass_a → bypass_b → bypass_c)",
  ]);
  await applyEdits("node", [
    { id: "bypass_a", delete: true },
    { id: "bypass_b", delete: true },
    { id: "bypass_c", delete: true },
  ]);
  // A batch may change direction and establish a feedback route together.
  const rewired = graphResult(await applyEdits("edge", [
    { from: "contract", to: "parser", delete: true },
    { from: "parser", to: "integration", delete: true },
    { from: "parser", to: "contract" },
    { from: "verification", to: "parser", feedback: true },
  ]));
  assert.equal(rewired.applied, true);
  assert.ok(readGraph().edges.some((edge: any) => edge.from === "verification" && edge.to === "parser" && edge.feedback));
  assert.equal(rewired.warnings, undefined);
  assert.equal(rewired.notes, undefined, "New feedback routes do not add rerun-scope notes");
  // A failed call does not roll back unrelated successful calls. Temporarily
  // remove the affected feedback route before restructuring its dependency path.
  assert.equal(graphResult(await node({ id: "contract", delete: true })).applied, false);
  await edge({ from: "verification", to: "parser", delete: true });
  await edge({ from: "parser", to: "contract", delete: true });
  await edge({ from: "parser", to: "integration" });
  await edge({ from: "verification", to: "parser", feedback: true });
  await node({ id: "contract", delete: true });
  await node({ id: "search", task: "Final replacement" });
  const afterDeletion = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"));
  assert.equal(afterDeletion.nodes.find((n: { id: string }) => n.id === "search").task, "Final replacement");
  assert.ok(afterDeletion.edges.every((e: { from: string; to: string }) => e.from !== "contract" && e.to !== "contract"));
  // Create the dependency before its feedback route, using ordinary calls.
  await applyEdits("node", [{ id: "fix", task: "Fix" }, { id: "check", task: "Check" }]);
  const addedBranch = graphResult(await applyEdits("edge", [
    { from: "fix", to: "check" }, { from: "check", to: "fix", feedback: true },
  ]));
  assert.equal(addedBranch.applied, true);
  assert.equal(addedBranch.warnings, undefined);
  assert.equal(addedBranch.notes, undefined, "Neither new nor existing feedback routes produce rerun-scope notes");

  // Operation feedback must not grow with unrelated graph state or repeat
  // other nodes' task text (including through machine-only details).
  const beforeScale = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({ originalGoal: "Result size", edges: [],
    nodes: Array.from({ length: 80 }, (_, index) => ({ id: `unrelated-${index}`, task: `PRIVATE_TASK_${index}` })) }));
  const scopedResult = await node({ id: "focus", task: "Do focused work" });
  assert.ok(graphResult(scopedResult).text.length < 120);
  assert.doesNotMatch(JSON.stringify(scopedResult), /PRIVATE_TASK_|unrelated-/);
  assert.deepEqual(scopedResult.details, {});
  assert.equal(readGraph().nodes.length, 81, "The authoritative IR still contains all nodes");
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, beforeScale);

  // Direct SDK callers may bypass Pi's sequential graph-edit scheduling. Reads
  // and mutations still share its native per-file queue, even if
  // later revision contexts are ready first.
  const beforeConcurrent = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  const previousPlannerRun = process.env.GRAPHER_PLANNER_RUN_ID;
  process.env.GRAPHER_PLANNER_RUN_ID = "concurrent-tools";
  const concurrentGraph = { originalGoal: "Concurrent calls", nodes: [], edges: [] };
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(concurrentGraph));
  function impactPath(id: string) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of Buffer.from(id, "utf8")) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    return `${process.env.GRAPHER_GRAPH_PATH}.impact-${hash.toString(16).padStart(16, "0")}.json`;
  }
  function ready(id: string) {
    writeFileSync(impactPath(id), JSON.stringify({ toolCallId: id,
      revisionContext: { graph: concurrentGraph, completedNodes: [], approved: false } }));
  }
  async function concurrentCall(name: "node" | "edge", id: string, raw: Record<string, unknown>, signal?: AbortSignal) {
    const tool = itemTool(extension.tools, name);
    const args = validateToolArguments(tool, { type: "toolCall", id, name, arguments: tool.prepareArguments!(raw) });
    return tool.execute(id, args, signal, undefined, context);
  }
  ready("queue-second");
  ready("queue-edge");
  const firstQueued = concurrentCall("node", "queue-first", { id: "a", task: "Build" });
  let readSettled = false;
  const intermediateRead = call("read_graph", {}).then(response => { readSettled = true; return JSON.parse(response.content[0].text); });
  const secondQueued = concurrentCall("node", "queue-second", { id: "b", task: "Review" });
  const edgeQueued = concurrentCall("edge", "queue-edge", { from: "a", to: "b" });
  const finalRead = snapshot();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")), concurrentGraph,
    "A ready later call must not overtake a call waiting for revision context");
  assert.equal(readSettled, false, "read_graph must wait behind an earlier pending mutation");
  ready("queue-first");
  const queuedResults = (await Promise.all([firstQueued, secondQueued, edgeQueued])).map(graphResult);
  assert.deepEqual((await intermediateRead).nodes, [{ id: "a", task: "Build" }]);
  assert.deepEqual(await finalRead, graphReadView(readGraph()));
  assert.ok(queuedResults.every(result => result.applied));
  assert.match(queuedResults[0].text, /node "a"/);
  assert.doesNotMatch(queuedResults[0].text, /"b"|Review/);
  assert.match(queuedResults[1].text, /node "b"/);
  assert.doesNotMatch(queuedResults[1].text, /"a"|Build/);
  assert.deepEqual(readGraph().edges, [{ from: "a", to: "b", feedback: false }]);

  // Cancellation while queued must not mutate the graph or poison the queue;
  // later calls to the same target still commit in invocation order.
  ready("queue-cancelled");
  ready("queue-after-cancel");
  const held = concurrentCall("node", "queue-held", { id: "a", task: "First update" });
  const controller = new AbortController();
  const cancelled = assert.rejects(concurrentCall("node", "queue-cancelled", { id: "cancelled", task: "Never saved" }, controller.signal), /Operation aborted/);
  const cancelledRead = assert.rejects(readTool.execute("cancelled-read", {}, controller.signal, undefined, context), /Operation aborted/);
  const afterCancel = concurrentCall("node", "queue-after-cancel", { id: "a", task: "Final update" });
  controller.abort();
  ready("queue-held");
  await Promise.all([held, cancelled, cancelledRead, afterCancel]);
  const afterQueue = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"));
  assert.equal(afterQueue.nodes.find((node: any) => node.id === "a").task, "Final update");
  assert.ok(!afterQueue.nodes.some((node: any) => node.id === "cancelled"));
  rmSync(impactPath("queue-cancelled"), { force: true });

  // An active call cancelled during its context wait also releases the queue
  // only after settling, without saving its candidate or starving a successor.
  const activeController = new AbortController();
  const activeCancelled = assert.rejects(concurrentCall("node", "queue-active-cancel", {
    id: "active-cancelled", task: "Never saved either",
  }, activeController.signal), /Operation aborted/);
  ready("queue-after-active-cancel");
  const afterActiveCancel = concurrentCall("node", "queue-after-active-cancel", { id: "a", task: "Recovered after active cancellation" });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8")), afterQueue);
  activeController.abort();
  await Promise.all([activeCancelled, afterActiveCancel]);
  const afterActiveQueue = JSON.parse(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"));
  assert.equal(afterActiveQueue.nodes.find((node: any) => node.id === "a").task, "Recovered after active cancellation");
  assert.ok(!afterActiveQueue.nodes.some((node: any) => node.id === "active-cancelled"));

  // A missing snapshot fails without invoking the compiler; a ready successor
  // cannot overtake it and can proceed once the timed-out call releases the queue.
  const beforeTimeoutCompiles = readFileSync(compilerCalls, "utf8");
  const timedOut = assert.rejects(concurrentCall("node", "queue-no-snapshot", { id: "unsaved", task: "Must not compile" }), /Timed out waiting.*graph is unchanged/s);
  ready("queue-after-timeout");
  const afterTimeout = concurrentCall("node", "queue-after-timeout", { id: "a", task: "Recovered after timeout" });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(readGraph(), afterActiveQueue);
  await Promise.all([timedOut, afterTimeout]);
  assert.equal(readFileSync(compilerCalls, "utf8"), `${beforeTimeoutCompiles}compile\n`, "Only the successor compiles");
  assert.equal(readGraph().nodes.find((node: any) => node.id === "a").task, "Recovered after timeout");
  assert.ok(!readGraph().nodes.some((node: any) => node.id === "unsaved"));
  if (previousPlannerRun === undefined) delete process.env.GRAPHER_PLANNER_RUN_ID;
  else process.env.GRAPHER_PLANNER_RUN_ID = previousPlannerRun;
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, beforeConcurrent);

  // Neither tool returns feedback-scope descriptions, including route creation,
  // retargeting and re-addition. Other mutation notes and warnings remain intact.
  const beforeIncrementalWarnings = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify({
    originalGoal: "Incremental warnings",
    nodes: ["base", "review", "inspect", "ship", "unrelated"].map(name => ({ id: name, task: name })),
    edges: [
      { from: "base", to: "review", feedback: false },
      { from: "review", to: "inspect", feedback: false },
      { from: "inspect", to: "ship", feedback: false },
      { from: "review", to: "base", feedback: true },
    ],
  }));
  const nodeEdit = graphResult(await node({ id: "unrelated", task: "Updated unrelated task" }));
  assert.equal(nodeEdit.warnings, undefined, "Node returns omit existing feedback-scope notes");
  assert.equal(nodeEdit.notes, undefined);
  const duplicateTaskWarning = "2 nodes have identical task text; they may duplicate work. Confirm that this is intentional.\n- base\n- unrelated";
  assert.deepEqual(graphResult(await node({ id: "unrelated", task: "base" })).warnings, [duplicateTaskWarning]);
  assert.equal(graphResult(await edge({ from: "review", to: "base", feedback: true })).warnings, undefined, "Unchanged advisory facts are not repeated on unrelated edges");
  assert.equal(graphResult(await node({ id: "unrelated", task: "base" })).warnings, undefined, "No-op replacements do not repeat duplicate-task advice");
  // A newly loaded extension makes the same decision without a seen-warning cache.
  const resumedAdvisories = await loadExtensions([join(source, "backend/resources/planner.ts")], repository);
  assert.deepEqual(resumedAdvisories.errors, []);
  const resumedEdit = await itemTool(resumedAdvisories.extensions[0].tools, "node").execute("resumed-advice", { id: "ship", task: "Ship updated" }, undefined, undefined, context);
  assert.equal(graphResult(resumedEdit).warnings, undefined);
  await node({ id: "unrelated", task: "unrelated" });
  assert.deepEqual(graphResult(await node({ id: "unrelated", task: "base" })).warnings, [duplicateTaskWarning], "Resolved advice reappears when reintroduced");
  await node({ id: "unrelated", task: "unrelated" });
  const markerWarning = graphResult(await node({ id: "unrelated", task: "Use <FEEDBACK> if necessary" }));
  assert.equal(markerWarning.warnings.length, 1);
  assert.match(markerWarning.warnings[0], /no outgoing feedback edge/);
  assert.equal(graphResult(await node({ id: "lonely-advice", task: "Independent" })).warnings, undefined);
  assert.equal(graphResult(await node({ id: "unrelated", task: "Still use <FEEDBACK> if necessary" })).warnings, undefined, "The unrouted marker fact has not changed");
  await node({ id: "unrelated", task: "unrelated" });
  assert.deepEqual(graphResult(await node({ id: "unrelated", task: "Use <FEEDBACK> again" })).warnings, markerWarning.warnings);
  await node({ id: "unrelated", task: "unrelated" });
  await node({ id: "lonely-advice", delete: true });
  const dependencyEdit = graphResult(await edge({ from: "ship", to: "unrelated" }));
  assert.equal(dependencyEdit.warnings, undefined, "Even changed scopes of existing feedback edges are not repeated");
  assert.equal(dependencyEdit.notes, undefined);
  const beforeRejectedFeedback = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  const rejectedFeedback = graphResult(await edge({ from: "ship", to: "base" }));
  assert.equal(rejectedFeedback.applied, false);
  assert.equal(rejectedFeedback.warnings, undefined);
  assert.equal(rejectedFeedback.notes, undefined);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), beforeRejectedFeedback);
  const mixedFeedback = graphResult(await applyEdits("edge", [
    { from: "inspect", to: "base", feedback: true },
    { from: "review", to: "base", feedback: true },
    { from: "ship", to: "inspect", feedback: true },
  ]));
  assert.equal(mixedFeedback.warnings, undefined);
  assert.equal(mixedFeedback.notes, undefined, "Mixed new and existing feedback routes produce no rerun-scope notes");
  const beforeRedundantFeedback = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  const prunedWithFeedback = await edge({ from: "base", to: "ship" });
  assert.equal(graphResult(prunedWithFeedback).applied, true);
  assert.equal(prunedWithFeedback.isError, undefined);
  assert.deepEqual(graphResult(prunedWithFeedback).notes, [
    "Auto-removed 1 redundant direct dependency (already provided by indirect path):",
    "base → ship (via base → review → inspect → ship)",
  ]);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), beforeRedundantFeedback, "Auto-removed redundant edge is not persisted while feedback routes stay intact");
  const reappliedRoute = graphResult(await edge({ from: "inspect", to: "base", feedback: true }));
  assert.equal(reappliedRoute.warnings, undefined);
  assert.equal(reappliedRoute.notes, undefined, "Reapplying a route does not add it again");
  const retargetedFeedback = graphResult(await applyEdits("edge", [
    { from: "ship", to: "inspect", delete: true }, { from: "ship", to: "base", feedback: true },
  ]));
  assert.equal(retargetedFeedback.warnings, undefined);
  assert.equal(retargetedFeedback.notes, undefined, "Retargeting a feedback route does not return a rerun-scope note");
  const removedRoute = graphResult(await edge({ from: "inspect", to: "base", delete: true }));
  assert.equal(removedRoute.warnings, undefined);
  assert.equal(removedRoute.notes, undefined, "Removing a route does not report other routes");
  const readdedRoute = graphResult(await edge({ from: "inspect", to: "base", feedback: true }));
  assert.equal(readdedRoute.warnings, undefined);
  assert.equal(readdedRoute.notes, undefined, "Re-adding a feedback route does not return a rerun-scope note");
  const deletedUnrelated = graphResult(await node({ id: "unrelated", delete: true }));
  assert.equal(deletedUnrelated.warnings, undefined);
  assert.deepEqual(deletedUnrelated.notes, [
    "Removed 1 incident edge:", "ship → unrelated",
  ], "Node deletions omit feedback-scope notes while reporting removed incident edges");
  await node({ id: "lonely", task: "Lonely" });
  const deletedLonely = graphResult(await node({ id: "lonely", delete: true }));
  assert.equal(deletedLonely.warnings, undefined);
  assert.equal(deletedLonely.notes, undefined, "Deleting an isolated node emits no notes");
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, beforeIncrementalWarnings);

  const beforeUnavailable = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  process.env.GRAPHER_COMPILER_PATH = join(root, "missing-compiler");
  const unavailable = await call("node", { nodes: [{ id: "fix", task: "Changed" }] });
  assert.equal(graphResult(unavailable).applied, false);
  assert.deepEqual(unavailable.details.diagnosticCodes, ["compiler-unavailable"]);
  assert.match(unavailable.content[0].text, /missing-compiler ENOENT/);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8"), beforeUnavailable);
  process.env.GRAPHER_COMPILER_PATH = compilerPath;

  // The Runtime supplies committed state for each revision tool call. Warnings
  // use the same invalidation calculation as commit and retain the tool schema.
  const beforeRevision = readFileSync(process.env.GRAPHER_GRAPH_PATH, "utf8");
  const revisionRun = process.env.GRAPHER_PLANNER_RUN_ID;
  process.env.GRAPHER_PLANNER_RUN_ID = "revision-run";
  const committed = {
    originalGoal: "Revision fixture",
    nodes: ["build", "review", "consumer", "unrelated"].map(name => ({ id: name, task: name })),
    edges: [
      { from: "build", to: "review", feedback: false },
      { from: "review", to: "consumer", feedback: false },
      { from: "review", to: "build", feedback: true },
    ],
  };
  const contextPath = `${process.env.GRAPHER_GRAPH_PATH}.impact-f9e6e6ef197c2b25.json`; // tool ID "test"
  function revisionContext(completedNodes = ["build", "review", "consumer", "unrelated"], approved = true) {
    writeFileSync(contextPath, JSON.stringify({
      toolCallId: "test", revisionContext: { graph: committed, completedNodes, approved },
    }));
  }
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(committed));
  revisionContext();
  const removeFeedback = graphResult(await edge({ from: "review", to: "build", feedback: true, delete: true }));
  const rerunWarning = [
    "Current draft will invalidate and rerun 2 completed nodes since:",
    "Graph changes affect these nodes; after their dependencies complete, they will rerun their original tasks using the latest workspace, incorporating workspaces passed down by their dependencies:",
    '- "consumer"',
    '- "review"',
  ].join("\n");
  assert.deepEqual(removeFeedback.warnings, [rerunWarning]);
  assert.equal(removeFeedback.applied, true, "Impact is a warning, not a rejected edit");

  revisionContext();
  const unchangedNode = graphResult(await node({ id: "unrelated", task: "unrelated" }));
  assert.deepEqual(unchangedNode.warnings, [rerunWarning], "Impact compares the whole candidate with the committed graph");
  revisionContext();
  const unrelatedDraftNode = graphResult(await node({ id: "new-work", task: "A new independent task" }));
  assert.deepEqual(unrelatedDraftNode.warnings, [rerunWarning], "Cumulative reasons must not be attributed to the latest unrelated edit");
  revisionContext();
  const restoreFeedback = graphResult(await edge({ from: "review", to: "build", feedback: true }));
  assert.equal(restoreFeedback.warnings, undefined);
  assert.equal(restoreFeedback.notes, undefined, "Reverting the edit removes the impact warning without adding a feedback-scope note");
  revisionContext();
  const changeTask = graphResult(await node({ id: "build", task: "Changed build" }));
  assert.deepEqual(changeTask.warnings, [[
    "Current draft will invalidate and rerun 3 completed nodes since:",
    "Tasks changed; rerun these nodes with their updated tasks:",
    '- "build"',
    "",
    "Graph changes affect these nodes; after their dependencies complete, they will rerun their original tasks using the latest workspace, incorporating workspaces passed down by their dependencies:",
    '- "consumer"',
    '- "review"',
  ].join("\n")], "Task changes distinguish updated instructions from original-task reruns on new dependency workspaces");
  revisionContext();
  const restoreTask = graphResult(await node({ id: "build", task: "build" }));
  assert.equal(restoreTask.warnings, undefined, "Restoring a node task does not repeat existing feedback-scope warnings");

  // One explanation per nonempty group, not per node. A changed node with
  // dependencies still belongs to the updated-task group, without implying
  // that every updated node starts from the source workspace alone.
  revisionContext();
  const allUpdatedTasks = graphResult(await applyEdits("node", ["build", "review", "consumer"].map(id => ({ id, task: `PRIVATE_GROUPED_TASK_${id}` }))));
  assert.deepEqual(allUpdatedTasks.warnings, [[
    "Current draft will invalidate and rerun 3 completed nodes since:",
    "Tasks changed; rerun these nodes with their updated tasks:",
    '- "build"',
    '- "consumer"',
    '- "review"',
  ].join("\n")], "Omit the empty original-task group and count nodes, not groups");
  assert.doesNotMatch(allUpdatedTasks.text, /PRIVATE_GROUPED_TASK_|workspace state/);
  revisionContext();
  assert.equal(graphResult(await applyEdits("node", ["build", "review", "consumer"].map(id => ({ id, task: id })))).warnings, undefined);

  revisionContext(["build", "review", "unrelated"]);
  const changedState = graphResult(await edge({ from: "review", to: "build", feedback: true, delete: true }));
  assert.deepEqual(changedState.warnings, [[
    "Current draft will invalidate and rerun 1 completed node since:",
    "Graph changes affect these nodes; after their dependencies complete, they will rerun their original tasks using the latest workspace, incorporating workspaces passed down by their dependencies:",
    '- "review"',
  ].join("\n")]);
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, JSON.stringify(committed));
  revisionContext(undefined, false);
  const draftEdit = graphResult(await edge({ from: "review", to: "build", feedback: true, delete: true }));
  assert.equal(draftEdit.warnings, undefined, "Unapproved drafts do not invalidate completed nodes");


  writeFileSync(contextPath, JSON.stringify({ toolCallId: "other", revisionContext: {
    graph: { originalGoal: "Legacy compiler", nodes: [{ id: "legacy", task: "Original" }], edges: [] },
    completedNodes: ["legacy"], approved: true,
  } }));
  // A missing runtime snapshot fails the call instead of validating with less
  // context (and silently dropping impact warnings).
  const beforeMissingContext = readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8");
  await assert.rejects(node({ id: "legacy", task: "Updated" }), /Timed out waiting for the runtime's graph snapshot\..*The graph is unchanged\./s);
  assert.equal(readFileSync(process.env.GRAPHER_GRAPH_PATH!, "utf8"), beforeMissingContext);
  rmSync(contextPath, { force: true });
  if (revisionRun === undefined) delete process.env.GRAPHER_PLANNER_RUN_ID;
  else process.env.GRAPHER_PLANNER_RUN_ID = revisionRun;
  writeFileSync(process.env.GRAPHER_GRAPH_PATH, beforeRevision);

  // Graph mutations remain self-contained; the shared adapter owns read/bash/write/edit.
  process.env.GRAPHER_MODE = "planner";
  writeFileSync(join(root, "grapher-planner.ts"), readFileSync(join(source, "backend/resources/planner.ts")));
  const extracted = await loadExtensions([join(root, "grapher-planner.ts"), adapterPath], repository);
  assert.deepEqual(extracted.errors, []);
  assert.deepEqual([...extracted.extensions[0].tools.keys()].sort(), ["edit_graph", "read_graph"]);
  const listed = await extracted.extensions[1].tools.get("bash")!.definition.execute("extracted", { command: "ls" }, undefined, undefined, context);
  assert.match(JSON.stringify(listed), /sample.txt/);
  const plannerOptions = normalizeBuildSystemPromptOptions({ customPrompt: "base", cwd: repository });
  const addendum = plannerOptions.appendSystemPrompt;
  await extracted.extensions[1].handlers.get("before_agent_start")![0]({ systemPromptOptions: plannerOptions });
  assert.equal(plannerOptions.appendSystemPrompt, addendum, "Planner gets no injected instructions");
  assert.equal(plannerOptions.cwd, ".");
  const plannerPrompt = buildSystemPrompt(plannerOptions);
  assert.doesNotMatch(plannerPrompt, /Use project-root-relative paths|node task handoffs|generated configuration/);

  // Partitioner and Merger use the same namespace without the Planner extension.
  for (const mode of ["partition", "merger"]) {
    process.env.GRAPHER_MODE = mode;
    const roleExtension = await loadExtensions([adapterPath], repository);
    assert.deepEqual(roleExtension.errors, []);
    const hooks = roleExtension.extensions[0].handlers;
    assert.equal(hooks.has("before_agent_start"), mode !== "partition", "Execution roles receive the relative-path convention");
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
  assert.deepEqual([...workerExtension.tools.keys()].sort(), ["bash"], "Without a graph binding the node adapter registers only Bash; ls/find/grep are gone and file tools bind via GRAPHER_ORIGINAL_ROOT");
  const workerOptions = normalizeBuildSystemPromptOptions({ customPrompt: "base", cwd: repository });
  const workerAddendum = workerOptions.appendSystemPrompt;
  assert.equal(await workerExtension.handlers.get("before_agent_start")![0]({ systemPromptOptions: workerOptions }), undefined);
  assert.equal(workerOptions.forceSystemPrompt, undefined, "Path guidance must not bypass request-time prompt trimming");
  assert.equal(workerOptions.appendSystemPrompt, workerAddendum, "Serial prompts receive no Grapher addendum");
  const workerPrompt = buildSystemPrompt(workerOptions);
  assert.doesNotMatch(workerPrompt, /Use project-root-relative paths|node task handoffs|generated configuration/,
    "Serial is the ordinary source-project Pi prompt, not a mapped execution");
  const { createReadToolDefinition } = await import("../pi/packages/coding-agent/src/core/tools/read.ts");
  const { createWriteToolDefinition } = await import("../pi/packages/coding-agent/src/core/tools/write.ts");
  const { createEditToolDefinition } = await import("../pi/packages/coding-agent/src/core/tools/edit.ts");
  const builtins = new Map([
    ["read", createReadToolDefinition(repository)],
    ["write", createWriteToolDefinition(repository)],
    ["edit", createEditToolDefinition(repository)],
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
  assert.equal(readFileSync(join(repository, "mapped.txt"), "utf8"), "after\n");
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
  console.log(`Pi extension smoke passed on ${process.platform}: read/write/edit/bash, external paths and symlinks, shell semantics, failures/cancellation, Planner graph tools. This is not a production launcher or transparent mapping test.`);
} finally {
  process.chdir(source);
  rmSync(root, { recursive: true, force: true });
}
