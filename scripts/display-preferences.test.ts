import assert from "node:assert/strict";
import test from "node:test";
import {
  LANDING_BACKGROUND_KEY,
  EXECUTION_OVERVIEW_KEY,
  HIDE_AUTO_MODE_KEY,
  COLLAPSE_CARDS_KEY,
  COMPLETION_NOTIFICATIONS_KEY,
  COMPLETION_NOTIFICATION_SOUND_KEY,
  executionOverviewEnabled,
  readExecutionOverview,
  setExecutionOverview,
  hideAutoModeEnabled,
  readHideAutoMode,
  setHideAutoMode,
  currentLandingBackground,
  readLandingBackground,
  setLandingBackground,
  collapseCardsEnabled,
  readCollapseCards,
  setCollapseCards,
  completionNotificationsEnabled,
  readCompletionNotifications,
  setCompletionNotifications,
  completionNotificationSoundEnabled,
  readCompletionNotificationSound,
  setCompletionNotificationSound,
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

test("collapse cards defaults to expanded and remembers explicit choices", () => {
  for (const value of [null, "0", "false", "unknown", ""]) {
    assert.equal(readCollapseCards({ getItem: key => key === COLLAPSE_CARDS_KEY ? value : null }), false);
  }
  for (const value of ["1", "true"]) {
    assert.equal(readCollapseCards({ getItem: key => key === COLLAPSE_CARDS_KEY ? value : null }), true);
  }
  assert.equal(readCollapseCards(), false, "unavailable storage uses the default");
  assert.equal(readCollapseCards({ getItem: () => { throw new Error("blocked"); } }), false);
});

test("collapse cards persists locally and remains usable when storage writes fail", () => {
  const original = collapseCardsEnabled();
  const writes: string[][] = [];
  const storage = { setItem: (key: string, value: string) => { writes.push([key, value]); }, removeItem: () => {} };
  try {
    setCollapseCards(true, storage);
    assert.equal(collapseCardsEnabled(), true);
    setCollapseCards(false, storage);
    assert.equal(collapseCardsEnabled(), false);
    assert.deepEqual(writes, [[COLLAPSE_CARDS_KEY, "1"], [COLLAPSE_CARDS_KEY, "0"]]);
    setCollapseCards(true, { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(collapseCardsEnabled(), true);
  } finally {
    setCollapseCards(original, storage);
  }
});

test("completion notifications are enabled by default and explicit opt-outs disable them", () => {
  for (const value of [null, "1", "true", "unknown", ""]) {
    assert.equal(readCompletionNotifications({ getItem: key => key === COMPLETION_NOTIFICATIONS_KEY ? value : null }), true);
  }
  for (const value of ["0", "false"]) {
    assert.equal(readCompletionNotifications({ getItem: key => key === COMPLETION_NOTIFICATIONS_KEY ? value : null }), false);
  }
  assert.equal(readCompletionNotifications(), true, "unavailable storage uses the default");
  assert.equal(readCompletionNotifications({ getItem: () => { throw new Error("blocked"); } }), true);
});

test("completion notifications persist locally and remain usable when storage writes fail", () => {
  const original = completionNotificationsEnabled();
  const writes: string[][] = [];
  const storage = { setItem: (key: string, value: string) => { writes.push([key, value]); }, removeItem: () => {} };
  try {
    setCompletionNotifications(false, storage);
    assert.equal(completionNotificationsEnabled(), false);
    setCompletionNotifications(true, storage);
    assert.equal(completionNotificationsEnabled(), true);
    assert.deepEqual(writes, [[COMPLETION_NOTIFICATIONS_KEY, "0"], [COMPLETION_NOTIFICATIONS_KEY, "1"]]);
    setCompletionNotifications(false, { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(completionNotificationsEnabled(), false);
  } finally {
    setCompletionNotifications(original, storage);
  }
});

test("completion notification sound defaults to on and explicit opt-outs disable it", () => {
  for (const value of [null, "1", "true", "unknown", ""]) {
    assert.equal(readCompletionNotificationSound({ getItem: key => key === COMPLETION_NOTIFICATION_SOUND_KEY ? value : null }), true);
  }
  for (const value of ["0", "false"]) {
    assert.equal(readCompletionNotificationSound({ getItem: key => key === COMPLETION_NOTIFICATION_SOUND_KEY ? value : null }), false);
  }
  assert.equal(readCompletionNotificationSound(), true, "unavailable storage uses the default");
  assert.equal(readCompletionNotificationSound({ getItem: () => { throw new Error("blocked"); } }), true);
});

test("completion notification sound persists locally and remains usable when storage writes fail", () => {
  const original = completionNotificationSoundEnabled();
  const writes: string[][] = [];
  const storage = { setItem: (key: string, value: string) => { writes.push([key, value]); }, removeItem: () => {} };
  try {
    setCompletionNotificationSound(false, storage);
    assert.equal(completionNotificationSoundEnabled(), false);
    setCompletionNotificationSound(true, storage);
    assert.equal(completionNotificationSoundEnabled(), true);
    assert.deepEqual(writes, [[COMPLETION_NOTIFICATION_SOUND_KEY, "0"], [COMPLETION_NOTIFICATION_SOUND_KEY, "1"]]);
    setCompletionNotificationSound(false, { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(completionNotificationSoundEnabled(), false);
  } finally {
    setCompletionNotificationSound(original, storage);
  }
});
