import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

for (const reducedMotion of ["no-preference", "reduce"]) {
  test(`conversation switching opens the final layout and centered graph (${reducedMotion})`, { timeout: 60_000 }, async () => {
    const repository = "/mock/project";
    const config = { repository, model: "test/model", maxParallel: 2, maxFeedback: 3, autoApprove: false };
    const makeSnapshot = (runId, names) => ({
      runId, config, planType: "graph", phase: "completed", approved: true, paused: false,
      planningId: `plan-${runId}`,
      graph: { originalGoal: `Goal ${runId}`, nodes: names.map(name => ({ name, task: `Task ${name}` })),
        edges: names.slice(1).map((name, index) => ({ from: names[index], to: name, feedback: false })) },
      nodes: Object.fromEntries(names.map(name => [name, { status: "done" }])),
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
    const server = await createServer({ cacheDir: "node_modules/.vite-graph-switching", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false } });
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
        // Sample painted target content from the first frame, not after Playwright
        // has waited for the layout/animation to become stable.
        await page.evaluate(({ id, expectedNames }) => {
          window.switchFrames = [];
          window.summaryFrames = [];
          window.workbenchChanges = 0;
          window.switchSamplingDone = false;
          let previousWorkbench = document.querySelector(".workbench");
          const started = performance.now();
          const sample = () => {
            const workbench = document.querySelector(".workbench");
            if (workbench !== previousWorkbench) {
              if (workbench) window.workbenchChanges++;
              previousWorkbench = workbench;
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
            else window.switchSamplingDone = true;
          };
          requestAnimationFrame(sample);
          document.querySelector(`[data-run-id="${id}"]`).click();
        }, { id, expectedNames: Object.keys(snapshots[id].nodes).sort() });
        await page.waitForFunction(() => window.switchSamplingDone);
        const { frames, summaries, changes } = await page.evaluate(() => ({
          frames: window.switchFrames, summaries: window.summaryFrames, changes: window.workbenchChanges,
        }));
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
      for (const id of ["c", "d", "c", "d", "a", "b", "c", "a", "d"]) await switchAndMeasure(id);
      await page.locator('[data-run-id="b"]').click();
      await assertGraphVisible("b");
      await page.locator('.react-flow__node[data-id="shared"]').click();
      await assertGraphVisible("b");

      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await page.locator(".graph-pane").waitFor({ state: "detached" });
      await page.locator('[data-run-id="b"]').click();
      await assertGraphVisible("b");

      // Superseded initialization callbacks must not restore an older graph.
      for (const id of ["a", "c", "b", "d"]) {
        await page.locator(`[data-run-id="${id}"]`).evaluate(card => card.click());
      }
      await page.locator('[data-run-id="a"]').click();
      await assertGraphVisible("a");
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
}
