import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
const deferred = () => {
  let resolve;
  const promise = new Promise(completed => { resolve = completed; });
  return { promise, resolve };
};
async function waitFor(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "mock request did not arrive");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const catalog = {
  providers: [{ id: "test", name: "Test", methods: [], configured: true }], warning: null,
  models: ["old", "new"].map(id => ({ provider: "test", id, name: id, available: true, api: "mock", contextWindow: 1000 })),
};
before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-frontend-audit",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false },
    plugins: [{ name: "frontend-audit-fixtures", configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/__audit")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root" style="padding:160px 32px"></div><script type="module" src="/scripts/fixtures/frontend-audit.tsx"></script></body></html>'));
      });
    } }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(name, handler = async () => false, reducedMotion = "reduce", autoExpandCot = undefined, clockTime = undefined, browserInstance = browser) {
  const context = await browserInstance.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion });
  await context.addInitScript(enabled => {
    localStorage.setItem("grapher_language_v1", "en");
    // COT cards auto-expand by default; "0" disables, "1" enables.
    if (enabled === true) localStorage.setItem("grapher_auto_expand_cot_v1", "1");
    else if (enabled === false) localStorage.setItem("grapher_auto_expand_cot_v1", "0");
    else localStorage.removeItem("grapher_auto_expand_cot_v1");
  }, autoExpandCot);
  const errors = [];
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (await handler(route, command, body)) return;
    const defaults = { provider_auth: catalog, pi_extensions: { globalDirectory: "mock", extensions: [] },
      environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true },
      list_files: { files: [] }, list_skills: { skills: [] },
      write_workspace_attachment: { name: "fixture.txt", path: "grapher-attachments/00000000-0000-4000-8000-000000000001/fixture.txt" },
      delete_workspace_attachment: { success: true } };
    if (Object.hasOwn(defaults, command)) return route.fulfill({ json: { result: defaults[command] } });
    errors.push(`Unexpected API: ${command}`);
    await route.fulfill({ status: 500, json: { error: `Unexpected API: ${command}` } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  page.setDefaultTimeout(10_000);
  if (clockTime) await page.clock.install({ time: clockTime });
  try {
    await page.goto(`${origin}/__audit?case=${name}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit);
  } catch (error) {
    await context.close();
    throw new Error(`Fixture failed: ${errors.join("; ")} ${error}`);
  }
  return { context, page, errors };
}

test("Markdown cannot execute HTML handlers or reach local APIs in live or replay views", { timeout: 30_000 }, async () => {
  const apiCalls = [];
  const { context, page, errors } = await fixture("markdownCopy", async (_route, command) => {
    apiCalls.push(command);
    return false;
  });
  try {
    for (const streaming of [true, false]) {
      await page.evaluate(streaming => {
        window.audit.xss = 0;
        const handler = "window.audit.xss++;fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})";
        window.audit.setMarkdown(`<img src="data:image/png;base64,AA==" onerror="${handler}">` +
          `<svg onload="${handler}"></svg><a href="&#x6a;avascript:window.audit.xss++">unsafe link</a>` +
          '<iframe srcdoc="<script>parent.audit.xss++</script>"></iframe>', streaming);
      }, streaming);
      await page.locator(".markdown-content a").waitFor();
      await page.locator(".markdown-content a").click();
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.audit.xss), 0);
      assert.equal(await page.locator(".markdown-content [onerror], .markdown-content [onload], .markdown-content iframe, .markdown-content svg").count(), 0);
      assert.equal(await page.locator(".markdown-content a").getAttribute("href"), null);
    }
    assert.deepEqual(apiCalls, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Markdown block copy controls copy only their current code and recover from clipboard denial", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("markdownCopy");
  try {
    await page.evaluate(() => {
      window.audit.copies = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async text => {
          if (window.audit.rejectCopy) throw new Error("Clipboard denied");
          window.audit.copies.push(text);
        },
      } });
    });
    const buttons = page.locator(".code-copy-btn");
    assert.equal(await buttons.count(), 2);
    assert.equal(await page.locator("p .code-copy-btn").count(), 0);
    await buttons.first().locator("svg.code-copy-icon").click();
    await page.waitForFunction(() => document.querySelector(".code-copy-btn").classList.contains("copied"));
    assert.equal(await buttons.first().getAttribute("aria-label"), "Copied");
    assert.deepEqual(await page.evaluate(() => window.audit.copies), ['printf "<tag> & 中文"\npwd\n']);
    await buttons.last().focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.audit.copies.length === 2);
    assert.equal(await page.evaluate(() => window.audit.copies.at(-1)), 'print("second")\n');

    await page.evaluate(() => window.audit.setMarkdown("```sh\necho streaming", true));
    await page.waitForFunction(() => document.querySelectorAll(".code-copy-btn").length === 1);
    assert.equal(await buttons.count(), 1);
    await buttons.first().click();
    await page.waitForFunction(() => window.audit.copies.length === 3);
    assert.equal(await page.evaluate(() => window.audit.copies.at(-1)), "echo streaming\n");
    await page.evaluate(() => window.audit.setMarkdown("```sh\necho streaming updated", true));
    await page.waitForFunction(() => document.querySelector("pre code")?.textContent === "echo streaming updated\n");
    await buttons.first().click();
    await page.waitForFunction(() => window.audit.copies.length === 4);
    assert.equal(await page.evaluate(() => window.audit.copies.at(-1)), "echo streaming updated\n");

    await page.evaluate(() => {
      window.audit.setMarkdown("```\nretry after denial\n```");
      window.audit.rejectCopy = true;
    });
    await buttons.first().click();
    assert.equal(await buttons.first().getAttribute("aria-label"), "Copy to clipboard");
    assert.equal(await page.evaluate(() => window.audit.copies.length), 4);
    await page.evaluate(() => { window.audit.rejectCopy = false; });
    await buttons.first().click();
    await page.waitForFunction(() => window.audit.copies.length === 5);
    assert.equal(await page.evaluate(() => window.audit.copies.at(-1)), "retry after denial\n");
    await page.waitForFunction(() => !document.querySelector(".code-copy-btn").classList.contains("copied"));
    assert.equal(await buttons.first().getAttribute("aria-label"), "Copy to clipboard");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("session clocks display whole seconds aligned with authoritative elapsed time", { timeout: 30_000 }, async () => {
  const base = new Date("2026-10-17T08:00:00Z");
  // Install the clock before mounting: the components initialize their clock
  // state during the first render, so installing it afterwards mixes real and
  // mocked dates until React's next effect.
  const { context, page, errors } = await fixture("timeTook", undefined, undefined, undefined, base);
  try {
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
    const values = () => page.locator("[data-execution-time], [data-planner-time]").allTextContents();
    await page.evaluate(() => window.audit.start(Date.now() - 800));
    assert.deepEqual(await values(), ["0s", "0s"]);
    await page.clock.runFor(199);
    assert.deepEqual(await values(), ["0s", "0s"]);
    await page.clock.runFor(1);
    assert.deepEqual(await values(), ["1s", "1s"], "refresh at the elapsed-second boundary, not a second after mounting");
    await page.clock.runFor(9000);
    assert.deepEqual(await values(), ["10s", "10s"]);
    await page.clock.runFor(1000);
    assert.deepEqual(await values(), ["11s", "11s"]);
    await page.evaluate(() => window.audit.finish());
    assert.deepEqual(await values(), ["3s", "3s"]);
    await page.clock.runFor(2000);
    assert.deepEqual(await values(), ["3s", "3s"], "settled durations must stay fixed");
    await page.evaluate(() => window.audit.start(Date.now() - 100, "next"));
    assert.deepEqual(await values(), ["0s", "0s"]);
    await page.clock.runFor(900);
    assert.deepEqual(await values(), ["1s", "1s"]);
    await page.evaluate(() => window.audit.start(Date.now() - 5800, "late"));
    assert.deepEqual(await values(), ["5s", "5s"], "late mounting must not reset the elapsed time");
    await page.clock.runFor(200);
    assert.deepEqual(await values(), ["6s", "6s"]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("cancelled Provider login/respond replies cannot reopen the panel or replace a newer login", { timeout: 30_000 }, async () => {
  const loginGate = deferred(), responseGate = deferred();
  let logins = 0, responses = 0, oldReply = false, responseReply = false;
  const cancelled = [];
  const pendingLogin = id => ({ id, provider: "test", status: "pending", events: [], error: null,
    prompt: { id: `${id}-prompt`, type: "secret", message: id === "second" ? "Second prompt" : "First prompt" } });
  const { context, page, errors } = await fixture("settings", async (route, command, body) => {
    if (command !== "provider_auth") return false;
    let result;
    switch (body.operation) {
      case "catalog": result = { ...catalog, providers: [{ id: "test", name: "Test", configured: false, methods: [{ id: "api_key", name: "API Key" }] }] }; break;
      case "login":
        logins += 1;
        if (logins === 1) { await loginGate.promise; result = pendingLogin("first"); oldReply = true; }
        else result = pendingLogin("second");
        break;
      case "poll": result = pendingLogin(body.id); break;
      case "cancel": cancelled.push(body.id); result = { ...pendingLogin(body.id), status: "cancelled" }; break;
      case "respond":
        responses += 1;
        await responseGate.promise;
        responseReply = true;
        result = { ...pendingLogin(body.id), status: "complete", prompt: null };
        break;
      default: throw new Error(`Unexpected auth operation: ${body.operation}`);
    }
    await route.fulfill({ json: { result } });
    return true;
  });
  try {
    await page.locator(".providers-grid-title").click();
    await page.locator(".login-btn").click();
    await waitFor(() => logins === 1);
    await page.locator(".active-login-header .icon-button-close").click();
    await page.locator(".login-btn").click();
    await page.locator("#auth-answer").waitFor();
    loginGate.resolve();
    await waitFor(() => oldReply && cancelled.includes("first"));
    assert.ok((await page.locator(".prompt-label").innerText()).includes("Second prompt"));
    await page.locator("#auth-answer").fill("dummy-test-answer");
    await page.locator("#auth-answer").evaluate(input => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => responses === 1);
    assert.equal(await page.locator("#auth-answer").isDisabled(), true);
    await page.locator(".active-login-header .icon-button-close").click();
    responseGate.resolve();
    await waitFor(() => responseReply);
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".active-login-panel").count(), 0);
    assert.equal(responses, 1);
    assert.deepEqual(errors, []);
  } finally { loginGate.resolve(); responseGate.resolve(); await context.close(); }
});

test("polling graph metadata cannot overwrite an open editor draft", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("editor");
  try {
    const editor = page.getByRole("textbox", { name: "Graph JSON" });
    await editor.fill('{"originalGoal":"Unsaved draft"}');
    await page.evaluate(() => window.audit.updateGraph());
    assert.equal(await editor.inputValue(), '{"originalGoal":"Unsaved draft"}');
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.locator(".modal").waitFor({ state: "detached" });
    await page.evaluate(() => window.audit.open());
    await page.waitForFunction(() => document.querySelector(".json-editor")?.value.includes("Polled graph"));
    assert.ok((await editor.inputValue()).includes("Polled graph"), "reopening starts a new draft session");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("inline message edits deduplicate click/Enter and preserve a rejected draft", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("bubble");
  try {
    await page.getByRole("textbox", { name: "Edit message content" }).waitFor();
    await page.evaluate(() => {
      document.querySelector(".chat-bubble-action-btn.send").click();
      document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.equal(await page.evaluate(() => window.audit.calls), 1);
    assert.equal(await page.locator("textarea").isDisabled(), true);
    await page.evaluate(() => window.audit.resolve(false));
    await page.waitForFunction(() => !document.querySelector("textarea").disabled);
    assert.equal(await page.locator("textarea").inputValue(), "Edited message");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("unchanged inline edit keeps the confirm visible but disabled until an actual change", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("unchangedBubble");
  try {
    // The confirm stays rendered (disabled) so the control never reads as missing.
    assert.equal(await page.getByRole("button", { name: "Cancel edit" }).count(), 1);
    const confirm = page.getByRole("button", { name: "Rewind and retry" });
    assert.equal(await confirm.count(), 1);
    assert.equal(await confirm.isDisabled(), true);
    await page.locator("textarea").press("Enter");
    assert.equal(await page.evaluate(() => window.audit.unchangedSends), 0);
    await page.locator("textarea").fill("Changed message");
    await confirm.waitFor();
    assert.equal(await confirm.isDisabled(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("inline edit keeps the caret where the user typed", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("bubble");
  try {
    const editor = page.locator("textarea");
    await editor.waitFor();
    await editor.evaluate(element => element.setSelectionRange(7, 7));
    await editor.press("X");
    assert.equal(await editor.inputValue(), "Edited Xmessage");
    assert.deepEqual(
      await editor.evaluate(element => [element.selectionStart, element.selectionEnd]),
      [8, 8],
    );
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("interrupt control does not submit or clear a pending draft", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("interruptPrompt");
  try {
    const input = page.locator("textarea");
    await input.fill("Keep my follow-up draft");
    await page.getByRole("button", { name: "Click to interrupt execution" }).click();
    assert.equal(await input.inputValue(), "Keep my follow-up draft");
    assert.equal(await page.evaluate(() => window.audit.interrupts), 1);
    assert.equal(await page.evaluate(() => window.audit.submissions ?? 0), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});


test("small settled node history opens through a bounded tail and renders tool cards without manual intervention", { timeout: 30_000 }, async () => {
  const line = event => JSON.stringify(event) + "\n";
  const tool = (id, label) => [
    line({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: label } }),
    line({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: false,
      result: { content: [{ type: "text", text: label }], details: { exitCode: 0 } } }),
  ].join("");
  const older = tool("older-tool", "OLDER_TOOL_OK");
  const tail = tool("tail-tool", "TAIL_TOOL_OK") + Array.from({ length: 10 }, (_, index) => line({
    type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `tail row ${index}` }] },
  })).join("");
  const fullContent = older + tail;
  const totalBytes = Buffer.byteLength(fullContent);
  const requests = [];
  const { context, page, errors } = await fixture("transcript", async (route, command, body) => {
    if (command !== "get_execution_output") return false;
    requests.push(body);
    await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId, content: fullContent,
      startOffset: 0, nextOffset: totalBytes, totalBytes, complete: true, status: "completed" } } });
    return true;
  });
  try {
    await page.locator(".tool-call-card").first().waitFor();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].full, false);
    assert.equal(requests[0].tail, true);
    assert.equal(requests[0].offset, 0);
    assert.equal(await page.locator(".tool-call-card").count(), 2, "a small history fits in its initial bounded tail");
    await page.locator(".tool-call-card").first().locator(".tool-call-header").click();
    await page.locator(".tool-call-card .tool-result-code").filter({ hasText: "OLDER_TOOL_OK" }).waitFor();
    await page.locator(".tool-call-card").last().locator(".tool-call-header").click();
    await page.locator(".tool-call-card .tool-result-code").filter({ hasText: "TAIL_TOOL_OK" }).waitFor();

    // Verify upward scrolling is smooth and uninhibited: scrolling up never pulls the user back down
    const scroller = page.locator("[data-transcript-scroll]");
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const bottomPos = await scroller.evaluate(el => el.scrollTop);
    await scroller.evaluate(el => { el.scrollTop = 50; });
    await page.waitForTimeout(100);
    const scrolledUpPos = await scroller.evaluate(el => el.scrollTop);
    assert.ok(scrolledUpPos < bottomPos / 2, "user stays scrolled up and is not dragged back down");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

// Pause the entrance partway through so live updates cannot race its natural end.
// Assert continuity, not decorative timings or exact keyframe positions.
async function pauseCardEntrance(card) {
  return card.evaluate(card => {
    const animations = card.getAnimations();
    const entrance = animations.find(animation => animation.effect.getKeyframes()
      .some(frame => frame.opacity !== undefined && frame.transform !== undefined));
    if (!entrance) return false;
    entrance.pause();
    entrance.currentTime = Number(entrance.effect.getTiming().duration) / 3;
    window.audit.entrance = entrance;
    window.audit.cardTransform = getComputedStyle(card).transform;
    return true;
  });
}

for (const type of ["thinking", "tool"]) {
  for (const source of ["direct", "node"]) {
    test(`${source} ${type} card entrance survives live updates and completion without snapping`, { timeout: 30_000 }, async () => {
      const { context, page, errors } = await fixture(`cardPresentation&type=${type}&source=${source}`, undefined, "no-preference", type === "thinking");
      try {
        await page.addStyleTag({ content: ".appear-active { animation-duration: 10s !important; }" });
        await page.evaluate(() => window.audit.showCards());
        const card = page.locator(type === "tool" ? ".tool-call-card" : ".thinking-card");
        await card.waitFor({ state: "attached" });
        assert.ok(await pauseCardEntrance(card), "new live cards must have an entrance, including running tools");
        if (type === "tool") {
          assert.ok(await card.evaluate(element => element.getAnimations().every(animation =>
            animation.effect.getTiming().iterations !== Infinity) && element.getAnimations({ subtree: true }).some(animation =>
              animation.effect.getTiming().iterations === Infinity && animation.effect.pseudoElement)),
            "tool activity feedback animates a decoration, not the moving/measured card surface");
        }
        for (const settle of [false, true]) {
          await page.evaluate(settle => window.audit.updateCard(settle), settle);
          await page.waitForFunction(({ type, settle }) => {
            const card = document.querySelector(type === "tool" ? ".tool-call-card" : ".thinking-card");
            if (!settle) return card.textContent.includes("updated");
            return card.classList.contains(type === "tool" ? "success" : "settled");
          }, { type, settle });
          const continuous = await card.evaluate(element => element.getAnimations().includes(window.audit.entrance) &&
            getComputedStyle(element).transform === window.audit.cardTransform);
          assert.ok(continuous, "status/content/timestamp changes must not cancel or restart an in-flight entrance");
        }
        await card.evaluate(() => { window.audit.entrance.finish(); });
        await page.evaluate(() => window.audit.remountCards());
        await page.locator('[data-card-presentation="1"]').waitFor({ state: "attached" });
        assert.equal(await pauseCardEntrance(card), false, "already-presented cards do not replay on remount");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    test(`${source} ${type} card entrance works in StrictMode and respects reduced motion and old history`, { timeout: 30_000 }, async () => {
      for (const reducedMotion of ["no-preference", "reduce"]) {
        const { context, page, errors } = await fixture(`cardPresentation&type=${type}&source=${source}&strict=1`, undefined, reducedMotion, type === "thinking");
        try {
          await page.addStyleTag({ content: ".appear-active { animation-duration: 10s !important; }" });
          await page.evaluate(() => window.audit.showCards(true));
          const selector = type === "tool" ? ".tool-call-card" : ".thinking-card";
          const card = page.locator(selector);
          await card.waitFor({ state: "attached" });
          assert.equal(await pauseCardEntrance(card), false, "old settled cards must not animate");
          if (source === "node") {
            await page.evaluate(() => window.audit.appendCompletedCard());
            await page.waitForFunction(selector => document.querySelectorAll(selector).length === 2, selector);
            assert.equal(await pauseCardEntrance(card.last()), reducedMotion === "no-preference",
              "new cards delivered already-completed in a live chunk still have an entrance");
            assert.equal(await pauseCardEntrance(card.first()), false, "new output does not animate existing history");
          }
          // Reload to reset presentation history before the first live presentation.
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForFunction(() => !!window.audit?.showCards);
          await page.addStyleTag({ content: ".appear-active { animation-duration: 10s !important; }" });
          await page.evaluate(() => window.audit.showCards());
          await card.waitFor({ state: "attached" });
          assert.equal(await pauseCardEntrance(card), reducedMotion === "no-preference",
            "StrictMode must not consume presentation before commit; reduced motion disables entrance");
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
    });
  }
}

for (const view of ["serial", "node"]) {
  for (const completion of ["during", "after"]) {
    test(`${view} tool card stays steady while its entrance plays naturally and completes ${completion} entrance`, { timeout: 30_000 }, async () => {
      const { context, page, errors } = await fixture(`latestScroll&layout=live-tool&view=${view}`, undefined, "no-preference");
      try {
        const scroller = page.locator(".initial-query-scroll");
        await page.getByText("Virtualized message 79", { exact: true }).waitFor();
        await page.waitForTimeout(400);
        const samples = await scroller.evaluate(async (scroll, completion) => {
          scroll.scrollTop = scroll.scrollHeight;
          const id = "natural-entrance-tool";
          window.audit.appendToolEvents([{ type: "message_update",
            assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id } }]);
          const samples = [];
          let executionStarted = false;
          let settledAt = null;
          let entrance = null;
          const start = performance.now();
          await new Promise(resolve => {
            const frame = () => {
              const card = scroll.querySelector(".tool-call-card");
              if (card) {
                entrance ??= card.getAnimations().find(animation => animation.effect.getKeyframes()
                  .some(frame => frame.transform !== undefined && frame.opacity !== undefined));
                const rect = card.getBoundingClientRect();
                const style = getComputedStyle(card);
                const dy = style.transform === "none" ? 0 : new DOMMatrix(style.transform).m42;
                samples.push({ top: rect.top, layoutTop: rect.top - dy, height: card.offsetHeight,
                  scrollTop: scroll.scrollTop, rowHeight: card.closest("[data-transcript-id]").offsetHeight });
                const progress = entrance?.effect.getComputedTiming().progress;
                if (!executionStarted && (progress >= 0.2 || entrance?.playState === "finished")) {
                  executionStarted = true;
                  window.audit.appendToolEvents([{ type: "tool_execution_start", toolCallId: id, toolName: "bash",
                    args: { command: "echo live arguments arriving after toolcall_start" } }]);
                }
                const shouldSettle = executionStarted && (completion === "after" ? entrance?.playState === "finished" : progress >= 0.6);
                if (settledAt === null && shouldSettle) {
                  settledAt = performance.now();
                  window.audit.appendToolEvents([{ type: "tool_execution_end", toolCallId: id, toolName: "bash",
                    result: { content: "completed", details: { exitCode: 0, truncated: true } } }]);
                }
              }
              if ((settledAt !== null && performance.now() - settledAt > 350) || performance.now() - start > 3000) resolve();
              else requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
          });
          return { samples, sawEntrance: !!entrance, settled: settledAt !== null };
        }, completion);
        assert.ok(samples.sawEntrance && samples.settled, "exercise a real, unpaused entrance and tool completion");
        const frames = samples.samples;
        assert.ok(Math.max(...frames.map(frame => frame.layoutTop)) - Math.min(...frames.map(frame => frame.layoutTop)) <= 1,
          `appearance/activity must not move the card's layout anchor: ${JSON.stringify(frames)}`);
        assert.ok(frames.every((frame, index) => index === 0 || frame.top <= frames[index - 1].top + 1),
          `the natural entrance must not bounce back down: ${JSON.stringify(frames)}`);
        assert.ok(frames.every(frame => frame.height === frames[0].height && frame.rowHeight === frames[0].rowHeight),
          "tool completion cannot disturb measured row height");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }
}

async function sampleCardToggle(header) {
  return header.evaluate(async header => {
    const card = header.parentElement;
    const scroll = card.closest(".initial-query-scroll");
    const samples = [];
    const sample = () => {
      const value = { top: card.getBoundingClientRect().top, height: card.getBoundingClientRect().height,
        bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight };
      if (JSON.stringify(samples.at(-1)) !== JSON.stringify(value)) samples.push(value);
    };
    sample();
    scroll.addEventListener("scroll", sample);
    header.click();
    const start = performance.now();
    await new Promise(resolve => {
      const frame = () => {
        sample();
        if (performance.now() - start < 450) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    scroll.removeEventListener("scroll", sample);
    return samples;
  });
}

async function assertCardAboveComposer(card) {
  const bounds = await card.evaluate(card => {
    const scroll = card.closest(".initial-query-scroll").getBoundingClientRect();
    const composer = card.closest(".initial-query-view").querySelector(".pane-bottom-chat").getBoundingClientRect();
    const header = card.querySelector('[aria-expanded]').getBoundingClientRect();
    const content = card.getBoundingClientRect();
    return { viewportTop: scroll.top, visibleBottom: Math.min(scroll.bottom, composer.top),
      headerTop: header.top, headerBottom: header.bottom, cardBottom: content.bottom, cardHeight: content.height };
  });
  assert.ok(bounds.headerTop >= bounds.viewportTop - 1 && bounds.headerBottom <= bounds.visibleBottom + 1,
    `the header must remain visible above the composer: ${JSON.stringify(bounds)}`);
  if (bounds.cardHeight <= bounds.visibleBottom - bounds.viewportTop - 24) {
    assert.ok(bounds.cardBottom <= bounds.visibleBottom + 1,
      `a card that fits must not be covered by the composer: ${JSON.stringify(bounds)}`);
  }
  return bounds;
}

for (const type of ["tool", "thinking"]) {
  test(`${type} card at the conversation bottom opens and closes without a scroll jump`, { timeout: 30_000 }, async () => {
    const { context, page, errors } = await fixture(`latestScroll&layout=${type}-card`, undefined, "no-preference");
    try {
      const card = page.locator(type === "tool" ? ".tool-call-card" : ".thinking-card");
      const header = card.locator(type === "tool" ? ".tool-call-header" : ".thinking-card-header");
      const body = card.locator(type === "tool" ? ".tool-call-body" : ".thinking-card-body");
      const scroller = page.locator(".initial-query-scroll");
      await card.waitFor();
      await page.waitForTimeout(400);
      assert.equal(await body.count(), 0, "folded history must not mount the body");
      for (let repeat = 0; repeat < 2; repeat++) {
        await header.scrollIntoViewIfNeeded();
        const opening = await sampleCardToggle(header);
        assert.ok(opening.some(sample => sample.height > opening[0].height + 5 && sample.height < opening.at(-1).height - 5),
          "opening reveals content progressively");
        assert.equal(await header.getAttribute("aria-expanded"), "true");
        await body.waitFor();
        await assertCardAboveComposer(card);
        await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await page.waitForTimeout(100);
        const samples = await sampleCardToggle(header);
        const first = samples[0], last = samples.at(-1);
        assert.ok(samples.every(sample => sample.bottomGap <= first.bottomGap + 3),
          `closing at the bottom must not open a transient scroll gap: ${JSON.stringify(samples)}`);
        assert.ok(first.height > last.height + 100, "the expanded card has substantial content");
        assert.ok(samples.some(sample => sample.height > last.height + 5 && sample.height < first.height - 5),
          "closing passes through intermediate heights rather than unmounting instantly");
        const min = Math.min(first.top, last.top) - 3, max = Math.max(first.top, last.top) + 3;
        assert.ok(samples.every(sample => sample.top >= min && sample.top <= max),
          `the header cannot jump outside its start/end positions: ${JSON.stringify(samples)}`);
        assert.ok(samples.every((sample, index) => index === 0 || sample.top >= samples[index - 1].top - 3),
          `bottom clamping must not bounce the header back up: ${JSON.stringify(samples)}`);
        await body.waitFor({ state: "detached" });
        assert.equal(await header.getAttribute("aria-expanded"), "false");
      }
      // Reversing a transition must retain the final requested state and content.
      await header.evaluate(async header => {
        for (let toggle = 0; toggle < 3; toggle++) {
          header.click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
      });
      await page.waitForTimeout(400);
      assert.equal(await header.getAttribute("aria-expanded"), "true");
      await body.waitFor({ state: "visible" });
      await header.press("Space");
      await body.waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const type of ["tool", "thinking"]) {
  test(`${type} card reveal respects a multiline composer and a short conversation pane`, { timeout: 30_000 }, async () => {
    const draft = Array.from({ length: 12 }, (_, index) => `Unsent draft line ${index}`).join("\n");
    for (const paneHeight of [800, 540]) {
      const { context, page, errors } = await fixture(`latestScroll&layout=${type}-card`, undefined, "no-preference");
      try {
        const card = page.locator(type === "tool" ? ".tool-call-card" : ".thinking-card");
        const header = card.locator('[aria-expanded]');
        const input = page.locator(".pane-bottom-chat textarea");
        const scroller = page.locator(".initial-query-scroll");
        await card.waitFor();
        await page.locator(".workbench").evaluate((element, height) => { element.parentElement.style.height = `${height}px`; }, paneHeight);
        await input.fill(draft);
        await page.waitForTimeout(400);
        // Read slightly above the newest output so this exercises the in-place
        // reveal rather than the follow-to-bottom expansion covered separately.
        await scroller.evaluate(scroll => {
          // Model a real reader: only a gesture takes over from following.
          scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -60, bubbles: true }));
          scroll.scrollTop = Math.max(0, scroll.scrollTop - 60);
        });
        await page.waitForTimeout(100);
        await header.click();
        await page.waitForTimeout(450);
        const bounds = await assertCardAboveComposer(card);
        if (paneHeight === 540) {
          assert.ok(bounds.cardHeight > bounds.visibleBottom - bounds.viewportTop,
            "the short pane exercises a card taller than the unobscured viewport");
        }
        await header.press("Space");
        await page.waitForTimeout(350);
        await assertCardAboveComposer(card);
        assert.equal(await input.inputValue(), draft, "resizing cards must preserve the unsent multiline draft");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  });
}

test("a tall thinking card expands without pulling its visible header on a short pane", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=thinking-card", undefined, "no-preference");
  try {
    const card = page.locator(".thinking-card");
    const header = card.locator(".thinking-card-header");
    const input = page.locator(".pane-bottom-chat textarea");
    await card.waitFor();
    await page.locator(".workbench").evaluate(element => { element.parentElement.style.height = "540px"; });
    await input.fill(Array.from({ length: 12 }, (_, index) => `Unsent draft line ${index}`).join("\n"));
    await page.waitForTimeout(400);
    const geometry = () => card.evaluate(card => {
      const scroll = card.closest(".initial-query-scroll").getBoundingClientRect();
      const composer = card.closest(".initial-query-view").querySelector(".pane-bottom-chat").getBoundingClientRect();
      const header = card.querySelector(".thinking-card-header").getBoundingClientRect();
      return { top: header.top, bottom: header.bottom, height: card.getBoundingClientRect().height,
        visibleTop: Math.max(0, scroll.top), visibleBottom: Math.min(window.innerHeight, composer.top) };
    });
    // Put read content below the card so it can sit mid-screen and away from
    // the bottom while the reader is not following new output.
    await page.evaluate(() => window.audit.appendToolEvents(Array.from({ length: 6 }, (_, index) => ({
      type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `AFTER_COT_CONTENT_${index}` }] },
    }))));
    await page.getByText("AFTER_COT_CONTENT_5", { exact: true }).waitFor();
    await page.waitForTimeout(200);
    await card.evaluate(card => {
      const scroll = card.closest(".initial-query-scroll");
      const header = card.querySelector(".thinking-card-header").getBoundingClientRect();
      scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
      scroll.scrollTop += header.top - (scroll.getBoundingClientRect().top + 100);
    });
    await page.waitForTimeout(100);
    assert.equal(await card.evaluate(card => {
      const scroll = card.closest(".initial-query-scroll");
      return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 35;
    }), true, "the reader starts scrolled away from the newest output");
    const before = await geometry();
    assert.ok(before.top >= before.visibleTop && before.bottom <= before.visibleBottom,
      `the header starts visible: ${JSON.stringify(before)}`);
    const box = await header.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(450);
    const after = await geometry();
    assert.ok(after.height > after.visibleBottom - after.visibleTop,
      "the expanded card is taller than the unobscured viewport");
    assert.ok(Math.abs(after.top - before.top) <= 2,
      `opening must keep the clicked header in place: ${JSON.stringify({ before, after })}`);
    assert.ok(after.top >= after.visibleTop && after.bottom <= after.visibleBottom,
      `the header remains visible: ${JSON.stringify(after)}`);
    await header.evaluate(element => element.click());
    await page.waitForTimeout(350);
    await card.evaluate(card => {
      const scroll = card.closest(".initial-query-scroll");
      const header = card.querySelector(".thinking-card-header").getBoundingClientRect();
      const composer = card.closest(".initial-query-view").querySelector(".pane-bottom-chat").getBoundingClientRect();
      scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
      scroll.scrollTop += header.top - (composer.top - 8);
    });
    await page.waitForTimeout(50);
    const partialBefore = await geometry();
    assert.ok(partialBefore.top < partialBefore.visibleBottom && partialBefore.bottom > partialBefore.visibleBottom,
      `the header starts partially visible: ${JSON.stringify(partialBefore)}`);
    const partialBox = await header.boundingBox();
    await page.mouse.click(partialBox.x + partialBox.width / 2, partialBefore.top + 4);
    await page.waitForTimeout(450);
    const partialAfter = await geometry();
    assert.ok(Math.abs(partialAfter.top - partialBefore.top) <= 2,
      `opening a partially visible header must not move it: ${JSON.stringify({ partialBefore, partialAfter })}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("expanding a thinking card while following keeps the conversation at the bottom", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=thinking-card", undefined, "no-preference");
  try {
    const card = page.locator(".thinking-card");
    const header = card.locator(".thinking-card-header");
    const input = page.locator(".pane-bottom-chat textarea");
    const scroller = page.locator(".initial-query-scroll");
    const bottomGap = () => scroller.evaluate(scroll => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight);
    await card.waitFor();
    await page.locator(".workbench").evaluate(element => { element.parentElement.style.height = "540px"; });
    await input.fill(Array.from({ length: 12 }, (_, index) => `Unsent draft line ${index}`).join("\n"));
    await page.waitForTimeout(400);
    await scroller.evaluate(scroll => { scroll.scrollTop = scroll.scrollHeight; });
    await page.waitForTimeout(100);
    assert.ok(await bottomGap() <= 2, "the reader starts at the newest output");
    const box = await header.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(450);
    assert.ok(await bottomGap() <= 2, "opening the card keeps the expanded content visible at the bottom");
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FOLLOW_AFTER_COT" }] },
    }]));
    await page.getByText("FOLLOW_AFTER_COT", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    assert.ok(await bottomGap() <= 2, "new output still follows after the expansion");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a tall live thinking card stays at the newest reasoning when the conversation pane resizes", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node", undefined, "reduce");
  try {
    const scroller = page.locator(".initial-query-scroll");
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: Array.from({ length: 40 }, (_, index) => `LIVE_REASONING_${index}\n\n`).join("") } },
    ]));
    const card = page.locator(".thinking-card");
    await card.locator(".thinking-card-body").waitFor();
    await page.waitForTimeout(200);
    assert.ok(await scroller.evaluate(scroll => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) <= 2,
      "the live reasoning starts at the bottom");
    // A shorter conversation pane reflows the card without appending more
    // reasoning. A follower must move to the new bottom, not stay anchored on
    // the card header that happened to be at the old viewport top.
    await page.locator(".workbench").evaluate(element => { element.parentElement.style.height = "540px"; });
    await page.waitForTimeout(300);
    const state = await scroller.evaluate(scroll => {
      const card = scroll.querySelector(".thinking-card");
      const body = card.querySelector(".thinking-card-body");
      const working = scroll.querySelector(".workspace-details .working-indicator");
      const composer = card.closest(".initial-query-view").querySelector(".pane-bottom-chat");
      const cardBounds = card.getBoundingClientRect();
      const scrollBounds = scroll.getBoundingClientRect();
      const workingBounds = working?.getBoundingClientRect();
      const composerBounds = composer?.getBoundingClientRect();
      return { bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        bodyGap: body ? body.scrollHeight - body.scrollTop - body.clientHeight : null,
        cardTop: cardBounds.top - scrollBounds.top, cardHeight: cardBounds.height, clientHeight: scroll.clientHeight,
        workingVisible: !!workingBounds && workingBounds.top >= scrollBounds.top && workingBounds.bottom <= scrollBounds.bottom,
        workingAboveComposer: !!workingBounds && (!composerBounds || workingBounds.bottom <= composerBounds.top) };
    });
    assert.ok(state.bottomGap <= 2, `the resize must keep the newest reasoning visible: ${JSON.stringify(state)}`);
    assert.ok(state.bodyGap <= 2, `the card body must follow its own latest line: ${JSON.stringify(state)}`);
    assert.ok(state.cardTop < 0,
      `the newest reasoning, not the card header, must be the focus after the resize: ${JSON.stringify(state)}`);
    assert.equal(state.workingVisible, true,
      `the conversation's working footer must stay in view: ${JSON.stringify(state)}`);
    assert.equal(state.workingAboveComposer, true,
      `the working footer must stay above the composer: ${JSON.stringify(state)}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("scrolling inside a live thinking card leaves the conversation following its own bottom", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool", undefined, "reduce");
  try {
    const scroller = page.locator(".initial-query-scroll");
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: Array.from({ length: 60 }, (_, index) => `INNER_SCROLL_REASONING_${index}\n\n`).join("") } },
    ]));
    const body = page.locator(".thinking-card-body");
    await body.waitFor();
    await page.waitForTimeout(200);
    const innerBefore = await body.evaluate(element => ({ top: element.scrollTop,
      max: element.scrollHeight - element.clientHeight }));
    assert.ok(innerBefore.max > 200, `the reasoning body must have its own scroll range: ${JSON.stringify(innerBefore)}`);
    await body.hover();
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(250);
    const innerAfter = await body.evaluate(element => element.scrollTop);
    assert.ok(innerAfter < innerBefore.top - 20, `the wheel must move only the inner reasoning viewport: ${innerAfter}`);
    assert.ok(await scroller.evaluate(scroll => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) <= 2,
      "an inner scroll must not turn off the conversation's bottom follow state");
    // More reasoning keeps streaming while the reader is scrolled inside the
    // card. The card must not snap the reader back to the latest line.
    for (let chunk = 0; chunk < 4; chunk++) {
      await page.evaluate(chunk => window.audit.appendToolEvents([{
        type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
          delta: `INNER_SCROLL_MORE_${chunk} ` + "reasoning detail ".repeat(20) },
      }]), chunk);
      await page.waitForTimeout(80);
    }
    const innerWhileStreaming = await body.evaluate(element => ({
      top: element.scrollTop, bottomGap: element.scrollHeight - element.scrollTop - element.clientHeight }));
    assert.ok(innerWhileStreaming.bottomGap > 100,
      `streaming must not force an inner reader back to the latest line: ${JSON.stringify(innerWhileStreaming)}`);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "AFTER_INNER_CARD_SCROLL" }] },
    }]));
    await page.getByText("AFTER_INNER_CARD_SCROLL", { exact: true }).waitFor();
    await page.waitForTimeout(250);
    const state = await scroller.evaluate(scroll => {
      const marker = [...scroll.querySelectorAll("*")].find(element => element.textContent === "AFTER_INNER_CARD_SCROLL");
      const bounds = marker?.getBoundingClientRect(), view = scroll.getBoundingClientRect();
      return { bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        markerVisible: !!bounds && bounds.bottom > view.top && bounds.top < view.bottom };
    });
    assert.ok(state.bottomGap <= 2, `outer output must keep following after an inner scroll: ${JSON.stringify(state)}`);
    assert.equal(state.markerVisible, true, `the new bottom row must be visible: ${JSON.stringify(state)}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("streamed reasoning cannot override an inner reading gesture before its scroll event", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool", undefined, "reduce");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: Array.from({ length: 60 }, (_, index) => `GESTURE_REASONING_${index}\n\n`).join("") } },
    ]));
    const body = page.locator(".thinking-card-body");
    await body.waitFor();
    await page.waitForTimeout(200);
    assert.ok(await body.evaluate(element => element.scrollHeight - element.clientHeight > 200));
    await body.evaluate(element => {
      // The next streamed line can commit before the browser dispatches this
      // gesture's scroll event. The intent must still lock the inner viewport.
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -160, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollTop - 160);
      window.audit.appendToolEvents([{
        type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
          delta: "GESTURE_MORE_REASONING " + "detail ".repeat(80) },
      }]);
    });
    await page.waitForTimeout(250);
    const gap = await body.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
    assert.ok(gap > 100, `the reading gesture must not be snapped to the latest line: ${gap}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("scrolling over a short reasoning card does not leave its future content unfollowed", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node", undefined, "reduce");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "SHORT_REASONING" } },
    ]));
    const body = page.locator(".thinking-card-body");
    await body.waitFor();
    await page.waitForTimeout(150);
    assert.ok(await body.evaluate(element => element.scrollHeight <= element.clientHeight + 1),
      "the initial card is too short to scroll internally");
    await body.hover();
    await page.mouse.wheel(0, -160);
    await page.waitForTimeout(200);
    // The wheel moved the conversation, not the short card. It must not lock
    // the card's own follow once more reasoning makes the body scrollable.
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: Array.from({ length: 60 }, (_, index) => `LATER_REASONING_${index}\n\n`).join("") } },
    ]));
    await page.waitForTimeout(300);
    const gap = await body.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
    assert.ok(gap <= 2, `the card must resume following its own newest reasoning: ${gap}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a growing reasoning card reserves its scrollbar track instead of rewrapping mid-stream", { timeout: 30_000 }, async () => {
  // Playwright hides scrollbars by default, while Grapher paints its own 10px
  // track. Launch with classic scrollbars so the width change is observable.
  const scrollbarBrowser = await chromium.launch({
    channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"),
    headless: true, ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  let context;
  try {
    const view = await fixture("thinking", undefined, "reduce", undefined, undefined, scrollbarBrowser);
    context = view.context;
    const { page, errors } = view;
    await page.evaluate(() => {
      window.audit.append({ type: "message_start", message: { role: "assistant", content: [] } });
      window.audit.append({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
      window.audit.append({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "SHORT_REASONING" } });
    });
    const body = page.locator('[data-thinking-view="live"] .thinking-card-body');
    await body.waitFor();
    await body.getByText("SHORT_REASONING").waitFor();
    const measure = () => body.evaluate(element => ({
      clientWidth: element.clientWidth, offsetWidth: element.offsetWidth,
      scrollable: element.scrollHeight > element.clientHeight + 1,
      gutter: getComputedStyle(element).scrollbarGutter,
    }));
    const short = await measure();
    assert.equal(short.scrollable, false, "the initial card does not need a scrollbar");
    assert.equal(short.gutter, "stable");
    // The reserved gutter is not a scrollbar yet. Clicking it on this short card
    // must not count as a scrollbar gesture and stop the card's own following.
    const bounds = await body.boundingBox();
    await page.mouse.click(bounds.x + bounds.width - 4, bounds.y + 20);
    await page.evaluate(() => window.audit.append({ type: "message_update", assistantMessageEvent: {
      type: "thinking_delta", contentIndex: 0,
      delta: "\n\n" + Array.from({ length: 60 }, (_, index) => `GROWING_REASONING_${index} with enough detail to wrap`).join("\n\n"),
    } }));
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-thinking-view="live"] .thinking-card-body');
      return element && element.scrollHeight > element.clientHeight + 1;
    });
    const tall = await measure();
    assert.equal(tall.scrollable, true, "the grown card scrolls internally");
    assert.equal(tall.clientWidth, short.clientWidth,
      `the scrollbar must not narrow the reasoning: ${JSON.stringify({ short, tall })}`);
    assert.equal(tall.offsetWidth, short.offsetWidth);
    await page.waitForTimeout(100);
    const gap = await body.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
    assert.ok(gap <= 2, `the card still follows its newest reasoning after the gutter click: ${gap}`);
    assert.deepEqual(errors, []);
  } finally { await context?.close(); await scrollbarBrowser.close(); }
});

for (const reducedMotion of ["no-preference", "reduce"]) {
  test(`resolving an auto route keeps a Planner reader where they scrolled to (${reducedMotion})`, { timeout: 30_000 }, async () => {
    // Auto routing renders the Planner pane while the route is still undecided.
    // Folding the raw route into the conversation key turned the Partitioner's
    // answer into a view switch that dropped the reader's position and follow
    // state, snapping a historical read back to the newest row.
    const { context, page, errors } = await fixture("plannerRoute", undefined, reducedMotion);
    try {
      await page.locator(".conversation-ready").waitFor();
      await page.waitForTimeout(300);
      const scroller = page.locator(".initial-query-scroll");
      const snapshot = () => scroller.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const rows = [...element.querySelectorAll("[data-transcript-id]")];
        return { top: element.scrollTop, gap: element.scrollHeight - element.scrollTop - element.clientHeight,
          following: element.dataset.transcriptFollowing ?? null,
          topRow: rows.find(row => row.getBoundingClientRect().bottom > bounds.top)?.dataset.transcriptId ?? null,
          opacity: getComputedStyle(element.querySelector(".chat-messages-stream")).opacity };
      });
      await scroller.hover();
      for (let step = 0; step < 4; step++) await page.mouse.wheel(0, -200);
      await page.waitForTimeout(150);
      const before = await snapshot();
      assert.ok(before.gap > 300, `the reader scrolled up into history: ${JSON.stringify(before)}`);
      assert.equal(before.following, null, "an upward gesture stops following the newest row");
      await page.evaluate(() => window.audit.setRoute("graph"));
      await page.waitForTimeout(250);
      const after = await snapshot();
      assert.equal(after.following, null, `the resolved route re-enabled following: ${JSON.stringify(after)}`);
      assert.ok(Math.abs(after.top - before.top) <= 3, `the resolved route moved the reader: ${JSON.stringify({ before, after })}`);
      assert.ok(after.gap > 300, `the resolved route left the newest row in view: ${JSON.stringify(after)}`);
      assert.equal(after.topRow, before.topRow, `the resolved route swapped the visible row: ${JSON.stringify({ before, after })}`);
      assert.equal(after.opacity, "1", "resolving the route must not blank the conversation");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("focusing an older reasoning card keeps keyboard navigation in place during live output", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Read this reasoning" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta",
        delta: Array.from({ length: 40 }, (_, index) => `FOCUS_ANSWER_${index} ${"detail ".repeat(20)}\n\n`).join("") } },
    ]));
    await page.getByText(/FOCUS_ANSWER_39/).waitFor();
    const scroller = page.locator(".initial-query-scroll");
    const header = page.locator(".thinking-card-header");
    await page.waitForTimeout(300);
    await header.evaluate(el => el.focus({ preventScroll: true }));
    await page.waitForTimeout(80);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " FOCUS_WITHOUT_SCROLL" },
    }]));
    await page.getByText(/FOCUS_WITHOUT_SCROLL/).waitFor({ state: "attached" });
    await page.waitForTimeout(100);
    assert.ok(await scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight) <= 2,
      "focusing without moving the viewport must not disable following");
    await header.evaluate(el => el.blur());
    await header.focus();
    await page.waitForTimeout(150);
    const before = await scroller.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
    assert.ok(before.gap > 500, `focusing the older header scrolls away from the bottom: ${JSON.stringify(before)}`);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " NEW_AFTER_FOCUS" },
    }]));
    await page.getByText(/NEW_AFTER_FOCUS/).waitFor({ state: "attached" });
    await page.waitForTimeout(250);
    const after = await scroller.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
    assert.ok(Math.abs(after.top - before.top) <= 3 && after.gap > 500,
      `live output must not pull a focused history control away: ${JSON.stringify({ before, after })}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("an upward gesture with no conversation scroll range keeps following", { timeout: 30_000 }, async () => {
  for (const gesture of ["wheel", "keyboard", "touch"]) {
    const { context, page, errors } = await fixture("latestScroll&layout=live-empty&view=node");
    try {
      const scroller = page.locator(".initial-query-scroll.conversation-ready");
      await scroller.waitFor();
      await page.waitForTimeout(200);
      const initial = await scroller.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
      assert.ok(initial.top <= 1 && initial.gap <= 2, `the empty conversation cannot scroll: ${JSON.stringify(initial)}`);
      await scroller.evaluate((el, gesture) => {
        if (gesture === "wheel") el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
        else if (gesture === "keyboard") el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
        else {
          el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [new Touch({ identifier: 1, target: el, clientY: 100 })] }));
          el.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [new Touch({ identifier: 1, target: el, clientY: 140 })] }));
        }
      }, gesture);
      await page.evaluate(() => window.audit.appendToolEvents([{
        type: "message_end", message: { role: "assistant", content: [{ type: "text",
          text: Array.from({ length: 30 }, (_, index) => `EMPTY_GESTURE_${index} ${"detail ".repeat(20)}\n\n`).join("") }] },
      }]));
      await page.getByText(/EMPTY_GESTURE_29/).waitFor({ state: "attached" });
      await page.waitForTimeout(200);
      const gap = await scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
      assert.ok(gap <= 2, `${gesture} without movement must not disable following: ${gap}`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test("a scrollbar-edge click without movement does not disable following", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node");
  try {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(400);
    const scroller = page.locator(".initial-query-scroll");
    const box = await scroller.boundingBox();
    await page.mouse.click(box.x + box.width - 7, box.y + box.height - 8);
    await page.waitForTimeout(100);
    assert.ok(await scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight) <= 2,
      "the click must not have scrolled the conversation");
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_update", assistantMessageEvent: { type: "text_delta",
        delta: Array.from({ length: 35 }, (_, index) => `EDGE_ANSWER_${index} ${"detail ".repeat(20)}\n\n`).join("") },
    }]));
    await page.getByText(/EDGE_ANSWER_34/).waitFor({ state: "attached" });
    await page.waitForTimeout(300);
    const gap = await scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
    assert.ok(gap <= 2, `output still follows after a stationary scrollbar click: ${gap}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a stationary scrollbar click preserves a reader just above the bottom", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node");
  try {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    const scroller = page.locator(".initial-query-scroll");
    await scroller.evaluate(el => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -10, bubbles: true }));
      el.scrollTop -= 10;
    });
    await page.waitForTimeout(100);
    const before = await scroller.evaluate(el => el.scrollTop);
    const box = await scroller.boundingBox();
    await page.mouse.click(box.x + box.width - 7, box.y + box.height - 8);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "NEAR_BOTTOM_READER" },
    }]));
    await page.getByText(/NEAR_BOTTOM_READER/).waitFor({ state: "attached" });
    await page.waitForTimeout(200);
    assert.ok(Math.abs(await scroller.evaluate(el => el.scrollTop) - before) <= 3,
      "a click without movement must not convert an existing reader to a follower");
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")); });
    await page.waitForFunction(() => document.querySelector(".initial-query-scroll").dataset.transcriptFollowing === "true");
    const smallDrag = await scroller.evaluate(el => {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 8, clientX: rect.right - 7, clientY: rect.top + 40 }));
      el.scrollTop -= 10; el.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 8 }));
      return { top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight, following: el.dataset.transcriptFollowing };
    });
    assert.ok(smallDrag.gap >= 8 && !smallDrag.following,
      `the small upward drag must not immediately snap back: ${JSON.stringify(smallDrag)}`);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " SMALL_DRAG_READER" },
    }]));
    await page.getByText(/SMALL_DRAG_READER/).waitFor({ state: "attached" });
    await page.waitForTimeout(200);
    assert.ok(Math.abs(await scroller.evaluate(el => el.scrollTop) - smallDrag.top) <= 3,
      "even a small intentional upward drag must take over from following");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a scrollbar drag that starts near the bottom remains a reading gesture", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    const scroller = page.locator(".initial-query-scroll");
    await scroller.evaluate(el => {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 5, clientX: rect.right - 7, clientY: rect.top + 40 }));
      el.scrollTop -= 10;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(50);
    await scroller.evaluate(el => { el.scrollTop -= 160; el.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(50);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 5 })));
    const before = await scroller.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
    assert.ok(before.gap > 100, `the drag moved away from the newest output: ${JSON.stringify(before)}`);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "DRAG_READING_NEW_OUTPUT" },
    }]));
    await page.getByText(/DRAG_READING_NEW_OUTPUT/).waitFor({ state: "attached" });
    await page.waitForTimeout(250);
    const after = await scroller.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
    assert.ok(Math.abs(after.top - before.top) <= 3 && after.gap > 100,
      `a drag must not be mistaken for layout movement: ${JSON.stringify({ before, after })}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const gesture of ["wheel", "wheel-small", "touch", "keyboard", "scrollbar"]) {
  test(`${gesture} scrolling the final answer does not let a draining CoT push it out of view`, { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node", undefined, "no-preference");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "SEED" } },
    ]));
    await page.locator(".thinking-card-body").waitFor();
    await page.waitForTimeout(80);
    // The provider can finish reasoning while its typewriter still has a
    // backlog. The card keeps growing above the already-started final answer.
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: Array.from({ length: 500 }, (_, index) => `ANCHOR_REASON_${index} ${"detail ".repeat(5)}\n\n`).join("") },
    }]));
    await page.waitForTimeout(60);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta",
        delta: "ANSWER_READING_ANCHOR\n\n" + "Visible answer detail ".repeat(24) } },
    ]));
    const marker = page.getByText(/ANSWER_READING_ANCHOR/);
    await marker.waitFor();
    const scroller = page.locator(".initial-query-scroll");
    await scroller.evaluate(el => {
      el.addEventListener("wheel", event => {
        if (event.deltaY >= 0) return;
        const marker = [...el.querySelectorAll("p")].find(p => p.textContent.includes("ANSWER_READING_ANCHOR"));
        window.audit.readingAnchorStart = { top: marker?.getBoundingClientRect().top,
          cardHeight: el.querySelector(".thinking-card")?.getBoundingClientRect().height,
          scrollTop: el.scrollTop, target: event.target.closest("[data-transcript-id]")?.dataset.transcriptId,
          answerRow: marker?.closest("[data-transcript-id]")?.dataset.transcriptId };
      }, { capture: true, once: true });
      window.audit.readingScrollSamples = [];
      el.addEventListener("scroll", () => {
        if (window.audit.readingScrollSamples.length < 30) window.audit.readingScrollSamples.push({ top: el.scrollTop,
          following: el.dataset.transcriptFollowing ?? null });
      });
      let index = 0;
      window.audit.answerStreamTimer = setInterval(() => window.audit.appendToolEvents([{
        type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ` continued_${index++}` },
      }]), 90);
    });
    if (gesture === "wheel" || gesture === "wheel-small") {
      const box = await marker.locator("xpath=ancestor::*[@data-transcript-id][1]").boundingBox();
      await page.mouse.move(box.x + 10, box.y + box.height / 2);
      await page.mouse.wheel(0, gesture === "wheel-small" ? -10 : -50);
    } else {
      await scroller.evaluate((el, gesture) => {
        const marker = [...el.querySelectorAll("p")].find(p => p.textContent.includes("ANSWER_READING_ANCHOR"));
        window.audit.readingAnchorStart = { top: marker.getBoundingClientRect().top,
          cardHeight: el.querySelector(".thinking-card").getBoundingClientRect().height };
        if (gesture === "touch") {
          const touch = clientY => new Touch({ identifier: 9, target: marker, clientY });
          marker.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(100)] }));
          marker.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [touch(150)] }));
        } else if (gesture === "keyboard") {
          marker.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
        } else {
          const rect = el.getBoundingClientRect();
          el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 9, clientX: rect.right - 7, clientY: rect.top + 40 }));
        }
        el.scrollTop -= 50;
        el.dispatchEvent(new Event("scroll"));
        if (gesture === "scrollbar") window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9 }));
      }, gesture);
    }
    await page.waitForTimeout(800);
    const state = await scroller.evaluate(el => {
      clearInterval(window.audit.answerStreamTimer);
      const marker = [...el.querySelectorAll("p")].find(p => p.textContent.includes("ANSWER_READING_ANCHOR"));
      const card = el.querySelector(".thinking-card"), view = el.getBoundingClientRect();
      const composer = el.closest(".initial-query-view").querySelector(".pane-bottom-chat")?.getBoundingClientRect();
      return { start: window.audit.readingAnchorStart, marker: marker?.getBoundingClientRect().toJSON(),
        cardHeight: card?.getBoundingClientRect().height, visibleBottom: Math.min(view.bottom, composer?.top ?? view.bottom),
        following: el.dataset.transcriptFollowing ?? null, samples: window.audit.readingScrollSamples };
    });
    assert.ok(state.start && state.cardHeight > state.start.cardHeight + 100,
      `the CoT must keep growing after the user starts reading: ${JSON.stringify(state)}`);
    assert.equal(state.following, null, `the upward gesture must stop bottom-following: ${JSON.stringify(state)}`);
    if (gesture === "wheel" || gesture === "wheel-small") assert.equal(state.start.target, state.start.answerRow,
      `the real wheel must target the answer, not the growing card: ${JSON.stringify(state)}`);
    const scrollDelta = gesture === "wheel-small" ? 10 : 50;
    assert.ok(state.marker && Math.abs(state.marker.top - (state.start.top + scrollDelta)) <= 25 && state.marker.bottom <= state.visibleBottom,
      `the answer being read must stay in view rather than being pushed down by CoT: ${JSON.stringify(state)}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  });
}

test("paged Node output keeps the answer being read visible while CoT drains", { timeout: 30_000 }, async () => {
  const line = event => JSON.stringify(event) + "\n";
  const history = Array.from({ length: 80 }, (_, index) => line({ type: "message_end", message: { role: "assistant",
    content: [{ type: "text", text: `Virtualized message ${index}` }] } })).join("");
  let output = history + [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "SEED " } },
  ].map(line).join("");
  let timer;
  const { context, page, errors } = await fixture("latestScroll&layout=live-paged&view=node", async (route, command, body) => {
    if (command !== "get_execution_output") return false;
    const bytes = Buffer.from(output), start = body.tail ? 0 : body.offset, end = bytes.length;
    await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
      content: bytes.subarray(start, end).toString(), startOffset: start, nextOffset: end,
      totalBytes: end, complete: true, status: "running" } } });
    return true;
  }, "no-preference");
  try {
    await page.locator(".thinking-card-body").waitFor();
    output += line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
      delta: "thought ".repeat(3000) } });
    await page.waitForFunction(() => document.querySelector(".thinking-card-body")?.textContent.includes("thought"));
    output += [
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta",
        delta: "PAGED_READING_ANCHOR\n\n" + "Visible answer detail ".repeat(24) } },
    ].map(line).join("");
    const marker = page.getByText("PAGED_READING_ANCHOR", { exact: true });
    await marker.waitFor();
    const scroller = page.locator(".initial-query-scroll");
    await scroller.evaluate(el => el.addEventListener("wheel", () => {
      const marker = [...el.querySelectorAll("p")].find(p => p.textContent === "PAGED_READING_ANCHOR");
      window.audit.pagedAnchorStart = { top: marker.getBoundingClientRect().top,
        height: el.querySelector(".thinking-card").getBoundingClientRect().height };
    }, { capture: true, once: true }));
    timer = setInterval(() => { output += line({ type: "message_update", assistantMessageEvent: {
      type: "text_delta", delta: " continued output" } }); }, 100);
    const box = await marker.locator("xpath=ancestor::*[@data-transcript-id][1]").boundingBox();
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.wheel(0, -50);
    await page.waitForTimeout(1200);
    const state = await scroller.evaluate(el => {
      const marker = [...el.querySelectorAll("p")].find(p => p.textContent === "PAGED_READING_ANCHOR");
      const card = el.querySelector(".thinking-card"), composer = el.closest(".initial-query-view").querySelector(".pane-bottom-chat");
      return { start: window.audit.pagedAnchorStart, top: marker?.getBoundingClientRect().top,
        bottom: marker?.getBoundingClientRect().bottom, cardHeight: card?.getBoundingClientRect().height,
        visibleBottom: composer.getBoundingClientRect().top, following: el.dataset.transcriptFollowing ?? null };
    });
    assert.ok(state.start && state.cardHeight > state.start.height + 70,
      `paged CoT must keep growing after the answer starts: ${JSON.stringify(state)}`);
    assert.ok(state.following === null && Math.abs(state.top - (state.start.top + 50)) <= 25 && state.bottom <= state.visibleBottom,
      `paged output must preserve the line being read: ${JSON.stringify(state)}`);
    assert.deepEqual(errors, []);
  } finally { clearInterval(timer); await context.close(); }
});

test("a reader who scrolls past the answer is not anchored back to it while CoT grows", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node", undefined, "no-preference");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "SEED" } },
    ]));
    await page.locator(".thinking-card-body").waitFor();
    await page.waitForTimeout(80);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: Array.from({ length: 500 }, (_, index) => `PAST_REASON_${index} ${"detail ".repeat(5)}\n\n`).join("") },
    }]));
    await page.waitForTimeout(60);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ANSWER_SCROLL_PAST" } },
    ]));
    const marker = page.getByText("ANSWER_SCROLL_PAST", { exact: true });
    await marker.waitFor();
    const scroller = page.locator(".initial-query-scroll");
    await scroller.evaluate(el => {
      const answer = [...el.querySelectorAll("p")].find(p => p.textContent === "ANSWER_SCROLL_PAST");
      answer.dispatchEvent(new WheelEvent("wheel", { deltaY: -180, bubbles: true }));
      el.scrollTop -= 180;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(100);
    const snapshot = () => scroller.evaluate(el => {
      const card = el.querySelector(".thinking-card"), answer = [...el.querySelectorAll("p")]
        .find(p => p.textContent === "ANSWER_SCROLL_PAST"), composer = el.closest(".initial-query-view").querySelector(".pane-bottom-chat");
      return { cardTop: card.getBoundingClientRect().top, cardHeight: card.getBoundingClientRect().height,
        answerTop: answer.getBoundingClientRect().top, visibleBottom: composer.getBoundingClientRect().top,
        following: el.dataset.transcriptFollowing ?? null };
    });
    const before = await snapshot();
    assert.ok(before.answerTop > before.visibleBottom, `the reader intentionally moved past the answer: ${JSON.stringify(before)}`);
    await page.waitForTimeout(700);
    const after = await snapshot();
    assert.ok(after.cardHeight > before.cardHeight + 100, `the CoT must still be draining: ${JSON.stringify({ before, after })}`);
    assert.ok(Math.abs(after.cardTop - before.cardTop) <= 25 && after.following === null,
      `growth must not drag the reader back toward the offscreen answer: ${JSON.stringify({ before, after })}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a layout clamp inside the thinking card resumes its newest reasoning", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node", undefined, "no-preference");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: Array.from({ length: 200 }, (_, index) => `CLAMP_REASON_${index} ${"detail ".repeat(6)}\n\n`).join("") } },
    ]));
    const body = page.locator(".thinking-card-body");
    await body.waitFor();
    await page.waitForTimeout(400);
    assert.ok(await body.evaluate(el => el.scrollTop > 1000), "the reasoning body starts at its newest line");
    // A remount or reflow can move scrollTop to the top without any gesture.
    await body.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(120);
    const resumed = await body.evaluate(el => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    assert.ok(resumed.top >= resumed.max - 2, `a non-gesture clamp must not park the reasoning at its top: ${JSON.stringify(resumed)}`);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: "CLAMP_MORE " + "reason ".repeat(200) + "\n\n" },
    }]));
    await page.waitForTimeout(300);
    const after = await body.evaluate(el => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    assert.ok(after.top >= after.max - 2, `later reasoning must keep following its newest line: ${JSON.stringify(after)}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a layout clamp of a live card keeps the conversation on the newest reasoning", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node", undefined, "no-preference");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: Array.from({ length: 200 }, (_, index) => `OUTER_CLAMP_${index} ${"detail ".repeat(6)}\n\n`).join("") } },
    ]));
    await page.locator(".thinking-card-body").waitFor();
    await page.waitForTimeout(400);
    const scroller = page.locator(".initial-query-scroll");
    const state = () => scroller.evaluate(el => {
      const card = el.querySelector(".thinking-card");
      return { gap: el.scrollHeight - el.scrollTop - el.clientHeight, following: el.dataset.transcriptFollowing ?? null,
        cardTop: Math.round(card.getBoundingClientRect().top), viewTop: Math.round(el.getBoundingClientRect().top) };
    });
    assert.ok((await state()).gap <= 2, "the conversation starts at the newest reasoning line");
    // Rows above the viewport reflowing shrink scrollHeight and clamp scrollTop
    // upwards without a reader gesture.
    await scroller.evaluate(el => { el.scrollTop -= 420; el.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(150);
    const restored = await state();
    assert.ok(restored.gap <= 2 && restored.following === "true",
      `a layout clamp must restore bottom-following instead of parking on a card title: ${JSON.stringify(restored)}`);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: "OUTER_CLAMP_MORE " + "reason ".repeat(120) + "\n\n" },
    }]));
    await page.waitForTimeout(300);
    const after = await scroller.evaluate(el => {
      const body = el.querySelector(".thinking-card-body"), composer = el.closest(".initial-query-view").querySelector(".pane-bottom-chat");
      return { gap: el.scrollHeight - el.scrollTop - el.clientHeight, following: el.dataset.transcriptFollowing ?? null,
        bodyGap: body.scrollHeight - body.scrollTop - body.clientHeight,
        bodyBottom: body.getBoundingClientRect().bottom, visibleBottom: Math.min(el.getBoundingClientRect().bottom, composer.getBoundingClientRect().top) };
    });
    assert.ok(after.gap <= 2 && after.following === "true" && after.bodyGap <= 2 && after.bodyBottom <= after.visibleBottom,
      `reasoning output must keep following after the clamp: ${JSON.stringify(after)}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("manual outer scrollback is preserved through streamed and completed output", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    const scroller = page.locator(".initial-query-scroll");
    await scroller.hover({ position: { x: 20, y: 80 } });
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(200);
    const before = await scroller.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
    assert.ok(before.gap > 100, `the reader intentionally scrolled back: ${JSON.stringify(before)}`);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "READING_STREAM " } },
    ]));
    await page.getByText(/READING_STREAM/).waitFor({ state: "attached" });
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "READING_FINAL" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "READING_STREAM READING_FINAL" }] } },
    ]));
    await page.getByText(/READING_FINAL/).waitFor({ state: "attached" });
    await page.waitForTimeout(200);
    const during = await scroller.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
    assert.ok(Math.abs(during.top - before.top) <= 3 && during.gap > 100,
      `new and completed output must not override scrollback: ${JSON.stringify({ before, during })}`);
    await scroller.evaluate(el => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: 1000, bubbles: true }));
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FOLLOW_RESUMED" }] },
    }]));
    await page.getByText("FOLLOW_RESUMED", { exact: true }).waitFor({ state: "attached" });
    await page.waitForTimeout(200);
    assert.ok(await scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight) <= 2,
      "returning to the bottom resumes following new output");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a scrollbar drag back to the bottom releases the history-reading anchor", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    const scroller = page.locator(".initial-query-scroll");
    await scroller.evaluate(el => {
      el.scrollTop -= 300;
      el.dataset.transcriptHistoryReading = "true";
      el.dispatchEvent(new Event("grapher:history-prepend"));
      el.dispatchEvent(new Event("scroll"));
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 6, clientX: rect.right - 7, clientY: rect.top + 40 }));
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 6 }));
    });
    const state = await scroller.evaluate(el => ({ gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      reading: el.dataset.transcriptHistoryReading, following: el.dataset.transcriptFollowing }));
    assert.ok(state.gap <= 2 && !state.reading && state.following === "true",
      `returning to the bottom must release the history anchor: ${JSON.stringify(state)}`);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "AFTER_HISTORY_DRAG" }] },
    }]));
    await page.getByText("AFTER_HISTORY_DRAG", { exact: true }).waitFor({ state: "attached" });
    await page.waitForTimeout(200);
    assert.ok(await scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight) <= 2);
    const reversed = await scroller.evaluate(el => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true }));
      el.scrollTop -= 300; el.dispatchEvent(new Event("scroll"));
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, clientX: rect.right - 7, clientY: rect.top + 40 }));
      el.scrollTop -= 80; el.dispatchEvent(new Event("scroll"));
      el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
      return { gap: el.scrollHeight - el.scrollTop - el.clientHeight, following: el.dataset.transcriptFollowing };
    });
    assert.ok(reversed.gap <= 2 && reversed.following === "true",
      `a drag that reverses direction and reaches the bottom must resume following: ${JSON.stringify(reversed)}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("clicking to interrupt Latest does not let new output resume it", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node", undefined, "no-preference");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    const scroller = page.locator(".initial-query-scroll");
    await scroller.evaluate(el => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }));
      el.scrollTop = 400;
    });
    const button = page.getByRole("button", { name: "Latest", exact: true });
    await button.waitFor({ state: "visible" });
    await button.click();
    await page.waitForFunction(() => document.querySelector(".initial-query-scroll").dataset.transcriptScrollMode === "latest");
    const box = await scroller.boundingBox();
    await page.mouse.click(box.x + 12, box.y + 120);
    await page.waitForTimeout(100);
    const before = await scroller.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
    assert.ok(before.gap > 100, `the click interrupted Latest in transit: ${JSON.stringify(before)}`);
    await scroller.evaluate(el => {
      window.audit.outputNotifications = 0;
      el.addEventListener("grapher:transcript-final-output", () => { window.audit.outputNotifications += 1; });
    });
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "AFTER_LATEST_CANCEL" }] },
    }]));
    await page.waitForFunction(() => window.audit.outputNotifications > 0);
    await page.waitForTimeout(200);
    const after = await scroller.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
    assert.ok(Math.abs(after.top - before.top) <= 3 && after.gap > 100,
      `output must respect a deliberate Latest cancellation: ${JSON.stringify({ before, after })}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a reflow displacement never parks a follower, and a gesture still wins", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    const state = await page.locator(".initial-query-scroll").evaluate(async el => {
      el.dispatchEvent(new Event("grapher:transcript-content-growth"));
      el.dispatchEvent(new Event("grapher:transcript-final-output"));
      // Model a reflow-induced upward scroll after both notifications but
      // before the shared animation frame; no reader gesture occurred.
      el.scrollTop -= 120;
      el.dispatchEvent(new Event("scroll"));
      const displaced = el.scrollHeight - el.scrollTop - el.clientHeight;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      const following = el.dataset.transcriptFollowing;
      // A real user gesture between notification and frame must win over the
      // same scheduled recovery, even if it was queued while following.
      el.dispatchEvent(new Event("grapher:transcript-final-output"));
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      el.scrollTop -= 120;
      el.dispatchEvent(new Event("scroll"));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { displaced, gap, following, readingGap: el.scrollHeight - el.scrollTop - el.clientHeight };
    });
    assert.ok(state.gap <= 2 && state.following === "true",
      `a gesture-free displacement must not park the follower: ${JSON.stringify(state)}`);
    assert.ok(state.readingGap > 100, `a user gesture must cancel the pending recovery: ${JSON.stringify(state)}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const kind of ["inline", "batched", "completed-only"]) {
  test(`${kind} assistant output keeps a follower on the rendered last line after a reflow`, { timeout: 30_000 }, async () => {
    const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node");
    try {
      await page.getByText("Virtualized message 79", { exact: true }).waitFor();
      await page.waitForTimeout(300);
      const scroller = page.locator(".initial-query-scroll");
      const initial = await scroller.evaluate((el, kind) => {
        el.scrollTop -= 160;
        el.dispatchEvent(new Event("scroll"));
        const displaced = el.scrollHeight - el.scrollTop - el.clientHeight;
        const followingAfterReflow = el.dataset.transcriptFollowing;
        const answer = Array.from({ length: 20 }, (_, index) => `${kind.toUpperCase()}_OUTPUT_${index} ${"detail ".repeat(20)}\n\n`).join("");
        const events = [{ type: "message_start", message: { role: "assistant", content: [] } }];
        if (kind !== "completed-only") events.push({ type: "message_update", assistantMessageEvent: { type: "text_delta",
          delta: kind === "inline" ? `<think>reason</think>${answer}` : answer } });
        if (kind !== "inline") events.push({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
        window.audit.appendToolEvents(events);
        return { displaced, followingAfterReflow };
      }, kind);
      assert.ok(initial.displaced <= 2 && initial.followingAfterReflow === "true",
        `a reflow must not disable following: ${JSON.stringify(initial)}`);
      await page.getByText(new RegExp(`${kind.toUpperCase()}_OUTPUT_19`)).waitFor({ state: "attached" });
      await page.waitForTimeout(300);
      const state = await scroller.evaluate((el, kind) => {
        const marker = [...el.querySelectorAll("p")].find(p => p.textContent.includes(`${kind.toUpperCase()}_OUTPUT_19`));
        const rect = marker?.getBoundingClientRect(), view = el.getBoundingClientRect();
        const composer = el.closest(".initial-query-view").querySelector(".pane-bottom-chat")?.getBoundingClientRect();
        return { gap: el.scrollHeight - el.scrollTop - el.clientHeight,
          visible: !!rect && rect.bottom > view.top && rect.bottom <= Math.min(view.bottom, composer?.top ?? view.bottom) + 1 };
      }, kind);
      assert.ok(state.gap <= 2 && state.visible, `the actual last paragraph must be visible: ${JSON.stringify(state)}`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("Planner forward output is distinguished from a historical prepend and final settlement", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("transcriptOutput");
  try {
    await page.getByText("PLANNER_TAIL", { exact: true }).waitFor();
    await page.locator("[data-transcript-events]").evaluate(el => {
      window.audit.outputNotifications = 0;
      el.addEventListener("grapher:transcript-final-output", () => { window.audit.outputNotifications += 1; });
    });
    await page.evaluate(() => window.audit.prependPlannerHistory());
    await page.getByText("PLANNER_PREPENDED", { exact: true }).waitFor();
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.audit.outputNotifications), 0,
      "mounting earlier history must not be treated as newly generated output");
    await page.evaluate(() => window.audit.appendPlannerOutput());
    await page.getByText("PLANNER_APPEND", { exact: true }).waitFor();
    await page.waitForFunction(() => window.audit.outputNotifications >= 1);
    const beforeFinal = await page.evaluate(() => window.audit.outputNotifications);
    await page.evaluate(() => window.audit.appendPlannerOutput(true));
    await page.getByText("PLANNER_FINAL", { exact: true }).waitFor();
    await page.waitForFunction(before => window.audit.outputNotifications > before, beforeFinal);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("live Node answer increments do not inherit the slow reasoning typewriter rate", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node", undefined, "no-preference");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.audit.appendToolEvents([{
      type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "SPEED_SEED" },
    }]));
    await page.getByText("SPEED_SEED", { exact: true }).waitFor();
    const length = await page.evaluate(async () => {
      window.audit.appendToolEvents([{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(1800) } }]);
      for (let frame = 0; frame < 45; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
      return [...document.querySelectorAll(".chat-message-assistant")].find(el => el.textContent.startsWith("SPEED_SEED"))?.textContent.length ?? 0;
    });
    assert.ok(length > 400, `the Node answer should drain at its prior rate, not 6 chars/frame: ${length}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("final text after a reasoning card becomes the conversation's bottom focus", { timeout: 45_000 }, async () => {
  const { context, page, errors } = await fixture("latestScroll&layout=live-tool&view=node", undefined, "no-preference");
  try {
    await page.getByText("Virtualized message 79", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0,
        delta: Array.from({ length: 50 }, (_, index) => `FINAL_COT_REASON_${index}\n\n`).join("") } },
    ]));
    await page.locator(".thinking-card-body").waitFor();
    await page.waitForTimeout(400);
    await page.evaluate(() => window.audit.appendToolEvents([
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
    ]));
    for (let i = 0; i < 20; i++) {
      await page.evaluate(i => window.audit.appendToolEvents([
        { type: "message_update", assistantMessageEvent: { type: "text_delta",
          delta: `FINAL_ANSWER_LINE_${i} ` + "visible final answer text ".repeat(8) + (i === 19 ? "FINAL_BOTTOM_MARKER" : "") + "\n\n" } },
      ]), i);
      await page.waitForTimeout(100);
    }
    const fullAnswer = Array.from({ length: 20 }, (_, i) =>
      `FINAL_ANSWER_LINE_${i} ` + "visible final answer text ".repeat(8) + (i === 19 ? "FINAL_BOTTOM_MARKER" : "") + "\n\n").join("");
    await page.evaluate(fullAnswer => window.audit.appendToolEvents([{
      type: "message_end", message: { role: "assistant", content: [{ type: "text", text: fullAnswer }] },
    }]), fullAnswer);
    await page.getByText(/FINAL_BOTTOM_MARKER/).waitFor();
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => {
      const scroll = document.querySelector(".initial-query-scroll");
      const card = scroll.querySelector(".thinking-card");
      const final = [...scroll.querySelectorAll(".chat-message-assistant")]
        .find(element => element.textContent?.includes("FINAL_ANSWER_LINE_0"));
      const working = scroll.querySelector(".workspace-details .working-indicator");
      const composer = scroll.closest(".initial-query-view").querySelector(".pane-bottom-chat");
      const bounds = element => element?.getBoundingClientRect();
      const view = bounds(scroll), cardBounds = bounds(card), finalBounds = bounds(final);
      const workingBounds = bounds(working), composerBounds = bounds(composer);
      const walker = document.createTreeWalker(final, NodeFilter.SHOW_TEXT);
      let text, lastLineBounds;
      while ((text = walker.nextNode())) {
        const index = text.textContent.indexOf("FINAL_BOTTOM_MARKER");
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(text, index); range.setEnd(text, index + "FINAL_BOTTOM_MARKER".length);
        lastLineBounds = range.getBoundingClientRect();
        break;
      }
      return { bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        cardAboveFinal: !!cardBounds && !!finalBounds && cardBounds.bottom <= finalBounds.top + 1,
        finalVisible: !!finalBounds && finalBounds.bottom > view.top && finalBounds.top < view.bottom,
        finalAboveComposer: !!finalBounds && (!composerBounds || finalBounds.bottom <= composerBounds.top + 1),
        lastLineVisible: !!lastLineBounds && lastLineBounds.top >= view.top &&
          lastLineBounds.bottom <= Math.min(view.bottom, composerBounds?.top ?? view.bottom) + 1,
        workingVisible: !!workingBounds && workingBounds.top >= view.top && workingBounds.bottom <= view.bottom,
        workingAboveComposer: !!workingBounds && (!composerBounds || workingBounds.bottom <= composerBounds.top) };
    });
    assert.ok(state.bottomGap <= 2, `the conversation must follow the final answer: ${JSON.stringify(state)}`);
    assert.equal(state.cardAboveFinal, true, `the reasoning card stays above the final answer: ${JSON.stringify(state)}`);
    assert.equal(state.finalVisible, true, `the final answer must be visible: ${JSON.stringify(state)}`);
    assert.equal(state.finalAboveComposer, true,
      `the final answer must stay above the composer: ${JSON.stringify(state)}`);
    assert.equal(state.lastLineVisible, true, `the final text's last line must be visible: ${JSON.stringify(state)}`);
    assert.equal(state.workingVisible, true, `the working footer must stay visible: ${JSON.stringify(state)}`);
    assert.equal(state.workingAboveComposer, true, `the working footer must stay above the composer: ${JSON.stringify(state)}`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("a live transcript with accumulated reasoning shows it without replaying the typewriter", { timeout: 30_000 }, async () => {
  const history = Array.from({ length: 80 }, (_, index) => JSON.stringify({ type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: `Virtualized message ${index}` }] } }) + "\n").join("");
  const reasoning = Array.from({ length: 120 }, (_, index) => `ACCUMULATED_REASONING_${index} existing detail`).join("\n");
  const content = history +
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }) + "\n" +
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: reasoning } }) + "\n";
  const total = Buffer.byteLength(content);
  const { context, page, errors } = await fixture("latestScroll&layout=live-paged&view=node", async (route, command, body) => {
    if (command !== "get_execution_output") return false;
    await route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
      content: (body.offset ?? 0) === 0 ? content : "", startOffset: body.offset ?? 0,
      nextOffset: total, totalBytes: total, complete: false, status: "running" } } });
    return true;
  }, "no-preference");
  try {
    const body = page.locator(".thinking-card-body");
    await body.waitFor();
    const first = await body.evaluate(element => element.innerText.length);
    await page.waitForTimeout(900);
    const later = await body.evaluate(element => element.innerText.length);
    assert.ok(first > reasoning.length * 0.8,
      `accumulated reasoning must render immediately, not type from empty: ${first}/${reasoning.length}`);
    assert.ok(later <= first + 5,
      `existing history must not keep typing after mount: ${first} -> ${later}`);
    assert.match(await page.locator(".thinking-card").getAttribute("class"), /streaming/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Planner and Node Agent tool history both render cards in headless browser", { timeout: 30_000 }, async () => {
  const line = event => JSON.stringify(event) + "\n";
  const toolEvents = [
    line({ type: "tool_execution_start", toolCallId: "planner-tool", toolName: "node", args: { name: "worker" } }),
    line({ type: "tool_execution_end", toolCallId: "planner-tool", toolName: "node", isError: false,
      result: { content: [{ type: "text", text: "PLAN_TOOL_RESULT" }] } }),
  ].join("");
  const { context, page, errors } = await fixture("plannerTranscript", async (route, command, body) => {
    if (command !== "get_planning_output") return false;
    assert.equal(body.planningId, "planner-tool-plan");
    const totalBytes = Buffer.byteLength(toolEvents);
    await route.fulfill({ json: { result: { planningId: body.planningId, role: "planner", content: toolEvents,
      startOffset: 0, nextOffset: totalBytes, totalBytes, complete: true, running: false } } });
    return true;
  });
  try {
    await page.locator(".tool-call-card").waitFor();
    assert.equal(await page.locator(".tool-call-card").count(), 1, "Planner tool output is a card, not raw JSON");
    assert.match(await page.locator(".tool-call-card").innerText(), /node/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});


for (const fixtureName of ["landingPrompt", "compactModePrompt"]) {
  for (const reducedMotion of ["no-preference", "reduce"]) {
    test(`${fixtureName} mode switching keeps the selector fixed with inertia (${reducedMotion})`, { timeout: 30_000 }, async () => {
      const { context, page, errors } = await fixture(fixtureName, undefined, reducedMotion);
      try {
        const selector = page.locator(".prompt-box-mode-selector");
        await selector.waitFor();
        for (const mode of ["Graph", "Serial", "Auto"]) {
          const frames = await selector.evaluate((selector, mode) => new Promise(resolve => {
            const rect = element => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return [x, y, width, height];
            };
            const frames = [];
            const started = performance.now();
            const sample = () => {
              frames.push({ track: rect(selector), buttons: [...selector.querySelectorAll("button")].map(rect),
                pill: rect(selector.querySelector(".prompt-box-mode-pill-indicator")),
                target: rect(selector.querySelector(".prompt-box-mode-btn.active")) });
              if (performance.now() - started >= 450) return resolve(frames);
              requestAnimationFrame(sample);
            };
            sample();
            [...selector.querySelectorAll("button")].find(button => button.textContent === mode).click();
          }), mode);
          const first = frames[0], last = frames.at(-1);
          for (const frame of frames) {
            const geometry = [...frame.track, ...frame.buttons.flat()];
            const initialGeometry = [...first.track, ...first.buttons.flat()];
            assert.ok(geometry.every((value, index) => Math.abs(value - initialGeometry[index]) < 0.1),
              `changing the selected mode cannot shift or resize the selector or labels: ${JSON.stringify(frame)}`);
            assert.ok(Math.abs(frame.pill[1] - first.pill[1]) < 0.25 && Math.abs(frame.pill[3] - first.pill[3]) < 0.25,
              "the pill slides horizontally without vertical jitter");
          }
          if (reducedMotion === "no-preference") assert.ok(frames.some(frame =>
            Math.abs(frame.pill[0] - first.pill[0]) > 1 && Math.abs(frame.pill[0] - last.target[0]) > 1),
          "selection keeps its animated slide rather than jumping directly to the target");
          assert.ok(last.pill.every((value, index) => Math.abs(value - last.target[index]) < 0.5),
            "the pill settles on the selected mode");
          assert.equal(await selector.getByRole("button", { name: mode, exact: true }).getAttribute("aria-pressed"), "true");
        }
        // Repeated reversals arrive before the spring settles, not only after
        // completed animations. The track and labels must not accumulate drift.
        const rapidFrames = await selector.evaluate(selector => new Promise(resolve => {
          const modes = ["Graph", "Auto", "Serial", "Graph", "Auto", "Graph", "Serial", "Auto"];
          const frames = [];
          const started = performance.now();
          let next = 0;
          const sample = () => {
            const elapsed = performance.now() - started;
            if (next < modes.length && elapsed >= next * 40) {
              const mode = modes[next++];
              [...selector.querySelectorAll("button")].find(button => button.textContent === mode).click();
            }
            frames.push([selector, ...selector.querySelectorAll("button")].flatMap(element => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return [x, y, width, height];
            }));
            if (elapsed >= modes.length * 40 + 600) return resolve(frames);
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }));
        assert.ok(rapidFrames.every(frame => frame.every((value, index) => Math.abs(value - rapidFrames[0][index]) < 0.1)),
          "rapid inertial reversals do not move or resize the control or its labels");
        assert.equal(await selector.locator(".prompt-box-mode-btn.active").innerText(), "Auto");
        const alignment = await selector.evaluate(element => {
          const pill = element.querySelector(".prompt-box-mode-pill-indicator").getBoundingClientRect();
          const active = element.querySelector(".prompt-box-mode-btn.active").getBoundingClientRect();
          return [pill.x - active.x, pill.y - active.y, pill.width - active.width, pill.height - active.height];
        });
        assert.ok(alignment.every(value => Math.abs(value) < 0.5), "rapid switching keeps the pill on the final selection");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }
}

for (const fixtureName of ["prompt", "compactPrompt"]) {
  test(`${fixtureName} expands only when full and preserves edits, selection and focus when toggled`, { timeout: 30_000 }, async () => {
    const { context, page, errors } = await fixture(fixtureName);
    try {
      const input = page.locator("textarea");
      const expand = page.getByRole("button", { name: "Expand input", exact: true });
      const collapse = page.getByRole("button", { name: "Collapse input", exact: true });
      await input.fill("Short draft");
      assert.equal(await expand.count(), 0);
      const draft = Array.from({ length: 40 }, (_, index) => `Draft line ${index}: editable 中文 content`).join("\n");
      await input.fill(draft);
      await expand.waitFor();
      const originalHeight = (await input.boundingBox()).height;
      const buttonBounds = await expand.boundingBox();
      const inputBounds = await input.boundingBox();
      assert.ok(buttonBounds.x + buttonBounds.width <= inputBounds.x + inputBounds.width);
      assert.ok(Math.abs(buttonBounds.y - inputBounds.y) < buttonBounds.height, "toggle is at the input's top right");
      await input.evaluate(element => { element.setSelectionRange(5, 12); element.scrollTop = 60; });
      await expand.click();
      await collapse.waitFor();
      assert.equal(await collapse.getAttribute("aria-expanded"), "true");
      assert.deepEqual(await input.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, focused: document.activeElement === element })),
        { start: 5, end: 12, focused: true });
      assert.equal(await input.inputValue(), draft);
      assert.ok((await input.boundingBox()).height > originalHeight);
      const expandedBounds = await page.locator(".prompt-box-container").boundingBox();
      assert.ok(Math.abs(expandedBounds.height - page.viewportSize().height * 0.8) < 2, "expanded composer occupies 80% of the viewport");
      // Meta/Cmd+End has inconsistent textarea semantics across browsers and
      // hosts. Set the caret explicitly so the edit tests composer behavior.
      await input.evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
      await input.press("Shift+Enter");
      await page.keyboard.insertText("Edited while expanded");
      const editedDraft = await input.inputValue();
      assert.ok(editedDraft.endsWith("\nEdited while expanded"));
      await collapse.click();
      await expand.waitFor();
      assert.equal(await input.inputValue(), editedDraft);
      assert.equal((await input.boundingBox()).height, originalHeight);
      await expand.click();
      await input.press("Escape");
      await expand.waitFor();
      assert.equal(await input.inputValue(), editedDraft);
      assert.equal(await page.evaluate(() => window.audit.cancels ?? 0), 0, "Escape collapses without cancelling the draft");
      await input.fill("Short again");
      await expand.waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const fixtureName of ["prompt", "compactPrompt"]) {
  for (const reducedMotion of ["no-preference", "reduce"]) {
    test(`${fixtureName} long paste keeps the caret and last line visible (${reducedMotion})`, { timeout: 30_000 }, async () => {
      const { context, page, errors } = await fixture(fixtureName, undefined, reducedMotion);
      try {
        const input = page.locator("textarea");
        const draft = Array.from({ length: 60 }, (_, index) => `Pasted paragraph ${index}: 中文长文稿 content `.repeat(20)).join("\n") + "\nLAST_LINE\n";
        await input.focus();
        await page.evaluate(() => {
          window.pasteFrames = [];
          window.samplePaste = true;
          const sample = () => {
            const input = document.querySelector("textarea");
            if (input.value.length > 1000) window.pasteFrames.push({
              bottomGap: input.scrollHeight - input.clientHeight - input.scrollTop,
              selectionStart: input.selectionStart, selectionEnd: input.selectionEnd,
              focused: document.activeElement === input,
              contentWidth: input.clientWidth,
              overflowY: getComputedStyle(input).overflowY,
            });
            if (window.samplePaste) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        // Native text insertion exercises caret scrolling without replacing the
        // machine's clipboard or setting a textarea value programmatically.
        await page.keyboard.insertText(draft);
        await page.waitForTimeout(650);
        const frames = await page.evaluate(() => { window.samplePaste = false; return window.pasteFrames; });
        assert.equal(await input.inputValue(), draft);
        assert.ok(frames.length > 0);
        // A visible scrollbar must not appear or disappear mid-paste: a changing
        // content width rewraps the pasted text inside the composer.
        const widths = new Set(frames.map(frame => frame.contentWidth));
        const overflows = new Set(frames.map(frame => frame.overflowY));
        assert.equal(widths.size, 1, `pasted text must keep one content width: ${JSON.stringify([...widths])}`);
        assert.equal(overflows.size, 1,
          `pasted text must not toggle its scrollbar and rewrap: ${JSON.stringify([...overflows])}`);
        for (const frame of frames) {
          assert.ok(frame.focused && frame.selectionStart === draft.length && frame.selectionEnd === draft.length,
            `pasting keeps focus and the insertion point at the end: ${JSON.stringify(frame)}`);
        }
        assert.ok(frames.every(frame => frame.bottomGap <= 2),
          `the final line must remain visible throughout resizing: ${JSON.stringify(frames.filter(frame => frame.bottomGap > 2).slice(0, 5))}`);
        // Appending to an already scrollable draft must not move the insertion
        // point or leave the viewport one line above its newly pasted ending.
        const extra = "Another pasted paragraph 中文 ".repeat(100) + "\nNEW_LAST_LINE\n";
        await page.keyboard.insertText(extra);
        await page.waitForTimeout(100);
        const ending = await input.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd,
          length: element.value.length, gap: element.scrollHeight - element.clientHeight - element.scrollTop }));
        assert.equal(await input.inputValue(), draft + extra);
        assert.equal(ending.start, ending.length);
        assert.equal(ending.end, ending.length);
        assert.ok(ending.gap <= 2, "repeated pastes keep the last line visible");
        // Shrinking back below the capped height must restore the same content
        // width, so removing the scrollbar cannot rewrap the remaining text.
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.press("Backspace");
        await page.keyboard.insertText("Short final draft");
        await page.waitForTimeout(120);
        const shrunk = await input.evaluate(element => ({ width: element.clientWidth, text: element.value,
          gap: element.scrollHeight - element.clientHeight - element.scrollTop }));
        assert.equal(shrunk.text, "Short final draft");
        assert.equal(shrunk.width, frames[0].contentWidth);
        assert.equal(shrunk.gap, 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }
}

for (const fixtureName of ["prompt", "compactPrompt"]) {
  test(`${fixtureName} long paste does not override manual scrollback or edits in the middle`, { timeout: 30_000 }, async () => {
    const { context, page, errors } = await fixture(fixtureName, undefined, "no-preference");
    try {
      const input = page.locator("textarea");
      const draft = "Long pasted paragraph 中文 ".repeat(1500);
      await input.focus();
      await page.keyboard.insertText(draft);
      await page.waitForFunction(() => document.querySelector(".prompt-box-container").hasAttribute("data-resizing"));
      await input.evaluate(element => {
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
        element.scrollTop = 200;
      });
      await page.waitForFunction(() => !document.querySelector(".prompt-box-container").hasAttribute("data-resizing"));
      await page.waitForTimeout(80);
      assert.ok(Math.abs(await input.evaluate(element => element.scrollTop) - 200) <= 1,
        "manual scrollback during the resize is not pulled back to the caret");
      await input.evaluate(element => { element.setSelectionRange(10, 10); element.scrollTop = 0; });
      await page.keyboard.insertText("MIDDLE");
      await page.waitForTimeout(100);
      assert.equal(await input.inputValue(), draft.slice(0, 10) + "MIDDLE" + draft.slice(10));
      const middle = await input.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }));
      assert.equal(middle.start, 16);
      assert.equal(middle.end, 16);
      assert.ok(middle.scroll < 10, "editing the beginning must not jump to the draft's end");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const fixtureName of ["prompt", "compactPrompt"]) {
  test(`${fixtureName} restores normal autosizing after edits during animated collapse`, { timeout: 30_000 }, async () => {
    const { context, page, errors } = await fixture(fixtureName, undefined, "no-preference");
    try {
      const input = page.locator("textarea");
      await input.fill("Short draft");
      const defaultHeight = (await input.boundingBox()).height;
      await input.fill("Long draft line\n".repeat(40));
      await page.getByRole("button", { name: "Expand input", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".prompt-box-container").hasAttribute("data-resizing"));
      const expandedHeight = (await page.locator(".prompt-box-container").boundingBox()).height;
      await page.getByRole("button", { name: "Collapse input", exact: true }).click();
      await page.waitForFunction(height => {
        const box = document.querySelector(".prompt-box-container");
        return box.hasAttribute("data-resizing") && box.getBoundingClientRect().height < height - 2;
      }, expandedHeight);
      await input.fill("Short again");
      await page.waitForFunction(() => !document.querySelector(".prompt-box-container").hasAttribute("data-resizing"));
      assert.equal((await input.boundingBox()).height, defaultHeight, "normal default height is restored");
      assert.equal(await page.getByRole("button", { name: "Expand input", exact: true }).count(), 0);
      assert.equal(await input.inputValue(), "Short again");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("prompt expansion responds to container width, external values and viewport height", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("prompt");
  try {
    const input = page.locator("textarea");
    const box = page.locator(".prompt-box-container");
    const expand = page.getByRole("button", { name: "Expand input", exact: true });
    await input.fill("Responsive editing text ".repeat(20));
    assert.equal(await expand.count(), 0);
    await box.evaluate(element => { element.style.width = "260px"; });
    await expand.waitFor();
    await box.evaluate(element => { element.style.width = "100%"; });
    await expand.waitFor({ state: "detached" });
    await page.evaluate(() => window.audit.setValue("Externally restored draft\n".repeat(40)));
    await expand.click();
    await page.getByRole("button", { name: "Collapse input", exact: true }).waitFor();
    await page.setViewportSize({ width: 900, height: 600 });
    await page.waitForFunction(() => Math.abs(document.querySelector(".prompt-box-container").getBoundingClientRect().height - innerHeight * 0.8) < 2);
    assert.equal(await input.inputValue(), "Externally restored draft\n".repeat(40));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const name of ["prompt", "compactPrompt"]) {
  test(`${name}: pending submissions clear immediately, restore failures and cannot clear a new workspace draft`, { timeout: 30_000 }, async () => {
    const { context, page, errors } = await fixture(name);
    try {
      const input = page.locator("textarea");
      const draft = "  Steer draft 中文🚀  ";
      await page.evaluate(() => { window.audit.deferSubmit = true; });
      await input.fill(draft); await input.press("Enter");
      await page.waitForFunction(() => window.audit.submissions === 1);
      assert.equal(await input.inputValue(), "");
      assert.equal(await input.isDisabled(), true);
      assert.equal(await page.evaluate(() => window.audit.lastMessage), draft.trim());
      await page.evaluate(() => window.audit.reject(new Error("Send failed")));
      await page.waitForFunction(() => !document.querySelector("textarea").disabled);
      assert.equal(await input.inputValue(), draft, "a thrown failure restores the exact, untrimmed draft");
      await input.press("Enter");
      await page.waitForFunction(() => window.audit.submissions === 2);
      assert.equal(await input.inputValue(), "");
      await page.evaluate(() => window.audit.resolve(false));
      await page.waitForFunction(() => !document.querySelector("textarea").disabled);
      assert.equal(await input.inputValue(), draft, "an explicit rejection also restores the draft");
      await input.press("Enter");
      await page.waitForFunction(() => window.audit.submissions === 3);
      await page.evaluate(() => window.audit.switchRepository());
      await input.fill("New workspace draft");
      await page.evaluate(() => window.audit.resolve(true));
      await page.waitForTimeout(100);
      assert.equal(await input.inputValue(), "New workspace draft");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("expanded prompt retains a rejected submission and collapses only after acceptance", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("prompt");
  try {
    const input = page.locator("textarea");
    const draft = "Keep the full expanded draft\n".repeat(40).trim();
    await input.fill(draft);
    await page.getByRole("button", { name: "Expand input", exact: true }).click();
    const collapse = page.getByRole("button", { name: "Collapse input", exact: true });
    await page.evaluate(() => { window.audit.deferSubmit = true; });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.waitForFunction(() => typeof window.audit.resolve === "function");
    assert.equal(await collapse.isDisabled(), true);
    assert.equal(await input.isDisabled(), true);
    assert.equal(await input.inputValue(), "", "the submitted text does not linger while acceptance is pending");
    await page.evaluate(() => { window.audit.resolve(false); delete window.audit.resolve; });
    await page.waitForFunction(() => !document.querySelector("textarea").disabled);
    assert.equal(await input.inputValue(), draft);
    assert.equal(await collapse.getAttribute("aria-expanded"), "true");
    await input.press("Enter");
    await page.waitForFunction(() => typeof window.audit.resolve === "function");
    await page.evaluate(() => window.audit.resolve(true));
    await page.waitForFunction(() => { const input = document.querySelector("textarea"); return input.value === "" && !input.disabled; });
    assert.equal(await collapse.count(), 0);
    assert.equal(await page.getByRole("button", { name: "Expand input", exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.audit.lastMessage), draft);
    assert.equal(await page.evaluate(() => window.audit.submissions), 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Escape dismisses suggestions before collapsing the expanded prompt and does not interrupt IME", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("prompt");
  try {
    const input = page.locator("textarea");
    await input.fill("Multiline draft\n".repeat(40) + "@");
    await page.getByRole("button", { name: "Expand input", exact: true }).click();
    const collapse = page.getByRole("button", { name: "Collapse input", exact: true });
    await page.locator(".prompt-box-suggestions-popover").waitFor();
    await input.press("Escape");
    await page.locator(".prompt-box-suggestions-popover").waitFor({ state: "detached" });
    assert.equal(await collapse.getAttribute("aria-expanded"), "true");
    await input.dispatchEvent("compositionstart");
    await input.press("Escape");
    assert.equal(await collapse.getAttribute("aria-expanded"), "true");
    await input.dispatchEvent("compositionend");
    await input.press("Escape");
    await page.getByRole("button", { name: "Expand input", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.audit.cancels ?? 0), 0);
    assert.equal(await page.evaluate(() => window.audit.submissions ?? 0), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("late workspace completions cannot replace current files/skills; controlled input clears on accepted send", { timeout: 30_000 }, async () => {
  let oldRequests = 0, oldReplies = 0;
  const gate = deferred();
  const { context, page, errors } = await fixture("prompt", async (route, command, body) => {
    if (!["list_files", "list_skills"].includes(command)) return false;
    const isOld = body.repository === "/a";
    if (isOld) { oldRequests += 1; await gate.promise; }
    const name = isOld ? "alpha" : "beta";
    const result = command === "list_files" ? { files: [`${name}.ts`] }
      : { skills: [{ name, description: `${name} skill`, path: `/${name}`, scope: "workspace" }] };
    await route.fulfill({ json: { result } });
    if (isOld) oldReplies += 1;
    return true;
  });
  try {
    // Completions are lazy: explicitly trigger the old workspace request first.
    await page.locator("textarea").fill("@");
    await waitFor(() => oldRequests === 2);
    await page.evaluate(() => window.audit.switchRepository());
    const input = page.locator("textarea");
    await input.fill("@");
    await page.locator(".suggestion-item-title-row", { hasText: "beta.ts" }).waitFor();
    gate.resolve();
    await waitFor(() => oldReplies === 2);
    assert.ok(!(await page.locator(".prompt-box-suggestions-list").innerText()).includes("alpha.ts"));
    await input.fill("/");
    await page.locator(".suggestion-item-title-row", { hasText: "/skill:beta" }).waitFor();
    assert.ok(!(await page.locator(".prompt-box-suggestions-list").innerText()).includes("alpha"));
    await input.press("Escape");
    await waitFor(async () => (await page.locator(".prompt-box-suggestions-popover").count()) === 0);
    await input.fill("/nonexistent");
    await page.locator(".prompt-box-suggestions-empty").waitFor();
    await input.press("Escape");
    await waitFor(async () => (await page.locator(".prompt-box-suggestions-popover").count()) === 0);
    await input.fill("/");
    await page.locator(".suggestion-item-title-row", { hasText: "/skill:beta" }).waitFor();
    await page.locator(".suggestions-header-close-btn").click();
    await waitFor(async () => (await page.locator(".prompt-box-suggestions-popover").count()) === 0);
    await input.fill("Accepted message");
    await input.press("Enter");
    await page.waitForFunction(() => window.audit.value === "");
    assert.equal(await input.inputValue(), "");
    assert.deepEqual(errors, []);
  } finally { gate.resolve(); await context.close(); }
});

test("attachments stay local until Send and retries reuse only their own managed upload", { timeout: 30_000 }, async () => {
  const writes = [], deletes = [];
  const path = "grapher-attachments/00000000-0000-4000-8000-000000000002/original.txt";
  const { context, page, errors } = await fixture("prompt", async (route, command, body) => {
    if (command === "delete_workspace_attachment") deletes.push(body);
    if (command !== "write_workspace_attachment") return false;
    writes.push(body);
    await route.fulfill({ json: { result: { name: "original.txt", path } } });
    return true;
  });
  try {
    const file = { name: "original.txt", mimeType: "text/plain", buffer: Buffer.from("attachment bytes") };
    const input = page.locator("textarea");
    await input.fill("Keep the original");
    await page.locator('input[type="file"]').setInputFiles(file);
    await page.locator(".prompt-box-file-badge").waitFor();
    await page.getByRole("button", { name: "Remove file", exact: true }).click();
    assert.deepEqual(writes, []); assert.deepEqual(deletes, []);
    await page.locator('input[type="file"]').setInputFiles(file);
    await page.evaluate(() => { window.audit.deferSubmit = true; });
    await input.press("Enter");
    await page.waitForFunction(() => window.audit.submissions === 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].repository, "/a");
    assert.equal(writes[0].filename, "original.txt");
    assert.equal(await page.evaluate(() => window.audit.lastMessage), `@${path} Keep the original`);
    await page.evaluate(() => window.audit.resolve(false));
    await page.waitForFunction(() => !document.querySelector("textarea").disabled);
    assert.equal(await input.inputValue(), "Keep the original");
    assert.equal(await page.locator(".prompt-box-file-badge").count(), 1);
    await input.press("Enter");
    await page.waitForFunction(() => window.audit.submissions === 2);
    assert.equal(writes.length, 2, "each retry revalidates the backend's current target");
    assert.equal(writes[1].attachmentId, writes[0].attachmentId, "the same pending file keeps its idempotency key");
    assert.match(writes[0].attachmentId, /^[0-9a-f-]{36}$/);
    await page.evaluate(() => window.audit.resolve(true));
    await page.waitForFunction(() => window.audit.value === "");
    await page.locator(".prompt-box-file-badge").waitFor({ state: "detached" });
    assert.equal(await page.locator(".prompt-box-file-badge").count(), 0);
    assert.deepEqual(deletes, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("attachment upload failure retains the draft and file and never submits a missing path", { timeout: 30_000 }, async () => {
  let writes = 0;
  const { context, page, errors } = await fixture("prompt", async (route, command) => {
    if (command !== "write_workspace_attachment") return false;
    writes++;
    await route.fulfill({ status: 400, json: { error: "Attachment workspace directory is unavailable" } });
    return true;
  });
  try {
    const input = page.locator("textarea");
    await input.fill("Keep this draft");
    await page.locator('input[type="file"]').setInputFiles({ name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
    assert.equal(writes, 0);
    await input.press("Enter");
    await page.getByRole("alert").filter({ hasText: "Attachment workspace directory is unavailable" }).waitFor();
    assert.equal(writes, 1);
    assert.equal(await page.evaluate(() => window.audit.submissions ?? 0), 0);
    assert.equal(await input.inputValue(), "Keep this draft");
    assert.equal(await page.locator(".prompt-box-file-badge").count(), 1);
    assert.equal(await input.isDisabled(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("an older backend is rejected before a legacy upload can overwrite a project basename", { timeout: 30_000 }, async () => {
  const calls = [];
  let original = "uncommitted project content";
  const { context, page, errors } = await fixture("prompt", async (route, command) => {
    calls.push(command);
    if (command === "write_workspace_file") {
      original = "destructive legacy upload";
      await route.fulfill({ json: { result: { name: "original.txt", path: "original.txt" } } });
      return true;
    }
    if (command === "write_workspace_attachment") {
      await route.fulfill({ status: 400, json: { error: "Unknown command" } });
      return true;
    }
    return false;
  });
  try {
    const input = page.locator("textarea");
    await input.fill("Keep my draft");
    await page.locator('input[type="file"]').setInputFiles({ name: "original.txt", mimeType: "text/plain", buffer: Buffer.from("attachment") });
    await input.press("Enter");
    await page.getByRole("alert").filter({ hasText: "Update the backend" }).waitFor();
    assert.deepEqual(calls, ["write_workspace_attachment"]);
    assert.equal(original, "uncommitted project content");
    assert.equal(await input.inputValue(), "Keep my draft");
    assert.equal(await page.locator(".prompt-box-file-badge").count(), 1);
    assert.equal(await page.evaluate(() => window.audit.submissions ?? 0), 0);
    assert.equal(await input.isDisabled(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("late attachment uploads cannot submit into a newly selected workspace", { timeout: 30_000 }, async () => {
  const gate = deferred();
  let requested = false;
  const { context, page, errors } = await fixture("prompt", async (route, command) => {
    if (command !== "write_workspace_attachment") return false;
    requested = true;
    await gate.promise;
    await route.fulfill({ json: { result: { name: "fixture.txt", path: "grapher-attachments/00000000-0000-4000-8000-000000000003/fixture.txt" } } });
    return true;
  });
  try {
    const input = page.locator("textarea");
    await input.fill("Old workspace draft");
    await page.locator('input[type="file"]').setInputFiles({ name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
    await input.press("Enter"); await waitFor(() => requested);
    await page.evaluate(() => window.audit.switchRepository());
    await input.fill("New workspace draft");
    gate.resolve(); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.audit.submissions ?? 0), 0);
    assert.equal(await input.inputValue(), "New workspace draft");
    await page.locator(".prompt-box-file-badge").waitFor({ state: "detached" });
    assert.equal(await page.locator(".prompt-box-file-badge").count(), 0);
    assert.equal(await input.isDisabled(), false);
    assert.deepEqual(errors, []);
  } finally { gate.resolve(); await context.close(); }
});

test("file completions search Unicode names and quote paths containing spaces", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("prompt", async (route, command) => {
    if (command !== "list_files") return false;
    await route.fulfill({ json: { result: { files: ["中文说明.txt", "with spaces.txt"] } } });
    return true;
  });
  try {
    const input = page.locator("textarea");
    await input.fill("@中文");
    await page.locator(".suggestion-item-title-row", { hasText: "中文说明.txt" }).click();
    assert.equal(await input.inputValue(), "@中文说明.txt ");
    await input.fill("@with");
    await page.locator(".suggestion-item-title-row", { hasText: "with spaces.txt" }).click();
    assert.equal(await input.inputValue(), '@"with spaces.txt" ');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("unreadable attachments retain the draft and file instead of sending an incomplete message", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("prompt");
  try {
    const input = page.locator("textarea");
    await input.fill("Keep this draft");
    await page.evaluate(() => {
      File.prototype.text = () => Promise.reject(new Error("Unreadable fixture"));
      FileReader.prototype.readAsText = () => { throw new Error("Unreadable fixture"); };
      document.querySelector("textarea").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: new DataTransfer() }));
    });
    assert.equal(await page.evaluate(() => window.audit.pastes), 1);
    await page.locator('input[type="file"]').setInputFiles({ name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from("test") });
    await input.press("Enter");
    await page.getByRole("alert", { name: "" }).filter({ hasText: "attachment could not be read" }).waitFor();
    assert.equal(await input.inputValue(), "Keep this draft");
    assert.equal(await page.locator(".prompt-box-file-badge").count(), 1);
    assert.equal(await input.isDisabled(), false);
    assert.equal(await page.evaluate(() => window.audit.submissions ?? 0), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("one unavailable Run cannot starve other polls, and a stale poll cannot overwrite an action with equal event sequence", { timeout: 30_000 }, async () => {
  let viewedRequests = 0, backgroundRequests = 0, oldReply = false;
  const gate = deferred();
  const { context, page, errors } = await fixture("polling", async (route, command, body) => {
    if (command !== "snapshot_if_changed") return false;
    if (body.runId === "broken") {
      await route.fulfill({ status: 404, json: { error: "Run unavailable" } });
      return true;
    }
    const make = goal => ({ runId: body.runId, config: { repository: "/a" }, phase: "running",
      graph: { originalGoal: goal, nodes: [], edges: [] }, events: [], nodes: {}, executions: [], approved: false });
    let goal = "Background";
    if (body.runId === "background") backgroundRequests += 1;
    if (body.runId === "view") {
      viewedRequests += 1;
      if (viewedRequests === 1) {
        await gate.promise;
        goal = "Stale poll result";
      } else goal = "Action result";
    }
    await route.fulfill({ json: { result: { version: `v-${viewedRequests}`, snapshot: make(goal) } } });
    if (body.runId === "view" && viewedRequests === 1) oldReply = true;
    return true;
  });
  try {
    await waitFor(() => viewedRequests === 1);
    assert.equal(backgroundRequests, 1);
    await page.evaluate(() => window.audit.acceptAction());
    gate.resolve();
    await waitFor(() => oldReply);
    await page.waitForTimeout(100);
    assert.equal(await page.locator("[data-viewed-goal]").innerText(), "Action result");
    await page.evaluate(() => window.audit.removeBroken());
    await waitFor(() => backgroundRequests >= 2);
    assert.deepEqual(errors, []);
  } finally { gate.resolve(); await context.close(); }
});

for (const approved of [false, true]) {
  test(`planner revision ${approved ? "preserves a paused runtime" : "hides approval without claiming execution"}`, { timeout: 30_000 }, async () => {
    const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
    const draft = { runId: "draft-run", config, planType: "graph",
      graph: { originalGoal: "Draft goal", nodes: [{ name: "task", task: "Draft task" }], edges: [] },
      nodes: { task: { status: "waiting", revision: 0, attempts: 0, instruction: "", error: null } },
      plan: null, executions: [], events: [], approved, paused: approved,
      phase: approved ? "paused" : "awaiting_approval", base: "", feedbackCounts: {} };
    const empty = { ...draft, runId: "", config: null, approved: false, paused: false, phase: "draft",
      graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {} };
    const info = { path: "/a", name: "Alpha", branch: "main", head: "", clean: true };
    const gate = deferred();
    let requested = false, polls = 0;
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
    await context.addInitScript(() => {
      localStorage.setItem("grapher_language_v1", "en");
      const fetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        if (!String(args[0]).includes("/api/plan_goal_stream") || !response.ok) return response;
        // Model a proxy that delivers `complete` but keeps the transport open.
        return new Response(new ReadableStream({ async start(controller) {
          controller.enqueue(new TextEncoder().encode(await response.text()));
        } }), { headers: response.headers });
      };
    });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": result = { config, snapshot: empty, runs: [draft.runId], repositoryInfo: info, dataPath: "/mock" }; break;
        case "history": case "snapshot": result = draft; break;
        case "snapshot_if_changed":
          if (requested) polls += 1;
          result = { version: `poll-${polls}`, snapshot: draft }; break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = catalog; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "plan_goal_stream":
          assert.equal(body.revisionRunId, draft.runId);
          requested = true;
          await gate.promise;
          await route.fulfill({ contentType: "text/event-stream", body:
            `event: complete\ndata: ${JSON.stringify({ snapshot: draft })}\n\n` });
          return;
        default:
          errors.push(`Unexpected API: ${command}`);
          await route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } }); return;
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.locator(`[data-run-id="${draft.runId}"]`).click();
      const bottom = page.locator(".graph-bottom");
      await bottom.waitFor();
      if (!approved) await bottom.getByRole("button", { name: "Approve", exact: true }).waitFor();
      const composer = page.locator(".pane-bottom-chat textarea");
      await composer.fill("Revise this graph");
      await composer.press("Enter");
      await waitFor(() => requested);
      const checkPlanning = async () => {
        assert.equal(await bottom.getByRole("button", { name: "Approve", exact: true }).count(), 0);
        assert.equal(await bottom.getByRole("button", { name: "Reject", exact: true }).count(), 0);
        assert.equal(await bottom.locator(".progress-label > span").last().innerText(), approved ? "Paused" : "Planning");
        assert.ok(!(await bottom.innerText()).includes("Running"));
        assert.ok(!(await bottom.innerText()).includes("Deterministic runtime"));
      };
      await checkPlanning();
      // Even an old awaiting_approval poll cannot bring the buttons back mid-turn.
      if (!approved) { await waitFor(() => polls > 0); await page.waitForTimeout(100); await checkPlanning(); }
      gate.resolve();
      if (!approved) await bottom.getByRole("button", { name: "Approve", exact: true }).waitFor();
      else await page.locator(".workbench.historical-settled").waitFor();
      assert.deepEqual(errors, []);
    } finally { gate.resolve(); await context.close(); }
  });
}

for (const wireStatus of ["completed", "done"]) {
  test(`topology cards capitalize statuses for ${wireStatus} backend completion`, { timeout: 30_000 }, async () => {
    const config = { repository: "/mock/status-label", model: "test/old", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
    const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
      plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
    const statuses = { waiting: "Waiting", running: "Running", paused: "Paused", blocked: "Blocked", failed: "Failed", dirty: "Dirty" };
    const names = ["task", ...Object.keys(statuses)];
    const merger = (id, node, status) => ({ id, node, status, revision: 1, attempt: 1, sessionId: id,
      worktree: config.repository, before: "", after: null, output: "", startedAt: 1, completedAt: 2 });
    const snapshot = { ...empty, runId: `status-${wireStatus}`, config, planType: "graph", approved: true, phase: "needs_attention",
      graph: { originalGoal: "Show authoritative node statuses", nodes: names.map(name => ({ name, task: `Task ${name}` })), edges: [] },
      nodes: Object.fromEntries(names.map(name => [name, {
        status: name === "task" ? wireStatus : name, revision: 1, head: null, instruction: "", error: name === "failed" ? "Mock failure" : null,
      }])),
      mergers: [merger("node-merger", "merge:blocked", "failed"), merger("publication-merger", "merger", "completed")] };
    const info = { path: config.repository, name: "Status labels", branch: "main", head: "", clean: true };
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": result = { config, snapshot: empty, runs: [snapshot.runId], repositoryInfo: info, dataPath: "/mock" }; break;
        case "history": case "snapshot": result = snapshot; break;
        case "snapshot_if_changed": result = { version: "1", snapshot }; break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = catalog; break;
        default: errors.push(`Unexpected API: ${command}`); result = null;
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.locator(`[data-run-id="${snapshot.runId}"]`).click();
      const card = page.locator('.graph-canvas .task-node[data-node-name="task"]');
      await card.waitFor();
      const label = card.locator(".node-footer .status");
      assert.equal(await label.innerText(), "Completed", "backend completion must render a capitalized card label");
      // The graph entrance can still be fading the new node when the label
      // first exists; checkVisibility below deliberately includes opacity.
      await page.waitForFunction(() => {
        const status = document.querySelector('.graph-canvas .task-node[data-node-name="task"] .node-footer .status');
        return status && Number(getComputedStyle(status).opacity) === 1;
      });
      assert.equal(await label.evaluate(element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })), true);
      const bounds = await label.boundingBox(), cardBounds = await card.boundingBox();
      assert.ok(bounds && cardBounds && bounds.width > 0 && bounds.height > 0 && bounds.x >= cardBounds.x &&
        bounds.x + bounds.width <= cardBounds.x + cardBounds.width, "the full status label fits inside the visible card");
      for (const [status, expected] of Object.entries(statuses)) {
        assert.equal(await page.locator(`.task-node[data-node-name="${status}"] .status`).innerText(), expected);
      }
      assert.equal(await page.locator('.task-node[data-node-name="merger · blocked"] .status').innerText(), "Failed");
      assert.equal(await page.locator('.task-node[data-node-name="publication merger"] .status').innerText(), "Completed");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("topology Pause/Continue controls running nodes and distinguishes paused attempts from failures", { timeout: 30_000 }, async () => {
  const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const execution = (id, node, status) => ({ id, node, status, revision: 1, attempt: 1, sessionId: id,
    worktree: "/work", before: "", after: null, output: "", startedAt: 1000, completedAt: status === "running" ? null : 2000 });
  let current = { runId: "pause-run", config, planType: "graph", approved: true, paused: false, phase: "running",
    graph: { originalGoal: "Pause graph", nodes: [{ name: "task", task: "Work" }, { name: "broken", task: "Failed independently" }], edges: [] },
    nodes: { task: { status: "running", revision: 1, instruction: "", error: null }, broken: { status: "failed", revision: 1, instruction: "", error: "Provider failed" } },
    executions: [execution("first", "task", "running"), execution("broken-first", "broken", "failed")],
    plan: null, events: [], base: "", feedbackCounts: {} };
  const empty = { ...current, runId: "", approved: false, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {}, executions: [] };
  const actions = [], errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [current.runId], repositoryInfo: { path: "/a", name: "Alpha", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "history": case "snapshot": result = current; break;
      case "snapshot_if_changed": result = { version: JSON.stringify(current), snapshot: current }; break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = catalog; break;
      case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
      case "get_execution_output": result = { runId: current.runId, executionId: body.executionId, content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true,
        status: current.executions.find(item => item.id === body.executionId)?.status }; break;
      case "control":
        actions.push(body);
        assert.equal(body.runId, current.runId);
        assert.equal(body.node, undefined, "topology controls stay global even with a node selected");
        current = body.action === "pause" ? { ...current, paused: true, phase: "paused" }
          : current.nodes.task.status === "paused" ? { ...current, paused: false, canResume: false, phase: "running",
            nodes: { ...current.nodes, task: { ...current.nodes.task, status: "running", error: null } },
            executions: [...current.executions, { ...execution("second", "task", "running"), attempt: 2 }] }
          : { ...current, paused: false, canResume: false, phase: "running",
            nodes: { ...current.nodes, broken: { ...current.nodes.broken, status: "running", error: null } },
            executions: [...current.executions, { ...execution("broken-second", "broken", "running"), attempt: 2 }] };
        result = current; break;
      default: errors.push(`Unexpected API: ${command}`); return route.fulfill({ status: 400, json: { error: command } });
    }
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator(`[data-run-id="${current.runId}"]`).click();
    const bottom = page.locator(".graph-bottom");
    await page.locator('[data-node-name="task"]').click();
    await bottom.getByRole("button", { name: "Pause", exact: true }).click();
    await bottom.getByRole("button", { name: "Pausing", exact: true }).waitFor();
    assert.equal(await bottom.getByRole("button", { name: "Pausing", exact: true }).isDisabled(), true);
    current = { ...current, canResume: true,
      nodes: { ...current.nodes, task: { ...current.nodes.task, status: "paused", error: "Execution paused by the user" } },
      executions: current.executions.map(item => item.id === "first" ? { ...item, status: "paused", completedAt: 2000 } : item) };
    await bottom.getByRole("button", { name: "Resume", exact: true }).waitFor();
    await page.locator('[data-node-name="task"] .status', { hasText: "Paused" }).waitFor();
    await page.locator('[data-node-name="broken"] .status', { hasText: "Failed" }).waitFor();
    await bottom.getByText("Continue first resumes paused tasks; retry other failed nodes afterward.").waitFor();
    await bottom.getByRole("button", { name: "Resume", exact: true }).click();
    await page.locator('[data-node-name="task"] .status', { hasText: "Running" }).waitFor();
    await page.locator('[data-node-name="broken"] .status', { hasText: "Failed" }).waitFor();
    current = { ...current, canResume: true, phase: "needs_attention",
      nodes: { ...current.nodes, task: { ...current.nodes.task, status: "completed" } },
      executions: current.executions.map(item => item.id === "second" ? { ...item, status: "completed", completedAt: 3000 } : item) };
    await bottom.getByRole("button", { name: "Resume", exact: true }).waitFor();
    await bottom.getByRole("button", { name: "Resume", exact: true }).click();
    await page.locator('[data-node-name="broken"] .status', { hasText: "Running" }).waitFor();
    // A paused Run can still project a completed phase after a restart. The
    // explicit pause state must keep Continue usable instead of latching the
    // terminal-phase disable rule.
    current = { ...current, paused: true, canResume: false, phase: "completed",
      nodes: { task: { ...current.nodes.task, status: "completed" }, broken: { ...current.nodes.broken, status: "completed" } },
      executions: current.executions.map(item => item.status === "running" ? { ...item, status: "completed", completedAt: 4000 } : item) };
    const restartContinue = bottom.getByRole("button", { name: "Resume", exact: true });
    await restartContinue.waitFor();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll(".graph-bottom button")].find(item => item.textContent?.trim() === "Resume");
      return button && !button.disabled;
    });
    await restartContinue.click();
    await waitFor(() => actions.length === 4);
    assert.deepEqual(actions.map(action => action.action), ["pause", "resume", "resume", "resume"]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("recovered planning polls activity before route discovery and opens the completed graph", { timeout: 45_000 }, async () => {
  const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
  const running = { planningId: "recovered-plan", repository: "/a", status: "running", createdAt: Date.now(),
    modelDuration: 0, totalPlanningDuration: 0, roles: { partition: {}, planner: {} } };
  const info = { path: "/a", name: "Alpha", branch: "main", head: "", clean: true };
  const bootstrap = { config, snapshot: empty, runs: [], repositoryInfo: info, dataPath: "/mock" };
  const completed = { ...empty, runId: "recovered-run", config, planType: "graph", phase: "awaiting_approval",
    planningId: running.planningId, planning: { ...running, status: "success" },
    graph: { originalGoal: "Recovered goal", nodes: [], edges: [] } };
  const line = event => JSON.stringify(event) + "\n";
  const first = line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "Recovered goal" }] } }) +
    line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Recovered activity 中文🚀" } });
  const appended = line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "\n\nAutomatically appended activity" } });
  let output = "", finished = false;
  const offsets = [], errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = bootstrap; break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = [finished ? completed.planning : running]; break;
      case "get_planning": result = finished ? completed.planning : running; break;
      case "get_planning_output": {
        assert.equal(body.planningId, running.planningId);
        assert.equal(body.role, "planner");
        offsets.push(body.offset);
        const bytes = Buffer.from(output);
        result = { planningId: running.planningId, role: "planner", content: bytes.subarray(body.offset).toString(),
          nextOffset: bytes.length, totalBytes: bytes.length, complete: true, running: !finished };
        break;
      }
      case "get_planning_snapshot":
        assert.equal(body.planningId, running.planningId);
        assert.equal(body.repository, "/a");
        result = completed; break;
      case "history": case "snapshot": result = completed; break;
      case "snapshot_if_changed": result = { version: "fixed", snapshot: null }; break;
      case "provider_auth": result = catalog; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      default:
        errors.push(`Unexpected API: ${command}`);
        await route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } }); return;
    }
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await waitFor(() => offsets.length > 0);
    assert.equal(await page.locator(".route-decision-pill").innerText(), "Evaluating task routing...");
    assert.equal(offsets[0], 0, "missing initial output must keep polling instead of settling the cache");

    output = first;
    const activity = page.getByRole("region", { name: "Planning activity" });
    await activity.getByText("Recovered activity 中文🚀", { exact: true }).waitFor();
    await activity.getByText("Recovered goal", { exact: true }).waitFor();
    output += appended;
    await activity.getByText("Automatically appended activity", { exact: true }).waitFor();
    assert.ok(offsets.includes(Buffer.byteLength(first)), "append polling resumes at the UTF-8 byte offset");
    assert.equal(await activity.getByText("Recovered activity 中文🚀", { exact: true }).count(), 1);

    finished = true;
    await page.locator('.run-item.chosen[data-run-id="recovered-run"]').waitFor();
    await activity.getByText("Automatically appended activity", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("pure frontend refresh during active planning re-attaches silently without a reconnect banner", { timeout: 45_000 }, async () => {
  const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const runningPlanning = { planningId: "active-plan", repository: "/a", status: "running", createdAt: Date.now(),
    modelDuration: 0, totalPlanningDuration: 0, roles: { partition: {}, planner: {} } };
  const planningSnapshot = {
    runId: "active-plan-run", config, planType: "undecided", phase: "planning",
    planningId: runningPlanning.planningId, planning: runningPlanning,
    graph: { originalGoal: "Active refresh goal", nodes: [], edges: [] },
    nodes: {}, plan: null, executions: [], events: [], approved: false, paused: false, base: "", feedbackCounts: {},
  };
  const info = { path: "/a", name: "Alpha", branch: "main", head: "", clean: true };
  const bootstrap = { config, snapshot: planningSnapshot, runs: ["active-plan-run"], repositoryInfo: info, dataPath: "/mock" };
  const line = event => JSON.stringify(event) + "\n";
  const output = line({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "Active refresh goal" }] } }) +
    line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Streaming active plan output" } });
  const offsets = [], errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => {
    localStorage.setItem("grapher_language_v1", "en");
    window.recoveryBanner = { shown: 0, removed: 0 };
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof HTMLElement && node.classList?.contains("floating-recovered-banner")) window.recoveryBanner.shown++;
        for (const node of record.removedNodes) if (node instanceof HTMLElement && node.classList?.contains("floating-recovered-banner")) window.recoveryBanner.removed++;
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = bootstrap; break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = [runningPlanning]; break;
      case "get_planning": result = runningPlanning; break;
      case "get_planning_output": {
        assert.equal(body.planningId, runningPlanning.planningId);
        assert.equal(body.role, "planner");
        offsets.push(body.offset);
        const bytes = Buffer.from(output);
        result = { planningId: runningPlanning.planningId, role: "planner", content: bytes.subarray(body.offset).toString(),
          nextOffset: bytes.length, totalBytes: bytes.length, complete: false, running: true };
        break;
      }
      case "history": case "snapshot": result = planningSnapshot; break;
      case "snapshot_if_changed": result = { version: "fixed", snapshot: null }; break;
      case "provider_auth": result = catalog; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      default:
        errors.push(`Unexpected API: ${command}`);
        await route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } }); return;
    }
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    // Planning activity should poll and render directly.
    const activity = page.getByRole("region", { name: "Planning activity" });
    await activity.getByText("Streaming active plan output", { exact: true }).waitFor();
    // Re-attaching a persisted running turn is silent: no reconnect banner.
    await page.waitForTimeout(2000);
    assert.equal(await page.locator(".floating-recovered-banner").count(), 0,
      "a recovered running turn must not surface a reconnect banner");
    assert.deepEqual(await page.evaluate(() => window.recoveryBanner), { shown: 0, removed: 0 });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("node follow-ups keep records expanded and completed nodes continue instead of leaving notes", { timeout: 45_000 }, async () => {
  const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const execution = attempt => ({ id: `record-${attempt}`, node: "task", status: "completed", revision: attempt, attempt,
    sessionId: "same-session", worktree: "/a", before: "", after: "", startedAt: attempt * 1000, completedAt: attempt * 1000 + 1,
    output: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Agent response ${attempt}` }] } }) + "\n" });
  let current = { runId: "record-run", config, planType: "graph", approved: true, paused: false, phase: "completed",
    graph: { originalGoal: "Continue the node", nodes: [{ name: "task", task: "Original task" }], edges: [] },
    nodes: { task: { status: "completed", revision: 1, instruction: "", error: null } },
    executions: [execution(1)], plan: null, events: [], base: "", feedbackCounts: {} };
  const empty = { ...current, runId: "", config: null, approved: false, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {}, executions: [] };
  const gates = [deferred(), deferred()], controls = [], errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [current.runId], repositoryInfo: { path: "/a", name: "Alpha", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "history": case "snapshot": result = current; break;
      case "snapshot_if_changed": result = { version: "fixed", snapshot: null }; break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = catalog; break;
      case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
      case "control": {
        const index = controls.length;
        controls.push(body);
        assert.equal(body.action, "intervene", "a completed node resumes execution, not message_node record-only delivery");
        assert.equal(body.node, "task");
        assert.equal(body.runId, current.runId);
        await gates[index].promise;
        const next = execution(index + 2), sequence = current.events.length + 1;
        current = { ...current, nodes: { task: { ...current.nodes.task, revision: next.revision, instruction: body.instruction } },
          executions: [...current.executions, next], events: [...current.events,
            { type: "invalidated", sequence, timestamp: next.startedAt, target: "task", nodes: ["task"], human: true, instruction: body.instruction },
            { type: "started", sequence: sequence + 1, timestamp: next.startedAt, execution: next }] };
        result = current; break;
      }
      default: errors.push(`Unexpected API: ${command}`); return route.fulfill({ status: 400, json: { error: command } });
    }
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  const headers = page.locator(".session-label-toggle[aria-expanded]");
  const expansion = () => headers.evaluateAll(items => items.map(item => item.getAttribute("aria-expanded")));
  const openNode = async () => {
    await page.locator('[data-run-id="record-run"]').click();
    await page.locator('[data-node-name="task"]').click();
    await page.getByText("Agent response 1", { exact: true }).waitFor();
  };
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await openNode();
    assert.equal(await headers.count(), 0, "a single execution stays open without a toggle header");
    const composer = page.locator(".pane-bottom-chat textarea");
    assert.equal(await composer.getAttribute("placeholder"), "Send a message to @task and continue execution…");
    await composer.fill("First follow-up");
    await composer.press("Enter");
    await waitFor(() => controls.length === 1);
    await headers.first().waitFor();
    assert.deepEqual(await expansion(), ["true"], "even the optimistic waiting turn keeps the old output expanded");
    await page.getByText("Agent response 1", { exact: true }).waitFor();
    gates[0].resolve();
    await page.getByText("Agent response 2", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector(".pane-bottom-chat textarea")?.value === "");
    assert.deepEqual(await expansion(), ["true", "true"], "both old and new executions default to expanded");

    await headers.nth(1).click();
    assert.deepEqual(await expansion(), ["true", "false"]);
    assert.equal(await page.locator('[data-execution-id="record-2"]').count(), 0);
    await composer.fill("Second follow-up");
    await composer.press("Enter");
    await waitFor(() => controls.length === 2);
    assert.deepEqual(await expansion(), ["true", "false"], "manual collapse survives the optimistic turn");
    gates[1].resolve();
    await page.getByText("Agent response 3", { exact: true }).waitFor();
    assert.deepEqual(await expansion(), ["true", "false", "true"], "the user's choice stays with the execution when it becomes an older attempt");
    await page.getByText("First follow-up", { exact: true }).waitFor();
    await page.getByText("Second follow-up", { exact: true }).waitFor();

    await headers.nth(2).click();
    await headers.nth(1).click();
    await page.getByText("Agent response 2", { exact: true }).waitFor();
    assert.deepEqual(await expansion(), ["true", "true", "false"], "opening one record never changes another record");
    await headers.nth(0).click();
    assert.deepEqual(await expansion(), ["false", "true", "false"], "multiple records can still be collapsed explicitly");

    await page.reload({ waitUntil: "networkidle" });
    await openNode();
    await page.getByText("Agent response 3", { exact: true }).waitFor();
    assert.deepEqual(await expansion(), ["true", "true", "true"], "cold history also defaults all execution records to expanded");
    assert.deepEqual(controls.map(body => body.instruction), ["First follow-up", "Second follow-up"]);
    assert.deepEqual(errors, []);
  } finally { gates.forEach(gate => gate.resolve()); await context.close(); }
});

for (const planType of ["graph", "serial"]) {
  test(`${planType}: queued messages batch in order and consecutive Steers stay on the live execution`, { timeout: 45_000 }, async () => {
    const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 1, maxFeedback: 0, autoApprove: false };
    const output = text => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
    const first = { id: "queue-first", node: "task", status: "completed", revision: 1, attempt: 1, sessionId: "same-session", worktree: "/a", before: "", after: "", startedAt: 1, completedAt: 2, output: output("Initial queue result") };
    let current = { runId: "queue-run", config, planType, approved: true, paused: false, phase: "completed",
      graph: { originalGoal: "Queue goal", nodes: [{ name: "task", task: "Queue task" }], edges: [] },
      nodes: { task: { status: "completed", revision: 1, head: "", instruction: "", error: null, pendingMessages: [] } },
      executions: [first], plan: null,
      events: [{ type: "started", sequence: 1, timestamp: 1, execution: first, message_sequences: [] }],
      base: "", feedbackCounts: {} };
    const empty = { ...current, runId: "", config: null, approved: false, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {}, executions: [] };
    const actions = [], errors = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": result = { config, snapshot: empty, runs: [current.runId], repositoryInfo: { path: "/a", name: "Alpha", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
        case "history": case "snapshot": result = current; break;
        case "snapshot_if_changed": result = { version: JSON.stringify(current), snapshot: current }; break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = catalog; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "control": {
          actions.push(body.action);
          const sequence = current.events.length + 1;
          if (body.action === "intervene") {
            const event = { type: "invalidated", sequence, timestamp: sequence + 2, target: "task", nodes: ["task"], human: true, instruction: body.instruction };
            current = { ...current, phase: "running", events: [...current.events, event],
              nodes: { task: { ...current.nodes.task, status: "dirty", pendingMessages: [...current.nodes.task.pendingMessages, { sequence, instruction: body.instruction }] } } };
          } else {
            assert.equal(body.action, "steer");
            assert.equal(body.executionId, "queue-batch");
            current = { ...current, events: [...current.events, { type: "steered", sequence, timestamp: sequence + 2,
              node: "task", execution_id: body.executionId, instruction: body.instruction }] };
          }
          result = current; break;
        }
        default: errors.push(`Unexpected API: ${command}`); return route.fulfill({ status: 400, json: { error: command } });
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(String(error)));
    const openNode = async () => {
      await page.locator('[data-run-id="queue-run"]').click();
      if (planType === "graph") await page.locator('[data-node-name="task"]').click();
      await page.getByText("Initial queue result", { exact: true }).waitFor();
    };
    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      await openNode();
      const composer = page.locator(".pane-bottom-chat textarea");
      const send = async text => {
        const before = actions.length;
        await composer.fill(text); await composer.press("Enter");
        await waitFor(() => actions.length === before + 1);
        await page.waitForFunction(() => {
          const input = document.querySelector(".pane-bottom-chat textarea");
          return input?.value === "" && !input.disabled;
        });
      };
      await send("Repeated queued instruction");
      await send("Repeated queued instruction");
      assert.deepEqual(actions, ["intervene", "intervene"]);
      assert.equal(current.nodes.task.pendingMessages.length, 2);
      assert.equal(await page.getByText("Repeated queued instruction", { exact: true }).count(), 2);
      const batch = { ...first, id: "queue-batch", attempt: 2, revision: 2, status: "running", startedAt: 10, completedAt: null, output: output("Combined batch response") };
      current = { ...current, executions: [...current.executions, batch],
        nodes: { task: { ...current.nodes.task, status: "running", pendingMessages: [] } },
        events: [...current.events, { type: "started", sequence: 4, timestamp: 10, execution: batch, message_sequences: [2, 3] }] };
      await page.getByText("Combined batch response", { exact: true }).waitFor();
      assert.equal(await page.locator('[data-execution-id="queue-batch"]').count(), 1);
      const batchOrder = await page.evaluate(() => {
        const messages = [...document.querySelectorAll(".chat-message-row.user")].filter(item => item.textContent.includes("Repeated queued instruction"));
        const execution = document.querySelector('[data-execution-id="queue-batch"]');
        return { count: messages.length, execution: !!execution,
          follows: !!execution && messages.length === 2 && !!(messages[1].compareDocumentPosition(execution) & Node.DOCUMENT_POSITION_FOLLOWING) };
      });
      assert.ok(batchOrder.follows, `the shared response follows all user turns in its batch: ${JSON.stringify(batchOrder)}`);
      await send("First live Steer");
      await send("Second live Steer");
      assert.deepEqual(actions, ["intervene", "intervene", "steer", "steer"]);
      assert.equal(current.executions.length, 2, "Steers do not create another execution");
      assert.equal(current.nodes.task.pendingMessages.length, 0);
      await page.getByText("First live Steer", { exact: true }).waitFor();
      await page.getByText("Second live Steer", { exact: true }).waitFor();
      await page.reload({ waitUntil: "networkidle" });
      await openNode();
      await page.getByText("Combined batch response", { exact: true }).waitFor();
      assert.equal(await page.getByText("Repeated queued instruction", { exact: true }).count(), 2);
      await page.getByText("First live Steer", { exact: true }).waitFor();
      await page.getByText("Second live Steer", { exact: true }).waitFor();
      assert.equal(await page.locator('[data-execution-id="queue-batch"]').count(), 1);
      assert.ok(await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".chat-message-row.user")];
        const steers = rows.filter(row => row.textContent.includes("First live Steer") || row.textContent.includes("Second live Steer"));
        const output = document.querySelector('[data-execution-id="queue-batch"]');
        return steers.length === 2 && !!output &&
          steers.every(steer => !!(output.compareDocumentPosition(steer) & Node.DOCUMENT_POSITION_FOLLOWING)) &&
          !!(steers[0].compareDocumentPosition(steers[1]) & Node.DOCUMENT_POSITION_FOLLOWING);
      }), "unread historical Steers stay below the loaded output until their transcript turns are available");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("editing a node objective replaces the opening turn without creating a chat message", { timeout: 45_000 }, async () => {
  const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 1, maxFeedback: 0, autoApprove: false };
  const output = text => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
  const execution = (id, attempt, text) => ({ id, node: "task", status: "completed", revision: attempt, attempt, sessionId: "s", worktree: "/a", before: "", after: "", startedAt: attempt * 10, completedAt: attempt * 10 + 1, output: output(text) });
  const first = execution("first", 1, "First response"), second = execution("second", 2, "Second response");
  let current = { runId: "objective-run", config, planType: "graph", approved: true, paused: false, phase: "completed",
    graph: { originalGoal: "Goal", nodes: [{ name: "task", task: "Original objective" }], edges: [] },
    nodes: { task: { status: "completed", revision: 1, head: "", instruction: "", error: null } },
    executions: [first, second], events: [
      { type: "started", sequence: 1, timestamp: 10, execution: first, message_sequences: [] },
      { type: "invalidated", sequence: 2, timestamp: 15, target: "task", instruction: "Follow-up", human: true },
      { type: "started", sequence: 3, timestamp: 20, execution: second, message_sequences: [2] },
    ], plan: null, base: "", feedbackCounts: {} };
  const empty = { ...current, runId: "", config: null, approved: false, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {}, executions: [], events: [] };
  const errors = [], edits = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [current.runId], repositoryInfo: { path: "/a", name: "Alpha", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "history": case "snapshot": result = current; break;
      case "snapshot_if_changed": result = { version: JSON.stringify(current), snapshot: current }; break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = catalog; break;
      case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
      case "get_execution_output": {
        const item = current.executions.find(item => item.id === body.executionId), bytes = Buffer.from(item.output);
        const end = Math.min(body.endOffset ?? bytes.length, bytes.length);
        const start = body.tail ? Math.max(0, (body.before ?? end) - (body.limit ?? end)) : body.offset;
        const next = Math.min(end, start + (body.limit ?? end));
        result = { runId: current.runId, executionId: item.id, content: bytes.subarray(start, next).toString(), startOffset: start, nextOffset: next, totalBytes: end, complete: next === end, status: item.status }; break;
      }
      case "control": {
        assert.equal(body.action, "intervene");
        const followup = execution("after-edit", 4, "Response after edit");
        current = { ...current, executions: [...current.executions, followup], events: [...current.events,
          { type: "invalidated", sequence: 6, timestamp: 35, target: "task", instruction: body.instruction, human: true },
          { type: "started", sequence: 7, timestamp: 40, execution: followup, message_sequences: [6] }] };
        result = current; break;
      }
      case "edit_node": {
        edits.push(body);
        if (edits.length === 1) return route.fulfill({ status: 400, json: { error: "Objective edit rejected" } });
        const replacement = execution("replacement", 3, "Replacement response");
        current = { ...current, graph: { ...current.graph, nodes: [{ name: "task", task: body.instruction }] }, supersededExecutionIds: ["first", "second"],
          executions: [...current.executions, replacement], events: [...current.events,
            { type: "conversation_edited", sequence: 4, timestamp: 25, target: "task", nodes: ["task"], first_turn: true, instruction: body.instruction, old_instruction: body.oldText, from_execution_id: "first", from_event_sequence: 1 },
            { type: "started", sequence: 5, timestamp: 30, execution: replacement, message_sequences: [] }] };
        result = current; break;
      }
      default: errors.push(`Unexpected API: ${command}`); return route.fulfill({ status: 400, json: { error: command } });
    }
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  const open = async () => { await page.locator('[data-run-id="objective-run"]').click(); await page.locator('[data-node-name="task"]').click(); };
  try {
    await page.goto(origin, { waitUntil: "networkidle" }); await open();
    await page.getByText("Second response", { exact: true }).waitFor();
    const order = await page.evaluate(() => {
      const first = document.querySelector('[data-execution-id="first"]');
      const follow = [...document.querySelectorAll('.chat-message-row.user')].find(row => row.textContent.includes('Follow-up'));
      const second = document.querySelector('[data-execution-id="second"]');
      return !!first && !!follow && !!second && !!(first.compareDocumentPosition(follow) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(follow.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.ok(order, "each attempt follows the prompt that produced it");
    await page.locator('.node-task-tool-btn.edit').click();
    await page.locator('.node-task-edit-textarea').fill('Updated objective');
    await page.locator('.node-task-tool-btn.save').click();
    await page.getByRole('alert').filter({ hasText: 'Objective edit rejected' }).waitFor();
    assert.equal(await page.locator('.node-task-edit-textarea').inputValue(), 'Updated objective');
    assert.equal(await page.locator('.chat-message-row.user', { hasText: 'Follow-up' }).count(), 1, 'a rejected edit keeps the existing conversation');
    await page.locator('.node-task-tool-btn.save').click();
    await page.getByText('Replacement response', { exact: true }).waitFor();
    assert.equal(edits.length, 2);
    assert.equal(edits[1].executionId, 'first');
    assert.equal(await page.locator('.node-task-content').innerText(), 'Updated objective');
    assert.equal(await page.locator('.chat-message-row.user', { hasText: 'Updated objective' }).count(), 0);
    assert.equal(await page.locator('.chat-message-row.user', { hasText: 'Follow-up' }).count(), 0);
    assert.equal(await page.locator('.node-task-card').getByRole('group', { name: 'Version history' }).count(), 0);
    const composer = page.locator('.pane-bottom-chat textarea');
    await composer.fill('New follow-up'); await composer.press('Enter');
    await page.getByText('Response after edit', { exact: true }).waitFor();
    const editedOrder = await page.evaluate(() => {
      const first = document.querySelector('[data-execution-id="replacement"]');
      const follow = [...document.querySelectorAll('.chat-message-row.user')].find(row => row.textContent.includes('New follow-up'));
      const second = document.querySelector('[data-execution-id="after-edit"]');
      return !!first && !!follow && !!second && !!(first.compareDocumentPosition(follow) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(follow.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.ok(editedOrder, 'the replacement attempt remains before the later follow-up and its attempt');
    await page.reload({ waitUntil: 'networkidle' }); await open();
    await page.getByText('Response after edit', { exact: true }).waitFor();
    assert.equal(await page.locator('.node-task-content').innerText(), 'Updated objective');
    assert.equal(await page.locator('.chat-message-row.user', { hasText: 'Updated objective' }).count(), 0);
    assert.equal(await page.locator('.node-task-card').getByRole('group', { name: 'Version history' }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const planType of ["graph", "serial"]) {
  test(`${planType}: Steers clear the composer before acknowledgement and remain editable inline after reload`, { timeout: 45_000 }, async () => {
    const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 1, maxFeedback: 0, autoApprove: false };
    const output = (role, text) => JSON.stringify({ type: "message_end", message: { role, content: [{ type: "text", text }] } }) + "\n";
    const live = { id: "steer-live", node: "task", status: "running", revision: 1, attempt: 1, sessionId: "s", worktree: "/a", before: "", after: null, startedAt: 1, completedAt: null,
      output: output("assistant", "Original agent response") + output("user", "Consumed steer") + output("assistant", "Earlier steer reply") +
        JSON.stringify({ type: "tool_execution_start", toolCallId: "retained-tool", toolName: "bash", args: { command: "echo retained" } }) + "\n" +
        JSON.stringify({ type: "tool_execution_end", toolCallId: "retained-tool", toolName: "bash", result: { content: [{ type: "text", text: "Retained tool output" }] } }) + "\n" };
    let current = { runId: "edit-steer-run", config, planType, approved: true, paused: false, phase: "running",
      graph: { originalGoal: "Original goal", nodes: [{ name: "task", task: "Original task" }], edges: [] },
      nodes: { task: { status: "running", revision: 1, head: "", instruction: "", error: null, pendingMessages: [] } },
      executions: [live], plan: null, events: [{ type: "started", sequence: 1, timestamp: 1, execution: live, message_sequences: [] },
        { type: "steered", sequence: 2, timestamp: 2, node: "task", execution_id: live.id, instruction: "Consumed steer" }],
      base: "", feedbackCounts: {} };
    const empty = { ...current, runId: "", config: null, approved: false, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {}, executions: [] };
    const gate = deferred(), controls = [], edits = [], errors = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": result = { config, snapshot: empty, runs: [current.runId], repositoryInfo: { path: "/a", name: "Alpha", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
        case "history": case "snapshot": result = current; break;
        case "snapshot_if_changed": result = { version: JSON.stringify(current), snapshot: current }; break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = catalog; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "get_execution_output": {
          const execution = current.executions.find(item => item.id === body.executionId);
          const bytes = Buffer.from(execution.output);
          const end = Math.min(body.endOffset ?? bytes.length, bytes.length);
          const start = body.tail ? Math.max(0, (body.before ?? end) - (body.limit ?? end)) : body.offset;
          const next = Math.min(end, start + (body.limit ?? end));
          result = { runId: current.runId, executionId: execution.id, content: bytes.subarray(start, next).toString(),
            startOffset: start, nextOffset: next, totalBytes: end, complete: next === end, status: execution.status };
          break;
        }
        case "control":
          controls.push(body);
          assert.equal(body.action, "steer");
          await gate.promise;
          current = { ...current, events: [...current.events, { type: "steered", sequence: 3, timestamp: 3,
            node: "task", execution_id: live.id, instruction: body.instruction }] };
          result = current; break;
        case "edit_node": {
          edits.push(body);
          if (edits.length === 1) {
            await route.fulfill({ status: 400, json: { error: "Retry this edit" } }); return;
          }
          const sequence = current.events.length + 1;
          const replacement = { ...live, id: `steer-edited-${edits.length}`, attempt: edits.length, startedAt: sequence + 1,
            output: output("assistant", edits.length === 2 ? "Edited steer response" : "Edited earlier response") };
          current = { ...current, supersededExecutionIds: current.executions.map(item => item.id),
            executions: [...current.executions.map(item => ({ ...item, status: "paused", completedAt: sequence, outputBytes: Buffer.byteLength(item.output) })), replacement],
            events: [...current.events,
              { type: "conversation_edited", sequence, timestamp: sequence, target: "task", nodes: ["task"], instruction: body.instruction,
                old_instruction: body.oldText, from_execution_id: live.id, from_event_sequence: 1, from_output_offset: body.userTurnOffset, first_turn: false },
              { type: "started", sequence: sequence + 1, timestamp: sequence + 1, execution: replacement, message_sequences: [] }] };
          result = current; break;
        }
        default: errors.push(`Unexpected API: ${command}`); return route.fulfill({ status: 400, json: { error: command } });
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on("pageerror", error => errors.push(String(error)));
    const open = async () => {
      await page.locator('[data-run-id="edit-steer-run"]').click();
      if (planType === "graph") await page.locator('[data-node-name="task"]').click();
      await page.getByText("Original agent response", { exact: true }).waitFor();
    };
    try {
      await page.goto(origin, { waitUntil: "networkidle" }); await open();
      const composer = page.locator(".pane-bottom-chat textarea");
      await composer.fill("Consumed steer"); await composer.press("Enter");
      await waitFor(() => controls.length === 1);
      await page.waitForFunction(() => document.querySelector(".pane-bottom-chat textarea")?.value === "");
      assert.equal(current.events.length, 2, "the input clears without waiting for the backend acknowledgement");
      const pending = page.locator(".chat-message-row.user.planner-follow-up", { hasText: "Consumed steer" });
      await pending.waitFor();
      await page.waitForTimeout(100);
      assert.equal(await pending.count(), 1, "the earlier identical turn must not hide the new unread Steer");
      assert.equal(await pending.locator(".chat-message-edit-btn").count(), 0, "an unread steer cannot branch a nonexistent Pi turn");
      gate.resolve();
      await page.waitForFunction(() => !document.querySelector(".pane-bottom-chat textarea")?.disabled);
      current = { ...current, executions: [{ ...live, output: live.output + output("user", "Consumed steer") + output("assistant", "Steer reply") }] };
      const rows = page.locator('[data-execution-id="steer-live"] .chat-message-row.user', { hasText: "Consumed steer" });
      const inline = rows.last();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-execution-id="steer-live"] .chat-message-row.user')].filter(row => row.textContent.includes("Consumed steer")).length === 2);
      assert.equal(await pending.count(), 0, "both identical messages move inline without an extra outer bubble");
      await page.reload({ waitUntil: "networkidle" }); await open();
      await inline.locator(".chat-user-message-card-wrapper").hover();
      await inline.locator(".chat-message-edit-btn").click();
      const editor = page.locator(".chat-bubble-edit-textarea");
      await editor.fill("Replacement steer"); await editor.press("Enter");
      await page.getByRole("alert").filter({ hasText: "Retry this edit" }).waitFor();
      await page.waitForFunction(() => !document.querySelector(".chat-bubble-edit-textarea")?.disabled);
      assert.equal(await editor.inputValue(), "Replacement steer", "a rejected edit retains its draft");
      await editor.press("Enter");
      await page.getByText("Edited steer response", { exact: true }).waitFor();
      await page.getByText("Consumed steer", { exact: true }).waitFor();
      await page.getByText("Original agent response", { exact: true }).waitFor();
      await page.getByText("Earlier steer reply", { exact: true }).waitFor();
      assert.equal(await page.locator('[data-execution-id="steer-live"] .tool-call-card').count(), 1);
      const ordered = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".chat-message-row")];
        const index = text => rows.findIndex(row => row.textContent.includes(text));
        return index("Consumed steer") < index("Replacement steer") && index("Replacement steer") < index("Edited steer response");
      });
      assert.ok(ordered, "earlier turns and the edited instruction precede its replacement response");
      assert.equal(edits.length, 2);
      assert.deepEqual(edits[1], { runId: current.runId, node: "task", executionId: live.id, oldText: "Consumed steer", instruction: "Replacement steer", userTurnOffset: Buffer.byteLength(live.output), compact: true, detail: "metadata" });
      assert.equal(current.graph.originalGoal, "Original goal");
      assert.equal(current.graph.nodes[0].task, "Original task");
      assert.equal(await page.locator(".chat-bubble-edit-textarea").count(), 0);
      // Reload the durable prefix, then edit its earlier, identically worded
      // Steer even though its execution is now superseded.
      await page.reload({ waitUntil: "networkidle" }); await open();
      await page.getByText("Earlier steer reply", { exact: true }).waitFor();
      const earlier = rows.first();
      await earlier.locator(".chat-user-message-card-wrapper").hover();
      await earlier.locator(".chat-message-edit-btn").click();
      await editor.fill("Replacement earlier steer"); await editor.press("Enter");
      await page.getByText("Edited earlier response", { exact: true }).waitFor();
      assert.equal(edits.length, 3);
      assert.equal(edits[2].executionId, live.id);
      assert.equal(edits[2].userTurnOffset, Buffer.byteLength(output("assistant", "Original agent response")));
      assert.equal(await page.getByText("Earlier steer reply", { exact: true }).count(), 0);
      assert.equal(await page.getByText("Edited steer response", { exact: true }).count(), 0);
      assert.equal(await page.locator(".tool-call-card").count(), 0);
      await page.getByText("Original agent response", { exact: true }).waitFor();
      await page.reload({ waitUntil: "networkidle" }); await open();
      await page.getByText("Edited earlier response", { exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally { gate.resolve(); await context.close(); }
  });
}

test("pausing a node returns an unread steer to the composer and removes its card", { timeout: 45_000 }, async () => {
  const gate = deferred();
  let steerReceived = false;
  const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 1, maxFeedback: 0, autoApprove: false };
  const live = { id: "live-exec", node: "task", status: "running", revision: 1, attempt: 1, sessionId: "s", worktree: "/a", before: "", after: null, startedAt: 1, completedAt: null, output: "" };
  let current = { runId: "pause-steer-run", config, planType: "graph", approved: true, paused: false, phase: "running",
    graph: { originalGoal: "Pause steer goal", nodes: [{ name: "task", task: "Pause steer task" }], edges: [] },
    nodes: { task: { status: "running", revision: 1, head: "", instruction: "", error: null, pendingMessages: [] } },
    executions: [live], plan: null,
    events: [{ type: "started", sequence: 1, timestamp: 1, execution: live, message_sequences: [] }],
    base: "", feedbackCounts: {} };
  const empty = { ...current, runId: "", config: null, approved: false, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {}, executions: [] };
  const actions = [], errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [current.runId], repositoryInfo: { path: "/a", name: "Alpha", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "history": case "snapshot": result = current; break;
      case "snapshot_if_changed": result = { version: JSON.stringify(current), snapshot: current }; break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = catalog; break;
      case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
      case "get_execution_output": result = { runId: current.runId, executionId: body.executionId, content: "", startOffset: 0, nextOffset: 0, totalBytes: 0, complete: true, status: current.executions.find(item => item.id === body.executionId)?.status }; break;
      case "control": {
        if (body.action === "steer") {
          steerReceived = true;
          await gate.promise;
        }
        actions.push({ action: body.action, node: body.node });
        if (body.action === "steer") {
          const sequence = current.events.length + 1;
          current = { ...current, events: [...current.events, { type: "steered", sequence, timestamp: sequence + 2, node: "task", execution_id: body.executionId, instruction: body.instruction }] };
        } else if (body.action === "stop") {
          current = { ...current, paused: true, phase: "paused",
            nodes: { task: { ...current.nodes.task, status: "paused" } },
            executions: current.executions.map(item => item.id === "live-exec" ? { ...item, status: "paused", completedAt: 5 } : item) };
        }
        result = current; break;
      }
      default: errors.push(`Unexpected API: ${command}`); return route.fulfill({ status: 400, json: { error: command } });
    }
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="pause-steer-run"]').click();
    await page.locator('[data-node-name="task"]').click();
    const composer = page.locator(".pane-bottom-chat textarea");
    await composer.fill("Unread steer instruction");
    await composer.press("Enter");
    await page.locator('.chat-message-row.user', { hasText: "Unread steer instruction" }).waitFor();
    await waitFor(() => steerReceived);
    assert.deepEqual(actions, [], "the optimistic card is visible before acknowledgement");
    const interrupt = page.getByRole("button", { name: "Click to interrupt execution" });
    assert.equal(await interrupt.isDisabled(), true, "the send must settle before interruption");
    gate.resolve();
    await waitFor(() => actions.length === 1);
    assert.deepEqual(actions, [{ action: "steer", node: "task" }]);
    await interrupt.click();
    await page.waitForFunction(() => document.querySelector(".pane-bottom-chat textarea")?.value === "Unread steer instruction");
    assert.equal(await page.locator('.chat-message-row.user', { hasText: "Unread steer instruction" }).count(), 0,
      "the unread steer card is removed");
    assert.deepEqual(actions, [{ action: "steer", node: "task" }, { action: "stop", node: "task" }]);
    assert.deepEqual(errors, []);
  } finally { gate.resolve(); await context.close(); }
});

test("a partially loaded transcript never rolls back a repeated consumed steer", { timeout: 45_000 }, async () => {
  const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 1, maxFeedback: 0, autoApprove: false };
  const line = (role, text) => JSON.stringify({ type: "message_end", message: { role, content: [{ type: "text", text }] } }) + "\n";
  const output = line("assistant", "Opening answer") + line("user", "again") +
    ["first", "second", "third"].map(index => line("assistant", `${index} ${"x".repeat(250_000)}`)).join("") +
    line("user", "again") + line("assistant", "Tail visible reply");
  const bytes = Buffer.from(output);
  const live = { id: "live-exec", node: "task", status: "running", revision: 1, attempt: 1, sessionId: "s", worktree: "/a", before: "", after: null, startedAt: 1, completedAt: null, output: "", outputBytes: bytes.length };
  let current = { runId: "tail-steer-run", config, planType: "graph", approved: true, paused: false, phase: "running",
    graph: { originalGoal: "Tail steer goal", nodes: [{ name: "task", task: "Tail steer task" }], edges: [] },
    nodes: { task: { status: "running", revision: 1, head: "", instruction: "", error: null, pendingMessages: [] } },
    executions: [live], plan: null, base: "", feedbackCounts: {},
    events: [{ type: "started", sequence: 1, timestamp: 1, execution: live, message_sequences: [] },
      { type: "steered", sequence: 2, timestamp: 2, node: "task", execution_id: live.id, instruction: "again" },
      { type: "steered", sequence: 3, timestamp: 3, node: "task", execution_id: live.id, instruction: "again" }] };
  const empty = { ...current, runId: "", config: null, approved: false, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {}, executions: [], events: [] };
  const actions = [], errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = { config, snapshot: empty, runs: [current.runId], repositoryInfo: { path: "/a", name: "Alpha", branch: "main", head: "", clean: true }, dataPath: "/mock" }; break;
      case "history": case "snapshot": result = current; break;
      case "snapshot_if_changed": result = { version: JSON.stringify(current), snapshot: current }; break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = catalog; break;
      case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
      case "get_execution_output": {
        // The initial read is a tail page that starts after the first identical
        // user turn, so the window cannot prove it was consumed.
        const end = Math.min(body.endOffset ?? bytes.length, bytes.length);
        const next = body.tail ? Math.min(body.before ?? end, end) : Math.min(end, body.offset + (body.limit ?? 262144));
        const start = body.tail ? Math.max(0, next - (body.limit ?? 262144)) : body.offset;
        result = { runId: current.runId, executionId: live.id, content: bytes.subarray(start, next).toString(),
          startOffset: start, nextOffset: next, totalBytes: end, complete: next === end, status: current.executions[0].status };
        break;
      }
      case "control":
        actions.push({ action: body.action, node: body.node });
        if (body.action === "stop") {
          current = { ...current, paused: true, phase: "paused",
            nodes: { task: { ...current.nodes.task, status: "paused" } },
            executions: [{ ...live, status: "paused", completedAt: 5 }] };
        }
        result = current; break;
      default: errors.push(`Unexpected API: ${command}`); return route.fulfill({ status: 400, json: { error: command } });
    }
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="tail-steer-run"]').click();
    await page.locator('[data-node-name="task"]').click();
    await page.getByText("Tail visible reply", { exact: true }).waitFor();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-execution-id="live-exec"] .chat-message-row.user', { hasText: "again" }).count(), 1,
      "the tail page renders the one consumed turn it loaded");
    assert.equal(await page.locator('.chat-message-row.user.planner-follow-up', { hasText: "again" }).count(), 0,
      "a repeated turn already inline does not grow a duplicate card");
    await page.getByRole("button", { name: "Click to interrupt execution", exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".pane-bottom-chat textarea").inputValue(), "",
      "a partially loaded transcript never returns a consumed steer to the composer");
    assert.deepEqual(actions, [{ action: "stop", node: "task" }]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("late node sends and edits cannot overwrite another workspace or its composer draft", { timeout: 45_000 }, async () => {
  const config = { repository: "/a", model: "test/old", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const base = { plan: null, events: [], approved: true, paused: false, phase: "completed", base: "", feedbackCounts: {} };
  const snapshots = {
    a: { ...base, runId: "a", config, planType: "serial", graph: { originalGoal: "Alpha original", nodes: [{ name: "task", task: "Alpha original" }], edges: [] },
      nodes: { task: { status: "completed", revision: 0, head: null, instruction: "", error: null } },
      executions: [{ id: "exec-a", node: "task", status: "completed", revision: 0, attempt: 1, sessionId: "s", worktree: "/a", before: "", after: "", output: "", startedAt: 1, completedAt: 2 }] },
    b: { ...base, runId: "b", config: { ...config, repository: "/b" }, planType: "graph", graph: { originalGoal: "Beta original", nodes: [], edges: [] }, nodes: {}, executions: [] },
  };
  const empty = { ...snapshots.b, runId: "", graph: { originalGoal: "", nodes: [], edges: [] }, approved: false, phase: "draft", config: null };
  const info = path => ({ path, name: path === "/a" ? "Alpha" : "Beta", branch: "main", head: "", clean: true });
  const bootstrap = { config, snapshot: empty, runs: ["a", "b"], repositoryInfo: info("/a"), dataPath: "/mock" };
  const sendGate = deferred(), editGate = deferred();
  let controls = 0, edits = 0, sendReplied = false, editReplied = false;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  const errors = [];
  await context.addInitScript(({ config }) => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_projects", JSON.stringify([
      { path: "/a", id: "/a", name: "Alpha", branch: "main", clean: true, lastOpened: 2 },
      { path: "/b", id: "/b", name: "Beta", branch: "main", clean: true, lastOpened: 1 },
    ]));
    localStorage.setItem("grapher_config", JSON.stringify(config));
  }, { config });
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    let result;
    switch (command) {
      case "bootstrap": result = bootstrap; break;
      case "snapshot": case "history": result = snapshots[body.runId]; break;
      case "snapshot_if_changed": result = { version: "fixed", snapshot: null }; break;
      case "detect_repository": result = info(body.path || body.repository); break;
      case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
      case "list_plannings": result = []; break;
      case "list_files": result = { files: [] }; break;
      case "list_skills": result = { skills: [] }; break;
      case "provider_auth": result = catalog; break;
      case "control":
        controls += 1;
        assert.equal(body.runId, "a");
        if (controls === 1) { await route.fulfill({ status: 400, json: { error: "Intervention rejected" } }); return; }
        await sendGate.promise;
        result = { ...snapshots.a, phase: "running" };
        sendReplied = true;
        break;
      case "edit_node":
        edits += 1;
        assert.equal(body.runId, "a");
        await editGate.promise;
        result = { ...snapshots.a, graph: { ...snapshots.a.graph, originalGoal: "Edited Alpha" }, phase: "running" };
        editReplied = true;
        break;
      default:
        errors.push(`Unexpected API: ${command}`);
        await route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } }); return;
    }
    await route.fulfill({ json: { result } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="a"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Alpha original" }).waitFor();
    const composer = page.locator(".pane-bottom-chat textarea");
    await composer.fill("Retryable follow-up");
    await composer.press("Enter");
    await page.getByRole("alert").filter({ hasText: "Intervention rejected" }).waitFor();
    assert.equal(await composer.inputValue(), "Retryable follow-up");
    assert.ok(!(await page.locator(".chat-messages-stream").innerText()).includes("Retryable follow-up"));
    await composer.press("Enter");
    await waitFor(() => controls === 2);
    // Switching workspaces lands on home; the Beta conversation is opened explicitly.
    await page.locator(".project-workspace-item", { hasText: "Beta" }).click();
    await page.locator(".landing-screen").waitFor();
    await page.waitForFunction(() => !document.querySelector(".chat-messages-stream"));
    assert.equal(await page.locator(".run-item.chosen").count(), 0);
    await page.locator('[data-run-id="b"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Beta original" }).waitFor();
    await composer.fill("Beta draft");
    sendGate.resolve();
    await waitFor(() => sendReplied);
    await page.waitForTimeout(100);
    assert.equal(await composer.inputValue(), "Beta draft");
    assert.equal(await page.locator(".run-item.chosen").getAttribute("data-run-id"), "b");
    assert.ok(!(await page.locator(".chat-messages-stream").innerText()).includes("Alpha"));
    await page.locator(".project-workspace-item", { hasText: "Alpha" }).click();
    await page.locator(".landing-screen").waitFor();
    await page.waitForFunction(() => !document.querySelector(".chat-messages-stream"));
    await page.locator('[data-run-id="a"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Alpha original" }).waitFor();
    await page.locator(".chat-user-message-card-wrapper").first().hover();
    await page.locator(".chat-message-edit-btn").first().click();
    const editor = page.locator(".chat-bubble-edit-textarea");
    await editor.fill("Edited Alpha");
    await editor.press("Enter");
    await waitFor(() => edits === 1);
    await page.locator(".project-workspace-item", { hasText: "Beta" }).click();
    await page.locator(".landing-screen").waitFor();
    await page.waitForFunction(() => !document.querySelector(".chat-messages-stream"));
    await page.locator('[data-run-id="b"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Beta original" }).waitFor();
    await composer.fill("Beta next draft");
    editGate.resolve();
    await waitFor(() => editReplied);
    await page.waitForTimeout(100);
    assert.equal(await composer.inputValue(), "Beta next draft");
    assert.equal(await page.locator(".run-item.chosen").getAttribute("data-run-id"), "b");
    assert.ok(!(await page.locator(".chat-messages-stream").innerText()).includes("Edited Alpha"));
    assert.deepEqual(errors, []);
  } finally { sendGate.resolve(); editGate.resolve(); await context.close(); }
});

test("thinking cards keep empty blocks with an explanation and backfill text in place in live and replay views", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("thinking", undefined, "reduce", true);
  const append = event => page.evaluate(event => window.audit.append(event), event);
  const update = (type, contentIndex, extra = {}) => append({
    type: "message_update", assistantMessageEvent: { type, contentIndex, ...extra },
  });
  const views = [page.locator('[data-thinking-view="live"]'), page.locator('[data-thinking-view="history"]')];
  try {
    await append({ type: "message_start", message: { role: "assistant", content: [] } });
    await update("thinking_start", 0);
    for (const view of views) await view.locator(".thinking-shimmer").waitFor();
    const ids = await Promise.all(views.map(view => view.locator("[data-transcript-id]").first().getAttribute("data-transcript-id")));
    await update("thinking_end", 0, { content: "" });
    for (const [index, view] of views.entries()) {
      const card = view.locator(".thinking-card").first();
      await card.waitFor();
      assert.match(await card.getAttribute("class"), /settled/);
      assert.equal(await view.locator(".thinking-shimmer, .thinking-empty").count(), 0);
      // The empty block keeps its card and explains the missing text when opened.
      if (!(await card.locator(".thinking-card-body").count()))
        await card.locator(".thinking-card-header").click();
      await card.locator(".thinking-card-body", { hasText: "This reasoning produced no visible content." }).waitFor();
      if (index === 1) await card.locator(".thinking-card-header").click();
    }
    await update("thinking_start", 1);
    for (const view of views) {
      await view.locator(".thinking-shimmer").waitFor();
      assert.equal(await view.locator(".thinking-empty").count(), 0);
    }
    await update("thinking_end", 1, { content: "End-only summary 中文🚀" });
    await update("thinking_start", 2);
    await update("thinking_delta", 2, { delta: "Normalized " });
    await update("thinking_end", 2, { content: "Normalized final summary" });
    await append({ type: "message_end", message: { role: "assistant", content: [
      { type: "thinking", thinking: "Backfilled first summary" },
      { type: "thinking", thinking: "End-only summary 中文🚀" },
      { type: "thinking", thinking: "Normalized final summary" },
    ] } });
    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      assert.equal(await view.locator(".thinking-card").count(), 3);
      assert.equal(await view.locator(".thinking-card.settled").count(), 3);
      assert.equal(await view.locator(".thinking-shimmer, .thinking-empty").count(), 0);
      assert.equal(await view.locator("[data-transcript-id]").first().getAttribute("data-transcript-id"), ids[i]);
      for (const [index, text] of ["Backfilled first summary", "End-only summary 中文🚀", "Normalized final summary"].entries()) {
        const card = view.locator(".thinking-card").nth(index);
        if (!(await card.locator(".thinking-card-body").count()))
          await card.locator(".thinking-card-header").click();
        await card.locator(".thinking-card-body", { hasText: text }).waitFor();
      }
    }
    await append({ type: "message_start", message: { role: "assistant", content: [] } });
    await update("thinking_start", 0);
    await update("thinking_end", 0, { content: "End-only summary 中文🚀" });
    for (const view of views) {
      const card = view.locator(".thinking-card").nth(3);
      await card.waitFor();
      assert.equal(await view.locator(".thinking-shimmer").count(), 0);
      if (!(await card.locator(".thinking-card-body").count()))
        await card.locator(".thinking-card-header").click();
      await card.locator(".thinking-card-body", { hasText: "End-only summary 中文🚀" }).waitFor();
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("completed thinking stays visible and copyable through empty or replacement summaries", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("thinking", undefined, "reduce", true);
  const append = event => page.evaluate(event => window.audit.append(event), event);
  const update = (type, extra = {}) => append({
    type: "message_update", assistantMessageEvent: { type, contentIndex: 0, ...extra },
  });
  const views = [page.locator('[data-thinking-view="live"]'), page.locator('[data-thinking-view="history"]')];
  const turns = [
    { seed: "", delta: "Streamed thinking 中文🚀: keep the first step and the detailed second step.", ending: "", final: "" },
    { seed: "Start snapshot 中文🚀: ", delta: "retain this text together with the remaining delta.", ending: "Brief final", final: "Different final summary" },
  ];
  try {
    await page.evaluate(() => {
      window.audit.copied = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async text => { window.audit.copied.push(text); },
      } });
    });
    for (const [turn, data] of turns.entries()) {
      const captured = data.seed + data.delta;
      await append({ type: "message_start", message: { role: "assistant", content: [] } });
      await update("thinking_start", data.seed ? { content: { type: "thinking", thinking: data.seed } } : {});
      await update("thinking_delta", { delta: data.delta });
      const ids = [];
      for (const view of views) {
        const card = view.locator(".thinking-card").nth(turn);
        await card.locator(".thinking-card-body", { hasText: captured }).waitFor();
        ids.push(await card.locator("xpath=ancestor::*[@data-transcript-id][1]").getAttribute("data-transcript-id"));
        await card.locator(".thinking-card-header").click();
      }
      await update("thinking_end", { content: data.ending });
      await append({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: data.final }] } });
      for (const [i, view] of views.entries()) {
        // message_end settles the card on the next render commit; do not read
        // its class immediately after the header already exists. Later cards
        // stay expanded from the copy check below, so index the card itself.
        const viewName = i === 0 ? "live" : "history";
        await page.waitForFunction(({ viewName, turn }) => {
          const card = document.querySelectorAll(`[data-thinking-view="${viewName}"] .thinking-card`)[turn];
          return card?.classList.contains("settled") && card.classList.contains("collapsed");
        }, { viewName, turn });
        const card = view.locator(".thinking-card").nth(turn);
        await card.locator(".thinking-card-header").waitFor();
        assert.match(await card.getAttribute("class"), /settled collapsed/);
        assert.equal(await card.locator("xpath=ancestor::*[@data-transcript-id][1]").getAttribute("data-transcript-id"), ids[i]);
        await card.locator(".thinking-card-header").click();
        await card.locator(".thinking-card-body", { hasText: captured }).waitFor();
        assert.equal(await view.locator(".thinking-empty, .thinking-shimmer").count(), 0);
        await card.locator(".thinking-copy-btn").click();
        assert.equal(await page.evaluate(() => window.audit.copied.at(-1)), captured);
      }
    }
    await append({ type: "message_start", message: { role: "assistant", content: [] } });
    await update("thinking_start");
    await update("thinking_end", { content: "" });
    for (const view of views) {
      await view.locator(".thinking-shimmer").waitFor({ state: "detached" });
      const empty = view.locator(".thinking-card").nth(2);
      await empty.waitFor();
      assert.match(await empty.getAttribute("class"), /settled/);
      assert.equal(await view.locator(".thinking-empty").count(), 0);
      assert.equal(await view.locator(".thinking-card").count(), 3);
      if (!(await empty.locator(".thinking-card-body").count()))
        await empty.locator(".thinking-card-header").click();
      await empty.locator(".thinking-card-body", { hasText: "This reasoning produced no visible content." }).waitFor();
      for (const data of turns) assert.ok((await view.innerText()).includes(data.seed + data.delta));
    }
    assert.equal(await views[1].locator("[data-transcript-id]").count(), 3, "empty history blocks keep their row");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("thinking stays folded while watching when disabled, until a click opens it", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await fixture("thinking", undefined, "reduce", false);
  const append = event => page.evaluate(event => window.audit.append(event), event);
  const views = [page.locator('[data-thinking-view="live"]'), page.locator('[data-thinking-view="history"]')];
  try {
    await append({ type: "message_start", message: { role: "assistant", content: [] } });
    await append({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    await append({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "FOLDED_AUTO_COT" } });
    for (const view of views) {
      const card = view.locator(".thinking-card").first();
      await card.waitFor();
      assert.match(await card.getAttribute("class"), /streaming collapsed/);
      assert.equal(await view.locator(".thinking-card-body").count(), 0,
        "a folded COT must not render its Markdown body");
      await card.locator(".thinking-card-header").click();
      await view.locator(".thinking-card-body", { hasText: "FOLDED_AUTO_COT" }).waitFor();
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
