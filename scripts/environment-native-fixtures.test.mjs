import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { venvCreationCommand, startBackgroundWriter } from './fixtures/environment-native.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const shell = process.platform === 'win32'
  ? join(resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../..'), 'bin/bash.exe') : '/bin/bash';

function bashPath(path) {
  return process.platform === 'win32'
    ? execFileSync(shell, ['--noprofile', '--norc', '-c', `/usr/bin/cygpath -u ${quote(path.replaceAll('\\', '/'))}`], { encoding: 'utf8' }).trim()
    : path;
}

test('venv creation uses the selected bootstrap, not an earlier host Python, without rebinding later calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ge-fixture-中 space-'));
  try {
    const selected = join(directory, 'selected Python');
    const host = join(directory, 'host Python');
    for (const [path, label] of [[selected, 'SELECTED'], [host, 'HOST']]) {
      await mkdir(path);
      await writeFile(join(path, 'python'), `#!/bin/sh\nprintf '%s:%s\\n' '${label}' "$*"\n`, { mode: 0o755 });
    }
    const command = `export PATH=${quote(bashPath(host))}; ${venvCreationCommand(join(selected, 'python'))}; python -V`;
    const result = spawnSync(shell, ['--noprofile', '--norc', '-c', command], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.replaceAll('\r\n', '\n'), 'SELECTED:-m venv .venv\nHOST:-V\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('background fixture confirms its partial write and remains in the owner lifecycle boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ge-writer-中 space-'));
  let pid;
  try {
    await mkdir(join(directory, '.venv'));
    pid = await startBackgroundWriter(directory);
    assert.equal(await readFile(join(directory, '.venv/background-partial'), 'utf8'), 'partial');
    process.kill(pid, 0);
    const heartbeat = join(directory, '.venv/background-partial-heartbeat');
    const initial = await readFile(heartbeat, 'utf8');
    await new Promise(done => setTimeout(done, 500));
    assert.notEqual(await readFile(heartbeat, 'utf8'), initial, 'the fixture must be an active writer');
    if (process.platform !== 'win32') {
      const group = pid => execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      assert.equal(group(pid), group(process.pid), 'unref must not create a detached process group');
    }
  } finally {
    if (pid) process.kill(pid, 'SIGKILL');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
