import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { checkDependenciesFast, findCargoExecutable } from "./ensure-deps.mjs";

test("checkDependenciesFast returns correct structure", () => {
  const result = checkDependenciesFast();
  assert.equal(typeof result.missingSubmodule, "boolean");
  assert.equal(typeof result.missingRootModules, "boolean");
  assert.equal(typeof result.missingPiDist, "boolean");
  assert.equal(typeof result.missingCargo, "boolean");
  assert.equal(typeof result.allReady, "boolean");
});

test("checkDependenciesFast latency benchmark: must execute in < 2ms", () => {
  // Warm up
  for (let i = 0; i < 10; i++) {
    checkDependenciesFast();
  }

  const iterations = 100;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    checkDependenciesFast();
  }
  const totalMs = performance.now() - start;
  const avgMs = totalMs / iterations;

  console.log(`[benchmark] Average check time: ${avgMs.toFixed(3)}ms (Total for ${iterations} runs: ${totalMs.toFixed(2)}ms)`);
  assert.ok(avgMs < 2, `Average latency (${avgMs.toFixed(3)}ms) exceeded 2ms target`);
});

test("findCargoExecutable behaves consistently", () => {
  const cargo = findCargoExecutable();
  if (cargo !== null) {
    assert.equal(typeof cargo, "string");
  }
});
