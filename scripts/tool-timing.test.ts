import assert from "node:assert/strict";
import test from "node:test";
import { formatToolDuration } from "../src/utils/toolTiming.ts";

test("sub-ten-second durations keep one decimal, like `Took 0.3s`", () => {
  assert.equal(formatToolDuration(0), "0.0s");
  assert.equal(formatToolDuration(120), "0.1s");
  assert.equal(formatToolDuration(300), "0.3s");
  assert.equal(formatToolDuration(2_480), "2.5s");
  assert.equal(formatToolDuration(9_960), "10.0s");
});

test("durations are reported in h/m/s units", () => {
  assert.equal(formatToolDuration(10_000), "10s");
  assert.equal(formatToolDuration(42_000), "42s");
  assert.equal(formatToolDuration(59_400), "59s");
  assert.equal(formatToolDuration(65_000), "1m 05s");
  assert.equal(formatToolDuration(3_780_000), "1h 3m 0s");
  assert.equal(formatToolDuration(-5), "0.0s");
});
