import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, appendFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";

const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const artifactDir = process.env.BENCHMARK_CASE_DIR ? path.resolve(process.env.BENCHMARK_CASE_DIR) : null;
const root = artifactDir || await mkdtemp(path.join(tmpdir(), "grapher-http-"));
await mkdir(root, { recursive: true });
const record = async (file, value) => {
  if (artifactDir) await appendFile(path.join(root, file), JSON.stringify(value) + "\n");
};
const base = `http://127.0.0.1:${port}`;
let backend;
let logs = "";
async function start(extraEnv = {}) {
  let spawnError;
  backend = spawn(path.resolve("backend/target/debug/grapher"), [], {
    env: { ...process.env, ...extraEnv, GRAPHER_DATA_DIR: root, GRAPHER_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  backend.stderr.on("data", chunk => { logs += chunk; });
  backend.on("error", error => { spawnError = error; logs += error.message; });
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    try { await call("bootstrap"); return; } catch {}
    if (backend.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Backend did not start: ${logs}`);
}
async function stop() {
  if (backend?.pid && backend.exitCode === null && backend.signalCode === null) {
    const exited = once(backend, "exit");
    const timeout = setTimeout(() => backend.kill("SIGKILL"), 5000);
    try {
      backend.kill("SIGTERM");
      await exited;
      assert.equal(backend.exitCode, 0, logs);
    } finally { clearTimeout(timeout); }
  }
}
async function call(command, body = {}) {
  const response = await fetch(`${base}/api/${command}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  await record("requests.jsonl", { command, body });
  await record("responses.jsonl", { command, status: response.status, body: data });
  if (!response.ok) throw new Error(data.error);
  return data.result;
}
try {
  await start();
  const bootstrap = await call("bootstrap");
  assert.equal(path.resolve(bootstrap.dataPath), root);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="root"/);
  for (const headers of [{ "Content-Type": "text/plain" }, { "Content-Type": "application/json", Origin: "https://untrusted.example" }]) {
    const response = await fetch(`${base}/api/reset_workspace`, { method: "POST", headers, body: "{}" });
    assert.ok([403, 415].includes(response.status));
  }
  await assert.rejects(call("unknown"), /Unknown command/);
  await assert.rejects(call("save_graph", {}), /Invalid graph/);
  const graph = { originalGoal: "HTTP integration", nodes: [{ name: "task", task: "Write test result" }], edges: [] };
  assert.deepEqual((await call("compile_graph", { graph })).executionBatches, [["task"]]);
  const config = { ...bootstrap.config, engine: "fixture", repository: "" };
  const saved = await call("save_graph", { graph, config });
  assert.equal(saved.phase, "awaiting_approval");
  assert.equal((await call("snapshot")).executions.length, 0);
  await call("control", { action: "approve" });
  let snapshot;
  for (let i = 0; i < 150; i++) {
    snapshot = await call("snapshot");
    if (snapshot.phase === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(snapshot.phase, "completed");
  assert.equal(snapshot.nodes.task.status, "done");
  assert.ok(snapshot.executions[0].after);
  const compact = await call("snapshot", { compact: true });
  assert.ok(snapshot.events.some(event => event.type === "output"));
  assert.ok(compact.events.every(event => event.type !== "output"));
  assert.deepEqual(compact.events, snapshot.events.filter(event => event.type !== "output"));
  assert.deepEqual(compact.executions, snapshot.executions, "compact polling preserves complete transcripts and execution identity");
  assert.deepEqual((await call("bootstrap", { compact: true })).snapshot, compact);
  assert.deepEqual(await call("history", { runId: saved.runId, compact: true }), compact);
  assert.deepEqual(await call("snapshot"), snapshot, "compact projection must not mutate persistent or active state");
  await writeFile(path.join(root, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  await stop();
  await start();
  assert.deepEqual(await call("history", { runId: saved.runId }), snapshot);
  // A real failing child must leave diagnostics for both planning stages.
  // This scripted protocol fixture never calls a model.
  const script = path.join(root, "planning-failure.sh");
  await writeFile(script, `cat >/dev/null
if [ "$FAIL_STAGE" = "planner" ] && [ "$GRAPHER_MODE" = "partition" ]; then
  printf '%s' '{"plan_type":"graph"}' > "$GRAPHER_GRAPH_PATH"
  printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Graph route"}]}}'
else
  echo "planning diagnostic: $GRAPHER_MODE" >&2
  exit 7
fi
`);
  for (const stage of ["partition", "planner"]) {
    await stop();
    await start({ FAIL_STAGE: stage });
    const before = new Set(await readdir(path.join(root, "planning")).catch(() => []));
    await assert.rejects(call("plan_goal", {
      goal: "Planning failure regression",
      config: { ...config, engine: "pi", repository: path.join(root, "fixture-repository"), piCommand: "/bin/sh", piArgs: [script] },
    }), /planning diagnostic/);
    const created = (await readdir(path.join(root, "planning"))).filter(id => !before.has(id));
    assert.equal(created.length, 1);
    const log = await readFile(path.join(root, "planning", created[0], `${stage}.jsonl`), "utf8");
    assert.match(log, new RegExp(`planning diagnostic: ${stage}`));
    assert.match(log, /grapher_process_exited/);
    await assert.rejects(call("control", { action: "unknown" }), /Unknown action/, "Failure must release the planning guard");
    assert.equal((await call("snapshot")).runId, saved.runId, "Failed planning must preserve the current graph");
    assert.deepEqual(await call("history", { runId: saved.runId }), snapshot);
    // Verify get_planning retrieves legitimate failed planning summary
    const planSummary = await call("get_planning", { planningId: created[0] });
    assert.equal(planSummary.planningId, created[0]);
    assert.equal(planSummary.status, "failed");
    assert.ok(planSummary.createdAt > 0);

    // V4-1 Security regression: Path traversal attacks must fail with Invalid planning ID
    const trace = await call("get_planning_output", { planningId: created[0], role: stage });
    assert.equal(trace.content, log);
    assert.equal(trace.complete, true);
    assert.equal(trace.nextOffset, Buffer.byteLength(log));
    for (const evilId of ["../../outside", "../planning", "/etc/passwd", "sub/dir", "..", "."]) {
      await assert.rejects(call("get_planning", { planningId: evilId }), /Invalid planning ID/);
      await assert.rejects(call("get_planning_output", { planningId: evilId, role: "planner" }), /Invalid planning ID/);
    }
  }

  const traceDir = path.join(root, "planning", "trace-pagination");
  await mkdir(traceDir);
  const utf8Trace = 'a'.repeat(256 * 1024 - 1) + '规划文字'.repeat(100000) + '\n';
  await writeFile(path.join(traceDir, 'planner.jsonl'), utf8Trace);
  let text = '', offset = 0, pages = 0;
  while (true) {
    const page = await call('get_planning_output', { planningId: 'trace-pagination', role: 'planner', offset });
    assert.ok(Buffer.byteLength(page.content) <= 256 * 1024);
    text += page.content; pages++;
    if (page.complete) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.ok(pages > 1);
  assert.equal(text, utf8Trace, 'UTF-8 pagination must reconstruct the complete trace');
  await assert.rejects(call('get_planning_output', { planningId: 'trace-pagination', role: '../summary' }), /Invalid planning role/);
  await assert.rejects(call('get_planning_output', { planningId: 'trace-pagination', role: 'planner', offset: 256 * 1024 }), /UTF-8 offset/);
  await assert.rejects(call('get_planning_output', { planningId: 'trace-pagination', role: 'planner', offset: -1 }), /Invalid offset/);
  await writeFile(path.join(root, 'outside-trace'), 'outside');
  await symlink(path.join(root, 'outside-trace'), path.join(traceDir, 'partition.jsonl'));
  await assert.rejects(call('get_planning_output', { planningId: 'trace-pagination', role: 'partition' }), /Invalid planning output path/);

  // Verify list_plannings sorting (createdAt desc) and repository filtering
  const allPlannings = await call("list_plannings");
  assert.ok(allPlannings.length >= 2);
  for (let i = 0; i < allPlannings.length - 1; i++) {
    assert.ok((allPlannings[i].createdAt || 0) >= (allPlannings[i + 1].createdAt || 0));
  }
  const filteredPlannings = await call("list_plannings", { repository: path.join(root, "fixture-repository") });
  assert.ok(filteredPlannings.length >= 2);
  assert.ok(filteredPlannings.every(p => p.repository === path.join(root, "fixture-repository")));

  const nonExistentRepoPlannings = await call("list_plannings", { repository: "/nonexistent/repo" });
  assert.equal(nonExistentRepoPlannings.length, 0);

  // V5-1: Test legacy backfilling and fail-closed isolation across workspaces
  const legacyDirUnattributed = path.join(root, "planning", "legacy-unattributed");
  await mkdir(legacyDirUnattributed, { recursive: true });
  await writeFile(path.join(legacyDirUnattributed, "summary.json"), JSON.stringify({
    planningId: "legacy-unattributed",
    totalPlanningDuration: 1.0,
    modelDuration: 1.0,
    roles: {},
    status: "failed",
    error: "Legacy failure without repository",
    createdAt: 1000,
  }, null, 2));

  const workspaceBDir = path.join(root, "planning", "workspace-b-plan");
  await mkdir(workspaceBDir, { recursive: true });
  await writeFile(path.join(workspaceBDir, "summary.json"), JSON.stringify({
    planningId: "workspace-b-plan",
    totalPlanningDuration: 2.0,
    modelDuration: 1.5,
    roles: {},
    status: "failed",
    error: "Workspace B failure",
    createdAt: 2000,
    repository: path.join(root, "workspace-b"),
  }, null, 2));

  // Query Workspace B: must include workspace B plan, but MUST NOT include fixture-repository or unattributed legacy plan
  const wsBPlannings = await call("list_plannings", { repository: path.join(root, "workspace-b") });
  assert.equal(wsBPlannings.length, 1);
  assert.equal(wsBPlannings[0].planningId, "workspace-b-plan");

  // Query fixture-repository: must NOT include workspace-b or unattributed legacy plan
  const fixturePlannings = await call("list_plannings", { repository: path.join(root, "fixture-repository") });
  assert.ok(fixturePlannings.length >= 2);
  assert.ok(fixturePlannings.every(p => p.repository === path.join(root, "fixture-repository")));
  assert.ok(!fixturePlannings.some(p => p.planningId === "legacy-unattributed" || p.planningId === "workspace-b-plan"));

  // Unfiltered list_plannings: must include all plannings, including unattributed legacy
  const allWithLegacy = await call("list_plannings");
  assert.ok(allWithLegacy.some(p => p.planningId === "legacy-unattributed"));
  assert.ok(allWithLegacy.some(p => p.planningId === "workspace-b-plan"));

  await call("delete_run", { runId: saved.runId });
  assert.ok(!(await call("bootstrap")).runs.includes(saved.runId));
  console.log("HTTP integration passed: assets, request validation, compilation, approval, execution, persistence, planning failure diagnostics, deletion, shutdown.");
} finally {
  try { await stop(); } finally {
    if (artifactDir) await writeFile(path.join(root, "backend.log"), logs);
    else await rm(root, { recursive: true, force: true });
  }
}
