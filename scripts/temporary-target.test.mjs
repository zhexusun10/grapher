import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTemporaryTarget, runWithTemporaryTarget, withTemporaryTarget } from './temporary-target.mjs';

const marker = '.grapher-temporary-target.json';
const exists = async path => access(path).then(() => true, () => false);
const freshEnv = () => { const env = { ...process.env }; delete env.CARGO_TARGET_DIR; return env; };
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'grapher-target-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('owned targets are unique and scoped cleanup leaves concurrent builds alone', async context => {
  const parent = await fixture(context);
  const left = await createTemporaryTarget({ parent, env: {} });
  const right = await createTemporaryTarget({ parent, env: {} });
  assert.notEqual(left.directory, right.directory);
  assert.equal(left.owned, true);
  await writeFile(join(right.directory, 'keep'), 'another build');
  assert.equal(await left.cleanup(), true);
  assert.equal(await left.cleanup(), true);
  assert.equal(await exists(left.directory), false);
  assert.equal(await readFile(join(right.directory, 'keep'), 'utf8'), 'another build');
  assert.equal(await right.cleanup(), true);
});

test('callbacks clean owned targets after both success and failure without changing their result', async context => {
  const parent = await fixture(context);
  let directory;
  assert.equal(await withTemporaryTarget(async (env, target) => {
    directory = target.directory;
    assert.equal(env.CARGO_TARGET_DIR, directory);
    await mkdir(join(directory, 'debug'));
    await writeFile(join(directory, 'debug', 'artifact'), 'compiled');
    return 42;
  }, { parent, env: {} }), 42);
  assert.equal(await exists(directory), false);
  const failure = new Error('test failure');
  await assert.rejects(withTemporaryTarget(async (_env, target) => {
    directory = target.directory;
    throw failure;
  }, { parent, env: {} }), error => error === failure);
  assert.equal(await exists(directory), false);
});

test('explicit CARGO_TARGET_DIR belongs to the caller and is never deleted', async context => {
  const parent = await fixture(context);
  const shared = join(parent, 'reusable-target');
  await mkdir(shared);
  await writeFile(join(shared, 'keep'), 'reusable dependency');
  await withTemporaryTarget(async (env, target) => {
    assert.equal(target.owned, false);
    assert.equal(env.CARGO_TARGET_DIR, shared);
    assert.equal(env.CARGO_INCREMENTAL, '1', 'explicit debugging settings must survive');
  }, { parent: join(parent, 'must-not-be-created'), env: { CARGO_TARGET_DIR: shared, CARGO_INCREMENTAL: '1' } });
  assert.deepEqual(await readdir(parent), ['reusable-target']);
  assert.equal(await readFile(join(shared, 'keep'), 'utf8'), 'reusable dependency');
});

test('cleanup unlinks nested directory links without following their targets', async context => {
  const parent = await fixture(context);
  const outside = join(parent, 'source');
  await mkdir(outside); await writeFile(join(outside, 'keep'), 'source files');
  const target = await createTemporaryTarget({ parent, env: {} });
  await symlink(outside, join(target.directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await target.cleanup(), true);
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'source files');
});

test('changed ownership or a replaced root is retained rather than guessed safe', async context => {
  const parent = await fixture(context);
  const warnings = [];
  const options = { parent, env: {}, warn: message => warnings.push(message) };
  const changed = await createTemporaryTarget(options);
  await writeFile(join(changed.directory, 'keep'), 'unverified data');
  await writeFile(join(changed.directory, marker), JSON.stringify({ version: 1, owner: 'different owner' }));
  assert.equal(await changed.cleanup(), false);
  assert.equal(await readFile(join(changed.directory, 'keep'), 'utf8'), 'unverified data');
  const replaced = await createTemporaryTarget(options);
  const outside = join(parent, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'external source');
  await rename(replaced.directory, `${replaced.directory}-moved`);
  await symlink(outside, replaced.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await replaced.cleanup(), false);
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'external source');
  assert.equal(warnings.length, 2);
});

test('command exit codes and spawn errors survive automatic target cleanup', async context => {
  const parent = await fixture(context);
  const evidence = join(parent, 'target-path.txt');
  const listeners = process.listenerCount('SIGTERM');
  const result = await runWithTemporaryTarget([process.execPath, '-e',
    'const fs=require("node:fs"); fs.writeFileSync(process.argv[1],process.env.CARGO_TARGET_DIR); process.exit(7)', evidence,
  ], { parent, env: freshEnv(), stdio: 'ignore' });
  assert.equal(result.code, 7);
  assert.equal(await exists(await readFile(evidence, 'utf8')), false);
  await assert.rejects(runWithTemporaryTarget([join(parent, 'missing-command')], { parent, env: freshEnv(), stdio: 'ignore' }));
  assert.deepEqual(await readdir(parent), ['target-path.txt']);
  assert.equal(process.listenerCount('SIGTERM'), listeners);
});

test('CLI propagates arguments, cleans a failed build, and reports missing commands', async context => {
  const parent = await fixture(context);
  const evidence = join(parent, 'result.json');
  const cli = resolve('scripts/temporary-target.mjs');
  const env = { ...freshEnv(), TMPDIR: parent, TEMP: parent, TMP: parent };
  const result = spawnSync(process.execPath, [cli, '--', process.execPath, '-e',
    'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({target:process.env.CARGO_TARGET_DIR,arg:process.argv[2]})); process.exit(9)', evidence, 'space and 中文',
  ], { env, encoding: 'utf8' });
  assert.equal(result.status, 9, result.stderr);
  const saved = JSON.parse(await readFile(evidence, 'utf8'));
  assert.equal(saved.arg, 'space and 中文');
  assert.equal(await exists(saved.target), false);
  assert.equal(spawnSync(process.execPath, [cli], { env }).status, 2);
});

test('npm script mode gives the whole suite one target and forwards arguments without shell quoting', async context => {
  const parent = await fixture(context);
  const npm = join(parent, 'fake-npm.mjs');
  const evidence = join(parent, 'npm-result.json');
  await writeFile(npm, 'import fs from "node:fs"; fs.writeFileSync(process.env.GRAPHER_TEST_EVIDENCE,JSON.stringify({args:process.argv.slice(2),target:process.env.CARGO_TARGET_DIR})); process.exit(4);');
  const env = { ...freshEnv(), TMPDIR: parent, TMP: parent, TEMP: parent, npm_execpath: npm, GRAPHER_TEST_EVIDENCE: evidence };
  const result = spawnSync(process.execPath, [resolve('scripts/temporary-target.mjs'), '--npm-script', 'fake-suite', 'space and 中文'], { env, encoding: 'utf8' });
  assert.equal(result.status, 4, result.stderr);
  const saved = JSON.parse(await readFile(evidence, 'utf8'));
  assert.deepEqual(saved.args, ['run', 'fake-suite', '--', 'space and 中文']);
  assert.equal(await exists(saved.target), false);
});

test('locked Windows artifacts retain their marker and can be cleaned after release', { skip: process.platform !== 'win32', timeout: 15_000 }, async context => {
  const parent = await fixture(context);
  const warnings = [];
  const target = await createTemporaryTarget({ parent, env: {}, warn: message => warnings.push(message) });
  const file = join(target.directory, 'in-use.exe');
  await writeFile(file, 'owned file');
  const child = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command',
    '$f=[IO.File]::Open($env:GRAPHER_TEST_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); [Console]::WriteLine("ready"); [Console]::ReadLine() | Out-Null; $f.Dispose()',
  ], { env: { ...process.env, GRAPHER_TEST_LOCK: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    assert.equal(await target.cleanup(), false);
    assert.equal(await exists(join(target.directory, marker)), true);
    assert.equal(warnings.length, 1);
  } finally {
    const closed = once(child, 'close');
    child.stdin.end('\n');
    await closed;
  }
  assert.equal(await target.cleanup(), true);
});

test('SIGTERM waits for the owned command to exit before reclaiming its target', { skip: process.platform === 'win32', timeout: 15_000 }, async context => {
  const parent = await fixture(context);
  const evidence = join(parent, 'target-path.txt');
  const child = spawn(process.execPath, [resolve('scripts/temporary-target.mjs'), '--', process.execPath, '-e',
    'require("node:fs").writeFileSync(process.argv[1],process.env.CARGO_TARGET_DIR); setInterval(()=>{},1000)', evidence,
  ], { env: { ...freshEnv(), TMPDIR: parent }, stdio: 'ignore' });
  try {
    while (!await exists(evidence)) await new Promise(completed => setTimeout(completed, 20));
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 143);
    assert.equal(await exists(await readFile(evidence, 'utf8')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
