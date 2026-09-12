import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";

const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const root = await mkdtemp(path.join(tmpdir(), "grapher-http-"));
const base = `http://127.0.0.1:${port}`;
let backend;
let logs = "";
async function start() {
  backend = spawn(path.resolve("backend/target/debug/grapher"), [], {
    env: { ...process.env, GRAPHER_DATA_DIR: root, GRAPHER_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  backend.stderr.on("data", chunk => { logs += chunk; });
  backend.on("error", error => { logs += error.message; });
  for (let i = 0; i < 100; i++) {
    try { await call("bootstrap"); return; } catch {}
    if (backend.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Backend did not start: ${logs}`);
}
async function stop() {
  if (backend && backend.exitCode === null) {
    const exited = once(backend, "exit");
    backend.kill("SIGTERM");
    await exited;
    assert.equal(backend.exitCode, 0, logs);
  }
}
async function call(command, body = {}) {
  const response = await fetch(`${base}/api/${command}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
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
  await stop();
  await start();
  assert.deepEqual(await call("history", { runId: saved.runId }), snapshot);
  await call("delete_run", { runId: saved.runId });
  assert.ok(!(await call("bootstrap")).runs.includes(saved.runId));
  console.log("HTTP integration passed: assets, request validation, compilation, approval, execution, persistence, deletion, shutdown.");
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
