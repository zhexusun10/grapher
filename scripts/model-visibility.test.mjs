import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelVisibility, saveModelVisibility } from '../engine/model-visibility.mjs';
import { ProviderAuthAdapter } from '../engine/provider-auth-adapter.mjs';

const temporary = fn => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-model-visibility-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('global model visibility persists, merges deltas and restores missing model IDs without rewriting other settings', () => temporary(dir => {
  writeFileSync(join(dir, 'settings.json'), '{"defaultModel":"keep"}');
  assert.deepEqual(readModelVisibility(dir), { hiddenModels: [] });
  saveModelVisibility([{ model: 'a/model', hidden: true }], false, dir);
  saveModelVisibility([{ model: 'b/model', hidden: true }], false, dir);
  assert.deepEqual(readModelVisibility(dir), { hiddenModels: ['a/model', 'b/model'] });
  saveModelVisibility([{ model: 'a/model', hidden: false }], false, dir);
  assert.deepEqual(readModelVisibility(dir), { hiddenModels: ['b/model'] });
  saveModelVisibility([], true, dir);
  assert.deepEqual(readModelVisibility(dir), { hiddenModels: [] });
  assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), '{"defaultModel":"keep"}');
  assert.ok(readdirSync(dir).every(name => !name.endsWith('.tmp')));
}));

test('invalid visibility updates and corrupt files fail without erasing saved choices', () => temporary(dir => {
  saveModelVisibility([{ model: 'a/model', hidden: true }], false, dir);
  const before = readFileSync(join(dir, 'model-visibility.json'), 'utf8');
  for (const changes of [null, {}, [{ model: 'missing-provider', hidden: true }], [{ model: 'a/model', hidden: 'yes' }]]) {
    assert.throws(() => saveModelVisibility(changes, false, dir));
    assert.equal(readFileSync(join(dir, 'model-visibility.json'), 'utf8'), before);
  }
  writeFileSync(join(dir, 'model-visibility.json'), 'broken');
  assert.throws(() => readModelVisibility(dir));
  assert.throws(() => saveModelVisibility([{ model: 'b/model', hidden: true }], false, dir));
  assert.equal(readFileSync(join(dir, 'model-visibility.json'), 'utf8'), 'broken');
}));

test('provider catalog projects hidden models without changing credential availability, across adapter restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-scope-adapter-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const models = [{ provider: 'a', id: 'one', name: 'One', contextWindow: 1000 }, { provider: 'a', id: 'two', name: 'Two', contextWindow: 1000 }];
  const create = () => new ProviderAuthAdapter(async () => ({ getModels: () => models, getAvailableSnapshot: () => models,
    getProviders: () => [], getError: () => null }), { getThinkingCapabilities: () => ({ thinkingLevels: ['off'] }) });
  const first = create();
  try {
    await first.dispatch({ version: 1, operation: 'set_model_visibility', changes: [{ model: 'a/one', hidden: true }] });
    const second = create();
    const catalog = await second.catalog();
    assert.deepEqual(catalog.hiddenModels, ['a/one']);
    assert.equal(catalog.models[0].available, true);
    assert.equal(catalog.models[0].hidden, true);
    assert.equal(catalog.models[1].hidden, false);
    assert.deepEqual(await second.dispatch({ version: 1, operation: 'model_visibility' }), { hiddenModels: ['a/one'] });
    second.close();
  } finally {
    first.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
