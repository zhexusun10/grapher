import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function trajectory(run) {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-trajectory-'));
  try {
    const events = [{ type: 'grapher_process_started', timestamp: 1000 }];
    const call = (id, name, start, end, text, details, isError = false) => {
      events.push({ type: 'tool_execution_start', toolCallId: id, toolName: name, grapherReceivedAt: 1000 + start, args: {} });
      events.push({ type: 'tool_execution_end', toolCallId: id, toolName: name, grapherReceivedAt: 1000 + end, isError,
        result: { content: [{ type: 'text', text }], details, ...(isError ? { isError } : {}) } });
    };
    const report = () => {
      const file = join(dir, 'events.jsonl');
      writeFileSync(file, events.map(event => JSON.stringify(event)).join('\n'));
      return JSON.parse(execFileSync(process.execPath, ['scripts/planning-trajectory.mjs', file], { encoding: 'utf8' }))[0];
    };
    run({ events, call, report });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('separates graph attempts from process outcome without double-counting concurrent tools', () => {
  trajectory(({ events, call, report }) => {
    call('explore', 'bash', 10, 30, 'Failed exploration', {}, true);
    call('a', 'edit_graph', 20, 25, 'Task is required.', { diagnostics: ['Task is required.'], diagnosticCodes: ['E203'] }, true);
    call('b', 'edit_graph', 40, 41, 'Task is required.', { diagnostics: ['Task is required.'], diagnosticCodes: ['E203'] }, true);
    events.push({ type: 'grapher_process_exited', success: true, elapsedMs: 100 });
    const failed = report();
    assert.equal(failed.processSuccess, true);
    assert.equal(failed.firstGraphMutationMs, 20);
    assert.equal(failed.firstSuccessfulGraphMutationMs, null);
    assert.equal(failed.longestGraphRejectionStreak, 2);
    assert.deepEqual(failed.graphDiagnostics, { E203: 2 });
    assert.equal(failed.toolWallMs, 21);
    call('c', 'edit_graph', 60, 65, 'Successfully created node "build".', {});
    call('d', 'edit_graph', 70, 71, 'Redundant dependency', { diagnostics: ['Redundant dependency'], diagnosticCodes: ['E209'] }, true);
    const recovered = report();
    assert.equal(recovered.firstSuccessfulGraphMutationMs, 65);
    assert.equal(recovered.longestGraphRejectionStreak, 2);
    assert.deepEqual(recovered.graphDiagnostics, { E203: 2, E209: 1 });
    assert.deepEqual(recovered.lastGraphFailure, ['Redundant dependency']);
  });
});

test('edit_graph truncated reports use isError and structured details', () => {
  trajectory(({ events, call, report }) => {
    call('args', 'edit_graph', 10, 11, 'Invalid edge call.', undefined, true);
    call('missing', 'edit_graph', 20, 21, 'Edge does not exist.', { diagnostics: ['Edge does not exist.'], diagnosticCodes: ['not-found'] }, true);
    call('accepted', 'edit_graph', 30, 31, 'Successfully created node "a".', {});
    const truncatedError = 'Edit rejected. The graph is unchanged.\nUnknown endpoint.\n[Output truncated. Full output: error.txt]';
    call('large-error', 'edit_graph', 32, 33, truncatedError,
      { diagnosticCodes: ['E204'], truncation: { truncated: true }, fullOutputPath: 'error.txt' }, true);
    call('large-success', 'edit_graph', 34, 35, 'The edit succeeded.\n[Output truncated. Full output: success.txt]',
      { truncation: { truncated: true }, fullOutputPath: 'success.txt' });
    events.push({ type: 'grapher_process_exited', success: true, elapsedMs: 40 });
    const result = report();
    assert.equal(result.firstGraphMutationMs, 10);
    assert.equal(result.firstSuccessfulGraphMutationMs, 31);
    assert.equal(result.longestGraphRejectionStreak, 2);
    assert.deepEqual(result.graphDiagnostics, { 'not-found': 1, E204: 1 });
    assert.deepEqual(result.lastGraphFailure, [truncatedError]);
    assert.equal(result.toolErrors, 3);
  });
});

test('retired node and edge tools are not counted as graph edits', () => {
  trajectory(({ call, report }) => {
    call('old-node', 'node', 1, 2, '{"applied":true}', {});
    call('old-edge', 'edge', 3, 4, '{"mutationApplied":false}', {}, true);
    const result = report();
    assert.equal(result.firstGraphMutationMs, null);
    assert.equal(result.firstSuccessfulGraphMutationMs, null);
    assert.deepEqual(result.graphDiagnostics, {});
  });
});
