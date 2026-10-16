// Opt-in paid-provider acceptance: real browser, production Rust, pinned Pi/Git
// and the real nested-agent model. It runs a fresh disposable Git project with
// a parallel branch plus a serial create -> verify -> report environment chain,
// then checks default native discovery/binding from backend receipts, snapshots,
// environment manifests and published report files rather than model prose.
// It also checks host-Python and new-Run isolation.
//
// Example (Windows):
//   GRAPHER_REAL_MODEL_ACCEPTANCE=1 node scripts/real-model-environment-acceptance.mjs
// Optional:
//   GRAPHER_ACCEPTANCE_MODEL=zicc/gpt-6-luna
//   GRAPHER_ACCEPTANCE_MANUAL_GRAPH=1   (skip Planner, still approve/run in the real UI)
//   GRAPHER_ACCEPTANCE_MAX_MS=600000    (whole-flow budget)
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer as netServer } from "node:net";
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert.equal(process.env.GRAPHER_REAL_MODEL_ACCEPTANCE, "1", "Paid acceptance requires GRAPHER_REAL_MODEL_ACCEPTANCE=1");
const model = process.env.GRAPHER_ACCEPTANCE_MODEL || "zicc/gpt-6-luna";
const slash = model.indexOf("/");
assert.ok(slash > 0, "Use provider/model");
const provider = model.slice(0, slash), modelId = model.slice(slash + 1);
const sourceAgent = resolve(process.env.GRAPHER_ACCEPTANCE_AGENT_SOURCE || join(homedir(), ".pi", "agent"));
const dataRoot = await mkdtemp(join(process.env.GRAPHER_ACCEPTANCE_PARENT || tmpdir(), "grapher-real-environment-"));
const repository = join(dataRoot, "env project 中文");
const data = join(dataRoot, "data");
const started = Date.now();
const maxMs = Number(process.env.GRAPHER_ACCEPTANCE_MAX_MS || 600_000);
const evidence = {
  startedAt: new Date(started).toISOString(), platform: process.platform, arch: process.arch, model, root: dataRoot,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: true,
  checks: {}, browserErrors: [], apiErrors: [], controls: [],
};
const sleep = ms => new Promise(completed => setTimeout(completed, ms));
let backend, vite, browser, context, page, runId, state, agent, diagnostics = "";
const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
  "-c", "commit.gpgsign=false", "-c", "user.name=Acceptance", "-c", "user.email=acceptance@localhost", ...args],
  { cwd: repository, encoding: "utf8" }).trim();

function nativePython() {
  if (process.env.GRAPHER_ACCEPTANCE_PYTHON) return process.env.GRAPHER_ACCEPTANCE_PYTHON;
  for (const executable of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    try { return execFileSync(executable, ["-I", "-c", "import sys,venv; print(sys.executable)"], { encoding: "utf8" }).trim(); } catch {}
  }
  throw new Error("A native Python with venv is required; no installation fallback");
}

async function freePort() {
  const server = netServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(completed => server.close(completed));
  return [2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080].includes(port) ? freePort() : port;
}
async function until(check, message, timeout = 90_000) {
  const end = Math.min(Date.now() + timeout, started + maxMs);
  while (Date.now() < end) {
    assert.ok(!backend || backend.exitCode === null, "Backend exited unexpectedly");
    const result = await check(); if (result) return result;
    await sleep(150);
  }
  throw new Error("Timed out: " + message + (diagnostics ? "\n" + diagnostics.slice(-4000) : ""));
}

// A random module name and marker keep the probe provably private to this Run.
const marker = randomBytes(16).toString("hex");
const moduleName = `grapher_probe_${randomBytes(4).toString("hex")}`;
const activate = process.platform === "win32" ? ".venv/Scripts/activate" : ".venv/bin/activate";
const createProbe = [
  "import json,pathlib,sys,sysconfig",
  `m='${marker}'`,
  `n='${moduleName}'`,
  "p=pathlib.Path(sysconfig.get_paths()['purelib'])",
  "f=p/(n+'.py')",
  "f.write_text('MARKER='+repr(m)+chr(10),encoding='utf-8')",
  "r={'marker':m,'module':str(f.resolve()),'prefix':str(pathlib.Path(sys.prefix).resolve()),'python':sys.executable,'name':n}",
  "pathlib.Path('environment-probe.json').write_text(json.dumps(r,sort_keys=True),encoding='utf-8')",
  "print('PROBE_CREATED',json.dumps(r,sort_keys=True))",
].join(";");
const verifyProbe = [
  "import json,pathlib,sys,importlib",
  "r=json.loads(pathlib.Path('environment-probe.json').read_text(encoding='utf-8'))",
  "m=importlib.import_module(r['name'])",
  "assert m.MARKER==r['marker'],'probe marker mismatch'",
  "root=pathlib.Path('.venv').resolve()",
  "assert pathlib.Path(sys.prefix).resolve()==root,(sys.prefix,str(root))",
  "f=pathlib.Path(m.__file__).resolve()",
  "assert root in f.parents,str(f)",
  "pathlib.Path('reports').mkdir(exist_ok=True)",
  "pathlib.Path('reports/verify.json').write_text(json.dumps({'marker':m.MARKER,'module':str(f),'prefix':str(root),'python':sys.executable},sort_keys=True),encoding='utf-8')",
  "print('PROBE_VERIFIED',m.MARKER)",
].join(";");
const reportProbe = verifyProbe.replace("reports/verify.json", "reports/report.json").replace("PROBE_VERIFIED", "PROBE_REPORTED");
const createCommand = `python -m venv --without-pip .venv && source ${activate} && python -c "${createProbe}"`;
const verifyCommand = `python -c "${verifyProbe}"`;
const reportCommand = `python -c "${reportProbe}"`;

const plannedNodes = [
  { name: "left", task: "Execute this exact bash command verbatim: `mkdir -p reports && printf 'left\\n' > reports/left.txt`. Preserve every other file, do not run other tools or installs, then send one nonempty sentence confirming success." },
  { name: "right", task: "Execute this exact bash command verbatim: `mkdir -p reports && printf 'right\\n' > reports/right.txt`. Preserve every other file, do not run other tools or installs, then send one nonempty sentence confirming success." },
  { name: "create", task: `Execute this exact bash command verbatim: \`${createCommand}\`. Do not change or split it, do not activate any other environment, do not install packages and do not run other tools; if it fails, explain the failure instead. Then send one nonempty sentence confirming success.` },
  { name: "verify", task: `Execute this exact bash command verbatim: \`${verifyCommand}\`. Use only that plain python command: do not activate an environment, do not write an interpreter path, do not create other files and do not run other tools; if it fails, explain the failure instead. Then send one nonempty sentence confirming success.` },
  { name: "report", task: `Execute this exact bash command verbatim: \`${reportCommand}\`. Use only that plain python command: do not activate an environment, do not write an interpreter path, do not create other files and do not run other tools; if it fails, explain the failure instead. Then send one nonempty sentence confirming success.` },
];
const plannedEdges = [
  { from: "left", to: "create", feedback: false }, { from: "right", to: "create", feedback: false },
  { from: "create", to: "verify", feedback: false }, { from: "verify", to: "report", feedback: false },
];
const goal = [
  "Plan this tiny Graph; do not implement or run bash in Planner.",
  `Use the node tool exactly once with these five nodes, copying every task string VERBATIM: ${JSON.stringify(plannedNodes)}.`,
  "Then use the edge tool exactly once with exactly these four dependency edges (feedback false): left -> create, right -> create, create -> verify, verify -> report.",
  "left and right must stay independent parallel roots. No other nodes or edges.",
  "After both graph tool calls succeed, your final assistant response MUST be the nonempty sentence: Plan ready.",
].join(" ");

try {
  const hostPython = nativePython();
  evidence.hostPython = hostPython;
  const catalog = JSON.parse(await readFile(join(sourceAgent, "models.json"), "utf8"));
  const definition = catalog.providers?.[provider];
  const selectedModel = definition?.models?.find(item => item.id === modelId);
  assert.ok(selectedModel, `${model} is absent from ${sourceAgent}/models.json`);
  agent = await mkdtemp(join(tmpdir(), "grapher-real-env-auth-"));
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { [provider]: { ...definition, models: [selectedModel] } } }));
  const auth = JSON.parse(await readFile(join(sourceAgent, "auth.json"), "utf8"));
  assert.ok(auth[provider], `${provider} has no configured credentials`);
  await writeFile(join(agent, "auth.json"), JSON.stringify({ [provider]: auth[provider] }));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [] }));
  evidence.endpoint = definition.baseUrl;

  // Fresh standard-Git project with no environment and no probe module.
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, ".gitignore"), ".venv/\n.agent-home/\n.runtime-cache/\n");
  await writeFile(join(repository, "README.md"), "Disposable Graph acceptance for default environment discovery and binding.\n");
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "baseline");
  evidence.baseline = git("rev-parse", "HEAD");
  const hostImport = () => execFileSync(hostPython, ["-I", "-c", `import ${moduleName}`], { cwd: repository, stdio: "pipe" });
  assert.throws(hostImport, "host Python must not provide the private probe before the Run");
  evidence.checks.hostProbeAbsentBeforeRun = true;

  const config = { repository, model, thinkingLevel: "off", maxParallel: 2, maxFeedback: 0, autoApprove: false };
  const port = await freePort();
  vite = await createServer({ cacheDir: join(dataRoot, "vite-cache"), server: { host: "127.0.0.1", port: 0, strictPort: false,
    open: false, proxy: { "/api": { target: `http://127.0.0.1:${port}`, changeOrigin: true } } } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const target = resolve(process.env.CARGO_TARGET_DIR || "backend/target");
  const executable = join(target, "debug", `grapher${process.platform === "win32" ? ".exe" : ""}`);
  assert.ok(existsSync(executable), `Build the production backend first: ${executable}`);
  backend = spawn(executable, [], {
    env: { ...process.env, GRAPHER_DATA_DIR: data, GRAPHER_PORT: String(port), GRAPHER_ALLOWED_ORIGINS: origin,
      GRAPHER_NATIVE_RUNTIME_PARENT: join(dataRoot, "runtime"), GRAPHER_WORKSPACE_PARENT: join(dataRoot, "workspaces"),
      GRAPHER_GLOBAL_PI_AGENT_DIR: join(dataRoot, "global-agent"),
      PI_CODING_AGENT_DIR: agent, GRAPHER_ISOLATED_PI_MODELS: "1", PLANNER_MODEL: model, NODE_AGENT_MODEL: model,
      PARTITIONER_MODEL: model, MERGER_MODEL: model, PLANNER_THINKING: "off", NODE_AGENT_THINKING: "off",
      PARTITIONER_THINKING: "off", MERGER_THINKING: "off" }, stdio: ["ignore", "pipe", "pipe"] });
  backend.stdout.on("data", value => { diagnostics += value.toString(); });
  backend.stderr.on("data", value => { diagnostics += value.toString(); });
  backend.on("error", error => { diagnostics += String(error); });
  const api = async (command, body = {}, timeout = 30_000) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    const payload = await response.json();
    assert.ok(response.ok && !payload.error, `${command}: ${payload.error || response.status}`);
    return payload.result;
  };
  await until(async () => { try { return await api("bootstrap", {}, 5_000); } catch { return false; } }, "backend startup", 30_000);
  await api("save_config", { config });

  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(({ repository, config }) => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Environment acceptance", lastOpened: Date.now() }]));
    localStorage.setItem("grapher_config", JSON.stringify(config));
  }, { repository, config });
  page = await context.newPage(); page.setDefaultTimeout(20_000);
  page.on("pageerror", error => evidence.browserErrors.push(String(error)));
  page.on("request", request => {
    if (request.url().endsWith("/api/control")) {
      const body = request.postDataJSON();
      evidence.controls.push({ at: new Date().toISOString(), action: body.action, node: body.node, runId: body.runId });
    }
  });
  page.on("response", response => {
    if (response.url().includes("/api/") && !response.ok()) evidence.apiErrors.push({ url: new URL(response.url()).pathname, status: response.status() });
  });
  await page.goto(origin, { waitUntil: "networkidle" });

  const manualGraph = process.env.GRAPHER_ACCEPTANCE_MANUAL_GRAPH === "1";
  if (manualGraph) {
    const draft = await api("save_graph", { graph: { originalGoal: goal, nodes: plannedNodes, edges: plannedEdges }, config });
    runId = draft.runId; evidence.runId = runId;
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(`[data-run-id="${runId}"]`).click();
  } else {
    await page.locator(".landing-screen .prompt-box-mode-btn", { hasText: "Graph" }).click();
    const input = page.locator(".landing-screen textarea");
    await input.fill(goal); await input.press("Enter");
    console.log("Planning with", model, "evidence:", dataRoot);
    await until(async () => {
      assert.equal(await page.locator(".error-banner").count(), 0, await page.locator(".error-banner").allTextContents());
      const failed = page.getByText(/Planning failed:/);
      assert.equal(await failed.count(), 0, await failed.allTextContents());
      return page.getByRole("button", { name: "Approve", exact: true }).isVisible();
    }, "Planner approval", 180_000);
    const bootstrap = await api("bootstrap");
    runId = bootstrap.runs.at(-1); assert.ok(runId, "Planner must persist a Run");
    evidence.runId = runId;
  }
  const draft = await api("snapshot", { runId });
  assert.deepEqual(draft.graph.nodes.map(node => node.name).sort(), ["create", "left", "report", "right", "verify"]);
  assert.deepEqual(draft.graph.edges.map(edge => `${edge.from}->${edge.to}`).sort(), ["create->verify", "left->create", "right->create", "verify->report"]);
  assert.equal(draft.environmentPolicy, "automatic-pending", "the client supplies no environment policy");
  const taskOf = name => draft.graph.nodes.find(node => node.name === name).task;
  assert.ok(taskOf("create").includes("venv --without-pip .venv") && taskOf("create").includes(moduleName), "create task copied verbatim");
  assert.ok(taskOf("verify").includes("PROBE_VERIFIED") && taskOf("verify").includes("environment-probe.json"), "verify task copied verbatim");
  assert.ok(taskOf("report").includes("PROBE_REPORTED") && taskOf("report").includes("reports/report.json"), "report task copied verbatim");
  evidence.checks.planner = manualGraph ? "skipped: fixed graph, real UI approval" : true;
  console.log("Graph ready:", draft.graph.nodes.map(node => node.name).join(", "));

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const approval = page.getByRole("dialog", { name: "Approve execution graph" });
  await approval.waitFor();
  await approval.getByRole("button", { name: "Approve and start", exact: true }).click();
  console.log("Approved; executing graph", runId);

  state = await until(async () => {
    const current = await api("snapshot", { runId, detail: "metadata" });
    if (["needs_attention", "publication_failed", "planning_failed"].includes(current.phase)) throw new Error(JSON.stringify(current.nodes) + "\n" + diagnostics.slice(-3000));
    return current.phase === "completed" && current;
  }, "environment graph execution", maxMs);
  assert.equal(state.publication?.status, "completed");
  console.log("Graph completed in", Math.round((Date.now() - started) / 1000), "s");
  state = await api("snapshot", { runId });

  // Snapshot: the frozen policy is lazy discovery with an empty binding.
  assert.equal(state.environmentPolicy, "automatic-lazy");
  assert.equal(state.config.environment.discovery, true);
  assert.equal(state.config.environment.allowDescendant, true);
  assert.equal(state.config.environment.layout, "fixed");
  assert.deepEqual(state.config.environment.authority, {});
  assert.deepEqual(state.config.environment.initialize, []);

  assert.equal(state.executions.length, 5, JSON.stringify(state.executions.map(({ node, status }) => ({ node, status }))));
  const byNode = Object.fromEntries(state.executions.map(execution => [execution.node, execution]));
  for (const node of ["left", "right", "create", "verify", "report"]) {
    assert.equal(byNode[node].status, "completed", `${node} must complete`);
    assert.ok(byNode[node].input && byNode[node].result, `${node} records input/result refs`);
  }
  // Parallel roots overlap; the serial chain waits for both roots.
  assert.notEqual(byNode.left.worktree, byNode.right.worktree, "parallel roots use independent slots");
  const overlap = Math.min(byNode.left.completedAt, byNode.right.completedAt) - Math.max(byNode.left.startedAt, byNode.right.startedAt);
  assert.ok(overlap > 0, "left and right executions must overlap in time");
  assert.ok(byNode.create.startedAt >= Math.max(byNode.left.completedAt, byNode.right.completedAt), "the serial chain waits for both roots");
  evidence.checks.parallel = state.executions.filter(execution => ["left", "right"].includes(execution.node))
    .map(({ node, id, startedAt, completedAt }) => ({ node, id, startedAt, completedAt, overlapMs: overlap }));

  // Launch references: roots and the chain input are unbound; create binds .venv.
  const launch = ref => readFile(join(data, "environments", runId, "launches", `${ref}.json`), "utf8").then(JSON.parse);
  const entryBinding = (execution, phase) => readFile(join(data, "sessions", execution.id, `launch-${execution.id}.json`), "utf8").then(JSON.parse);
  assert.equal((await launch(byNode.left.result.launchRef)).environment, undefined, "ordinary parallel roots stay unbound");
  assert.equal((await launch(byNode.right.result.launchRef)).environment, undefined, "ordinary parallel roots stay unbound");
  assert.equal((await launch(byNode.create.input.launchRef)).environment, undefined, "the chain starts from the unbound baseline");
  const createdLaunch = await launch(byNode.create.result.launchRef);
  assert.equal(createdLaunch.environment.kind, "venv");
  assert.equal(createdLaunch.environment.prefix, ".venv");
  // E/L inheritance across create -> verify -> report without re-creation.
  for (const name of ["verify", "report"]) {
    assert.equal(byNode[name].input.environmentRef, byNode.create.result.environmentRef, `${name} inherits the same E`);
    assert.equal(byNode[name].input.launchRef, byNode.create.result.launchRef, `${name} inherits the same L`);
    assert.equal(byNode[name].result.environmentRef, byNode[name].input.environmentRef, `${name} does not fork E`);
    assert.equal(byNode[name].result.launchRef, byNode[name].input.launchRef, `${name} does not fork L`);
    assert.equal((await entryBinding(byNode[name])).environment.prefix, ".venv", `${name} runs through the Runtime-bound venv entry`);
  }
  evidence.checks.environmentBinding = { environmentRef: byNode.create.result.environmentRef, launchRef: byNode.create.result.launchRef, kind: createdLaunch.environment.kind, prefix: createdLaunch.environment.prefix };

  // Native receipts are actual observed tool invocations, not model text.
  const receipts = async execution => {
    const directory = join(data, "sessions", execution.id, "environment-observations", execution.id);
    const names = await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    return Promise.all(names.filter(name => name.endsWith(".json")).map(name => readFile(join(directory, name), "utf8").then(JSON.parse)));
  };
  const createReceipts = await receipts(byNode.create);
  assert.ok(createReceipts.some(receipt => receipt.created === true && receipt.prefix === ".venv" && receipt.kind === "venv"), "create records the observed venv creation");
  assert.ok(createReceipts.some(receipt => receipt.created === false && receipt.prefix === ".venv"), "create records the observed venv use");
  for (const name of ["verify", "report"]) {
    const observed = await receipts(byNode[name]);
    assert.ok(observed.some(receipt => receipt.created === false && receipt.prefix === ".venv"), `${name} records the inherited venv use`);
    assert.ok(!observed.some(receipt => receipt.created === true), `${name} must not recreate the venv`);
  }
  evidence.checks.receipts = { create: createReceipts.map(({ tool, prefix, kind, created }) => ({ tool, prefix, kind, created })),
    verify: (await receipts(byNode.verify)).map(({ tool, prefix, kind, created }) => ({ tool, prefix, kind, created })),
    report: (await receipts(byNode.report)).map(({ tool, prefix, kind, created }) => ({ tool, prefix, kind, created })) };

  // Published project reports come from real interpreter runs inside the venv.
  const created = JSON.parse(await readFile(join(repository, "environment-probe.json"), "utf8"));
  const verifyReport = JSON.parse(await readFile(join(repository, "reports/verify.json"), "utf8"));
  const finalReport = JSON.parse(await readFile(join(repository, "reports/report.json"), "utf8"));
  assert.equal(created.marker, marker);
  assert.equal(created.name, moduleName);
  for (const item of [created, verifyReport, finalReport]) {
    assert.equal(item.marker, marker, "probe marker must stay consistent");
    assert.ok(item.prefix.endsWith(`${sep}.venv`), `sys.prefix must be the private venv: ${item.prefix}`);
    assert.ok(item.module.includes(".venv"), `module must live in the venv: ${item.module}`);
    assert.ok(String(item.python).includes(".venv"), `python must be the venv interpreter: ${item.python}`);
  }
  assert.equal((await readFile(join(repository, "reports/left.txt"), "utf8")).trim(), "left");
  assert.equal((await readFile(join(repository, "reports/right.txt"), "utf8")).trim(), "right");
  evidence.checks.report = { marker, prefix: finalReport.prefix, module: finalReport.module, python: finalReport.python };

  // Environment scope stays in Runtime storage: absent from source and Git.
  await assert.rejects(stat(join(repository, ".venv")), /ENOENT/, "the private venv is never copied to source");
  const tracked = git("ls-files");
  assert.doesNotMatch(tracked, /(^|\n)\.venv\//, ".venv stays outside published Git");
  assert.ok(/environment-probe\.json/.test(tracked) && /reports\/verify\.json/.test(tracked) && /reports\/report\.json/.test(tracked), "ordinary reports publish");
  assert.equal(git("status", "--porcelain"), "", "publication leaves a clean source tree");
  evidence.checks.storage = { sourceVenvAbsent: true, publishedReports: ["environment-probe.json", "reports/verify.json", "reports/report.json"] };

  // Environment manifest and per-execution records cross-check the inheritance chain.
  const manifest = JSON.parse(await readFile(join(data, "environments", runId, "files", "versions", `${byNode.create.result.environmentRef}.json`), "utf8"));
  assert.ok(Object.keys(manifest.entries).some(name => name.startsWith(".venv/") && name.endsWith(`${moduleName}.py`)), "E snapshot contains the private probe only inside .venv");
  assert.ok(manifest.parents.includes(byNode.create.input.environmentRef), "E snapshot links the unbound input");
  for (const name of ["create", "verify", "report"]) {
    const execution = byNode[name];
    const before = JSON.parse(await readFile(join(data, "environments", runId, "records", `before-${execution.id}.json`), "utf8"));
    const after = JSON.parse(await readFile(join(data, "environments", runId, "records", `after-${execution.id}.json`), "utf8"));
    assert.equal(before.codeRef, execution.before, `${name} before snapshot matches the execution`);
    assert.equal(after.codeRef, execution.after, `${name} after snapshot matches the execution`);
    assert.equal(before.environmentRef, execution.input.environmentRef, `${name} input E matches its record`);
    assert.equal(after.environmentRef, execution.result.environmentRef, `${name} result E matches its record`);
  }
  // Snapshot events agree with the snapshot refs and ordering.
  const inputEvent = id => state.events.find(event => event.type === "execution_input_recorded" && event.execution_id === id)?.input;
  const resultEvent = id => state.events.find(event => event.type === "execution_result_recorded" && event.execution_id === id)?.result;
  const sequence = (type, id) => state.events.find(event => event.type === type && event.execution_id === id)?.sequence;
  const policyEvent = state.events.find(event => event.type === "environment_policy_resolved");
  assert.ok(policyEvent, "EnvironmentPolicyResolved must be recorded");
  assert.equal(policyEvent.environment?.discovery, true);
  for (const name of ["verify", "report"]) {
    assert.equal(resultEvent(byNode.create.id).environmentRef, byNode.create.result.environmentRef, "result event refs match the snapshot");
    assert.equal(inputEvent(byNode[name].id).environmentRef, byNode.create.result.environmentRef, `${name} input event inherits the create E`);
    assert.ok(sequence("finished", byNode.create.id) < sequence("prepared", byNode[name].id), `${name} prepares only after create finished`);
  }
  evidence.checks.inheritance = { createE: byNode.create.result.environmentRef, verifyE: byNode.verify.input.environmentRef, reportE: byNode.report.input.environmentRef,
    manifestEntries: Object.keys(manifest.entries).length, policy: state.environmentPolicy };

  // Real UI shows the completed run and the published result descriptor.
  await until(async () => (await page.locator(".graph-bottom .approval-row").innerText()).includes("Run completed"), "browser completion", 30_000);
  await until(async () => (await page.locator(".graph-bottom details summary").first().innerText()).includes("Launchable result descriptor"), "published result descriptor in UI", 20_000);
  await page.locator(".graph-bottom details summary").first().click();
  const descriptorText = await page.locator(".graph-bottom details").first().innerText();
  assert.ok(descriptorText.includes(byNode.report.result.environmentRef), "UI shows the bound E ref");
  assert.ok(descriptorText.includes(byNode.report.result.launchRef), "UI shows the bound L ref");
  await page.locator('.react-flow__node[data-id="verify"]').click();
  await until(async () => await page.locator(".conversation-heading h2").innerText() === "verify", "verify node conversation");
  await page.screenshot({ path: join(dataRoot, "completed.png"), fullPage: true });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(`[data-run-id="${runId}"]`).click();
  await until(async () => (await page.locator(".graph-bottom .approval-row").innerText()).includes("Run completed"), "durable UI completion after reload", 30_000);
  evidence.checks.ui = true;

  // Negative isolation: a new Run starts unbound and never sees the other Run's E.
  const isolated = await api("save_graph", { graph: { originalGoal: "New Run isolation",
    nodes: [{ name: "plain", task: "Execute this exact bash command verbatim: `test -f README.md && printf 'isolated\\n' > isolated.txt`. Then send one nonempty sentence confirming success." }], edges: [] }, config });
  const isolatedDraft = await api("snapshot", { runId: isolated.runId });
  assert.equal(isolatedDraft.environmentPolicy, "automatic-pending", "a new Run starts from an unbound pending policy");
  await api("control", { runId: isolated.runId, action: "approve" });
  const plain = await until(async () => {
    const current = await api("snapshot", { runId: isolated.runId, detail: "metadata" });
    if (["needs_attention", "publication_failed"].includes(current.phase)) throw new Error(JSON.stringify(current.nodes));
    return current.phase === "completed" && current;
  }, "isolation Run execution", 180_000);
  const plainExecution = plain.executions.at(-1);
  assert.equal((await launch(plainExecution.input.launchRef)).environment, undefined, "a new Run is unbound at start");
  assert.equal((await launch(plainExecution.result.launchRef)).environment, undefined, "an isolated no-op Run never adopts another Run environment");
  assert.notEqual(plainExecution.input.environmentRef, byNode.create.result.environmentRef);
  const isolatedManifest = JSON.parse(await readFile(join(data, "environments", isolated.runId, "files", "versions", `${plainExecution.result.environmentRef}.json`), "utf8"));
  assert.ok(!Object.keys(isolatedManifest.entries).some(name => name.startsWith(".venv/")), "a new Run does not see the previous environment");
  assert.equal((await readFile(join(repository, "isolated.txt"), "utf8")).trim(), "isolated");
  assert.throws(hostImport, "host Python never provides the private probe");
  evidence.checks.newRunIsolation = { runId: isolated.runId, inputLaunchUnbound: true, resultLaunchUnbound: true, manifestVenvEntries: 0 };
  evidence.checks.hostProbeAbsentAfterRun = true;

  // Actual Pi assistant metadata proves the requested real model served every turn.
  const models = new Set();
  for (const file of await readdir(join(dataRoot, "data"), { recursive: true })) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of (await readFile(join(dataRoot, "data", file), "utf8")).split(/\r?\n/)) {
      if (!line) continue;
      const entry = JSON.parse(line); const message = entry.message || entry.assistantMessage;
      if (message?.role === "assistant" && message.model && message.provider) models.add(`${message.provider}/${message.model}`);
    }
  }
  assert.deepEqual([...models], [model], "Every observed assistant turn must use the requested real model");
  evidence.checks.actualModels = [...models];
  assert.deepEqual(evidence.browserErrors, []); assert.deepEqual(evidence.apiErrors, []);
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed"; evidence.error = String(error.stack || error); process.exitCode = 1;
  console.error(evidence.error);
  if (page) await page.screenshot({ path: join(dataRoot, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  await context?.close(); await browser?.close(); await vite?.close();
  if (backend && backend.exitCode === null && backend.pid) {
    // Only terminate the isolated service created by this harness, never a user service.
    const exited = once(backend, "exit");
    if (process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(backend.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
    else backend.kill("SIGTERM");
    await Promise.race([exited, sleep(10_000)]);
  }
  if (agent && (!backend || backend.exitCode !== null || backend.signalCode !== null)) await rm(agent, { recursive: true, force: true }).catch(() => {});
  evidence.durationMs = Date.now() - started;
  if (state) await writeFile(join(dataRoot, "snapshot.json"), JSON.stringify(state, null, 2));
  await writeFile(join(dataRoot, "backend.log"), diagnostics);
  await writeFile(join(dataRoot, "report.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, durationMs: evidence.durationMs, evidence: dataRoot, checks: evidence.checks }, null, 2));
}
