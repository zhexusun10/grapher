import assert from 'node:assert/strict';
import { test } from 'node:test';
import continuity from '../node_modules/pi-continuity/extensions/index.ts';

test('pi-continuity omits the interrupted assistant and matching tool results without model text', async () => {
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  continuity({ registerFlag() {}, registerCommand() {}, on(name: string, handler: (event: any, ctx: any) => any) {
    hooks.set(name, handler);
  } } as any);
  const failed = { role: 'assistant', stopReason: 'error', errorMessage: 'ECONNRESET', content: [] };
  const toolResult = { role: 'toolResult', toolCallId: 'call-1', content: 'done' };
  const result = await hooks.get('turn_end')!({ message: failed, messageEntryId: 'assistant',
    toolResultEntryIds: ['tool'], outcome: 'error', entries: [], continue: false,
    context: { pendingMessages: [], contextEntries: [
      { sourceEntry: { id: 'assistant', type: 'message' }, messages: [failed] },
      { sourceEntry: { id: 'tool', type: 'message' }, messages: [toolResult] },
    ] } }, { mode: 'rpc', hasUI: false, signal: undefined, hasPendingMessages: () => false });
  assert.deepEqual(result.entries, [
    { type: 'context_edit', targetId: 'assistant', replacement: null },
    { type: 'context_edit', targetId: 'tool', replacement: null },
  ]);
});

test('pi-continuity keeps a complete tool tail and schedules continuation with a non-context entry', async () => {
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  continuity({ registerFlag() {}, registerCommand() {}, on(name: string, handler: (event: any, ctx: any) => any) {
    hooks.set(name, handler);
  } } as any);
  const assistant = { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }] };
  const toolResult = { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'done' }] };
  const context = { pendingMessages: [], llmMessages: [assistant, toolResult], contextEntries: [
    { sourceEntry: { id: 'assistant', type: 'message' }, messages: [assistant] },
    { sourceEntry: { id: 'tool', type: 'message' }, messages: [toolResult] },
  ] };
  const ctx = { mode: 'rpc', hasUI: false, signal: undefined, hasPendingMessages: () => false };
  const turn = { message: assistant, messageEntryId: 'assistant', toolResultEntryIds: ['tool'],
    outcome: 'completed', entries: [], continue: false, context };
  assert.equal(await hooks.get('turn_end')!(turn, ctx), undefined);
  const result = await hooks.get('agent_before_settle')!(turn, ctx);
  assert.equal(result.continue, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].type, 'custom');
  assert.equal(result.entries[0].customType, 'pi-continuity');
  assert.equal(result.entries[0].data.reason, 'tool-tail');
  assert.equal('content' in result.entries[0], false, 'the record is not a model-visible custom message');
});
