import assert from "node:assert/strict";
import test from "node:test";
import { plannerContentSteerId, plannerContentText, plannerSteerId, stripPlannerContext } from "../src/services/plannerText.ts";
import { plannerSteerOwner, plannerSteerRows, planningOutputSteerIds, withoutPlannerSteerIdentity } from "../src/services/plannerSteers.ts";
import { plannerSteerContext } from "../engine/planner-steer.ts";
import { firstPlannerUserIsSteer, plannerHistoryMessageSources, plannerUserTurns, skipsFirstPersistedTurn, withoutLiveFirstTurn } from "../src/services/plannerUserTurns.ts";
import type { ChatMessage, PlanningSummary } from "../src/types.ts";

test("Planner status context is not shown as conversation text", () => {
  assert.equal(stripPlannerContext("Current graph node status:\n- worker: completed\n继续优化"), "继续优化");
  assert.equal(stripPlannerContext("You are now at backend's workspace. You can move to another node's workspace by outputting exactly one line containing only the target node name.\nCurrent graph node status:\n- worker: completed\n\nModifying a completed node's task re-runs that node in a fresh session and invalidates all its downstream dependents (they re-run their previous tasks with the updated dependencies' workspace states); unrelated branches keep their work.\n\n继续优化"), "继续优化");
  assert.equal(stripPlannerContext("You are now at backend's workspace. This is a retained workspace from a superseded or removed execution, not the pending node's current input. Your writes here are retained separately and are not automatically inherited by current graph nodes.\nCurrent graph node status:\n- worker: waiting\n\n继续优化"), "继续优化");
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

test("Planner user turns follow the transcript parser's start/end rules", () => {
  const line = (type: string, content: string, id?: string) => JSON.stringify({
    type, message: { id, role: "user", content: [{ type: "text", text: content }] },
  });
  // A start/end pair for one message renders once, from its start.
  assert.deepEqual(plannerUserTurns([
    line("message_start", "User query:\n\nOriginal", "m1"),
    line("message_end", "User query:\n\nOriginal", "m1"),
    line("message_start", "Current graph node status:\n- worker: completed\n\n继续优化", "m2"),
    line("message_end", "Current graph node status:\n- worker: completed\n\n继续优化", "m2"),
  ].join("\n")), ["Original", "继续优化"]);
  // A message_end without a start is still a rendered turn.
  assert.deepEqual(plannerUserTurns([line("message_end", "继续优化", "m3")].join("\n")), ["继续优化"]);
  // A turn aborted after its start was flushed persists no message_end. The
  // transcript parser still renders it, so it must count as a replacement for
  // the optimistic bubble instead of rendering the message twice.
  assert.deepEqual(plannerUserTurns([
    line("message_start", "User query:\n\nOriginal", "m4"),
    line("message_end", "User query:\n\nOriginal", "m4"),
    line("message_start", "stopped steer", "m5"),
    "{incomplete",
  ].join("\n")), ["Original", "stopped steer"]);
});

test("Planner user start/end matching resets at each revision boundary", () => {
  const marker = (id: string) => JSON.stringify({ type: "grapher_planning_source", planningId: id, startOffset: 0 });
  const user = (type: string, text: string) => JSON.stringify({ type, message: { id: "reused", role: "user", content: [{ type: "text", text }] } });
  assert.deepEqual(plannerUserTurns([marker("first"), user("message_start", "interrupted"),
    marker("second"), user("message_end", "next")].join("\n")), ["interrupted", "next"]);
});

test("cached follow-ups are matched only to their own unambiguous saved turn", () => {
  const messages: ChatMessage[] = [
    { id: "goal", role: "user", text: "Goal", timestamp: 100 },
    { id: "one", role: "user", text: "same", timestamp: 200 },
    { id: "two", role: "user", text: "same", timestamp: 400 },
    { id: "pending", role: "user", text: "same", timestamp: 600 },
    { id: "unknown-time", role: "user", text: "unknown" },
  ];
  const turn = (planningId: string, goal: string, createdAt: number): PlanningSummary => ({
    planningId, goal, createdAt, roles: {}, totalPlanningDuration: 0, modelDuration: 0,
  });
  const turns = [turn("first", "Goal", 110), turn("one", "same", 210), turn("review", "same", 250),
    turn("two", "<file name=\"a\">body</file>same", 410)];
  assert.deepEqual([...plannerHistoryMessageSources(messages, turns, turns.map(item => item.planningId), new Set(["review"]))],
    [["one", "one"], ["two", "two"]]);
  assert.deepEqual([...plannerHistoryMessageSources(messages, [...turns, turn("ambiguous", "same", 220)],
    [...turns.map(item => item.planningId), "ambiguous"], new Set(["review"]))], [["two", "two"]],
    "ambiguous timestamps must not claim an optimistic message");
  assert.deepEqual([...plannerHistoryMessageSources(messages, turns, ["first", "review"], new Set(["review"]))], [],
    "a matching review cannot be mistaken for an ordinary turn");
});

test("live continuation does not repeat the already rendered first turn", () => {
  const items: Array<{ id: string; role: string; content: string }> = [
    { id: "msg-0", role: "user", content: "Edited goal" },
    { id: "tool-1", role: "assistant", content: "" },
    { id: "msg-1", role: "user", content: "Follow-up" },
  ];
  assert.deepEqual(withoutLiveFirstTurn(items, "msg-0").map(item => item.id), ["tool-1", "msg-1"]);
  assert.deepEqual(withoutLiveFirstTurn(items, undefined).map(item => item.id), ["msg-0", "tool-1", "msg-1"]);
  // A different first id never hides a real follow-up user turn.
  assert.deepEqual(withoutLiveFirstTurn(items, "msg-initial-goal").map(item => item.id), ["msg-0", "tool-1", "msg-1"]);
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

test("a steer persisted only as message_start still suppresses its optimistic bubble after an interrupt", () => {
  // Pausing the Planner can leave the sent instruction in the durable JSONL as
  // a message_start without a message_end. The saved replay renders that row,
  // so the optimistic bubble must be treated as already represented.
  const savedPlannerOutput = [
    JSON.stringify({ type: "message_start", message: { id: "goal", role: "user", content: [{ type: "text", text: "Initial Goal" }] } }),
    JSON.stringify({ type: "message_end", message: { id: "goal", role: "user", content: [{ type: "text", text: "Initial Goal" }] } }),
    JSON.stringify({ type: "message_start", message: { id: "steer", role: "user", content: [{ type: "text", text: "Stopped steer" }] } }),
  ].join("\n");
  const persistedTurns = plannerUserTurns(savedPlannerOutput);
  assert.deepEqual(persistedTurns, ["Initial Goal", "Stopped steer"]);
  const remaining = new Map<string, number>([[persistedTurns[1], 1]]);
  const visible = ["Stopped steer"].filter((text) => {
    const count = remaining.get(text) ?? 0;
    if (count > 0) { remaining.set(text, count - 1); return false; }
    return true;
  });
  assert.deepEqual(visible, []);
});

test("a partial transcript window keeps a later steer when the header is absent", () => {
  assert.equal(skipsFirstPersistedTurn(["Initial goal", "Steer"], "Initial goal"), true);
  // A window that starts at a steer must not suppress that steer as if it were
  // the conversation header already rendered above the transcript.
  assert.equal(skipsFirstPersistedTurn(["Steer"], "Initial goal"), false);
  assert.equal(skipsFirstPersistedTurn(["Steer"], undefined), false);
  assert.equal(skipsFirstPersistedTurn([], "Initial goal"), false);
  // Editing a saved turn can persist the prompt's attachment XML even though
  // the conversation header shows only the clean text.
  assert.equal(skipsFirstPersistedTurn(['<file name="a.txt">content</file>Initial goal'], "Initial goal"), true);
  assert.equal(skipsFirstPersistedTurn(['<file name="a.txt">content</file>Steer'], "Initial goal"), false);
});

test("Planner transport identity survives replay but is absent from model context", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  const text = `Current graph node status:\n- worker: completed\n\ninspect 🚀\n\n<grapher-steer-id>${id}</grapher-steer-id>`;
  const image = { type: "image", mimeType: "image/png", data: "abc" };
  const messages = [{ role: "user", content: [{ type: "text", text }, image] },
    { role: "assistant", content: [{ type: "text", text }] }];
  const projected = plannerSteerContext(messages);
  assert.equal(projected[0].content[0].text, text.replace(/\n\n<grapher-steer-id>.*$/, ""));
  assert.equal(projected[0].content[1], image);
  assert.equal(projected[1], messages[1], "assistant output is never rewritten");
  assert.equal(plannerSteerId(text), id);
  const extended = [{ type: "text", text }, { type: "text", text: "extension note" }];
  assert.equal(plannerContentSteerId(extended), id, "a later extension text block does not hide the identity");
  assert.equal(stripPlannerContext(plannerContentText(extended)), "inspect 🚀\nextension note");
  assert.equal(plannerContentSteerId([...extended, { type: "text", text: `other\n\n<grapher-steer-id>12345678-1234-4234-8234-123456789abd</grapher-steer-id>` }]), undefined,
    "conflicting identities do not prove which request was consumed");
  assert.equal(stripPlannerContext(text), "inspect 🚀");
  const output = JSON.stringify({ type: "message_start", message: messages[0] });
  assert.deepEqual(plannerUserTurns(output), ["inspect 🚀"]);
  assert.equal(firstPlannerUserIsSteer(output), true, "a partial window's marked steer is never the header, even with identical text");
  assert.equal(firstPlannerUserIsSteer(JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "inspect 🚀" }] } }) + "\n" + output), false);
  assert.deepEqual([...planningOutputSteerIds(output)], [id]);
  assert.equal(planningOutputSteerIds(JSON.stringify({ type: "queue_update", steering: [text] })).size, 0,
    "a queued marker in Pi's queue update is not a consumed transcript row");
  assert.equal(planningOutputSteerIds(JSON.stringify({ type: "agent_end", messages: [messages[0]] })).size, 0,
    "an aggregate event does not itself render the user turn");
  assert.equal(stripPlannerContext("literal <grapher-steer-id>not-a-uuid</grapher-steer-id>"),
    "literal <grapher-steer-id>not-a-uuid</grapher-steer-id>");
});

test("editing or branching a steer starts a new turn without its delivery identity", () => {
  const steer = { id: "msg-1", role: "user" as const, text: "inspect",
    plannerSteerId: "12345678-1234-4234-8234-123456789abc", plannerSteerStatus: "consumed" as const,
    plannerSteerError: "stale" };
  const edited = withoutPlannerSteerIdentity({ ...steer, text: "edited" });
  assert.equal(edited.plannerSteerId, undefined);
  assert.equal(edited.plannerSteerStatus, undefined);
  assert.equal(edited.plannerSteerError, undefined);
  assert.equal(edited.text, "edited");
  assert.equal(steer.plannerSteerId, "12345678-1234-4234-8234-123456789abc", "the pending card is not mutated");
  const plain = { id: "msg-2", role: "user" as const, text: "goal" };
  assert.equal(withoutPlannerSteerIdentity(plain), plain, "a message without identity is reused");
});

test("repeated Planner steers hand off by ID, not by equal text", () => {
  const ids = ["12345678-1234-4234-8234-123456789abc", "12345678-1234-4234-8234-123456789abd"];
  const messages = ids.map(id => ({ id: `msg-${id}`, role: "user" as const, text: "again", plannerSteerId: id }));
  const events = [
    ...ids.map((request_id, i) => ({ type: "planner_steer_submitted", sequence: i + 1, timestamp: i + 1,
      planning_id: "turn", request_id, instruction: "again" })),
    { type: "planner_steer_status", sequence: 3, timestamp: 3, planning_id: "turn", request_id: ids[0], status: "consumed" },
    { type: "planner_steer_status", sequence: 4, timestamp: 4, planning_id: "turn", request_id: ids[1], status: "queued" },
  ];
  const options = { planning: true, activePlanningId: "turn", visibleIds: new Set([ids[0]]) };
  assert.deepEqual(plannerSteerRows(events, messages, options).map(row => [row.id, row.status]), [[ids[1], "queued"]]);
  assert.deepEqual(plannerSteerRows(events, [], { ...options, planning: false, visibleIds: new Set<string>() })
    .map(row => [row.id, row.status]), [[ids[1], "unknown"]], "reload/stop never silently retries an uncertain steer");
  assert.deepEqual(plannerSteerRows(events, messages, { ...options, visibleIds: new Set<string>() })
    .map(row => row.status), ["consumed", "queued"], "a consumed optimistic turn remains until its own row appears");
  assert.deepEqual(plannerSteerRows(events, messages, { ...options, planning: false, visibleIds: new Set<string>() })
    .map(row => row.status), ["unknown"],
    "a settled turn's consumed handoff card does not outlive a tail window that starts later");
});

test("a rejected Planner steer returns to the composer instead of staying as a card", () => {
  const rejected = "12345678-1234-4234-8234-123456789abc";
  const delivered = "12345678-1234-4234-8234-123456789abd";
  const events = [
    { type: "planner_steer_submitted", sequence: 1, timestamp: 1, planning_id: "turn", request_id: rejected, instruction: "refused" },
    { type: "planner_steer_status", sequence: 2, timestamp: 2, planning_id: "turn", request_id: rejected, status: "failed", error: "prompt rejected" },
    { type: "planner_steer_submitted", sequence: 3, timestamp: 3, planning_id: "turn", request_id: delivered, instruction: "accepted" },
    { type: "planner_steer_status", sequence: 4, timestamp: 4, planning_id: "turn", request_id: delivered, status: "queued" },
  ];
  const options = { planning: true, activePlanningId: "turn", visibleIds: new Set<string>() };
  assert.deepEqual(plannerSteerRows(events, [], options).map(row => [row.id, row.status]),
    [[rejected, "failed"], [delivered, "queued"]],
    "a refused steer stays visible only until the client that sent it returns the text");
  const reverted = new Set([rejected]);
  assert.deepEqual(plannerSteerRows(events, [], { ...options, revertedIds: reverted }).map(row => [row.id, row.status]),
    [[delivered, "queued"]], "the draft owns the rejected instruction, so no card repeats it");
  const local = [{ id: `msg-${rejected}`, role: "user" as const, text: "refused", plannerSteerId: rejected }];
  assert.deepEqual(plannerSteerRows(events, local, { ...options, revertedIds: reverted }).map(row => row.id), [delivered],
    "a card the composer already owns is not rebuilt from the durable submission");
  assert.deepEqual(plannerSteerRows(events, local, options).map(row => row.id), [rejected, delivered],
    "an async rejection still keeps the card when its draft never returned");
});

test("a Planner steer send has exactly one owner", () => {
  assert.equal(plannerSteerOwner({ recorded: true, status: "queued" }), "pending");
  assert.equal(plannerSteerOwner({ recorded: true, status: "consumed" }), "pending");
  assert.equal(plannerSteerOwner({ recorded: true, status: "submitted" }), "pending");
  assert.equal(plannerSteerOwner({ recorded: true, status: "unknown" }), "pending",
    "a recorded but uncertain turn stays a card rather than an editable draft");
  assert.equal(plannerSteerOwner({ recorded: true, status: "failed" }), "composer",
    "an RPC rejection delivered nothing, so its text goes back to the input");
  assert.equal(plannerSteerOwner({ recorded: false, status: "unknown" }), "composer",
    "a submission the durable record never showed is still the user's draft");
  assert.equal(plannerSteerOwner({ recorded: false, legacy: true }), "pending",
    "an older backend without request IDs keeps its optimistic behavior");
});
