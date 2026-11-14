import assert from "node:assert/strict";
import test from "node:test";
import { projectLiveSteerWithdrawals, projectWithdrawnSteers, inlineSteerKey, isPendingSteer, isUncommittedSteer, liveSteerConsumed, nodeInstructionText, numberSteers, steerFallbackPosition, steerRollbackKey, type InlineUserTurnWindow, type LiveSteerMarker } from "../src/lib/pendingSteers.ts";
import { ComposerDrafts } from "../src/services/composerDrafts.ts";
import { newExecutionSteer } from "../src/services/plannerSteers.ts";
import { emptySnapshot, type ChatMessage } from "../src/types.ts";

const steer = (id: string, text: string, executionId: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, parentId: null, role: "user", text, node: "task", executionId, delivery: "steered", ...extra,
});
const window = (texts: string[], complete = true): Record<string, InlineUserTurnWindow> => ({ "exec-1": { texts, complete } });

test("confirmed withdrawals remove only their exact optimistic duplicate and renumber resends", () => {
  const events = [1, 2, 3].map(sequence => ({ type: "steered", sequence, timestamp: sequence,
    execution_id: "exec-1", instruction: "again", request_id: `request-${sequence}` }));
  const source = { ...emptySnapshot, events: [...events,
    { type: "steers_withdrawn", sequence: 4, timestamp: 4, execution_id: "exec-1", message_sequences: [2] }] };
  const messages = numberSteers([steer("first", "again", "exec-1", { steerRequestId: "request-1" }),
    steer("withdrawn", "again", "exec-1", { steerRequestId: "request-2" }),
    steer("resent", "again", "exec-1", { steerRequestId: "request-3" }), steer("other", "again", "exec-2")]);
  const projected = projectWithdrawnSteers(source, messages);
  assert.deepEqual(projected.messages.map(message => [message.id, message.inlineSteerOrdinal]), [["first", 0], ["resent", 1], ["other", 0]]);
  assert.deepEqual(projected.state.events.map(event => event.sequence), [1, 3, 4]);
  assert.equal(isUncommittedSteer(projected.messages[1], window(["again"])), true);
  assert.equal(isUncommittedSteer(projected.messages[1], window(["again", "again"])), false);
  assert.equal(source.events.length, 4, "projection never rewrites durable history");
  assert.equal(projectWithdrawnSteers(source, []).state.events.length, 3, "reload hides the withdrawn card without local state");
});

test("Merger edits and version resends have fresh, withdrawable delivery identities", () => {
  const original: ChatMessage = { id: "event-1", role: "user", text: "old", node: "merge:join", executionId: "exec-1",
    delivery: "steered", steerRequestId: "old-request", steerOrdinal: 7, inlineSteerOrdinal: 8,
    versions: [{ id: "version-1", text: "old", timestamp: 1 }], currentVersionIndex: 0 };
  const copy = newExecutionSteer({ ...original, text: "edited" }, "exec-1", "new-request");
  assert.equal(copy.steerRequestId, "new-request");
  assert.equal(copy.delivery, "steered");
  assert.equal(copy.steerOrdinal, undefined);
  assert.equal(copy.inlineSteerOrdinal, undefined);
  assert.equal(copy.versions, original.versions);
  const source = { ...emptySnapshot, events: [
    { type: "steered", sequence: 1, timestamp: 1, execution_id: "exec-1", instruction: "old", request_id: "old-request" },
    { type: "steered", sequence: 2, timestamp: 2, execution_id: "exec-1", instruction: "edited", request_id: "new-request" },
    { type: "steers_withdrawn", sequence: 3, timestamp: 3, message_sequences: [1] },
  ] };
  assert.equal(projectWithdrawnSteers(source, [copy]).messages.length, 1, "the old event-shaped UI ID cannot override the new request ID");
  source.events.push({ type: "steers_withdrawn", sequence: 4, timestamp: 4, message_sequences: [2] });
  assert.deepEqual(projectWithdrawnSteers(source, [copy]).messages, []);
  assert.notEqual(newExecutionSteer(original, "exec-1").steerRequestId, newExecutionSteer(original, "exec-1").steerRequestId);
  assert.equal(original.steerRequestId, "old-request", "history must not be mutated");
});

test("pause rollback keeps the same identity before and after withdrawal renumbers duplicates", () => {
  const events = [1, 2, 3].map(sequence => ({ type: "steered", sequence, timestamp: sequence,
    execution_id: "exec-1", instruction: "again", request_id: `request-${sequence}` }));
  const source = { ...emptySnapshot, events: [...events,
    { type: "steers_withdrawn", sequence: 4, timestamp: 4, message_sequences: [2] }] };
  const raw = steer("latest", "again", "exec-1", { steerRequestId: "request-3", steerOrdinal: 2, inlineSteerOrdinal: 2 });
  const projected = projectWithdrawnSteers(source, [raw]).messages[0];
  assert.equal(projected.steerOrdinal, 1);
  assert.equal(steerRollbackKey(raw), steerRollbackKey(projected), "Pause must remove the raw optimistic copy, not a withdrawn predecessor");
});

test("withdrawal uses IDs even when a local copy has rewritten text or a stale ordinal", () => {
  const events = [1, 2].map(sequence => ({ type: "steered", sequence, timestamp: sequence,
    execution_id: "exec-1", instruction: "same", request_id: `request-${sequence}` }));
  const source = { ...emptySnapshot, events: [...events,
    { type: "steers_withdrawn", sequence: 3, timestamp: 3, message_sequences: [2] }] };
  const messages = [steer("read", "same", "exec-1", { steerRequestId: "request-1", inlineSteerOrdinal: 1 }),
    steer("queued", "rewritten local text", "exec-1", { steerRequestId: "request-2", inlineSteerOrdinal: 0 }),
    steer("unconfirmed", "same", "exec-1", { inlineSteerOrdinal: 1 })];
  assert.deepEqual(projectWithdrawnSteers(source, messages).messages.map(message => message.id), ["read", "unconfirmed"]);
  const markers = messages.slice(0, 2).map(message => ({ key: inlineSteerKey(message)!, requestId: message.steerRequestId,
    executionId: "exec-1", text: message.text, afterOffset: 100, occurrence: 1 }));
  assert.deepEqual(projectLiveSteerWithdrawals(markers, source.events, new Set()), [markers[0]]);
});

test("withdrawal preserves consumed attachment cursors and unrelated node handoffs", () => {
  const make = (executionId: string, ordinal: number): LiveSteerMarker => ({ executionId, text: "same", key: `${executionId}\u0000same\u0000${ordinal}`, afterOffset: 100, occurrence: ordinal + 1 });
  const consumed = { ...make("node-a", 0), images: [{ type: "image" as const, data: "image", mimeType: "image/png" }] };
  const unrelated = make("node-b", 0);
  const events = [1, 2, 3].map(sequence => ({ sequence, timestamp: sequence, type: "steered", execution_id: "node-a", instruction: "same" }));
  const projected = projectLiveSteerWithdrawals([consumed, make("node-a", 1), make("node-a", 2), unrelated], [...events,
    { sequence: 4, timestamp: 4, type: "steers_withdrawn", message_sequences: [2] }], new Set());
  assert.equal(projected[0], consumed, "its image handoff must not disappear or rebuild a duplicate outer card");
  assert.equal(projected[2], unrelated);
  assert.equal(projected[1].key, "node-a\u0000same\u00001");
  assert.equal(projected[1].occurrence, 2);
});

test("recall completion belongs to the shared draft, not the original mounted composer", async () => {
  const drafts = new ComposerDrafts();
  drafts.set("first", "original");
  drafts.set("other", "unrelated");
  const image = { type: "image" as const, data: "image", mimeType: "image/png" };
  let complete!: (messages: Array<{ text: string; images: typeof image[] }>) => void;
  const pending = drafts.withdraw("first", () => new Promise(resolve => { complete = resolve; }));
  assert.equal(drafts.recall("first").pending, true);
  assert.equal(drafts.recall("other").pending, false);
  assert.equal(drafts.withdraw("first", async () => { assert.fail("duplicate request"); }), pending);
  await Promise.resolve();
  drafts.set("first", "newer draft after switching views");
  complete([{ text: "recalled", images: [image] }]);
  await pending;
  assert.equal(drafts.get("first"), "newer draft after switching views\n\nrecalled");
  assert.equal(drafts.get("other"), "unrelated");
  assert.deepEqual(drafts.recall("first").images, [image]);
  drafts.delete("first");
  assert.deepEqual(drafts.recall("first").images, [image], "editing text to empty retains image-only input");
  assert.equal(drafts.recall("first").pending, false);
});

test("a failed recall retries its request identity and restores its receipt only once", async () => {
  const drafts = new ComposerDrafts();
  drafts.set("view", "draft");
  const ids: string[] = [];
  await assert.rejects(drafts.withdraw("view", async id => { ids.push(id); throw new Error("response lost"); }), /response lost/);
  assert.equal(drafts.get("view"), "draft");
  assert.equal(drafts.recall("view").pending, false);
  await drafts.withdraw("view", async id => { ids.push(id); return [{ text: "queued" }]; });
  assert.equal(ids[0], ids[1]);
  assert.equal(drafts.get("view"), "draft\n\nqueued");
  await drafts.withdraw("view", async id => { ids.push(id); return []; });
  assert.notEqual(ids[1], ids[2], "only a successful receipt permits a new recall");
  assert.equal(drafts.get("view"), "draft\n\nqueued");
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
