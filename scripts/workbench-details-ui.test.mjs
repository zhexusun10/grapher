import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

async function assertOverviewVerticalSpacing(page) {
  const spacing = await page.locator(".plan-summary-card").evaluate(card => {
    const bounds = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    const header = card.querySelector(".plan-summary-header").getBoundingClientRect();
    const publication = card.querySelector(".pub-card-body");
    const contentBottom = publication
      ? publication.lastElementChild.getBoundingClientRect().bottom
      : Math.max(...[...card.querySelectorAll(".node-chip")].map(chip => chip.getBoundingClientRect().bottom));
    return { top: header.top - bounds.top - parseFloat(style.borderTopWidth),
      bottom: bounds.bottom - parseFloat(style.borderBottomWidth) - contentBottom };
  });
  assert.ok(Math.abs(spacing.top - spacing.bottom) < 1,
    `overview content has equal top and bottom spacing: ${JSON.stringify(spacing)}`);
}

for (const [language, reducedMotion] of [["en", "no-preference"], ["zh-CN", "reduce"]]) {
  test(`workbench keeps long names and actions usable (${language}, ${reducedMotion})`, { timeout: 60_000 }, async () => {
    const repository = "/mock/workbench-details";
    const config = { repository, model: "test/model", maxParallel: 2, maxFeedback: 3, autoApprove: false };
    const longName = "inspect_" + "workbench_layout_and_interaction_details_".repeat(8);
    const graph = { originalGoal: "Workbench details", nodes: [
      { name: longName, task: "Inspect the layout" }, { name: "verify", task: "Verify the interactions" },
    ], edges: [{ from: longName, to: "verify", feedback: false }] };
    const completed = { runId: "details-completed", config, planType: "graph", phase: "completed", approved: true, paused: false,
      graph, nodes: { [longName]: { status: "completed" }, verify: { status: "completed" } },
      plan: null, executions: [], events: [], base: "", feedbackCounts: {} };
    const snapshots = {
      "details-completed": completed,
      "details-approval": { ...completed, runId: "details-approval", phase: "awaiting_approval", approved: false,
        nodes: { [longName]: { status: "completed" }, verify: { status: "waiting" } } },
      "details-followup": { ...completed, runId: "details-followup", phase: "followup" },
    };
    const empty = { ...completed, runId: "", config: null, phase: "draft", approved: false,
      graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {} };
    const repositoryInfo = { path: repository, name: "Project", branch: "main", head: "", clean: true };
    const labels = language === "en" ? {
      create: "New node", cancel: "Cancel node creation", back: "Back to Planner conversation",
      progress: "Node completion progress", approve: "Approve", reject: "Reject", name: "Name (name)",
    } : {
      create: "新建节点", cancel: "取消新建节点", back: "返回规划对话",
      progress: "节点完成进度", approve: "批准", reject: "拒绝", name: "名称 (name)",
    };
    const errors = [];
    const server = await createServer({ cacheDir: "node_modules/.vite-workbench-details",
      server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false } });
    let browser;
    try {
      await server.listen();
      browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"), headless: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: language, reducedMotion });
      await context.addInitScript(({ repository, config, language }) => {
        localStorage.setItem("grapher_language_v1", language);
        localStorage.setItem("grapher_projects", JSON.stringify([{ id: repository, path: repository, name: "Project", lastOpened: 1 }]));
        localStorage.setItem("grapher_config", JSON.stringify(config));
        localStorage.setItem("grapher_workbench_split_ratio", "0.15");
      }, { repository, config, language });
      await context.route("**/api/*", async route => {
        const command = new URL(route.request().url()).pathname.slice(5);
        const body = route.request().postDataJSON();
        let result;
        switch (command) {
          case "bootstrap": result = { config, snapshot: empty, runs: Object.keys(snapshots), repositoryInfo, dataPath: "/mock" }; break;
          case "history": case "snapshot": result = snapshots[body.runId] || empty; break;
          case "snapshot_if_changed": result = { version: "1", snapshot: null }; break;
          case "repository_status": result = { repository, valid: true, error: null }; break;
          case "detect_repository": result = repositoryInfo; break;
          case "list_plannings": result = []; break;
          case "list_files": result = { files: [] }; break;
          case "list_skills": result = { skills: [] }; break;
          case "provider_auth": result = { providers: [], models: [], warning: null }; break;
          default: errors.push(`Unexpected API: ${command}`); result = null;
        }
        try { await route.fulfill({ json: { result } }); } catch { /* Navigation may cancel a poll. */ }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12_000);
      page.on("pageerror", error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle" });
      await page.locator('[data-run-id="details-completed"]').click();
      const chip = page.getByRole("button", { name: longName, exact: true });
      await chip.waitFor();
      await assertOverviewVerticalSpacing(page);
      await chip.hover();
      assert.equal(await chip.getAttribute("title"), null, "overview nodes do not show native hover tags");
      assert.equal(await chip.locator("[title], [role='tooltip']").count(), 0,
        "overview node content stays tooltip-free while retaining its full accessible name");
      const chipFits = await chip.evaluate(button => {
        const bounds = button.getBoundingClientRect();
        const list = button.closest(".nodes-chips").getBoundingClientRect();
        return bounds.left >= list.left && bounds.right <= list.right + 1;
      });
      assert.equal(chipFits, true, "an unbroken node name cannot overflow the overview in a 280px conversation");
      await chip.click();
      const heading = page.getByRole("heading", { name: longName, exact: true });
      await heading.waitFor();
      assert.equal(await heading.getAttribute("title"), longName);
      const back = page.getByRole("button", { name: labels.back, exact: true });
      const headingBounds = await heading.boundingBox(), backBounds = await back.boundingBox();
      assert.ok(headingBounds.x + headingBounds.width <= backBounds.x,
        "the long heading leaves the back button unobscured");
      await back.click();
      await chip.waitFor();
      const progress = page.getByRole("progressbar", { name: labels.progress });
      assert.equal(await progress.getAttribute("aria-valuemin"), "0");
      assert.equal(await progress.getAttribute("aria-valuemax"), "2");
      assert.equal(await progress.getAttribute("aria-valuenow"), "2");

      assert.equal(await page.locator(".graph-toolbar").getByRole("button", { name: labels.create, exact: true }).count(), 0,
        "node creation stays in the existing background menu, not the toolbar");
      const create = page.getByRole("menuitem", { name: labels.create, exact: true });
      const openMenu = async () => {
        await page.locator(".react-flow__pane").click({ button: "right", position: { x: 12, y: 12 } });
        await create.waitFor();
      };
      await openMenu();
      await create.focus();
      await create.press("Enter");
      await page.locator(".create-node-form").waitFor();
      assert.equal(await page.getByRole("textbox", { name: labels.name, exact: true }).evaluate(input => input === document.activeElement), true,
        "keyboard activation moves focus to the new node name");
      await page.getByRole("button", { name: labels.cancel }).click();

      await page.locator('[data-run-id="details-approval"]').click();
      await page.getByRole("button", { name: labels.approve, exact: true }).waitFor();
      await assertOverviewVerticalSpacing(page);
      assert.equal(await page.getByRole("button", { name: labels.reject, exact: true }).isVisible(), true,
        "both approval actions use the selected language");
      await openMenu();
      assert.equal(await create.isEnabled(), true, "unapproved plans still allow manual nodes");
      await page.keyboard.press("Escape");
      assert.equal(await progress.getAttribute("aria-valuenow"), "1", "progress updates when the conversation changes");

      // Narrow the graph itself, then exercise enlarged status copy without
      // hiding any of the approval actions or stealing the canvas's height.
      await page.getByRole("separator").press("End");
      await page.locator(".approval-row > span").evaluate(status => {
        status.style.fontSize = "18px";
        status.textContent = "A_long_translated_runtime_status_".repeat(4);
      });
      const footerFit = await page.locator(".graph-bottom").evaluate(footer => {
        const bounds = footer.getBoundingClientRect();
        const status = footer.querySelector(".approval-row > span").getBoundingClientRect();
        const actions = [...footer.querySelectorAll("button")].map(button => button.getBoundingClientRect());
        return footer.scrollWidth <= footer.clientWidth && actions.every(action =>
          action.left >= bounds.left && action.right <= bounds.right && action.bottom <= bounds.bottom &&
          (action.left >= status.right || action.top >= status.bottom));
      });
      assert.equal(footerFit, true, "long status copy wraps without overflowing or covering approval actions");

      await page.setViewportSize({ width: 900, height: 700 });
      const graphSwitch = page.locator(".workbench-view-switcher button").nth(1);
      await graphSwitch.click();
      await openMenu();
      await create.focus();
      await create.press("Enter");
      await page.locator(".create-node-form").waitFor();
      assert.equal(await page.locator(".workbench-view-switcher button").first().getAttribute("aria-pressed"), "true",
        "creating a node from the narrow graph brings its form into view");
      assert.equal(await page.getByRole("textbox", { name: labels.name, exact: true }).isVisible(), true);
      await page.getByRole("button", { name: labels.cancel }).click();
      await page.locator('[data-run-id="details-followup"]').click();
      await graphSwitch.click();
      await openMenu();
      assert.equal(await create.isDisabled(), true, "direct-source follow-up cannot add graph nodes");
      await page.keyboard.press("Escape");
      await page.locator(".workbench-view-switcher button").first().click();
      await page.setViewportSize({ width: 500, height: 700 });
      await chip.waitFor();
      await assertOverviewVerticalSpacing(page);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
    }
  });
}
