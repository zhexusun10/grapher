// Production HTTP entrypoints, no model calls: invalid
// bindings must be rejected before execution or snapshot side effects.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import net from 'node:net';

const root = await mkdtemp(join(tmpdir(), 'grapher-binding-'));
const source = join(root, 'source');
const moved = join(root, 'moved');
let child;
let diagnostics = '';
try {
  await mkdir(source);
  await writeFile(join(source, 'value'), 'base');
  const hooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${hooksPath}`, '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  child = spawn(`${resolve('backend/target/debug/grapher')}${process.platform === 'win32' ? '.exe' : ''}`, [], {
    env: { ...process.env, GRAPHER_DATA_DIR: join(root, 'data'), GRAPHER_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', data => { diagnostics += data; });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  async function api(command, body = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || String(response.status));
    return data.result;
  }
  for (let attempt = 0; ; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || attempt > 100) throw new Error(diagnostics || 'Backend did not start');
    try { await api('repository_status', { repository: source }); break; } catch {}
    await new Promise(done => setTimeout(done, 50));
  }
  assert.equal((await api('repository_status', { repository: source })).valid, true);
  assert.equal((await api('repository_status', { repository: 'relative' })).valid, false);
  const plain = join(root, 'plain');
  await mkdir(plain);
  assert.equal((await api('repository_status', { repository: plain })).valid, true);
  assert.deepEqual(await readdir(plain), []);
  const graph = { originalGoal: 'binding regression', nodes: [{ name: 'worker', task: 'unused' }], edges: [] };
  const config = { repository: source, model: 'unused', maxParallel: 2, maxFeedback: 1 };
  await api('save_graph', { graph, config });
  await writeFile(join(source, 'planner.txt'), 'planner must survive reject');
  await api('control', { action: 'reject' });
  assert.equal(await readFile(join(source, 'planner.txt'), 'utf8'), 'planner must survive reject');
  await api('save_graph', { graph, config });
  const before = await api('snapshot');
  // Looking at another binding cannot rebind the active run.
  await api('repository_status', { repository: plain });
  assert.equal((await api('snapshot')).config.repository, source);
  await rename(source, moved);
  assert.equal((await api('repository_status', { repository: source })).valid, false);
  await assert.rejects(api('control', { action: 'approve' }), /项目绑定已失效/);
  await assert.rejects(api('plan_goal', { goal: 'must not run', config }), /项目绑定已失效/);
  const after = await api('snapshot');
  assert.equal(after.runId, before.runId);
  assert.equal(after.approved, false);
  assert.deepEqual(after.executions, []);
  assert.equal(await readFile(join(moved, 'planner.txt'), 'utf8'), 'planner must survive reject');
  assert.equal((await readdir(root)).includes('source'), false);
  console.log('Production HTTP binding checks passed: read-only status, project switching, Reject preserves Planner files, moved binding rejects approval/planning.');
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    const timer = setTimeout(() => {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 5000);
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else {
      child.kill('SIGTERM');
    }
    try { await exited; } finally { clearTimeout(timer); }
  }
  await rm(root, { recursive: true, force: true });
}
