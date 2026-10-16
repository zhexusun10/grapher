import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { computeExecutionLayers, graphEdgeId, indexFeedbackExhaustion, indexGraphInputs, useGraphElements } from "../src/hooks/useGraphElements.ts";
import { emptySnapshot, type Execution, type Graph, type Plan, type RuntimeActivity, type Snapshot } from "../src/types.ts";

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
    nodes: { c: { status: "completed", revision: 1, head: "head", instruction: "", error: null } },
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

function mergerState(): Snapshot {
  return {
    ...emptySnapshot,
    graph: { originalGoal: "merge", nodes: [{ name: "join", task: "join task" }], edges: [] },
    nodes: { join: { status: "blocked", revision: 1, head: null, instruction: "", error: "conflict" } },
    mergers: [{
      id: "merger-1", node: "merge:join", revision: 1, attempt: 1, sessionId: "merger-1",
      worktree: "/worktrees/join", before: "base", after: null, status: "failed",
      output: "", startedAt: 1, completedAt: 2,
    } as Execution],
  };
}

function projectGraph(state: Snapshot, selected: string, selectedMergerId = "", activity: RuntimeActivity[] = []) {
  let elements: ReturnType<typeof useGraphElements> | undefined;
  function Projection() {
    elements = useGraphElements(state, selected, new Set(), selectedMergerId, activity);
    return null;
  }
  renderToStaticMarkup(createElement(Projection));
  return elements!;
}

function publicationMergerState(): Snapshot {
  return {
    ...emptySnapshot,
    graph: { originalGoal: "publish", nodes: [{ name: "a", task: "a" }, { name: "b", task: "b" }],
      edges: [{ from: "a", to: "b", feedback: false }] },
    plan: { executionBatches: [["a"], ["b"]], roots: ["a"], terminals: ["b"], warnings: [] },
    nodes: { a: { status: "completed", revision: 1, head: "ha", instruction: "", error: null },
      b: { status: "completed", revision: 1, head: "hb", instruction: "", error: null } },
    mergers: [{
      id: "publish-merger", node: "merger", revision: 1, attempt: 1, sessionId: "publish-merger",
      worktree: "/source", before: "hb", after: "hc", status: "completed",
      output: "", startedAt: 3, completedAt: 4,
    } as Execution],
  };
}

test("a publication merger is a card below the terminal layer", () => {
  const state = publicationMergerState();
  const idle = projectGraph(state, "");
  const card = idle.nodes.find(node => node.id === "merger:publication");
  assert.ok(card, "publication merger card must exist once invoked");
  assert.equal(card!.data.name, "publication merger");
  assert.equal(card!.data.status, "completed");
  assert.equal(card!.data.selected, false);
  // The publication card sits below the last execution layer and receives the
  // terminal edges only.
  const terminal = idle.nodes.find(node => node.id === "b")!;
  assert.ok(card!.position.y > terminal.position.y);
  assert.equal(terminal.data.hasBottom, true);
  const publicationEdges = idle.edges.filter(edge => edge.target === "merger:publication");
  assert.deepEqual(publicationEdges.map(edge => edge.source), ["b"]);
  assert.ok(!idle.edges.some(edge => edge.source === "a" && edge.target === "merger:publication"));

  const selected = projectGraph(state, "merger:publication", "publish-merger");
  const selectedCard = selected.nodes.find(node => node.id === "merger:publication")!;
  assert.equal(selectedCard.data.selected, true);
  assert.equal(selected.nodes.find(node => node.id === "b")!.data.selected, false);

  // Without a recorded publication merger the synthetic card does not render.
  const plain = publicationMergerState();
  plain.mergers = [];
  assert.ok(!projectGraph(plain, "").nodes.some(node => node.id === "merger:publication"));
  assert.ok(!projectGraph(plain, "").edges.some(edge => edge.target === "merger:publication"));
});

test("a node-composition merger is a selectable card in the topology", () => {
  const state = mergerState();
  const idle = projectGraph(state, "");
  assert.deepEqual(idle.nodes.map(node => node.id).sort(), ["join", "merger:join"]);
  assert.equal(idle.nodes.find(node => node.id === "merger:join")!.data.status, "failed");

  // Selecting the merger card highlights it without highlighting the node card.
  const mergerSelected = projectGraph(state, "join", "merger-1");
  assert.equal(mergerSelected.nodes.find(node => node.id === "merger:join")!.data.selected, true);
  assert.equal(mergerSelected.nodes.find(node => node.id === "join")!.data.selected, false);

  // Selecting the node card leaves the merger card unselected.
  const nodeSelected = projectGraph(state, "join");
  assert.equal(nodeSelected.nodes.find(node => node.id === "merger:join")!.data.selected, false);
  assert.equal(nodeSelected.nodes.find(node => node.id === "join")!.data.selected, true);

  // A `merger` node is a publication merger, not a per-target card.
  const publication = mergerState();
  publication.mergers![0].node = "merger";
  assert.deepEqual(projectGraph(publication, "").nodes.map(node => node.id).sort(), ["join", "merger:publication"]);
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

test("downstream edge is dashed only during workspace transfer and immediately turns solid once transfer completes without waiting for node completion", () => {
  const testGraph: Graph = {
    originalGoal: "test topology edge animation",
    nodes: [{ name: "a", task: "a" }, { name: "b", task: "b" }, { name: "c", task: "c" }],
    edges: [
      { from: "a", to: "b", feedback: false },
      { from: "b", to: "c", feedback: false },
    ],
  };

  // 1. Initial state: a is running, b is waiting.
  // Downstream edge a -> b should NOT be animated (not dashed) while a is running.
  const stateRunningA: Snapshot = {
    ...emptySnapshot,
    graph: testGraph,
    nodes: {
      a: { status: "running", revision: 1, head: null, instruction: "", error: null },
      b: { status: "waiting", revision: 1, head: null, instruction: "", error: null },
      c: { status: "waiting", revision: 1, head: null, instruction: "", error: null },
    },
  };
  const projA = projectGraph(stateRunningA, "");
  const edgeAB_running = projA.edges.find(e => e.source === "a" && e.target === "b")!;
  const edgeBC_running = projA.edges.find(e => e.source === "b" && e.target === "c")!;
  assert.equal(edgeAB_running.animated, false, "downstream edge must not be animated/dashed while upstream node is running");
  assert.equal(edgeBC_running.animated, false);

  // 2. a is completed, workspace starts passing to b (b is waiting/preparing, not yet prepared).
  // Downstream edge a -> b should be animated (dashed).
  const stateTransferringB: Snapshot = {
    ...emptySnapshot,
    graph: testGraph,
    nodes: {
      a: { status: "completed", revision: 1, head: "ha", instruction: "", error: null },
      b: { status: "running", revision: 1, head: null, instruction: "", error: null },
      c: { status: "waiting", revision: 1, head: null, instruction: "", error: null },
    },
    executions: [{
      id: "exec-b-1", node: "b", revision: 1, attempt: 1, sessionId: "s-b-1",
      worktree: "/wt/b", before: "ha", after: null, status: "running",
      output: "", outputBytes: 0, startedAt: 1, completedAt: null,
    } as Execution],
    events: [{ sequence: 1, timestamp: 1, type: "started", node: "b", execution_id: "exec-b-1" }],
  };
  const projTransferring = projectGraph(stateTransferringB, "", "", [{ kind: "workspace_prepare", nodes: ["b"] }]);
  const edgeAB_passing = projTransferring.edges.find(e => e.source === "a" && e.target === "b")!;
  assert.equal(edgeAB_passing.animated, true, "edge must turn dashed while workspace is transferring to b");

  // 3. Workspace transfer completes (prepared event emitted), but b is STILL RUNNING!
  // The edge a -> b must IMMEDIATELY turn into a solid line (animated: false),
  // without waiting for b to finish (status === "completed").
  const statePreparedB: Snapshot = {
    ...stateTransferringB,
    events: [
      { sequence: 1, timestamp: 1, type: "started", node: "b", execution_id: "exec-b-1" },
      { sequence: 2, timestamp: 2, type: "prepared", node: "b", execution_id: "exec-b-1" },
    ],
  };
  const projPrepared = projectGraph(statePreparedB, "", "", []);
  const edgeAB_prepared = projPrepared.edges.find(e => e.source === "a" && e.target === "b")!;
  const edgeBC_stillWaiting = projPrepared.edges.find(e => e.source === "b" && e.target === "c")!;
  assert.equal(edgeAB_prepared.animated, false, "edge a -> b must immediately turn solid once workspace transfer completes, even though b is still running");
  assert.equal(edgeBC_stillWaiting.animated, false, "edge b -> c must not be dashed while b is running");

  // 4. b completes: workspace starts passing to c (c is preparing, not yet prepared).
  // a -> b stays solid, b -> c becomes dashed.
  const stateTransferringC: Snapshot = {
    ...emptySnapshot,
    graph: testGraph,
    nodes: {
      a: { status: "completed", revision: 1, head: "ha", instruction: "", error: null },
      b: { status: "completed", revision: 1, head: "hb", instruction: "", error: null },
      c: { status: "running", revision: 1, head: null, instruction: "", error: null },
    },
    executions: [
      { id: "exec-b-1", node: "b", status: "completed", completedAt: 3 } as Execution,
      { id: "exec-c-1", node: "c", status: "running", startedAt: 4, completedAt: null, output: "", outputBytes: 0 } as Execution,
    ],
    events: [
      { sequence: 3, timestamp: 3, type: "finished", node: "b", execution_id: "exec-b-1" },
      { sequence: 4, timestamp: 4, type: "started", node: "c", execution_id: "exec-c-1" },
    ],
  };
  const projTransferringC = projectGraph(stateTransferringC, "", "", [{ kind: "workspace_prepare", nodes: ["c"] }]);
  const edgeAB_afterB = projTransferringC.edges.find(e => e.source === "a" && e.target === "b")!;
  const edgeBC_passing = projTransferringC.edges.find(e => e.source === "b" && e.target === "c")!;
  assert.equal(edgeAB_afterB.animated, false, "edge a -> b must remain solid");
  assert.equal(edgeBC_passing.animated, true, "edge b -> c must turn dashed while workspace is transferring to c");

  // 5. c completes workspace transfer: b -> c immediately turns solid while c runs its task.
  const statePreparedC: Snapshot = {
    ...stateTransferringC,
    events: [
      ...stateTransferringC.events,
      { sequence: 5, timestamp: 5, type: "prepared", node: "c", execution_id: "exec-c-1" },
    ],
  };
  const projPreparedC = projectGraph(statePreparedC, "", "", []);
  const edgeBC_prepared = projPreparedC.edges.find(e => e.source === "b" && e.target === "c")!;
  assert.equal(edgeBC_prepared.animated, false, "edge b -> c must immediately turn solid once workspace transfer completes");

  // 6. c completes: all nodes completed, all edges solid.
  const stateAllCompleted: Snapshot = {
    ...emptySnapshot,
    graph: testGraph,
    nodes: {
      a: { status: "completed", revision: 1, head: "ha", instruction: "", error: null },
      b: { status: "completed", revision: 1, head: "hb", instruction: "", error: null },
      c: { status: "completed", revision: 1, head: "hc", instruction: "", error: null },
    },
  };
  const projAllCompleted = projectGraph(stateAllCompleted, "");
  assert.ok(projAllCompleted.edges.every(e => !e.animated), "all edges must be solid once all nodes are completed");
});

test("fan-in dependency edges only turn dashed once all upstream parents are completed and turn solid once prepared", () => {
  const fanInGraph: Graph = {
    originalGoal: "test fan-in edge animation",
    nodes: [{ name: "a", task: "a" }, { name: "b", task: "b" }, { name: "c", task: "c" }],
    edges: [
      { from: "a", to: "c", feedback: false },
      { from: "b", to: "c", feedback: false },
    ],
  };

  // a is completed, but b is still running. c cannot receive workspace yet.
  const statePartial: Snapshot = {
    ...emptySnapshot,
    graph: fanInGraph,
    nodes: {
      a: { status: "completed", revision: 1, head: "ha", instruction: "", error: null },
      b: { status: "running", revision: 1, head: null, instruction: "", error: null },
      c: { status: "waiting", revision: 1, head: null, instruction: "", error: null },
    },
  };
  const projPartial = projectGraph(statePartial, "");
  const edgeAC_partial = projPartial.edges.find(e => e.source === "a" && e.target === "c")!;
  const edgeBC_partial = projPartial.edges.find(e => e.source === "b" && e.target === "c")!;
  assert.equal(edgeAC_partial.animated, false, "edge a -> c must not animate while b is still running");
  assert.equal(edgeBC_partial.animated, false, "edge b -> c must not animate while b is running");

  // Both a and b are completed, c starts workspace transfer. Both edges turn dashed.
  const stateBothCompletedTransferring: Snapshot = {
    ...emptySnapshot,
    graph: fanInGraph,
    nodes: {
      a: { status: "completed", revision: 1, head: "ha", instruction: "", error: null },
      b: { status: "completed", revision: 1, head: "hb", instruction: "", error: null },
      c: { status: "running", revision: 1, head: null, instruction: "", error: null },
    },
    executions: [{
      id: "exec-c-1", node: "c", revision: 1, attempt: 1, sessionId: "s-c-1",
      worktree: "/wt/c", before: "hb", after: null, status: "running",
      output: "", outputBytes: 0, startedAt: 1, completedAt: null,
    } as Execution],
    events: [{ sequence: 1, timestamp: 1, type: "started", node: "c", execution_id: "exec-c-1" }],
  };
  const projBothCompleted = projectGraph(stateBothCompletedTransferring, "", "", [{ kind: "workspace_prepare", nodes: ["c"] }]);
  const edgeAC_transferring = projBothCompleted.edges.find(e => e.source === "a" && e.target === "c")!;
  const edgeBC_transferring = projBothCompleted.edges.find(e => e.source === "b" && e.target === "c")!;
  assert.equal(edgeAC_transferring.animated, true, "edge a -> c must turn dashed during workspace transfer to c");
  assert.equal(edgeBC_transferring.animated, true, "edge b -> c must turn dashed during workspace transfer to c");

  // c completes workspace preparation (prepared event emitted), but c is STILL RUNNING.
  // Both edges IMMEDIATELY turn back to solid!
  const stateBothCompletedPrepared: Snapshot = {
    ...stateBothCompletedTransferring,
    events: [
      { sequence: 1, timestamp: 1, type: "started", node: "c", execution_id: "exec-c-1" },
      { sequence: 2, timestamp: 2, type: "prepared", node: "c", execution_id: "exec-c-1" },
    ],
  };
  const projPrepared = projectGraph(stateBothCompletedPrepared, "", "", []);
  const edgeAC_prepared = projPrepared.edges.find(e => e.source === "a" && e.target === "c")!;
  const edgeBC_prepared = projPrepared.edges.find(e => e.source === "b" && e.target === "c")!;
  assert.equal(edgeAC_prepared.animated, false, "edge a -> c must immediately turn solid once workspace transfer completes");
  assert.equal(edgeBC_prepared.animated, false, "edge b -> c must immediately turn solid once workspace transfer completes");
});
