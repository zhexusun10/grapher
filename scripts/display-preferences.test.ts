import assert from "node:assert/strict";
import test from "node:test";
import {
  LANDING_BACKGROUND_KEY,
  currentLandingBackground,
  readLandingBackground,
  setLandingBackground,
} from "../src/services/displayPreferences.ts";

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
