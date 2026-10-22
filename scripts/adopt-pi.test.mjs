import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateGeneratedModelData } from '../pi/packages/ai/scripts/model-data.ts';
import { candidateLock } from './adopt-pi.mjs';
import { resolveBuildOrder } from './build-pi.mjs';
import { lock, restoreModelData, root, source } from './pi-baseline.mjs';
import { corePackages } from './pi-dependencies.mjs';

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
  // A clean checkout has no git-ignored overlay. Build one here so this test
  // never depends on the developer's personal engine/model-data-local state.
  const overlay = mkdtempSync(join(tmpdir(), 'grapher-pi-overlay-src-'));
  const name = Object.keys(lock.modelData).find(entry => entry.endsWith('.json') && entry !== '.manifest.json');
  const data = mkdtempSync(join(tmpdir(), 'grapher-pi-overlay-'));
  t.after(() => {
    rmSync(overlay, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });
  const overridden = JSON.parse(readFileSync(join(root, 'engine/model-data', name), 'utf8'));
  const firstApi = Object.values(overridden)[0];
  const firstModel = Object.values(firstApi)[0];
  firstModel.name = `${firstModel.name} (local overlay)`;
  writeFileSync(join(overlay, name), `${JSON.stringify(overridden)}\n`);
  cpSync(join(root, 'engine/model-data'), data, { recursive: true });
  // A stale provider from an older hydration must not survive the restore.
  writeFileSync(join(data, 'stale-provider.json'), '{}\n');
  const directory = stagedPackage(t, data);
  const merged = join(directory, 'src/providers/data');
  restoreModelData(merged, overlay);
  assert.deepEqual(readdirSync(merged).sort(), Object.keys(lock.modelData).sort(), 'overlay may only override known providers');
  assert.notEqual(
    createHash('sha256').update(readFileSync(join(merged, name))).digest('hex'),
    lock.modelData[name],
    `${name} must come from the overlay, not the committed baseline`);
  // The merged catalog (baseline plus local API tweaks) passes upstream validation.
  validateGeneratedModelData(directory);
});

test('Pi package builds follow workspace dependency order', t => {
  // Upstream's root build script builds chord before pi-telemetry even though
  // chord depends on it; a clean offline build must order packages itself.
  const directory = mkdtempSync(join(tmpdir(), 'grapher-pi-build-order-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const internal = (name) => `@earendil-works/${name}`;
  const dependencies = {
    chord: ['telemetry'],
    tui: [],
    telemetry: [],
    codemode: [],
    mcp: [],
    ai: ['telemetry'],
    durable: ['chord', 'ai', 'codemode', 'telemetry'],
    agent: ['ai'],
    'coding-agent': ['agent', 'ai', 'codemode', 'mcp', 'tui'],
  };
  for (const name of corePackages) {
    mkdirSync(join(directory, 'packages', name), { recursive: true });
    const spec = { name: internal(name), version: '1.0.0' };
    if (dependencies[name]?.length) {
      spec.dependencies = Object.fromEntries(dependencies[name].map(dependency => [internal(dependency), '1.0.0']));
    }
    writeFileSync(join(directory, 'packages', name, 'package.json'), JSON.stringify(spec));
  }
  const order = resolveBuildOrder(directory);
  assert.deepEqual([...order].sort(), [...corePackages].sort(), 'every reviewed package builds exactly once');
  for (const [name, required] of Object.entries(dependencies)) {
    for (const dependency of required) {
      assert.ok(order.indexOf(dependency) < order.indexOf(name), `${dependency} must build before ${name}`);
    }
  }
  assert.equal(order.at(-1), 'coding-agent', 'the CLI bundle builds last');
  // A cycle must fail loudly instead of silently picking an order.
  writeFileSync(join(directory, 'packages', 'telemetry', 'package.json'),
    JSON.stringify({ name: internal('telemetry'), dependencies: { [internal('chord')]: '1.0.0' } }));
  assert.throws(() => resolveBuildOrder(directory), /dependency cycle/);
});
