import assert from "node:assert/strict";
import test from "node:test";
import { isNodeWorking, nodeDependenciesCompleted } from "../src/lib/nodeWorking.ts";
import { resolveGraphPhase } from "../src/lib/graphPhase.ts";

test("a submitted node message shows working before the next execution starts", () => {
  const previous = { status: "completed", completedAt: 1 };
  assert.equal(isNodeWorking("completed", previous, true, {}), true);
  assert.equal(isNodeWorking("dirty", previous, false, undefined, false, true, true), true);
  assert.equal(isNodeWorking("running", { status: "running", completedAt: null }, false), true);
});

test("a dirty downstream node waiting for feedback ancestors is not Working", () => {
  const previous = { status: "completed", completedAt: 1 };
  assert.equal(isNodeWorking("dirty", previous, false, undefined, false, false, true), false);
  assert.equal(isNodeWorking("dirty", previous, false, undefined, false, true, false), false,
    "a dirty node with an earlier execution and no queued message is not Working");
  assert.equal(isNodeWorking("dirty", previous, false, undefined, false, true, true), true);
  assert.equal(isNodeWorking("dirty", undefined, false, undefined, false, true, false), true,
    "a first execution that is dirty and ready still shows startup Working");

  const graph = { edges: [
    { from: "root", to: "review", feedback: false },
    { from: "review", to: "repair", feedback: false },
    { from: "repair", to: "deliver", feedback: false },
    { from: "deliver", to: "repair", feedback: true },
  ] };
  const nodes = {
    root: { status: "completed" }, review: { status: "completed" },
    repair: { status: "running" }, deliver: { status: "dirty" },
  };
  assert.equal(nodeDependenciesCompleted(graph, nodes, "deliver"), false,
    "a transitive running ancestor blocks the dirty node");
  assert.equal(nodeDependenciesCompleted(graph, nodes, "repair"), true,
    "feedback edges do not participate in dependency readiness");
  assert.equal(nodeDependenciesCompleted(graph, { ...nodes, repair: { status: "completed" } }, "deliver"), true);
});

test("settled and delivered messages do not leave working behind", () => {
  const previous = { status: "completed", completedAt: 1 };
  assert.equal(isNodeWorking("completed", previous, false, {}), false);
  assert.equal(isNodeWorking("completed", previous, true, { delivery: "steered" }), false);
  assert.equal(isNodeWorking("completed", previous, true), false);
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

