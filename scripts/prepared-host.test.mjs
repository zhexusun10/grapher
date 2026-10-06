// Production Pi, isolated resources, loopback model only; no paid providers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { root } from './pi-baseline.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
function host(role, cwd, env) {
  const child = spawn(process.execPath, [join(root, 'engine/entrypoint.mjs'), '--grapher-prewarm', role], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events = [];
  let diagnostics = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdin.on('error', () => {});
  child.stderr.on('data', bytes => { diagnostics += bytes; });
  createInterface({ input: child.stdout }).on('line', line => {
    try { events.push(JSON.parse(line)); } catch { diagnostics += line; }
  });
  const wait = async (predicate, label = role) => {
    const start = Date.now();
    while (Date.now() - start < 30000) {
      if (spawnError) throw spawnError;
      const value = predicate();
      if (value) return value;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited: ${diagnostics}`);
      await delay(10);
    }
    throw new Error(`${label} timed out: ${diagnostics}`);
  };
  const request = async message => {
    const id = randomUUID();
    child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
    return wait(() => events.find(event => event.id === id && event.type === 'response'), message.type);
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else child.kill('SIGTERM');
      await closed;
    }
  };
  return { child, events, request, wait, stop, get diagnostics() { return diagnostics; } };
}

test('three prepared roles bind real isolated sessions; Planner paths, extensions, tools and RPC bytes are task-scoped', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-prepared-host-'));
  const children = [];
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const value = JSON.parse(raw);
      requests.push(value);
      const createGraph = value.model === 'planner' && !value.messages.some(message => message.role === 'tool');
      const delta = createGraph ? { role: 'assistant', tool_calls: [{ index: 0, id: 'create-node', type: 'function',
        function: { name: 'node', arguments: JSON.stringify({ nodes: [{ name: 'A', task: 'Return completed' }] }) } }] }
        : { role: 'assistant', content: `completed-${value.model}` };
      const chunk = (delta, finish_reason) => ({ id: 'prepared-test', object: 'chat.completion.chunk', created: 1,
        model: value.model, choices: [{ index: 0, delta, finish_reason }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, createGraph ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(error); response.writeHead(500); response.end(String(error)); }
  });
  try {
    const source = join(directory, 'source spaces # 中文');
    const other = join(directory, 'other');
    const agent = join(directory, 'agent');
    const global = join(directory, 'global');
    const marker = join(directory, 'loaded.jsonl');
    for (const path of [source, other, agent, join(global, 'extensions')]) await mkdir(path, { recursive: true });
    await writeFile(join(global, 'extensions/probe.ts'), `import { appendFileSync } from 'node:fs';\nexport default function(pi) { appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ role: process.env.GRAPHER_MODE, run: process.env.GRAPHER_ACTIVE_RUN_ID, execution: process.env.GRAPHER_NODE_EXECUTION_ID, graph: process.env.GRAPHER_GRAPH_PATH }) + '\\n'); }`);
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const model = id => ({ id, reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'prepared-test': {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'loopback-only',
      models: ['partition', 'planner', 'node'].map(model),
    } } }));
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent, GRAPHER_GLOBAL_PI_AGENT_DIR: global,
      GRAPHER_ISOLATED_PI_MODELS: '1', PI_OFFLINE: '1', GRAPHER_ACTIVE_RUN_ID: 'outer-must-not-leak',
      GRAPHER_GRAPH_PATH: join(other, 'outer-graph.json') };
    const roles = ['partition', 'planner', 'node'];
    const started = performance.now();
    const prepared = roles.map(role => { const value = host(role, source, env); children.push(value); return value; });
    await Promise.all(prepared.map((value, index) => value.request({ type: 'grapher_prepare', role: roles[index] })
      .then(response => assert.equal(response.success, true))));
    t.diagnostic(`three-role concurrent process preparation: ${(performance.now() - started).toFixed(0)}ms`);
    assert.deepEqual(requests, []);
    assert.deepEqual(await readdir(source), [], 'process preparation must not snapshot or alter the project');
    await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'extension factories must not run before binding');
    await assert.rejects(readFile(join(agent, 'sessions')), { code: 'ENOENT' });
    const sessionIds = [];
    let plannerBinding;
    for (let index = 0; index < roles.length; index++) {
      const role = roles[index];
      const value = prepared[index];
      const session = join(directory, `sessions-${role}`);
      const graph = join(directory, `graph-${role}.json`);
      const sessionId = randomUUID();
      sessionIds.push(sessionId);
      await mkdir(session);
      await writeFile(graph, JSON.stringify({ originalGoal: `goal-${role}`, nodes: [], edges: [] }));
      const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'backend/target');
      const args = ['--mode', 'rpc', '--no-prompt-templates', '--no-themes', '--model', `prepared-test/${role}`,
        '--thinking', 'off', '--session-id', sessionId, '--session-dir', session];
      if (role === 'partition') args.push('--no-tools', '--no-extensions', '--no-skills', '--no-approve');
      else if (role === 'planner') args.push('--no-approve', '--exclude-tools', 'edit,write,ls,find,grep', '--no-context-files',
        '--extension', join(root, 'backend/resources/planner.ts'));
      else args.push('--approve');
      const binding = { type: 'grapher_bind', role, cwd: source, args, environment: {
        GRAPHER_MODE: role, GRAPHER_EXECUTION_KIND: 'source', GRAPHER_SOURCE_ALIAS: source,
        GRAPHER_WORKSPACE_ROOT: source, GRAPHER_ORIGINAL_ROOT: source, GRAPHER_GRAPH_PATH: graph,
        GRAPHER_ACTIVE_RUN_ID: `run-${role}`, GRAPHER_NODE_EXECUTION_ID: `execution-${role}`,
        GRAPHER_COMPILER_PATH: join(target, `debug/grapher${process.platform === 'win32' ? '.exe' : ''}`),
        PI_MODEL: null, PI_SESSION_ID: null,
      } };
      if (role === 'planner') plannerBinding = binding;
      const bindStarted = performance.now();
      const bindId = randomUUID();
      const stateId = randomUUID();
      // Exercise control/RPC handoff with both lines in the same pipe write.
      value.child.stdin.write(`${JSON.stringify({ ...binding, id: bindId })}\n${JSON.stringify({ type: 'get_state', id: stateId })}\n`);
      assert.equal((await value.wait(() => value.events.find(event => event.id === bindId))).success, true);
      const state = await value.wait(() => value.events.find(event => event.id === stateId));
      t.diagnostic(`${role} binding + session RPC readiness: ${(performance.now() - bindStarted).toFixed(0)}ms`);
      assert.equal(state.success, true);
      assert.equal(state.data.sessionId, sessionId);
      assert.equal(state.data.messageCount, 0, 'new task must not inherit another conversation');
      assert.equal(state.data.model.id, role);
      assert.ok(state.data.sessionFile.startsWith(session));
      const before = requests.length;
      // Batch two frames into one write: controlLine must not steal later bytes.
      const prompt = { id: randomUUID(), type: 'prompt', message: `SENTINEL-${role}` };
      value.child.stdin.write(`${JSON.stringify({ id: 'commands', type: 'get_commands' })}\n${JSON.stringify(prompt)}\n`);
      await value.wait(() => value.events.find(event => event.type === 'agent_settled'));
      assert.deepEqual(errors, []);
      assert.equal(requests.length, before + (role === 'planner' ? 2 : 1));
      const body = requests[before];
      const text = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n');
      assert.ok(body.messages.some(message => message.role === 'user' && text(message.content) === `SENTINEL-${role}`));
      const tools = body.tools?.map(tool => tool.function.name) ?? [];
      if (role === 'partition') assert.deepEqual(tools, []);
      else if (role === 'planner') {
        assert.ok(['node', 'edge', 'read', 'bash'].every(tool => tools.includes(tool)));
        assert.ok(['edit', 'write', 'ls', 'find', 'grep'].every(tool => !tools.includes(tool)));
        assert.equal(JSON.parse(await readFile(graph, 'utf8')).nodes[0].name, 'A');
      } else assert.ok(['read', 'write', 'edit', 'bash'].every(tool => tools.includes(tool)));
      // Match Rust's Planner/Node steer handoff window before closing RPC.
      if (role !== 'partition') await delay(500);
      const closed = once(value.child, 'close');
      value.child.stdin.end();
      assert.equal((await closed)[0], 0, value.diagnostics);
    }
    assert.equal(new Set(sessionIds).size, 3);
    const loaded = (await readFile(marker, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(loaded.map(value => value.role).sort(), ['node', 'planner']);
    assert.ok(loaded.every(value => value.run === `run-${value.role}` && value.execution === `execution-${value.role}` && value.graph === join(directory, `graph-${value.role}.json`)));
    assert.deepEqual(await readdir(other), [], 'outer Run graph path must never be touched');

    // A failed bind must not initialize resources, create a session or invoke a model.
    for (const change of [{ role: 'node' }, { cwd: other }, { environment: { NODE_OPTIONS: '--eval bad' } }]) {
      const value = host('planner', source, env);
      children.push(value);
      assert.equal((await value.request({ type: 'grapher_prepare', role: 'planner' })).success, true);
      const before = requests.length;
      const reply = await value.request({ ...plannerBinding, ...change });
      assert.equal(reply.success, false);
      assert.equal(requests.length, before);
    }
  } finally {
    await Promise.all(children.map(value => value.stop()));
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});
