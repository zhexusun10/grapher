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
      if (request.url().endsWith("/provider_auth")) result = { providers: [], warning: null, models: ["one", "two"].map(id => ({ provider: "test", id, name: id, available: true, thinkingLevels: ["off", "minimal", "low", "high"] })) };
      if (request.url().endsWith("/composer_rename")) {
        renames.push(body);
        result = {
          runId: body.runId,
          title: body.title,
          graph: { originalGoal: "Original prompt", nodes: [{ name: "a", task: "t" }, { name: "b", task: "t" }], edges: [] },
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
    for (const command of ["/quit", "/new", "/tree", "/new/tree", "/mcp", "/extension", "/help"]) {
      await submit(command);
      await page.locator('[role="alert"]').waitFor();
      assert.equal(await composer.inputValue(), command);
      assert.equal((await output()).calls.length, 2);
    }
    await submit("/name Before run");
    await page.locator('[role="alert"]').waitFor();
    assert.equal(renames.length, 0);
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
    assert.deepEqual(errors, []);
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
