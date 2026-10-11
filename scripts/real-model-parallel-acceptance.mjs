// Opt-in paid-provider acceptance: real browser, production Rust, pinned Pi/Git.
// Leaves disposable project/data/evidence intact; never touches user runtime data.
// Example (Windows): GRAPHER_REAL_MODEL_ACCEPTANCE=1 CARGO_TARGET_DIR=C:/tmp/grapher-env-control-target node scripts/real-model-parallel-acceptance.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as netServer } from "node:net";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert.equal(process.env.GRAPHER_REAL_MODEL_ACCEPTANCE, "1", "Paid acceptance requires GRAPHER_REAL_MODEL_ACCEPTANCE=1");
const model = process.env.GRAPHER_ACCEPTANCE_MODEL || "zicc/gpt-6-luna";
const slash = model.indexOf("/");
assert.ok(slash > 0, "Use provider/model");
const provider = model.slice(0, slash), modelId = model.slice(slash + 1);
const sourceAgent = resolve(process.env.GRAPHER_ACCEPTANCE_AGENT_SOURCE || join(homedir(), ".pi", "agent"));
const resume = process.env.GRAPHER_ACCEPTANCE_RESUME_DIR;
const dataRoot = resume ? resolve(resume) : await mkdtemp(join(process.env.GRAPHER_ACCEPTANCE_PARENT || tmpdir(), "grapher-real-parallel-"));
const previousReport = resume ? JSON.parse(await readFile(join(dataRoot, "report.json"), "utf8")) : null;
if (resume) {
  assert.equal(previousReport.status, "failed", "Recovery requires a failed harness-owned acceptance");
  assert.equal(previousReport.model, model);
  assert.equal(resolve(previousReport.root), dataRoot);
  assert.ok(previousReport.runId && previousReport.checks.planner);
}
const root = resume ? await mkdtemp(join(dataRoot, "retry-")) : dataRoot;
// Credentials are separate from retained evidence and deleted after our backend exits.
const agent = await mkdtemp(join(tmpdir(), "grapher-real-auth-"));
const repository = join(dataRoot, "parallel project 中文");
const started = Date.now();
const evidence = { startedAt: new Date(started).toISOString(), platform: process.platform, model, root,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: true,
  dataRoot, recoveryFrom: resume ? join(dataRoot, "report.json") : undefined,
  checks: {}, browserErrors: [], apiErrors: [], controls: [], activity: [], pollLatencyMs: [] };
const sleep = ms => new Promise(done => setTimeout(done, ms));
let backend, vite, browser, context, page, runId, state;
let previousMergerCount = 0;
let diagnostics = "";
const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
  "-c", "commit.gpgsign=false", "-c", "user.name=Acceptance", "-c", "user.email=acceptance@localhost", ...args],
  { cwd: repository, encoding: "utf8" }).trim();
async function freePort() {
  const server = netServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(done => server.close(done));
  return [2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080].includes(port) ? freePort() : port;
}
async function until(check, message, timeout = 90_000) {
  const end = Math.min(Date.now() + timeout, started + 240_000);
  while (Date.now() < end) {
    assert.ok(!backend || backend.exitCode === null, "Backend exited unexpectedly");
    const result = await check(); if (result) return result;
    await sleep(150);
  }
  throw new Error("Timed out: " + message);
}
try {
  const catalog = JSON.parse(await readFile(join(sourceAgent, "models.json"), "utf8"));
  const definition = catalog.providers?.[provider];
  const selectedModel = definition?.models?.find(item => item.id === modelId);
  assert.ok(selectedModel, `${model} is absent from ${sourceAgent}/models.json`);
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { [provider]: { ...definition, models: [selectedModel] } } }));
  const auth = JSON.parse(await readFile(join(sourceAgent, "auth.json"), "utf8"));
  await writeFile(join(agent, "auth.json"), JSON.stringify(auth[provider] ? { [provider]: auth[provider] } : {}));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [] }));
  evidence.endpoint = definition.baseUrl;
  if (!resume) {
    await mkdir(join(repository, "artifacts"), { recursive: true });
    await writeFile(join(repository, ".gitignore"), "artifacts/\n");
    await writeFile(join(repository, "README.md"), "Disposable parallel Graph acceptance. No dependencies.\n");
    await writeFile(join(repository, "artifacts", "seed.txt"), "SEED\n");
    await writeFile(join(repository, "remove-left.txt"), "delete in left\n");
    await writeFile(join(repository, "remove-right.txt"), "delete in right\n");
    git("init", "-q"); git("add", ".gitignore", "README.md", "remove-left.txt", "remove-right.txt"); git("commit", "-qm", "base");
  }
  const config = { repository, model, thinkingLevel: "off", maxParallel: 2, maxFeedback: 0, autoApprove: false };
  const port = await freePort();
  vite = await createServer({ cacheDir: join(root, "vite-cache"), server: { host: "127.0.0.1", port: 0, strictPort: false,
    open: false, proxy: { "/api": { target: `http://127.0.0.1:${port}`, changeOrigin: true } } } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const target = resolve(process.env.CARGO_TARGET_DIR || "backend/target");
  backend = spawn(join(target, "debug", `grapher${process.platform === "win32" ? ".exe" : ""}`), [], {
    env: { ...process.env, GRAPHER_DATA_DIR: join(dataRoot, "data"), GRAPHER_PORT: String(port), GRAPHER_ALLOWED_ORIGINS: origin,
      GRAPHER_NATIVE_RUNTIME_PARENT: join(root, "runtime"), GRAPHER_WORKSPACE_PARENT: join(root, "workspaces"),
      PI_CODING_AGENT_DIR: agent, GRAPHER_ISOLATED_PI_MODELS: "1", PLANNER_MODEL: model, NODE_AGENT_MODEL: model,
      PARTITIONER_MODEL: model, MERGER_MODEL: model, PLANNER_THINKING: "off", NODE_AGENT_THINKING: "off",
      PARTITIONER_THINKING: "off", MERGER_THINKING: "off" }, stdio: ["ignore", "pipe", "pipe"] });
  backend.stdout.on("data", value => { diagnostics += value.toString(); });
  backend.stderr.on("data", value => { diagnostics += value.toString(); });
  backend.on("error", error => { diagnostics += String(error); });
  const api = async (command, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const payload = await response.json();
    assert.ok(response.ok && !payload.error, `${command}: ${payload.error || response.status}`);
    return payload.result;
  };
  await until(async () => { try { return await api("bootstrap"); } catch { return false; } }, "backend startup", 30_000);
  await api("save_config", { config });
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(({ repository, config }) => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Real parallel acceptance", lastOpened: Date.now() }]));
    localStorage.setItem("grapher_config", JSON.stringify(config));
  }, { repository, config });
  page = await context.newPage(); page.setDefaultTimeout(20_000);
  page.on("pageerror", error => evidence.browserErrors.push(String(error)));
  page.on("request", request => {
    if (request.url().endsWith("/api/control")) {
      const body = request.postDataJSON(); evidence.controls.push({ action: body.action, node: body.node, executionId: body.executionId, instruction: body.instruction });
    }
  });
  page.on("response", response => {
    if (response.url().includes("/api/") && !response.ok()) evidence.apiErrors.push({ url: new URL(response.url()).pathname, status: response.status() });
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  if (resume) {
    runId = previousReport.runId;
    state = await api("snapshot", { runId });
    assert.equal(state.phase, "publication_failed", "Only publication recovery is supported");
    previousMergerCount = state.mergers?.length ?? 0;
    evidence.runId = runId; evidence.checks.planner = true; evidence.checks.publicationRecovery = true;
    await page.locator(`[data-run-id="${runId}"]`).click();
    await page.getByRole("button", { name: "Retry publication", exact: true }).click();
    console.log("Retrying publication with", model, "evidence:", root);
  } else {
    await page.locator(".landing-screen .prompt-box-mode-btn", { hasText: "Graph" }).click();
    const plannedNodes = ["left", "right"].map(name => ({ name, task:
      `Execute this exact bash command verbatim: \`test "$(tr -d '\\r' < artifacts/seed.txt)" = SEED && sleep 2 && printf '${name.toUpperCase()}\\n' > ${name}.txt && printf '${name.toUpperCase()}\\n' > artifacts/shared.txt && rm -f remove-${name}.txt\`. Preserve every other file, including .gitignore and artifacts/seed.txt. Do not run other tools or installs. Then send one nonempty sentence confirming success; if the command fails, explain the failure instead.` }));
    const goal = `Plan a tiny parallel acceptance. Do not implement or run bash in Planner. Make exactly these TWO independent nodes with one node tool call; copy their task strings VERBATIM, no edges or other nodes: ${JSON.stringify(plannedNodes)}. Both nodes write different versions of artifacts/shared.txt intentionally. Publication Merger must preserve LEFT then RIGHT lines, both branch output files and both deletions; use one short bash command to resolve that path and git add -f -- artifacts/shared.txt, verify no unresolved conflicts, and send one nonempty sentence. No broad inspection or installs. After the node tool succeeds, your final assistant response MUST be the nonempty plain-text sentence: Plan ready.`;
    const input = page.locator(".landing-screen textarea"); await input.fill(goal); await input.press("Enter");
    console.log("Planning with", model, "evidence:", root);
    await until(async () => {
      assert.equal(await page.locator(".error-banner").count(), 0, await page.locator(".error-banner").allTextContents());
      const failed = page.getByText(/Planning failed:/);
      assert.equal(await failed.count(), 0, await failed.allTextContents());
      return page.getByRole("button", { name: "Approve", exact: true }).isVisible();
    }, "Planner approval", 100_000);
    const bootstrap = await api("bootstrap");
    runId = bootstrap.runs.at(-1); assert.ok(runId, "Planner must persist a Run");
    state = await api("snapshot", { runId });
    assert.equal(state.phase, "awaiting_approval");
    assert.deepEqual(state.graph.nodes.map(node => node.name).sort(), ["left", "right"]);
    assert.equal(state.graph.edges.length, 0); evidence.runId = runId; evidence.checks.planner = true;
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    const approval = page.getByRole("dialog", { name: "Approve execution graph" });
    await approval.waitFor(); assert.match(await approval.innerText(), /force-stages.*\.gitignore/s);
    await approval.getByRole("button", { name: "Approve and start", exact: true }).click();
    console.log("Approved two parallel nodes");
  }
  await until(async () => {
    const time = Date.now();
    const result = await api("snapshot_if_changed", { runId, version: null });
    evidence.pollLatencyMs.push(Date.now() - time);
    if (result.activity?.length) evidence.activity.push(result.activity);
    if (result.snapshot) state = result.snapshot;
    assert.ok(!["needs_attention", "publication_failed", "planning_failed"].includes(state.phase), JSON.stringify(state.nodes));
    assert.ok(state.phase !== "completed" || state.mergers?.some(item => item.node === "merger"), "Task completed without the expected conflict; inspect node tool failures and outputs");
    return (state.mergers ?? []).slice(previousMergerCount).some(item => item.node === "merger");
  }, "publication conflict and Merger", 100_000);
  const card = page.locator('.react-flow__node[data-id="merger:publication"]'); await card.waitFor();
  // A retry can launch before the next UI poll replaces the previous failed card.
  // Select the new attempt only once its actual snapshot has reached the browser.
  await until(async () => !(await card.innerText()).includes("FAILED"), "latest Merger attempt reaches the topology");
  await card.click();
  await until(async () => await page.locator(".conversation-heading h2").innerText() === "publication merger", "Merger conversation");
  const composer = page.locator(".initial-query-view textarea"); await composer.waitFor();
  state = await api("snapshot", { runId });
  const current = state.mergers.filter(item => item.node === "merger").at(-1);
  if (current.status === "running") {
    await until(async () => !await composer.isDisabled() && /Steer the merger/.test(await composer.getAttribute("placeholder")), "live Merger composer");
    await composer.fill("For this tiny conflict, use one short bash command to write LEFT then RIGHT lines in artifacts/shared.txt and git add -f -- artifacts/shared.txt. Preserve all other branch changes, verify no unresolved conflicts, and respond with one nonempty sentence.");
    await composer.press("Enter");
    await until(() => evidence.controls.some(item => item.action === "steer" && item.executionId === current.id), "browser Merger steer request");
    evidence.checks.liveMergerSteer = true;
  } else evidence.checks.liveMergerSteer = "missed: merger already settled";
  await until(async () => { state = await api("snapshot", { runId });
    assert.notEqual(state.phase, "publication_failed", state.publication?.error);
    return state.phase === "completed" && state.publication?.status === "completed";
  }, "successful Git publication", 90_000);
  const executions = state.executions.filter(item => ["left", "right"].includes(item.node));
  assert.equal(executions.length, 2); assert.ok(executions.every(item => item.status === "completed"));
  assert.ok(Math.max(...executions.map(item => item.startedAt)) < Math.min(...executions.map(item => item.completedAt)), "Executions must overlap");
  evidence.checks.parallel = executions.map(({ node, id, startedAt, completedAt }) => ({ node, id, startedAt, completedAt }));
  for (const [file, expected] of [["left.txt", "LEFT"], ["right.txt", "RIGHT"], ["artifacts/seed.txt", "SEED"]]) assert.equal((await readFile(join(repository, file), "utf8")).trim(), expected);
  assert.equal((await readFile(join(repository, "artifacts/shared.txt"), "utf8")).replaceAll("\r\n", "\n"), "LEFT\nRIGHT\n");
  assert.ok(!git("ls-files").includes("remove-left.txt") && !git("ls-files").includes("remove-right.txt"));
  assert.equal(git("status", "--porcelain"), "");
  assert.ok(git("ls-files").includes("artifacts/shared.txt")); evidence.checks.ignoredFilesAndDeletionsPublished = true;
  // Poll durable completion into the UI without injecting or mocking a snapshot.
  await until(async () => (await card.innerText()).includes("DONE"), "settled Merger card");
  await until(async () => /Append a message/.test(await composer.getAttribute("placeholder")), "settled Merger composer");
  assert.equal(await composer.isDisabled(), false);
  const followupMergerCount = state.mergers.filter(item => item.node === "merger").length;
  await composer.fill("Write followup.txt containing FOLLOWUP plus newline, using a short bash command. Stage and commit that file, leave the repository clean, preserve existing outputs. Finish with one sentence.");
  await composer.press("Enter");
  await until(async () => {
    state = await api("snapshot", { runId });
    const mergers = state.mergers.filter(item => item.node === "merger");
    assert.notEqual(mergers.at(-1).status, "failed", "Merger continuation failed");
    return mergers.length === followupMergerCount + 1 && mergers.at(-1).status === "completed";
  }, "publication Merger follow-up", 60_000);
  assert.ok(evidence.controls.some(item => item.action === "continue_merger" && item.node === "merger"));
  assert.equal((await readFile(join(repository, "followup.txt"), "utf8")).trim(), "FOLLOWUP");
  assert.equal(git("status", "--porcelain"), ""); evidence.checks.mergerContinuation = true;
  await until(async () => (await card.innerText()).includes("DONE") &&
    /Append a message/.test(await composer.getAttribute("placeholder")), "live continuation terminal status without reload");
  evidence.checks.liveContinuationSettled = true;
  await page.screenshot({ path: join(root, "merger-followup.png"), fullPage: true });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(`[data-run-id="${runId}"]`).click();
  await page.locator('.react-flow__node[data-id="merger:publication"]').click();
  await until(async () => (await page.locator(".initial-query-view").innerText()).includes("followup.txt") &&
    await page.locator('.react-flow__node[data-id="merger:publication"]').isVisible() &&
    await page.locator(".graph-canvas .react-flow").evaluate(element => getComputedStyle(element).opacity === "1"), "durable Merger transcript and graph after reload");
  evidence.checks.reload = true;
  await page.screenshot({ path: join(root, "reloaded.png"), fullPage: true });
  // Verify actual Pi assistant metadata, not merely the requested config.
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
  if (page) await page.screenshot({ path: join(root, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  await context?.close(); await browser?.close(); await vite?.close();
  if (backend && backend.exitCode === null && backend.pid) {
    // Only terminate the isolated service created by this harness, never a user service.
    const exited = once(backend, "exit");
    if (process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(backend.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
    else backend.kill("SIGTERM");
    await Promise.race([exited, sleep(10_000)]);
  }
  if (!backend || backend.exitCode !== null || backend.signalCode !== null) await rm(agent, { recursive: true, force: true });
  evidence.durationMs = Date.now() - started;
  if (state) await writeFile(join(root, "snapshot.json"), JSON.stringify(state, null, 2));
  await writeFile(join(root, "backend.log"), diagnostics);
  await writeFile(join(root, "report.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, durationMs: evidence.durationMs, evidence: root, checks: evidence.checks }, null, 2));
}
