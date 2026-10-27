import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-steer-order", server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
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
