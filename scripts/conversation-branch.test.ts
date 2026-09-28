import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeNodeConversationEvents, activeNodeExecutions, executionIdForEdit, versionsForEdit } from '../src/services/conversationBranch.ts';
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

test('edited messages point at the new active execution, not the superseded anchor', () => {
  const state: Snapshot = {
    ...emptySnapshot,
    events: [
      { sequence: 1, timestamp: 10, type: 'conversation_edited', target: 'task', nodes: ['task'], instruction: 'replacement', from_execution_id: 'old' },
      { sequence: 2, timestamp: 20, type: 'started', execution: { id: 'new', node: 'task' } as never },
    ],
  };
  assert.equal(executionIdForEdit(state, state.events[0]), 'new');
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
