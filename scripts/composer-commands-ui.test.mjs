import assert from "node:assert/strict";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

function commandServer() {
  return createServer({ cacheDir: "node_modules/.vite-composer-commands", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null },
    plugins: [{ name: "composer-commands-fixture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/__commands")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/scripts/fixtures/composer-commands.tsx"></script></body></html>'));
      });
    } }] });
}

test("composer model scope, slash completion, blocking and extension dialogs", async () => {
  const server = await commandServer();
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const page = await browser.newPage();
    let pendingExecute;
    let standaloneCatalogs = 0;
    let events = [];
    const responses = [];
    const renames = [];
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.route("**/api/*", async route => {
      const request = route.request();
      const body = request.postDataJSON();
      let result = [];
      if (request.url().endsWith("/list_files")) result = { files: ["docs/app-notes.md", "src/App.tsx", "package.json", "README.md"] };
      if (request.url().endsWith("/list_skills")) result = { skills: [{ name: "demo", description: "Demo", path: "/demo", scope: "workspace" }] };
      if (request.url().endsWith("/provider_auth")) result = { providers: [], warning: null, models: ["one", "two"].map(id => ({ provider: "test", id, name: id, api: "mock", contextWindow: 1000, available: true, thinkingLevels: ["off", "minimal", "low", "high"], thinkingLevelFallbacks: {} })) };
      if (request.url().endsWith("/composer_rename")) {
        renames.push(body);
        result = {
          runId: body.runId,
          title: body.title,
          graph: { originalGoal: "Original prompt", nodes: [{ id: "a", task: "t" }, { id: "b", task: "t" }], edges: [] },
          config: { repository: "/project", model: "test/one", thinkingLevel: "low", maxParallel: 2, maxFeedback: 2, autoApprove: true },
          plan: null,
          nodes: { a: { status: "running", revision: 1, head: null, instruction: "", error: null }, b: { status: "waiting", revision: 1, head: null, instruction: "", error: null } },
          executions: [],
          events: [],
          approved: true,
          paused: false,
          phase: "running",
          base: "",
          feedbackCounts: {},
        };
      }
      if (request.url().endsWith('/extension_command')) {
        standaloneCatalogs++;
        result = { instance: 'standalone', commands: [] };
      }
      if (request.url().endsWith("/composer_command")) {
        assert.equal(body.runId, "run-a");
        assert.equal(body.node, "a");
        if (body.operation === "catalog") result = { instance: "pi-instance", commands: [{ name: "extension", description: "Interactive extension" }, { name: "mcp", description: "MCP servers" }, { name: "tree" }] };
        if (body.operation === "poll") { result = events; events = []; }
        if (body.operation === "execute") {
          if (body.text === "/mcp" || body.text === "/mcp reconnect demo") {
            events.push({ type: "extension_ui_request", id: "mcp-status", method: "notify", message: body.text === "/mcp" ? "demo: connected (2 tools)" : "Reconnected to MCP server demo" });
            await route.fulfill({ json: { result: { disposition: "handled" } } });
            return;
          }
          assert.equal(body.text, "/extension");
          events.push({ type: "extension_ui_request", id: "choice", method: "select", title: "Choose action", options: ["Inspect", "Cancel"] });
          pendingExecute = route;
          return;
        }
        if (body.operation === "respond") {
          responses.push(body.response);
          if (body.response.id === "choice" && !body.response.cancelled) events.push({ type: "extension_ui_request", id: "input", method: "input", title: "Enter value" });
          else {
            if (!body.response.cancelled) events.push({ type: "extension_ui_request", id: "editor-text", method: "set_editor_text", text: "extension draft" });
            await pendingExecute.fulfill({ json: { result: { disposition: "handled" } } }); pendingExecute = undefined;
          }
        }
      }
      assert.ok(!request.url().endsWith("/save_config"), "slash changes must not save global defaults");
      await route.fulfill({ json: { result } });
    });
    const base = `http://127.0.0.1:${server.httpServer.address().port}/__commands`;
    await page.goto(base);
    const composer = page.locator("textarea").first();
    const submit = async text => { await composer.fill(text); await composer.press("Escape"); await composer.press("Enter"); };
    const output = async () => JSON.parse(await page.locator("output").textContent());
    // Both `/` and `@` cards omit the top-left header icon, exclude `/help`,
    // and keep `Tab` / `Esc` hints comfortably sized inside their keycaps.
    for (const trigger of ["/", "@"]) {
      await composer.fill(trigger);
      await page.locator(".prompt-box-suggestions-popover").waitFor();
      assert.equal(await page.locator(".suggestions-header-title svg").count(), 0, `${trigger} header must have no top-left icon`);
      if (trigger === "/") {
        const listText = await page.locator(".prompt-box-suggestions-list").innerText();
        assert.ok(!listText.includes("/help"), "/help must not appear in slash suggestions");
        assert.ok(listText.includes("/name"), "/name appears in main conversation slash suggestions");
      }
      const layout = await page.evaluate(() => {
        const header = document.querySelector(".prompt-box-suggestions-header").getBoundingClientRect();
        const close = document.querySelector(".suggestions-header-close-btn").getBoundingClientRect();
        const kbds = [...document.querySelectorAll(".suggestions-header-hints .key-hint")].map(el => ({
          text: el.textContent.trim(),
          rect: el.getBoundingClientRect(),
          fontSize: parseFloat(getComputedStyle(el).fontSize),
          height: parseFloat(getComputedStyle(el).height),
        }));
        return { header, close, kbds };
      });
      assert.ok(layout.close.right <= layout.header.right, "close button stays inside header");
      for (const kbd of layout.kbds) {
        if (kbd.text === "Tab" || kbd.text === "Esc") {
          assert.ok(kbd.fontSize <= 10, `${kbd.text} font size stays compact (${kbd.fontSize})`);
          assert.ok(kbd.height - kbd.fontSize >= 7, `${kbd.text} does not press against its keycap border`);
        }
      }
      await composer.press("Escape");
    }
    // Slash and @ ranking prefer exact/stem/prefix matches over substring matches.
    await composer.fill("/co");
    await page.locator(".prompt-box-suggestions-list").waitFor();
    const slashCoTitles = await page.locator(".prompt-box-suggestion-item .suggestion-item-title").allInnerTexts();
    assert.deepEqual(slashCoTitles, ["/copy", "/compact", "/scoped-models"], "/co puts /copy first, ahead of /compact and substring /scoped-models");
    await composer.fill("/thinking l");
    const thinkingTitles = await page.locator(".prompt-box-suggestion-item .suggestion-item-title").allInnerTexts();
    assert.deepEqual(thinkingTitles, ["low", "minimal"], "/thinking l puts low before substring minimal");
    await composer.fill("@app");
    const atAppTitles = await page.locator(".prompt-box-suggestion-item .suggestion-item-title").allInnerTexts();
    assert.equal(atAppTitles[0], "App.tsx", "@app ranks exact stem App.tsx before prefix app-notes.md");
    await composer.fill("@src/App");
    const atPathTitles = await page.locator(".prompt-box-suggestion-item .suggestion-item-title").allInnerTexts();
    assert.deepEqual(atPathTitles, ["App.tsx"], "@src/App keeps path completion open and filters by path");
    await composer.press("Escape");
    await composer.fill("/model ");
    await page.getByText("test/two", { exact: true }).waitFor();
    await page.getByText("test/two", { exact: true }).click();
    await composer.press("Escape"); await composer.press("Enter");
    await page.waitForFunction(() => JSON.parse(document.querySelector("output").textContent).calls.length === 1);
    assert.equal((await output()).calls[0].scope.role, "planner");
    assert.equal((await output()).config.roleModels.planner.model, "test/two");
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();
    await page.getByText("Switch mode").click();
    await submit("/thinking off");
    await page.waitForFunction(() => JSON.parse(document.querySelector("output").textContent).calls.length === 2);
    assert.equal((await output()).calls[1].scope.role, "nodeAgent");
    assert.equal((await output()).config.roleModels.nodeAgent.thinkingLevel, "off");
    for (const command of ["/quit", "/new", "/tree"]) {
      await submit(command);
      await page.locator('[role="alert"]').waitFor();
      assert.equal(await composer.inputValue(), command);
      assert.equal((await output()).calls.length, 2);
    }
    // Paths, unknown/unregistered slash text, and bare-only commands followed by prompt text
    // pass through as ordinary prompts instead of failing as invalid commands.
    const passthroughPrompts = [
      "/Users/jerry/Desktop/grapher/src/App.tsx 请帮我看看",
      "/new/tree",
      "/login 接口返回 401",
      "/settings 页面白屏",
      "/session 超时了",
      "/dashboard 页面报错",
      "/mcp",
      "/extension",
      "/help",
    ];
    for (const [index, promptText] of passthroughPrompts.entries()) {
      await submit(promptText);
      const expectedCalls = 3 + index;
      await page.waitForFunction(expected => JSON.parse(document.querySelector("output").textContent).calls.length === expected, expectedCalls);
      assert.deepEqual((await output()).calls.at(-1), { prompt: promptText });
      assert.equal(await composer.inputValue(), "");
      assert.equal(await page.locator('[role="alert"]').count(), 0);
    }
    const callsAfterPassthrough = (await output()).calls.length;
    await submit("/name Before run");
    await page.locator('[role="alert"]').waitFor();
    assert.equal(renames.length, 0);
    assert.equal((await output()).calls.length, callsAfterPassthrough);
    const errorCard = page.locator('.prompt-command-popover[role="alert"]');
    assert.match(await errorCard.innerText(), /请先开始或打开一个对话/);
    const errorStyles = await errorCard.evaluate(el => {
      const btn = el.querySelector(".prompt-command-notice-close");
      return {
        color: getComputedStyle(el).color,
        btnColor: btn ? getComputedStyle(btn).color : "",
        btnBorderWidth: btn ? getComputedStyle(btn).borderTopWidth : "",
      };
    });
    assert.equal(errorStyles.color, "rgb(239, 68, 68)", "error popover uses bright danger red instead of dark red");
    assert.equal(errorStyles.btnColor, "rgb(100, 116, 139)", "close button uses neutral secondary color");
    assert.equal(errorStyles.btnBorderWidth, "0px", "close button is a borderless ghost button");
    assert.equal(await page.locator(".prompt-box-attachment-error").count(), 0);
    const errorBox = await errorCard.boundingBox();
    const composerBox = await page.locator(".prompt-box-container").boundingBox();
    assert.ok(errorBox.y + errorBox.height <= composerBox.y, "inactive-session errors float above the input");
    const beforeActive = standaloneCatalogs;
    await page.goto(`${base}?run=1&node=a`);
    // Node agent dialogs hide `/name` in suggestions and reject it when submitted.
    await composer.fill("/");
    await page.locator(".prompt-box-suggestions-popover").waitFor();
    assert.ok(!(await page.locator(".prompt-box-suggestions-list").innerText()).includes("/name"));
    await composer.press("Escape");
    await submit("/name Should fail");
    await page.locator('.prompt-command-popover[role="alert"]').waitFor();
    assert.match(await page.locator('.prompt-command-popover[role="alert"]').innerText(), /节点对话框不支持 \/name/);
    assert.equal(renames.length, 0);
    // Main conversation (including Serial with `conversationModel`) allows `/name`.
    await page.goto(`${base}?run=1&node=a&conversationModel=1`);
    await submit("/name Custom Card Title");
    await page.locator('.prompt-command-popover[role="status"]').filter({ hasText: "已重命名对话：Custom Card Title" }).waitFor();
    assert.equal(renames.length, 1);
    assert.equal(renames[0].runId, "run-a");
    assert.equal(renames[0].title, "Custom Card Title");
    assert.equal((await output()).title, "Custom Card Title");
    await page.goto(`${base}?run=1&node=a`);
    await submit("/model test/two");
    await page.waitForFunction(() => JSON.parse(document.querySelector("output").textContent).calls.length === 1);
    const nodeResult = await output();
    assert.equal(nodeResult.calls[0].scope.node, "a");
    assert.equal(nodeResult.nodes.a.modelConfig.model, "test/two");
    assert.equal(nodeResult.nodes.b.modelConfig, undefined);
    assert.equal(nodeResult.config.model, "test/one");
    await submit("/mcp");
    await page.locator('.prompt-command-popover[role="status"]').filter({ hasText: "demo: connected (2 tools)" }).waitFor();
    await submit("/mcp reconnect demo");
    await page.locator('.prompt-command-popover[role="status"]').filter({ hasText: "Reconnected to MCP server demo" }).waitFor();
    assert.equal((await output()).calls.length, 1, "MCP controls do not become model prompts");
    await submit("/extension");
    await page.getByRole("button", { name: "Inspect", exact: true }).evaluate(button => { button.click(); button.click(); });
    const field = page.getByRole("textbox", { name: "Enter value" });
    await field.fill("test-response");
    await page.getByRole("button", { name: "提交", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("textarea").value === "extension draft");
    assert.deepEqual(responses, [
      { type: "extension_ui_response", id: "choice", value: "Inspect" },
      { type: "extension_ui_response", id: "input", value: "test-response" },
    ]);
    assert.equal((await output()).calls.length, 1, "extension command is not a user model prompt");
    await submit("/extension");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("textarea").value === "");
    assert.deepEqual(responses[2], { type: "extension_ui_response", id: "choice", cancelled: true });
    assert.equal(responses.length, 3, "a same-tick double click must never answer the following dialog");
    assert.equal(standaloneCatalogs, beforeActive, 'an active Agent supplies the command catalog without starting a standalone worker');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("standalone extension commands work before a conversation and follow the selected project", { timeout: 30_000 }, async () => {
  const server = await commandServer();
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    for (const suffix of ["", "?run=1"]) {
      const page = await browser.newPage();
      const jobs = new Map();
      const saved = [];
      const cancelled = [];
      const commands = ["custom-help", "provider-preferences", "api-options", "mcp", "custom-settings"].map(name => ({ name, source: "extension" }));
      let activeExecutions = 0;
      await page.route("**/api/*", async route => {
        const url = route.request().url();
        const body = route.request().postDataJSON();
        let result = [];
        if (url.endsWith("/list_files")) result = { files: [] };
        if (url.endsWith("/list_skills")) result = { skills: [] };
        if (url.endsWith("/provider_auth")) result = { providers: [], models: [] };
        if (url.endsWith("/composer_command")) {
          if (body.operation === "execute") activeExecutions++;
          await route.fulfill({ status: 400, json: { error: "Pi session is not active" } });
          return;
        }
        if (url.endsWith("/extension_command")) {
          assert.equal(body.runId, undefined, "standalone commands have no Run owner");
          assert.ok(["/project", "/other-project"].includes(body.repository));
          if (body.operation === "catalog") result = { instance: "standalone-host", commands: body.repository === "/project" ? commands : [{ name: "other-project-settings", source: "extension" }] };
          else {
            assert.equal(body.instance, "standalone-host");
            if (body.operation === "execute") {
              const custom = body.text === "/custom-settings";
              jobs.set(body.commandId, { repository: body.repository, status: custom ? "pending" : "complete", events: [custom
                ? { type: "extension_ui_request", id: "choice", method: "select", title: "Custom settings", options: ["Inspect"] }
                : { type: "extension_ui_request", id: "info", method: "notify", message: body.text === "/mcp" ? `MCP project: ${body.repository}` : "Custom extension help" }] });
              result = {};
            } else {
              const job = jobs.get(body.commandId);
              assert.ok(job);
              assert.equal(body.repository, job.repository, "replies stay pinned to the original project");
              if (body.operation === "poll") { result = { status: job.status, events: job.events }; job.events = []; }
              if (body.operation === "respond") {
                if (body.response.id === "choice") job.events.push({ type: "extension_ui_request", id: "value", method: "input", title: "Custom value" });
                else { saved.push(body.response.value); job.status = "complete"; job.events.push({ type: "extension_ui_request", id: "saved", method: "notify", message: "Custom setting saved" }); }
                result = { accepted: true };
              }
              if (body.operation === "cancel") { if (job.status === "pending") { cancelled.push(body.repository); job.status = "cancelled"; } result = {}; }
            }
          }
        }
        await route.fulfill({ json: { result } });
      });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__commands${suffix}`);
      const composer = page.locator("textarea").first();
      await composer.fill("/");
      for (const command of commands) await expect(page.locator(".suggestion-item-title").filter({ hasText: `/${command.name}` })).toBeVisible();
      const submit = async text => { await composer.fill(text); await composer.press("Escape"); await composer.press("Enter"); };
      await submit("/custom-help");
      await expect(page.locator('.prompt-command-popover[role="status"]')).toContainText("Custom extension help");
      await submit("/mcp");
      await expect(page.locator('.prompt-command-popover[role="status"]')).toContainText("MCP project: /project");
      await submit("/custom-settings");
      await page.getByRole("button", { name: "Inspect", exact: true }).click();
      await page.getByRole("textbox", { name: "Custom value" }).fill("custom-browser-value");
      await page.getByRole("button", { name: "提交", exact: true }).click();
      await expect(page.locator('.prompt-command-popover[role="status"]')).toContainText("Custom setting saved");
      assert.deepEqual(saved, ["custom-browser-value"]);
      assert.equal(activeExecutions, 0);
      assert.deepEqual(JSON.parse(await page.locator("output").textContent()).calls, [], "configuration creates no model prompt or conversation");
      await submit("/custom-settings");
      await page.getByRole("button", { name: "Inspect", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Custom value" })).toBeVisible();
      await page.getByRole("button", { name: "Switch project", exact: true }).click();
      await expect.poll(() => cancelled).toEqual(["/project"]);
      await expect(page.getByRole("textbox", { name: "Custom value" })).toHaveCount(0);
      await expect(composer).toBeEnabled();
      await composer.fill("/");
      await expect(page.locator(".suggestion-item-title").filter({ hasText: "/other-project-settings" })).toBeVisible();
      assert.equal(await page.locator(".suggestion-item-title").filter({ hasText: "/custom-settings" }).count(), 0);
      assert.equal(saved.length, 1, "project changes cancel pending entry");
      await page.close();
    }
  } finally { await browser?.close(); await server.close(); }
});

test("extension catalogs show loading and retry, refresh selections and reject stale results", { timeout: 30_000 }, async () => {
  const server = await commandServer();
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const page = await browser.newPage();
    const reads = [];
    page.setDefaultTimeout(5_000);
    let disabled = false;
    await page.route("**/api/*", async route => {
      const url = route.request().url();
      const body = route.request().postDataJSON();
      if (url.endsWith('/extension_command')) { reads.push(route); return; }
      if (url.endsWith('/pi_extensions')) {
        assert.equal(body.operation, 'set_enabled');
        disabled = true;
        await route.fulfill({ json: { result: { globalDirectory: '/pi', extensions: [{ id: 'fixture-extension', name: 'Fixture', path: '/pi/fixture.ts', enabled: false }] } } });
        return;
      }
      const result = url.endsWith('/list_files') ? { files: [] } : url.endsWith('/list_skills') ? { skills: [] }
        : url.endsWith('/provider_auth') ? { providers: [], models: [] } : {};
      await route.fulfill({ json: { result } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__commands`);
    const composer = page.locator('textarea').first();
    await composer.fill('/');
    await expect.poll(() => reads.length).toBe(1);
    const refreshButton = page.getByRole('button', { name: '刷新指令', exact: true });
    await expect(refreshButton).toBeDisabled();
    await expect(refreshButton).toHaveAttribute('aria-busy', 'true');
    await expect(refreshButton.locator('svg')).toHaveClass(/spin-icon/);
    await expect(page.locator('.prompt-box-suggestions-list')).not.toContainText('正在读取扩展指令');
    await reads[0].fulfill({ status: 503, json: { error: 'Temporary host failure' } });
    await expect(refreshButton).toBeEnabled();
    await expect(refreshButton.locator('svg')).not.toHaveClass(/spin-icon/);
    await expect(page.locator('.prompt-box-suggestions-list [role="status"]')).toContainText('扩展指令加载失败');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect.poll(() => reads.length).toBe(2);
    await reads[1].fulfill({ json: { result: { instance: 'host', commands: [{ name: 'totally-custom-extension', description: 'User installed command', source: 'extension' }] } } });
    await expect(page.getByText('/totally-custom-extension', { exact: true })).toBeVisible();
    assert.equal(await page.getByText('/pi-better-web-search', { exact: true }).count(), 0);
    assert.equal(await page.getByText('/mcp', { exact: true }).count(), 0, 'unloaded extensions get no synthetic entries');
    await page.getByRole('button', { name: '刷新指令', exact: true }).click();
    await expect.poll(() => reads.length).toBe(3);
    await page.getByRole('button', { name: 'Disable fixture extension', exact: true }).evaluate(button => button.click());
    await expect.poll(() => disabled).toBe(true);
    await expect.poll(() => reads.length).toBe(4);
    await reads[3].fulfill({ json: { result: { instance: 'host', commands: [{ name: 'another-extension', source: 'extension' }] } } });
    await expect(page.getByText('/another-extension', { exact: true })).toBeVisible();
    await reads[2].fulfill({ json: { result: { instance: 'host', commands: [{ name: 'totally-custom-extension', source: 'extension' }] } } });
    await expect(page.getByText('/totally-custom-extension', { exact: true })).toHaveCount(0);
    await expect(page.getByText('/another-extension', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Switch project', exact: true }).evaluate(button => button.click());
    await expect.poll(() => reads.length).toBe(5);
    assert.equal(reads[4].request().postDataJSON().repository, '/other-project');
    await expect(page.getByText('/another-extension', { exact: true })).toHaveCount(0);
    await reads[4].fulfill({ json: { result: { instance: 'host', commands: [{ name: 'project-command', source: 'extension' }] } } });
    await expect(page.getByText('/project-command', { exact: true })).toBeVisible();
  } finally { await browser?.close(); await server.close(); }
});

test("arbitrary extension dialogs support filtering, keyboard selection, IME and cancellation", { timeout: 30_000 }, async () => {
  const server = await commandServer();
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const page = await browser.newPage();
    const jobs = new Map();
    const replies = [];
    await page.route('**/api/*', async route => {
      const url = route.request().url();
      const body = route.request().postDataJSON();
      let result = url.endsWith('/list_files') ? { files: [] } : url.endsWith('/list_skills') ? { skills: [] }
        : url.endsWith('/provider_auth') ? { providers: [], models: [] } : {};
      if (url.endsWith('/extension_command')) {
        if (body.operation === 'catalog') result = { instance: 'host', commands: [{ name: 'choose-workspace', source: 'extension' }] };
        if (body.operation === 'execute') jobs.set(body.commandId, { status: 'pending', events: [{ type: 'extension_ui_request', id: 'choice', method: 'select', title: 'Choose workspace', options: Array.from({ length: 12 }, (_, index) => `Workspace ${index + 1}`) }] });
        const job = jobs.get(body.commandId);
        if (body.operation === 'poll') { result = { status: job.status, events: job.events }; job.events = []; }
        if (body.operation === 'respond') {
          replies.push(body.response);
          if (body.response.cancelled) job.status = 'complete';
          else if (body.response.id === 'choice') job.events.push({ type: 'extension_ui_request', id: 'input', method: 'input', title: 'Workspace name' });
          else if (body.response.id === 'input') job.events.push({ type: 'extension_ui_request', id: 'editor', method: 'editor', title: 'Workspace notes', prefill: 'Existing notes' });
          else { job.status = 'complete'; job.events.push({ type: 'extension_ui_request', id: 'done', method: 'notify', message: 'Workspace configured' }); }
        }
        if (body.operation === 'cancel') job.status = 'cancelled';
      }
      await route.fulfill({ json: { result } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__commands`);
    const composer = page.locator('textarea').first();
    const composerBoxBefore = await page.locator('.prompt-box-container').boundingBox();
    const submit = async () => { await composer.fill('/choose-workspace'); await composer.press('Escape'); await composer.press('Enter'); };
    await submit();
    const filter = page.getByRole('searchbox', { name: '筛选选项' });
    await expect(filter).toBeFocused();
    const dialogBox = await page.locator('.prompt-command-ui').boundingBox();
    const composerBoxOpen = await page.locator('.prompt-box-container').boundingBox();
    assert.ok(dialogBox.y + dialogBox.height <= composerBoxOpen.y, 'extension dialog floats above the composer');
    assert.ok(Math.abs(composerBoxOpen.height - composerBoxBefore.height) <= 1, 'opening extension dialog does not change composer height');
    await filter.fill('missing');
    await expect(page.locator('.prompt-command-ui [role="status"]')).toContainText('没有匹配的选项');
    await filter.fill('12');
    await filter.press('ArrowDown');
    await expect(page.getByRole('button', { name: 'Workspace 12', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    const input = page.getByRole('textbox', { name: 'Workspace name' });
    await expect(input).toBeFocused();
    const composerBoxAfterSelect = await page.locator('.prompt-box-container').boundingBox();
    assert.ok(Math.abs(composerBoxAfterSelect.height - composerBoxBefore.height) <= 1, 'selecting an extension option does not change composer height');
    await input.fill('工作区');
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    assert.equal(replies.length, 1, 'IME confirmation does not submit the dialog');
    await input.press('Shift+Enter');
    assert.equal(replies.length, 1, 'Shift+Enter preserves a newline');
    await input.fill('New workspace');
    await input.press('Enter');
    const editor = page.getByRole('textbox', { name: 'Workspace notes' });
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue('Existing notes');
    await editor.press('Enter');
    assert.equal(replies.length, 2, 'editor Enter preserves multiline editing');
    await editor.press('ControlOrMeta+Enter');
    await expect(page.locator('.prompt-command-popover[role="status"]')).toContainText('Workspace configured');
    assert.equal(replies.length, 3);
    await submit();
    await expect(filter).toBeFocused();
    await filter.press('Escape');
    await expect.poll(() => replies.length).toBe(4);
    assert.equal(replies[3].cancelled, true);
    await expect(page.locator('.prompt-command-ui')).toHaveCount(0);
  } finally { await browser?.close(); await server.close(); }
});

test("a delayed model command cannot overwrite newer settings in the same conversation", { timeout: 30_000 }, async () => {
  const server = await commandServer();
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    for (const command of ["/thinking low", "/model test/one"]) {
      const page = await browser.newPage();
      let catalogRequest;
      const errors = [];
      page.on("pageerror", error => errors.push(String(error)));
      await page.route("**/api/*", async route => {
        const url = route.request().url();
        if (url.endsWith("/provider_auth")) { catalogRequest = route; return; }
        const result = url.endsWith("/list_files") ? { files: [] } : url.endsWith("/list_skills") ? { skills: [] }
          : { instance: "model-fixture", commands: [] };
        await route.fulfill({ json: { result } });
      });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__commands?run=1`);
      const input = page.locator("textarea").first();
      await input.fill(command); await input.press("Escape"); await input.press("Enter");
      await expect.poll(() => !!catalogRequest).toBe(true);
      await expect(input).toBeDisabled();
      await page.getByRole("button", { name: "Apply newer settings", exact: true }).click();
      await catalogRequest.fulfill({ json: { result: { providers: [], warning: null, models: ["one", "two"].map(id => ({
        provider: "test", id, name: id, api: "mock", contextWindow: 1000, available: true, thinkingLevels: ["off", "low", "high"], thinkingLevelFallbacks: {},
      })) } } });
      await expect(input).toBeEnabled();
      await expect(input, "an obsolete command remains a retryable draft").toHaveValue(command);
      const read = async () => JSON.parse(await page.locator("output").textContent());
      assert.equal((await read()).calls.length, 0, "catalog completion must not save captured old settings");
      assert.deepEqual((await read()).config.roleModels.planner, { model: "test/two", thinkingLevel: "off" });
      await input.fill(command === "/thinking low" ? "/thinking high" : command);
      await input.press("Escape"); await input.press("Enter");
      await expect.poll(async () => (await read()).calls.length).toBe(1);
      assert.deepEqual((await read()).calls[0].settings, command === "/thinking low"
        ? { model: "test/two", thinkingLevel: "high" } : { model: "test/one", thinkingLevel: "off" });
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("returning to a live process cannot let an old command cancel the new command's UI", async () => {
  const server = await commandServer();
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const page = await browser.newPage();
    let owner;
    let slowExecute;
    let dialogExecute;
    let oldPoll;
    let events = [];
    const replies = [];
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.route("**/api/*", async route => {
      const body = route.request().postDataJSON();
      let result = [];
      if (route.request().url().endsWith("/provider_auth")) result = { providers: [], models: [], warning: null };
      if (route.request().url().endsWith("/composer_command")) {
        if (body.operation === "catalog") result = { instance: "same-live-pi", commands: [{ name: "slow" }, { name: "dialog" }] };
        else {
          assert.match(body.commandId, /^[0-9a-f-]{36}$/, "every UI operation must carry its invocation identity");
          if (body.operation === "execute") {
            if (owner?.running) return route.fulfill({ json: { error: "Another Pi command is still running" } });
            owner = { id: body.commandId, running: true };
            events = [];
            if (body.text === "/slow") slowExecute = route;
            else {
              dialogExecute = route;
              events.push({ type: "extension_ui_request", id: "new-dialog", method: "input", title: "New command input" });
            }
            return;
          }
          if (body.operation === "poll") {
            if (!oldPoll && slowExecute) { oldPoll = { route, commandId: body.commandId }; return; }
            if (body.commandId === owner?.id) { result = events; events = []; }
          }
          if (body.operation === "respond") {
            if (body.commandId !== owner?.id) return route.fulfill({ json: { error: "Pi command changed" } });
            replies.push(body.response);
            owner.running = false;
            await dialogExecute.fulfill({ json: { result: { disposition: "handled" } } });
          }
        }
      }
      await route.fulfill({ json: { result } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__commands?run=1&node=a`);
    const input = page.locator("textarea").first();
    const submit = async text => { await input.fill(text); await input.press("Escape"); await input.press("Enter"); };
    await submit("/slow");
    await expect.poll(() => !!oldPoll).toBe(true);
    await page.getByRole("button", { name: "Switch node", exact: true }).click();
    await page.getByRole("button", { name: "Switch node", exact: true }).click();
    await submit("/dialog");
    await page.getByRole("alert").filter({ hasText: "Another Pi command is still running" }).waitFor();
    await expect(input).toHaveValue("/dialog");
    assert.equal(dialogExecute, undefined, "the second command cannot enter Pi before the first acknowledges");
    owner.running = false;
    await slowExecute.fulfill({ json: { result: { disposition: "handled" } } });
    await submit("/dialog");
    await expect.poll(() => !!dialogExecute).toBe(true);
    assert.notEqual(owner.id, oldPoll.commandId);
    // The old HTTP read reaches the process after the new command starts. Its
    // command-ID fence must leave the new event in the shared Pi queue.
    await oldPoll.route.fulfill({ json: { result: oldPoll.commandId === owner.id ? events.splice(0) : [] } });
    const dialog = page.getByRole("textbox", { name: "New command input" });
    await dialog.fill("keep new command");
    await page.getByRole("button", { name: "提交", exact: true }).click();
    await expect.poll(() => replies.length).toBe(1);
    assert.deepEqual(replies, [{ type: "extension_ui_response", id: "new-dialog", value: "keep new command" }]);
    await expect(input).toHaveValue("");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("scope changes and unmount cancel in-flight and subsequent Pi dialogs on the original instance", async () => {
  const server = await commandServer();
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    for (const change of ["Switch node", "Switch run", "Toggle composer"]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(String(error)));
      let pendingExecute;
      let heldPoll;
      const responses = [];
      let events = [];
      let firstPoll = true;
      await page.route("**/api/*", async route => {
        const body = route.request().postDataJSON();
        let result = [];
        if (route.request().url().endsWith("/provider_auth")) result = { providers: [], models: [], warning: null };
        if (route.request().url().endsWith("/composer_command")) {
          if (body.operation === "catalog") result = { instance: "original-pi", commands: [{ name: "extension", source: "extension" }] };
          if (body.operation === "execute") { pendingExecute = route; return; }
          if (body.operation === "poll") {
            assert.equal(body.runId, "run-a"); assert.equal(body.node, "a"); assert.equal(body.instance, "original-pi");
            if (firstPoll) { firstPoll = false; heldPoll = route; return; }
            result = events; events = [];
          }
          if (body.operation === "respond") {
            assert.equal(body.runId, "run-a"); assert.equal(body.node, "a"); assert.equal(body.instance, "original-pi");
            responses.push(body.response);
            if (body.response.id === "late-dialog") {
              // Extensions can open a second dialog after the first is cancelled.
              events.push({ type: "extension_ui_request", id: "next-dialog", method: "confirm", title: "Still waiting" });
            } else {
              await pendingExecute.fulfill({ json: { result: { disposition: "handled" } } });
              pendingExecute = undefined;
            }
          }
        }
        await route.fulfill({ json: { result } });
      });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__commands?run=1&node=a`);
      const composer = page.locator("textarea").first();
      await composer.fill("/extension"); await composer.press("Escape"); await composer.press("Enter");
      await expect.poll(() => !!heldPoll).toBe(true);
      const inFlightPoll = heldPoll;
      await page.getByRole("button", { name: change, exact: true }).click();
      if (change !== "Toggle composer") await composer.fill("new scope draft");
      await inFlightPoll.fulfill({ json: { result: [
        { type: "extension_ui_request", id: "late-dialog", method: "input", title: "Old scope input" },
        { type: "extension_ui_request", id: "late-editor", method: "set_editor_text", text: "must not replace new draft" },
        { type: "extension_ui_request", id: "late-notice", method: "notify", message: "old scope notice" },
      ] } });
      await expect.poll(() => responses.length).toBe(2);
      assert.deepEqual(responses, [
        { type: "extension_ui_response", id: "late-dialog", cancelled: true },
        { type: "extension_ui_response", id: "next-dialog", cancelled: true },
      ]);
      await expect.poll(() => pendingExecute === undefined).toBe(true);
      assert.equal(await page.locator(".prompt-command-ui").count(), 0);
      assert.equal(await page.getByText("old scope notice", { exact: true }).count(), 0);
      if (change !== "Toggle composer") await expect(composer).toHaveValue("new scope draft");
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("slash command confirmation notices auto-dismiss and reset on repeat, while inspection notices stay open", { timeout: 30_000 }, async () => {
  const server = await commandServer();
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.clock.install();
    await page.route("**/api/*", async route => {
      const url = route.request().url();
      const body = route.request().postDataJSON();
      let result = [];
      if (url.endsWith("/list_files")) result = { files: [] };
      if (url.endsWith("/list_skills")) result = { skills: [] };
      if (url.endsWith("/provider_auth")) {
        result = {
          providers: [],
          warning: null,
          models: ["one", "two"].map(id => ({
            provider: "test", id, name: id, api: "mock", contextWindow: 1000,
            available: true, thinkingLevels: ["off", "low", "high"], thinkingLevelFallbacks: {},
          })),
        };
      }
      if (url.endsWith("/composer_command")) {
        if (body.operation === "catalog") result = { instance: "pi-instance", commands: [] };
        else if (body.operation === "poll") result = [];
        else if (body.operation === "execute" && body.text === "/stats") result = { tokens: 42 };
      }
      await route.fulfill({ json: { result } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__commands?run=1&node=a`);
    const composer = page.locator("textarea").first();
    const statusNotice = page.locator('.prompt-command-popover[role="status"]');
    const submit = async text => { await composer.fill(text); await composer.press("Escape"); await composer.press("Enter"); };

    await submit("/model test/two");
    await expect(statusNotice).toContainText("已更新当前会话配置；正在执行的调用保持不变，后续调用使用新配置。");
    await page.clock.runFor(2500);
    await expect(statusNotice).toBeVisible();

    // Repeating a command with identical confirmation text resets the timer.
    await submit("/thinking high");
    await expect(statusNotice).toContainText("已更新当前会话配置；正在执行的调用保持不变，后续调用使用新配置。");
    await page.clock.runFor(2500);
    await expect(statusNotice).toBeVisible();
    await page.clock.runFor(2000);
    await expect(statusNotice).toHaveCount(0);

    // Inspection output such as /stats remains open until dismissed.
    await submit("/stats");
    await expect(statusNotice).toContainText('"tokens": 42');
    await page.clock.runFor(10_000);
    await expect(statusNotice).toBeVisible();

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("unrecognized slash prompts work with attachments and catalog failures while real commands still validate", { timeout: 30_000 }, async () => {
  const server = await commandServer();
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const page = await browser.newPage();
    const errors = [];
    let catalogFails = false;
    page.on("pageerror", error => errors.push(String(error)));
    await page.route("**/api/*", async route => {
      const url = route.request().url();
      if (url.endsWith("/extension_command")) {
        if (catalogFails) {
          await route.fulfill({ status: 503, json: { error: "Temporary host failure" } });
          return;
        }
        await route.fulfill({ json: { result: { instance: "host", commands: [] } } });
        return;
      }
      const result = url.endsWith("/list_files") ? { files: [] } : url.endsWith("/list_skills") ? { skills: [] }
        : url.endsWith("/provider_auth") ? { providers: [], warning: null, models: [] }
        : url.endsWith("/write_workspace_attachment") ? { name: "note.txt", path: "/tmp/attachment-inputs/11111111-1111-1111-1111-111111111111/note.txt" }
        : {};
      await route.fulfill({ json: { result } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__commands`);
    const composer = page.locator("textarea").first();
    const fileInput = page.locator('input[type="file"]');
    const output = async () => JSON.parse(await page.locator("output").textContent());
    const submit = async text => { await composer.fill(text); await composer.press("Escape"); await composer.press("Enter"); };

    // Real command still rejects attachments.
    await fileInput.setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await submit("/model test/two");
    await expect(page.locator('.prompt-command-popover[role="alert"]')).toContainText("Pi 指令不能携带附件");
    assert.equal((await output()).calls.length, 0);

    // Unrecognized slash text with attachment submits normally.
    await submit("/dashboard 页面报错，看附件");
    await page.waitForFunction(() => JSON.parse(document.querySelector("output").textContent).calls.length === 1);
    assert.equal((await output()).calls[0].prompt, "@/tmp/attachment-inputs/11111111-1111-1111-1111-111111111111/note.txt /dashboard 页面报错，看附件");
    assert.equal(await page.locator('[role="alert"]').count(), 0);

    // Even when extension catalog loading fails, unknown slash text and paths pass through as prompts,
    // while known history commands still fail explicitly.
    catalogFails = true;
    await submit("/foo bar");
    await page.waitForFunction(() => JSON.parse(document.querySelector("output").textContent).calls.length === 2);
    assert.deepEqual((await output()).calls[1], { prompt: "/foo bar" });

    await submit("/Users/jerry/Desktop/grapher/src/App.tsx");
    await page.waitForFunction(() => JSON.parse(document.querySelector("output").textContent).calls.length === 3);
    assert.deepEqual((await output()).calls[2], { prompt: "/Users/jerry/Desktop/grapher/src/App.tsx" });

    await submit("/compact");
    await expect(page.locator('.prompt-command-popover[role="alert"]')).toContainText("扩展指令加载失败");
    assert.equal((await output()).calls.length, 3);

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("/reload invalidates cached command catalog so newly registered commands are not short-circuited as prompts", { timeout: 30_000 }, async () => {
  const server = await commandServer();
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const page = await browser.newPage();
    const errors = [];
    const executed = [];
    let reloaded = false;
    page.on("pageerror", error => errors.push(String(error)));
    await page.route("**/api/*", async route => {
      const url = route.request().url();
      if (url.endsWith("/extension_command")) {
        const body = route.request().postDataJSON();
        if (body.operation === "catalog") {
          const commands = reloaded
            ? [{ name: "reload", description: "Reload extensions" }, { name: "fresh-cmd", description: "Fresh command" }]
            : [{ name: "reload", description: "Reload extensions" }];
          await route.fulfill({ json: { result: { instance: "host", commands } } });
          return;
        }
        if (body.operation === "execute") {
          executed.push(body.text);
          if (body.text === "/reload") reloaded = true;
          await route.fulfill({ json: { result: { ok: true } } });
          return;
        }
        if (body.operation === "poll") {
          await route.fulfill({ json: { result: { status: "complete", events: [{ method: "notify", message: `ran ${executed.at(-1)}` }] } } });
          return;
        }
        await route.fulfill({ json: { result: {} } });
        return;
      }
      const result = url.endsWith("/list_files") ? { files: [] } : url.endsWith("/list_skills") ? { skills: [] }
        : url.endsWith("/provider_auth") ? { providers: [], warning: null, models: [] }
        : {};
      await route.fulfill({ json: { result } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__commands`);
    const composer = page.locator("textarea").first();
    const output = async () => JSON.parse(await page.locator("output").textContent());
    const submit = async text => { await composer.fill(text); await composer.press("Escape"); await composer.press("Enter"); };

    // Populate cache, then reload to introduce /fresh-cmd.
    await submit("/reload");
    await expect(page.locator('.prompt-command-popover[role="status"]')).toContainText("ran /reload");
    // Immediately execute /fresh-cmd without reopening the menu; cache must not short-circuit it as a prompt.
    await submit("/fresh-cmd");
    await expect(page.locator('.prompt-command-popover[role="status"]')).toContainText("ran /fresh-cmd");
    assert.deepEqual(executed, ["/reload", "/fresh-cmd"]);
    assert.equal((await output()).calls.length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
