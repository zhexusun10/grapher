import assert from "node:assert/strict";
import test from "node:test";
import { readStorageJson, readStorageString, STORAGE_KEYS, writeStorageJson } from "../src/services/appStorage.ts";

function withStorage(work: (values: Map<string, string>) => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try { work(values); }
  finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("stored projects discard corrupt entries but preserve explicit empty lists and recoverable paths", () => withStorage(values => {
  const key = STORAGE_KEYS.projects;
  for (const value of [null, {}, "old", [null, 42, { path: 7 }]]) {
    values.set(key, JSON.stringify(value));
    assert.equal(readStorageJson(key), null);
  }
  values.set(key, "[]");
  assert.deepEqual(readStorageJson(key), [], "an intentionally empty sidebar must not restore removed workspaces");
  values.set(key, JSON.stringify([null, { path: "\\\\?\\C:\\repo", name: {}, id: 42, lastOpened: "new", branch: null },
    { path: "/good", id: "/good", name: "Good", branch: "main", clean: true, lastOpened: 123 }]));
  assert.deepEqual(readStorageJson(key), [
    { path: "C:\\repo", id: "C:\\repo", name: "repo", branch: "", clean: false, lastOpened: 0 },
    { path: "/good", id: "/good", name: "Good", branch: "main", clean: true, lastOpened: 123 },
  ]);
}));

test("valid stored settings and workspace identities survive decoding unchanged", () => withStorage(values => {
  const settings = { repository: "/repo", model: "test/default", thinkingLevel: "high", maxParallel: 4, maxFeedback: 3,
    feedbackEnabled: false, autoApprove: false, postTaskReview: true, plannerWriteTools: false, isolateParallelNodes: true,
    roleModels: { planner: { model: "test/planner", thinkingLevel: "off" }, nodeAgent: { model: "test/node" } } };
  writeStorageJson(STORAGE_KEYS.config, settings);
  assert.deepEqual(readStorageJson(STORAGE_KEYS.config), settings);
  const project = { id: "retained-card-id", path: "/repo", name: "Repo", branch: "main", clean: true, isShadow: false, lastOpened: 100 };
  values.set(STORAGE_KEYS.projects, JSON.stringify([project]));
  assert.deepEqual(readStorageJson(STORAGE_KEYS.projects), [project]);
}));

test("stored settings retain valid fields instead of trusting wrong scalar or nested types", () => withStorage(values => {
  values.set(STORAGE_KEYS.config, JSON.stringify({ repository: null, model: "test/model", thinkingLevel: "unsupported",
    maxParallel: 4, maxFeedback: "many", feedbackEnabled: false, autoApprove: "no", roleModels: {
      planner: { model: "test/planner", thinkingLevel: "high" }, nodeAgent: { model: 5 }, partitioner: null,
    } }));
  assert.deepEqual(readStorageJson(STORAGE_KEYS.config), { model: "test/model", maxParallel: 4, feedbackEnabled: false,
    roleModels: { planner: { model: "test/planner", thinkingLevel: "high" } } });
}));

test("stored conversation indexes reject invalid shapes and retain only renderable values", () => withStorage(values => {
  values.set(STORAGE_KEYS.workspaceRuns, JSON.stringify({ "/repo": ["run", null, 3], "/invalid": "run" }));
  values.set(STORAGE_KEYS.runLabels, JSON.stringify({ run: "Saved title", corrupt: { title: "not a React child" } }));
  values.set(STORAGE_KEYS.runModes, JSON.stringify({ run: "serial", corrupt: "unknown" }));
  assert.deepEqual(readStorageJson(STORAGE_KEYS.workspaceRuns), { "/repo": ["run"] });
  assert.deepEqual(readStorageJson(STORAGE_KEYS.runLabels), { run: "Saved title" });
  assert.deepEqual(readStorageJson(STORAGE_KEYS.runModes), { run: "serial" });
  values.set(STORAGE_KEYS.runLabels, "[]");
  assert.equal(readStorageJson(STORAGE_KEYS.runLabels), null);
  values.set(STORAGE_KEYS.config, "{incomplete");
  assert.equal(readStorageJson(STORAGE_KEYS.config), null);
  writeStorageJson(STORAGE_KEYS.runLabels, { run: "New title" });
  assert.deepEqual(readStorageJson(STORAGE_KEYS.runLabels), { run: "New title" });
}));

test("unavailable browser storage does not break startup or writes", () => withStorage(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Blocked"); } });
  assert.equal(readStorageString(STORAGE_KEYS.projects), null);
  assert.equal(readStorageJson(STORAGE_KEYS.config), null);
  assert.doesNotThrow(() => writeStorageJson(STORAGE_KEYS.projects, []));
}));
