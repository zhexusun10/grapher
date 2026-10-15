import assert from "node:assert/strict";
import test from "node:test";
import {
  loadLandingDraft,
  saveLandingDraft,
  clearLandingDraft,
  landingDraftKey,
  LANDING_GOAL_STORAGE_KEY,
  LEGACY_LANDING_GOAL_STORAGE_KEY,
} from "../src/services/landingDraft";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

test("landingDraftKey handles paths, aliases and unbound repos", () => {
  assert.equal(landingDraftKey(""), "__unbound__");
  assert.equal(landingDraftKey(undefined), "__unbound__");
  assert.equal(landingDraftKey("C:\\Projects\\Alpha"), "c:/projects/alpha");
  assert.equal(landingDraftKey("c:/projects/alpha/"), "c:/projects/alpha");
  assert.equal(landingDraftKey("\\\\?\\C:\\Projects\\Alpha"), "c:/projects/alpha");
});

test("save and load drafts per repository", () => {
  const store = new MemoryStorage();
  const repoA = "C:\\Projects\\Alpha";
  const repoB = "C:\\Projects\\Beta";

  assert.equal(loadLandingDraft(repoA, store), "");

  saveLandingDraft(repoA, "Goal for Alpha", store);
  assert.equal(loadLandingDraft(repoA, store), "Goal for Alpha");
  assert.equal(loadLandingDraft(repoB, store), "");

  saveLandingDraft(repoB, "Goal for Beta", store);
  assert.equal(loadLandingDraft(repoA, store), "Goal for Alpha");
  assert.equal(loadLandingDraft(repoB, store), "Goal for Beta");
});

test("unbound draft is inherited when repository has no draft yet", () => {
  const store = new MemoryStorage();
  const repo = "C:\\Projects\\Alpha";

  saveLandingDraft("", "Draft typed before opening a project", store);
  // When repository is opened, it inherits the unbound draft
  assert.equal(loadLandingDraft(repo, store), "Draft typed before opening a project");

  // Once saved for the repository, unbound draft is consumed
  saveLandingDraft(repo, "Draft typed before opening a project", store);
  const raw = JSON.parse(store.getItem(LANDING_GOAL_STORAGE_KEY)!);
  assert.equal(raw["__unbound__"], undefined);
  assert.equal(raw["c:/projects/alpha"], "Draft typed before opening a project");
});

test("clearLandingDraft cleans up workspace draft and legacy key", () => {
  const store = new MemoryStorage();
  const repo = "C:\\Projects\\Alpha";

  saveLandingDraft(repo, "Alpha goal to submit", store);
  assert.equal(loadLandingDraft(repo, store), "Alpha goal to submit");

  clearLandingDraft(repo, store);
  assert.equal(loadLandingDraft(repo, store), "");
  assert.equal(store.getItem(LANDING_GOAL_STORAGE_KEY), null);
  assert.equal(store.getItem(LEGACY_LANDING_GOAL_STORAGE_KEY), null);
});

test("saving empty string clears draft", () => {
  const store = new MemoryStorage();
  const repo = "C:\\Projects\\Alpha";

  saveLandingDraft(repo, "Some goal", store);
  assert.equal(loadLandingDraft(repo, store), "Some goal");

  saveLandingDraft(repo, "   ", store);
  assert.equal(loadLandingDraft(repo, store), "");
  assert.equal(store.getItem(LANDING_GOAL_STORAGE_KEY), null);
});

test("fallback to legacy key if drafts map is absent", () => {
  const store = new MemoryStorage();
  store.setItem(LEGACY_LANDING_GOAL_STORAGE_KEY, "Legacy draft content");

  assert.equal(loadLandingDraft("C:\\Projects\\Alpha", store), "Legacy draft content");
});
