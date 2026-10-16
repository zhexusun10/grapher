import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateGeneratedModelData } from '../pi/packages/ai/scripts/model-data.ts';
import { candidateLock } from './adopt-pi.mjs';
import { lock, restoreModelData, root, source } from './pi-baseline.mjs';

function stagedPackage(t, dataDir) {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-pi-model-data-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const providers = join(source, 'packages/ai/src/providers');
  const stagedProviders = join(directory, 'src/providers');
  mkdirSync(stagedProviders, { recursive: true });
  copyFileSync(join(source, 'packages/ai/src/models.generated.ts'), join(directory, 'src/models.generated.ts'));
  for (const name of readdirSync(providers).filter(name => name.endsWith('.models.ts'))) {
    copyFileSync(join(providers, name), join(stagedProviders, name));
  }
  cpSync(dataDir, join(stagedProviders, 'data'), { recursive: true });
  return directory;
}

test('Pi adoption records the exact checked-out clean commit and hydrated data', t => {
  // Adoption always records the pristine upstream hydration, never the local
  // overlay, so hash the committed baseline copy instead of the merged
  // submodule data directory.
  const baseline = mkdtempSync(join(tmpdir(), 'grapher-pi-baseline-'));
  t.after(() => rmSync(baseline, { recursive: true, force: true }));
  for (const name of readdirSync(join(root, 'engine/model-data'))) {
    copyFileSync(join(root, 'engine/model-data', name), join(baseline, name));
  }
  assert.deepEqual(candidateLock(lock.forkCommit, baseline), lock);
  assert.ok(lock.modelData['.manifest.json'], 'offline setup must restore the upstream model-data manifest');
  assert.throws(() => candidateLock('0'.repeat(40)), /checked-out Pi commit/);
  assert.throws(() => candidateLock('HEAD'), /checked-out Pi commit/);
});

test('bundled Pi model data validates in a fresh checkout and matches the baseline hashes', t => {
  const data = mkdtempSync(join(tmpdir(), 'grapher-pi-data-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  cpSync(join(root, 'engine/model-data'), data, { recursive: true });
  const directory = stagedPackage(t, data);
  // Validate the committed snapshot itself: added or edited model IDs must go
  // through the local overlay, never a hand-edited baseline.
  validateGeneratedModelData(directory);
  const merged = join(directory, 'src/providers/data');
  assert.deepEqual(readdirSync(merged).sort(), Object.keys(lock.modelData).sort());
  for (const [name, expected] of Object.entries(lock.modelData)) {
    assert.equal(createHash('sha256').update(readFileSync(join(merged, name))).digest('hex'), expected, name);
  }
});

test('local model-data overlay overrides the baseline and keeps upstream validation green', t => {
  const overlay = join(root, 'engine/model-data-local');
  const names = readdirSync(overlay).filter(name => name.endsWith('.json'));
  assert.ok(names.length > 0, 'this repository is developed with a local overlay; the test exercises it');
  const data = mkdtempSync(join(tmpdir(), 'grapher-pi-overlay-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  cpSync(join(root, 'engine/model-data'), data, { recursive: true });
  // A stale provider from an older hydration must not survive the restore.
  writeFileSync(join(data, 'stale-provider.json'), '{}\n');
  const directory = stagedPackage(t, data);
  const merged = join(directory, 'src/providers/data');
  restoreModelData(merged);
  assert.deepEqual(readdirSync(merged).sort(), Object.keys(lock.modelData).sort(), 'overlay may only override known providers');
  for (const name of names) {
    assert.notEqual(
      createHash('sha256').update(readFileSync(join(merged, name))).digest('hex'),
      lock.modelData[name],
      `${name} must come from the overlay, not the committed baseline`);
  }
  // The merged catalog (baseline plus local API tweaks) passes upstream validation.
  validateGeneratedModelData(directory);
});
