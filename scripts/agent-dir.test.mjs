import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readlinkSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reuseManagedTools } from '../engine/agent-dir.mjs';
import { prepareModelOverlay, overlayRuntimeOptions } from '../engine/model-config-overlay.mjs';

test('configuring the agent directory does not copy or link a host model catalog', () => {
  const root = mkdtempSync(join(tmpdir(), 'grapher-model-isolation-'));
  try {
    mkdirSync(join(root, '.pi/agent'), { recursive: true });
    writeFileSync(join(root, '.pi/agent/models.json'), '{"models":[]}');
    for (const isolated of ['0', '1']) {
      const target = join(root, `agent-${isolated}`);
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import {configureAgentDir} from './engine/agent-dir.mjs'; configureAgentDir();"], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: target,
          GRAPHER_ISOLATED_PI_MODELS: isolated },
        encoding: 'utf8',
      });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(existsSync(join(target, 'models.json')), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('model overlay refreshes Pi models, preserves dedicated entries and backs up the original', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grapher-model-overlay-'));
  const saved = process.env.GRAPHER_ISOLATED_PI_MODELS;
  delete process.env.GRAPHER_ISOLATED_PI_MODELS;
  try {
    const source = join(root, 'pi-models.json');
    const agent = join(root, 'agent');
    mkdirSync(agent);
    const target = join(agent, 'models.json');
    const dedicated = { providers: { shared: { api: 'openai-completions', apiKey: 'dedicated-key', models: [
      { id: 'same', name: 'old' }, { id: 'dedicated' }
    ] }, private: { models: [{ id: 'private' }] } } };
    writeFileSync(target, JSON.stringify(dedicated));
    const upstream = { providers: { shared: { baseUrl: 'https://example.test', models: [
      { id: 'same', name: 'new' }, { id: 'added' }
    ] } } };
    writeFileSync(source, JSON.stringify(upstream));
    const firstPath = await prepareModelOverlay(agent, JSON.parse, { source });
    const first = JSON.parse(readFileSync(firstPath, 'utf8'));
    assert.equal(await prepareModelOverlay(agent, JSON.parse, { source }), firstPath, 'unchanged refresh reuses its private snapshot');
    assert.equal(first.providers.shared.apiKey, 'dedicated-key');
    assert.deepEqual(first.providers.shared.models, [{ id: 'dedicated' }, { id: 'same', name: 'new' }, { id: 'added' }]);
    assert.deepEqual(first.providers.private, dedicated.providers.private);
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), dedicated);
    assert.deepEqual(JSON.parse(readFileSync(join(agent, 'models.json.grapher-backup'), 'utf8')), dedicated);
    assert.equal(await prepareModelOverlay(agent, JSON.parse, { source: target }), undefined, 'same file must not overlay itself');
    assert.equal(await prepareModelOverlay(agent, JSON.parse, { source: join(root, 'missing') }), undefined);
    assert.equal(await prepareModelOverlay(agent, JSON.parse, { source, validate: async path => path !== target }), target,
      'schema failure must select the original bad file for Pi diagnostics');
    const empty = join(root, 'empty-agent');
    mkdirSync(empty);
    assert.equal(await prepareModelOverlay(empty, JSON.parse, { source }), source, 'source alone is loaded directly');
    assert.deepEqual(await overlayRuntimeOptions({ modelsPath: join(root, 'explicit.json') }, agent, JSON.parse),
      { modelsPath: join(root, 'explicit.json') }, 'explicit model paths must not be replaced');
    upstream.providers.shared.models[0].name = 'refreshed';
    writeFileSync(source, JSON.stringify(upstream));
    const refreshed = JSON.parse(readFileSync(await prepareModelOverlay(agent, JSON.parse, { source }), 'utf8'));
    assert.equal(refreshed.providers.shared.models.find(m => m.id === 'same').name, 'refreshed');
    process.env.GRAPHER_ISOLATED_PI_MODELS = '1';
    assert.equal(await prepareModelOverlay(agent, JSON.parse, { source }), undefined);
    assert.deepEqual(await overlayRuntimeOptions({ modelsPath: null }, agent, JSON.parse), { modelsPath: null });
    delete process.env.GRAPHER_ISOLATED_PI_MODELS;
    writeFileSync(source, '{bad');
    assert.equal(await prepareModelOverlay(agent, JSON.parse, { source }), source, 'Pi receives the malformed file and reports its own warning');
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), dedicated);
  } finally {
    if (saved === undefined) delete process.env.GRAPHER_ISOLATED_PI_MODELS;
    else process.env.GRAPHER_ISOLATED_PI_MODELS = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('reuses executable managed tools without replacing local tools or importing other files', () => {
  const root = mkdtempSync(join(tmpdir(), 'grapher-managed-tools-'));
  try {
    const upstream = join(root, 'upstream');
    const target = join(root, 'target');
    mkdirSync(join(upstream, 'bin'), { recursive: true });
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const rg = `rg${suffix}`;
    const fd = `fd${suffix}`;
    writeFileSync(join(upstream, 'bin', rg), '#!/bin/sh\necho rg-fixture\n');
    chmodSync(join(upstream, 'bin', rg), 0o755);
    writeFileSync(join(upstream, 'bin', fd), 'not executable');
    writeFileSync(join(upstream, 'bin', 'other'), 'not a managed tool');
    reuseManagedTools(target, upstream);
    if (process.platform === 'win32') {
      assert.deepEqual(readFileSync(join(target, 'bin', rg)), readFileSync(join(upstream, 'bin', rg)));
    } else {
      assert.equal(readlinkSync(join(target, 'bin', rg)), join(upstream, 'bin', rg));
    }
    assert.equal(existsSync(join(target, 'bin', 'other')), false);
    if (process.platform !== 'win32') assert.equal(existsSync(join(target, 'bin', fd)), false);
    rmSync(join(target, 'bin', rg));
    writeFileSync(join(target, 'bin', rg), 'local tool');
    reuseManagedTools(target, upstream);
    assert.equal(readFileSync(join(target, 'bin', rg), 'utf8'), 'local tool');
    reuseManagedTools(join(root, 'empty-target'), join(root, 'missing'));
    assert.equal(existsSync(join(root, 'empty-target', 'bin')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
