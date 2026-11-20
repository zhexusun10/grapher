import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSummaryFromFiles,
  cacheFileChangeSummary,
  getCachedFileChangeSummary,
  invalidateFileChangeSummaryCache,
  mergeFileChangeSummaries,
} from "../src/services/fileChanges.ts";

test("file-change summary cache is run-scoped and invalidated per Run or globally", () => {
  const first = buildSummaryFromFiles([{ path: "src/a.ts", status: "added", additions: 1, deletions: 0 }]);
  const second = buildSummaryFromFiles([{ path: "src/b.ts", status: "modified", additions: 2, deletions: 1 }]);
  cacheFileChangeSummary("cache-test:scope-a", "cache-test", first);
  cacheFileChangeSummary("other-run:scope-a", "other-run", second);
  assert.equal(getCachedFileChangeSummary("cache-test:scope-a"), first);

  invalidateFileChangeSummaryCache("cache-test");
  assert.equal(getCachedFileChangeSummary("cache-test:scope-a"), undefined);
  assert.equal(getCachedFileChangeSummary("other-run:scope-a"), second);

  cacheFileChangeSummary("cache-test:scope-b", "cache-test", first);
  invalidateFileChangeSummaryCache();
  assert.equal(getCachedFileChangeSummary("cache-test:scope-b"), undefined);
  assert.equal(getCachedFileChangeSummary("other-run:scope-a"), undefined);
});

test("merging repeated attempts counts shared paths once", () => {
  const summary = buildSummaryFromFiles([
    { path: "src/shared.ts", status: "modified", additions: 1, deletions: 0, source: "git" },
  ]);
  const merged = mergeFileChangeSummaries([summary, summary]);
  assert.equal(merged.totalFiles, 1);
  assert.equal(merged.files.length, 1);
  assert.equal(merged.modifiedCount, 1);
});

test("a capped backend aggregate retains all authoritative counters", () => {
  const aggregate = buildSummaryFromFiles(Array.from({ length: 120 }, (_, index) => ({
    path: `src/file-${index}.ts`, status: "added" as const, additions: 2, deletions: 0,
  })));
  const capped = { ...aggregate, files: aggregate.files.slice(0, 60) };
  const merged = mergeFileChangeSummaries([null, capped]);
  assert.equal(merged.files.length, 60);
  assert.equal(merged.totalFiles, 120);
  assert.equal(merged.addedCount, 120);
  assert.equal(merged.totalAdditions, 240);
});

test("merging backend summaries keeps Git counts authoritative and unions nodes", () => {
  const agentSummary = buildSummaryFromFiles([
    { path: "docs/plan.md", status: "added", additions: 2, deletions: 0, nodes: ["planner"], source: "write" },
    { path: "src/api.ts", status: "added", additions: 1, deletions: 0, nodes: ["api_node"], source: "write" },
  ]);
  const gitSummary = buildSummaryFromFiles([
    { path: "docs/plan.md", status: "modified", additions: 5, deletions: 3, nodes: ["api_node"], source: "git" },
  ]);

  const merged = mergeFileChangeSummaries([agentSummary, gitSummary], false);
  assert.equal(merged.totalFiles, 2);
  assert.equal(merged.addedCount, 2, "a file created then edited in the run stays added");
  assert.equal(merged.modifiedCount, 0);

  const plan = merged.files.find((file) => file.path === "docs/plan.md")!;
  assert.equal(plan.additions, 5, "Git summary replaces tool-derived counts");
  assert.equal(plan.deletions, 3);
  assert.equal(plan.source, "git");
  assert.deepEqual(plan.nodes, ["planner", "api_node"]);
});
