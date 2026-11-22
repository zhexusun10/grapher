import assert from "node:assert/strict";
import { fixtureSummaries, fixtureFileChanges } from "./fixtures/current-api.mjs";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

let server, browser, origin;
const repository = "/search-workspace";
const config = {
  repository,
  model: "test/model",
  thinkingLevel: "off",
  maxParallel: 2,
  maxFeedback: 3,
  autoApprove: false,
};
const empty = {
  runId: "",
  config: null,
  phase: "draft",
  graph: { originalGoal: "", nodes: [], edges: [] },
  nodes: {},
  executions: [],
  events: [],
  mergers: [],
  plan: null,
  approved: false,
  paused: false,
  base: "",
  feedbackCounts: {},
};
const runOne = {
  ...empty,
  runId: "run-search-1",
  config,
  planType: "graph",
  phase: "completed",
  approved: true,
  graph: {
    originalGoal: "Optimize database queries",
    nodes: [{ id: "db-node", task: "Add composite index" }],
    edges: [],
  },
  nodes: {
    "db-node": { status: "completed", revision: 1, attempts: 1, head: "abc", error: null },
  },
  executions: [
    {
      id: "exec-db-1",
      node: "db-node",
      revision: 1,
      attempt: 1,
      sessionId: "sess-1",
      worktree: repository,
      before: "000",
      after: "abc",
      workspaceLineage: [],
      input: null,
      result: null,
      status: "completed",
      startedAt: 1000,
      completedAt: 2000,
      output: "",
      outputBytes: 0,
      pid: null,
      metrics: null,
    },
  ],
};
const runTwo = {
  ...empty,
  runId: "run-search-2",
  config,
  planType: "serial",
  phase: "completed",
  approved: true,
  graph: {
    originalGoal: "Fix sidebar layout",
    nodes: [{ id: "task", task: "Fix sidebar layout" }],
    edges: [],
  },
};
const runArchived = {
  ...empty,
  runId: "run-search-archived",
  config,
  planType: "serial",
  phase: "completed",
  approved: true,
  graph: {
    originalGoal: "Archived legacy migration",
    nodes: [{ id: "task", task: "Archived legacy migration" }],
    edges: [],
  },
};
const runsById = {
  [runOne.runId]: runOne,
  [runTwo.runId]: runTwo,
  [runArchived.runId]: runArchived,
};
const bootstrap = {
  config,
  snapshot: runTwo,
  runs: [runTwo.runId, runOne.runId, runArchived.runId],
  conversations: fixtureSummaries([runTwo, runOne, runArchived]),
  repositoryInfo: { path: repository, name: "SearchWorkspace", branch: "main", clean: true, head: "" },
  dataPath: "/mock",
  envOverrides: {},
};
const catalog = {
  providers: [{ id: "test", name: "Test", methods: [], configured: true }],
  warning: null,
  models: [
    {
      provider: "test",
      id: "model",
      name: "Model",
      api: "mock",
      available: true,
      contextWindow: 1000,
      thinkingLevels: ["off"],
      thinkingLevelFallbacks: {},
    },
  ],
};

before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-workspace-search",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"),
    headless: true,
  });
});

after(async () => {
  await browser?.close();
  server?.httpServer?.closeAllConnections?.();
  await server?.close();
});

async function openSearchHarness({ failSearch = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    reducedMotion: "reduce",
  });
  const searchRequests = [];
  const errors = [];

  await context.addInitScript(({ repository, archivedId }) => {
    localStorage.setItem("grapher_language_v1", "en");
    localStorage.setItem("grapher_data_path", "/mock");
    localStorage.setItem(
      "grapher_projects",
      JSON.stringify([{ id: repository, path: repository, name: "SearchWorkspace", lastOpened: 1 }]),
    );
    localStorage.setItem("grapher-format-1:/mock:grapher_archived_runs", JSON.stringify([archivedId]));
  }, { repository, archivedId: runArchived.runId });

  await context.route("**/api/*", async (route) => {
    const command = new URL(route.request().url()).pathname.slice(5);
    if (command === "events") {
      return route.abort("failed");
    }
    const body = route.request().postDataJSON();
    if (command === "search_conversations") {
      if (body.warm) {
        return route.fulfill({
          json: {
            result: { query: "", matches: [], totalMatches: 0, matchedConversations: 0, truncated: false },
          },
        });
      }
      searchRequests.push(body);
      if (failSearch) {
        return route.fulfill({ status: 500, json: { error: "Search index unavailable" } });
      }
      const query = body.query;
      const matches =
        query === "nomatch"
          ? []
          : query === "archived"
            ? [
                {
                  runId: runArchived.runId,
                  conversationTitle: "Archived legacy migration",
                  planType: "serial",
                  role: "user",
                  sourceKind: "serial",
                  snippetBefore: "",
                  snippetMatch: query,
                  snippetAfter: "",
                  timestamp: 1500,
                },
              ]
            : [
                {
                  runId: runTwo.runId,
                  conversationTitle: "Fix sidebar layout",
                  planType: "serial",
                  role: "user",
                  sourceKind: "serial",
                  snippetBefore: "Fix ",
                  snippetMatch: query,
                  snippetAfter: " alignment",
                  timestamp: 3000,
                },
                {
                  runId: runOne.runId,
                  conversationTitle: "Optimize database queries",
                  planType: "graph",
                  role: "assistant",
                  sourceKind: "node",
                  node: "db-node",
                  executionId: "exec-db-1",
                  snippetBefore: "Added ",
                  snippetMatch: query,
                  snippetAfter: " on users table",
                  timestamp: 2000,
                },
              ];
      return route.fulfill({
        json: {
          result: {
            query,
            matches,
            totalMatches: matches.length,
            matchedConversations: matches.length,
            truncated: false,
          },
        },
      });
    }
    if (command === "snapshot" && body?.runId && runsById[body.runId]) {
      return route.fulfill({ json: { result: runsById[body.runId] } });
    }
    const defaults = {
      bootstrap,
      history: runTwo,
      snapshot: runTwo,
      load_run: runTwo,
      get_execution_output: {
        runId: body?.runId || runOne.runId,
        executionId: body?.executionId || "exec-db-1",
        content: "",
        startOffset: 0,
        nextOffset: 0,
        totalBytes: 0,
        complete: true,
        status: "completed",
      },
      get_file_changes: fixtureFileChanges(body),
      extension_command: { instance: "standalone", commands: [] },
      snapshot_if_changed: { version: "fixed", snapshot: null },
      repository_status: { repository, valid: true, error: null },
      list_plannings: [],
      list_files: { files: [] },
      list_skills: { skills: [] },
      provider_auth: catalog,
      pi_extensions: { globalDirectory: "mock", extensions: [] },
      environment_capabilities: { platform: "darwin", arch: "arm64", nativeWorkspace: true },
    };
    return route.fulfill({ json: { result: defaults[command] ?? null } });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator(".sidebar").waitFor();
  return { context, page, searchRequests, errors };
}

test("Cmd+G / Ctrl+G toggles minimalist search, flushes Enter during debounce, and opens matched conversation", { timeout: 30_000 }, async () => {
  const { context, page, searchRequests, errors } = await openSearchHarness();
  const modal = page.locator(".workspace-search-modal");
  const input = modal.locator(".workspace-search-input");
  const options = modal.locator('[role="option"]');

  try {
    // Open with Meta+g -> compact input-only state (no listbox until query is typed)
    await page.keyboard.press("Meta+g");
    await modal.waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains("workspace-search-input"));
    assert.equal(await modal.locator('[role="listbox"]').count(), 0);
    assert.equal(await modal.locator("footer").count(), 0);

    // Toggle closed with Meta+g, reopen with Control+g, close with Escape
    await page.keyboard.press("Meta+g");
    await modal.waitFor({ state: "detached" });
    await page.keyboard.press("Control+g");
    await modal.waitFor();
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });

    // Reopen via sidebar button and search
    await page.getByRole("button", { name: "Search workspace conversations (⌘G / Ctrl+G)" }).click();
    await modal.waitFor();
    await input.fill("index");
    await options.nth(1).waitFor();
    assert.equal(await options.count(), 2);
    assert.equal(searchRequests.at(-1)?.repository, repository);
    assert.equal(searchRequests.at(-1)?.query, "index");
    assert.equal(await options.nth(0).locator(".workspace-search-item-title").textContent(), "Fix sidebar layout");
    assert.equal(await options.nth(0).locator("mark.workspace-search-highlight").textContent(), "index");
    assert.equal(await options.nth(1).locator(".workspace-search-item-title").textContent(), "Optimize database queries");
    assert.equal(await options.nth(1).locator(".workspace-search-item-snippet").textContent(), "Added index on users table");

    // Verify items stay left-aligned inside the modal card with no horizontal overflow
    const geometry = await modal.evaluate((el) => {
      const card = el.getBoundingClientRect();
      const item = el.querySelector(".workspace-search-item").getBoundingClientRect();
      const head = el.querySelector(".workspace-search-item-head").getBoundingClientRect();
      const snippet = el.querySelector(".workspace-search-item-snippet").getBoundingClientRect();
      const results = el.querySelector(".workspace-search-results");
      return {
        cardLeft: card.left,
        cardRight: card.right,
        itemLeft: item.left,
        itemRight: item.right,
        headLeft: head.left,
        headRight: head.right,
        snippetLeft: snippet.left,
        snippetRight: snippet.right,
        horizontalOverflow: results.scrollWidth - results.clientWidth,
      };
    });
    assert.ok(geometry.itemLeft >= geometry.cardLeft && geometry.itemRight <= geometry.cardRight + 1, JSON.stringify(geometry));
    assert.ok(geometry.headLeft - geometry.itemLeft <= 16, `expected left-aligned title row: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.headRight <= geometry.cardRight + 1 && geometry.snippetRight <= geometry.cardRight + 1, JSON.stringify(geometry));
    assert.equal(geometry.horizontalOverflow, 0, JSON.stringify(geometry));

    // Clear button resets query, collapses results, and keeps focus in input
    await modal.getByRole("button", { name: "Clear search" }).click();
    assert.equal(await input.inputValue(), "");
    assert.equal(await modal.locator('[role="listbox"]').count(), 0);
    await page.waitForFunction(() => document.activeElement?.classList.contains("workspace-search-input"));

    // Typing a new query and immediately pressing Enter during debounce
    // flushes the new query instead of navigating to a stale result
    await input.fill("index");
    await options.nth(1).waitFor();
    await input.fill("nomatch");
    await page.keyboard.press("Enter");
    await modal.getByText("No matching conversations").waitFor();
    assert.equal(searchRequests.at(-1)?.query, "nomatch");
    assert.equal(await modal.count(), 1);

    // Select second conversation via keyboard ArrowDown + Enter
    await input.fill("index");
    await options.nth(1).waitFor();
    await input.focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await options.nth(1).getAttribute("aria-selected"), "true");
    await page.keyboard.press("Enter");
    await modal.waitFor({ state: "detached" });
    await page.locator('[data-run-id="run-search-1"].chosen').waitFor();

    // Archived conversation is tagged and opens directly on click
    await page.keyboard.press("Meta+g");
    await modal.waitFor();
    await input.fill("archived");
    await options.first().waitFor();
    assert.equal(await options.first().locator(".workspace-search-item-tag").textContent(), "Archived");
    await options.first().click();
    await modal.waitFor({ state: "detached" });

    // Cmd+G does not hijack when Settings modal is open
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".settings-modal").waitFor();
    await page.keyboard.press("Meta+g");
    assert.equal(await modal.count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("workspace search surfaces backend failures cleanly as an alert", { timeout: 30_000 }, async () => {
  const { context, page, errors } = await openSearchHarness({ failSearch: true });
  const modal = page.locator(".workspace-search-modal");

  try {
    await page.keyboard.press("Meta+g");
    await modal.waitFor();
    await modal.locator(".workspace-search-input").fill("anything");
    await modal.getByRole("alert").filter({ hasText: "Search index unavailable" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
