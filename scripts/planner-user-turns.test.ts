import assert from "node:assert/strict";
import test from "node:test";
import { stripPlannerContext } from "../src/services/plannerText.ts";
import { plannerUserTurns } from "../src/services/plannerUserTurns.ts";

test("Planner status context is not shown as conversation text", () => {
  assert.equal(stripPlannerContext("Current graph node status:\n- worker: completed\n继续优化"), "继续优化");
  assert.equal(stripPlannerContext("Current graph node status:\n- worker: completed\n\n继续优化"), "继续优化");
  assert.equal(stripPlannerContext("User query:\n\nOriginal"), "Original");
  // Current and historical rework notes are transport context, not user text.
  for (const dependencyInput of ["the updated dependencies' project-file results", "the new dependency filesystem state"]) {
    assert.equal(
      stripPlannerContext(`Current graph node status:\nModifying a completed node's task re-runs that node in a fresh session and invalidates all its downstream dependents (they re-run their previous tasks with ${dependencyInput}); unrelated branches keep their results and history.\n- worker: completed\n\n继续优化`),
      "继续优化",
    );
  }
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

test("persisted user turns are not duplicated in follow-up message list during live planning continuation", () => {
  const plannerMessages = [
    { id: "msg-0", role: "user" as const, text: "Initial Goal" },
    { id: "msg-1", role: "user" as const, text: "Cut edge 22 to 09" },
    { id: "msg-2", role: "user" as const, text: "Will this affect our task?" },
  ];
  const savedPlannerOutput = [
    JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Initial Goal" }] } }),
    JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Cut edge 22 to 09" }] } }),
  ].join("\n");
  const turns = plannerUserTurns(savedPlannerOutput);
  if (turns[0] === plannerMessages[0]?.text.trim()) turns.shift();
  assert.deepEqual(turns, ["Cut edge 22 to 09"]);

  const remainingPersistedTurns = new Map<string, number>();
  for (const text of turns) {
    remainingPersistedTurns.set(text, (remainingPersistedTurns.get(text) ?? 0) + 1);
  }

  const useSavedPlanner = true;
  const renderLivePlanner = true;
  const plannerStreamItems = [
    { id: "msg-2", role: "user", content: "Will this affect our task?" },
  ];

  const visibleFollowUps = plannerMessages.slice(1).filter((msg) => {
    if (msg.node && msg.node !== "planner") return false;
    if (renderLivePlanner && plannerStreamItems.some((item) =>
      item.role === "user" && item.id === msg.id)) return false;
    if (useSavedPlanner) {
      const text = msg.text.trim();
      const count = remainingPersistedTurns.get(text) ?? 0;
      if (count > 0) {
        remainingPersistedTurns.set(text, count - 1);
        return false;
      }
    }
    return true;
  });

  // msg-1 is persisted in saved planner history and msg-2 is in live stream,
  // so neither should appear in visibleFollowUps (no duplicate user bubbles).
  assert.deepEqual(visibleFollowUps, []);
});

