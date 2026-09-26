// End-to-end HTTP regression: a second Run must not switch or stop the first.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import net from 'node:net';

if (process.platform === 'win32') {
  console.log('Concurrent fixture HTTP probe requires /bin/sh; skipped on Windows');
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), 'grapher-parallel-'));
let backend;
try {
  const repository = join(root, 'repo');
  await mkdir(repository);
  await writeFile(join(repository, 'base.txt'), 'original\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repository, stdio: 'pipe' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'initial');
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  backend = spawn(resolve('backend/target/debug/grapher'), [], {
    env: { ...process.env, GRAPHER_DATA_DIR: join(root, 'data'), GRAPHER_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  backend.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  const api = async (command, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, detail: 'metadata', compact: true }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || String(response.status));
    return data.result;
  };
  const until = async (condition, message) => {
    for (let i = 0; i < 200; i++) {
      if (backend.exitCode !== null) throw new Error(diagnostics);
      if (await condition()) return;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`${message}\n${diagnostics}`);
  };
  await until(async () => {
    try { await api('bootstrap'); return true; } catch { return false; }
  }, 'Backend failed to start');
  const exists = async path => { try { await access(path); return true; } catch { return false; } };
  const startRun = async name => {
    const started = join(root, `started-${name}`);
    const release = join(root, `release-${name}`);
    const script = join(root, `worker-${name}.sh`);
    await writeFile(script, `cat >/dev/null\ntouch '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.02; done\nprintf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Completed"}]}}'\n`);
    const graph = { originalGoal: name, nodes: [{ name: 'worker', task: name }], edges: [] };
    const config = { repository, model: 'test', engine: 'pi', piCommand: '/bin/sh', piArgs: [script], maxParallel: 1, maxFeedback: 0 };
    const snapshot = await api('save_graph', { graph, config });
    await api('control', { action: 'approve', runId: snapshot.runId });
    return { id: snapshot.runId, started, release };
  };
  const first = await startRun('first');
  await until(() => exists(first.started), 'First Run did not start');
  const second = await startRun('second');
  await until(() => exists(second.started), 'Second Run did not start alongside the first');
  assert.notEqual(first.id, second.id);
  await writeFile(second.release, 'go');
  await until(async () => (await api('snapshot', { runId: second.id })).phase === 'completed', 'Second Run did not finish');
  assert.equal((await api('snapshot', { runId: first.id })).nodes.worker.status, 'running');
  await writeFile(first.release, 'go');
  await until(async () => (await api('snapshot', { runId: first.id })).phase === 'completed', 'First Run did not finish');
  assert.equal((await api('history', { runId: second.id })).nodes.worker.status, 'done');
  console.log('Concurrent HTTP Runs completed independently without replacing the old session.');
} finally {
  if (backend && backend.exitCode === null) {
    const done = once(backend, 'exit');
    backend.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([done, new Promise(resolve => { timer = setTimeout(() => { backend.kill('SIGKILL'); resolve(); }, 5000); })]);
    } finally { clearTimeout(timer); }
  }
  await rm(root, { recursive: true, force: true });
}
