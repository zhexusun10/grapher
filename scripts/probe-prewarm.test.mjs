import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { join } from 'node:path';
import { root } from './pi-baseline.mjs';

test('startup probe measures verified CLI and Core without prompts and labels the compatibility gap', { timeout: 60000 }, () => {
  const result = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts/probe-prewarm.mjs'), '--runs', '1'], {
    cwd: root, encoding: 'utf8', timeout: 55000, maxBuffer: 1024 * 1024,
  }));
  assert.equal(result.runs, 1);
  assert.equal(result.modelRequests, 0);
  assert.equal(result.coreIsProductionEquivalent, false);
  assert.match(result.note, /required extension policies/);
  for (const kind of ['cli', 'core']) {
    assert.equal(result.samples[kind].length, 1);
    assert.ok(result.medianMs[kind].startup > 0);
    assert.ok(result.medianMs[kind].readyRpc > 0);
  }
});
