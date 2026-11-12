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

    // The workspace viewport ends at a card boundary at different heights;
    // overflowing cards remain scrollable without showing a clipped card.
    for (const height of [800, 700, 600, 500, 420]) {
      await page.setViewportSize({ width: 1280, height });
      await page.waitForTimeout(400);
      const workspace = await page.locator(".projects-list").evaluate(list => {
        const cards = [...list.querySelectorAll(".project-workspace-item")];
        const bounds = list.getBoundingClientRect();
        const visible = cards.filter(card => card.getBoundingClientRect().bottom <= bounds.bottom + 0.5);
        const last = visible.at(-1)?.getBoundingClientRect();
        return { height: bounds.height, visible: visible.length, bottomGap: last ? bounds.bottom - last.bottom : null,
          scrollable: list.scrollHeight > list.clientHeight };
      });
      assert.ok(workspace.visible >= 1 && Math.abs(workspace.bottomGap) < 1,
        `workspace ends after a whole card at height ${height}: ${JSON.stringify(workspace)}`);
      assert.equal(workspace.scrollable, true, "additional workspaces remain scrollable");
      if (height === 800) {
        assert.equal(workspace.visible, 4, "four workspaces fit at desktop height");
        const exactFit = await page.locator(".projects-list").evaluate(list => {
          const extra = [...list.querySelectorAll(".project-workspace-item")].slice(4);
          extra.forEach(card => { card.style.display = "none"; });
          const fits = list.scrollHeight <= list.clientHeight;
          extra.forEach(card => { card.style.removeProperty("display"); });
          return fits;
        });
        assert.equal(exactFit, true, "four cards do not trigger workspace scrolling");
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    // Compare the actual card with a non-clipping reference at the same pixel
    // position. Descenders must survive the overflow needed for ellipsis.
    const card = page.locator(".project-workspace-item").first();
    const title = card.locator(".proj-name-row strong");
    await title.evaluate(element => {
      element.textContent = "RSI-Agent";
      // Exercise a taller font as well as the platform's default font metrics.
      element.style.fontSize = "16px";
    });
    const glyphClip = await title.evaluate(element => {
      const range = document.createRange();
      range.setStart(element.firstChild, 5);
      range.setEnd(element.firstChild, 6);
      const glyph = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const x = Math.floor(glyph.left), y = Math.floor(box.top) - 2;
      return { x, y, width: Math.ceil(glyph.right) - x, height: Math.ceil(box.bottom) - y + 2 };
    });
    const clipped = await page.screenshot({ clip: glyphClip, animations: "disabled" });
    await title.evaluate(element => { element.style.overflow = "visible"; });
    const unclipped = await page.screenshot({ clip: glyphClip, animations: "disabled" });
    assert.ok(clipped.equals(unclipped), "workspace title descenders are not clipped by the ellipsis box");
    await title.evaluate(element => {
      element.style.removeProperty("overflow");
      element.style.removeProperty("font-size");
      element.textContent = "A very long workspace title with descenders gyp ".repeat(3);
    });
    const titleLayout = await card.evaluate(element => {
      const title = element.querySelector(".proj-name-row strong");
      const path = element.querySelector(".proj-path-text");
      return { truncated: title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === "ellipsis",
        separated: title.getBoundingClientRect().bottom <= path.getBoundingClientRect().top,
        withinCard: path.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom };
    });
    assert.deepEqual(titleLayout, { truncated: true, separated: true, withinCard: true },
      "long titles still truncate without overlapping the path or card edge");
    await title.evaluate(element => { element.textContent = "Project"; });
    assert.equal(await switcher.isVisible(), false, "wide workspaces keep the split view");
    assert.ok((await page.locator(".conversation-pane").boundingBox()).width >= 279, "a stored small split does not crush the conversation");
    assert.ok((await page.locator(".graph-pane").boundingBox()).width >= 319, "the graph retains its minimum width");
    await page.locator(".plan-summary-stats").waitFor();
    const stats = await page.locator(".plan-summary-stats").evaluate(row => {
      const bounds = row.getBoundingClientRect();
      const cells = [...row.children].map(child => child.getBoundingClientRect());
      return { withinRow: cells.every(cell => cell.left >= bounds.left && cell.right <= bounds.right + 1),
        wraps: cells.at(-1).top > cells[0].top };
    });
    assert.equal(stats.withinRow && stats.wraps, true, "overview statistics wrap rather than overflow a narrow split");
    const dividers = await page.locator(".plan-batches-list").evaluate(list => {
      const bounds = list.getBoundingClientRect();
      const rule = getComputedStyle(list, "::before");
      const rows = [...list.children];
      const nodeList = list.closest(".plan-nodes-list");
      const publication = nodeList.nextElementSibling;
      return {
        continuous: rule.position === "absolute" && rule.top === "0px" && rule.bottom === "0px"
          && rule.width === "1px" && Math.abs(parseFloat(rule.height) - bounds.height) < 1,
        aligned: rule.gridColumnStart === "2" && rule.left === "0px" && rows.every(row => {
          const label = row.querySelector(".plan-batch-label").getBoundingClientRect();
          const chips = row.querySelector(".nodes-chips").getBoundingClientRect();
          return Math.abs(label.right - chips.left) < 1
            && Math.abs(chips.left - rows[0].querySelector(".nodes-chips").getBoundingClientRect().left) < 1;
        }),
        joinedRows: rows.slice(1).every((row, index) => {
          const rect = row.getBoundingClientRect();
          return Math.abs(rect.top - rows[index].getBoundingClientRect().bottom) < 1
            && rect.left === bounds.left && rect.right === bounds.right
            && getComputedStyle(row).borderTopWidth === "1px";
        }),
        joinsHeader: Math.abs(bounds.top - nodeList.getBoundingClientRect().top
          - parseFloat(getComputedStyle(nodeList).borderTopWidth)) < 1,
        joinsPublication: Math.abs(publication.getBoundingClientRect().top - bounds.bottom) < 1,
        nonInteractive: rule.pointerEvents === "none",
        uniformStroke: rule.borderLeftWidth === "1px" && rule.borderLeftStyle === "solid"
          && [nodeList, ...rows.slice(1), publication].every(element => {
            const horizontal = getComputedStyle(element);
            return horizontal.borderTopWidth === rule.borderLeftWidth
              && horizontal.borderTopColor === rule.borderLeftColor;
          }),
      };
    });
    assert.deepEqual(dividers, { continuous: true, aligned: true, joinedRows: true,
      joinsHeader: true, joinsPublication: true, nonInteractive: true, uniformStroke: true },
    "overview dividers span the batch area and meet adjacent rules without gaps");
    // Exercise label widths without changing the mocked run or its graph layout.
    const labelLayouts = await page.locator(".plan-batches-list").evaluate(list => {
      const rows = [...list.children];
      const labels = rows.map(row => row.querySelector(".plan-batch-label"));
      const original = labels.map(label => label.textContent);
      try {
        return [["批次 1", "批次 2"], ["批次 9", "批次 10"],
          ["Batch 9", "Batch 10"], ["Batch 99", "Batch 100"]].map(texts => {
          labels.forEach((label, index) => { label.textContent = texts[index]; });
          const bounds = list.getBoundingClientRect();
          const cells = rows.map((row, index) => {
            const range = document.createRange();
            range.selectNodeContents(labels[index]);
            const chips = row.querySelector(".nodes-chips").getBoundingClientRect();
            return { left: chips.left, gap: chips.left - range.getBoundingClientRect().right,
              fits: [...row.querySelectorAll(".node-chip")].every(chip => chip.getBoundingClientRect().right <= bounds.right + 1) };
          });
          const vertical = getComputedStyle(list, "::before");
          const horizontal = getComputedStyle(rows[1]);
          return { texts, width: cells[0].left - bounds.left,
            separated: cells.every(cell => cell.gap >= 11.5),
            aligned: cells.every(cell => Math.abs(cell.left - cells[0].left) < 1),
            fits: cells.every(cell => cell.fits),
            uniformStroke: vertical.borderLeftWidth === "1px" && vertical.borderLeftStyle === "solid"
              && vertical.borderLeftWidth === horizontal.borderTopWidth
              && vertical.borderLeftColor === horizontal.borderTopColor };
        });
      } finally {
        labels.forEach((label, index) => { label.textContent = original[index]; });
      }
    });
    for (const layout of labelLayouts) {
      assert.ok(layout.separated && layout.aligned && layout.fits && layout.uniformStroke,
        `batch labels retain padding beside a continuous, uniformly thin divider: ${JSON.stringify(layout)}`);
    }
    assert.ok(labelLayouts[1].width > labelLayouts[0].width && labelLayouts[3].width > labelLayouts[2].width,
      "the shared label column grows with two- and three-digit batch numbers");
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
