import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  SPLIT_RATIO_STORAGE_KEY,
  LEGACY_WIDTH_STORAGE_KEY,
  getStoredRatio,
  persistRatio,
  clampSplitRatio,
} from "../src/hooks/useWorkbenchResizer.ts";

test("DEFAULT_SPLIT_RATIO is 0.6 (60% dialogue, 40% graph)", () => {
  assert.equal(DEFAULT_SPLIT_RATIO, 0.6);
});

test("getStoredRatio returns default ratio when storage is empty", () => {
  const mockStorage = {
    getItem: () => null,
  };
  assert.equal(getStoredRatio(mockStorage), DEFAULT_SPLIT_RATIO);
  assert.equal(getStoredRatio(mockStorage), 0.6);
});

test("getStoredRatio loads persisted split ratio and clamps within bounds", () => {
  const validStorage = {
    getItem: (key: string) => (key === SPLIT_RATIO_STORAGE_KEY ? "0.45" : null),
  };
  assert.equal(getStoredRatio(validStorage), 0.45);

  const tooSmallStorage = {
    getItem: (key: string) => (key === SPLIT_RATIO_STORAGE_KEY ? "0.05" : null),
  };
  assert.equal(getStoredRatio(tooSmallStorage), MIN_SPLIT_RATIO);

  const tooLargeStorage = {
    getItem: (key: string) => (key === SPLIT_RATIO_STORAGE_KEY ? "0.95" : null),
  };
  assert.equal(getStoredRatio(tooLargeStorage), MAX_SPLIT_RATIO);
});

test("getStoredRatio gracefully converts legacy pixel width", () => {
  const legacyStorage = {
    getItem: (key: string) => (key === LEGACY_WIDTH_STORAGE_KEY ? "480" : null),
  };
  // 480 / 1200 = 0.40
  assert.equal(getStoredRatio(legacyStorage), 0.4);
});

test("getStoredRatio prioritizes split ratio over legacy width", () => {
  const bothStorage = {
    getItem: (key: string) => {
      if (key === SPLIT_RATIO_STORAGE_KEY) return "0.50";
      if (key === LEGACY_WIDTH_STORAGE_KEY) return "370";
      return null;
    },
  };
  assert.equal(getStoredRatio(bothStorage), 0.5);
});

test("persistRatio saves ratio and updates legacy pixel width", () => {
  const saved: Record<string, string> = {};
  const mockStorage = {
    setItem: (key: string, value: string) => {
      saved[key] = value;
    },
  };

  persistRatio(0.42, mockStorage);
  assert.equal(saved[SPLIT_RATIO_STORAGE_KEY], "0.42");
  assert.equal(saved[LEGACY_WIDTH_STORAGE_KEY], "504"); // 0.42 * 1200 = 504
});

test("clampSplitRatio ensures minimum left and right widths for different container sizes", () => {
  // Container width 1000px:
  // minLeft = 280px -> minRatio = 0.28
  // minRight = 320px -> maxRatio = (1000 - 320) / 1000 = 0.68
  assert.equal(clampSplitRatio(0.1, 1000), 0.28);
  assert.equal(clampSplitRatio(0.9, 1000), 0.68);
  assert.equal(clampSplitRatio(0.4, 1000), 0.4);

  // Large container width 2000px:
  // minLeft = 280px -> minRatio = 280 / 2000 = 0.14 -> clamped to MIN_SPLIT_RATIO (0.15)
  // minRight = 320px -> maxRatio = 1680 / 2000 = 0.84
  assert.equal(clampSplitRatio(0.1, 2000), MIN_SPLIT_RATIO);
  assert.equal(clampSplitRatio(0.5, 2000), 0.5);
  assert.equal(clampSplitRatio(0.84, 2000), 0.84);
});

test("storage exceptions do not throw and fall back to default", () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error("QuotaExceededError or security block");
    },
    setItem: () => {
      throw new Error("QuotaExceededError or security block");
    },
  };
  assert.equal(getStoredRatio(throwingStorage), DEFAULT_SPLIT_RATIO);
  assert.doesNotThrow(() => persistRatio(0.4, throwingStorage));
});
