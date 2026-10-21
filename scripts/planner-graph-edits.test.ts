import assert from "node:assert/strict";
import test from "node:test";
import { plannerEdgeEdits, plannerNodeEdits } from "../src/lib/plannerGraphEdits.ts";

test("Planner node previews accept every backend-tolerated edit shape", () => {
  const edit = { name: "worker", task: "Do the work" };
  for (const args of [
    { nodes: [edit] },
    { nodes: edit },
    { nodes: JSON.stringify([edit]) },
    { nodes: JSON.stringify(edit) },
    edit,
    JSON.stringify({ nodes: [edit] }),
    { nodes: [], ...edit },
    [edit],
    JSON.stringify([edit]),
  ]) {
    assert.deepEqual(plannerNodeEdits(args), [{ ...edit, delete: false }], JSON.stringify(args));
  }
});

test("Planner edge previews accept every backend-tolerated edit shape", () => {
  const edit = { from: "a", to: "b" };
  for (const args of [
    { edges: [edit] },
    { edges: edit },
    { edges: JSON.stringify([edit]) },
    { edges: JSON.stringify(edit) },
    edit,
    JSON.stringify({ edges: [edit] }),
    { edges: [], ...edit },
    [edit],
    JSON.stringify([edit]),
  ]) {
    assert.deepEqual(plannerEdgeEdits(args), [{ ...edit, feedback: false, delete: false }], JSON.stringify(args));
  }
});

test("Planner graph previews mirror backend primitive coercion", () => {
  assert.deepEqual(plannerNodeEdits({ nodes: [{ name: 7, task: 42, delete: "true" }, { name: "x", delete: 0 }] }), [
    { name: "7", task: "42", delete: true },
    { name: "x", task: "", delete: false },
  ]);
  assert.deepEqual(plannerEdgeEdits({ edges: [{ from: "a", to: "b", feedback: 1 }, { from: "b", to: "c", delete: "true" }] }), [
    { from: "a", to: "b", feedback: true, delete: false },
    { from: "b", to: "c", feedback: false, delete: true },
  ]);
});

test("Planner graph previews ignore unusable arguments", () => {
  assert.deepEqual(plannerNodeEdits(undefined), []);
  assert.deepEqual(plannerNodeEdits("not json"), []);
  assert.deepEqual(plannerNodeEdits({ nodes: [null, "nope", { task: "missing name" }] }), []);
  assert.deepEqual(plannerEdgeEdits({ edges: [{ from: "a" }, { to: "b" }] }), []);
});
