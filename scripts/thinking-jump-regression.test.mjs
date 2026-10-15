import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const line = event => JSON.stringify(event) + "\n";
const assistant = text => line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

test("switching conversation records to a settled conversation containing an expanded thinking card does not jump or replay entrance animation", { timeout: 35_000 }, async () => {
  const server = await createServer({
    cacheDir: "node_modules/.vite-thinking-jump-test",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
    plugins: [{
      name: "test-fixtures",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url.startsWith("/__history")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml(req.url, `<html><body><div id="root" style="padding:32px"></div><script type="module" src="/scripts/fixtures/frontend-audit.tsx"></script></body></html>`));
        });
      }
    }]
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await chromium.launch({
    channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"),
    headless: true,
  });

  try {
    const config = { repository: "/mock/repo", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
    const empty = {
      runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
      plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {},
    };

    const runs = {
      "run-a": {
        ...empty,
        runId: "run-a",
        config,
        planType: "graph",
        phase: "completed",
        approved: true,
        planningId: "plan-a",
        graph: { originalGoal: "Goal A", nodes: [{ name: "node-a", task: "Task A" }], edges: [] },
        nodes: { "node-a": { status: "done", revision: 1, instruction: "", error: null } },
        executions: [],
        events: [{ type: "created", sequence: 1, planning_id: "plan-a", timestamp: 1 }],
      },
      "run-b": {
        ...empty,
        runId: "run-b",
        config,
        planType: "graph",
        phase: "completed",
        approved: true,
        planningId: "plan-b",
        graph: { originalGoal: "Goal B", nodes: [{ name: "node-b", task: "Task B" }], edges: [] },
        nodes: { "node-b": { status: "done", revision: 1, instruction: "", error: null } },
        executions: [],
        events: [{ type: "created", sequence: 1, planning_id: "plan-b", timestamp: 1 }],
      },
    };

    const planBOutput = [
      line({ type: "message_start", message: { role: "assistant", content: [] } }),
      line({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }),
      line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Reasoning step 1: analyzing the codebase\nReasoning step 2: identifying patterns\nReasoning step 3: forming a plan\nReasoning step 4: finalizing details" } }),
      line({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }),
      line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Final plan output content." } }),
      line({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Reasoning step 1: analyzing the codebase\nReasoning step 2: identifying patterns\nReasoning step 3: forming a plan\nReasoning step 4: finalizing details" }, { type: "text", text: "Final plan output content." }] } }),
    ].join("");

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "zh-CN"));

    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap":
          result = {
            config, snapshot: empty, runs: Object.keys(runs),
            repositoryInfo: { path: config.repository, name: "Jump test", branch: "main", head: "", clean: true },
            dataPath: "/mock",
          };
          break;
        case "snapshot":
        case "history":
          result = runs[body.runId];
          break;
        case "snapshot_if_changed":
          result = { version: body.runId, snapshot: null };
          break;
        case "repository_status":
          result = { repository: config.repository, valid: true, error: null };
          break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
        case "get_planning_output": {
          const text = body.planningId === "plan-b" ? planBOutput : assistant("Plan A Output");
          const bytes = Buffer.from(text);
          const start = body.offset || 0;
          result = {
            planningId: body.planningId, role: "planner", content: bytes.subarray(start).toString(),
            startOffset: start, nextOffset: bytes.length, totalBytes: bytes.length, complete: true, running: false,
          };
          break;
        }
        default:
          result = {};
      }
      await route.fulfill({ json: { result } });
    });

    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded" });

    // Open run-a first
    await page.locator('.run-item[data-run-id="run-a"]').click();
    await page.getByText("Plan A Output").waitFor();

    // Switch to run-b
    await page.locator('.run-item[data-run-id="run-b"]').click();
    const card = page.locator(".thinking-card");
    await card.waitFor();

    // Ensure it is expanded
    const isExpanded = (await card.getAttribute("class")).includes("expanded");
    if (!isExpanded) {
      await card.locator(".thinking-card-header").click();
      await page.waitForFunction(() => document.querySelector(".thinking-card")?.classList.contains("expanded"));
    }

    // Switch back to run-a
    await page.locator('.run-item[data-run-id="run-a"]').click();
    await page.getByText("Plan A Output").waitFor();

    // Setup frame-by-frame tracker before switching to run-b
    await page.evaluate(() => {
      window.cardSamples = [];
      window.sampleActive = true;
      const sample = () => {
        const card = document.querySelector(".thinking-card");
        if (card) {
          const r = card.getBoundingClientRect();
          const cs = getComputedStyle(card);
          window.cardSamples.push({
            time: Math.round(performance.now()),
            top: Math.round(r.top * 100) / 100,
            height: Math.round(r.height * 100) / 100,
            transform: cs.transform,
            hasAppearClass: card.classList.contains("appear-active"),
            anims: card.getAnimations().map(a => a.animationName),
          });
        }
        if (window.sampleActive) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    // Switch to run-b with tracking
    await page.locator('.run-item[data-run-id="run-b"]').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.sampleActive = false; });

    const samples = await page.evaluate(() => window.cardSamples);
    assert.ok(samples.length > 5, "samples should be captured across frames");

    // The card must NOT play appear animation and must NOT jump
    for (const s of samples) {
      assert.ok(!s.hasAppearClass, `card must not have appear-active on conversation switch: ${JSON.stringify(s)}`);
      assert.ok(s.transform === "none" || s.transform === "matrix(1, 0, 0, 1, 0, 0)",
        `card transform must stay unscaled without jump: ${JSON.stringify(s)}`);
      assert.ok(!s.anims.includes("transcript-card-appear"),
        `transcript-card-appear must not play on conversation switch: ${JSON.stringify(s)}`);
    }

    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
});

test("switching conversation records to an active planning conversation containing an expanded thinking card does not jump or replay entrance animation", { timeout: 35_000 }, async () => {
  const server = await createServer({
    cacheDir: "node_modules/.vite-thinking-jump-test2",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
    plugins: [{
      name: "test-fixtures",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url.startsWith("/__history")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml(req.url, `<html><body><div id="root" style="padding:32px"></div><script type="module" src="/scripts/fixtures/frontend-audit.tsx"></script></body></html>`));
        });
      }
    }]
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await chromium.launch({
    channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"),
    headless: true,
  });

  try {
    const config = { repository: "/mock/repo", model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
    const empty = {
      runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
      plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {},
    };

    const runs = {
      "run-a": {
        ...empty,
        runId: "run-a",
        config,
        planType: "graph",
        phase: "completed",
        approved: true,
        planningId: "plan-a",
        graph: { originalGoal: "Goal A", nodes: [{ name: "node-a", task: "Task A" }], edges: [] },
        nodes: { "node-a": { status: "done", revision: 1, instruction: "", error: null } },
        executions: [],
        events: [{ type: "created", sequence: 1, planning_id: "plan-a", timestamp: 1 }],
      },
      "run-b": {
        ...empty,
        runId: "run-b",
        config,
        planType: "graph",
        phase: "planning",
        approved: false,
        planningId: "plan-b",
        graph: { originalGoal: "Goal B", nodes: [], edges: [] },
        nodes: {},
        executions: [],
        events: [{ type: "created", sequence: 1, planning_id: "plan-b", timestamp: 1 }],
        planning: {
          planningId: "plan-b",
          repository: "/mock/repo",
          status: "running",
          createdAt: Date.now() - 10000,
          roles: { planner: { status: "running" } },
        },
      },
    };

    const planBOutput = [
      line({ type: "message_start", message: { role: "assistant", content: [] } }),
      line({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }),
      line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Reasoning step 1: analyzing the codebase\nReasoning step 2: identifying patterns\nReasoning step 3: forming a plan\nReasoning step 4: finalizing details" } }),
    ].join("");

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "zh-CN"));

    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap":
          result = {
            config, snapshot: empty, runs: Object.keys(runs),
            repositoryInfo: { path: config.repository, name: "Jump test", branch: "main", head: "", clean: true },
            dataPath: "/mock",
          };
          break;
        case "snapshot":
        case "history":
          result = runs[body.runId];
          break;
        case "snapshot_if_changed":
          result = { version: body.runId, snapshot: null };
          break;
        case "repository_status":
          result = { repository: config.repository, valid: true, error: null };
          break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [{ id: "test", name: "Test", configured: true, methods: [] }], models: [], warning: null }; break;
        case "get_planning_output": {
          const text = body.planningId === "plan-b" ? planBOutput : assistant("Plan A Output");
          const bytes = Buffer.from(text);
          const start = body.offset || 0;
          result = {
            planningId: body.planningId, role: "planner", content: bytes.subarray(start).toString(),
            startOffset: start, nextOffset: bytes.length, totalBytes: bytes.length, complete: false, running: true,
          };
          break;
        }
        default:
          result = {};
      }
      await route.fulfill({ json: { result } });
    });

    const page = await context.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded" });

    // Open run-a first
    await page.locator('.run-item[data-run-id="run-a"]').click();
    await page.getByText("Plan A Output").waitFor();

    // Switch to run-b first to let it mount
    await page.locator('.run-item[data-run-id="run-b"]').click();
    const card = page.locator(".thinking-card");
    await card.waitFor();
    assert.ok((await card.getAttribute("class")).includes("expanded"), "card in running plan must be expanded");

    // Switch back to run-a
    await page.locator('.run-item[data-run-id="run-a"]').click();
    await page.getByText("Plan A Output").waitFor();

    // Setup frame-by-frame tracker before switching to run-b
    await page.evaluate(() => {
      window.cardSamples = [];
      window.sampleActive = true;
      const sample = () => {
        const card = document.querySelector(".thinking-card");
        if (card) {
          const r = card.getBoundingClientRect();
          const cs = getComputedStyle(card);
          window.cardSamples.push({
            time: Math.round(performance.now()),
            top: Math.round(r.top * 100) / 100,
            height: Math.round(r.height * 100) / 100,
            transform: cs.transform,
            anims: card.getAnimations().map(a => a.animationName),
          });
        }
        if (window.sampleActive) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    // Switch to run-b with tracking
    await page.locator('.run-item[data-run-id="run-b"]').click();
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.sampleActive = false; });

    const samples = await page.evaluate(() => window.cardSamples);
    assert.ok(samples.length > 5, "samples should be captured across frames");

    // While switching conversation records, the thinking card must not jump
    for (const s of samples) {
      assert.ok(s.transform === "none" || s.transform === "matrix(1, 0, 0, 1, 0, 0)",
        `card transform must stay unscaled without jump: ${JSON.stringify(s)}`);
      assert.ok(!s.anims.includes("transcript-card-appear"),
        `transcript-card-appear must not play on conversation switch: ${JSON.stringify(s)}`);
    }

    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
