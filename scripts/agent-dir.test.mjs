import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readlinkSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reuseManagedTools } from '../engine/agent-dir.mjs';

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
