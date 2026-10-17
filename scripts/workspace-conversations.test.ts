import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, emptySnapshot, type Snapshot } from "../src/types.ts";
import { bindRunToWorkspace, mergeValidatedWorkspaceRuns, normalizeWorkspaceRuns, reconcileWorkspaceRuns, snapshotBelongsToWorkspace, workspaceKey } from "../src/services/workspaceConversations.ts";

const snapshot = (runId: string, repository: string): Snapshot => ({
  ...emptySnapshot, runId, config: { ...defaultConfig, repository },
});

test("Windows path aliases and UNC prefixes resolve to the same workspace", () => {
  assert.equal(workspaceKey("\\\\?\\C:\\Projects\\App\\"), workspaceKey("c:/projects/app"));
  assert.equal(workspaceKey("\\\\?\\UNC\\Server\\Share\\App"), workspaceKey("\\\\server\\share\\app\\"));
  assert.notEqual(workspaceKey("/work/App"), workspaceKey("/work/app"));
  assert.equal(workspaceKey("/"), "/");
});

test("legacy path keys merge without duplicate cards or default-workspace ownership", () => {
  assert.deepEqual(normalizeWorkspaceRuns({
    "C:\\Projects\\App": ["a", "b"], "\\\\?\\C:\\Projects\\App\\": ["b", "c"], default: ["foreign"],
  }), { "c:/projects/app": ["a", "b", "c"] });
});

test("a Run has exactly one workspace even when cached in multiple workspaces", () => {
  const original = { "/a": ["a", "b"], "/b": ["a", "b"] };
  const repaired = bindRunToWorkspace(original, "a", "/a");
  assert.deepEqual(repaired, { "/a": ["a", "b"], "/b": ["b"] });
  assert.deepEqual(original, { "/a": ["a", "b"], "/b": ["a", "b"] }, "must not mutate React state");
  assert.equal(bindRunToWorkspace(repaired, "a", "/a"), repaired, "repeated observations are stable");
});

test("detached planning replaces its provisional ID in the originating workspace", () => {
  assert.deepEqual(bindRunToWorkspace({ "/a": ["newer", "pending-1", "older"], "/b": ["b", "pending-1"] }, "real-a", "/a", "pending-1"), {
    "/a": ["newer", "real-a", "older"], "/b": ["b"],
  });
});

test("repeated detached completion events do not reorder an already replaced card", () => {
  const index = { "/a": ["newer", "real-a", "older"], "/b": ["b"] };
  assert.equal(bindRunToWorkspace(index, "real-a", "/a", "pending-1"), index);
});

test("bootstrap repairs already indexed foreign Runs and discovers missing histories", () => {
  const repaired = reconcileWorkspaceRuns({ "/a": ["a", "b", "pending-old"], "/b": ["a", "b"], default: ["unbound"] }, [
    snapshot("a", "/a"), snapshot("b", "/b"), snapshot("new-b", "/b"), snapshot("unbound", ""),
  ]);
  assert.deepEqual(repaired, { "/a": ["a"], "/b": ["new-b", "b"] });
});

test("cold bootstrap keeps the backend's newest-first order instead of reversing it", () => {
  assert.deepEqual(reconcileWorkspaceRuns({}, [snapshot("newest", "/a"), snapshot("middle", "/a"), snapshot("oldest", "/a")]), {
    "/a": ["newest", "middle", "oldest"],
  });
});

test("newly discovered Runs are inserted ahead of cached cards without reordering the cache", () => {
  assert.deepEqual(reconcileWorkspaceRuns({ "/a": ["cached-newer", "cached-older"] }, [
    snapshot("fresh-1", "/a"), snapshot("fresh-2", "/a"), snapshot("cached-newer", "/a"), snapshot("cached-older", "/a"),
  ]), { "/a": ["fresh-1", "fresh-2", "cached-newer", "cached-older"] });
});

test("unavailable history does not discard cached conversations; unbound histories cannot inherit a workspace", () => {
  assert.deepEqual(reconcileWorkspaceRuns({ "/a": ["offline", "unbound"] }, [null, snapshot("unbound", "")]), { "/a": ["offline"] });
  const original = { "/a": ["a"] };
  assert.equal(bindRunToWorkspace(original, "unbound", ""), original);
});

test("progressive validation keeps warm cards whose histories are not in the current batch", () => {
  const cached = { "/a": ["a", "b", "c", "d"] };
  const firstBatch = { "/a": ["a"] };
  assert.deepEqual(mergeValidatedWorkspaceRuns(cached, firstBatch), cached);
  // Only a later batch may speak for the cards it actually validated.
  assert.deepEqual(mergeValidatedWorkspaceRuns({ "/a": ["a", "b", "c", "d"] }, { "/a": ["a", "b"] }), { "/a": ["a", "b", "c", "d"] });
  assert.deepEqual(cached, { "/a": ["a", "b", "c", "d"] }, "must not mutate React state");
});

test("progressive validation moves a proven card without dropping unreported cards", () => {
  assert.deepEqual(mergeValidatedWorkspaceRuns({ "/a": ["a", "b"], "/b": ["b"] }, { "/b": ["b"] }), {
    "/a": ["a"], "/b": ["b"],
  });
  assert.deepEqual(mergeValidatedWorkspaceRuns({ "/a": ["cached"] }, { "/a": ["cached", "new"] }), {
    "/a": ["cached", "new"],
  });
});

test("opening a card validates snapshot ownership independently of the selected workspace", () => {
  assert.equal(snapshotBelongsToWorkspace(snapshot("a", "C:\\Projects\\A"), "\\\\?\\c:\\projects\\a\\"), true);
  assert.equal(snapshotBelongsToWorkspace(snapshot("a", "/a"), "/b"), false);
  assert.equal(snapshotBelongsToWorkspace(emptySnapshot, ""), false);
});
