import assert from "node:assert/strict";
import test from "node:test";
import { isNodeWorking } from "../src/lib/nodeWorking.ts";
import { resolveGraphPhase } from "../src/lib/graphPhase.ts";

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

test("resolveGraphPhase returns running when work is active after failure intervention", () => {
  const base = {
    isPlanning: false,
    approved: true,
    paused: false,
    canResume: false,
    publishing: false,
    publicationFailed: false,
    phase: "needs_attention",
  };

  // When a node is running or dirty after intervention, phase resolves to running
  assert.equal(resolveGraphPhase({ ...base, nodes: { task: { status: "running" } } }), "running");
  assert.equal(resolveGraphPhase({ ...base, nodes: { task: { status: "dirty" } } }), "running");

  // When an execution is running, phase resolves to running
  assert.equal(resolveGraphPhase({ ...base, executions: [{ status: "running" }] }), "running");

  // When a node merger is running, phase resolves to running
  assert.equal(resolveGraphPhase({ ...base, mergers: [{ node: "merge:task", status: "running" }] }), "running");

  // When publication merger is running, phase resolves to merging
  assert.equal(resolveGraphPhase({ ...base, mergers: [{ node: "merger", status: "running" }] }), "merging");

  // When active prop is true, phase resolves to running
  assert.equal(resolveGraphPhase({ ...base, active: true }), "running");

  // When truly stopped and needs attention, phase remains needs_attention
  assert.equal(resolveGraphPhase({ ...base, nodes: { task: { status: "failed" } } }), "needs_attention");
});

