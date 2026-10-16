import assert from "node:assert/strict";
import test from "node:test";
import { stripPlannerContext } from "../src/services/plannerText.ts";
import { plannerUserTurns } from "../src/services/plannerUserTurns.ts";

test("Planner status context is not shown as conversation text", () => {
  assert.equal(stripPlannerContext("Current graph node status:\n- worker: completed\n继续优化"), "继续优化");
  assert.equal(stripPlannerContext("Current graph node status:\n- worker: completed\n\n继续优化"), "继续优化");
  assert.equal(stripPlannerContext("User query:\n\nOriginal"), "Original");
  // Current prompts carry the rework note between the header and the node list.
  assert.equal(
    stripPlannerContext("Current graph node status:\nModifying a completed node's task re-runs that node in a fresh session and invalidates all its downstream dependents (they re-run their previous tasks with the new dependency filesystem state); unrelated branches keep their results and history.\n- worker: completed\n\n继续优化"),
    "继续优化",
  );
  // Legacy blocks carried the published-nodes paragraph before the status list.
  assert.equal(
    stripPlannerContext("Current graph node status:\nAlready published in this run: a, b. These nodes cannot be deleted; change their task to rework them.\n- a: completed\n- b: completed\n\n继续优化"),
    "继续优化",
  );
});

test("only completed Planner user turns replace optimistic messages", () => {
  const line = (type: string, content: string) => JSON.stringify({
    type, message: { role: "user", content: [{ type: "text", text: content }] },
  });
  assert.deepEqual(plannerUserTurns([
    line("message_start", "User query:\n\nOriginal"),
    line("message_end", "User query:\n\nOriginal"),
    line("message_start", "still pending"),
    line("message_end", "Current graph node status:\n- worker: completed\n\n继续优化"),
    "{incomplete",
  ].join("\n")), ["Original", "继续优化"]);
});

test("planner messages filter out node and merger-directed messages", () => {
  const messages = [
    { id: "msg-initial", role: "user" as const, text: "Initial Goal" },
    { id: "msg-planner-1", role: "user" as const, text: "Planner follow-up" },
    { id: "msg-merger-1", role: "user" as const, text: "[@merge:06_feature_qa] continue merge", node: "merge:06_feature_qa" },
    { id: "msg-node-1", role: "user" as const, text: "[@worker_node] fix tests", node: "worker_node" },
  ];
  const plannerMessages = messages.filter((msg) => !msg.node || msg.node === "planner");
  assert.deepEqual(plannerMessages.map(m => m.id), ["msg-initial", "msg-planner-1"]);
});
