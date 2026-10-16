import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;

before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-wedged-repro",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
    plugins: [{ name: "wedged-repro", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/__repro")) return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<html><body><div id="root" style="padding:16px"></div><script type="module" src="/scripts/fixtures/wedged-node-repro.tsx"></script></body></html>'));
      });
    } }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function open() {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
  const errors = [];
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command === "get_execution_output") return route.fulfill({ json: { result: { output: "", offset: 0, complete: true } } });
    if (command === "snapshot_if_changed" || command === "snapshot") return route.fulfill({ json: { result: { version: "1", snapshot: null } } });
    return route.fulfill({ json: { result: {} } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", msg => { if (msg.type() === "error") errors.push(`console: ${msg.text().slice(0, 300)}`); });
  await page.goto(`${origin}/__repro?case=wedged`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.wedgedAudit);
  await page.waitForTimeout(600);
  console.log("PANE CLASSES:", await page.evaluate(() =>
    Array.from(document.querySelectorAll("[class*=pane], [class*=workbench], [class*=conversation]")).slice(0, 12)
      .map(el => `${el.tagName}.${el.className?.toString?.().slice(0, 60)}`)));
  return { context, page, errors };
}

test("diagnose wedged-node conversation edit + continue controls", { timeout: 60_000 }, async () => {
  const { context, page, errors } = await open();
  try {
    // 0) Narrow the conversation pane like the real split view
    await page.setViewportSize({ width: 1965, height: 1330 });
    // 1) The instruction bubble rendered for the failed node
    const bubbles = page.locator(".chat-user-message-card-wrapper");
    await bubbles.first().waitFor();
    const count = await bubbles.count();
    console.log("user bubbles:", count);

    // 2) Click the edit pencil on the instruction bubble (the one containing the protocol text)
    const target = bubbles.filter({ hasText: "Feedback Protocol Error" }).first();
    const editBtn = target.locator(".chat-message-edit-btn");
    console.log("edit buttons on target bubble:", await editBtn.count());
    if (await editBtn.count()) {
      await target.hover();
      await editBtn.click();
      await page.waitForSelector(".chat-bubble-edit-textarea");
      // BEFORE typing: is the confirm button rendered? Is cancel occluded?
      const pre = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll(".chat-bubble-actions .chat-bubble-action-btn"));
        return btns.map(b => {
          const r = b.getBoundingClientRect();
          const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { cls: b.className.includes("send") ? "confirm" : "cancel", x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
            hit: el === b || b.contains(el) ? "ok" : `covered by ${el?.className?.toString?.().slice(0, 60)}` };
        });
      });
      console.log("pre-typing buttons:", JSON.stringify(pre));
      console.log("editing bubble box:", JSON.stringify(await page.evaluate(() => {
        const b = document.querySelector(".chat-bubble-user.editing");
        const r = b?.getBoundingClientRect();
        return r ? { x: Math.round(r.x), w: Math.round(r.width) } : null;
      })));
      await page.screenshot({ path: "node_modules/.wedged-repro-preedit.png", fullPage: false });
      // 3) Modify the draft
      await page.fill(".chat-bubble-edit-textarea", "Modified instruction for retry");
      await page.waitForTimeout(120);
      const cancelBtn = page.locator(".chat-bubble-actions .chat-bubble-action-btn").first();
      const sendBtn = page.locator(".chat-bubble-actions .chat-bubble-action-btn.send");
      console.log("cancel visible:", await cancelBtn.isVisible());
      console.log("send(confirm) count:", await sendBtn.count());
      if (await sendBtn.count()) {
        console.log("send visible:", await sendBtn.isVisible());
        const box = await sendBtn.boundingBox();
        console.log("send box:", JSON.stringify(box));
        // occlusion probe: what element sits at the button's center?
        const occluded = await page.evaluate(() => {
          const btn = document.querySelector(".chat-bubble-actions .chat-bubble-action-btn.send");
          if (!btn) return "missing";
          const r = btn.getBoundingClientRect();
          const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return el === btn || btn.contains(el) ? "ok" : `covered by ${el?.className?.toString?.().slice(0, 80)}`;
        });
        console.log("send occlusion:", occluded);
      }
      const cancelOccluded = await page.evaluate(() => {
        const btn = document.querySelector(".chat-bubble-actions .chat-bubble-action-btn");
        if (!btn) return "missing";
        const r = btn.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return el === btn || btn.contains(el) ? "ok" : `covered by ${el?.className?.toString?.().slice(0, 80)}`;
      });
      console.log("cancel occlusion:", cancelOccluded);
      await page.screenshot({ path: "node_modules/.wedged-repro-edit.png", fullPage: false });
      await page.keyboard.press("Escape");
    }

    // 4) The topology bottom continue/pause button
    const control = page.locator("#execution-control-btn, .graph-bottom .execution-control-btn, .graph-bottom button.primary");
    const ctrlCount = await control.count();
    console.log("bottom control buttons:", ctrlCount);
    if (ctrlCount) {
      const btn = control.first();
      console.log("bottom control text:", (await btn.textContent())?.trim());
      console.log("bottom control disabled:", await btn.isDisabled());
      if (!(await btn.isDisabled())) {
        await btn.click();
        await page.waitForTimeout(80);
      }
      console.log("controls recorded:", JSON.stringify((await page.evaluate(() => window.wedgedAudit.controls))));
    }

    // 5) composer state: type text, check send button, click send
    const promptBox = page.locator(".prompt-box-container").first();
    console.log("prompt box disabled class:", await promptBox.getAttribute("class"));
    await page.fill(".prompt-box-container textarea", "请节点 11 继续");
    const sendBtn2 = page.locator(".prompt-box-send-btn").first();
    console.log("composer send disabled after typing:", await sendBtn2.isDisabled());
    if (!await sendBtn2.isDisabled()) {
      await sendBtn2.click();
      await page.waitForTimeout(150);
      console.log("sends recorded:", JSON.stringify(await page.evaluate(() => window.wedgedAudit.sends)));
      // the optimistic bubble for the sent message
      const sent = page.locator(".chat-user-message-card-wrapper").filter({ hasText: "请节点 11 继续" });
      console.log("sent bubble count:", await sent.count());
      if (await sent.count()) {
        await sent.first().hover();
        const sentEdit = sent.first().locator(".chat-message-edit-btn");
        console.log("sent bubble edit btn:", await sentEdit.count());
        if (await sentEdit.count()) {
          await sentEdit.click();
          await page.waitForSelector(".chat-bubble-edit-textarea", { timeout: 4000 }).catch(() => console.log("NO EDIT TEXTAREA"));
          const ta = page.locator(".chat-bubble-edit-textarea");
          if (await ta.count()) {
            await ta.fill("修改后的继续指令");
            await page.waitForTimeout(100);
            const s = page.locator(".chat-bubble-actions .chat-bubble-action-btn.send");
            console.log("sent-bubble confirm count:", await s.count(), "visible:", await s.count() ? await s.first().isVisible() : "-");
            const c = page.locator(".chat-bubble-actions .chat-bubble-action-btn").first();
            console.log("sent-bubble cancel visible:", await c.isVisible());
            const occ = await page.evaluate(() => {
              const btn = document.querySelector(".chat-bubble-actions .chat-bubble-action-btn");
              if (!btn) return "missing";
              const r = btn.getBoundingClientRect();
              const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              return { rect: { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight },
                hit: el === btn || btn.contains(el) ? "ok" : `covered by ${el?.className?.toString?.().slice(0, 60)}` };
            });
            console.log("sent-bubble cancel occlusion:", JSON.stringify(occ));
            await page.screenshot({ path: "node_modules/.wedged-repro-sent-edit.png" });
          }
        }
      }
    }
    console.log("page errors:", JSON.stringify(errors));
    assert.ok(errors.length === 0, `page errors: ${errors.join("; ")}`);
  } finally {
    await context.close();
  }
});
