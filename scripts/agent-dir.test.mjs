import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readlinkSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reuseManagedTools } from '../engine/agent-dir.mjs';

test('benchmark Pi config does not inherit a host model catalog', () => {
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
      assert.equal(existsSync(join(target, 'models.json')), isolated === '0');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    assert.equal(readlinkSync(join(target, 'bin', rg)), join(upstream, 'bin', rg));
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
