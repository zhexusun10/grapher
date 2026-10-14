import assert from "node:assert/strict";
import test from "node:test";
import { stripPlannerContext } from "../src/services/plannerText.ts";
import { plannerUserTurns } from "../src/services/plannerUserTurns.ts";

test("Planner status context is not shown as conversation text", () => {
  assert.equal(stripPlannerContext("Current graph node status:\n- worker: done\n继续优化"), "继续优化");
  assert.equal(stripPlannerContext("Current graph node status:\n- worker: done\n\n继续优化"), "继续优化");
  assert.equal(stripPlannerContext("User query:\n\nOriginal"), "Original");
});

test("only completed Planner user turns replace optimistic messages", () => {
  const line = (type: string, content: string) => JSON.stringify({
    type, message: { role: "user", content: [{ type: "text", text: content }] },
  });
  assert.deepEqual(plannerUserTurns([
    line("message_start", "User query:\n\nOriginal"),
    line("message_end", "User query:\n\nOriginal"),
    line("message_start", "still pending"),
    line("message_end", "Current graph node status:\n- worker: done\n\n继续优化"),
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
