import assert from "node:assert/strict";
import test from "node:test";
import { computeExecutionLayers } from "../src/hooks/useGraphElements.ts";
import type { Graph, Plan } from "../src/types.ts";

const graph = {
  nodes: [{ name: "a" }, { name: "b" }, { name: "c" }],
  edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
} as Graph;

test("dependency layers follow the DAG", () => {
  assert.deepEqual(computeExecutionLayers(graph), [["a"], ["b"], ["c"]]);
});

test("feedback edges do not impose dependencies", () => {
  const withFeedback = { ...graph, edges: [...graph.edges, { from: "c", to: "a", feedback: true }] } as Graph;
  assert.deepEqual(computeExecutionLayers(withFeedback), [["a"], ["b"], ["c"]]);
});

test("explicit plan batches include unscheduled nodes", () => {
  const plan = { executionBatches: [["a"], ["b"]] } as Plan;
  assert.deepEqual(computeExecutionLayers(graph, plan), [["a"], ["b"], ["c"]]);
});
