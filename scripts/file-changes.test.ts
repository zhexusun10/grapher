import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSummaryFromFiles,
  filterFileChanges,
  mergeFileChangeSummaries,
  splitFilePath,
} from "../src/services/fileChanges.ts";

test("splitFilePath separates the file name and its directory", () => {
  assert.deepEqual(splitFilePath("src/components/changes/WorkspaceChangesPanel.tsx"), {
    fileName: "WorkspaceChangesPanel.tsx",
    dirPath: "src/components/changes",
  });
  assert.deepEqual(splitFilePath("README.md"), { fileName: "README.md", dirPath: "" });
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

  assert.equal(filterFileChanges(merged.files, "added").length, 2);
  assert.equal(filterFileChanges(merged.files, "all", "api").length, 1);
  assert.equal(filterFileChanges(merged.files, "all", "", "api_node").length, 2);
});
