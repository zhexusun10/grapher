import assert from "node:assert/strict";
import test from "node:test";
import { computeExecutionLayers, graphEdgeId, indexGraphInputs } from "../src/hooks/useGraphElements.ts";
import type { Graph, Plan, Snapshot } from "../src/types.ts";

const graph = {
  nodes: [{ name: "a" }, { name: "b" }, { name: "c" }],
  edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
} as Graph;

test("edge identities are unambiguous and distinguish feedback", () => {
  const edges = [
    { from: "a", to: "b-dep-c", feedback: false },
    { from: "a-dep-b", to: "c", feedback: false },
    { from: "a", to: "b-dep-c", feedback: true },
    { from: 'a\"', to: "b,c", feedback: false },
  ];
  assert.equal(new Set(edges.map(graphEdgeId)).size, edges.length);
  assert.equal(graphEdgeId(edges[0]), graphEdgeId({ ...edges[0] }));
});

test("node indexes match scans and preserve hint and attempt order", () => {
  const g = { ...graph, edges: [...graph.edges, { from: "c", to: "a", feedback: true }] } as Graph;
  const executions = [{ node: "a", id: "1" }, { node: "c", id: "2" }, { node: "a", id: "3" }] as Snapshot["executions"];
  const indexes = indexGraphInputs(g, executions);
  for (const { name } of g.nodes) {
    assert.deepEqual(indexes.incoming.get(name) ?? [], g.edges.filter(e => e.to === name));
    assert.deepEqual(indexes.outgoing.get(name) ?? [], g.edges.filter(e => e.from === name));
    assert.deepEqual(indexes.hints.get(name) ?? [], g.edges.filter(e => e.to === name || (e.from === name && e.feedback)));
    assert.deepEqual(indexes.attempts.get(name) ?? [], executions.filter(e => e.node === name));
  }
});

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
