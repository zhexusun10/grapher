// Real HTTP driver + scripted Execution Instance process; no model/API calls.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

const root = await mkdtemp(path.join(tmpdir(), "grapher-publication-"));
const binary = path.resolve("backend/target/debug/grapher");
const listen = net.createServer();
await new Promise(resolve => listen.listen(0, "127.0.0.1", resolve));
const port = listen.address().port;
await new Promise(resolve => listen.close(resolve));
const url = `http://127.0.0.1:${port}/api/`;
let child;
let logs = "";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(command, body = {}) {
  const response = await fetch(url + command, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data.result;
}
async function start(dataRoot) {
  child = spawn(binary, [], { env: { ...process.env, GRAPHER_DATA_DIR: dataRoot, GRAPHER_PORT: String(port), ALLOW_MERGER: path.join(root, "allow-merger") }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", text => { logs += text; });
  for (let i = 0; i < 100; i++) {
    try { await call("bootstrap"); return; } catch { await delay(40); }
  }
  throw new Error(`Backend did not start: ${logs}`);
}
async function stop() {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
}
async function settled(phase) {
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const state = await call("snapshot");
    seen.add(state.phase);
    if (state.phase === phase) return { state, seen };
    await delay(30);
  }
  throw new Error(`Did not reach ${phase}: ${logs}`);
}
try {
  const script = path.join(root, "engine.sh");
  await writeFile(script, `set -eu
query=$(cat)
if git rev-parse --verify MERGE_HEAD >/dev/null 2>&1; then
  echo 'merger is resolving' >&2
  sleep 0.3
  if [ ! -e "$ALLOW_MERGER" ]; then exit 9; fi
  printf 'left\\nright\\n' > shared.txt
  git add shared.txt
else
  case "$query" in
    *left*) printf 'left\\n' > shared.txt; printf 'left' > left.txt ;;
    *right*) printf 'right\\n' > shared.txt; printf 'right' > right.txt ;;
    *) exit 7 ;;
  esac
fi
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"done"}]}}'
`);
  for (const standard of [false, true]) {
    const directory = path.join(root, standard ? "git-project" : "plain-project");
    const dataRoot = path.join(root, standard ? "git-runtime" : "plain-runtime");
    await mkdir(directory);
    await writeFile(path.join(directory, "shared.txt"), "original\n");
    if (standard) {
      execFileSync("git", ["init", directory]);
      execFileSync("git", ["-C", directory, "add", "."]);
      execFileSync("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@local", "-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
    }
    await rm(path.join(root, "allow-merger"), { force: true });
    await start(dataRoot);
    const boot = await call("bootstrap");
    const graph = { originalGoal: "Combine left and right", nodes: [{ name: "left", task: "left" }, { name: "right", task: "right" }], edges: [] };
    await call("save_graph", { graph, config: { ...boot.config, repository: directory, engine: "pi", piCommand: "/bin/sh", piArgs: [script] } });
    await call("control", { action: "approve" });
    const { state: failed, seen } = await settled("publication_failed");
    assert.ok(seen.has("merging"));
    assert.ok(!seen.has("completed"), "UI must not see completed before publication");
    assert.equal(failed.publication.status, "failed");
    assert.ok(failed.publication.error);
    assert.equal(failed.mergers.length, 1);
    assert.equal(failed.mergers[0].status, "failed");
    assert.match(failed.mergers[0].output, /merger is resolving/);
    assert.ok(failed.executions.every(e => e.status === "completed"));
    await assert.rejects(call("control", { action: "resume" }), /Publication/);
    await stop();
    await start(dataRoot);
    assert.equal((await call("snapshot")).phase, "publication_failed");
    await writeFile(path.join(root, "allow-merger"), "yes");
    await call("control", { action: "retry_publication" });
    const { state: complete } = await settled("completed");
    assert.equal(complete.publication.status, "completed");
    assert.ok(complete.publication.head);
    assert.ok(complete.publication.completedAt);
    assert.equal(complete.executions.length, 2, "Do not re-execute graph nodes on publication retry");
    assert.equal(complete.mergers.length, 2);
    assert.equal(complete.mergers[1].status, "completed");
    assert.equal(await readFile(path.join(directory, "shared.txt"), "utf8"), "left\nright\n");
    assert.equal(await readFile(path.join(directory, "left.txt"), "utf8"), "left");
    assert.equal(await readFile(path.join(directory, "right.txt"), "utf8"), "right");
    if (!standard) await assert.rejects(access(path.join(directory, ".git")));
    const kinds = complete.events.map(e => e.type);
    assert.ok(kinds.indexOf("publication_started") < kinds.indexOf("merger_started"));
    assert.ok(kinds.lastIndexOf("merger_finished") < kinds.indexOf("publication_completed"));
    await stop();
    await start(dataRoot);
    assert.deepEqual(await call("snapshot"), complete, "Completed result and merger history must survive restart");
    await stop();
  }
  console.log("Publication HTTP passed: Git + plain folder, visible merger output, failed/retry lifecycle, restart, no premature completion, no .git pollution.");
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
