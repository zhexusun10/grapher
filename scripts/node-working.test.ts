import assert from "node:assert/strict";
import test from "node:test";
import { isNodeWorking } from "../src/lib/nodeWorking.ts";

test("a submitted node message shows working before the next execution starts", () => {
  const previous = { status: "done", completedAt: 1 };
  assert.equal(isNodeWorking("done", previous, true, {}), true);
  assert.equal(isNodeWorking("dirty", previous, false), true);
  assert.equal(isNodeWorking("running", { status: "running", completedAt: null }, false), true);
});

test("settled and delivered messages do not leave working behind", () => {
  const previous = { status: "done", completedAt: 1 };
  assert.equal(isNodeWorking("done", previous, false, {}), false);
  assert.equal(isNodeWorking("done", previous, true, { delivery: "steered" }), false);
  assert.equal(isNodeWorking("done", previous, true), false);
  assert.equal(isNodeWorking("failed", { status: "failed", completedAt: 2 }, false), false);
});
