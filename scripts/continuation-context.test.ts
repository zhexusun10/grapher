import assert from 'node:assert/strict';
import { test } from 'node:test';
import workspacePolicy from '../engine/prompt-extension.ts';

const marker = { role: 'custom', customType: 'grapher-interrupted-continuation', content: [] };
const user = { role: 'user', content: 'task' };
const toolCall = { role: 'assistant', stopReason: 'toolUse', timestamp: 42, content: [{ type: 'toolCall', id: 'call-1', name: 'bash' }] };
const toolResult = { role: 'toolResult', toolCallId: 'call-1', content: 'done' };
const final = { role: 'assistant', stopReason: 'stop', content: 'finished' };

function project(messages: unknown[], continuation = true) {
  const previousMode = process.env.GRAPHER_MODE;
  const previousContinuation = process.env.GRAPHER_CONTINUE_INTERRUPTED;
  const previousKind = process.env.GRAPHER_EXECUTION_KIND;
  try {
    process.env.GRAPHER_MODE = continuation ? 'partition' : 'node';
    process.env.GRAPHER_CONTINUE_INTERRUPTED = continuation ? 'true' : 'false';
    delete process.env.GRAPHER_EXECUTION_KIND;
    const hooks = new Map<string, (event: any) => any>();
    workspacePolicy({ registerTool() {}, on(name: string, handler: (event: any) => any) { hooks.set(name, handler); } } as any);
    return hooks.get('context')!({ messages }).messages;
  } finally {
    for (const [key, value] of Object.entries({ GRAPHER_MODE: previousMode,
      GRAPHER_CONTINUE_INTERRUPTED: previousContinuation, GRAPHER_EXECUTION_KIND: previousKind })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('continuing after a completed model turn preserves the full tool exchange', () => {
  assert.deepEqual(project([user, toolCall, toolResult, final, marker]), [user, toolCall, toolResult, final]);
  assert.deepEqual(project([user, final, marker]), [user, final], 'the private marker is never sent to the provider');
});

test('continuing an incomplete turn removes only the trailing incomplete protocol', () => {
  assert.deepEqual(project([user, toolCall, toolResult, marker]), [user, toolCall, toolResult],
    'a settled tool tail must not repeat already-executed work');
  const missing = project([user, toolCall, marker]);
  assert.deepEqual(missing.slice(0, 2), [user, toolCall]);
  assert.equal(missing[2].toolCallId, 'call-1');
  assert.equal(missing[2].isError, true);
  assert.match(missing[2].content[0].text, /side effects are unknown/);
  assert.deepEqual(project([user, marker, toolCall, marker]), missing, 'markers from earlier retries are removed too');
  const partialBatch = { ...toolCall, content: [...toolCall.content, { type: 'toolCall', id: 'call-2', name: 'write' }] };
  const partial = project([user, partialBatch, toolResult, marker]);
  assert.deepEqual(partial.slice(0, 3), [user, partialBatch, toolResult], 'recorded results remain paired with their calls');
  assert.equal(partial[3].toolCallId, 'call-2');
  assert.equal(partial[3].isError, true);
  assert.match(partial[3].content[0].text, /side effects are unknown/);
  const malformed = { ...toolCall, content: [{ type: 'toolCall', id: '', name: 'bash' }] };
  assert.deepEqual(project([user, malformed, toolResult, marker]), [user], 'malformed calls cannot leave orphan results');
  const failed = { role: 'assistant', stopReason: 'error', content: 'provider error' };
  assert.deepEqual(project([user, toolCall, toolResult, failed, marker]), [user, toolCall, toolResult]);
  const laterUser = { role: 'user', content: 'another turn' };
  assert.deepEqual(project([user, toolCall, toolResult, laterUser, marker]), [user, toolCall, toolResult, laterUser],
    'a prior turn must not be reinterpreted as the current interrupted turn');
});

test('later ordinary turns reconstruct missing-result warnings after reload', () => {
  const partialBatch = { ...toolCall, content: [...toolCall.content, { type: 'toolCall', id: 'call-2', name: 'write' }] };
  const laterUser = { role: 'user', content: 'follow-up' };
  const saved = [user, partialBatch, toolResult, final, laterUser];
  const projected = project(saved, false);
  assert.deepEqual(projected.slice(0, 3), [user, partialBatch, toolResult]);
  assert.equal(projected[3].toolCallId, 'call-2');
  assert.equal(projected[3].isError, true);
  assert.match(projected[3].content[0].text, /side effects are unknown/);
  assert.deepEqual(projected.slice(4), [final, laterUser]);
  assert.deepEqual(project(saved, false), projected, 'the warning is rebuilt without mutating stored history');
  assert.deepEqual(saved, [user, partialBatch, toolResult, final, laterUser]);
  assert.deepEqual(project([user, toolCall, toolResult, final, laterUser], false),
    [user, toolCall, toolResult, final, laterUser], 'complete exchanges are unchanged');
});
