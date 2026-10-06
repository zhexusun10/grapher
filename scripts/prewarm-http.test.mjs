// Real production launcher/RPC with a loopback model only. No paid providers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { root } from './pi-baseline.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));

test('Auto refills during routing and older completions cannot revert a newly configured ready worker', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-prewarm-http-'));
  let backend;
  let diagnostics = '';
  let releaseRoute;
  const routeRelease = new Promise(done => { releaseRoute = done; });
  let enteredRoute;
  const routeEntered = new Promise(done => { enteredRoute = done; });
  const errors = [];
  const requests = [];
  const modelServer = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const value = JSON.parse(body);
      requests.push(value.model);
      if (value.model === 'router') {
        enteredRoute();
        await routeRelease;
      }
      const chunk = (delta, finish_reason) => ({ id: 'prewarm-test', object: 'chat.completion.chunk', created: 1,
        model: value.model, choices: [{ index: 0, delta, finish_reason }] });
      const createGraph = value.model === 'planner' && !value.messages.some(message => message.role === 'tool');
      const delta = createGraph ? { role: 'assistant', tool_calls: [{ index: 0, id: 'create-node', type: 'function',
        function: { name: 'node', arguments: JSON.stringify({ nodes: [{ name: 'A', task: 'Return completed' }] }) } }] }
        : { role: 'assistant', content: value.model.startsWith('router') ? 'serial' : 'Completed' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, createGraph ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      errors.push(error);
      response.writeHead(500);
      response.end(String(error));
    }
  });
  try {
    const source = join(directory, 'source');
    const data = join(directory, 'data');
    const agent = join(directory, 'agent');
    await mkdir(source);
    await mkdir(agent);
    await writeFile(join(source, 'base.txt'), 'keep');
    await new Promise(done => modelServer.listen(0, '127.0.0.1', done));
    const modelPort = modelServer.address().port;
    const model = id => ({ id, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'prewarm-test': {
      baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', apiKey: 'loopback-only',
      models: [model('router'), model('router-next'), model('node'), model('planner')],
    } } }));
    const listener = createServer();
    await new Promise(done => listener.listen(0, '127.0.0.1', done));
    const port = listener.address().port;
    await new Promise(done => listener.close(done));
    const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'backend/target');
    const env = { ...process.env, GRAPHER_DATA_DIR: data, GRAPHER_PORT: String(port), PI_CODING_AGENT_DIR: agent,
      GRAPHER_GLOBAL_PI_AGENT_DIR: join(directory, 'global-agent'), GRAPHER_ISOLATED_PI_MODELS: '1',
      GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'runtime'), GRAPHER_WORKSPACE_PARENT: join(directory, 'workspaces'), PARTITIONER_MODEL: undefined,
      NODE_AGENT_MODEL: 'prewarm-test/node', PLANNER_MODEL: 'prewarm-test/planner', MERGER_MODEL: 'prewarm-test/node',
      PARTITIONER_THINKING: 'off', NODE_AGENT_THINKING: 'off', PLANNER_THINKING: 'off', MERGER_THINKING: 'off' };
    backend = spawn(join(target, `debug/grapher${process.platform === 'win32' ? '.exe' : ''}`), [], {
      cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    backend.stdout.on('data', bytes => { diagnostics += bytes; });
    backend.stderr.on('data', bytes => { diagnostics += bytes; });
    let spawnError;
    backend.on('error', error => { spawnError = error; });
    const api = async (command, body = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.error || String(response.status));
      return payload.result;
    };
    const until = async (check, label) => {
      const start = Date.now();
      while (Date.now() - start < 60000) {
        if (spawnError) throw spawnError;
        assert.equal(backend.exitCode, null, diagnostics);
        assert.equal(backend.signalCode, null, diagnostics);
        assert.deepEqual(errors, []);
        if (await check()) return;
        await delay(50);
      }
      throw new Error(`${label}\n${diagnostics}`);
    };
    await until(async () => { try { await api('snapshot'); return true; } catch { return false; } }, 'Backend not ready');
    // The independent credential host warms without a selected project. Its
    // private handshake must not check credentials or make provider requests.
    await until(() => diagnostics.includes('Provider/Auth prewarm ready in '), 'Provider/Auth host not prepared');
    assert.deepEqual(requests, []);
    const config = { repository: source, model: 'prewarm-test/node', thinkingLevel: 'off', maxParallel: 1, maxFeedback: 0,
      roleModels: { partitioner: { model: 'prewarm-test/router', thinkingLevel: 'off' } } };
    await api('save_config', { config });
    const readyCount = () => (diagnostics.match(/Partitioner prewarm ready in /g) || []).length;
    await until(() => readyCount() >= 1 && diagnostics.includes('Planner prewarm ready in ') && diagnostics.includes('Serial prewarm ready in '),
      'All three source roles did not become process-ready');
    assert.deepEqual(requests, [], 'preloading must not make model calls');
    const catalog = await api('provider_auth', { version: 1, operation: 'catalog', refresh: false });
    assert.ok(catalog.providers.some(provider => provider.id === 'prewarm-test' && provider.configured));
    assert.equal((diagnostics.match(/Provider\/Auth prewarm ready in /g) || []).length, 1, 'the claimed credential host must not be replenished/duplicated');
    assert.deepEqual(requests, []);
    const planned = api('plan_goal', { goal: 'Return Completed without tools', config });
    // Attach a rejection handler immediately; readiness polling may precede await.
    planned.catch(() => {});
    await Promise.race([routeEntered, planned.then(() => { throw new Error('Router did not enter the held model call'); })]);
    await until(() => readyCount() >= 2, 'Replacement was not prepared during the held route');
    assert.deepEqual(requests, ['router'], 'the replacement must remain idle');
    const nextConfig = { ...config, roleModels: { partitioner: { model: 'prewarm-test/router-next', thinkingLevel: 'off' } } };
    await api('save_config', { config: nextConfig });
    assert.equal(readyCount(), 2, 'model changes must retain the unbound replacement; no model is loaded yet');
    assert.deepEqual(requests, ['router'], 'configuration warming must also remain idle');
    releaseRoute();
    const state = await planned;
    const assertReused = async (state, role = 'partition') => {
      const log = await readFile(join(data, 'planning', state.planningId, `${role}.jsonl`), 'utf8');
      const started = log.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line))
        .find(event => event.type === 'grapher_process_started');
      assert.equal(started.prewarmed, true);
      assert.equal(started.prewarmStage, 'process');
      assert.equal(typeof started.taskBindingMs, 'number');
      assert.ok(started.taskBindingMs >= 0);
      assert.ok(started.prewarmReadyMs >= 0);
      assert.ok(started.launchPreparationMs >= 0);
    };
    await assertReused(state);
    await until(async () => {
      const snapshot = await api('snapshot', { runId: state.runId });
      const execution = snapshot.executions.find(value => value.node === 'task' && value.status === 'completed');
      if (!execution) return false;
      const output = await api('get_execution_output', { runId: state.runId, executionId: execution.id, full: true });
      const started = output.content.split(/\r?\n/).filter(line => line.startsWith('{')).map(JSON.parse)
        .find(event => event.type === 'grapher_process_started');
      assert.equal(started.prewarmed, true, 'Serial first turn must claim its independent prepared process');
      assert.equal(started.prewarmStage, 'process');
      assert.equal(started.sessionId, execution.sessionId);
      assert.equal(typeof started.taskBindingMs, 'number');
      return true;
    }, 'First Serial turn did not complete');
    const nextState = await api('plan_goal', { goal: 'Return Completed without tools', config: nextConfig });
    await assertReused(nextState);
    assert.ok(requests.includes('router-next'), 'the retained host must use the newly bound model, not the older model');
    // Windows has no Graph sandbox prerequisite. The direct source-role
    // contract tests Planner on every host without depending on bubblewrap.
    if (process.platform === 'win32') {
      const graphState = await api('plan_goal', { goal: 'Create one node A without approving execution', config: nextConfig, mode: 'graph' });
      await assertReused(graphState, 'planner');
      assert.equal(graphState.graph.nodes[0].name, 'A');
      assert.equal(graphState.approved, false);
    }
    assert.equal(await readFile(join(source, 'base.txt'), 'utf8'), 'keep');
  } finally {
    releaseRoute();
    if (backend?.pid && backend.exitCode === null && backend.signalCode === null) {
      const exited = once(backend, 'exit');
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(backend.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else backend.kill('SIGTERM');
      await exited;
    }
    modelServer.closeAllConnections();
    await new Promise(done => modelServer.close(done));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});
