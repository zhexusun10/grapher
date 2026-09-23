import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('separates rejected graph attempts, successful mutations and process outcome', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-trajectory-'));
  try {
    const events = [{ type: 'grapher_process_started', timestamp: 1000 }];
    function call(id, name, start, end, mutation, isError = false, diagnosticCodes) {
      events.push({ type: 'tool_execution_start', toolCallId: id, toolName: name, grapherReceivedAt: 1000 + start, args: {} });
      events.push({ type: 'tool_execution_end', toolCallId: id, toolName: name, grapherReceivedAt: 1000 + end, isError,
        result: { content: [{ type: 'text', text: JSON.stringify(mutation) }], ...(diagnosticCodes ? { details: { diagnosticCodes } } : {}) } });
    }
    call('explore', 'bash', 10, 30, {}, true);
    const rejected = { mutationApplied: false, diagnostics: [{ code: 'mutation-input' }] };
    call('a', 'node', 20, 25, rejected, true);
    call('b', 'node', 40, 41, rejected, true);
    events.push({ type: 'grapher_process_exited', success: true, elapsedMs: 100 });
    const file = join(dir, 'events.jsonl');
    const report = () => {
      writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n'));
      return JSON.parse(execFileSync(process.execPath, ['scripts/planning-trajectory.mjs', file], { encoding: 'utf8' }))[0];
    };
    const failed = report();
    assert.equal(failed.processSuccess, true);
    assert.equal(failed.firstGraphMutationMs, 20);
    assert.equal(failed.firstSuccessfulGraphMutationMs, null);
    assert.equal(failed.longestGraphRejectionStreak, 2);
    assert.deepEqual(failed.graphDiagnostics, { 'mutation-input': 2 });
    assert.equal(failed.toolWallMs, 21, 'overlapping tools must not double count');
    call('c', 'node', 60, 65, { mutationApplied: true });
    call('d', 'edge', 70, 71, { mutationApplied: false, diagnostics: ['Redundant dependency'] }, true, ['E209']);
    const recovered = report();
    assert.equal(recovered.firstSuccessfulGraphMutationMs, 65);
    assert.equal(recovered.longestGraphRejectionStreak, 2);
    assert.deepEqual(recovered.graphDiagnostics, { 'mutation-input': 2, E209: 1 });
    assert.deepEqual(recovered.lastGraphFailure, ['Redundant dependency']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
