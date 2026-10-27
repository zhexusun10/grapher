import assert from "node:assert/strict";
import test from "node:test";
import { inlineSteerKey, isPendingSteer, isUncommittedSteer, liveSteerConsumed, nodeInstructionText, numberSteers, steerFallbackPosition, steerRollbackKey, type InlineUserTurnWindow, type LiveSteerMarker } from "../src/lib/pendingSteers.ts";
import type { ChatMessage } from "../src/types.ts";

const steer = (id: string, text: string, executionId: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, parentId: null, role: "user", text, node: "task", executionId, delivery: "steered", ...extra,
});
const window = (texts: string[], complete = true): Record<string, InlineUserTurnWindow> => ({ "exec-1": { texts, complete } });

test("nodeInstructionText strips the addressing prefix", () => {
  assert.equal(nodeInstructionText("[@task] tighten the guard"), "tighten the guard");
  assert.equal(nodeInstructionText("plain instruction"), "plain instruction");
});

test("a steer absent from the transcript is uncommitted", () => {
  assert.equal(isUncommittedSteer(steer("msg-1", "[@task] run the tests", "exec-1"), {}), true);
});

test("a steer present in the transcript is committed", () => {
  const message = steer("msg-1", "[@task] run the tests", "exec-1");
  assert.equal(isUncommittedSteer(message, window(["run the tests"])), false);
});

test("an unrelated transcript turn does not commit the steer", () => {
  const message = steer("msg-1", "[@task] run the tests", "exec-1");
  assert.equal(isUncommittedSteer(message, window(["some other turn"])), true);
  assert.equal(isUncommittedSteer(message, { "exec-2": { texts: ["run the tests"], complete: true } }), true,
    "a match in another execution's transcript is not this steer");
});

test("a partially loaded transcript cannot prove a steer was consumed", () => {
  // The tail page only carries the second identical turn, so it cannot show
  // whether Pi consumed the first. Rolling the card back would resend work.
  const messages = numberSteers([steer("event-1", "again", "exec-1"), steer("msg-2", "again", "exec-1")]);
  const partial = window(["again"], false);
  assert.equal(isUncommittedSteer(messages[1], partial), false, "an unprovable turn is never rolled back");
  assert.equal(isPendingSteer(messages[1], partial), false, "a text already inline does not grow a duplicate card");
  assert.equal(isPendingSteer(messages[0], partial), false, "the loaded turn keeps both cards suppressed");
  assert.equal(isUncommittedSteer(messages[1], window(["again"])), true, "a complete window proves the later turn is unread");
});

test("attachment steers are not rolled back by the text transcript check", () => {
  assert.equal(isUncommittedSteer(steer("msg-1", "[@task] inspect this", "exec-1", { files: [{ name: "a.ts" }] }), {}), false);
  assert.equal(isUncommittedSteer(steer("msg-1", "[@task] inspect this", "exec-1", { images: [{ type: "image", mimeType: "image/png", data: "" }] }), {}), false);
});

test("non-steer turns are never treated as uncommitted steers", () => {
  assert.equal(isUncommittedSteer({ id: "msg-1", role: "user", text: "task", delivery: "node_messaged" }, {}), false);
  assert.equal(isUncommittedSteer({ id: "msg-2", role: "user", text: "task" }, {}), false);
});

test("an earlier identical Steer does not commit or roll back a later unread occurrence", () => {
  const messages = numberSteers([steer("event-1", "again", "exec-1"), steer("msg-2", "again", "exec-1")]);
  assert.deepEqual(messages.map(message => message.steerOrdinal), [0, 1]);
  const parsed = window(["again"]);
  assert.equal(isUncommittedSteer(messages[0], parsed), false);
  assert.equal(isUncommittedSteer(messages[1], parsed), true);
  assert.equal(isPendingSteer(messages[0], parsed), false);
  assert.equal(isPendingSteer(messages[1], parsed), true);
  assert.notEqual(steerRollbackKey(messages[0]), steerRollbackKey(messages[1]));
  const accepted = numberSteers([steer("event-1", "again", "exec-1"), steer("event-2", "again", "exec-1")]);
  assert.equal(steerRollbackKey(messages[1]), steerRollbackKey(accepted[1]));
  assert.equal(isUncommittedSteer(accepted[1], window(["again", "again"])), false);
});

test("live unread steers follow the transcript until their inline turn appears", () => {
  const messages = numberSteers([steer("event-1", "again", "exec-1"), steer("msg-2", "again", "exec-1")]);
  assert.equal(steerFallbackPosition(messages[1], {}, true), "after");
  assert.equal(steerFallbackPosition(messages[0], window(["again"]), true), null);
  assert.equal(steerFallbackPosition(messages[1], window(["again"]), true), "after");
  assert.equal(steerFallbackPosition(messages[1], window(["again", "again"]), true), null);
  assert.equal(steerFallbackPosition(messages[1], window(["again"]), false), "after",
    "settling before the transcript catches up must not move the queued card above the output");
  assert.equal(steerFallbackPosition(messages[1], {}, false), "before",
    "an unloaded settled transcript remains a historical fallback");
  assert.equal(steerFallbackPosition(messages[1], window(["again"]), true, false), "before");
});

test("unloaded history and attachment cards retain their fallback position", () => {
  const message = steer("event-1", "older", "exec-1");
  assert.equal(steerFallbackPosition(message, window(["other"], false), true), "before");
  assert.equal(steerFallbackPosition(message, window(["older"], false), true), null);
  const attached = steer("msg-2", "inspect", "exec-1", { files: [{ name: "a.ts" }] });
  assert.equal(steerFallbackPosition(attached, {}, true), "before");
  assert.equal(steerFallbackPosition(attached, {}, false), "before");
});

test("live cursors distinguish new repeated turns from partial history and survive settlement", () => {
  const [first, second] = numberSteers([steer("msg-1", "again", "exec-1"), steer("msg-2", "again", "exec-1")]);
  const marker: LiveSteerMarker = { key: inlineSteerKey(second)!, executionId: "exec-1", text: "again", afterOffset: 100, occurrence: 2 };
  const partial = { "exec-1": { complete: false, texts: ["again"], end: 100, turns: [{ text: "again", offset: 40 }] } };
  assert.equal(steerFallbackPosition(second, partial, true, true, marker), "after");
  assert.equal(steerFallbackPosition(second, partial, false, true, marker), "after");
  const oneNew = { "exec-1": { ...partial["exec-1"], turns: [...partial["exec-1"].turns, { text: "again", offset: 100 }] } };
  assert.equal(liveSteerConsumed(marker, oneNew["exec-1"]), false);
  const twoNew = { "exec-1": { ...oneNew["exec-1"], turns: [...oneNew["exec-1"].turns, { text: "again", offset: 130 }] } };
  assert.equal(steerFallbackPosition(second, twoNew, false, true, marker), null);
  assert.notEqual(inlineSteerKey(first), inlineSteerKey(second));
});

test("live attachments use inline cursors without changing text-only rollback ordinals", () => {
  const [image, text] = numberSteers([
    steer("image", "inspect", "exec-1", { images: [{ type: "image", mimeType: "image/png", data: "abc" }] }),
    steer("text", "inspect", "exec-1"),
  ]);
  assert.equal(text.steerOrdinal, 0);
  assert.equal(text.inlineSteerOrdinal, 1);
  const marker: LiveSteerMarker = { key: inlineSteerKey(image)!, executionId: "exec-1", text: "inspect", afterOffset: 20, occurrence: 1 };
  assert.equal(steerFallbackPosition(image, {}, true, true, marker), "after");
  assert.equal(steerFallbackPosition(image, { "exec-1": { complete: false, texts: ["inspect"], turns: [{ text: "inspect", offset: 21 }] } }, false, true, marker), null);
});

test("the rollback key is shared by the optimistic card and the durable event", () => {
  const optimistic = steer("msg-1", "[@task] run the tests", "exec-1");
  const durable = steer("event-9", "run the tests", "exec-1");
  assert.equal(steerRollbackKey(optimistic), steerRollbackKey(durable));
  assert.notEqual(steerRollbackKey(optimistic), steerRollbackKey(steer("event-9", "run the tests", "exec-2")),
    "a different execution must not share the key");
  assert.equal(steerRollbackKey({ id: "msg-2", role: "user", text: "task" }), null);
});
