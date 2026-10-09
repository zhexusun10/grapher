import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

test("graphs fade in only after fitting when repeatedly switching conversations", { timeout: 90_000 }, async () => {
  const repository = "/mock/project";
  const config = { repository, model: "test/model", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const makeSnapshot = (runId, names) => ({
    runId, config, planType: "graph", phase: "completed", approved: true, paused: false,
    graph: { originalGoal: `Goal ${runId}`, nodes: names.map(name => ({ name, task: `Task ${name}` })),
      edges: names.slice(1).map((name, index) => ({ from: names[index], to: name, feedback: false })) },
    nodes: Object.fromEntries(names.map(name => [name, { status: "done" }])),
    plan: null, executions: [], events: [], base: "", feedbackCounts: {},
  });
  const snapshots = { a: makeSnapshot("a", ["shared", "alpha"]), b: makeSnapshot("b", ["shared", "beta", "gamma"]) };
  const empty = { ...makeSnapshot("", []), config: null, phase: "draft", approved: false };
  const repositoryInfo = { path: repository, name: "Project", branch: "main", head: "", clean: true };
  const errors = [];
  const server = await createServer({ cacheDir: "node_modules/.vite-graph-switching", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 768 } });
    await context.addInitScript(({ repository, config }) => {
      localStorage.setItem("grapher_language_v1", "en");
      localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Project", lastOpened: 1 }]));
      localStorage.setItem("grapher_config", JSON.stringify(config));
      // Sample actual painted opacity, not just the presence of animation props.
      window.graphReveals = [];
      window.composerMotionSamples = [];
      window.recordComposerMotion = false;
      let previousFlow, reveal;
      const sample = () => {
        const flow = document.querySelector(".graph-canvas .react-flow");
        if (flow && flow !== previousFlow) {
          reveal = { samples: [] };
          window.graphReveals.push(reveal);
        }
        previousFlow = flow;
        if (flow && reveal.samples.at(-1)?.opacity !== 1) {
          const nodes = [...flow.querySelectorAll(".react-flow__node")];
          reveal.samples.push({
            opacity: Number(getComputedStyle(flow.closest(".graph-pane")).opacity),
            flowOpacity: Number(getComputedStyle(flow).opacity),
            names: nodes.map(node => node.dataset.id),
            measured: nodes.length > 0 && nodes.every(node => node.offsetWidth > 0 && node.offsetHeight > 0 && getComputedStyle(node).visibility !== "hidden"),
            viewport: flow.querySelector(".react-flow__viewport")?.style.transform,
          });
        }
        if (window.recordComposerMotion) {
          const matrix = element => {
            const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
            return { scaleX: transform.m11, scaleY: transform.m22, x: transform.m41, y: transform.m42 };
          };
          window.composerMotionSamples.push({
            prompts: [...document.querySelectorAll(".main-view-stage .prompt-box-container")].map(matrix),
            parents: [...document.querySelectorAll(".main-view-stage > div, .pane-bottom-chat")].map(matrix),
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { repository, config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": case "save_config": result = { config, snapshot: empty, runs: ["a", "b"], repositoryInfo, dataPath: "/mock/.grapher" }; break;
        case "history": case "snapshot": result = snapshots[body.runId] || empty; break;
        case "snapshot_if_changed": result = { version: "1", snapshot: snapshots[body.runId] || null }; break;
        case "repository_status": result = { repository, valid: true, error: null }; break;
        case "detect_repository": result = repositoryInfo; break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [], models: [], warning: null }; break;
        default: errors.push(`Unexpected API: ${command}`); result = null;
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle" });
    const backgroundPlayback = () => page.locator(".floating-path").evaluateAll(paths => paths.map(path => {
      const animation = path.getAnimations()[0];
      return { time: animation.currentTime, state: animation.playState, offset: getComputedStyle(path).strokeDashoffset };
    }));
    const assertBackgroundPaused = async () => {
      const before = await backgroundPlayback();
      assert.equal(before.length, 36);
      assert.ok(before.every(path => path.state === "paused"), "opening a conversation must pause every background path");
      await page.waitForTimeout(150);
      assert.deepEqual(await backgroundPlayback(), before, "hidden background playback must remain frozen");
      return before;
    };
    assert.ok((await backgroundPlayback()).every(path => path.state === "running"), "the landing page must animate");
    const startComposerSampling = () => page.evaluate(() => {
      window.composerMotionSamples = [];
      window.recordComposerMotion = true;
    });
    const assertGentleComposerMotion = async () => {
      const samples = await page.evaluate(() => {
        window.recordComposerMotion = false;
        return window.composerMotionSamples;
      });
      const prompts = samples.flatMap(sample => sample.prompts);
      assert.ok(prompts.some(prompt => Math.abs(prompt.x) > 0.1 || Math.abs(prompt.y) > 0.1),
        "the shared composer must still slide between pages");
      assert.ok(prompts.every(prompt => Math.abs(prompt.scaleX - 1) < 0.001 && Math.abs(prompt.scaleY - 1) < 0.001),
        "the shared composer must not stretch or squeeze its text/buttons");
      assert.ok(samples.flatMap(sample => sample.parents).every(parent => Math.abs(parent.y) < 0.001),
        "parent entrance/exit motion must not add vertical wobble to the composer handoff");
    };
    const assertGraphVisible = async id => {
      await page.waitForFunction(id => {
        const flow = document.querySelector(".graph-canvas .react-flow");
        const names = [...document.querySelectorAll(".react-flow__node")].map(node => node.dataset.id);
        const expected = id === "a" ? ["shared", "alpha"] : ["shared", "beta", "gamma"];
        return flow && getComputedStyle(flow).opacity === "1" && getComputedStyle(flow.closest(".graph-pane")).opacity === "1" &&
          window.graphReveals.at(-1)?.samples.at(-1)?.opacity === 1 &&
          names.length === expected.length && expected.every(name => names.includes(name));
      }, id, { timeout: 3_000 }).catch(async error => {
        const state = await page.evaluate(() => ({
          paneOpacity: document.querySelector(".graph-pane") && getComputedStyle(document.querySelector(".graph-pane")).opacity,
          flowOpacity: document.querySelector(".react-flow") && getComputedStyle(document.querySelector(".react-flow")).opacity,
          names: [...document.querySelectorAll(".react-flow__node")].map(node => node.dataset.id),
          revealCount: window.graphReveals.length,
          lastSamples: window.graphReveals.at(-1)?.samples.slice(-3),
        }));
        throw new Error(`run ${id} did not become visible: ${JSON.stringify({ state, errors })}`, { cause: error });
      });
      const bounds = await page.locator(".react-flow__node").evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        const canvas = node.closest(".graph-canvas").getBoundingClientRect();
        return { name: node.dataset.id, rect: rect.toJSON(), canvas: canvas.toJSON(), visible: getComputedStyle(node).visibility !== "hidden", inside: rect.right > canvas.left && rect.left < canvas.right && rect.bottom > canvas.top && rect.top < canvas.bottom };
      }));
      assert.ok(bounds.every(node => node.visible && node.inside), `run ${id} must be fitted and visible: ${JSON.stringify(bounds)}`);
      const samples = await page.evaluate(() => window.graphReveals.at(-1).samples);
      assert.equal(samples[0].opacity, 0, `run ${id} must start hidden`);
      const fading = samples.filter(sample => sample.opacity > 0 && sample.opacity < 1);
      assert.ok(fading.length >= 2, `run ${id} must visibly animate, not flash in`);
      const expected = Object.keys(snapshots[id].nodes).sort();
      for (const sample of fading) {
        assert.equal(sample.flowOpacity, 1, "the flow is ready before the panel fades in");
        assert.ok(sample.measured, "every node is measured before the panel fades in");
        assert.deepEqual(sample.names.sort(), expected, "no previous run's nodes appear during the fade");
      }
      assert.equal(new Set(fading.map(sample => sample.viewport)).size, 1, "the fitted viewport must not jump during the fade");
    };
    for (let index = 0; index < 60; index++) {
      const id = index % 2 ? "b" : "a";
      if (index === 0) await startComposerSampling();
      await page.locator(`[data-run-id="${id}"]`).click();
      await assertGraphVisible(id);
      if (index === 0) {
        await assertBackgroundPaused();
        await assertGentleComposerMotion();
      }
    }
    // Selecting a node must not remount or replay the whole graph's entrance.
    const revealCount = await page.evaluate(() => window.graphReveals.length);
    await page.locator('.react-flow__node[data-id="shared"]').click();
    await assertGraphVisible("b");
    assert.equal(await page.evaluate(() => window.graphReveals.length), revealCount);

    // Leaving for the landing page resumes the frozen background without resetting it.
    const pausedBackground = await assertBackgroundPaused();
    await startComposerSampling();
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.locator(".graph-pane").waitFor({ state: "detached" });
    await assertGentleComposerMotion();
    const resumedBackground = await backgroundPlayback();
    assert.ok(resumedBackground.every((path, index) => path.state === "running" && path.time > pausedBackground[index].time),
      "returning home must resume, not restart, background playback");
    await page.locator('[data-run-id="b"]').click();
    await assertGraphVisible("b");
    await assertBackgroundPaused();

    // Switch again before initialization/measurement callbacks can settle.
    for (let index = 0; index < 20; index++) {
      const id = index % 2 ? "b" : "a";
      await page.locator(`[data-run-id="${id}"]`).evaluate(card => card.click());
      await page.waitForTimeout(25);
    }
    await page.locator('[data-run-id="a"]').click();
    await assertGraphVisible("a");
    await assertBackgroundPaused();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
