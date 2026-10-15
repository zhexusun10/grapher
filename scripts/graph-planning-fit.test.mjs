import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-graph-planning-fit",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false },
    plugins: [{ name: "graph-planning-fixture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__graph-planning") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url,
          '<html><body><div id="root"></div><script type="module" src="/scripts/fixtures/graph-planning.tsx"></script></body></html>'));
      });
    } }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

const viewport = page => page.locator(".react-flow__viewport").evaluate(element => {
  const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
  return { x: matrix.e, y: matrix.f, zoom: matrix.a };
});

async function assertFitted(page, rows) {
  await page.evaluate(() => { window.lastFitSample = null; });
  await page.waitForFunction(rows => {
    const flow = document.querySelector(".graph-canvas .react-flow");
    if (!flow || +getComputedStyle(flow).opacity < 1 || +getComputedStyle(flow.closest(".graph-pane")).opacity < 0.99) return false;
    const elements = [...flow.querySelectorAll(".react-flow__node")];
    if (elements.length !== rows.flat().length || elements.some(node => !node.checkVisibility({ checkVisibilityCSS: true }))) return false;
    const rects = new Map(elements.map(node => [node.dataset.id, node.getBoundingClientRect()]));
    if (rows.flat().some(id => !rects.has(id))) return false;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].some(id => Math.abs(rects.get(id).top - rects.get(rows[i][0]).top) > 2)) return false;
      if (i && rects.get(rows[i][0]).top <= rects.get(rows[i - 1][0]).bottom) return false;
    }
    const bounds = [...rects.values()];
    const canvas = flow.getBoundingClientRect();
    const left = Math.min(...bounds.map(rect => rect.left)), right = Math.max(...bounds.map(rect => rect.right));
    const top = Math.min(...bounds.map(rect => rect.top)), bottom = Math.max(...bounds.map(rect => rect.bottom));
    if (left < canvas.left - 1 || right > canvas.right + 1 || top < canvas.top - 1 || bottom > canvas.bottom + 1 ||
        Math.abs((left + right - canvas.left - canvas.right) / 2) > 2 ||
        Math.abs((top + bottom - canvas.top - canvas.bottom) / 2) > 2) return false;
    const transform = getComputedStyle(flow.querySelector(".react-flow__viewport")).transform;
    if (window.lastFitSample?.transform !== transform) window.lastFitSample = { transform, since: performance.now() };
    return performance.now() - window.lastFitSample.since > 150;
  }, rows, { timeout: 10_000 });
  const automatic = await viewport(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(100);
  const manual = await viewport(page);
  assert.ok(Math.abs(automatic.x - manual.x) < 1 && Math.abs(automatic.y - manual.y) < 1 && Math.abs(automatic.zoom - manual.zoom) < 0.001,
    `automatic fit matches the Fit View button: ${JSON.stringify({ automatic, manual })}`);
}

for (const reducedMotion of ["no-preference", "reduce"]) {
  test(`Planner layouts settle centered at Fit View scale (${reducedMotion})`, { timeout: 35_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion });
    await context.addInitScript(() => localStorage.setItem("grapher_language_v1", "en"));
    const errors = [];
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const result = command === "list_files" ? { files: [] } : command === "list_skills" ? { skills: [] } : null;
      if (result === null) errors.push(`Unexpected API: ${command}`);
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    const nodes = ["a", "b", "c", "d"].map((name, i) => ({ name, task: `Task ${name}. ` + "Unequal measured card content. ".repeat(i + 1) }));
    const graph = edges => ({ originalGoal: "Viewport regression", nodes, edges: edges.map(([from, to]) => ({ from, to, feedback: false })) });
    const update = (patch, planning) => page.evaluate(({ patch, planning }) => window.graphFixture.update(patch, planning), { patch, planning });
    try {
      await page.goto(`${origin}/__graph-planning`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => !!window.graphFixture);
      await page.locator(".graph-pane").waitFor({ state: "attached" });
      // The pane mounts before the first node tool result arrives.
      assert.equal(await page.locator(".react-flow__node").count(), 0);
      await update({ runId: "planned-run", graph: graph([]) }, true);
      await assertFitted(page, [["a", "b", "c", "d"]]);

      // Finish in the same update that changes the layout. Fitting must wait
      // for the row-to-column interpolation and the approval footer to settle.
      await update({ graph: graph([["a", "b"], ["b", "c"], ["c", "d"]]), phase: "awaiting_approval" }, false);
      await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
      await assertFitted(page, [["a"], ["b"], ["c"], ["d"]]);

      // Rewire with identical node/edge counts: count-only effects miss this.
      await update({ graph: graph([["a", "b"], ["a", "c"], ["b", "d"]]) }, true);
      await assertFitted(page, [["a"], ["b", "c"], ["d"]]);
      // No geometry change at completion, but the footer changes canvas height.
      await update({}, false);
      await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
      await assertFitted(page, [["a"], ["b", "c"], ["d"]]);

      await update({ graph: { ...graph([]), nodes: nodes.slice(0, 1) } }, true);
      await assertFitted(page, [["a"]]);
      await update({}, false);
      await assertFitted(page, [["a"]]);

      // Once fitted, status/log updates must not undo the user's own zoom.
      await page.locator(".react-flow__controls-zoomout").click();
      const userView = await viewport(page);
      await update({ nodes: { a: { status: "running", revision: 1, head: null, instruction: "", error: null } },
        events: [{ sequence: 1, timestamp: 1, type: "started", node: "a" }] }, false);
      await page.waitForTimeout(350);
      assert.deepEqual(await viewport(page), userView);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
