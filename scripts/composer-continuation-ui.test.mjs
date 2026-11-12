import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

test("empty composer continues without submitting a message; drafts and stop retain their behavior", async () => {
  const server = await createServer({ cacheDir: "node_modules/.vite-composer-continuation", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null },
    plugins: [{ name: "composer-continuation-fixture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/__composer-continuation") && !req.url.startsWith("/__node-continuation")) return next();
        const fixture = req.url.startsWith("/__node-continuation") ? "node-continuation" : "composer-continuation";
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module" src="/scripts/fixtures/${fixture}.tsx"></script></body></html>`));
      });
    } }] });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const page = await browser.newPage();
    await page.route("**/api/*", route => route.fulfill({ json: { result: {} } }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__composer-continuation`);
    const input = page.locator("textarea");
    const output = page.locator("output");
    assert.equal(await page.locator(".prompt-box-continuation-risk").count(), 0, "continuation has no additional risk banner");
    const continueButton = page.getByRole("button", { name: "继续当前 Agent（不会追加消息）" });
    await continueButton.click();
    assert.equal(await output.textContent(), "continue");
    await input.fill("  ");
    await input.press("Enter");
    assert.equal(await output.textContent(), "continue|continue");
    await input.fill("hello");
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes("send:hello"));
    await page.getByText("Toggle working").click();
    await page.getByRole("button", { name: "点击打断执行" }).click();
    assert.equal(await output.textContent(), "continue|continue|send:hello|interrupt");
    await page.getByText("Toggle working").click();
    await page.getByText("Toggle disabled").click();
    assert.equal(await page.getByRole("button", { name: "继续当前 Agent（不会追加消息）" }).isDisabled(), true);
    for (const mode of ["graph", "serial", "planner"]) {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__node-continuation?mode=${mode}`);
      await page.locator(".pane-bottom-chat textarea").evaluate(input => {
        for (let i = 0; i < 2; i++) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      assert.equal(await page.getByTestId("calls").textContent(), mode === "planner" ? "resume_planner" : "resume_node:task", `${mode} must address its own agent only once`);
      if (mode === "graph") {
        await page.getByText("正在准备节点工作区", { exact: true }).waitFor();
        assert.equal(await page.getByText("正在复制节点工作区", { exact: true }).count(), 0,
          "node continuation must not infer copying from generic preparation");
      }
    }
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__node-continuation?mode=graph`);
    assert.equal(await page.getByText("正在准备节点工作区", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "继续", exact: true }).click();
    assert.equal(await page.getByTestId("calls").textContent(), "resume");
    await page.getByText("正在准备节点工作区", { exact: true }).waitFor();
    assert.equal(await page.getByText("正在复制节点工作区", { exact: true }).count(), 0,
      "run-wide continuation must not infer copying from generic preparation");
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__composer-continuation?pending=1`);
    await page.locator("textarea").evaluate(input => {
      for (let i = 0; i < 2; i++) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    assert.equal(await page.locator("output").textContent(), "continue", "repeated Enter cannot submit a pending continuation twice");
    assert.equal(await page.getByRole("button", { name: "正在继续" }).isDisabled(), true);
    await page.evaluate(() => window.continuationFixture.reject(new Error("rejected")));
    await page.getByRole("button", { name: "继续当前 Agent（不会追加消息）" }).waitFor();
    const play = page.getByRole("button", { name: "继续当前 Agent（不会追加消息）" });
    const box = await play.boundingBox();
    assert.ok(box);
    await play.click();
    await page.evaluate(() => { window.continuationFixture.setWorking(true); window.continuationFixture.resolve(true); });
    await page.waitForTimeout(100);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await page.locator("output").textContent(), "continue|continue", "a second click must not stop the just-resumed agent");
    await page.mouse.move(0, 0);
    await page.getByRole("button", { name: "点击打断执行" }).click();
    assert.equal(await page.locator("output").textContent(), "continue|continue|interrupt");
  } finally {
    await browser?.close();
    await server.close();
  }
});
