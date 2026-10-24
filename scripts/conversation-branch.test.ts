import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeNodeConversationEvents, activeNodeExecutions, nodeConversationExecutions, nodeConversationLineage, executionIdForMessage, executionIdForVersion, executionIdForEdit, versionsForEdit } from '../src/services/conversationBranch.ts';
import { emptySnapshot, type GraphEvent, type Snapshot } from '../src/types.ts';

test('editing a completed turn hides the abandoned node branch but preserves earlier turns', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    supersededExecutionIds: ['second', 'third'],
    executions: [
      { id: 'first', node: 'task', revision: 1, attempt: 1, sessionId: 's', worktree: '', before: '', after: '', status: 'completed', output: '', startedAt: 1, completedAt: 2 },
      { id: 'second', node: 'task', revision: 2, attempt: 2, sessionId: 's', worktree: '', before: '', after: '', status: 'completed', output: '', startedAt: 3, completedAt: 4 },
      { id: 'third', node: 'task', revision: 3, attempt: 3, sessionId: 's', worktree: '', before: '', after: '', status: 'completed', output: '', startedAt: 5, completedAt: 6 },
      { id: 'edited', node: 'task', revision: 4, attempt: 4, sessionId: 's', worktree: '', before: '', after: '', status: 'completed', output: '', startedAt: 7, completedAt: 8 },
    ],
    events: [
      { sequence: 1, timestamp: 1, type: 'started', execution: { id: 'first' } as never },
      { sequence: 2, timestamp: 3, type: 'invalidated', target: 'task', instruction: 'second', human: true },
      { sequence: 3, timestamp: 3, type: 'started', execution: { id: 'second' } as never },
      { sequence: 4, timestamp: 5, type: 'invalidated', target: 'task', instruction: 'third', human: true },
      { sequence: 5, timestamp: 7, type: 'conversation_edited', target: 'task', nodes: ['task'], instruction: 'replacement', from_event_sequence: 2, from_execution_id: 'second' },
    ],
  };
  assert.deepEqual(activeNodeExecutions(state, 'task').map(e => e.id), ['first', 'edited']);
  assert.deepEqual(activeNodeConversationEvents(state, 'task').filter(e => !!e.instruction).map(e => e.instruction), ['replacement']);
  assert.equal(state.events.length, 5, 'old durable history remains intact');
});

test('editing a later Steer preserves earlier Steers from the superseded execution in the same session', () => {
  const original = { id: 'original', node: 'task', revision: 1, attempt: 1, sessionId: 'same', worktree: '', before: '', after: '', status: 'paused', output: '', startedAt: 1, completedAt: 4 };
  const replacement = { ...original, id: 'replacement', attempt: 2, startedAt: 5, status: 'running', completedAt: null };
  const state = { ...emptySnapshot, supersededExecutionIds: [original.id], executions: [original, replacement], events: [
    { type: 'started', sequence: 1, timestamp: 1, execution: original },
    { type: 'steered', sequence: 2, timestamp: 2, node: 'task', execution_id: original.id, instruction: 'keep this steer' },
    { type: 'steered', sequence: 3, timestamp: 3, node: 'task', execution_id: original.id, instruction: 'replace this steer' },
    { type: 'conversation_edited', sequence: 4, timestamp: 4, target: 'task', nodes: ['task'], first_turn: false,
      instruction: 'edited steer', old_instruction: 'replace this steer', from_event_sequence: 3, from_execution_id: original.id },
    { type: 'started', sequence: 5, timestamp: 5, execution: replacement },
  ] } as Snapshot;
  const replayed = JSON.parse(JSON.stringify(state));
  assert.deepEqual(activeNodeConversationEvents(replayed, 'task').filter(event => event.instruction).map(event => event.instruction),
    ['keep this steer', 'edited steer']);
  assert.equal(executionIdForEdit(replayed, replayed.events[3]), replacement.id);
  assert.deepEqual(versionsForEdit(replayed, replayed.events[3]).map(version => version.text), ['replace this steer', 'edited steer']);
});

test('cursor edits retain bounded transcript prefixes and recutting an earlier turn drops only its suffix', () => {
  const original = { id: 'original', node: 'task', revision: 1, attempt: 1, sessionId: 'same', worktree: '', before: '', after: '', status: 'paused', output: '', startedAt: 1, completedAt: 4 };
  const second = { ...original, id: 'second', attempt: 2, startedAt: 5, completedAt: 7 };
  const third = { ...original, id: 'third', attempt: 3, startedAt: 8, status: 'running', completedAt: null };
  const state = { ...emptySnapshot, supersededExecutionIds: [original.id, second.id], executions: [original, second, third], events: [
    { type: 'started', sequence: 1, timestamp: 1, execution: original },
    { type: 'conversation_edited', sequence: 4, timestamp: 4, target: 'task', nodes: ['task'],
      from_execution_id: original.id, from_event_sequence: 1, from_output_offset: 120 },
    { type: 'started', sequence: 5, timestamp: 5, execution: second },
    { type: 'conversation_edited', sequence: 7, timestamp: 7, target: 'task', nodes: ['task'],
      from_execution_id: original.id, from_event_sequence: 1, from_output_offset: 40 },
    { type: 'started', sequence: 8, timestamp: 8, execution: third },
  ] } as Snapshot;
  const replayed = JSON.parse(JSON.stringify(state));
  assert.deepEqual(nodeConversationExecutions(replayed, 'task').map(execution => [execution.id, execution.historyEndOffset]),
    [['original', 40], ['third', undefined]]);
  assert.equal(nodeConversationExecutions(replayed, 'task')[0].historyReadOnly, false,
    'a same-session prefix stays editable');
  assert.deepEqual(activeNodeExecutions(replayed, 'task').map(execution => execution.id), ['third'], 'prefixes are not live runtime executions');
  const restarted = { ...state, supersededExecutionIds: ['original', 'second', 'third'],
    executions: [...state.executions, { ...third, id: 'fresh', sessionId: 'fresh-session', startedAt: 9 }],
    events: [...state.events, { type: 'started', sequence: 9, timestamp: 9, fresh_restart: true,
      execution: { ...third, id: 'fresh', sessionId: 'fresh-session' } }] } as Snapshot;
  assert.deepEqual(nodeConversationExecutions(restarted, 'task').map(execution => execution.id), ['fresh']);
});

test('retained prefix ownership uses execution order even when start timestamps collide', () => {
  const first = { id: 'first', node: 'task', revision: 1, attempt: 1, sessionId: 's', worktree: '', before: '', after: '', status: 'paused', output: '', startedAt: 1, completedAt: 2 };
  const second = { ...first, id: 'second', attempt: 2 };
  const third = { ...first, id: 'third', attempt: 3, status: 'running', completedAt: null };
  const state = { ...emptySnapshot, supersededExecutionIds: ['first', 'second'], executions: [first, second, third], events: [
    { type: 'conversation_edited', target: 'task', sequence: 2, timestamp: 2, from_execution_id: 'first', from_output_offset: 20 },
    { type: 'conversation_edited', target: 'task', sequence: 4, timestamp: 2, from_execution_id: 'second', from_output_offset: 30 },
  ] } as Snapshot;
  assert.deepEqual(nodeConversationExecutions(state, 'task').map(execution => [execution.id, execution.historyEndOffset]),
    [['first', 20], ['second', 30], ['third', undefined]]);
});

test('a forked session keeps its retained prefix while a from-zero restart drops it', () => {
  const original = { id: 'original', node: 'task', revision: 1, attempt: 1, sessionId: 'old-session', worktree: '/old', before: '', after: '', status: 'paused', output: '', startedAt: 1, completedAt: 4 };
  const forked = { ...original, id: 'forked', attempt: 2, sessionId: 'forked-session', worktree: '/new', status: 'running', startedAt: 5, completedAt: null };
  const forkedState = { ...emptySnapshot, supersededExecutionIds: [original.id], executions: [original, forked], events: [
    { type: 'started', sequence: 1, timestamp: 1, execution: original, fresh_restart: true },
    { type: 'steered', sequence: 2, timestamp: 2, node: 'task', execution_id: original.id, instruction: 'keep this steer' },
    { type: 'conversation_edited', sequence: 3, timestamp: 3, target: 'task', nodes: ['task'], first_turn: false,
      instruction: 'edited turn', from_event_sequence: 1, from_execution_id: original.id, from_output_offset: 40 },
    { type: 'started', sequence: 4, timestamp: 4, execution: forked, fresh_restart: false },
  ] } as Snapshot;
  const replayed = JSON.parse(JSON.stringify(forkedState));
  assert.equal(nodeConversationLineage(replayed, 'task').has(original.id), true);
  assert.deepEqual(nodeConversationExecutions(replayed, 'task').map(execution => [execution.id, execution.historyEndOffset]),
    [['original', 40], ['forked', undefined]],
    'a fork keeps the retained prefix even though its Pi session ID changed');
  assert.equal(nodeConversationExecutions(replayed, 'task')[0].historyReadOnly, true,
    'a forked prefix cannot branch the active session, so it offers no edit');
  const restarted = { ...forkedState, supersededExecutionIds: [original.id, forked.id],
    executions: [...forkedState.executions, { ...forked, id: 'restart', sessionId: 'restart-session', startedAt: 6 }],
    events: [...forkedState.events, { type: 'started', sequence: 5, timestamp: 5, execution: { ...forked, id: 'restart' }, fresh_restart: true }] } as Snapshot;
  const reloaded = JSON.parse(JSON.stringify(restarted));
  assert.equal(nodeConversationLineage(reloaded, 'task').has(original.id), false);
  assert.deepEqual(nodeConversationExecutions(reloaded, 'task').map(execution => execution.id), ['restart']);
});

test('queued turns use exact durable execution claims, not the next start or matching text', () => {
  const messages: GraphEvent[] = [1, 2, 3].map(sequence => ({ sequence, timestamp: sequence, type: 'invalidated', target: 'task', instruction: 'same', human: true }));
  const state: Snapshot = { ...emptySnapshot,
    nodes: { task: { status: 'dirty', revision: 2, head: '', instruction: 'same', error: null, pendingMessages: [{ sequence: 3, instruction: 'same' }] } },
    events: [...messages,
      { sequence: 4, timestamp: 4, type: 'started', execution: { id: 'other', node: 'other' } as never, message_sequences: [3] },
      { sequence: 5, timestamp: 5, type: 'started', execution: { id: 'batch', node: 'task' } as never, message_sequences: [1, 2] },
      { sequence: 6, timestamp: 6, type: 'started', execution: { id: 'unrelated-task-start', node: 'task' } as never, message_sequences: [] }],
  };
  assert.equal(executionIdForMessage(state, messages[0]), 'batch');
  assert.equal(executionIdForMessage(state, messages[1]), 'batch');
  assert.equal(executionIdForMessage(state, messages[2]), undefined);
  const reloaded = JSON.parse(JSON.stringify(state));
  assert.equal(executionIdForMessage(reloaded, messages[1]), 'batch');
});

test('edited messages point at the new active execution, not the superseded anchor', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    events: [
      { sequence: 1, timestamp: 10, type: 'conversation_edited', target: 'task', nodes: ['task'], instruction: 'replacement', from_execution_id: 'old' },
      { sequence: 2, timestamp: 20, type: 'started', execution: { id: 'new', node: 'task' } as never, message_sequences: [] },
    ],
  };
  assert.equal(executionIdForEdit(state, state.events[0]), 'new');
});
test('version lookup can recover a superseded branch anchor', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    events: [
      { sequence: 1, timestamp: 10, type: 'invalidated', target: 'task', instruction: 'original' },
      { sequence: 2, timestamp: 20, type: 'started', execution: { id: 'old', node: 'task' } as never },
      { sequence: 3, timestamp: 30, type: 'conversation_edited', target: 'task', nodes: ['task'], instruction: 'replacement', old_instruction: 'original', from_execution_id: 'old' },
      { sequence: 4, timestamp: 40, type: 'started', execution: { id: 'new', node: 'task' } as never },
    ],
  };
  assert.equal(executionIdForMessage(state, state.events[2]), 'new');
  assert.equal(executionIdForVersion(state, 'task', 'original'), 'old');
});
test('selecting an existing branch does not append another version', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    events: [
      { sequence: 1, timestamp: 10, type: 'invalidated', target: 'task', instruction: 'original' },
      { sequence: 2, timestamp: 20, type: 'conversation_edited', target: 'task', instruction: 'replacement', old_instruction: 'original', from_event_sequence: 1 },
      { sequence: 3, timestamp: 30, type: 'conversation_edited', target: 'task', instruction: 'original', old_instruction: 'replacement', from_event_sequence: 1, selected_version: 0 },
    ],
  };
  const selected = state.events[2];
  assert.deepEqual(versionsForEdit(state, selected).map(version => version.text), ['original', 'replacement']);
  assert.equal(selected.selected_version, 0);

  const continued: GraphEvent = {
    sequence: 4, timestamp: 40, type: 'conversation_edited', target: 'task', instruction: 'continued',
    old_instruction: 'original', from_event_sequence: 3,
  };
  const continuedState = { ...state, events: [...state.events, continued] };
  assert.deepEqual(versionsForEdit(continuedState, continued).map(version => version.text), ['original', 'continued']);
});

test('message versions survive reload and nested edits', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    events: [
      { sequence: 1, timestamp: 10, type: 'invalidated', target: 'task', instruction: 'original' },
      { sequence: 2, timestamp: 20, type: 'conversation_edited', target: 'task', instruction: 'replacement', old_instruction: 'original', from_event_sequence: 1 },
      { sequence: 3, timestamp: 30, type: 'conversation_edited', target: 'task', instruction: 'third', old_instruction: 'replacement', from_event_sequence: 2 },
    ],
  };
  assert.deepEqual(versionsForEdit(state, state.events[2]).map(version => version.text),
    ['original', 'replacement', 'third']);
});

test('message rollback matches stripped node prefixes and rolls back subsequent turns', () => {
  const stripPrefix = (s: string) => s.replace(/^\[@[^\]]+\]\s*/, '').trim();
  const baseEntries = [
    { id: 'msg-1', text: '[@merge:06_feature_qa] continue solve the conflict' },
    { id: 'msg-2', text: '[@merge:06_feature_qa] second follow-up turn' },
  ];
  const targetClean = 'continue solve the conflict';
  const targetIndex = baseEntries.findIndex((e) =>
    e.id === 'event-5' ||
    stripPrefix(e.text) === targetClean
  );
  assert.equal(targetIndex, 0, 'matches turn 0 despite different ID and [@node] prefix');
  const prevEntries = baseEntries.slice(0, targetIndex);
  const subsequentEntries = baseEntries.slice(targetIndex + 1);
  assert.equal(prevEntries.length, 0);
  assert.equal(subsequentEntries.length, 1);
  assert.equal(subsequentEntries[0].id, 'msg-2');
});


test('a fresh restart supersedes prior attempts and their human turns', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    supersededExecutionIds: ['attempt-1'],
    executions: [
      { id: 'attempt-1', node: 'task', revision: 1, attempt: 1, sessionId: 'old', worktree: '', before: '', after: '', status: 'failed', output: '', startedAt: 1, completedAt: 2 },
      { id: 'attempt-2', node: 'task', revision: 2, attempt: 2, sessionId: 'new', worktree: '', before: '', after: '', status: 'running', output: '', startedAt: 9, completedAt: null },
    ],
    events: [
      { sequence: 1, timestamp: 1, type: 'started', execution: { id: 'attempt-1', node: 'task' } as never },
      { sequence: 2, timestamp: 2, type: 'invalidated', target: 'task', instruction: 'old repair instruction', human: true },
      { sequence: 9, timestamp: 9, type: 'started', execution: { id: 'attempt-2', node: 'task' } as never },
    ],
  };
  assert.deepEqual(activeNodeExecutions(state, 'task').map(e => e.id), ['attempt-2']);
  // The dead conversation's human turn no longer renders above the fresh start.
  assert.deepEqual(activeNodeConversationEvents(state, 'task').filter(e => !!e.instruction), []);
});
