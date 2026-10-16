import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { devPort, loadDevEnvironment, runDev } from './dev.mjs';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t, behavior = {}) {
  const root = mkdtempSync(join(tmpdir(), 'grapher-dev-启动 # %-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'child.mjs');
  writeFileSync(script, `
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
const phase = process.argv[2];
const behavior = JSON.parse(process.env.BEHAVIOR);
if (phase === 'setup' || phase === 'build') {
  await delay(behavior[phase + 'Delay'] ?? 0);
  process.exit(behavior[phase + 'Exit'] ?? 0);
} else if (behavior[phase + 'Exit'] !== undefined) {
  process.exit(behavior[phase + 'Exit']);
} else if (behavior.noListen) {
  setInterval(() => {}, 1000);
} else {
  createServer((req, res) => { res.writeHead(415); res.end('JSON POST required'); })
    .listen(Number(process.env.GRAPHER_PORT), '127.0.0.1');
}
`);
  const children = [];
  const phases = [];
  const logs = [];
  const signals = new EventEmitter();
  const env = { ...process.env, GRAPHER_PORT: String(await freePort()), GRAPHER_FRONTEND_PORT: String(await freePort()), BEHAVIOR: JSON.stringify(behavior) };
  const spawnProcess = (command, args, options) => {
    const phase = args[0] === 'build' || args[0] === 'run' || args[0] === 'setup' ? args[0] : 'frontend';
    phases.push(phase);
    assert.equal(options.cwd, root);
    assert.equal(options.env.GRAPHER_PORT, env.GRAPHER_PORT);
    if (phase === 'frontend') assert.equal(args.at(-1), env.GRAPHER_FRONTEND_PORT);
    const child = spawn(process.execPath, [script, phase], { ...options, stdio: 'ignore' });
    children.push(child);
    return child;
  };
  const options = { installationRoot: root, env, signals, spawnProcess, ensureReady: async () => {},
    startupTimeoutMs: 1000, log: text => logs.push(text), logError: text => logs.push(text) };
  let dev;
  t.after(async () => { signals.emit('SIGTERM'); if (dev) await dev.stop(); });
  return { root, env, signals, phases, logs, children, options,
    start: async overrides => { dev = await runDev({ ...options, ...overrides }); return dev; } };
}

test('cold compilation is outside the server readiness timeout; frontend starts only after readiness', { timeout: 10000 }, async t => {
  const f = await fixture(t, { buildDelay: 1300 });
  const dev = await f.start();
  assert.deepEqual(f.phases, ['build', 'run', 'frontend']);
  assert.ok(f.logs.some(text => text.includes('Backend ready')));
  await dev.stop();
  assert.equal(await dev.completed, 0);
  assert.equal(f.signals.listenerCount('SIGINT'), 0);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('setup and build errors fail closed without starting backend/frontend', async t => {
  const missing = await fixture(t);
  const first = await missing.start({ ensureReady: async () => { throw new Error('missing host prerequisite'); } });
  assert.equal(await first.completed, 1);
  assert.deepEqual(missing.phases, []);
  const failed = await fixture(t, { buildExit: 7 });
  const second = await failed.start();
  assert.equal(await second.completed, 1);
  assert.deepEqual(failed.phases, ['build']);
  assert.ok(failed.logs.some(text => text.includes('failed (7)')));
});

test('a backend exit aborts readiness immediately instead of waiting for the timeout', { timeout: 5000 }, async t => {
  const f = await fixture(t, { runExit: 2 });
  const dev = await f.start({ startupTimeoutMs: 60000 });
  assert.equal(await dev.completed, 2);
  assert.deepEqual(f.phases, ['build', 'run']);
});

test('an unresponsive backend times out only after compilation and is cleaned up', async t => {
  const f = await fixture(t, { noListen: true });
  const dev = await f.start({ startupTimeoutMs: 200 });
  assert.equal(await dev.completed, 1);
  assert.deepEqual(f.phases, ['build', 'run']);
  assert.ok(f.logs.some(text => text.includes('after compilation finished')));
  assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
});

test('unexpected frontend exit stops the owned backend', async t => {
  const f = await fixture(t, { frontendExit: 3 });
  const dev = await f.start();
  assert.equal(await dev.completed, 3);
  assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
});

for (const phase of ['setup', 'build']) {
  test(`Ctrl+C cancels owned ${phase} work before any server is started`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { [`${phase}Delay`]: 60000 });
    const spawnProcess = (command, args, options) => {
      const child = f.options.spawnProcess(command, args, options);
      child.once('spawn', () => f.signals.emit('SIGINT'));
      return child;
    };
    const dev = await f.start({ spawnProcess, ensureReady: phase === 'setup' ? async ({ run }) => run(process.execPath, ['setup']) : async () => {} });
    assert.equal(await dev.completed, 130);
    assert.deepEqual(f.phases, [phase]);
    assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
  });
}

test('an occupied port is rejected before setup and its listener is not terminated', async t => {
  const f = await fixture(t);
  const server = createServer((req, res) => res.end('unrelated'));
  await new Promise(resolve => server.listen(Number(f.env.GRAPHER_PORT), '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let installed = false;
  const dev = await f.start({ ensureReady: async () => { installed = true; } });
  assert.equal(await dev.completed, 1);
  assert.equal(installed, false);
  assert.deepEqual(f.phases, []);
  assert.equal(await (await fetch(`http://127.0.0.1:${f.env.GRAPHER_PORT}`)).text(), 'unrelated');
});

test('.env ports are shared with backend and Vite; inherited values win and secrets are not logged', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.root, 'backend'));
  writeFileSync(join(f.root, '.env'), '# comment\nGRAPHER_PORT="4321"\nSECRET_KEY=private\n');
  writeFileSync(join(f.root, 'backend/.env'), 'GRAPHER_PORT=9876\nOTHER=ignored\n');
  const env = loadDevEnvironment(f.root, {});
  assert.equal(env.GRAPHER_PORT, '4321');
  assert.equal(env.SECRET_KEY, 'private');
  assert.equal(env.OTHER, undefined);
  assert.equal(loadDevEnvironment(f.root, { GRAPHER_PORT: '5432' }).GRAPHER_PORT, '5432');
  assert.equal(process.env.SECRET_KEY, undefined);
});

test('the PATH key keeps the launcher casing and stays spawnable on Windows', async t => {
  const root = mkdtempSync(join(tmpdir(), 'grapher-dev-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const withoutPath = { ...process.env };
  for (const name of Object.keys(withoutPath)) if (/^path$/i.test(name)) delete withoutPath[name];
  // Explorer/PowerShell chains deliver "Path", POSIX shells "PATH"; a child env
  // containing both names makes spawn fail to locate any executable.
  for (const [key, value] of [['Path', 'C:\\Git\\cmd'], ['PATH', '/usr/bin']]) {
    const env = loadDevEnvironment(root, { ...withoutPath, [key]: value });
    assert.deepEqual(Object.keys(env).filter(name => /^path$/i.test(name)), [key]);
    assert.equal(env[key], `${join(homedir(), '.cargo/bin')}${delimiter}${value}`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-p', '0'], { env, cwd: root });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`spawned child exited ${code}`)));
    });
  }
});

test('invalid and conflicting ports fail before installation', async t => {
  for (const value of ['', '0', '-1', '65536', '1421oops', '1.5']) {
    assert.throws(() => devPort(value, 1421, 'GRAPHER_PORT'), /integer from 1 to 65535/);
  }
  assert.equal(devPort(undefined, 1421, 'GRAPHER_PORT'), 1421);
  const f = await fixture(t);
  const dev = await f.start({ env: { ...f.env, GRAPHER_PORT: f.env.GRAPHER_FRONTEND_PORT } });
  assert.equal(await dev.completed, 1);
  assert.deepEqual(f.phases, []);
});
