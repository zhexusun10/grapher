import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

// The Planner's live SSE stream is not the conversation record: once a turn
// ends, the workbench replays `planning/<id>/planner.jsonl`. These regressions
// pin that handoff, because a transcript window that settles too early used to
// hide the answer until a full page reload cleared the in-memory cache.

let server, browser, origin;
let onPlanStream;

const line = event => JSON.stringify(event) + "\n";
const assistant = text => line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-planner-handoff",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
    plugins: [{ name: "planner-handoff-fixtures", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === "/api/plan_goal_stream") {
          let body = "";
          for await (const chunk of req) body += chunk;
          if (onPlanStream) return onPlanStream(JSON.parse(body), res);
        }
        if (req.url.startsWith("/__steer-recovery")) {
          res.setHeader("Content-Type", "text/html");
          return res.end(await vite.transformIndexHtml(req.url,
            `<html><body><div id="root"></div><script type="module" src="/scripts/fixtures/planner-steer-recovery.tsx"></script></body></html>`));
        }
        if (!req.url.startsWith("/__handoff")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url,
          `<html><body><div id="root" style="padding:32px"></div><script type="module" src="/scripts/fixtures/frontend-audit.tsx"></script></body></html>`));
      });
    } }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function newPage(handler) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  const errors = [];
  await context.route("**/api/*", handler);
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on("pageerror", error => errors.push(String(error)));
  return { context, page, errors };
}

/** One Run whose Planner follow-up commits `new-plan` and streams an answer.
 * `firstRead` simulates a transcript read that raced the writer. */
async function openFollowUp({ repository, firstRead = "ready" }) {
  const config = { repository, model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: true };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const running = { ...empty, runId: "handoff-run", config, planType: "graph", phase: "running", approved: true, planningId: "old-plan",
    graph: { originalGoal: "Original goal", nodes: [{ name: "worker", task: "Task" }], edges: [] },
    nodes: { worker: { status: "completed", revision: 1, instruction: "", error: null } },
    executions: [{ id: "done-execution", node: "worker", status: "completed", revision: 1, attempt: 1,
      startedAt: 1, completedAt: 2, sessionId: "worker-session", worktree: "/mock/handoff-worker",
      before: "", after: "head", output: "", outputBytes: 0 }],
    events: [{ type: "created", sequence: 1, planning_id: "old-plan", timestamp: 1 }] };
  const completed = { ...running, planningId: "new-plan",
    events: [...running.events, { type: "graph_revised", sequence: 2, planning_id: "new-plan", timestamp: 2,
      planning: { planningId: "new-plan", status: "success", createdAt: 2 } }] };
  const outputs = { "old-plan": assistant("OLD TURN ANSWER"), "new-plan": assistant("NEW ANSWER MARKER") };
  let newPlanReads = 0;
  let closed = false;
  onPlanStream = (_body, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: run_started\ndata: ${JSON.stringify({ runId: running.runId })}\n\n`);
    res.write(`event: planner\ndata: ${JSON.stringify({ event: { type: "message_start", message: { role: "assistant", content: [] } } })}\n\n`);
    res.write(`event: planner\ndata: ${JSON.stringify({ event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "NEW ANSWER MARKER" } } })}\n\n`);
    res.write(`event: planner\ndata: ${JSON.stringify({ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "NEW ANSWER MARKER" }] } } })}\n\n`);
    res.write(`event: complete\ndata: ${JSON.stringify({ snapshot: completed })}\n\n`);
    res.end();
  };
  const { context, page, errors } = await newPage(route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [running.runId], repositoryInfo: { path: config.repository, name: "Handoff", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = running; break;
      case "snapshot_if_changed": result = { version: "handoff", snapshot: running }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": {
        if (body.planningId === "new-plan") newPlanReads += 1;
        // A race with the writer can return an empty page that still claims to be
        // terminal; the panel must not accept that as the final revision.
        const empty = body.planningId === "new-plan" && firstRead === "empty" && newPlanReads === 1;
        const content = empty ? "" : (outputs[body.planningId] ?? "");
        const bytes = Buffer.byteLength(content), from = body.offset ?? 0;
        result = { planningId: body.planningId, role: "planner", content: content.slice(from),
          startOffset: from, nextOffset: bytes, totalBytes: bytes, complete: true, running: false };
        break;
      }
      case "get_execution_output": result = { runId: body.runId, executionId: body.executionId, content: "",
        startOffset: body.offset ?? 0, nextOffset: 0, totalBytes: 0, complete: true, status: "completed" }; break;
      default: result = {};
    }
    return route.fulfill({ json: { result } });
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.locator('[data-run-id="handoff-run"]').click();
  await page.locator(".pane-bottom-chat").first().waitFor();
  const input = page.locator(".pane-bottom-chat textarea");
  await input.fill("ASK DURING RUN");
  await input.press("Enter");
  await page.locator(".chat-bubble-user", { hasText: "ASK DURING RUN" }).waitFor();
  const close = async () => { closed = true; onPlanStream = undefined; await context.close(); };
  return { page, errors, close, transcriptReads: () => newPlanReads, isClosed: () => closed };
}

/** A settled Planner with a short tail, while only graph workers keep updating. */
async function openPagedPlanner({ graphRunning = true, stalled = false } = {}) {
  const config = { repository: "/mock/planner-fill", model: "test/model", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: true };
  const planning = { planningId: "fill-plan", status: "success", createdAt: 1, runId: "fill-run", repository: config.repository, roles: { planner: {} } };
  const snapshot = { runId: "fill-run", config, planType: "graph", phase: graphRunning ? "running" : "completed",
    approved: true, paused: false, base: "", feedbackCounts: {}, planningId: planning.planningId, planning,
    graph: { originalGoal: "Planner fill regression", nodes: [{ name: "worker", task: "Task" }], edges: [] },
    nodes: { worker: { status: graphRunning ? "running" : "completed", revision: 1, instruction: "", error: null } },
    plan: { executionBatches: [["worker"]], roots: ["worker"], terminals: ["worker"], warnings: [] },
    executions: [{ id: "worker-execution", node: "worker", status: graphRunning ? "running" : "completed", revision: 1,
      attempt: 1, startedAt: 1, output: "", outputBytes: 0 }],
    events: [{ type: "created", sequence: 1, planning_id: planning.planningId, planning, timestamp: 1 }] };
  const prefix = Array.from({ length: 65 }, (_, i) => assistant(`OLDER_PLANNER_ROW_${i}`)).join("");
  const bytes = Buffer.from(prefix + assistant("PLANNER_FILL_TAIL")), split = Buffer.byteLength(prefix);
  let releaseOlder, polls = 0, reads = 0;
  const { context, page, errors } = await newPage(async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: { ...snapshot, runId: "", graph: { originalGoal: "", nodes: [], edges: [] },
        nodes: {}, executions: [], events: [], phase: "draft", planning: null, planningId: undefined }, runs: [snapshot.runId],
        repositoryInfo: { path: config.repository, name: "Planner fill", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = snapshot; break;
      case "snapshot_if_changed": {
        polls++;
        result = { version: String(polls), snapshot: { ...snapshot,
          executions: snapshot.executions.map(execution => ({ ...execution, outputBytes: polls })),
          events: [...snapshot.events, { type: "execution_progress", node: "worker", sequence: polls + 1, timestamp: polls + 1 }] } };
        break;
      }
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": {
        reads++;
        if (body.before !== undefined) {
          if (stalled) await new Promise(resolve => { releaseOlder = resolve; });
          else await new Promise(resolve => setTimeout(resolve, 120));
        }
        const start = body.before !== undefined ? 0 : body.tail ? split : body.offset ?? 0;
        const end = body.before ?? bytes.length;
        result = { planningId: body.planningId, role: "planner", content: bytes.subarray(start, end).toString(),
          startOffset: start, nextOffset: end, totalBytes: bytes.length, complete: end === bytes.length, running: false }; break;
      }
      default: result = {};
    }
    try { await route.fulfill({ json: { result } }); } catch { /* a closed view cancels its reads */ }
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.plannerFillFrames = [];
    window.samplePlannerFill = true;
    const sample = () => {
      const scroll = document.querySelector(".initial-query-scroll");
      const row = [...(scroll?.querySelectorAll("[data-transcript-id]") ?? [])].find(el => el.textContent.includes("PLANNER_FILL_TAIL"));
      if (scroll && row) window.plannerFillFrames.push({ opacity: Number(getComputedStyle(scroll).opacity),
        top: row.getBoundingClientRect().top, filled: scroll.scrollHeight > 2000 });
      if (window.samplePlannerFill) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.locator('[data-run-id="fill-run"]').click();
  return { context, page, errors, release: () => releaseOlder?.(), polls: () => polls, reads: () => reads };
}

for (const graphRunning of [true, false]) {
  test(`settled Planner fills before fading while graph is ${graphRunning ? "running" : "completed"}`, { timeout: 30_000 }, async () => {
    const { context, page, errors, polls, reads } = await openPagedPlanner({ graphRunning });
    try {
      await page.waitForFunction(() => document.querySelector(".initial-query-scroll")?.style.opacity === "1" &&
        getComputedStyle(document.querySelector(".initial-query-scroll")).opacity === "1");
      await page.waitForTimeout(350);
      const frames = await page.evaluate(() => { window.samplePlannerFill = false; return window.plannerFillFrames; });
      const fading = frames.filter(frame => frame.opacity > 0.01 && frame.opacity < 0.99);
      assert.ok(fading.length >= 3, "sample the reveal itself");
      assert.ok(fading.every(frame => frame.filled), `history must fill before painting: ${JSON.stringify(fading)}`);
      const tops = fading.map(frame => frame.top);
      assert.ok(Math.max(...tops) - Math.min(...tops) <= 1.5, "the tail must not move mid-fade");
      assert.equal(await page.locator(".workbench.planning-active").count(), 0, "graph activity does not revive Planner");
      await page.evaluate(() => { window.savedPlannerElement = document.querySelector(".planning-activity"); });
      const previousPolls = polls(), previousReads = reads();
      await page.waitForTimeout(2800);
      assert.ok(polls() > previousPolls, "exercise worker snapshot updates");
      assert.equal(reads(), previousReads, "worker output does not reread settled Planner logs");
      assert.ok(await page.evaluate(() => window.savedPlannerElement === document.querySelector(".planning-activity")), "snapshot updates do not remount history");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("a stalled Planner history fill still reveals the available tail", { timeout: 30_000 }, async () => {
  const { context, page, errors, release } = await openPagedPlanner({ stalled: true });
  try {
    await page.waitForFunction(() => {
      const scroll = document.querySelector(".initial-query-scroll");
      return scroll && getComputedStyle(scroll).opacity === "1";
    }, null, { timeout: 4000 });
    assert.equal(await page.locator(".planning-activity").getAttribute("aria-busy"), "true");
    await page.getByText("PLANNER_FILL_TAIL", { exact: true }).waitFor();
    release();
    await page.waitForFunction(() => document.querySelector(".planning-activity").getAttribute("aria-busy") === "false");
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test("empty failed Planner composer resumes its own turn without adding a user message", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/planner-resume", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const summary = { planningId: "failed-plan", runId: "planner-resume-run", planType: "graph", status: "failed",
    goal: "Original goal", error: "interrupted", repository: config.repository, roles: { planner: {} }, createdAt: 1 };
  const failed = { runId: summary.runId, config, planType: "graph", phase: "planning_failed", approved: false, paused: false,
    planningId: summary.planningId, planning: summary, graph: { originalGoal: "Original goal", nodes: [], edges: [] },
    nodes: {}, plan: null, executions: [], events: [{ type: "planning_failed", sequence: 1, timestamp: 1, planning: summary }], base: "", feedbackCounts: {} };
  const complete = { ...failed, phase: "awaiting_approval", planningId: "continued-plan", planning: { ...summary, planningId: "continued-plan", status: "success", error: null },
    graph: { originalGoal: "Original goal", nodes: [{ name: "restored", task: "task" }], edges: [] },
    nodes: { restored: { status: "waiting", revision: 0, instruction: "", error: null } } };
  let body;
  onPlanStream = (request, res) => {
    body = request;
    res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
    res.write(`event: run_started\ndata: ${JSON.stringify({ runId: failed.runId })}\n\n`);
    res.write(`event: complete\ndata: ${JSON.stringify({ snapshot: complete })}\n\n`);
    res.end();
  };
  const { context, page, errors } = await newPage(route => {
    const command = new URL(route.request().url()).pathname.slice(5), request = route.request().postDataJSON();
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: failed, runs: [failed.runId], repositoryInfo: { path: config.repository, name: "Resume", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": case "load_run": result = failed; break;
      case "snapshot_if_changed": result = { version: "failed", snapshot: failed }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = [summary]; break;
      case "get_planning": result = summary; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": result = { planningId: request.planningId, role: "planner", content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, running: false }; break;
      default: result = {};
    }
    return route.fulfill({ json: { result } });
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator(`[data-run-id="${failed.runId}"]`).click();
    const input = page.locator(".pane-bottom-chat textarea");
    await input.waitFor();
    const before = await page.locator(".chat-bubble-user").count();
    await page.getByRole("button", { name: "Continue this agent (without adding a message)" }).click();
    await page.waitForFunction(() => document.querySelector(".pane-bottom-chat"));
    await page.waitForTimeout(300);
    assert.equal(body?.revisionRunId, failed.runId);
    assert.equal(body?.continuePlanningId, summary.planningId);
    assert.equal(body?.mode, "graph");
    assert.equal(await page.locator(".chat-bubble-user").count(), before, "continuation must not create an optimistic user bubble");
    assert.deepEqual(errors, []);
  } finally { onPlanStream = undefined; await context.close(); }
});

test("post-task review output starts after a divider instead of continuing the planned turn", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/review-divider", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3,
    autoApprove: false, postTaskReview: true };
  const initial = { planningId: "plan-initial", status: "completed", createdAt: 1, runId: "review-divider-run",
    repository: config.repository, roles: { planner: { sessionId: "review-session", sessionStart: 1 } } };
  const review = { planningId: "plan-review", status: "completed", createdAt: 2, runId: "review-divider-run",
    repository: config.repository, roles: { planner: { sessionId: "review-session", sessionStart: 1 } } };
  const completed = { runId: "review-divider-run", config, planType: "graph", phase: "completed", approved: true,
    paused: false, base: "", feedbackCounts: {}, plan: null, executions: [],
    planningId: "plan-review", planning: review,
    graph: { originalGoal: "Review this run", nodes: [{ name: "worker", task: "Do the work" }], edges: [] },
    nodes: { worker: { status: "completed", revision: 0, instruction: "", error: null } },
    events: [
      { type: "created", sequence: 1, planning_id: "plan-initial", timestamp: 1, planning: initial },
      { type: "planner_review_started", sequence: 2, timestamp: 2, planning: review },
      { type: "planner_review_finished", sequence: 3, timestamp: 3, planning: review, approval_required: false },
    ] };
  const outputs = { "plan-initial": assistant("PLANNED WORK ANSWER"), "plan-review": assistant("POST TASK REVIEW ANSWER") };
  const { context, page, errors } = await newPage(route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: completed, runs: [completed.runId],
        repositoryInfo: { path: config.repository, name: "Review divider", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = completed; break;
      case "snapshot_if_changed": result = { version: "review-divider", snapshot: completed }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": {
        const content = outputs[body.planningId] ?? "";
        const from = body.offset ?? 0, bytes = Buffer.byteLength(content);
        result = { planningId: body.planningId, role: "planner", content: content.slice(from), startOffset: from,
          nextOffset: bytes, totalBytes: bytes, complete: true, running: false };
        break;
      }
      case "get_execution_output": result = { runId: body.runId, executionId: body.executionId, content: "",
        startOffset: body.offset ?? 0, nextOffset: 0, totalBytes: 0, complete: true, status: "completed" }; break;
      default: result = {};
    }
    return route.fulfill({ json: { result } });
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="review-divider-run"]').click();
    await page.getByText("POST TASK REVIEW ANSWER", { exact: true }).waitFor();
    await page.getByText("PLANNED WORK ANSWER", { exact: true }).waitFor();
    const rows = await page.evaluate(() => [...document.querySelectorAll(".planning-activity [data-transcript-id]")]
      .map(row => row.querySelector(".transcript-divider") ? "divider" : (row.textContent || "").replace(/\s+/g, " ").trim()));
    const planned = rows.findIndex(text => text === "PLANNED WORK ANSWER");
    const divider = rows.indexOf("divider");
    const reviewRow = rows.findIndex(text => text === "POST TASK REVIEW ANSWER");
    assert.ok(planned >= 0 && divider >= 0 && reviewRow >= 0, `missing rows: ${JSON.stringify(rows)}`);
    assert.ok(planned < divider && divider < reviewRow,
      `the review must sit below a divider, not inside the planned turn: ${JSON.stringify(rows)}`);
    assert.equal(rows.filter(text => text === "divider").length, 1, "one divider per review turn");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a completed Planner follow-up keeps its answer when the live stream hands off to JSONL", { timeout: 45_000 }, async () => {
  const session = await openFollowUp({ repository: "/mock/handoff" });
  try {
    await session.page.waitForTimeout(1200);
    assert.equal(await session.page.getByText("NEW ANSWER MARKER", { exact: true }).count(), 1,
      "the completed turn must be replayed exactly once from its durable log");
    assert.equal(await session.page.getByText("OLD TURN ANSWER", { exact: true }).count(), 1,
      "earlier revisions stay in the conversation");
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
});

test("a terminal transcript read that raced the writer does not hide the turn until reload", { timeout: 45_000 }, async () => {
  const session = await openFollowUp({ repository: "/mock/handoff-empty", firstRead: "empty" });
  try {
    await session.page.getByText("NEW ANSWER MARKER", { exact: true }).waitFor();
    assert.ok(session.transcriptReads() >= 2,
      `the empty terminal page must be retried (reads=${session.transcriptReads()})`);
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
});

test("a steer whose durable window starts at that turn stays visible after the reply", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/steer-window", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: true };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const planned = { ...empty, runId: "steer-window-run", config, planType: "graph", phase: "running", approved: true, planningId: "new-plan",
    graph: { originalGoal: "Original goal", nodes: [{ name: "worker", task: "Task" }], edges: [] },
    nodes: { worker: { status: "completed", revision: 1, instruction: "", error: null } },
    events: [{ type: "created", sequence: 1, planning_id: "new-plan", timestamp: 1,
      planning: { planningId: "new-plan", status: "success", roles: {}, createdAt: 1 } }] };
  // The loaded window begins at the steer: the header turn is not part of it.
  const outputs = { "new-plan": line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "STEER DURING REPLY" }] } }) + assistant("NEW ANSWER MARKER") };
  let release;
  const steerSeen = new Promise(resolve => { release = resolve; });
  onPlanStream = (_body, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: run_started\ndata: ${JSON.stringify({ runId: planned.runId })}\n\n`);
    res.write(`event: planner\ndata: ${JSON.stringify({ event: { type: "message_start", message: { role: "assistant", content: [] } } })}\n\n`);
    res.write(`event: planner\ndata: ${JSON.stringify({ event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "NEW ANSWER MARKER" } } })}\n\n`);
    void steerSeen.then(() => {
      res.write(`event: planner\ndata: ${JSON.stringify({ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "NEW ANSWER MARKER" }] } } })}\n\n`);
      res.write(`event: complete\ndata: ${JSON.stringify({ snapshot: planned })}\n\n`);
      res.end();
    });
  };
  const { context, page, errors } = await newPage(route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: planned, runs: [planned.runId], repositoryInfo: { path: config.repository, name: "Steer window", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = planned; break;
      case "snapshot_if_changed": result = { version: "steer-window", snapshot: planned }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": {
        const content = outputs[body.planningId] ?? "";
        const bytes = Buffer.byteLength(content), from = body.offset ?? 0;
        result = { planningId: body.planningId, role: "planner", content: content.slice(from),
          startOffset: from, nextOffset: bytes, totalBytes: bytes, complete: true, running: false };
        break;
      }
      case "get_execution_output": result = { runId: body.runId, executionId: body.executionId, content: "",
        startOffset: body.offset ?? 0, nextOffset: 0, totalBytes: 0, complete: true, status: "completed" }; break;
      case "control": result = planned; if (body.action === "steer_planner") release(); break;
      default: result = {};
    }
    return route.fulfill({ json: { result } });
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="steer-window-run"]').click();
    const input = page.locator(".pane-bottom-chat textarea");
    await input.fill("FOLLOW-UP");
    await input.press("Enter");
    await page.locator(".chat-bubble-user", { hasText: "FOLLOW-UP" }).waitFor();
    await page.waitForTimeout(300);
    await input.fill("STEER DURING REPLY");
    await input.press("Enter");
    // The live stream and the saved replay can overlap for a frame.
    await page.getByText("NEW ANSWER MARKER", { exact: true }).first().waitFor();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator(".chat-bubble-user", { hasText: "STEER DURING REPLY" }).count(), 1,
      "the steer must not be suppressed as if its turn were the conversation header");
    assert.equal(await page.locator(".chat-bubble-user", { hasText: "FOLLOW-UP" }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { onPlanStream = undefined; await context.close(); }
});

test("Planner shows generated tools immediately and moves a queued steer only when Pi consumes it", { timeout: 45_000 }, async () => {
  const config = { repository: "/mock/steer-live", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: true };
  const initial = { runId: "steer-live-run", config, planType: "graph", phase: "awaiting_approval", approved: false, planningId: "old-plan",
    graph: { originalGoal: "Original goal", nodes: [{ name: "worker", task: "Task" }], edges: [] },
    nodes: { worker: { status: "waiting", revision: 1, instruction: "", error: null } },
    plan: null, executions: [], events: [{ type: "created", sequence: 1, planning_id: "old-plan", timestamp: 1 }],
    paused: false, base: "", feedbackCounts: {} };
  let snapshot = initial, stream, requestId;
  const emit = event => stream.write(`event: planner\ndata: ${JSON.stringify({ event })}\n\n`);
  onPlanStream = (_body, res) => {
    stream = res;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: run_started\ndata: ${JSON.stringify({ runId: initial.runId })}\n\n`);
    res.write(`event: route_decision\ndata: ${JSON.stringify({ planType: "graph" })}\n\n`);
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "tool-one", toolName: "bash" } });
  };
  const { context, page, errors } = await newPage(route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "plan_goal_stream") return route.continue();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: initial, runs: [initial.runId], repositoryInfo: { path: config.repository, name: "Steer", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "snapshot": case "history": result = snapshot; break;
      case "snapshot_if_changed": result = { version: String(snapshot.events.length), snapshot }; break;
      case "repository_status": result = { repository: config.repository, valid: true, error: null }; break;
      case "list_plannings": case "list_files": case "list_skills": result = command === "list_plannings" ? [] : command === "list_files" ? { files: [] } : { skills: [] }; break;
      case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
      case "get_planning_output": {
        const text = assistant("OLD ANSWER"), from = body.offset ?? 0;
        result = { planningId: body.planningId, role: "planner", content: text.slice(from), startOffset: from,
          nextOffset: Buffer.byteLength(text), totalBytes: Buffer.byteLength(text), complete: true, running: false };
        break;
      }
      case "control": {
        assert.equal(body.action, "steer_planner");
        requestId = body.requestId;
        assert.match(requestId, /^[0-9a-f-]{36}$/);
        snapshot = { ...initial, planning: { planningId: "new-plan", status: "running", roles: {}, createdAt: 2 },
          events: [...initial.events,
            { type: "planner_steer_submitted", sequence: 2, timestamp: 2, planning_id: "new-plan", request_id: requestId, instruction: body.instruction },
            { type: "planner_steer_status", sequence: 3, timestamp: 3, planning_id: "new-plan", request_id: requestId, status: "queued" }] };
        result = snapshot; break;
      }
      default: result = {};
    }
    return route.fulfill({ json: { result } });
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="steer-live-run"]').click();
    const input = page.locator(".pane-bottom-chat textarea");
    await input.fill("FOLLOW UP"); await input.press("Enter");
    await page.getByText("Preparing call…", { exact: true }).waitFor();
    assert.equal(await page.locator('[data-testid="tool-call-card"]').count(), 1);
    await input.fill("STEER WHILE TOOL RUNS"); await input.press("Enter");
    await page.getByText("Queued; waiting for the current step to finish", { exact: true }).waitFor();
    assert.equal(await page.locator(".planner-transcript .chat-bubble-user", { hasText: "STEER WHILE TOOL RUNS" }).count(), 0,
      "submission does not insert an unread message into the transcript");
    emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0,
      toolCall: { id: "tool-one", name: "bash", arguments: { command: "sleep 10" } } } });
    await page.getByText("Waiting to run…", { exact: true }).waitFor();
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-one", name: "bash", arguments: { command: "sleep 10" } }] } });
    emit({ type: "tool_execution_start", toolCallId: "tool-one", toolName: "bash", args: { command: "sleep 10" } });
    await page.getByText("Running...", { exact: true }).waitFor();
    assert.equal(await page.locator('[data-testid="tool-call-card"]').count(), 1);
    emit({ type: "tool_execution_end", toolCallId: "tool-one", toolName: "bash", result: { content: [{ type: "text", text: "done" }], details: { exitCode: 0 } } });
    const marked = `STEER WHILE TOOL RUNS\n\n<grapher-steer-id>${requestId}</grapher-steer-id>`;
    emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: marked }] } });
    emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: marked }] } });
    await page.locator(".planner-transcript .chat-bubble-user", { hasText: "STEER WHILE TOOL RUNS" }).waitFor();
    assert.equal(await page.locator(".chat-bubble-user", { hasText: "STEER WHILE TOOL RUNS" }).count(), 1);
    assert.equal(await page.locator(".planner-steer-list").count(), 0);
    assert.equal(await page.getByText(/grapher-steer-id/).count(), 0);
    assert.deepEqual(errors, []);
  } finally { stream?.destroy(); onPlanStream = undefined; await context.close(); }
});

test("recovered Planner keeps repeated queued steers separate and marks unread delivery unknown after interruption", { timeout: 45_000 }, async () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  let output = Buffer.from([
    line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "ORIGINAL GOAL" }] } }),
    line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "ORIGINAL GOAL" }] } }),
    line({ type: "tool_execution_start", toolCallId: "tool", toolName: "bash", args: { command: "long" } }),
    line({ type: "queue_update", steering: ["REPEATED INSTRUCTION\n\n<grapher-steer-id>12345678-1234-4234-8234-123456789abd</grapher-steer-id>"] }),
    line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: `REPEATED INSTRUCTION\n\n<grapher-steer-id>${id}</grapher-steer-id>` }] } }),
  ].join(""));
  let running = true;
  const { context, page, errors } = await newPage(route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command !== "get_planning_output") return route.fulfill({ json: { result: {} } });
    const from = body.offset ?? 0;
    return route.fulfill({ json: { result: { planningId: body.planningId, role: "planner", content: output.subarray(from).toString(),
      startOffset: from, nextOffset: output.length, totalBytes: output.length, complete: true, running } } });
  });
  try {
    await page.goto(`${origin}/__steer-recovery`, { waitUntil: "domcontentloaded" });
    await page.getByText("Queued; waiting for the current step to finish", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.chat-bubble-user').length >= 3);
    assert.equal(await page.locator(".chat-bubble-user", { hasText: "REPEATED INSTRUCTION" }).count(), 2,
      "one consumed and one identical unread steer retain distinct identities");
    assert.equal(await page.locator(".planner-steer-list .chat-bubble-user", { hasText: "REPEATED INSTRUCTION" }).count(), 1);
    running = false;
    await page.goto(`${origin}/__steer-recovery?running=false`, { waitUntil: "domcontentloaded" });
    await page.getByText("Delivery unknown; check the conversation before retrying", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.chat-bubble-user').length >= 3);
    assert.equal(await page.locator(".chat-bubble-user", { hasText: "REPEATED INSTRUCTION" }).count(), 2);
    assert.equal(await page.locator(".planner-steer-list .chat-bubble-user", { hasText: "REPEATED INSTRUCTION" }).count(), 1);
    // A paged window that begins with a steer identical to the goal must not
    // mistake that marked turn for the separately rendered header.
    output = Buffer.from(line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: `REPEATED INSTRUCTION\n\n<grapher-steer-id>${id}</grapher-steer-id>` }] } }));
    running = true;
    await page.goto(`${origin}/__steer-recovery?sameGoal=true`, { waitUntil: "domcontentloaded" });
    await page.getByText("Queued; waiting for the current step to finish", { exact: true }).waitFor();
    await page.locator(".planning-activity .chat-bubble-user", { hasText: "REPEATED INSTRUCTION" }).waitFor();
    assert.equal(await page.locator(".planning-activity .chat-bubble-user", { hasText: "REPEATED INSTRUCTION" }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
