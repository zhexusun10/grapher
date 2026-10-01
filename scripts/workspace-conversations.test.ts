import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, emptySnapshot, type Snapshot } from "../src/types.ts";
import { bindRunToWorkspace, normalizeWorkspaceRuns, reconcileWorkspaceRuns, snapshotBelongsToWorkspace, workspaceKey } from "../src/services/workspaceConversations.ts";

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

test("unavailable history does not discard cached conversations; unbound histories cannot inherit a workspace", () => {
  assert.deepEqual(reconcileWorkspaceRuns({ "/a": ["offline", "unbound"] }, [null, snapshot("unbound", "")]), { "/a": ["offline"] });
  const original = { "/a": ["a"] };
  assert.equal(bindRunToWorkspace(original, "unbound", ""), original);
});

test("opening a card validates snapshot ownership independently of the selected workspace", () => {
  assert.equal(snapshotBelongsToWorkspace(snapshot("a", "C:\\Projects\\A"), "\\\\?\\c:\\projects\\a\\"), true);
  assert.equal(snapshotBelongsToWorkspace(snapshot("a", "/a"), "/b"), false);
  assert.equal(snapshotBelongsToWorkspace(emptySnapshot, ""), false);
});
