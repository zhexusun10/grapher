// Windows production backend, isolated LocalAppData and a loopback-only model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { root } from './pi-baseline.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));

test('Windows projects/backends share a persistent engine and default workspaces to LocalAppData', {
  skip: process.platform !== 'win32', timeout: 180000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-shared-runtime-'));
  const backends = [];
  let modelCalls = 0;
  const modelServer = createServer(async (request, response) => {
    for await (const _ of request) { /* drain the loopback request */ }
    modelCalls++;
    const chunk = (delta, finish_reason) => ({ id: 'cache-test', object: 'chat.completion.chunk', created: 1,
      model: 'node', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Completed' }, null))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  const stop = async backend => {
    if (backend.child.exitCode !== null || backend.child.signalCode !== null) return;
    const exited = once(backend.child, 'exit');
    try { execFileSync('taskkill', ['/PID', String(backend.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await exited;
  };
  const until = async (backend, check, label) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      assert.equal(backend.child.exitCode, null, backend.diagnostics);
      assert.equal(backend.child.signalCode, null, backend.diagnostics);
      assert.doesNotMatch(backend.diagnostics, /Graph runtime prewarm unavailable:/, backend.diagnostics);
      if (await check()) return;
      await delay(50);
    }
    throw new Error(`${label}\n${backend.diagnostics}`);
  };
  try {
    await new Promise(done => modelServer.listen(0, '127.0.0.1', done));
    const agent = join(directory, 'agent');
    await mkdir(agent);
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'cache-test': {
      baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, api: 'openai-completions', apiKey: 'loopback-only',
      models: [{ id: 'node', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const local = join(directory, 'LocalAppData');
    const cache = join(local, 'Grapher', 'workspaces');
    const engines = join(cache, '.grapher-workspaces');
    const start = async name => {
      const source = join(directory, 'Desktop', name);
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'base.txt'), 'keep');
      const listener = createServer();
      await new Promise(done => listener.listen(0, '127.0.0.1', done));
      const port = listener.address().port;
      await new Promise(done => listener.close(done));
      const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'backend/target');
      const env = { ...process.env, GRAPHER_DATA_DIR: join(directory, `data-${name}`), GRAPHER_PORT: String(port),
        // Isolate engine preparation explicitly to avoid inspecting the real
        // installation's legacy caches; node placement uses the OS default.
        LOCALAPPDATA: local, GRAPHER_CACHE_DIR: undefined, GRAPHER_NATIVE_RUNTIME_PARENT: engines,
        GRAPHER_NATIVE_RUNTIME_DIR: undefined, GRAPHER_WORKSPACE_PARENT: undefined,
        PI_CODING_AGENT_DIR: agent, GRAPHER_GLOBAL_PI_AGENT_DIR: join(directory, 'global-agent'), GRAPHER_ISOLATED_PI_MODELS: '1' };
      for (const role of ['PARTITIONER', 'PLANNER', 'NODE_AGENT', 'MERGER']) {
        env[`${role}_MODEL`] = 'cache-test/node';
        env[`${role}_THINKING`] = 'off';
      }
      const backend = { child: spawn(join(target, 'debug/grapher.exe'), [], { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] }),
        source, diagnostics: '' };
      backends.push(backend);
      backend.child.stdout.on('data', bytes => { backend.diagnostics += bytes; });
      backend.child.stderr.on('data', bytes => { backend.diagnostics += bytes; });
      backend.api = async (command, body = {}) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        const payload = await response.json();
        assert.ok(response.ok && !payload.error, payload.error || String(response.status));
        return payload.result;
      };
      await until(backend, async () => { try { await backend.api('snapshot'); return true; } catch { return false; } }, 'Backend not ready');
      backend.config = { repository: source, model: 'cache-test/node', thinkingLevel: 'off', maxParallel: 1, maxFeedback: 0 };
      await backend.api('save_config', { config: backend.config });
      return backend;
    };
    const [first, second] = await Promise.all([start('alpha'), start('beta')]);
    const ready = backend => until(backend, () => backend.diagnostics.includes('Shared Graph runtime ready: '), 'Shared runtime not prepared');
    await Promise.all([ready(first), ready(second)]);
    assert.equal(modelCalls, 0, 'preparation must not call a model');
    const copies = await readdir(engines);
    const names = copies.filter(name => name.startsWith('grapher-native-engine-'));
    assert.equal(names.length, 1, 'different projects/data roots must share one copy');
    const engine = join(engines, names[0]);
    const marker = JSON.parse(await readFile(join(engine, '.grapher-native-runtime.json'), 'utf8'));
    assert.equal(marker.version, 2);
    assert.equal(marker.ready, true);
    for (const backend of [first, second]) {
      const path = backend.diagnostics.match(/Shared Graph runtime ready: ([^\r\n]+)/)[1];
      assert.equal(await realpath(path), await realpath(engine));
    }
    const draft = await first.api('save_graph', { graph: { originalGoal: 'Return Completed', nodes: [{ name: 'A', task: 'Return Completed without tools' }], edges: [] }, config: first.config });
    await first.api('control', { action: 'approve', runId: draft.runId });
    let completed;
    await until(first, async () => {
      completed = await first.api('snapshot');
      return completed.phase === 'completed';
    }, 'Graph did not publish');
    assert.equal(completed.executions.length, 1);
    assert.ok(completed.executions[0].worktree.toLowerCase().startsWith(join(cache, '.grapher-worktrees', draft.runId).toLowerCase()));
    assert.equal(await readFile(join(first.source, 'base.txt'), 'utf8'), 'keep');
    await stop(first);
    assert.equal((await readdir(engines)).filter(name => name.startsWith('grapher-native-engine-')).length, 1);
    const restarted = await start('alpha');
    await ready(restarted);
    assert.deepEqual((await readdir(engines)).filter(name => name.startsWith('grapher-native-engine-')), names, 'restart reuses the cache while another backend holds its reader');
    await stop(second);
    await stop(restarted);
    assert.ok(await readFile(join(engine, 'engine/entrypoint.mjs')), 'cache survives all backend exits');
  } finally {
    await Promise.all(backends.map(stop));
    modelServer.closeAllConnections();
    await new Promise(done => modelServer.close(done));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});
