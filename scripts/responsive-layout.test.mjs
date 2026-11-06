import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

// Mocked APIs exercise the real app while keeping the workspace untouched.
for (const reducedMotion of ["reduce", "no-preference"]) {
test(`desktop workbench adapts to available width and short windows (${reducedMotion})`, { timeout: 60_000 }, async () => {
  const repository = "/mock/responsive-project";
  const config = { repository, model: "test/model", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  // A full workspace list exercises the sidebar's short-window layout.
  const projects = [
    { id: repository, path: repository, name: "Project", lastOpened: 1 },
    ...Array.from({ length: 7 }, (_, index) => ({ id: `${repository}-${index}`, path: `${repository}-${index}`, name: `Project ${index}`, lastOpened: 1 })),
  ];
  const graph = { originalGoal: "Responsive layout test", nodes: [
    { name: "first", task: "Inspect the first task" },
    { name: "second", task: "Inspect the second task" },
  ], edges: [{ from: "first", to: "second", feedback: false }] };
  const snapshot = {
    runId: "responsive-run", config, planType: "graph", phase: "completed", approved: true, paused: false,
    graph, nodes: { first: { status: "completed" }, second: { status: "completed" } },
    plan: null, executions: [], events: [], base: "", feedbackCounts: {},
  };
  const empty = { ...snapshot, runId: "", config: null, phase: "draft", approved: false,
    graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {} };
  const repositoryInfo = { path: repository, name: "Project", branch: "main", head: "", clean: true };
  const errors = [];
  const server = await createServer({ cacheDir: "node_modules/.vite-responsive-layout",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", reducedMotion });
    await context.addInitScript(({ config, projects }) => {
      localStorage.setItem("grapher_language_v1", "en");
      localStorage.setItem("grapher_projects", JSON.stringify(projects));
      localStorage.setItem("grapher_config", JSON.stringify(config));
      localStorage.setItem("grapher_workbench_split_ratio", "0.15");
    }, { config, projects });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": case "save_config": result = { config, snapshot: empty, runs: [snapshot.runId], repositoryInfo, dataPath: "/mock/.grapher" }; break;
        case "history": case "snapshot": result = body.runId === snapshot.runId ? snapshot : empty; break;
        case "snapshot_if_changed": result = { version: "1", snapshot: body.runId === snapshot.runId ? snapshot : null }; break;
        case "repository_status": result = { repository, valid: true, error: null }; break;
        case "detect_repository": result = repositoryInfo; break;
        case "list_plannings": case "list_files": case "list_skills": result = command === "list_plannings" ? [] : command === "list_files" ? { files: [] } : { skills: [] }; break;
        case "provider_auth": result = { providers: [], models: [], warning: null }; break;
        case "pi_extensions": result = { globalDirectory: "/mock", extensions: [] }; break;
        case "environment_capabilities": result = { platform: "windows", arch: "x86_64", nativeWorkspace: true }; break;
        default: errors.push(`Unexpected API: ${command}`); result = null;
      }
      try { await route.fulfill({ json: { result } }); } catch { /* Navigation may abort a request. */ }
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle" });
    await page.locator(`[data-run-id="${snapshot.runId}"]`).click();
    await page.locator(".graph-canvas .react-flow__node").first().waitFor();
    const switcher = page.getByRole("group", { name: "Workbench view" });
    const conversation = switcher.getByRole("button", { name: "Conversation", exact: true });
    const graphButton = switcher.getByRole("button", { name: "Execution graph", exact: true });
    const composer = page.locator(".conversation-pane .pane-bottom-chat textarea");
    await composer.fill("Draft survives resizing");

    assert.equal(await switcher.isVisible(), false, "wide workspaces keep the split view");
    assert.ok((await page.locator(".conversation-pane").boundingBox()).width >= 279, "a stored small split does not crush the conversation");
    assert.ok((await page.locator(".graph-pane").boundingBox()).width >= 319, "the graph retains its minimum width");
    await page.locator(".plan-stats-row").waitFor();
    const stats = await page.locator(".plan-stats-row").evaluate(row => {
      const bounds = row.getBoundingClientRect();
      const cells = [...row.children].map(child => child.getBoundingClientRect());
      return { withinRow: cells.every(cell => cell.left >= bounds.left && cell.right <= bounds.right + 1),
        wraps: cells.at(-1).top > cells[0].top };
    });
    assert.equal(stats.withinRow && stats.wraps, true, "overview statistics wrap rather than overflow a narrow split");
    const storedRatio = await page.evaluate(() => localStorage.getItem("grapher_workbench_split_ratio"));

    // The graph canvas has its own sizing container. Both the workbench and
    // its children must still switch on the same outer stage at the exact
    // breakpoint, including the two pixels occupied by the workbench border.
    for (const width of [719, 720, 721, 722]) {
      await page.locator(".main-view-stage").evaluate((stage, width) => { stage.style.width = `${width}px`; }, width);
      await page.waitForFunction(width => document.querySelector(".main-view-stage").clientWidth === width, width);
      const layout = await page.evaluate(() => ({
        direction: getComputedStyle(document.querySelector(".workbench")).flexDirection,
        switcher: getComputedStyle(document.querySelector(".workbench-view-switcher")).display,
        splitter: getComputedStyle(document.querySelector(".workbench-resizer")).display,
        aperture: getComputedStyle(document.querySelector(".graph-pane-aperture")).position,
      }));
      assert.deepEqual(layout, width <= 720
        ? { direction: "column", switcher: "flex", splitter: "none", aperture: "absolute" }
        : { direction: "row", switcher: "none", splitter: "flex", aperture: "relative" },
      `the entire workbench switches together at stage width ${width}`);
    }
    await page.locator(".main-view-stage").evaluate(stage => stage.style.removeProperty("width"));

    await page.setViewportSize({ width: 900, height: 700 });
    await switcher.waitFor({ state: "visible" });
    assert.equal(await conversation.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".workbench-resizer").isVisible(), false);
    assert.equal(await page.locator(".graph-pane").isVisible(), false);
    assert.equal(await page.locator(".graph-canvas .react-flow__node").first().isVisible(), false,
      "React Flow's inline node visibility cannot expose the hidden graph");
    assert.ok((await page.locator(".conversation-pane").boundingBox()).width > 600);
    // Latest explicitly sets visibility and pointer events when active.
    await page.locator(".scroll-to-bottom-btn").evaluate(button => button.classList.add("visible"));
    await graphButton.click();
    assert.equal(await graphButton.getAttribute("aria-pressed"), "true");
    assert.equal(await composer.isVisible(), false);
    assert.equal(await page.locator(".scroll-to-bottom-btn").isVisible(), false,
      "conversation controls cannot show through the graph pane");
    await page.evaluate(() => { window.savedGraphCanvas = document.querySelector(".react-flow"); });
    await conversation.click();
    assert.equal(await composer.inputValue(), "Draft survives resizing");
    await graphButton.click();
    assert.equal(await page.evaluate(() => window.savedGraphCanvas === document.querySelector(".react-flow")), true,
      "switching panes retains the graph viewport rather than remounting it");
    await page.locator(".graph-canvas .react-flow__node[data-id='first']").click();
    assert.equal(await conversation.getAttribute("aria-pressed"), "true", "selecting a node returns to its conversation");
    assert.equal(await conversation.evaluate(button => button === document.activeElement), true);
    await page.locator(".back-to-query-btn").click();
    assert.equal(await composer.inputValue(), "Draft survives resizing");

    // Collapsing the sidebar makes enough room for both panes without changing
    // the saved split; expanding it again restores the one-pane controls.
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await switcher.waitFor({ state: "hidden" });
    await page.locator(".graph-pane").waitFor({ state: "visible" });
    assert.equal(await composer.inputValue(), "Draft survives resizing");
    assert.equal(await page.evaluate(() => localStorage.getItem("grapher_workbench_split_ratio")), storedRatio);
    await page.getByRole("separator", { name: "Resize execution graph" }).press("Enter");
    await page.getByRole("button", { name: "Expand execution graph" }).waitFor();
    await page.locator(".graph-pane").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await switcher.waitFor({ state: "visible" });
    assert.equal(await conversation.getAttribute("aria-pressed"), "true");
    await graphButton.click();
    await page.locator(".graph-canvas .react-flow__node[data-id='first']").waitFor();
    assert.equal(await graphButton.getAttribute("aria-pressed"), "true", "the switcher can reopen a graph collapsed on the wide layout");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await switcher.waitFor({ state: "hidden" });
    await composer.waitFor({ state: "visible" });
    await page.locator(".graph-pane").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await switcher.waitFor({ state: "visible" });
    assert.equal(await graphButton.getAttribute("aria-pressed"), "true", "the narrow view is retained across a resize");
    await conversation.click();
    assert.equal(await composer.inputValue(), "Draft survives resizing");

    // The canvas and settings footer must stay within a short desktop window.
    await page.setViewportSize({ width: 900, height: 420 });
    await graphButton.click();
    const geometry = await page.evaluate(() => {
      const canvas = document.querySelector(".graph-canvas").getBoundingClientRect();
      const bottom = document.querySelector(".graph-bottom").getBoundingClientRect();
      const workbench = document.querySelector(".workbench").getBoundingClientRect();
      return { canvasHeight: canvas.height, bottom: bottom.bottom, workbenchBottom: workbench.bottom, viewport: innerHeight };
    });
    assert.ok(geometry.canvasHeight > 80, `graph remains usable: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.bottom <= geometry.workbenchBottom && geometry.workbenchBottom <= geometry.viewport);
    const sidebarFit = await page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
      const footer = document.querySelector(".sidebar-bottom").getBoundingClientRect();
      const runs = document.querySelector(".runs-list").getBoundingClientRect();
      return { reachable: footer.top >= sidebar.top && footer.bottom <= sidebar.bottom,
        footer: footer.bottom, sidebar: sidebar.bottom, runsHeight: runs.height };
    });
    assert.equal(sidebarFit.reachable, true, `a full workspace list cannot hide the sidebar footer: ${JSON.stringify(sidebarFit)}`);

    // Below the single-pane breakpoint the sidebar starts as a rail and opens
    // over the workspace, so the conversation keeps the full available width.
    await page.setViewportSize({ width: 640, height: 700 });
    await page.waitForFunction(() => document.querySelector(".sidebar")?.classList.contains("is-collapsed"));
    await conversation.click();
    const composerFit = await page.evaluate(() => {
      const box = document.querySelector(".conversation-pane .prompt-box-container");
      const row = document.querySelector(".conversation-pane .prompt-box-actions-row");
      return { box: box.scrollWidth - box.clientWidth, row: row.scrollWidth - row.clientWidth };
    });
    assert.ok(composerFit.box <= 0 && composerFit.row <= 0, `narrow composer controls wrap instead of overflowing: ${JSON.stringify(composerFit)}`);
    const mainWidth = await page.locator(".main").evaluate(element => element.getBoundingClientRect().width);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    const overlay = await page.evaluate(() => ({
      position: getComputedStyle(document.querySelector(".sidebar")).position,
      main: document.querySelector(".main").getBoundingClientRect().width,
    }));
    assert.equal(overlay.position, "absolute", "the narrow sidebar opens as an overlay");
    assert.ok(overlay.main >= mainWidth, "opening the overlay must not squeeze the workspace");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();

    // Restore the expanded sidebar before testing the short desktop window.
    await page.setViewportSize({ width: 900, height: 420 });
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const modal = page.locator(".settings-modal");
    await modal.waitFor();
    const settings = await page.evaluate(() => {
      const modal = document.querySelector(".settings-modal").getBoundingClientRect();
      const footer = document.querySelector(".settings-modal-footer").getBoundingClientRect();
      return { top: modal.top, bottom: modal.bottom, footerBottom: footer.bottom, height: innerHeight };
    });
    assert.ok(settings.top >= 0 && settings.bottom <= settings.height && settings.footerBottom <= settings.height,
      `settings and its actions remain visible: ${JSON.stringify(settings)}`);
    const settingsScroll = page.locator(".settings-modal-content .settings-sections");
    assert.equal(await settingsScroll.evaluate(element => element.scrollHeight > element.clientHeight), true);
    await settingsScroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.ok(await settingsScroll.evaluate(element => element.scrollTop > 0));
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isVisible(), true);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser?.close();
    await server.close();
  }
});
}
