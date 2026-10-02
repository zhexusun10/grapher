import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { root, lock } from './pi-baseline.mjs';

// Exercise the same CLI and IPC entrypoints the Rust host launches, without
// loading user credentials or contacting a provider. This catches SDK imports,
// CLI flags and DTO drift that a types-only compatibility probe cannot see.
const resolverUrl = pathToFileURL(join(root, 'pi/packages/coding-agent/src/experimental/source-resolver.ts')).href;

test('production Pi CLI reports the pinned version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-pi-cli-'));
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'engine/entrypoint.mjs'), '--version'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, PI_CODING_AGENT_DIR: dir },
    });
    assert.equal(stdout.trim(), lock.packageVersion);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Settings IPC discovers extensions and persists removal/restoration without executing user code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-pi-extensions-ipc-'));
  try {
    const global = join(dir, 'global');
    mkdirSync(join(global, 'extensions'), { recursive: true });
    const file = join(global, 'extensions/probe.ts');
    const code = 'throw new Error("must not execute at discovery");';
    writeFileSync(file, code);
    const call = fields => JSON.parse(execFileSync(process.execPath, ['--import', resolverUrl, join(root, 'engine/extensions-host.ts')], {
      encoding: 'utf8', timeout: 30000, input: JSON.stringify({ version: 1, ...fields }),
      env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, 'own'), GRAPHER_GLOBAL_PI_AGENT_DIR: global, GRAPHER_ISOLATED_PI_MODELS: '1' },
    })).result;
    const extension = call({ operation: 'catalog' }).extensions.find(extension => !extension.bundled);
    assert.ok(extension);
    assert.equal(call({ operation: 'set_enabled', id: extension.id, enabled: false }).extensions.find(value => value.id === extension.id).enabled, false);
    assert.equal(call({ operation: 'catalog' }).extensions.find(value => value.id === extension.id).enabled, false);
    assert.equal(call({ operation: 'set_enabled', id: extension.id, enabled: true }).extensions.find(value => value.id === extension.id).enabled, true);
    assert.equal(readFileSync(file, 'utf8'), code);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Provider/Auth IPC returns a catalog after input EOF without exposing credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-pi-provider-'));
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      SystemRoot: process.env.SystemRoot,
      windir: process.env.windir,
      PI_CODING_AGENT_DIR: dir,
    };
    const output = execFileSync(process.execPath, ['--import', resolverUrl, join(root, 'engine/provider-host.ts')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 8 * 1024 * 1024,
      input: [
        { version: 1, operation: 'catalog', refresh: false },
        { version: 0, operation: 'catalog', refresh: false },
      ].map(request => JSON.stringify(request)).join('\n') + '\n',
      env,
    });
    const lines = output.trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(Buffer.byteLength(line) <= 4 * 1024 * 1024, 'Rust adapter rejects responses over 4 MiB');
    const replies = lines.map(JSON.parse);
    const catalog = replies.find(reply => reply.result?.providers);
    assert.equal(catalog?.version, 1);
    assert.ok(Array.isArray(catalog.result.providers) && catalog.result.providers.length > 0);
    assert.ok(catalog.result.providers.every(p => typeof p.id === 'string' && Array.isArray(p.methods)));
    assert.ok(Array.isArray(catalog.result.models) && catalog.result.models.length > 0);
    assert.ok(catalog.result.models.every(m => typeof m.id === 'string' && typeof m.provider === 'string' && typeof m.available === 'boolean'));
    assert.deepEqual(replies.find(reply => reply.error), { version: 1, error: 'Provider/Auth operation failed. Refresh providers or restart login.' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
