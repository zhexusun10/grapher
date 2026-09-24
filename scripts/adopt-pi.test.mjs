import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateLock } from './adopt-pi.mjs';
import { lock } from './pi-baseline.mjs';

test('Pi adoption records the exact checked-out clean commit and hydrated data', () => {
  assert.deepEqual(candidateLock(lock.forkCommit), lock);
  assert.ok(lock.modelData['.manifest.json'], 'offline setup must restore the upstream model-data manifest');
  assert.throws(() => candidateLock('0'.repeat(40)), /checked-out Pi commit/);
  assert.throws(() => candidateLock('HEAD'), /checked-out Pi commit/);
});
