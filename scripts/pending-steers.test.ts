import assert from "node:assert/strict";
import test from "node:test";
import { isPendingSteer, isUncommittedSteer, nodeInstructionText, numberSteers, steerRollbackKey, type InlineUserTurnWindow } from "../src/lib/pendingSteers.ts";
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

test("the rollback key is shared by the optimistic card and the durable event", () => {
  const optimistic = steer("msg-1", "[@task] run the tests", "exec-1");
  const durable = steer("event-9", "run the tests", "exec-1");
  assert.equal(steerRollbackKey(optimistic), steerRollbackKey(durable));
  assert.notEqual(steerRollbackKey(optimistic), steerRollbackKey(steer("event-9", "run the tests", "exec-2")),
    "a different execution must not share the key");
  assert.equal(steerRollbackKey({ id: "msg-2", role: "user", text: "task" }), null);
});
