import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, appendFile } from "node:fs/promises";
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
  }
  await call("delete_run", { runId: saved.runId });
  assert.ok(!(await call("bootstrap")).runs.includes(saved.runId));
  console.log("HTTP integration passed: assets, request validation, compilation, approval, execution, persistence, planning failure diagnostics, deletion, shutdown.");
} finally {
  try { await stop(); } finally {
    if (artifactDir) await writeFile(path.join(root, "backend.log"), logs);
    else await rm(root, { recursive: true, force: true });
  }
}
