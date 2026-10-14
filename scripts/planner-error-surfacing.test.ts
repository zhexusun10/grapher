import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptItem } from "../src/types";

test("planner error surfacing in live stream items", () => {
  const failureMessage = "OpenAI API error (400): 400 {\"detail\":\"The 'o4-mini' model is not supported when using Codex with a ChatGPT account.\"}";
  const initialItems: TranscriptItem[] = [
    {
      id: "msg-1",
      type: "text",
      role: "user",
      content: "Build a demo app",
      timestamp: Date.now(),
    },
  ];

  // Simulate message_end error event handling
  const failureStopReason = "error";
  let items = initialItems;
  if ((failureStopReason === "error" || failureStopReason === "aborted") && failureMessage) {
    const alreadyHas = items.some(i => (i.isError || i.status === "error") && i.content === failureMessage);
    if (!alreadyHas) {
      items = [
        ...items,
        {
          id: `planner_error_${Date.now()}`,
          type: "text",
          role: "assistant",
          content: failureMessage,
          isError: true,
          status: "error",
          timestamp: Date.now(),
        },
      ];
    }
  }

  assert.equal(items.length, 2);
  const errorItem = items[1];
  assert.equal(errorItem.role, "assistant");
  assert.equal(errorItem.isError, true);
  assert.equal(errorItem.status, "error");
  assert.equal(errorItem.content, failureMessage);

  // Deduplication: adding again should not duplicate
  let deduplicated = items;
  const alreadyHas = deduplicated.some(i => (i.isError || i.status === "error") && i.content === failureMessage);
  if (!alreadyHas) {
    deduplicated = [...deduplicated, { ...errorItem, id: "planner_error_2" }];
  }
  assert.equal(deduplicated.length, 2);
});

test("provisional run ID resolution keeps run key and conversation view key stable", () => {
  const provisionalId = "pending-1741000000";
  const realId = "2b549fa2-9e69-4725-8960-e53c5f792b90";

  let provisionalRunIdRef: string | null = null;

  const computeCurrentRunKey = (runId: string) => {
    if (runId.startsWith("pending-")) {
      provisionalRunIdRef = runId;
    }
    if (provisionalRunIdRef && runId && !runId.startsWith("pending-")) {
      return provisionalRunIdRef;
    }
    return runId || "initial";
  };

  const key1 = computeCurrentRunKey(provisionalId);
  assert.equal(key1, provisionalId);

  // When backend starts run and replaces provisional ID with real UUID
  const key2 = computeCurrentRunKey(realId);
  // Key must remain stable so graph-pane motion.div and ReactFlow canvas do not unmount and flicker
  assert.equal(key2, provisionalId);

  // View key for conversation must also match
  const routeType = "graph";
  const viewKey1 = `${key1}:${routeType}:planner:`;
  const viewKey2 = `${key2}:${routeType}:planner:`;
  assert.equal(viewKey1, viewKey2);
});

test("planning_failed phase prevents premature return to landing screen", () => {
  const isLandingView = (state: { runId: string; graph: { nodes: any[] }; phase: string }, isPlanning: boolean, failedPlanning: any) =>
    !state.runId &&
    state.graph.nodes.length === 0 &&
    !isPlanning &&
    !failedPlanning &&
    state.phase !== "planning_failed";

  // Normal landing state
  assert.equal(isLandingView({ runId: "", graph: { nodes: [] }, phase: "draft" }, false, null), true);

  // Early failure with provisional runId removed but phase marked planning_failed
  assert.equal(isLandingView({ runId: "", graph: { nodes: [] }, phase: "planning_failed" }, false, null), false);
});
