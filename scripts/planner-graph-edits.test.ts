import assert from "node:assert/strict";
import test from "node:test";
import { PlannerGraphEditQueue, plannerEdgeEdits, plannerNodeEdits } from "../src/lib/plannerGraphEdits.ts";

test("Planner previews match edit_graph collection preparation", () => {
  const node = { id: "worker", task: "Do the work" };
  for (const args of [
    { nodes: [node] }, { nodes: node },
    { nodes: JSON.stringify([node]) }, { nodes: JSON.stringify(node) },
    JSON.stringify({ nodes: [node] }),
  ]) {
    assert.deepEqual(plannerNodeEdits(args), [{ ...node, delete: false }]);
  }
  const edge = { from: "a", to: "b" };
  for (const args of [
    { edges: [edge] }, { edges: edge },
    { edges: JSON.stringify([edge]) }, { edges: JSON.stringify(edge) },
    JSON.stringify({ edges: [edge] }),
  ]) {
    assert.deepEqual(plannerEdgeEdits(args), [{ ...edge, feedback: false, delete: false }]);
  }
});

test("Planner previews do not accept retired name aliases or bare single-edit tools", () => {
  assert.deepEqual(plannerNodeEdits({ nodes: [{ name: "worker", task: "Old field" }] }), []);
  for (const args of [{ id: "worker", task: "Bare" }, [{ id: "worker", task: "Bare" }], { nodes: [], id: "worker" }]) {
    assert.deepEqual(plannerNodeEdits(args), []);
  }
  for (const args of [{ from: "a", to: "b" }, [{ from: "a", to: "b" }], { edges: [], from: "a", to: "b" }]) {
    assert.deepEqual(plannerEdgeEdits(args), []);
  }
});

test("edit_graph previews retain both collections and every edit", () => {
  const batch = { nodes: [{ id: "new", task: "New work" }, { id: "old", delete: true }],
    edges: [{ from: "new", to: "check" }, { from: "check", to: "new", feedback: true }] };
  assert.deepEqual(plannerNodeEdits(batch), [
    { id: "new", task: "New work", delete: false }, { id: "old", task: "", delete: true },
  ]);
  assert.deepEqual(plannerEdgeEdits(batch), [
    { from: "new", to: "check", feedback: false, delete: false },
    { from: "check", to: "new", feedback: true, delete: false },
  ]);
  assert.deepEqual(plannerNodeEdits({ edges: batch.edges }), []);
  assert.deepEqual(plannerEdgeEdits({ nodes: batch.nodes }), []);
});

test("Planner graph previews mirror Pi primitive coercion", () => {
  assert.deepEqual(plannerNodeEdits({ nodes: [{ id: 7, task: 42, delete: "true" }, { id: "x", delete: 0 }] }), [
    { id: "7", task: "42", delete: true }, { id: "x", task: "", delete: false },
  ]);
  assert.deepEqual(plannerEdgeEdits({ edges: [{ from: "a", to: "b", feedback: 1 }, { from: "b", to: "c", delete: "true" }] }), [
    { from: "a", to: "b", feedback: true, delete: false }, { from: "b", to: "c", feedback: false, delete: true },
  ]);
  for (const value of ["TRUE", "True", "1"]) {
    assert.deepEqual(plannerNodeEdits({ nodes: [{ id: "remove", delete: value }] }), [
      { id: "remove", task: "", delete: true },
    ]);
    assert.deepEqual(plannerEdgeEdits({ edges: [{ from: "check", to: "build", feedback: value }] }), [
      { from: "check", to: "build", feedback: true, delete: false },
    ]);
  }
  for (const value of ["FALSE", "False", "0", null]) {
    assert.deepEqual(plannerNodeEdits({ nodes: [{ id: "keep", task: "Work", delete: value }] }), [
      { id: "keep", task: "Work", delete: false },
    ]);
  }
  assert.deepEqual(plannerNodeEdits({ nodes: [{ id: null, task: "Literal null identity" }] }), [
    { id: "null", task: "Literal null identity", delete: false },
  ]);
  assert.deepEqual(plannerEdgeEdits({ edges: [{ from: null, to: "check" }] }), [
    { from: "null", to: "check", feedback: false, delete: false },
  ]);
});

test("Planner graph previews drain reordered results in invocation order and ignore duplicate delivery", () => {
  const queue = new PlannerGraphEditQueue();
  const first = { toolName: "edit_graph", args: { nodes: [{ id: "a", task: "Old" }] }, isError: false };
  const second = { toolName: "edit_graph", args: { nodes: [{ id: "a", task: "New" }] }, isError: false };
  queue.start("first");
  queue.start("second");
  assert.deepEqual(queue.finish("second", second), []);
  queue.start("second");
  assert.deepEqual(queue.finish("first", first), [first, second]);
  assert.deepEqual(queue.finish("first", first), []);
  assert.deepEqual(queue.finish("second", second), []);
  queue.clear();
  queue.start("first");
  assert.deepEqual(queue.finish("first", second), [second]);
});

test("Planner graph preview failures and interrupted turns do not block successors", () => {
  const queue = new PlannerGraphEditQueue();
  const failed = { toolName: "edit_graph", args: { nodes: [{ id: "bad" }] }, isError: true };
  const edge = { toolName: "edit_graph", args: { edges: [{ from: "b", to: "c" }] }, isError: false };
  queue.start("failed");
  queue.start("edge");
  assert.deepEqual(queue.finish("edge", edge), []);
  const ready = queue.finish("failed", failed);
  assert.deepEqual(ready, [failed, edge]);
  assert.deepEqual(ready.filter(result => !result.isError).flatMap(result => plannerEdgeEdits(result.args)), [
    { from: "b", to: "c", feedback: false, delete: false },
  ]);
  assert.deepEqual(queue.finish("tail-without-start", edge), [edge]);
  assert.deepEqual(queue.finish(undefined, edge), [edge]);
  queue.start("interrupted");
  queue.clear();
  assert.deepEqual(queue.finish("next-turn", edge), [edge]);
});

test("Planner graph previews ignore unusable arguments", () => {
  assert.deepEqual(plannerNodeEdits(undefined), []);
  assert.deepEqual(plannerNodeEdits("not json"), []);
  assert.deepEqual(plannerNodeEdits({ nodes: [null, "nope", { task: "missing id" }] }), []);
  assert.deepEqual(plannerEdgeEdits({ edges: [{ from: "a" }, { to: "b" }] }), []);
});
