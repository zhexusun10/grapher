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

async function fixture(name, handler = async () => false, reducedMotion = "reduce", autoExpandCot = undefined) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion });
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
      write_workspace_file: { success: true }, delete_workspace_file: { success: true } };
    if (Object.hasOwn(defaults, command)) return route.fulfill({ json: { result: defaults[command] } });
    errors.push(`Unexpected API: ${command}`);
    await route.fulfill({ status: 500, json: { error: `Unexpected API: ${command}` } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  page.setDefaultTimeout(10_000);
  try {
    await page.goto(`${origin}/__audit?case=${name}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.audit);
  } catch (error) {
    await context.close();
    throw new Error(`Fixture failed: ${errors.join("; ")} ${error}`);
  }
  return { context, page, errors };
}

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
    assert.equal(await buttons.count(), 1);
    await buttons.first().click();
    await page.waitForFunction(() => window.audit.copies.length === 3);
    assert.equal(await page.evaluate(() => window.audit.copies.at(-1)), "echo streaming\n");
    await page.evaluate(() => window.audit.setMarkdown("```sh\necho streaming updated", true));
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
  const { context, page, errors } = await fixture("timeTook");
  try {
    const base = new Date("2026-10-17T08:00:00Z");
    await page.clock.install({ time: base });
    await page.clock.pauseAt(new Date(base.getTime() + 1000));
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

test("reasoning auto-expand is committed by Save and discarded by Cancel", { timeout: 30_000 }, async () => {
  const saves = [];
  const { context, page, errors } = await fixture("settings", async (route, command, body) => {
    if (command !== "save_config") return false;
    saves.push(body.config);
    await route.fulfill({ json: { result: { config: body.config, snapshot: null, dataPath: "/mock" } } });
    return true;
  });
  const toggle = () => page.getByLabel("Auto-expand chain of thought while running");
  const stored = () => page.evaluate(() => localStorage.getItem("grapher_auto_expand_cot_v1"));
  try {
    assert.equal(await toggle().isChecked(), true, "display option starts checked by default");

    // Cancel closes the modal without touching the stored preference.
    await toggle().uncheck();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(await stored(), null);
    await page.evaluate(() => window.audit.open());
    assert.equal(await toggle().isChecked(), true, "reopening restores the unsaved draft");

    // Save commits the display option alongside the backend settings.
    await toggle().uncheck();
    await page.getByRole("button", { name: /save settings/i }).click();
    await page.waitForFunction(() => localStorage.getItem("grapher_auto_expand_cot_v1") === "0");
    assert.equal(saves.length, 1, "the backend config save still runs");
    await page.evaluate(() => window.audit.open());
    assert.equal(await toggle().isChecked(), false, "the saved option survives reopening");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
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
        await card.waitFor();
        await page.locator(".workbench").evaluate((element, height) => { element.parentElement.style.height = `${height}px`; }, paneHeight);
        await input.fill(draft);
        await page.waitForTimeout(400);
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
    await page.evaluate(() => { window.audit.resolve(false); delete window.audit.resolve; });
    await page.waitForFunction(() => !document.querySelector("textarea").disabled);
    assert.equal(await input.inputValue(), draft);
    assert.equal(await collapse.getAttribute("aria-expanded"), "true");
    await input.press("Enter");
    await page.waitForFunction(() => typeof window.audit.resolve === "function");
    await page.evaluate(() => window.audit.resolve(true));
    await page.waitForFunction(() => document.querySelector("textarea").value === "");
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
      else await page.locator(".planner-off", { hasText: "Offline" }).waitFor();
      assert.deepEqual(errors, []);
    } finally { gate.resolve(); await context.close(); }
  });
}

for (const wireStatus of ["completed", "done"]) {
  test(`topology cards display COMPLETED for ${wireStatus} backend status`, { timeout: 30_000 }, async () => {
    const config = { repository: "/mock/status-label", model: "test/old", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
    const empty = { runId: "", config: null, graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
      plan: null, executions: [], events: [], approved: false, paused: false, phase: "draft", base: "", feedbackCounts: {} };
    const snapshot = { ...empty, runId: `status-${wireStatus}`, config, planType: "graph", approved: true, phase: "needs_attention",
      graph: { originalGoal: "Show authoritative node statuses", nodes: ["task", "waiting", "failed"].map(name => ({ name, task: `Task ${name}` })), edges: [] },
      nodes: Object.fromEntries(["task", "waiting", "failed"].map(name => [name, {
        status: name === "task" ? wireStatus : name, revision: 1, head: null, instruction: "", error: name === "failed" ? "Mock failure" : null,
      }])) };
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
      assert.equal(await label.innerText(), "COMPLETED", "backend completion must never leave the card label empty");
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
      assert.equal(await page.locator('.task-node[data-node-name="waiting"] .status').innerText(), "WAITING");
      assert.equal(await page.locator('.task-node[data-node-name="failed"] .status').innerText(), "FAILED");
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
          : { ...current, paused: false, canResume: false, phase: "running",
            nodes: { ...current.nodes, task: { ...current.nodes.task, status: "running", error: null } },
            executions: [...current.executions, { ...execution("second", "task", "running"), attempt: 2 }] };
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
    await page.locator('[data-node-name="task"] .status', { hasText: "PAUSED" }).waitFor();
    await page.locator('[data-node-name="broken"] .status', { hasText: "FAILED" }).waitFor();
    await bottom.getByRole("button", { name: "Resume", exact: true }).click();
    await page.locator('[data-node-name="task"] .status', { hasText: "RUNNING" }).waitFor();
    assert.deepEqual(actions.map(action => action.action), ["pause", "resume"]);
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
    await page.locator(".floating-recovered-banner").waitFor();
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
    await page.locator(".floating-recovered-banner").waitFor({ state: "detached" });

    finished = true;
    await page.locator('.run-item.chosen[data-run-id="recovered-run"]').waitFor();
    await activity.getByText("Automatically appended activity", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("pure frontend refresh during active planning announces reconnection once and auto-dismisses without flicker", { timeout: 45_000 }, async () => {
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
    // Planning activity should poll and render directly
    const activity = page.getByRole("region", { name: "Planning activity" });
    await activity.getByText("Streaming active plan output", { exact: true }).waitFor();
    // A persisted running turn is re-attached immediately; the reconnect banner must
    // appear exactly once and auto-dismiss after the conversation becomes ready.
    await page.waitForFunction(() => window.recoveryBanner.shown >= 1, null, { timeout: 10_000 });
    await page.locator(".floating-recovered-banner").waitFor({ state: "detached", timeout: 10_000 });
    const banner = await page.evaluate(() => window.recoveryBanner);
    assert.deepEqual(banner, { shown: 1, removed: 1 }, "the reconnect banner is announced once and removed without flicker");
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
        await composer.fill(text); await composer.press("Enter");
        await page.waitForFunction(() => document.querySelector(".pane-bottom-chat textarea")?.value === "");
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
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

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

test("thinking cards hide empty blocks and backfill text in place in live and replay views", { timeout: 30_000 }, async () => {
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
    for (const view of views) {
      await view.locator(".thinking-card").waitFor({ state: "detached" });
      assert.equal(await view.locator(".thinking-shimmer, .thinking-empty").count(), 0);
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
      await view.locator(".thinking-card-body", { hasText: "Backfilled first summary" }).waitFor();
      assert.equal(await view.locator(".thinking-card").count(), 3);
      assert.equal(await view.locator(".thinking-card.settled").count(), 3);
      assert.equal(await view.locator(".thinking-shimmer, .thinking-empty").count(), 0);
      assert.equal(await view.locator("[data-transcript-id]").first().getAttribute("data-transcript-id"), ids[i]);
      assert.ok((await view.innerText()).includes("End-only summary 中文🚀"));
      assert.ok((await view.innerText()).includes("Normalized final summary"));
    }
    await append({ type: "message_start", message: { role: "assistant", content: [] } });
    await update("thinking_start", 0);
    await update("thinking_end", 0, { content: "End-only summary 中文🚀" });
    for (const view of views) {
      await view.locator(".thinking-card").nth(3).waitFor();
      assert.equal(await view.locator(".thinking-card-body", { hasText: "End-only summary 中文🚀" }).count(), 2);
      assert.equal(await view.locator(".thinking-shimmer").count(), 0);
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
      assert.equal(await view.locator(".thinking-card").count(), 2);
      assert.equal(await view.locator(".thinking-empty").count(), 0);
      for (const data of turns) assert.ok((await view.innerText()).includes(data.seed + data.delta));
    }
    assert.equal(await views[1].locator("[data-transcript-id]").count(), 2, "empty history blocks reserve no rows");
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
