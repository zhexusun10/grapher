import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyHostResult } from './benchmark-result.mjs';

const binary = path.resolve('backend/target/debug/examples/benchmark');

test('host exit and artifact must agree; assertion failures are not environment failures', () => {
  assert.equal(classifyHostResult({ status: 1 }, { status: 'FAIL', error: 'broken invariant' }).classification, 'IMPLEMENTATION_BUG');
  assert.equal(classifyHostResult({ status: 0 }, { status: 'FAIL' }).classification, 'ENVIRONMENT_FAILURE');
  assert.equal(classifyHostResult({ status: 1 }, { status: 'PASS' }).classification, 'ENVIRONMENT_FAILURE');
  assert.equal(classifyHostResult({ status: 0 }, null).classification, 'ENVIRONMENT_FAILURE');
  assert.equal(classifyHostResult({ status: null, signal: 'SIGKILL' }, { status: 'FAIL' }).classification, 'ENVIRONMENT_FAILURE');
});

test('a failing host retains its evidence and exits nonzero', { timeout: 30_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grapher-benchmark-failure-'));
  try {
    const processResult = spawnSync(binary, [], {
      env: { ...process.env, BENCHMARK_CASE: 'B001', BENCHMARK_CASE_DIR: root, BENCHMARK_TEST_FORCE_FAILURE: '1' },
      encoding: 'utf8', timeout: 20_000,
    });
    const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
    assert.equal(processResult.status, 1, processResult.stderr);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.error, 'Injected benchmark host failure');
    assert.equal(classifyHostResult(processResult, result).classification, 'IMPLEMENTATION_BUG');
    assert.ok(fs.existsSync(path.join(root, 'snapshot.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime benchmark cases execute against isolated repositories and retain evidence', { timeout: 210_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grapher-benchmark-test-'));
  try {
    // Include approval, ordering, true concurrency, merge, rejection, Pi failure,
    // feedback, intervention, retry exhaustion and recovery. No provider calls.
    const counts = { B001: 1, B002: 3, B003: 3, B004: 4, B005: 0, B006: 1, B007: 5, B008: 2, B009: 3 };
    for (const [id, count] of Object.entries(counts)) {
      const dir = path.join(root, id);
      const processResult = spawnSync(binary, [], {
        env: { ...process.env, BENCHMARK_CASE: id, BENCHMARK_CASE_DIR: dir },
        encoding: 'utf8', timeout: 30_000,
      });
      const resultFile = path.join(dir, 'result.json');
      assert.ok(fs.existsSync(resultFile), `${id}: missing result.json: ${processResult.stderr}`);
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      assert.deepEqual({ status: processResult.status, signal: processResult.signal, error: result.error }, { status: 0, signal: null, error: null }, `${id}: ${processResult.stderr}`);
      assert.equal(result.status, 'PASS', id);
      assert.equal(result.caseId, id);
      assert.equal(result.nodeExecutionCount, count, id);
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
      assert.equal(snapshot.executions.length, count, id);
      assert.ok(fs.existsSync(path.join(dir, 'requests.jsonl')), `${id}: no IPC evidence`);
      assert.ok(fs.existsSync(path.join(dir, 'responses.jsonl')), `${id}: no IPC response evidence`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
