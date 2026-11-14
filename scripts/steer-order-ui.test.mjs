import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-steer-order", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
    plugins: [{ name: "steer-order", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/__steer")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/scripts/fixtures/steer-order.tsx"></script></body></html>'));
      });
    } }] });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

for (const mode of ["serial", "graph"]) {
  test(`${mode}: Alt+Q restores only queued messages and Alt+S sends an interruption`, { timeout: 30_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    let withdrawals = 0;
    let fail = false;
    let events = [];
    const withdrawn = { type: "steers_withdrawn", sequence: 3, timestamp: 3, execution_id: "exec", message_sequences: [2] };
    await context.route("**/api/*", async route => {
      const body = route.request().postDataJSON();
      if (body?.operation === "withdraw") {
        withdrawals++;
        assert.equal(body.runId, "steer-run");
        assert.equal(body.node, "task");
        if (fail) return route.fulfill({ status: 500, json: { error: "Cannot withdraw" } });
        return route.fulfill({ json: { result: { messages: withdrawals === 1 ? [{ text: "SAME" }] : [],
          snapshot: { events: [...events, withdrawn] } } } });
      }
      return route.fulfill({ json: { result: {} } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(`${origin}/__steer?mode=${mode}`);
      await page.getByText("OUTPUT BEFORE STEER", { exact: true }).waitFor();
      const input = page.locator(".pane-bottom-chat textarea").first();
      const bubbles = page.locator(".chat-bubble-user", { hasText: "SAME" });
      for (let i = 0; i < 2; i++) {
        await input.fill("SAME"); await input.press("Enter");
        await expect(input).toHaveValue("");
      }
      await expect(bubbles).toHaveCount(2);
      events = await page.evaluate(() => window.steerAudit.events);
      assert.equal(new Set(events.map(event => event.request_id)).size, 2);
      await expect(page.getByText(/Alt \+ Q to restore queued messages/).first()).toBeVisible();
      await page.evaluate(() => window.steerAudit.consume("SAME"));
      await page.getByText("OUTPUT AFTER STEER", { exact: true }).waitFor();
      await input.fill("EXISTING DRAFT");
      await input.press("Alt+q");
      await expect(input).toHaveValue("EXISTING DRAFT\n\nSAME");
      await expect(input).toBeFocused();
      await expect(bubbles).toHaveCount(1);
      await input.press("Alt+q");
      await expect(input).toBeEnabled();
      assert.equal(withdrawals, 2);
      await expect(input).toHaveValue("EXISTING DRAFT\n\nSAME");
      fail = true;
      await input.press("Alt+q");
      await page.getByText("Cannot withdraw", { exact: true }).waitFor();
      await expect(input).toHaveValue("EXISTING DRAFT\n\nSAME");
      await expect(bubbles).toHaveCount(1);
      await input.fill("");
      await input.press("Alt+s");
      assert.equal(await page.evaluate(() => window.steerAudit.submissions.length), 2, "empty interruption does nothing");
      await input.fill("SAME");
      await input.press("Alt+s");
      await expect(input).toHaveValue("");
      assert.deepEqual(await page.evaluate(() => window.steerAudit.submissions.map(item => item.interrupt)), [false, false, true]);
      await expect(bubbles).toHaveCount(2);
      await page.evaluate(() => window.steerAudit.consume("SAME"));
      await expect(page.getByText("OUTPUT AFTER STEER", { exact: true })).toHaveCount(2);
      await expect(bubbles).toHaveCount(2, { timeout: 3000 });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  test(`${mode}: withdrawal preserves image inputs and ignores composing/repeated shortcuts`, { timeout: 30_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", name: "image.png" };
    let withdrawals = 0;
    await context.route("**/api/*", route => {
      const body = route.request().postDataJSON();
      if (body?.operation === "withdraw") {
        withdrawals++;
        return route.fulfill({ json: { result: { messages: [{ text: "inspect queued image", images: [image] }], snapshot: { events: [] } } } });
      }
      return route.fulfill({ json: { result: {} } });
    });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/__steer?mode=${mode}`);
      const input = page.locator(".pane-bottom-chat textarea").first();
      await input.fill("draft");
      for (const extra of [{ isComposing: true }, { repeat: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
        for (const code of ["KeyQ", "KeyS"]) await input.dispatchEvent("keydown", { key: code.at(-1).toLowerCase(), code, altKey: true, ...extra });
      }
      assert.equal(withdrawals, 0);
      assert.equal(await page.evaluate(() => window.steerAudit.submissions.length), 0);
      // macOS Option changes the printable key, but the physical chord remains Alt+Q.
      await input.dispatchEvent("keydown", { key: "œ", code: "KeyQ", altKey: true });
      await expect(input).toHaveValue("draft\n\ninspect queued image");
      await expect(page.locator(".prompt-box-preview-img")).toHaveCount(1);
      await input.dispatchEvent("keydown", { key: "ß", code: "KeyS", altKey: true });
      await expect(input).toHaveValue("");
      assert.deepEqual(await page.evaluate(() => window.steerAudit.submissions[0]), {
        text: "draft\n\ninspect queued image", interrupt: true, images: [image],
      });
      await expect(page.locator(".prompt-box-preview-img")).toHaveCount(0);
    } finally { await context.close(); }
  });

  test(`${mode}: in-flight recall survives view changes and image-only resend`, { timeout: 30_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", name: "image.png" };
    let pending;
    let requests = 0;
    await context.route("**/api/*", route => {
      if (route.request().postDataJSON()?.operation === "withdraw") { pending = route; requests++; return; }
      return route.fulfill({ json: { result: {} } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(`${origin}/__steer?mode=${mode}`);
      const input = page.locator(".pane-bottom-chat textarea").first();
      await input.fill("existing draft");
      await input.press("Alt+q");
      await expect.poll(() => requests).toBe(1);
      await page.getByRole("button", { name: "Toggle view" }).click();
      await expect(input).toHaveCount(0);
      await page.getByRole("button", { name: "Toggle view" }).click();
      await expect(input).toBeDisabled();
      await pending.fulfill({ json: { result: { messages: [{ text: "recalled image", images: [image] }], snapshot: { events: [] } } } });
      await expect(input).toHaveValue("existing draft\n\nrecalled image");
      await expect(input).toBeEnabled();
      await expect(page.locator(".prompt-box-preview-img")).toHaveCount(1);
      // A second navigation must preserve the already-restored attachment too.
      await page.getByRole("button", { name: "Toggle view" }).click();
      await page.getByRole("button", { name: "Toggle view" }).click();
      await expect(input).toHaveValue("existing draft\n\nrecalled image");
      await expect(page.locator(".prompt-box-preview-img")).toHaveCount(1);
      await input.fill("");
      await expect(page.locator(".prompt-box-preview-img")).toHaveCount(1);
      await input.press("Alt+s");
      await expect.poll(() => page.evaluate(() => window.steerAudit.submissions.length)).toBe(1);
      assert.deepEqual(await page.evaluate(() => window.steerAudit.submissions[0]), {
        text: "Please inspect the attached images.", images: [image], interrupt: true,
      });
      await expect(page.locator(".prompt-box-preview-img")).toHaveCount(0);
      assert.equal(requests, 1);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  test(`${mode}: an unread steer follows output, even when execution settles before consumption`, { timeout: 30_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    await context.route("**/api/*", route => route.fulfill({ json: { result: {} } }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(`${origin}/__steer?mode=${mode}`);
      const output = page.getByText("OUTPUT BEFORE STEER", { exact: true });
      await output.waitFor();
      const input = page.locator(".pane-bottom-chat textarea").first();
      await input.fill("STEER MARKER");
      await input.press("Enter");
      const steer = page.locator(".chat-bubble-user", { hasText: "STEER MARKER" });
      await steer.waitFor();
      assert.equal(await steer.evaluate(element => !element.closest(".serial-execution-panel")), true,
        "an unread steer keeps the conversation column spacing instead of nesting inside the execution panel");
      const follows = () => page.evaluate(() => {
        const output = [...document.querySelectorAll("*")].find(e => e.textContent === "OUTPUT BEFORE STEER");
        const steer = [...document.querySelectorAll(".chat-bubble-user")].find(e => e.textContent.includes("STEER MARKER"));
        return !!output && !!steer && !!(output.compareDocumentPosition(steer) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      assert.equal(await follows(), true);
      await page.evaluate(() => window.steerAudit.settle());
      await page.waitForTimeout(100);
      assert.equal(await follows(), true, "settlement must not move the pending steer above output");
      await page.evaluate(() => window.steerAudit.consume("STEER MARKER"));
      await page.getByText("OUTPUT AFTER STEER", { exact: true }).waitFor();
      assert.equal(await steer.count(), 1, "the inline turn replaces the pending card");
      assert.equal(await follows(), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  test(`${mode}: a consumed steer renders once after a settled reload`, { timeout: 30_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    await context.route("**/api/*", route => route.fulfill({ json: { result: {} } }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(`${origin}/__steer?mode=${mode}&presettled=true`);
      await page.getByText("OUTPUT AFTER STEER", { exact: true }).waitFor();
      const bubble = page.locator(".chat-bubble-user", { hasText: "CONSUMED STEER" });
      await bubble.waitFor();
      await page.waitForTimeout(300);
      assert.equal(await bubble.count(), 1, "the parsed inline turn must not also render as an outer fallback card");
      const row = page.locator(".chat-message-row.user", { hasText: "CONSUMED STEER" });
      assert.equal(await row.count(), 1);
      const metrics = await row.evaluate(element => {
        const style = getComputedStyle(element);
        const list = element.closest(".virtualized-transcript-container");
        return {
          marginTop: style.marginTop, marginBottom: style.marginBottom,
          inline: element.classList.contains("planner-user-turn"),
          inTranscript: !!list && !!list.closest("[data-execution-id]"),
          listGap: list ? getComputedStyle(list.querySelector(".transcript-scroll-area")?.firstElementChild ?? list).gap : "",
        };
      });
      assert.equal(metrics.inline, true);
      assert.equal(metrics.inTranscript, true);
      // 46px margin + the 10px list gap keeps the same 56px above the turn as
      // the 44px margin + 12px conversation gap used outside the transcript.
      assert.equal(metrics.marginTop, "46px");
      assert.equal(metrics.marginBottom, "10px");
      assert.equal(metrics.listGap, "10px");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  test(`${mode}: two identical queued steers hand off one at a time`, { timeout: 30_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    await context.route("**/api/*", route => route.fulfill({ json: { result: {} } }));
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/__steer?mode=${mode}`);
      await page.getByText("OUTPUT BEFORE STEER", { exact: true }).waitFor();
      const input = page.locator(".pane-bottom-chat textarea").first();
      for (let i = 0; i < 2; i++) {
        await input.fill("SAME STEER");
        await input.press("Enter");
        await page.waitForFunction(count => [...document.querySelectorAll(".chat-bubble-user")].filter(e => e.textContent.includes("SAME STEER")).length === count, i + 1);
      }
      await page.evaluate(() => window.steerAudit.consume("SAME STEER"));
      await page.getByText("OUTPUT AFTER STEER", { exact: true }).first().waitFor();
      const positions = await page.evaluate(() => {
        const output = [...document.querySelectorAll("*")].find(e => e.textContent === "OUTPUT AFTER STEER");
        return [...document.querySelectorAll(".chat-bubble-user")].filter(e => e.textContent.includes("SAME STEER"))
          .map(e => !!(output.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING));
      });
      assert.deepEqual(positions, [false, true], "only the unread second occurrence stays after the output");
    } finally { await context.close(); }
  });

  test(`${mode}: a repeated steer in a partial log stays visible at the tail`, { timeout: 30_000 }, async () => {
    const line = event => JSON.stringify(event) + "\n";
    const assistant = text => line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    const user = text => line({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
    const prefix = assistant("OLDER HISTORY");
    let data = Buffer.from(prefix + user("REPEAT") + assistant("OUTPUT BEFORE STEER"));
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.split("/").at(-1);
      if (command !== "get_execution_output") return route.fulfill({ json: { result: {} } });
      const body = route.request().postDataJSON();
      if (body.before !== undefined) return; // Keep the older page in flight during this test.
      const start = body.tail ? Buffer.byteLength(prefix) : body.offset;
      return route.fulfill({ json: { result: { runId: body.runId, executionId: body.executionId,
        content: data.subarray(start).toString(), startOffset: start, nextOffset: data.length,
        totalBytes: data.length, complete: true, status: "running" } } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(`${origin}/__steer?mode=${mode}&paged=true`);
      await page.getByText("OUTPUT BEFORE STEER", { exact: true }).waitFor();
      const input = page.locator(".pane-bottom-chat textarea").first();
      await input.fill("REPEAT");
      await input.press("Enter");
      const bubbles = page.locator(".chat-bubble-user", { hasText: "REPEAT" });
      await page.waitForFunction(() => [...document.querySelectorAll(".chat-bubble-user")].filter(e => e.textContent.includes("REPEAT")).length === 2);
      const lastFollows = () => page.evaluate(() => {
        const output = [...document.querySelectorAll("*")].find(e => e.textContent === "OUTPUT BEFORE STEER");
        const rows = [...document.querySelectorAll(".chat-bubble-user")].filter(e => e.textContent.includes("REPEAT"));
        return !!output && rows.length === 2 && !!(output.compareDocumentPosition(rows[1]) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      assert.equal(await lastFollows(), true);
      data = Buffer.concat([data, Buffer.from(user("REPEAT") + assistant("OUTPUT AFTER STEER"))]);
      await page.getByText("OUTPUT AFTER STEER", { exact: true }).waitFor({ timeout: 15_000 });
      assert.equal(await bubbles.count(), 2);
      assert.equal(await lastFollows(), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  test(`${mode}: an image steer retains its preview when it enters the transcript`, { timeout: 30_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    await context.route("**/api/*", route => {
      const command = new URL(route.request().url()).pathname.split("/").at(-1);
      return route.fulfill({ json: { result: command === "write_workspace_attachment"
        ? { name: "image.png", path: "grapher-attachments/12345678-1234-1234-1234-123456789abc/image.png" } : {} } });
    });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/__steer?mode=${mode}`);
      await page.getByText("OUTPUT BEFORE STEER", { exact: true }).waitFor();
      await page.locator('input[type="file"]').first().setInputFiles({ name: "image.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
      const input = page.locator(".pane-bottom-chat textarea").first();
      await input.fill("inspect image");
      await input.press("Enter");
      const bubble = page.locator(".chat-bubble-user", { hasText: "inspect image" });
      await bubble.waitFor();
      assert.equal(await bubble.locator(".. >> img.chat-user-img").count(), 1);
      await page.evaluate(() => window.steerAudit.consume("@grapher-attachments/12345678-1234-1234-1234-123456789abc/image.png inspect image"));
      await page.getByText("OUTPUT AFTER STEER", { exact: true }).waitFor();
      assert.equal(await bubble.count(), 1);
      assert.equal(await bubble.locator(".. >> img.chat-user-img").count(), 1);
    } finally { await context.close(); }
  });

  test(`${mode}: an attachment stays with its steer through transcript handoff`, { timeout: 30_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    await context.route("**/api/*", route => {
      const command = new URL(route.request().url()).pathname.split("/").at(-1);
      return route.fulfill({ json: { result: command === "write_workspace_attachment"
        ? { name: "evidence.txt", path: "grapher-attachments/12345678-1234-1234-1234-123456789abc/evidence.txt" } : {} } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(`${origin}/__steer?mode=${mode}`);
      await page.getByText("OUTPUT BEFORE STEER", { exact: true }).waitFor();
      await page.locator('input[type="file"]').first().setInputFiles({ name: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from("evidence") });
      const input = page.locator(".pane-bottom-chat textarea").first();
      await input.fill("inspect this file");
      await input.press("Enter");
      const steer = page.locator(".chat-bubble-user", { hasText: "inspect this file" });
      await steer.waitFor();
      assert.equal(await steer.locator(".. >> .chat-bubble-file-badge", { hasText: "evidence.txt" }).count(), 1);
      const follows = () => page.evaluate(() => {
        const output = [...document.querySelectorAll("*")].find(e => e.textContent === "OUTPUT BEFORE STEER");
        const steer = [...document.querySelectorAll(".chat-bubble-user")].find(e => e.textContent.includes("inspect this file"));
        return !!output && !!steer && !!(output.compareDocumentPosition(steer) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      assert.equal(await follows(), true);
      await page.evaluate(() => window.steerAudit.consume("@grapher-attachments/12345678-1234-1234-1234-123456789abc/evidence.txt inspect this file"));
      await page.getByText("OUTPUT AFTER STEER", { exact: true }).waitFor();
      await page.waitForTimeout(100);
      assert.equal(await steer.count(), 1);
      assert.equal(await steer.locator(".. >> .chat-bubble-file-badge", { hasText: "evidence.txt" }).count(), 1);
      assert.equal(await follows(), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
