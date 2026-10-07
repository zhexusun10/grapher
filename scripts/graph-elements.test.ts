import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { computeExecutionLayers, graphEdgeId, indexFeedbackExhaustion, indexGraphInputs, useGraphElements } from "../src/hooks/useGraphElements.ts";
import { emptySnapshot, type Execution, type Graph, type Plan, type Snapshot } from "../src/types.ts";

const graph: Graph = {
  originalGoal: "Test graph projection",
  nodes: ["a", "b", "c"].map(name => ({ name, task: name })),
  edges: [{ from: "a", to: "b", feedback: false }, { from: "b", to: "c", feedback: false }],
};

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

test("graph projections use endpoints and feedback without relation labels", () => {
  const state = { ...emptySnapshot, graph: { ...graph, edges: [...graph.edges, { from: "c", to: "a", feedback: true }] } };
  let elements: ReturnType<typeof useGraphElements> | undefined;
  function Projection() {
    elements = useGraphElements(state, "", new Set());
    return null;
  }
  renderToStaticMarkup(createElement(Projection));
  assert.deepEqual(elements!.nodes.map(node => node.data.hint), [
    "c → a (feedback)", "a → b", "b → c\nc → a (feedback)",
  ]);
  assert.ok(elements!.edges.every(edge => !Object.hasOwn(edge.data!, "relation")));
  assert.equal(elements!.edges[2].markerEnd, "url(#workflow-arrow-feedback)");
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

function skippedFeedbackState(): Snapshot {
  return {
    ...emptySnapshot,
    graph: { ...graph, edges: [...graph.edges, { from: "c", to: "a", feedback: true }] },
    nodes: { c: { status: "done", revision: 1, head: "head", instruction: "", error: null } },
    executions: [{ node: "c", id: "review-1", status: "completed" } as Execution],
    feedbackCounts: { "c->a": 3 },
    events: [{ sequence: 1, timestamp: 1, type: "feedback_exhausted", from: "c", to: "a", count: 3, limit: 3, execution_id: "review-1" }],
  };
}

test("cards show recorded skipped feedback, including a zero budget", () => {
  const state = skippedFeedbackState();
  assert.deepEqual(indexFeedbackExhaustion(state).get("c"), { from: "c", to: "a", count: 3, limit: 3 });
  state.feedbackCounts = {};
  state.events[0] = { ...state.events[0], count: 0, limit: 0 };
  assert.deepEqual(indexFeedbackExhaustion(state).get("c"), { from: "c", to: "a", count: 0, limit: 0 });
});

test("reaching the count or accepting a verdict is not exhaustion", () => {
  const state = skippedFeedbackState();
  state.events = [{ sequence: 1, timestamp: 1, type: "feedback", from: "c", to: "a", accepted: true }];
  assert.equal(indexFeedbackExhaustion(state).size, 0);
  state.events = [];
  assert.equal(indexFeedbackExhaustion(state).size, 0);
});

test("stale, superseded, invalidated, and removed-route warnings are hidden", () => {
  for (const status of ["waiting", "dirty", "running", "failed", "blocked"] as const) {
    const state = skippedFeedbackState();
    state.nodes.c.status = status;
    assert.equal(indexFeedbackExhaustion(state).size, 0, status);
  }
  const rerun = skippedFeedbackState();
  rerun.executions.push({ node: "c", id: "review-2", status: "completed" } as Execution);
  assert.equal(indexFeedbackExhaustion(rerun).size, 0);
  const superseded = skippedFeedbackState();
  superseded.supersededExecutionIds = ["review-1"];
  assert.equal(indexFeedbackExhaustion(superseded).size, 0);
  const removed = skippedFeedbackState();
  removed.graph.edges = removed.graph.edges.filter(edge => !edge.feedback);
  assert.equal(indexFeedbackExhaustion(removed).size, 0);
});
