// The publication Merger is not a planner node; it must still appear as a
// selectable card below the terminal layer, steerable while its process runs
// and able to continue its session after it settles.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const repository = "/mock/project";
const config = { repository, model: "test/model", maxParallel: 2, maxFeedback: 3, autoApprove: false };
const terminal = (name) => ({ name, task: `${name} task` });

function snapshotWith(mergerStatus) {
  const running = mergerStatus === "running";
  return {
    runId: "run-1", config, planType: "graph", phase: running ? "merging" : "completed", approved: true, paused: false,
    graph: { originalGoal: "Publish", nodes: [terminal("left"), terminal("right")], edges: [] },
    nodes: {
      left: { status: "done", revision: 1, head: "head-left", instruction: "", error: null },
      right: { status: "done", revision: 1, head: "head-right", instruction: "", error: null },
    },
    plan: { executionBatches: [["left", "right"]], roots: ["left", "right"], terminals: ["left", "right"], warnings: [] },
    executions: [],
    mergers: [{
      id: "publish-merger", node: "merger", revision: 1, attempt: 1, sessionId: "publish-merger",
      worktree: repository, before: "head-source", after: running ? null : "head-published",
      status: mergerStatus, output: "merger output line\n", startedAt: 1, completedAt: running ? null : 2,
    }],
    publication: { repository, heads: ["head-left", "head-right"], status: running ? "merging" : "completed", head: running ? null : "head-published", error: null, startedAt: 1, completedAt: running ? null : 2 },
    events: [], base: "", feedbackCounts: {},
  };
}

async function until(check, message, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

test("a publication merger is a graph card, steerable while running and continuable when settled", { timeout: 90_000 }, async () => {
  let status = "running";
  const controls = [];
  const errors = [];
  const image = { name: "steer.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxkAAAAASUVORK5CYII=", "base64") };
  // Mount before publication starts: live publication must not change Hook order.
  const snapshots = {
    "run-1": { ...snapshotWith(status), phase: "running", publication: null, mergers: [] },
    "run-2": { ...snapshotWith("completed"), runId: "run-2", mergers: [], publication: null },
  };
  const server = await createServer({ cacheDir: "node_modules/.vite-merger-graph-ui", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
    await context.addInitScript(({ repository, config }) => {
      localStorage.setItem("grapher_language_v1", "en");
      localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Project", lastOpened: 1 }]));
      localStorage.setItem("grapher_config", JSON.stringify(config));
    }, { repository, config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      const empty = { ...snapshotWith(status), runId: "", config: null, planType: undefined, phase: "draft", approved: false, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {}, plan: null, mergers: [], publication: null };
      const current = { ...snapshotWith(status) };
      let result;
      switch (command) {
        case "bootstrap": result = { config, snapshot: empty, runs: ["run-1", "run-2"], repositoryInfo: { path: repository, name: "Project", branch: "main", head: "", clean: true }, dataPath: "/mock/.grapher" }; break;
        case "history": case "snapshot": result = snapshots[body.runId] || current; break;
        case "snapshot_if_changed": result = { version: "1", snapshot: snapshots[body.runId] || current }; break;
        case "repository_status": result = { repository, valid: true, error: null }; break;
        case "detect_repository": result = { path: repository, name: "Project", branch: "main", head: "", clean: true }; break;
        case "get_execution_output": result = { runId: body.runId, executionId: body.executionId, content: "merger output line\n", nextOffset: 19, totalBytes: 19, complete: true, status }; break;
        case "control":
          controls.push(body);
          if (body.action === "continue_merger") {
            const previous = { ...snapshotWith("completed"), events: snapshots["run-1"].events };
            snapshots["run-1"] = { ...previous, mergers: [...previous.mergers,
              { ...snapshotWith("running").mergers[0], id: "continued-merger", attempt: 2, startedAt: 3 }] };
          }
          if (body.action === "steer" || body.action === "continue_merger") {
            const current = snapshots["run-1"];
            const executionId = body.action === "continue_merger" ? "continued-merger" : body.executionId;
            current.events = [...current.events, { type: "steered", sequence: current.events.length + 1,
              timestamp: Date.now(), node: "merger", execution_id: executionId, instruction: body.instruction, images: body.images }];
          }
          result = snapshots["run-1"]; break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [], models: [], warning: null }; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "environment_capabilities": result = { platform: "windows", arch: "x86_64", nativeWorkspace: true }; break;
        default: errors.push(`Unexpected API: ${command}`); result = null;
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="run-1"]').click();
    await page.locator('.react-flow__node[data-id="left"]').waitFor();
    snapshots["run-1"] = snapshotWith(status);
    const card = page.locator('.react-flow__node[data-id="merger:publication"]');
    await card.waitFor({ state: "visible" });
    assert.ok((await card.innerText()).includes("publication merger"), "the publication card must be named in the graph");
    // React Flow fits the graph under the publication panel; dispatch the React
    // click directly like the acceptance harness instead of hit-testing.
    await card.evaluate(node => node.click());

    // Running: the pane addresses the merger's live session.
    const heading = page.locator(".conversation-heading h2");
    await until(async () => (await heading.innerText()) === "publication merger", "publication merger pane heading");
    const textarea = page.locator("textarea");
    await textarea.waitFor({ state: "visible" });
    assert.equal(await textarea.isDisabled(), false, "a running merger accepts steering");
    assert.match(await textarea.getAttribute("placeholder"), /Steer the merger in real time/);
    await page.locator('input[type="file"]').setInputFiles(image);
    await textarea.fill("prefer both changes");
    await textarea.press("Enter");
    await until(() => controls.some(item => item.action === "steer" && item.node === "merger" &&
      item.executionId === "publish-merger" && item.instruction.endsWith("prefer both changes") && item.images?.[0]?.data), "steer control for the running publication merger");

    await until(async () => await page.locator(".chat-bubble-user", { hasText: "prefer both changes" }).count() === 1,
      "accepted steer retains exactly one user bubble after the durable event replaces the optimistic turn");

    const imageBubble = page.locator(".chat-user-bubble-stack", { hasText: "prefer both changes" });
    await until(async () => await imageBubble.locator('img[alt="steer.png"]').count() === 1,
      "accepted steer retains the image thumbnail").catch(async error => {
        throw new Error(`${error.message}: ${await imageBubble.innerHTML()} events=${JSON.stringify(snapshots["run-1"].events)}`);
      });

    // Settled: the publication merger still accepts appended messages.
    status = "completed";
    snapshots["run-1"] = { ...snapshotWith(status), events: snapshots["run-1"].events };
    await until(async () => (await card.innerText()).includes("DONE"), "live publication completion without a Hook-order crash");
    const closePublication = page.getByRole("button", { name: "Dismiss publication results", exact: true });
    // Dismissing the live banner also must not change Hook order.
    await closePublication.click();
    await page.locator(".publication-panel").waitFor({ state: "detached" });
    const settledCard = page.locator('.react-flow__node[data-id="merger:publication"]');
    await settledCard.waitFor({ state: "visible" });
    assert.ok((await settledCard.innerText()).includes("DONE"), "the settled card shows its terminal status");
    await settledCard.evaluate(node => node.click());
    const settledTextarea = page.locator("textarea");
    await settledTextarea.waitFor({ state: "visible" });
    assert.equal(await settledTextarea.isDisabled(), false, "a settled publication merger still accepts follow-ups");
    assert.match(await settledTextarea.getAttribute("placeholder"), /Append a message to the publication merger/);
    await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("FILE_TOKEN") });
    await settledTextarea.fill("keep the helper file");
    await settledTextarea.press("Enter");
    await until(() => controls.some(item => item.action === "continue_merger" && item.node === "merger" &&
      item.executionId === "publish-merger" && item.instruction.includes("FILE_TOKEN") && item.instruction.endsWith("keep the helper file")), "continue_merger control for the settled publication merger");
    assert.equal(controls.filter(item => item.instruction.endsWith("prefer both changes")).length, 1, "the earlier steer was not resent");
    await until(async () => /Steer the merger/.test(await settledTextarea.getAttribute("placeholder")), "continuation selects the new running execution");
    await until(async () => await page.locator(".chat-bubble-user", { hasText: "keep the helper file" }).count() === 1,
      "accepted continuation retains exactly one durable user bubble");
    assert.equal(snapshots["run-1"].phase, "completed", "a standalone merger does not restart publication");
    snapshots["run-1"] = { ...snapshots["run-1"], mergers: snapshots["run-1"].mergers.map(item =>
      item.id === "continued-merger" ? { ...item, status: "completed", after: "continued-head", completedAt: 4 } : item) };
    await until(async () => (await settledCard.innerText()).includes("DONE") &&
      /Append a message/.test(await settledTextarea.getAttribute("placeholder")), "polls a completed Run until its standalone merger settles");
    const assertAttachments = async () => {
      await until(async () => await page.locator(".chat-bubble-user", { hasText: "prefer both changes" }).count() === 1 &&
        await page.locator(".chat-bubble-user", { hasText: "keep the helper file" }).count() === 1, "exactly one bubble per attachment turn");
      assert.equal(await page.locator('.chat-user-bubble-stack img[alt="steer.png"]').count(), 1);
      assert.equal(await page.locator('.chat-user-bubble-stack .chat-bubble-file-badge[title="notes.txt"]').count(), 1);
    };
    await assertAttachments();
    await page.locator('[data-run-id="run-2"]').click();
    await page.locator('.react-flow__node[data-id="left"]').waitFor();
    await page.locator('[data-run-id="run-1"]').click();
    await page.locator('.react-flow__node[data-id="merger:publication"]').click();
    await assertAttachments();
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('[data-run-id="run-1"]').click();
    await page.locator('.react-flow__node[data-id="merger:publication"]').click();
    await assertAttachments();
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser?.close();
    await server.close();
  }
});
