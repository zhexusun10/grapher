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

const delay = ms => new Promise(completed => setTimeout(completed, ms));
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

test('prepared host loads the latest Pi overlay from the task binding', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-prepared-overlay-'));
  const source = join(directory, 'source');
  const agent = join(directory, 'agent');
  const upstream = join(directory, 'upstream-models.json');
  const sessions = join(directory, 'sessions');
  for (const path of [source, agent, sessions]) await mkdir(path);
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: {} }));
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, PI_CODING_AGENT_DIR: agent,
    GRAPHER_ISOLATED_PI_MODELS: '0', PI_OFFLINE: '1' };
  delete env.GRAPHER_UPSTREAM_PI_MODELS;
  const value = host('partition', source, env);
  try {
    assert.equal((await value.request({ type: 'grapher_prepare', role: 'partition' })).success, true);
    // This file and its binding only appear after the process is prepared.
    await writeFile(upstream, JSON.stringify({ providers: { 'prepared-overlay': {
      baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'latest' }],
    } } }));
    const reply = await value.request({ type: 'grapher_bind', role: 'partition', cwd: source,
      args: ['--mode', 'rpc', '--no-tools', '--no-extensions', '--no-skills', '--no-approve',
        '--model', 'prepared-overlay/latest', '--session-dir', sessions],
      environment: { GRAPHER_MODE: 'partition', GRAPHER_EXECUTION_KIND: 'source', GRAPHER_SOURCE_ALIAS: source,
        GRAPHER_WORKSPACE_ROOT: source, GRAPHER_ORIGINAL_ROOT: source, PI_CODING_AGENT_DIR: agent,
        GRAPHER_UPSTREAM_PI_MODELS: upstream } });
    assert.equal(reply.success, true, reply.error);
    const state = await value.request({ type: 'get_state' });
    assert.equal(state.success, true, value.diagnostics);
    assert.equal(state.data.model.id, 'latest');
    // Exercise the installed clear_queue binding through production Pi RPC,
    // without starting a model call. One-at-a-time mode must still recall all.
    for (const message of ['same queued text', 'same queued text']) {
      assert.equal((await value.request({ type: 'steer', message })).success, true);
    }
    assert.equal((await value.request({ type: 'follow_up', message: 'later' })).success, true);
    const cleared = await value.request({ type: 'clear_queue' });
    assert.equal(cleared.success, true, cleared.error);
    assert.deepEqual(cleared.data, { steering: ['same queued text', 'same queued text'], followUp: ['later'],
      messages: ['same queued text', 'same queued text', 'later'].map(text => ({ text, images: [] })) });
    assert.deepEqual((await value.request({ type: 'clear_queue' })).data, { steering: [], followUp: [], messages: [] });
    const closed = once(value.child, 'close');
    value.child.stdin.end();
    assert.equal((await closed)[0], 0, value.diagnostics);
  } finally {
    await value.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});

test('prepared queue identities survive async input rewriting without recalling read turns', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-queue-identity-'));
  const source = join(directory, 'source');
  const agent = join(directory, 'agent');
  const sessions = join(directory, 'sessions');
  const extension = join(directory, 'rewrite.ts');
  const settleGate = join(directory, 'release-settle');
  const inputGate = join(directory, 'release-input');
  const extensionInput = `extension injected\n\n<grapher-node-steer-id>${randomUUID()}</grapher-node-steer-id>`;
  let release, releaseNext;
  const hold = new Promise(resolve => { release = resolve; });
  const nextHold = new Promise(resolve => { releaseNext = resolve; });
  let requestBody, modelCalls = 0;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requestBody = JSON.parse(raw);
    await (++modelCalls === 1 ? hold : nextHold);
    if (response.destroyed) return;
    const chunk = (delta, finish_reason) => ({ id: 'queue-test', object: 'chat.completion.chunk', created: 1,
      model: 'test', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'finished' }, null))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  let value;
  try {
    for (const path of [source, agent, sessions]) await mkdir(path);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'queue-test': {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-only',
      models: [{ id: 'test', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await writeFile(extension, `import { existsSync } from 'node:fs';
    export default function(pi) {
      let settling = true;
      pi.on('agent_settled', async (_event, ctx) => {
        if (!settling) return;
        settling = false;
        ctx.ui.notify('settlement held', 'info');
        while (!existsSync(${JSON.stringify(settleGate)})) await new Promise(resolve => setTimeout(resolve, 10));
      });
      pi.registerCommand('queue-noop', { description: 'No-op', handler: async () => {} });
      pi.on('input', async (event, ctx) => {
        if (event.text.startsWith('deferred queued')) {
          ctx.ui.notify('deferred input:' + event.text, 'info');
          while (!existsSync(${JSON.stringify(inputGate)})) await new Promise(resolve => setTimeout(resolve, 10));
          return { action: 'transform', text: 'read first' };
        }
        if (event.text === 'first queued') {
          pi.sendUserMessage(${JSON.stringify(extensionInput)}, { deliverAs: 'steer' });
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (event.text.endsWith('queued')) return { action: 'transform', text: 'read first' };
        return { action: 'continue' };
      });
    }`);
    const env = { ...process.env, HOME: directory, USERPROFILE: directory, PI_CODING_AGENT_DIR: agent,
      GRAPHER_ISOLATED_PI_MODELS: '1', PI_OFFLINE: '1' };
    value = host('node', source, env);
    assert.equal((await value.request({ type: 'grapher_prepare', role: 'node' })).success, true);
    const bound = await value.request({ type: 'grapher_bind', role: 'node', cwd: source,
      args: ['--mode', 'rpc', '--no-tools', '--no-extensions', '--no-skills', '--no-approve', '--extension', extension,
        '--model', 'queue-test/test', '--session-dir', sessions],
      environment: { GRAPHER_MODE: 'node', GRAPHER_AGENT_KIND: 'serial', GRAPHER_EXECUTION_KIND: 'source', GRAPHER_SOURCE_ALIAS: source,
        GRAPHER_WORKSPACE_ROOT: source, GRAPHER_ORIGINAL_ROOT: source, PI_CODING_AGENT_DIR: agent } });
    assert.equal(bound.success, true, bound.error);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const marked = (text, id) => `${text}\n\n<grapher-node-steer-id>${id}</grapher-node-steer-id>`;
    assert.equal((await value.request({ type: 'prompt', message: marked('read first', ids[0]) })).success, true);
    await value.wait(() => requestBody, 'model began reading the first turn');
    const replies = await Promise.all([1, 2].map(index => value.request({ type: 'prompt',
      message: marked(index === 1 ? 'first queued' : 'second queued', ids[index]), streamingBehavior: 'steer' })));
    for (const reply of replies) assert.equal(reply.data.disposition, 'queued', reply.error);
    const noop = await value.request({ type: 'prompt', message: marked('/queue-noop', randomUUID()), streamingBehavior: 'steer' });
    assert.equal(noop.data.disposition, 'handled', 'identity must not break slash-command dispatch');
    const cleared = await value.request({ type: 'clear_queue' });
    assert.equal(cleared.success, true, cleared.error);
    const owned = cleared.data.messages.filter(message => message.requestId);
    assert.deepEqual(owned, [ids[2], ids[1]].map(requestId => ({ requestId, text: 'read first', images: [] })),
      'identity follows the async submission, not text equality or completion order');
    assert.deepEqual(cleared.data.messages.filter(message => !message.requestId), [{ text: extensionInput, images: [] }],
      'nested extension input must not inherit an ID or interpret literal marker-shaped content');
    assert.ok(!JSON.stringify(requestBody).includes('grapher-node-steer-id'), 'private identity never enters model context');
    assert.deepEqual((await value.request({ type: 'clear_queue' })).data.messages, []);
    release();
    await value.wait(() => value.events.find(event => event.type === 'extension_ui_request' && event.message === 'settlement held'));
    const deferredId = randomUUID();
    const literal = marked('deferred queued', randomUUID()); // literal user text, not this send's envelope
    const deferredReply = value.request({ type: 'prompt', message: marked(literal, deferredId), streamingBehavior: 'steer' })
      .catch(error => ({ success: false, error: String(error) }));
    await value.request({ type: 'get_state' }); // ordered after Pi has deferred the prompt
    await writeFile(settleGate, 'release');
    const observedInput = await value.wait(() => value.events.find(event => event.type === 'extension_ui_request' && event.message?.startsWith('deferred input:')));
    assert.equal(observedInput.message, `deferred input:${literal}`, 'deferred dispatch must not strip a second envelope from literal user text');
    assert.equal((await value.request({ type: 'prompt', message: 'next active turn' })).success, true);
    await value.wait(() => modelCalls === 2);
    await writeFile(inputGate, 'release');
    const deferredResult = await deferredReply;
    assert.equal(deferredResult.data?.disposition, 'queued', deferredResult.error);
    assert.deepEqual((await value.request({ type: 'clear_queue' })).data.messages,
      [{ requestId: deferredId, text: 'read first', images: [] }], 'deferred input keeps its original identity after another turn starts');
    releaseNext();
    await value.wait(() => value.events.filter(event => event.type === 'agent_settled').length === 2, 'both read turns completed');
    const users = value.events.filter(event => event.type === 'message_start' && event.message?.role === 'user');
    assert.deepEqual(users.map(event => event.message.content[0].text), ['read first', 'next active turn'],
      'read turns stay; recalled turns never enter the transcript');
  } finally {
    release();
    releaseNext();
    await value?.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});

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
      const toolResults = value.messages.filter(message => message.role === 'tool');
      const editGraph = value.model === 'planner' && toolResults.length < 2;
      const nodes = toolResults.length === 0 ? [{ id: 'published', delete: true }] : [{ id: 'A', task: 'Return completed' }];
      const delta = editGraph ? { role: 'assistant', tool_calls: [{ index: 0, id: `edit-node-${toolResults.length}`, type: 'function',
        function: { name: 'node', arguments: JSON.stringify({ nodes }) } }] }
        : { role: 'assistant', content: `completed-${value.model}` };
      const chunk = (delta, finish_reason) => ({ id: 'prepared-test', object: 'chat.completion.chunk', created: 1,
        model: value.model, choices: [{ index: 0, delta, finish_reason }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, editGraph ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(error); response.writeHead(500); response.end(String(error)); }
  });
  try {
    const source = join(directory, 'source spaces # 中文');
    const other = join(directory, 'other');
    const agent = join(directory, 'agent');
    const global = join(directory, 'global');
    const marker = join(directory, 'loaded.jsonl');
    const bashSources = join(directory, 'bash-sources.jsonl');
    for (const path of [source, other, agent, join(global, 'extensions')]) await mkdir(path, { recursive: true });
    await writeFile(join(global, 'extensions/probe.ts'), `import { appendFileSync } from 'node:fs';\nexport default function(pi) { appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ role: process.env.GRAPHER_MODE, agentKind: process.env.GRAPHER_AGENT_KIND, run: process.env.GRAPHER_ACTIVE_RUN_ID, execution: process.env.GRAPHER_NODE_EXECUTION_ID, nodeName: process.env.GRAPHER_NODE_NAME, graph: process.env.GRAPHER_GRAPH_PATH, continuation: process.env.GRAPHER_CONTINUE_INTERRUPTED, feedback: process.env.GRAPHER_FEEDBACK_SOURCE, unremovableNodes: process.env.GRAPHER_UNREMOVABLE_NODES }) + '\\n'); pi.on('session_start', () => appendFileSync(${JSON.stringify(bashSources)}, JSON.stringify({ role: process.env.GRAPHER_MODE, agentKind: process.env.GRAPHER_AGENT_KIND, bash: pi.getAllTools().find(tool => tool.name === 'bash')?.sourceInfo }) + '\\n')); }`);
    await new Promise(completed => server.listen(0, '127.0.0.1', completed));
    const model = id => ({ id, reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'prepared-test': {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'loopback-only',
      models: ['partition', 'planner', 'node'].map(model),
    } } }));
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent, GRAPHER_GLOBAL_PI_AGENT_DIR: global,
      GRAPHER_ISOLATED_PI_MODELS: '1', PI_OFFLINE: '1', GRAPHER_ACTIVE_RUN_ID: 'outer-must-not-leak',
      GRAPHER_AGENT_KIND: 'outer-agent-kind-must-not-leak',
      GRAPHER_GRAPH_PATH: join(other, 'outer-graph.json'), GRAPHER_NODE_NAME: 'outer-node-must-not-leak',
      GRAPHER_CONTINUE_INTERRUPTED: 'outer-continuation-must-not-leak', GRAPHER_FEEDBACK_SOURCE: 'outer-feedback-must-not-leak',
      GRAPHER_FEEDBACK_ENABLED: 'true',
      GRAPHER_UNREMOVABLE_NODES: JSON.stringify(['outer-node-must-not-leak']) };
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
    let nodeBinding;
    for (let index = 0; index < roles.length; index++) {
      const role = roles[index];
      const value = prepared[index];
      const session = join(directory, `sessions-${role}`);
      const graph = join(directory, `graph-${role}.json`);
      const sessionId = randomUUID();
      sessionIds.push(sessionId);
      await mkdir(session);
      await writeFile(graph, JSON.stringify({ originalGoal: `goal-${role}`,
        nodes: role === 'planner' ? [{ name: 'published', task: 'Already published' }] : [], edges: [] }));
      const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'backend/target');
      const args = ['--mode', 'rpc', '--no-prompt-templates', '--no-themes', '--model', `prepared-test/${role}`,
        '--thinking', 'off', '--session-id', sessionId, '--session-dir', session];
      if (role === 'partition') args.push('--no-tools', '--no-extensions', '--no-skills', '--no-approve');
      else if (role === 'planner') args.push('--no-approve', '--exclude-tools', 'ls,find,grep', '--no-context-files',
        '--extension', join(root, 'backend/resources/planner.ts'));
      else args.push('--approve');
      const binding = { type: 'grapher_bind', role, cwd: source, args, environment: {
        GRAPHER_MODE: role, GRAPHER_EXECUTION_KIND: 'source', GRAPHER_SOURCE_ALIAS: source,
        ...(role === 'node' ? { GRAPHER_AGENT_KIND: 'serial' } : { GRAPHER_AGENT_KIND: null }),
        GRAPHER_WORKSPACE_ROOT: source, GRAPHER_ORIGINAL_ROOT: source, GRAPHER_GRAPH_PATH: graph,
        GRAPHER_ACTIVE_RUN_ID: `run-${role}`, GRAPHER_NODE_EXECUTION_ID: `execution-${role}`,
        ...(role === 'planner' ? { GRAPHER_UNREMOVABLE_NODES: JSON.stringify(['published']), GRAPHER_PLANNER_WRITE_TOOLS: 'true' } : {}),
        GRAPHER_FEEDBACK_SOURCE: role === 'node' ? 'true' : null,
        GRAPHER_FEEDBACK_ENABLED: role === 'planner' ? 'false' : null,
        ...(role === 'node' ? { GRAPHER_NODE_NAME: null, GRAPHER_CONTINUE_INTERRUPTED: 'false' } : {}),
        GRAPHER_COMPILER_PATH: join(target, `debug/grapher${process.platform === 'win32' ? '.exe' : ''}`),
        GRAPHER_TRUSTED_GIT: process.env.GRAPHER_TRUSTED_GIT ?? 'git',
        PI_MODEL: null, PI_SESSION_ID: null, GIT_CEILING_DIRECTORIES: null, GIT_CONFIG_PARAMETERS: null,
      } };
      if (role === 'planner') plannerBinding = binding;
      if (role === 'node') nodeBinding = binding;
      const bindStarted = performance.now();
      const bindId = randomUUID();
      const stateId = randomUUID();
      // Exercise control/RPC handoff with both lines in the same pipe write.
      value.child.stdin.write(`${JSON.stringify({ ...binding, id: bindId })}\n${JSON.stringify({ type: 'get_state', id: stateId })}\n`);
      const bound = await value.wait(() => value.events.find(event => event.id === bindId));
      assert.equal(bound.success, true, bound.error);
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
      assert.equal(requests.length, before + (role === 'planner' ? 3 : 1));
      const body = requests[before];
      const text = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n');
      assert.ok(body.messages.some(message => message.role === 'user' && text(message.content) === `SENTINEL-${role}`));
      const system = body.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => text(message.content)).join('\n');
      assert.doesNotMatch(system, /If \.venv is present|copied activate\/pip wrappers|Filesystem inheritance does not rewrite paths inside programs/);
      if (role === 'node') {
        assert.doesNotMatch(system, /End your response with exactly one standalone final line:[\s\S]*<ACCEPT>[\s\S]*<FEEDBACK>/,
          'a source-bound Node Agent is Serial, not a Graph feedback target');
        assert.ok(body.messages.filter(message => message.role === 'user').every(message => !text(message.content).includes('<ACCEPT>')));
      } else assert.doesNotMatch(system, /End your response with exactly one standalone final line/);
      const tools = body.tools?.map(tool => tool.function.name) ?? [];
      if (role === 'partition') assert.deepEqual(tools, []);
      else if (role === 'planner') {
        assert.ok(['node', 'edge', 'read', 'bash', 'write', 'edit'].every(tool => tools.includes(tool)));
        assert.ok(['ls', 'find', 'grep'].every(tool => !tools.includes(tool)));
        const edgeDescription = body.tools.find(tool => tool.function.name === 'edge').function.description;
        assert.doesNotMatch(edgeDescription, /feedback|ignored|non-Git|drain|fork/i);
        const edgeSchema = body.tools.find(tool => tool.function.name === 'edge').function.parameters;
        assert.deepEqual(Object.keys(edgeSchema.properties.edges.items.properties), ['from', 'to', 'delete']);
        const rejected = JSON.parse(requests[before + 1].messages.find(message => message.role === 'tool').content);
        assert.equal(rejected.applied, false, 'the bound published-node constraint must reach the Planner compiler');
        assert.deepEqual(rejected.topology, { "from: [to]": { published: [] } });
        assert.match(rejected.diagnostics[0], /Cannot remove node 'published'.*already published/);
        const results = requests[before + 2].messages.filter(message => message.role === 'tool');
        const accepted = JSON.parse(results[1].content);
        assert.equal(accepted.applied, true, 'a rejected deletion must not prevent further valid edits');
        assert.deepEqual(accepted.topology, {
          rootNodes: ["A", "published"], "from: [to]": { published: [], A: [] },
        });
        assert.deepEqual(accepted.topology.rootNodes, ["A", "published"], "both nodes inherit nothing and are listed as roots");
        assert.deepEqual(JSON.parse(await readFile(graph, 'utf8')).nodes.map(node => node.name), ['published', 'A']);
      } else {
        assert.ok(['read', 'write', 'edit', 'bash'].every(tool => tools.includes(tool)));
        assert.ok(['ls', 'find', 'grep'].every(tool => !tools.includes(tool)), 'node tool surface excludes ls/find/grep for every project');
      }
      // Match Rust's Planner/Node steer handoff window before closing RPC.
      if (role !== 'partition') await delay(500);
      const closed = once(value.child, 'close');
      value.child.stdin.end();
      assert.equal((await closed)[0], 0, value.diagnostics);
    }
    assert.equal(new Set(sessionIds).size, 3);
    const loaded = (await readFile(marker, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(loaded.map(value => value.role).sort(), ['node', 'planner']);
    assert.equal(loaded.find(value => value.role === 'node').nodeName, undefined, 'node extensions must not inherit an outer node identity');
    assert.equal(loaded.find(value => value.role === 'node').agentKind, 'serial');
    assert.equal(loaded.find(value => value.role === 'planner').agentKind, undefined, 'the prepared Planner must not inherit a node agent kind');
    assert.equal(loaded.find(value => value.role === 'node').continuation, 'false');
    assert.equal(loaded.find(value => value.role === 'node').feedback, 'true');
    assert.equal(loaded.find(value => value.role === 'planner').feedback, undefined, 'prepared roles must not inherit an outer feedback flag');
    assert.equal(loaded.find(value => value.role === 'planner').nodeName, undefined, 'prepared roles must not inherit an outer node identity');
    assert.equal(loaded.find(value => value.role === 'planner').continuation, undefined, 'prepared roles must not inherit an outer continuation flag');
    assert.equal(loaded.find(value => value.role === 'planner').unremovableNodes, JSON.stringify(['published']));
    assert.equal(loaded.find(value => value.role === 'node').unremovableNodes, undefined, 'prepared roles must not inherit another Run\'s published-node constraints');
    assert.ok(loaded.every(value => value.run === `run-${value.role}` && value.execution === `execution-${value.role}` && value.graph === join(directory, `graph-${value.role}.json`)));
    const bashToolSources = (await readFile(bashSources, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(bashToolSources.map(value => value.role).sort(), ['node', 'planner']);
    assert.equal(bashToolSources.find(value => value.role === 'node' && value.agentKind === 'serial').bash.path, 'builtin:bash',
      'a bound Serial Agent must retain Pi\'s native Bash tool');
    assert.match(bashToolSources.find(value => value.role === 'planner').bash.path, /grapher-workspace-policy/,
      'Planner keeps the Grapher Bash adapter');

    // A source-direct Graph Node Agent has the same Pi model role and cwd as
    // Serial, but its explicit agent identity must still select Grapher Bash.
    const sourceNode = host('node', source, env);
    children.push(sourceNode);
    assert.equal((await sourceNode.request({ type: 'grapher_prepare', role: 'node' })).success, true);
    const sourceNodeSession = join(directory, 'sessions-source-node');
    await mkdir(sourceNodeSession);
    const sourceNodeId = randomUUID();
    const sourceNodeArgs = [...nodeBinding.args];
    sourceNodeArgs[sourceNodeArgs.indexOf('--session-id') + 1] = sourceNodeId;
    sourceNodeArgs[sourceNodeArgs.indexOf('--session-dir') + 1] = sourceNodeSession;
    const sourceNodeBinding = { ...nodeBinding, args: sourceNodeArgs, environment: {
      ...nodeBinding.environment,
      GRAPHER_AGENT_KIND: 'node',
      GRAPHER_NODE_EXECUTION_ID: 'source-direct-graph-node',
      GRAPHER_FEEDBACK_SOURCE: null,
    } };
    const sourceNodeReply = await sourceNode.request(sourceNodeBinding);
    assert.equal(sourceNodeReply.success, true, sourceNodeReply.error);
    const sourceNodeState = await sourceNode.request({ type: 'get_state' });
    assert.equal(sourceNodeState.success, true, sourceNode.diagnostics);
    sourceNode.child.stdin.write(`${JSON.stringify({ id: 'source-node-prompt', type: 'prompt', message: 'SENTINEL-source-direct-node' })}\n`);
    await sourceNode.wait(() => sourceNode.events.find(event => event.type === 'agent_settled'));
    const boundSources = (await readFile(bashSources, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    const sourceNodeTool = boundSources.find(value => value.role === 'node' && value.agentKind === 'node')?.bash;
    assert.ok(sourceNodeTool?.path.includes('grapher-workspace-policy'), 'source-direct Graph Node Agent uses Grapher Bash');
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
    // Start from a valid node binding: an incomplete binding would be rejected
    // anyway and would not prove that an injected node name is forbidden.
    const namedNode = host('node', source, env);
    children.push(namedNode);
    assert.equal((await namedNode.request({ type: 'grapher_prepare', role: 'node' })).success, true);
    const before = requests.length;
    const rejectedName = await namedNode.request({
      ...nodeBinding,
      environment: { ...nodeBinding.environment, GRAPHER_NODE_NAME: 'forbidden' },
    });
    assert.equal(rejectedName.success, false);
    assert.match(rejectedName.error, /Unsupported task environment: GRAPHER_NODE_NAME/);
    assert.equal(requests.length, before);
  } finally {
    await Promise.all(children.map(value => value.stop()));
    server.closeAllConnections();
    await new Promise(completed => server.close(completed));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});
