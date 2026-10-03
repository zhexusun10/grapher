// Production HTTP regressions, no model calls, isolated data and source folders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';

const delay = ms => new Promise(done => setTimeout(done, ms));

test('production HTTP confines static paths and refuses linked workspace cleanup', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-hardening-'));
  const listener = createServer();
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const { port } = listener.address();
  await new Promise(done => listener.close(done));
  const target = resolve(process.env.CARGO_TARGET_DIR || 'backend/target');
  const agent = join(directory, 'agent');
  await mkdir(agent);
  const backend = spawn(join(target, `debug/grapher${process.platform === 'win32' ? '.exe' : ''}`), [], {
    env: { ...process.env, GRAPHER_DATA_DIR: join(directory, 'data'), GRAPHER_PORT: String(port),
      PI_CODING_AGENT_DIR: agent, GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'runtime') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  let spawnError;
  backend.stderr.on('data', bytes => { diagnostics += bytes; });
  backend.on('error', error => { spawnError = error; });
  const api = async (command, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || String(response.status));
    return payload.result;
  };
  // Unlike fetch, node:http preserves backslashes and drive prefixes in the URI.
  const rawGet = path => new Promise((done, fail) => {
    const req = request({ hostname: '127.0.0.1', port, method: 'GET', path }, response => {
      response.resume();
      response.on('end', () => done(response.statusCode));
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP probe timed out')));
    req.on('error', fail);
    req.end();
  });
  try {
    for (let attempt = 0; ; attempt++) {
      if (spawnError) throw spawnError;
      assert.ok(backend.exitCode === null && attempt < 100, diagnostics || 'Backend did not start');
      try { await api('snapshot'); break; } catch {}
      await delay(50);
    }
    const failures = [];
    for (const path of ['/../backend/Cargo.toml', '/..\\backend\\Cargo.toml', '/C:/Windows/win.ini', '/\\\\localhost\\share\\file']) {
      const status = await rawGet(path);
      if (status !== 404) failures.push(`Static path escaped the web root (${status}): ${path}`);
    }
    const source = join(directory, 'source');
    const external = join(directory, 'external');
    await mkdir(source);
    await mkdir(external);
    await writeFile(join(source, 'file.txt'), 'source');
    const state = await api('save_graph', { graph: { originalGoal: 'hardening',
      nodes: [{ name: 'worker', task: 'never executed' }], edges: [] },
      config: { repository: source, model: 'unused', maxParallel: 1, maxFeedback: 0 } });
    const externalRun = join(external, state.runId);
    await mkdir(externalRun);
    await writeFile(join(externalRun, 'must-survive.txt'), 'external data');
    // Windows junctions do not require Developer Mode or symlink privilege.
    await symlink(external, join(directory, '.grapher-worktrees'), process.platform === 'win32' ? 'junction' : 'dir');
    try { await api('delete_run', { runId: state.runId }); } catch (error) {
      assert.match(String(error), /symlink|redirect|real director/i);
    }
    try { assert.equal(await readFile(join(externalRun, 'must-survive.txt'), 'utf8'), 'external data'); }
    catch { failures.push('Workspace cleanup followed a linked parent and deleted external data'); }
    assert.deepEqual(failures, []);
  } finally {
    if (backend.pid && backend.exitCode === null && backend.signalCode === null) {
      const exited = once(backend, 'exit');
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(backend.pid), '/F'], { stdio: 'ignore' });
      else backend.kill('SIGTERM');
      await exited;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});
