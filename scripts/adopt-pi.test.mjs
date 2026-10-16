import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateGeneratedModelData } from '../pi/packages/ai/scripts/model-data.ts';
import { candidateLock } from './adopt-pi.mjs';
import { lock, root, source } from './pi-baseline.mjs';

test('Pi adoption records the exact checked-out clean commit and hydrated data', () => {
  assert.deepEqual(candidateLock(lock.forkCommit), lock);
  assert.ok(lock.modelData['.manifest.json'], 'offline setup must restore the upstream model-data manifest');
  assert.throws(() => candidateLock('0'.repeat(40)), /checked-out Pi commit/);
  assert.throws(() => candidateLock('HEAD'), /checked-out Pi commit/);
});

test('bundled Pi model data validates in a fresh checkout and matches the baseline hashes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-pi-model-data-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const providers = join(source, 'packages/ai/src/providers');
  const stagedProviders = join(directory, 'src/providers');
  mkdirSync(stagedProviders, { recursive: true });
  copyFileSync(join(source, 'packages/ai/src/models.generated.ts'), join(directory, 'src/models.generated.ts'));
  for (const name of readdirSync(providers).filter(name => name.endsWith('.models.ts'))) {
    copyFileSync(join(providers, name), join(stagedProviders, name));
  }
  // Validate only the checked-in snapshot, not ignored data left by a local
  // hydration. Added model IDs must update the upstream generation stamp too.
  const data = join(stagedProviders, 'data');
  cpSync(join(root, 'engine/model-data'), data, { recursive: true });
  validateGeneratedModelData(directory);
  assert.deepEqual(readdirSync(data).sort(), Object.keys(lock.modelData).sort());
  for (const [name, expected] of Object.entries(lock.modelData)) {
    assert.equal(createHash('sha256').update(readFileSync(join(data, name))).digest('hex'), expected, name);
  }
});
