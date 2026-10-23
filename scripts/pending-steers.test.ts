import assert from "node:assert/strict";
import test from "node:test";
import { isUncommittedSteer, nodeInstructionText, steerRollbackKey } from "../src/lib/pendingSteers.ts";
import type { ChatMessage } from "../src/types.ts";

const steer = (id: string, text: string, executionId: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, parentId: null, role: "user", text, node: "task", executionId, delivery: "steered", ...extra,
});

test("nodeInstructionText strips the addressing prefix", () => {
  assert.equal(nodeInstructionText("[@task] tighten the guard"), "tighten the guard");
  assert.equal(nodeInstructionText("plain instruction"), "plain instruction");
});

test("a steer absent from the transcript is uncommitted", () => {
  assert.equal(isUncommittedSteer(steer("msg-1", "[@task] run the tests", "exec-1"), {}), true);
});

test("a steer present in the transcript is committed", () => {
  const message = steer("msg-1", "[@task] run the tests", "exec-1");
  assert.equal(isUncommittedSteer(message, { "exec-1": ["run the tests"] }), false);
});

test("an unrelated transcript turn does not commit the steer", () => {
  const message = steer("msg-1", "[@task] run the tests", "exec-1");
  assert.equal(isUncommittedSteer(message, { "exec-1": ["some other turn"] }), true);
  assert.equal(isUncommittedSteer(message, { "exec-2": ["run the tests"] }), true,
    "a match in another execution's transcript is not this steer");
});

test("attachment steers are not rolled back by the text transcript check", () => {
  assert.equal(isUncommittedSteer(steer("msg-1", "[@task] inspect this", "exec-1", { files: [{ name: "a.ts" }] }), {}), false);
  assert.equal(isUncommittedSteer(steer("msg-1", "[@task] inspect this", "exec-1", { images: [{ type: "image", mimeType: "image/png", data: "" }] }), {}), false);
});

test("non-steer turns are never treated as uncommitted steers", () => {
  assert.equal(isUncommittedSteer({ id: "msg-1", role: "user", text: "task", delivery: "node_messaged" }, {}), false);
  assert.equal(isUncommittedSteer({ id: "msg-2", role: "user", text: "task" }, {}), false);
});

test("the rollback key is shared by the optimistic card and the durable event", () => {
  const optimistic = steer("msg-1", "[@task] run the tests", "exec-1");
  const durable = steer("event-9", "run the tests", "exec-1");
  assert.equal(steerRollbackKey(optimistic), steerRollbackKey(durable));
  assert.notEqual(steerRollbackKey(optimistic), steerRollbackKey(steer("event-9", "run the tests", "exec-2")),
    "a different execution must not share the key");
  assert.equal(steerRollbackKey({ id: "msg-2", role: "user", text: "task" }), null);
});
