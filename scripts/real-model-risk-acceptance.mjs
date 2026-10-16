// Paid, opt-in browser acceptance. Uses only disposable projects/data and the
// pinned production engine; no mocked API/model and no existing service stopped.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer as netServer } from "node:net";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

assert.equal(process.env.GRAPHER_REAL_MODEL_ACCEPTANCE, "1", "Paid acceptance requires GRAPHER_REAL_MODEL_ACCEPTANCE=1");
const model = process.env.GRAPHER_ACCEPTANCE_MODEL || "zicc/gpt-6-luna";
const slash = model.indexOf("/"); assert.ok(slash > 0, "Use provider/model");
const provider = model.slice(0, slash), modelId = model.slice(slash + 1);
const sourceAgent = resolve(process.env.GRAPHER_ACCEPTANCE_AGENT_SOURCE || join(homedir(), ".pi", "agent"));
const resume = process.env.GRAPHER_ACCEPTANCE_RESUME_DIR;
const dataRoot = resume ? resolve(resume) : await mkdtemp(join(process.env.GRAPHER_ACCEPTANCE_PARENT || tmpdir(), "grapher-real-risks-"));
const previousReport = resume ? JSON.parse(await readFile(join(dataRoot, "report.json"), "utf8")) : null;
if (resume) {
  assert.equal(previousReport.status, "failed"); assert.equal(previousReport.model, model);
  assert.equal(resolve(previousReport.root), dataRoot);
  assert.ok(previousReport.runId && previousReport.otherRunId && previousReport.checks.sourceEditPreserved && previousReport.checks.privateComposition,
    "Resume only a harness-owned completed graph whose remaining continuation checks failed");
}
const root = resume ? await mkdtemp(join(dataRoot, "retry-")) : dataRoot;
const agent = await mkdtemp(join(tmpdir(), "grapher-real-auth-"));
const repository = join(dataRoot, "parallel project 中文");
const started = Date.now();
const evidence = { startedAt: new Date(started).toISOString(), platform: process.platform, model, root,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: true,
  dataRoot, recoveryFrom: resume ? join(dataRoot, "report.json") : undefined,
  checks: { ...previousReport?.checks }, browserErrors: [], apiErrors: [], controls: [] };
const sleep = ms => new Promise(completed => setTimeout(completed, ms));
let backend, vite, browser, context, page, runId, state, diagnostics = "";
const gitAt = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
  "-c", "commit.gpgsign=false", "-c", "user.name=Acceptance", "-c", "user.email=acceptance@localhost", ...args],
  { cwd, encoding: "utf8" }).trim();
const git = (...args) => gitAt(repository, ...args);
const text = async file => (await readFile(join(repository, file), "utf8")).replaceAll("\r\n", "\n").trim();
async function freePort() {
  const server = netServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(completed => server.close(completed));
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
  assert.ok(selectedModel, `${model} is absent from the configured catalog`);
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { [provider]: { ...definition, models: [selectedModel] } } }));
  const auth = JSON.parse(await readFile(join(sourceAgent, "auth.json"), "utf8"));
  await writeFile(join(agent, "auth.json"), JSON.stringify(auth[provider] ? { [provider]: auth[provider] } : {}));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [] }));
  evidence.endpoint = definition.baseUrl;
  if (!resume) {
  await mkdir(join(repository, "artifacts"), { recursive: true });
  for (const [file, content] of [[".gitignore", "artifacts/\n"], ["README.md", "Disposable acceptance; no dependencies.\n"],
    ["artifacts/shared.txt", "BASE\n"], ["remove-left.txt", "delete left\n"], ["remove-right.txt", "delete right\n"]]) {
    await writeFile(join(repository, file), content);
  }
  git("init", "-q"); git("add", "-f", "."); git("commit", "-qm", "base");
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
      GRAPHER_NATIVE_RUNTIME_PARENT: join(dataRoot, "runtime"), GRAPHER_WORKSPACE_PARENT: join(dataRoot, "workspaces"),
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
  // A second real persisted Run for navigation checks, without another paid task.
  const other = resume ? { runId: previousReport.otherRunId } : await api("save_graph", { graph: { originalGoal: "Navigation-only draft", nodes: [{ name: "draft", task: "Do not execute" }], edges: [] }, config });
  evidence.otherRunId = other.runId;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(({ repository, config }) => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Risk acceptance", lastOpened: Date.now() }]));
    localStorage.setItem("grapher_config", JSON.stringify(config));
  }, { repository, config });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on("pageerror", error => evidence.browserErrors.push(String(error)));
  page.on("request", request => {
    if (request.url().endsWith("/api/control")) {
      const body = request.postDataJSON(); evidence.controls.push({ at: new Date().toISOString(), action: body.action, node: body.node,
        executionId: body.executionId, instruction: body.instruction, images: body.images?.map(image => ({ name: image.name, mimeType: image.mimeType })) });
    }
  });
  page.on("response", async response => {
    if (response.url().includes("/api/") && !response.ok()) evidence.apiErrors.push({ url: new URL(response.url()).pathname, status: response.status(), body: await response.text().catch(() => "") });
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  if (resume) {
    runId = previousReport.runId; evidence.runId = runId;
    state = await api("snapshot", { runId });
    assert.equal(state.phase, "completed", "Continuation recovery must not rerun the graph");
    await page.locator(`[data-run-id="${runId}"]`).click();
    evidence.checks.continuationRecovery = true;
  } else {
  const plannedNodes = ["left", "right"].map(name => ({ name, task:
    `First execute this bash command verbatim: \`sleep 25 && printf '${name.toUpperCase()}\\n' > ${name}.txt && printf '${name.toUpperCase()}\\n' > artifacts/shared.txt && rm -f remove-${name}.txt\`. Preserve every other file. Honor any attached steering messages after this tool call. No installs or broad inspection. Finish with a nonempty sentence.` }));
  plannedNodes.push({ name: "joined", task: "If this task is background for a conflict-repair Merger: do NOT run the verification task. Resolve artifacts/shared.txt to exactly LEFT then RIGHT lines using `printf 'LEFT\\nRIGHT\\n' > artifacts/shared.txt && git add -f -- artifacts/shared.txt && test -z \"$(git diff --name-only --diff-filter=U)\"`. Preserve other changes; reply with a nonempty sentence. For the actual joined node (not a Merger): execute exactly this bash command: `test \"$(tr -d '\\r' < artifacts/shared.txt)\" = \"$(printf 'LEFT\\nRIGHT')\" && test -f left.txt && test -f right.txt && cp artifacts/shared.txt downstream.txt && sleep 3`. This verifies you inherited the private parent merge before running. Preserve every other file; no installs. Finish with a nonempty sentence." });
  const mergerRule = "Conflict repair rule: in a private node workspace resolve artifacts/shared.txt to exactly LEFT then RIGHT lines. In the source publication workspace preserve the concurrent USER line, followed by LEFT then RIGHT. Stage that path with git add -f -- artifacts/shared.txt, preserve other branch changes/deletions, verify no unresolved conflicts, and finish with a nonempty sentence. Never run the graph tasks in a Merger.";
  const goal = `Plan only; do not implement or run bash. Make exactly these three nodes, copying tasks VERBATIM: ${JSON.stringify(plannedNodes)}. Exactly two ordinary edges: left -> joined and right -> joined; no feedback. left and right must be parallel. ${mergerRule} After the graph tools succeed, respond with the nonempty sentence: Plan ready.`;
  const manualGraph = process.env.GRAPHER_ACCEPTANCE_MANUAL_GRAPH === "1";
  if (manualGraph) {
    const draft = await api("save_graph", { graph: { originalGoal: `Tiny parallel file task with a downstream verifier. ${mergerRule} For the publication conflict use one Bash command: printf 'USER\\nLEFT\\nRIGHT\\n' > artifacts/shared.txt && git add -f -- artifacts/shared.txt && test -z "$(git diff --name-only --diff-filter=U)". No installs or broad inspection.`, nodes: plannedNodes,
      edges: [{ from: "left", to: "joined", feedback: false }, { from: "right", to: "joined", feedback: false }] }, config });
    runId = draft.runId;
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(`[data-run-id="${runId}"]`).click();
  } else {
    await page.locator(".landing-screen .prompt-box-mode-btn", { hasText: "Graph" }).click();
    await page.locator(".landing-screen textarea").fill(goal); await page.locator(".landing-screen textarea").press("Enter");
    await until(() => page.getByRole("button", { name: "Approve", exact: true }).isVisible(), "Planner approval", 70_000);
    const bootstrap = await api("bootstrap"); runId = bootstrap.runs.find(id => id !== other.runId);
  }
  console.log(manualGraph ? "Fixed graph" : "Planned graph", model, "evidence:", root);
  assert.ok(runId); evidence.runId = runId;
  state = await api("snapshot", { runId });
  assert.deepEqual(state.graph.nodes.map(node => node.name).sort(), ["joined", "left", "right"]);
  assert.deepEqual(state.graph.edges.map(edge => `${edge.from}->${edge.to}`).sort(), ["left->joined", "right->joined"]);
  evidence.checks.planner = manualGraph ? "skipped: fixed graph, real UI approval" : true;
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("dialog", { name: "Approve execution graph" }).getByRole("button", { name: "Approve and start", exact: true }).click();
  }
  const refresh = async () => {
    state = await api("snapshot", { runId });
    assert.ok(!["needs_attention", "publication_failed", "planning_failed"].includes(state.phase), JSON.stringify(state.nodes));
    return state;
  };
  if (!resume) {
  await until(async () => { await refresh(); return ["left", "right"].every(node => state.executions.some(e => e.node === node && e.status === "running")); }, "two concurrent root executions");
  await writeFile(join(repository, "artifacts/shared.txt"), "USER\nBASE\n");
  evidence.checks.sourceEditedDuringExecution = { at: new Date().toISOString(), content: "USER\nBASE\n", running: state.executions.filter(e => e.status === "running").map(e => e.id) };
  }
  const select = async node => {
    await page.locator(`.react-flow__node[data-id="${node}"]`).click();
    await until(async () => await page.locator(".conversation-heading h2").innerText() === node, `select ${node}`);
  };
  // Started includes workspace/native launch preparation. Wait for a real Pi
  // tool call before steering, so the RPC session (not only a scheduled slot)
  // is live and the sleeping tool gives navigation a bounded delivery window.
  if (!resume) {
  const leftExecution = state.executions.find(e => e.node === "left");
  await until(async () => {
    const output = await api("get_execution_output", { runId, executionId: leftExecution.id });
    return output.content.split(/\r?\n/).some(line => {
      try { const event = JSON.parse(line); return event.type === "tool_execution_start" && event.toolName === "bash"; } catch { return false; }
    });
  }, "live Pi Bash tool before steer", 40_000);
  await select("left");
  }
  const imageAttachment = async (name, color) => {
    const data = await page.evaluate(color => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 128;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 128, 128);
      return canvas.toDataURL("image/png").split(",")[1];
    }, color);
    return { name, mimeType: "image/png", buffer: Buffer.from(data, "base64") };
  };
  const turns = resume ? previousReport.controls.filter(control => control.action === "steer").map(control => ({
    node: control.node, name: control.instruction.match(/<file name="([^"]+)"/)[1], image: !!control.images?.length,
    instruction: control.instruction.slice(control.instruction.indexOf("</file>") + 7).trim(),
  })) : [];
  evidence.checks.turns = turns;
  const submit = async (node, action, attachment, instruction) => {
    const previous = evidence.controls.length;
    const composer = page.locator(".conversation-pane textarea");
    if (action === "intervene") await until(async () => (await page.locator(".graph-bottom .approval-row").innerText()).includes("Run completed"), "durable publication completion reaches browser");
    await until(async () => await composer.count() === 1 && !await composer.isDisabled() &&
      (action !== "steer" || /Steer/.test(await composer.getAttribute("placeholder"))), "available live composer", 20_000);
    await page.locator('input[type="file"]').setInputFiles(attachment);
    await composer.fill(instruction); await composer.press("Enter");
    await until(() => {
      assert.deepEqual(evidence.apiErrors, [], "No API rejection during attachment submission");
      const request = evidence.controls.slice(previous).find(control => control.node === node && control.instruction?.endsWith(instruction));
      if (request) assert.equal(request.action, action, "Submit only after the expected live state reaches the browser");
      return request;
    }, `${action} request`, 15_000);
    await until(async () => { await refresh(); return state.events.some(event => event.instruction?.endsWith(instruction)); }, `${action} durable acceptance`);
    turns.push({ node, name: attachment.name, image: attachment.mimeType.startsWith("image/"), instruction });
    await assertTurns(node);
  };
  const assertTurns = async node => {
    for (const turn of turns.filter(turn => turn.node === node)) {
      const stack = page.locator(".chat-user-bubble-stack", { hasText: turn.instruction });
      await until(async () => await stack.count() === 1 && await stack.locator(`.chat-bubble-file-badge[title="${turn.name}"]`).count() === 1 &&
        (!turn.image || await stack.locator(`img[alt="${turn.name}"]`).count() === 1), `one persistent attachment bubble: ${turn.name}`);
      if (turn.image) assert.ok(await stack.locator("img").evaluate(image => image.complete && image.naturalWidth > 0));
    }
  };
  if (!resume) {
  const steerColor = ["red", "blue", "green"][Math.floor(Math.random() * 3)];
  const steerToken = "STEER_" + randomUUID();
  await submit("left", "steer", await imageAttachment("steer-image.png", steerColor), "Inspect the attached image, write its actual solid background color as one lowercase English word to steer-image.txt using bash. Do not guess from the filename. Preserve the root task outputs; finish with a nonempty sentence.");
  await submit("left", "steer", { name: "steer-notes.txt", mimeType: "text/plain", buffer: Buffer.from(steerToken) }, "Read the attached file and write its exact token plus newline to steer-file.txt using bash. Preserve all other outputs; finish with a nonempty sentence.");
  // Switch actual Runs while the original task continues, not an injected UI state.
  await page.locator(`[data-run-id="${other.runId}"]`).click();
  await page.locator('.react-flow__node[data-id="draft"]').waitFor();
  await page.locator(`[data-run-id="${runId}"]`).click(); await select("left"); await assertTurns("left");
  evidence.checks.steerAttachmentsAfterRunSwitch = true;
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(`[data-run-id="${runId}"]`).click(); await select("left"); await assertTurns("left");
  evidence.checks.steerAttachmentsAfterReload = true;
  // Capture the child's input while its private workspace still exists, before publication cleanup.
  await until(async () => {
    await refresh();
    const child = state.executions.find(e => e.node === "joined" && e.status === "running");
    return child && state.events.some(e => e.type === "prepared" && e.execution_id === child.id);
  }, "downstream prepared after private composition", 160_000);
  const child = state.executions.find(e => e.node === "joined");
  const composition = state.mergers.find(e => e.node === "merge:joined");
  assert.ok(composition && composition.status === "completed", "A private node Merger must finish before downstream runs");
  assert.notEqual(resolve(composition.worktree.replace(/^\\\\\?\\/, "")), resolve(repository));
  assert.equal(gitAt(child.worktree, "show", `${child.before}:artifacts/shared.txt`).replaceAll("\r\n", "\n"), "LEFT\nRIGHT");
  assert.equal((await readFile(join(child.worktree, "artifacts/shared.txt"), "utf8")).replaceAll("\r\n", "\n"), "LEFT\nRIGHT\n");
  assert.ok(composition.completedAt <= child.startedAt || state.events.find(e => e.type === "merger_finished" && e.execution_id === composition.id).sequence < state.events.find(e => e.type === "prepared" && e.execution_id === child.id).sequence);
  evidence.checks.privateComposition = { mergerId: composition.id, worktree: composition.worktree, childId: child.id, childInput: child.before, content: "LEFT\nRIGHT\n" };
  await until(async () => { await refresh(); return state.phase === "completed" && state.publication?.status === "completed"; }, "publication preserving concurrent source edit", 80_000);
  const roots = state.executions.filter(e => ["left", "right"].includes(e.node));
  assert.equal(roots.length, 2); assert.ok(roots.every(e => e.status === "completed"));
  assert.ok(Math.max(...roots.map(e => e.startedAt)) < Math.min(...roots.map(e => e.completedAt)));
  evidence.checks.parallel = roots.map(({ node, startedAt, completedAt }) => ({ node, startedAt, completedAt }));
  assert.equal(await text("artifacts/shared.txt"), "USER\nLEFT\nRIGHT");
  assert.equal(await text("downstream.txt"), "LEFT\nRIGHT");
  assert.equal(await text("steer-image.txt"), steerColor); assert.equal(await text("steer-file.txt"), steerToken);
  assert.ok(state.mergers.some(e => e.node === "merger" && e.status === "completed"));
  evidence.checks.sourceEditPreserved = true; evidence.checks.modelReceivedSteerAttachments = true;
  }
  // Completed-node continuations, both visual and text attachments.
  await select("joined");
  const followColor = ["red", "blue", "green"][Math.floor(Math.random() * 3)];
  const followToken = "FOLLOWUP_" + randomUUID();
  await submit("joined", "intervene", await imageAttachment("follow-image.png", followColor), "Inspect the attached image and write its actual solid background color as one lowercase English word to follow-image.txt using bash. Preserve existing files; finish with a nonempty sentence.");
  await until(async () => { await refresh(); return state.phase === "completed" && state.nodes.joined.status === "completed"; }, "image continuation published", 50_000);
  await submit("joined", "intervene", { name: "follow-notes.txt", mimeType: "text/plain", buffer: Buffer.from(followToken) }, "Read the attached file and write its exact token plus newline to follow-file.txt using bash. Preserve existing files; finish with a nonempty sentence.");
  await until(async () => { await refresh(); return state.phase === "completed" && state.nodes.joined.status === "completed"; }, "file continuation published", 50_000);
  assert.equal(await text("follow-image.txt"), followColor); assert.equal(await text("follow-file.txt"), followToken);
  assert.equal(await text("artifacts/shared.txt"), "USER\nLEFT\nRIGHT");
  assert.equal(await text("downstream.txt"), "LEFT\nRIGHT");
  assert.ok(!git("ls-files").includes("remove-left.txt") && !git("ls-files").includes("remove-right.txt"));
  assert.equal(git("status", "--porcelain"), "");
  evidence.checks.modelReceivedContinuationAttachments = true;
  await page.locator(`[data-run-id="${other.runId}"]`).click();
  await page.locator('.react-flow__node[data-id="draft"]').waitFor();
  await page.locator(`[data-run-id="${runId}"]`).click(); await select("joined"); await assertTurns("joined");
  evidence.checks.continuationAttachmentsAfterRunSwitch = true;
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(`[data-run-id="${runId}"]`).click(); await select("joined"); await assertTurns("joined");
  await page.screenshot({ path: join(root, "continuation-reloaded.png"), fullPage: true });
  await select("left"); await assertTurns("left");
  await page.screenshot({ path: join(root, "steer-reloaded.png"), fullPage: true });
  evidence.checks.allAttachmentsAfterReload = true;
  const models = new Set(), userMessages = [];
  for (const file of await readdir(join(dataRoot, "data"), { recursive: true })) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of (await readFile(join(dataRoot, "data", file), "utf8")).split(/\r?\n/)) {
      if (!line) continue;
      const entry = JSON.parse(line), message = entry.message || entry.assistantMessage;
      if (message?.role === "assistant" && message.model && message.provider) models.add(`${message.provider}/${message.model}`);
      if (message?.role === "user" && Array.isArray(message.content)) userMessages.push(message);
    }
  }
  assert.deepEqual([...models], [model]); evidence.checks.actualModels = [...models];
  evidence.checks.piAttachmentPayloads = turns.map(turn => {
    const message = userMessages.find(message => message.content.some(part => part.type === "text" && part.text.endsWith(turn.instruction)));
    assert.ok(message, `Pi session must contain the actual attachment turn: ${turn.name}`);
    const event = state.events.find(event => event.instruction?.endsWith(turn.instruction));
    assert.ok(message.content.some(part => part.type === "text" && part.text === event.instruction), "Pi must receive the exact durable attachment-bearing text");
    if (turn.image) assert.ok(message.content.some(part => part.type === "image" && part.mimeType === "image/png" && part.data === event.images?.[0]?.data), "Pi must receive the exact durable image bytes");
    return { node: turn.node, name: turn.name, exactPiPayload: true };
  });
  evidence.checks.turns = turns;
  assert.deepEqual(evidence.browserErrors, []); assert.deepEqual(evidence.apiErrors, []);
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed"; evidence.error = String(error.stack || error); process.exitCode = 1;
  console.error(evidence.error);
  if (page) await page.screenshot({ path: join(root, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  await context?.close(); await browser?.close(); await vite?.close();
  if (backend && backend.exitCode === null && backend.pid) {
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
