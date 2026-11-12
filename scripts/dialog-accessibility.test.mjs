import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-dialog-accessibility",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false },
    plugins: [{ name: "dialog-accessibility-fixture", configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__dialogs") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/scripts/fixtures/dialog-accessibility.tsx"></script></body></html>'));
      });
    } }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"),
    headless: true,
  });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: "reduce", ...options });
  const errors = [];
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const results = {
      provider_auth: { providers: [{ id: "test", name: "Test provider", configured: true, authSource: "local", methods: [] }], models: [], warning: null },
      pi_extensions: { globalDirectory: "/fixture/extensions", extensions: [] },
      environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true },
    };
    if (!Object.hasOwn(results, command)) errors.push(`Unexpected API: ${command}`);
    await route.fulfill({ json: { result: results[command] ?? {} } });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/__dialogs`);
  await page.getByRole("button", { name: "Open confirm", exact: true }).waitFor();
  return page;
}

for (const reducedMotion of ["reduce", "no-preference"]) {
  test(`confirmation keeps keyboard focus safe and restores it (${reducedMotion})`, { timeout: 30_000 }, async t => {
    const page = await fixture(t, { reducedMotion });
    const opener = page.getByRole("button", { name: "Open confirm", exact: true });
    await opener.click();
    const dialog = page.getByRole("alertdialog", { name: "Delete conversation?" });
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    const confirm = dialog.getByRole("button", { name: "Delete conversation", exact: true });
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(confirm).toBeFocused();
    // An unrelated component trying to autofocus cannot escape the modal.
    await page.getByRole("textbox", { name: "Background input" }).evaluate(element => element.focus());
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    await expect(dialog).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.dialogs.confirms), 0);
    await opener.press("Enter");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.dialogs.confirms), 0, "Enter initially cancels, never deletes");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => window.dialogs.closedCallbacks), 0);
  });
}

test("editor keeps its draft and ignores Escape during IME composition", { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  const opener = page.getByRole("button", { name: "Open editor", exact: true });
  await opener.click();
  const editor = page.getByRole("textbox", { name: "Graph JSON" });
  await expect(editor).toBeFocused();
  await editor.fill('{"originalGoal":"Unsaved draft"}');
  await editor.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('{"originalGoal":"Unsaved draft"}');
  const apply = page.getByRole("button", { name: "Validate and apply", exact: true });
  const close = page.getByRole("button", { name: "Close dialog", exact: true });
  await apply.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(apply).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
});

for (const kind of ["editor", "approval"]) {
  test(`${kind} cannot close or change actions while busy`, { timeout: 30_000 }, async t => {
    const page = await fixture(t);
    await page.getByRole("button", { name: `Open ${kind}`, exact: true }).click();
    await page.evaluate(() => window.dialogs.setBusy(true));
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    for (const button of await dialog.getByRole("button").all()) await expect(button).toBeDisabled();
    if (kind === "editor") await expect(page.getByRole("textbox", { name: "Graph JSON" })).toHaveAttribute("readonly", "");
    await page.keyboard.press("Escape");
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Tab");
    assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)), "even an all-disabled dialog retains keyboard focus");
    await page.evaluate(() => window.dialogs.setBusy(false));
    await expect(page.getByRole("button", { name: "Close dialog", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Open ${kind}`, exact: true })).toBeFocused();
  });
}

test("nested language confirmation dismisses only itself and restores the settings control", { timeout: 30_000 }, async t => {
  const page = await fixture(t, { reducedMotion: "no-preference" });
  const opener = page.getByRole("button", { name: "Open settings", exact: true });
  await opener.click();
  const language = page.getByRole("combobox", { name: "Interface language", exact: true });
  await language.focus();
  await language.selectOption("zh-CN");
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(language).toBeFocused();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  await expect(page.locator(".settings-modal")).toHaveCount(0);
});

test("nested credential confirmation traps focus without dismissing Settings", { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.locator(".configured-title-group").click();
  const remove = page.locator(".logout-btn").first();
  await remove.click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  const last = confirmation.getByRole("button").last();
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(confirmation.getByRole("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(remove).toBeFocused();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
});

test("long confirmation details wrap and remain scrollable in a small viewport", { timeout: 30_000 }, async t => {
  const page = await fixture(t, { viewport: { width: 360, height: 480 } });
  await page.evaluate(() => window.dialogs.setLongDetail(true));
  await page.getByRole("button", { name: "Open confirm", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  const bounds = await dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: innerWidth, height: innerHeight, clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height);
  assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, "unbroken paths must not cause horizontal scrolling");
  assert.ok(bounds.scrollHeight > bounds.clientHeight, "long details scroll inside the dialog");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("dragging from confirmation text onto the backdrop does not cancel", { timeout: 30_000 }, async t => {
  const page = await fixture(t);
  await page.getByRole("button", { name: "Open confirm", exact: true }).click();
  const message = page.getByText("This operation cannot be undone.", { exact: true });
  const box = await message.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(4, 4);
  await page.mouse.up();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
