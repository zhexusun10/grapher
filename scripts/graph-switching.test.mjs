import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

async function waitForComposerSettled(page, selector) {
  await page.locator(selector).evaluate(box => new Promise((resolve, reject) => {
    let previous = box.getBoundingClientRect();
    let stable = 0;
    const started = performance.now();
    const sample = () => {
      const rect = box.getBoundingClientRect();
      const movement = Math.abs(rect.x - previous.x) + Math.abs(rect.bottom - previous.bottom);
      stable = movement < 0.1 ? stable + 1 : 0;
      previous = rect;
      if (stable >= 4) return resolve();
      if (performance.now() - started > 5000) return reject(new Error("Composer did not settle"));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}

// Include ancestors: an input with opacity:1 still disappears under a fading view.
async function assertOpaqueComposerNavigation(page, navigate) {
  await page.evaluate(() => {
    window.navigationComposerFrames = [];
    window.sampleNavigationComposer = true;
    const sample = () => {
      const homeActive = document.querySelector(".app-shell").classList.contains("landing-active");
      const view = document.querySelector(homeActive ? ".landing-screen" : ".workspace-view-wrapper");
      const box = view?.querySelector(".prompt-box-container");
      let opacity = box ? 1 : 0;
      for (let element = box; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        opacity *= Number(style.opacity);
        if (style.visibility === "hidden" || style.display === "none") opacity = 0;
      }
      const send = box?.querySelector(".prompt-box-send-btn");
      const rect = send?.getBoundingClientRect();
      const painted = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const attach = box?.querySelector(".prompt-box-left-actions .prompt-box-icon-btn");
      const attachRect = attach?.getBoundingClientRect();
      const attachPainted = attachRect && document.elementFromPoint(attachRect.x + attachRect.width / 2, attachRect.y + attachRect.height / 2);
      const boxRect = box?.getBoundingClientRect();
      const visibleButtons = [...document.querySelectorAll(".prompt-box-send-btn")].filter(button =>
        button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).length;
      window.navigationComposerFrames.push({ homeActive, opacity, visibleButtons,
        sendPainted: !!painted && send.contains(painted), paintedClass: painted?.getAttribute("class"),
        sendTop: rect?.top, sendBottom: rect?.bottom, viewportHeight: innerHeight,
        attachPainted: !!attachPainted && attach.contains(attachPainted),
        boxTop: boxRect?.top, boxBottom: boxRect?.bottom,
        controlsInViewport: [rect, attachRect].every(bounds => bounds && bounds.top >= 0 &&
          bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth) });
      if (window.sampleNavigationComposer) requestAnimationFrame(sample);
    };
    sample();
  });
  try {
    await navigate();
    await page.waitForTimeout(400);
  } finally {
    await page.evaluate(() => { window.sampleNavigationComposer = false; });
  }
  const frames = await page.evaluate(() => window.navigationComposerFrames);
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.ok(frame.opacity > 0.99 && frame.visibleButtons === 1 && frame.sendPainted &&
      frame.attachPainted && frame.controlsInViewport,
      `navigation keeps the input and both controls visible, even when draft heights differ: ${JSON.stringify(frame)}`);
    assert.ok(Math.abs(frame.boxBottom - frames[0].boxBottom) < 1 &&
      Math.abs(frame.sendBottom - frames[0].sendBottom) < 1,
      `different-height drafts keep the composer and controls bottom-anchored: ${JSON.stringify(frame)}`);
  }
}

for (const reducedMotion of ["no-preference", "reduce"]) {
  test(`conversation switching opens the final layout and centered graph (${reducedMotion})`, { timeout: 60_000 }, async () => {
    const repository = "/mock/project";
    const config = { repository, model: "test/model", maxParallel: 2, maxFeedback: 3, autoApprove: false };
    const makeSnapshot = (runId, names) => ({
      runId, config, planType: "graph", phase: "completed", approved: true, paused: false,
      planningId: `plan-${runId}`,
      graph: { originalGoal: `Goal ${runId}`, nodes: names.map(name => ({ name, task: `Task ${name}` })),
        edges: names.slice(1).map((name, index) => ({ from: names[index], to: name, feedback: false })) },
      nodes: Object.fromEntries(names.map(name => [name, { status: "completed" }])),
      plan: null, executions: [], events: [], base: "", feedbackCounts: {},
    });
    const snapshots = {
      a: makeSnapshot("a", ["shared", "alpha"]), b: makeSnapshot("b", ["shared", "beta", "gamma"]),
      c: makeSnapshot("c", []), d: { ...makeSnapshot("d", ["task"]), planType: "serial", planningId: undefined,
        executions: [{ id: "exec-d", node: "task", status: "completed", output: "", revision: 1, attempt: 1,
          startedAt: 1, completedAt: 2, sessionId: "session-d", worktree: repository, before: "", after: "" }] },
    };
    const hasGraph = id => snapshots[id].planType === "graph" && snapshots[id].graph.nodes.length > 0;
    const transcript = id => {
      const text = `TRANSCRIPT_${id}: ` + "Conversation text should wrap at its final width. 中文内容也不应在显示后重新换行。 ".repeat(16);
      return JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
    };
    const empty = { ...makeSnapshot("", []), planningId: undefined, config: null, phase: "draft", approved: false };
    const repositoryInfo = { path: repository, name: "Project", branch: "main", head: "", clean: true };
    const errors = [];
    let rejectNodeMessage = false;
    const server = await createServer({ cacheDir: "node_modules/.vite-graph-switching", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false } });
    let browser;
    try {
      await server.listen();
      browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 768 }, reducedMotion });
      await context.addInitScript(({ repository, config }) => {
        localStorage.setItem("grapher_language_v1", "en");
        localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Project", lastOpened: 1 }]));
        localStorage.setItem("grapher_config", JSON.stringify(config));
      }, { repository, config });
      await context.route("**/api/*", async route => {
        const command = new URL(route.request().url()).pathname.slice(5);
        const body = route.request().postDataJSON();
        let result;
        switch (command) {
          case "bootstrap": case "save_config": result = { config, snapshot: empty, runs: Object.keys(snapshots), repositoryInfo, dataPath: "/mock/.grapher" }; break;
          case "history": result = snapshots[body.runId] || empty; break;
          // Paint the previous view while metadata is in flight, as on a cold history read.
          case "snapshot": await new Promise(resolve => setTimeout(resolve, 80)); result = snapshots[body.runId] || empty; break;
          case "snapshot_if_changed": result = { version: "1", snapshot: snapshots[body.runId] || null }; break;
          case "get_planning_output": {
            // The overview must remain hidden through a slow cold-history read.
            await new Promise(resolve => setTimeout(resolve, 450));
            const id = body.planningId.slice(5);
            const content = transcript(id);
            result = { planningId: body.planningId, role: "planner", content, startOffset: 0,
              nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), complete: true, running: false }; break;
          }
          case "get_execution_output": {
            const content = transcript(body.runId);
            result = { runId: body.runId, executionId: body.executionId, content, startOffset: 0,
              nextOffset: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content), complete: true, status: "completed" }; break;
          }
          case "control":
            assert.equal(body.action, "intervene");
            if (rejectNodeMessage) {
              await route.fulfill({ status: 500, json: { error: "Mock rejected draft" } });
              return;
            }
            result = snapshots[body.runId]; break;
          case "repository_status": result = { repository, valid: true, error: null }; break;
          case "detect_repository": result = repositoryInfo; break;
          case "list_plannings": result = []; break;
          case "list_files": result = { files: [] }; break;
          case "list_skills": result = { skills: [] }; break;
          case "provider_auth": result = { providers: [], models: [], warning: null }; break;
          default: errors.push(`Unexpected API: ${command}`); result = null;
        }
        try { await route.fulfill({ json: { result } }); } catch { /* Superseded navigation can abort a request. */ }
      });
      snapshots.d.executions[0].outputBytes = Buffer.byteLength(transcript("d"));
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle" });
      const assertGraphVisible = async id => {
        const expected = Object.keys(snapshots[id].nodes).sort();
        await page.waitForFunction(expected => {
          const nodes = [...document.querySelectorAll(".graph-canvas .react-flow__node")];
          const names = nodes.map(node => node.dataset.id).sort();
          return JSON.stringify(names) === JSON.stringify(expected) && nodes.every(node => {
            const rect = node.getBoundingClientRect();
            const canvas = node.closest(".graph-canvas").getBoundingClientRect();
            return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
              rect.right > canvas.left && rect.left < canvas.right && rect.bottom > canvas.top && rect.top < canvas.bottom;
          });
        }, expected);
        assert.deepEqual(await page.locator(".graph-canvas .react-flow__node").evaluateAll(nodes => nodes.map(node => node.dataset.id).sort()), expected);
      };
      const switchAndMeasure = async id => {
        await page.waitForFunction(() => !document.querySelector(".pane-bottom-chat .prompt-box-container")?.hasAttribute("data-resizing"));
        const sourceComposer = await page.evaluate(() => {
          const workbench = document.querySelector(".workbench");
          const box = workbench?.querySelector(".prompt-box-container");
          if (!box) return null;
          const rect = box.getBoundingClientRect();
          return { x: rect.x, y: rect.y, graph: !!workbench.querySelector(".graph-pane") };
        });
        // Sample painted target content from the first frame, not after Playwright
        // has waited for the layout/animation to become stable.
        await page.evaluate(({ id, expectedNames }) => {
          window.switchFrames = [];
          window.summaryFrames = [];
          window.composerFrames = [];
          window.workbenchChanges = 0;
          window.switchSamplingCompleted = false;
          let previousWorkbench = document.querySelector(".workbench");
          const sourceWorkbench = previousWorkbench;
          const started = performance.now();
          const sample = () => {
            const workbench = document.querySelector(".workbench");
            if (workbench !== previousWorkbench) {
              if (workbench) window.workbenchChanges++;
              previousWorkbench = workbench;
            }
            const composer = workbench !== sourceWorkbench && workbench?.querySelector(".prompt-box-container");
            if (composer) {
              const rect = composer.getBoundingClientRect();
              const arrow = composer.querySelector(".prompt-box-send-btn > span");
              const transform = arrow ? new DOMMatrixReadOnly(getComputedStyle(arrow).transform) : null;
              const angle = transform ? Math.atan2(transform.b, transform.a) * 180 / Math.PI : 0;
              const expectedAngle = composer.querySelector("textarea").value.trim() ? -90 : 0;
              const send = composer.querySelector(".prompt-box-send-btn");
              const sendRect = send.getBoundingClientRect();
              const attach = composer.querySelector(".prompt-box-left-actions .prompt-box-icon-btn");
              const painted = document.elementFromPoint(sendRect.x + sendRect.width / 2, sendRect.y + sendRect.height / 2);
              window.composerFrames.push({ x: rect.x, y: rect.y,
                sendPainted: !!painted && send.contains(painted), paintedTag: painted?.getAttribute("class"),
                arrowPresent: !!arrow, attachOpacity: Number(getComputedStyle(attach).opacity),
                opacity: Number(getComputedStyle(composer).opacity), arrowError: Math.abs(angle - expectedAngle),
                visible: composer.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) });
            }
            const output = [...document.querySelectorAll(".planning-activity-output, [data-execution-id]")].find(el => el.textContent.includes(`TRANSCRIPT_${id}:`));
            const stream = output?.closest(".chat-messages-stream");
            const scroll = document.querySelector(".initial-query-scroll");
            const summary = document.querySelector(".plan-summary-card");
            const summaryNames = [...(summary?.querySelectorAll(".chip-name") ?? [])].map(el => el.textContent).sort();
            if (summary && JSON.stringify(summaryNames) === JSON.stringify(expectedNames) && +getComputedStyle(scroll).opacity > 0) {
              const rect = summary.getBoundingClientRect();
              window.summaryFrames.push({ width: rect.width, height: rect.height, top: rect.top, historyReady: !!stream && +getComputedStyle(stream).opacity > 0 });
            }
            if (stream && +getComputedStyle(stream).opacity > 0 && +getComputedStyle(scroll).opacity > 0) {
              const pane = stream.closest(".conversation-pane");
              const content = output.getBoundingClientRect();
              const frame = { width: pane.getBoundingClientRect().width, textWidth: content.width, textHeight: content.height,
                graphPanes: document.querySelectorAll(".graph-pane").length };
              const flow = document.querySelector(".graph-canvas .react-flow");
              const graphPane = flow?.closest(".graph-pane");
              const nodes = [...document.querySelectorAll(".graph-canvas .react-flow__node")];
              if (flow && +getComputedStyle(flow).opacity > 0 && +getComputedStyle(graphPane).opacity > 0 && nodes.length) {
                const canvas = flow.getBoundingClientRect(), rects = nodes.map(node => node.getBoundingClientRect());
                frame.centerX = (Math.min(...rects.map(r => r.left)) + Math.max(...rects.map(r => r.right))) / 2 - (canvas.left + canvas.right) / 2;
                frame.centerY = (Math.min(...rects.map(r => r.top)) + Math.max(...rects.map(r => r.bottom))) / 2 - (canvas.top + canvas.bottom) / 2;
              }
              window.switchFrames.push(frame);
            }
            if (performance.now() - started < 900) requestAnimationFrame(sample);
            else window.switchSamplingCompleted = true;
          };
          requestAnimationFrame(sample);
          document.querySelector(`[data-run-id="${id}"]`).click();
        }, { id, expectedNames: Object.keys(snapshots[id].nodes).sort() });
        await page.waitForFunction(() => window.switchSamplingCompleted);
        const { frames, summaries, changes, composers } = await page.evaluate(() => ({
          frames: window.switchFrames, summaries: window.summaryFrames, changes: window.workbenchChanges,
          composers: window.composerFrames,
        }));
        if (sourceComposer && sourceComposer.graph !== hasGraph(id) && reducedMotion === "no-preference") {
          const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
          const destination = composers.at(-1);
          assert.ok(destination && distance(sourceComposer, destination) > 4, `${id}: split and full-width inputs occupy different positions`);
          assert.ok(composers.some(frame => distance(frame, sourceComposer) > 1 && distance(frame, destination) > 1),
            `${id}: graph/full-width navigation preserves the composer's position animation in both directions`);
          const dx = destination.x - sourceComposer.x, dy = destination.y - sourceComposer.y;
          const length = Math.hypot(dx, dy);
          let previousProgress = -1;
          for (const frame of composers) {
            const progress = ((frame.x - sourceComposer.x) * dx + (frame.y - sourceComposer.y) * dy) / (length * length);
            assert.ok(progress + 1 / length >= previousProgress, `${id}: input movement must not jump backwards or restart mid-handoff`);
            previousProgress = Math.max(previousProgress, progress);
          }
        }
        if (sourceComposer) {
          assert.ok(composers.length > 0, `${id}: incoming input must be painted`);
          for (const frame of composers) {
            assert.ok(frame.visible && frame.opacity > 0.99, `${id}: the shared input stays opaque instead of flashing during navigation`);
            assert.ok(frame.arrowPresent && frame.arrowError < 0.1, `${id}: navigation must not replay or replace the idle send arrow`);
            assert.ok(frame.attachOpacity > 0.99, `${id}: navigation must not briefly dim the restored input controls`);
            assert.ok(frame.sendPainted, `${id}: the moving input must not be clipped or covered: ${JSON.stringify(frame)}`);
          }
        }
        assert.equal(changes, 1, `${id}: switching must not remount the previous conversation while metadata loads`);
        assert.ok(frames.length > 0, `target ${id} must be painted`);
        const last = frames.at(-1);
        for (const frame of frames) {
          assert.ok(Math.abs(frame.width - last.width) <= 1, `${id}: conversation width changed after reveal (${frame.width} -> ${last.width})`);
          assert.ok(Math.abs(frame.textWidth - last.textWidth) <= 1 && Math.abs(frame.textHeight - last.textHeight) <= 1,
            `${id}: conversation text rewrapped after reveal`);
          if (!hasGraph(id)) assert.equal(frame.graphPanes, 0, `${id}: no departing graph should affect the new conversation`);
        }
        if (hasGraph(id)) {
          assert.ok(summaries.length > 0, `${id}: overview must be painted`);
          const finalSummary = summaries.at(-1);
          for (const summary of summaries) {
            assert.ok(summary.historyReady, `${id}: overview appeared before history was ready`);
            assert.ok(Math.abs(summary.width - finalSummary.width) <= 1 && Math.abs(summary.height - finalSummary.height) <= 1 &&
              Math.abs(summary.top - finalSummary.top) <= 2, `${id}: overview moved or rewrapped after reveal`);
          }
          const graphFrames = frames.filter(frame => frame.centerX !== undefined);
          assert.ok(graphFrames.length > 0, `${id}: graph must be painted`);
          for (const frame of graphFrames) {
            assert.ok(Math.abs(frame.centerX) <= 3 && Math.abs(frame.centerY) <= 3,
              `${id}: graph is not centered when visible (${frame.centerX}, ${frame.centerY})`);
          }
          await assertGraphVisible(id);
        }
      };
      // Cover every direction, including both no-graph entry and return paths.
      // Drafts are owned by their conversation, not by the currently mounted input.
      const drafts = new Map();
      const composer = page.locator(".pane-bottom-chat textarea");
      for (const id of ["c", "d", "c", "d", "a", "b", "c", "a", "d"]) {
        await switchAndMeasure(id);
        assert.equal(await composer.inputValue(), drafts.get(id) ?? "", `${id}: restores only its own unsent text`);
        if (!drafts.has(id)) {
          const draft = id === "b" ? "Long graph draft\n".repeat(24) : `Unsent draft for ${id}\n中文内容 and a second line`;
          await composer.fill(draft);
          drafts.set(id, draft);
        }
      }
      await page.locator('[data-run-id="b"]').click();
      await assertGraphVisible("b");
      await waitForComposerSettled(page, ".pane-bottom-chat .prompt-box-container");
      await page.evaluate(() => {
        window.recordComposerFrames = [];
        window.sampleRecordComposer = true;
        const sample = () => {
          const box = document.querySelector(".pane-bottom-chat .prompt-box-container");
          const rect = box.getBoundingClientRect();
          const actions = box.querySelector(".prompt-box-actions-row").getBoundingClientRect();
          window.recordComposerFrames.push({ x: rect.x, bottom: rect.bottom, width: rect.width, actionsBottom: actions.bottom,
            visible: box.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) });
          if (window.sampleRecordComposer) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      for (const text of ["More lines\n".repeat(4), "Short", "Scrollable input\n".repeat(40), drafts.get("b")]) {
        await composer.fill(text);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      const recordFrames = await page.evaluate(() => { window.sampleRecordComposer = false; return window.recordComposerFrames; });
      assert.ok(recordFrames.length > 0);
      for (const frame of recordFrames) {
        const first = recordFrames[0];
        assert.ok(frame.visible, "the record-page input never disappears while editing");
        assert.ok(Math.abs(frame.x - first.x) < 1 && Math.abs(frame.width - first.width) < 1 &&
          Math.abs(frame.bottom - first.bottom) < 1 && Math.abs(frame.actionsBottom - first.actionsBottom) < 1,
          `record-page auto-growing/shrinking does not displace the input or controls: ${JSON.stringify(frame)}`);
      }
      await page.locator('.react-flow__node[data-id="shared"]').click();
      await assertGraphVisible("b");
      assert.equal(await composer.inputValue(), "", "node draft is separate from Planner");
      await composer.fill("Unsent shared-node draft");
      await page.locator(".back-to-query-btn").click();
      assert.equal(await composer.inputValue(), drafts.get("b"));
      await page.locator('.react-flow__node[data-id="shared"]').click();
      assert.equal(await composer.inputValue(), "Unsent shared-node draft");
      rejectNodeMessage = true;
      await composer.press("Enter");
      await page.getByRole("alert").filter({ hasText: "Mock rejected draft" }).waitFor();
      await page.locator(".floating-error-close").click();
      await page.getByRole("alert").filter({ hasText: "Mock rejected draft" }).waitFor({ state: "detached" });
      await page.waitForFunction(() => !document.querySelector(".pane-bottom-chat textarea").disabled);
      await page.locator(".back-to-query-btn").click();
      await page.locator('.react-flow__node[data-id="shared"]').click();
      assert.equal(await composer.inputValue(), "Unsent shared-node draft", "rejection preserves the target's draft across navigation");
      rejectNodeMessage = false;
      await composer.press("Enter");
      await page.waitForFunction(() => document.querySelector(".pane-bottom-chat textarea").value === "");
      await page.locator(".back-to-query-btn").click();
      assert.equal(await composer.inputValue(), drafts.get("b"), "acceptance does not clear Planner's draft");
      await page.locator('.react-flow__node[data-id="shared"]').click();
      assert.equal(await composer.inputValue(), "", "an accepted draft does not reappear on return");
      await composer.fill("Unsent shared-node draft");

      const assertHomeVisible = () => page.waitForFunction(() => {
        const home = document.querySelector(".landing-screen");
        const title = home?.querySelector(".landing-title-copy");
        const input = home?.querySelector("textarea");
        return home && getComputedStyle(home).opacity === "1" && !home.inert &&
          title?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
          input?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }, undefined, { timeout: 5000 });
      await waitForComposerSettled(page, ".pane-bottom-chat .prompt-box-container");
      const sourceComposer = await page.locator(".pane-bottom-chat .prompt-box-container").boundingBox();
      await page.evaluate(() => {
        window.homeComposerFrames = [];
        window.sampleHomeComposer = true;
        const sample = () => {
          const box = document.querySelector(".landing-screen .prompt-box-container");
          if (box) {
            const rect = box.getBoundingClientRect();
            let opacity = 1;
            for (let element = box; element; element = element.parentElement) {
              const style = getComputedStyle(element);
              opacity *= Number(style.opacity);
              if (style.visibility === "hidden" || style.display === "none") opacity = 0;
            }
            const send = box.querySelector(".prompt-box-send-btn");
            const sendRect = send.getBoundingClientRect();
            const painted = document.elementFromPoint(sendRect.x + sendRect.width / 2, sendRect.y + sendRect.height / 2);
            window.homeComposerFrames.push({ x: rect.x, y: rect.y, opacity,
              sendPainted: !!painted && send.contains(painted) });
          }
          if (window.sampleHomeComposer) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await page.locator(".graph-pane").waitFor({ state: "detached" });
      await assertHomeVisible();
      await waitForComposerSettled(page, ".landing-screen .prompt-box-container");
      const homeFrames = await page.evaluate(() => { window.sampleHomeComposer = false; return window.homeComposerFrames; });
      const destinationComposer = await page.locator(".landing-screen .prompt-box-container").boundingBox();
      assert.ok(homeFrames.length > 0, "returning home samples the input from its first mounted frame");
      for (const frame of homeFrames) {
        assert.ok(frame.opacity > 0.99 && frame.sendPainted,
          `returning home must not fade, hide or cover the input through any ancestor: ${JSON.stringify(frame)}`);
      }
      if (reducedMotion === "no-preference") {
        const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        assert.ok(distance(sourceComposer, destinationComposer) > 4, "node and home composers have different positions");
        assert.ok(homeFrames.some(frame => distance(frame, sourceComposer) > 1 && distance(frame, destinationComposer) > 1),
          "returning home preserves the shared composer position animation, not just a crossfade");
      }
      assert.equal(await page.locator(".landing-screen textarea").inputValue(), "", "node draft does not leak into home");
      await page.locator('[data-run-id="b"]').click();
      await assertGraphVisible("b");
      assert.equal(await composer.inputValue(), drafts.get("b"));

      // Re-enter while the previous home is still exiting, not only after a
      // completed transition. Its copy and composer must recover their opacity.
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await assertHomeVisible();
      await page.locator('[data-run-id="b"]').evaluate(card => card.click());
      await page.waitForFunction(() => !document.querySelector(".app-shell").classList.contains("landing-active"));
      await page.getByRole("button", { name: "New conversation", exact: true }).evaluate(button => button.click());
      await assertHomeVisible();
      await page.locator('[data-run-id="b"]').click();
      await assertGraphVisible("b");
      assert.equal(await composer.inputValue(), drafts.get("b"));

      // Switching from home to a conversation without a graph (serial / no graph)
      // must preserve the composer's resting position without abrupt vertical jitter
      // and without ghosting duplicate send buttons during the handoff.
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await assertHomeVisible();
      await waitForComposerSettled(page, ".landing-screen .prompt-box-container");
      const homeBox = await page.locator(".landing-screen .prompt-box-container").boundingBox();

      await page.evaluate(() => {
        window.homeToNoGraphFrames = [];
        window.sampleHomeToNoGraph = true;
        const start = performance.now();
        const sample = () => {
          const homeActive = document.querySelector(".app-shell").classList.contains("landing-active");
          const box = document.querySelector(homeActive
            ? ".landing-screen .prompt-box-container" : ".pane-bottom-chat .prompt-box-container");
          if (box) {
            const rect = box.getBoundingClientRect();
            const visibleSendButtons = [...document.querySelectorAll(".prompt-box-send-btn")].filter(
              btn => btn.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            );
            let opacity = 1;
            for (let element = box; element; element = element.parentElement) {
              const style = getComputedStyle(element);
              opacity *= Number(style.opacity);
              if (style.visibility === "hidden" || style.display === "none") opacity = 0;
            }
            window.homeToNoGraphFrames.push({
              time: Math.round(performance.now() - start),
              x: rect.x, y: rect.y, width: rect.width, height: rect.height,
              visibleButtons: visibleSendButtons.length, opacity,
            });
          }
          if (window.sampleHomeToNoGraph) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });

      await page.locator('.run-item[data-run-id="d"]').click();
      await page.waitForFunction(() => !document.querySelector(".app-shell").classList.contains("landing-active"));
      await page.waitForFunction(() => {
        const stream = document.querySelector(".chat-messages-stream");
        const scroll = document.querySelector(".initial-query-scroll");
        return stream && scroll && +getComputedStyle(stream).opacity > 0 && +getComputedStyle(scroll).opacity > 0;
      });
      await waitForComposerSettled(page, ".pane-bottom-chat .prompt-box-container");

      const switchFrames = await page.evaluate(() => {
        window.sampleHomeToNoGraph = false;
        return window.homeToNoGraphFrames;
      });
      assert.ok(switchFrames.length > 0, "frames captured during Home -> No-graph transition");
      const finalSwitchBox = switchFrames.at(-1);
      const homeBottom = homeBox.y + homeBox.height;
      const finalSwitchBottom = finalSwitchBox.y + finalSwitchBox.height;
      assert.ok(Math.abs(homeBox.x - finalSwitchBox.x) <= 2, "composer stays centered horizontally");
      assert.ok(Math.abs(homeBottom - finalSwitchBottom) <= 2, "composer bottom remains viewport-anchored between home and conversation");
      for (const frame of switchFrames) {
        assert.ok(frame.visibleButtons === 1 && frame.opacity > 0.99,
          `home/history navigation keeps one opaque input instead of a full-view fade: ${JSON.stringify(frame)}`);
      }

      // Serial history, Planner history and restored multiline home drafts must
      // stay opaque too, including a reversal before the previous home exits.
      const newConversation = page.getByRole("button", { name: "New conversation", exact: true });
      await assertOpaqueComposerNavigation(page, () => newConversation.click());
      await assertHomeVisible();
      const homeDraft = "Restored very long home draft 中文\n".repeat(40);
      await page.locator(".landing-screen textarea").fill(homeDraft);
      await page.waitForFunction(() => !document.querySelector(".landing-screen .prompt-box-container").hasAttribute("data-resizing"));
      await assertOpaqueComposerNavigation(page, () => page.locator('[data-run-id="a"]').click());
      await assertGraphVisible("a");
      await assertOpaqueComposerNavigation(page, () => newConversation.click());
      assert.equal(await page.locator(".landing-screen textarea").inputValue(), homeDraft);
      await assertOpaqueComposerNavigation(page, async () => {
        await page.locator('[data-run-id="d"]').evaluate(card => card.click());
        await page.waitForFunction(() => !document.querySelector(".app-shell").classList.contains("landing-active"));
        await newConversation.evaluate(button => button.click());
      });
      await assertHomeVisible();
      assert.equal(await page.locator(".landing-screen textarea").inputValue(), homeDraft);

      // Run-to-Run handoffs must also handle a tall destination, not only a tall
      // departing draft. Node-specific drafts must not change Planner's draft.
      await assertOpaqueComposerNavigation(page, () => page.locator('[data-run-id="b"]').click());
      await assertGraphVisible("b");
      await assertOpaqueComposerNavigation(page, () => page.locator('.react-flow__node[data-id="shared"]').click());
      const nodeDraft = "Very long node draft 中文\n".repeat(40);
      await composer.fill(nodeDraft);
      await page.waitForFunction(() => !document.querySelector(".pane-bottom-chat .prompt-box-container").hasAttribute("data-resizing"));
      await assertOpaqueComposerNavigation(page, () => page.locator(".back-to-query-btn").click());
      assert.equal(await composer.inputValue(), drafts.get("b"));
      await assertOpaqueComposerNavigation(page, () => page.locator('[data-run-id="d"]').click());
      await assertOpaqueComposerNavigation(page, () => page.locator('[data-run-id="b"]').click());
      await assertOpaqueComposerNavigation(page, () => page.locator('.react-flow__node[data-id="shared"]').click());
      assert.equal(await composer.inputValue(), nodeDraft);
      await assertOpaqueComposerNavigation(page, () => newConversation.click());

      // A smaller viewport must not hide either control, including a handoff
      // from the 80dvh expanded editor into a short history input and back.
      for (const height of [480, 360]) {
        await page.setViewportSize({ width: 1280, height });
        await waitForComposerSettled(page, ".landing-screen .prompt-box-container");
        await page.getByRole("button", { name: "Expand input", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector(".landing-screen .prompt-box-container").hasAttribute("data-resizing"));
        await assertOpaqueComposerNavigation(page, () => page.locator('[data-run-id="d"]').click());
        await assertOpaqueComposerNavigation(page, () => newConversation.click());
        await assertHomeVisible();
        assert.equal(await page.locator(".landing-screen textarea").inputValue(), homeDraft);
      }
      await page.setViewportSize({ width: 1280, height: 768 });

      // Superseded initialization callbacks must not restore an older graph.
      for (const id of ["a", "c", "b", "d"]) {
        await page.locator(`.run-item[data-run-id="${id}"]`).evaluate(card => card.click());
      }
      await page.locator('.run-item[data-run-id="a"]').click();
      await assertGraphVisible("a");
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
}
