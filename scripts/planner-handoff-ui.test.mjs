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
