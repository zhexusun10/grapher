import assert from "node:assert/strict";
import test from "node:test";
import {
  LANDING_BACKGROUND_KEY,
  EXECUTION_OVERVIEW_KEY,
  HIDE_AUTO_MODE_KEY,
  executionOverviewEnabled,
  readExecutionOverview,
  setExecutionOverview,
  hideAutoModeEnabled,
  readHideAutoMode,
  setHideAutoMode,
  currentLandingBackground,
  readLandingBackground,
  setLandingBackground,
} from "../src/services/displayPreferences.ts";

test("Execution graph overview is hidden by default and explicit opt-ins enable it", () => {
  for (const value of [null, "0", "false", "unknown", ""]) {
    assert.equal(readExecutionOverview({ getItem: key => key === EXECUTION_OVERVIEW_KEY ? value : null }), false);
  }
  for (const value of ["1", "true"]) {
    assert.equal(readExecutionOverview({ getItem: key => key === EXECUTION_OVERVIEW_KEY ? value : null }), true);
  }
  assert.equal(readExecutionOverview(), false, "unavailable storage uses the default");
  assert.equal(readExecutionOverview({ getItem: () => { throw new Error("blocked"); } }), false);
});

test("Execution graph overview persists locally and remains usable when storage writes fail", () => {
  const original = executionOverviewEnabled();
  const writes: string[][] = [];
  const storage = { setItem: (key: string, value: string) => { writes.push([key, value]); }, removeItem: () => {} };
  try {
    setExecutionOverview(true, storage);
    assert.equal(executionOverviewEnabled(), true);
    setExecutionOverview(false, storage);
    assert.equal(executionOverviewEnabled(), false);
    assert.deepEqual(writes, [[EXECUTION_OVERVIEW_KEY, "1"], [EXECUTION_OVERVIEW_KEY, "0"]]);
    setExecutionOverview(true, { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(executionOverviewEnabled(), true);
  } finally {
    setExecutionOverview(original, storage);
  }
});

test("Auto mode is hidden by default and explicit opt-outs keep it visible", () => {
  for (const value of [null, "1", "true", "unknown", ""]) {
    assert.equal(readHideAutoMode({ getItem: key => key === HIDE_AUTO_MODE_KEY ? value : null }), true);
  }
  for (const value of ["0", "false"]) {
    assert.equal(readHideAutoMode({ getItem: () => value }), false);
  }
  assert.equal(readHideAutoMode(), true, "unavailable storage uses the default");
  assert.equal(readHideAutoMode({ getItem: () => { throw new Error("blocked"); } }), true);
});

test("Auto visibility persists locally and remains usable when storage writes fail", () => {
  const original = hideAutoModeEnabled();
  const writes: string[][] = [];
  const storage = { setItem: (key: string, value: string) => { writes.push([key, value]); }, removeItem: () => {} };
  try {
    setHideAutoMode(true, storage);
    assert.equal(hideAutoModeEnabled(), true);
    setHideAutoMode(false, storage);
    assert.equal(hideAutoModeEnabled(), false);
    assert.deepEqual(writes, [[HIDE_AUTO_MODE_KEY, "1"], [HIDE_AUTO_MODE_KEY, "0"]]);
    setHideAutoMode(true, { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(hideAutoModeEnabled(), true);
  } finally {
    setHideAutoMode(original, storage);
  }
});

test("home background defaults to the static dot pattern and handles unavailable or invalid storage", () => {
  assert.equal(readLandingBackground({ getItem: () => null }), "dots");
  assert.equal(readLandingBackground({ getItem: () => "paths" }), "paths");
  assert.equal(readLandingBackground({ getItem: () => "dots" }), "dots");
  assert.equal(readLandingBackground({ getItem: () => "unknown" }), "dots");
  assert.equal(readLandingBackground({ getItem: () => "warp" }), "dots", "a removed background falls back to the default");
  assert.equal(readLandingBackground({ getItem: () => { throw new Error("blocked"); } }), "dots");
});

test("home background persists locally and remains usable when storage writes fail", () => {
  const writes: string[][] = [];
  const storage = {
    setItem: (key: string, value: string) => { writes.push([key, value]); },
    removeItem: () => {},
  };
  try {
    setLandingBackground("dots", storage);
    assert.equal(currentLandingBackground(), "dots");
    setLandingBackground("paths", storage);
    assert.equal(currentLandingBackground(), "paths");
    assert.deepEqual(writes, [[LANDING_BACKGROUND_KEY, "dots"], [LANDING_BACKGROUND_KEY, "paths"]]);
    setLandingBackground("dots", { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(currentLandingBackground(), "dots");
  } finally {
    setLandingBackground("paths");
  }
});
