import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { root, lock } from './pi-baseline.mjs';

// Exercise the same CLI and IPC entrypoints the Rust host launches, without
// loading user credentials or contacting a provider. This catches SDK imports,
// CLI flags and DTO drift that a types-only compatibility probe cannot see.
const resolverUrl = pathToFileURL(join(root, 'pi/packages/coding-agent/src/experimental/source-resolver.ts')).href;

function settleRpc(child, role) {
  // Match Rust's Planner/Node/Merger handoff window. Immediate EOF can race extension
  // and source-loader cleanup on Windows/Node 24 (UV_HANDLE_CLOSING assertion).
  const timer = setTimeout(() => child.stdin.end(), ['planner', 'node', 'merger'].includes(role) ? 500 : 0);
  child.once('close', () => clearTimeout(timer));
}

test('production Pi CLI reports the pinned version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-pi-cli-'));
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'engine/entrypoint.mjs'), '--version'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, PI_CODING_AGENT_DIR: dir },
    });
    assert.equal(stdout.trim(), lock.packageVersion);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Provider/Auth private readiness loads code only and preserves authentication bytes', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-auth-prepared-'));
  const auth = join(directory, 'auth.json');
  const original = '{ "sentinel": { "type": "api_key", "key": "isolated-not-a-real-key" } }\n';
  writeFileSync(auth, original);
  const child = spawn(process.execPath, ['--import', resolverUrl, join(root, 'engine/provider-host.ts')], {
    cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: directory, GRAPHER_ISOLATED_PI_MODELS: '1', PI_OFFLINE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  const lines = createInterface({ input: child.stdout });
  let diagnostics = '';
  child.stderr.on('data', bytes => { diagnostics += bytes; });
  let timer;
  try {
    const reply = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Provider/Auth readiness timed out: ${diagnostics}`)), 20000);
      lines.once('line', line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
    });
    child.stdin.write(`${JSON.stringify({ version: 1, operation: 'grapher_prepare', id: 'isolated-ready' })}\n`);
    const ready = await Promise.race([reply, exit.then(code => { throw new Error(`Provider/Auth exited before readiness: ${code}: ${diagnostics}`); })]);
    assert.deepEqual(ready, { version: 1, id: 'isolated-ready', result: { ready: true } });
    assert.equal(readFileSync(auth, 'utf8'), original);
    child.stdin.end();
    assert.equal(await exit, 0, diagnostics);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
    lines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Settings IPC discovers extensions and persists removal/restoration without executing user code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-pi-extensions-ipc-'));
  try {
    const global = join(dir, 'global');
    mkdirSync(join(global, 'extensions'), { recursive: true });
    const file = join(global, 'extensions/probe.ts');
    const code = 'throw new Error("must not execute at discovery");';
    writeFileSync(file, code);
    const call = fields => JSON.parse(execFileSync(process.execPath, ['--import', resolverUrl, join(root, 'engine/extensions-host.ts')], {
      encoding: 'utf8', timeout: 30000, input: JSON.stringify({ version: 1, ...fields }),
      env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, 'own'), GRAPHER_GLOBAL_PI_AGENT_DIR: global, GRAPHER_ISOLATED_PI_MODELS: '1' },
    })).result;
    const catalog = call({ operation: 'catalog' });
    const continuity = catalog.extensions.find(extension => extension.id === 'npm:pi-continuity');
    assert.ok(continuity?.bundled);
    assert.equal(continuity.required, false);
    assert.equal(continuity.enabled, true);
    assert.equal(call({ operation: 'set_enabled', id: continuity.id, enabled: false }).extensions.find(value => value.id === continuity.id).enabled, false);
    assert.equal(call({ operation: 'catalog' }).extensions.find(value => value.id === continuity.id).enabled, false);
    assert.equal(call({ operation: 'set_enabled', id: continuity.id, enabled: true }).extensions.find(value => value.id === continuity.id).enabled, true);
    const webSearch = catalog.extensions.find(extension => extension.id === 'npm:pi-better-web-search');
    assert.ok(webSearch?.bundled);
    assert.equal(webSearch.required, false);
    assert.equal(webSearch.enabled, false);
    assert.equal(call({ operation: 'set_enabled', id: webSearch.id, enabled: true }).extensions.find(value => value.id === webSearch.id).enabled, true);
    assert.equal(call({ operation: 'catalog' }).extensions.find(value => value.id === webSearch.id).enabled, true);
    assert.equal(call({ operation: 'set_enabled', id: webSearch.id, enabled: false }).extensions.find(value => value.id === webSearch.id).enabled, false);
    const extension = catalog.extensions.find(extension => !extension.bundled);
    assert.ok(extension);
    assert.equal(call({ operation: 'set_enabled', id: extension.id, enabled: false }).extensions.find(value => value.id === extension.id).enabled, false);
    assert.equal(call({ operation: 'catalog' }).extensions.find(value => value.id === extension.id).enabled, false);
    assert.equal(call({ operation: 'set_enabled', id: extension.id, enabled: true }).extensions.find(value => value.id === extension.id).enabled, true);
    assert.equal(readFileSync(file, 'utf8'), code);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pi-trim transforms actual provider requests for every role without removing tools or task prompts', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-trim-provider-'));
  const agent = join(directory, 'agent');
  const global = join(directory, 'global');
  for (const path of [agent, global]) mkdirSync(path);
  const requests = [];
  const serverErrors = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const chunk = (delta, finish_reason) => ({ id: 'audit', object: 'chat.completion.chunk', created: 1, model: 'local',
        choices: [{ index: 0, delta, finish_reason }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'audit complete' }, null))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      serverErrors.push(error);
      response.writeHead(500);
      response.end('Audit server failed');
    }
  });
  const identity = 'You are a coding assistant running inside pi, a coding agent harness.';
  const opaqueUser = `${identity}\n<docs>\nPi documentation (read only in user content)\n</docs>`;
  const text = content => typeof content === 'string' ? content : (content ?? []).map(block => block.text ?? '').join('\n');
  const run = (role, args, user) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'engine/entrypoint.mjs'), '--mode', 'rpc', '--no-session',
      '--no-context-files', '--no-prompt-templates', '--no-themes', '--model', 'pi-trim-audit/local', '--thinking', 'off', ...args], {
      cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_CODING_AGENT_DIR: agent, GRAPHER_GLOBAL_PI_AGENT_DIR: global,
        GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_MODE: role, GRAPHER_EXECUTION_KIND: 'source', PI_OFFLINE: '1' },
    });
    let stderr = '';
    const events = [];
    child.stderr.on('data', value => { stderr += value.toString(); });
    child.stdin.on('error', () => {}); // An early exit is reported with its stderr below.
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === 'agent_settled') settleRpc(child, role);
      } catch {}
    });
    const timeout = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else child.kill('SIGTERM');
      reject(new Error(`${role} timed out: ${stderr}`));
    }, 20000);
    child.once('error', error => { clearTimeout(timeout); lines.close(); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      lines.close();
      if (code !== 0) reject(new Error(`${role} exited ${code}: ${stderr}`));
      else resolve(events);
    });
    child.stdin.write(`${JSON.stringify({ id: role, type: 'prompt', message: user })}\n`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'pi-trim-audit': {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-audit-only',
      models: [{ id: 'local', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    for (const role of ['partition', 'planner', 'node', 'merger']) {
      const args = role === 'node' ? ['--approve'] : role === 'planner' ? ['--exclude-tools', 'ls,find,grep']
        : ['--no-extensions', '--no-skills'];
      const custom = `<role_policy>\n${role} instructions remain intact\n<docs>\nProject documentation\n</docs>\n</role_policy>`;
      if (role === 'partition' || role === 'planner') {
        const promptFile = join(directory, `${role}-prompt.md`);
        writeFileSync(promptFile, custom);
        args.push('--system-prompt', promptFile);
      }
      if (role === 'partition') args.push('--no-tools');
      const addendum = 'Resolve the current Git merge conflicts. Preserve valid changes. Do not modify unrelated files.';
      if (role === 'merger') {
        const file = join(directory, 'merger-addendum.md');
        writeFileSync(file, addendum);
        args.push('--append-system-prompt', file);
      }
      const before = requests.length;
      const user = `TRIM_AUDIT[${role}]\n${opaqueUser}`;
      const events = await run(role, args, user);
      assert.deepEqual(serverErrors, []);
      assert.equal(requests.length, before + 1, `${role}: exactly one local model request`);
      const body = requests[before];
      const system = body.messages.filter(message => message.role === 'system').map(message => text(message.content)).join('\n');
      assert.ok(body.messages.some(message => message.role === 'user' && text(message.content) === user), `${role}: preserve user text`);
      if (role === 'partition' || role === 'planner') assert.ok(system.includes(custom), `${role}: preserve role policy and nested docs`);
      else {
        assert.ok(system.includes('You are a coding assistant.'), `${role}: trim Pi identity; provider roles=${body.messages.map(message => message.role)}\n${system}`);
        assert.ok(!system.includes(identity), `${role}: no Pi identity in provider system prompt`);
        assert.ok(!system.includes('Pi documentation (read only'), `${role}: no Pi docs in provider system prompt`);
        assert.ok(system.includes('<tools>') && system.includes('<rules>'), `${role}: retain tool and rule sections`);
      }
      if (role === 'merger') assert.ok(system.includes(addendum), 'preserve conflict-repair instructions');
      const tools = body.tools?.map(tool => tool.function.name) ?? [];
      if (role === 'partition') assert.deepEqual(tools, []);
      else assert.ok(tools.includes('read') && tools.includes('bash'), `${role}: retain provider tool schemas`);
      assert.ok(events.some(event => event.type === 'message_end' && event.message?.role === 'assistant' &&
        event.message.content.some(part => part.type === 'text' && part.text === 'audit complete')), `${role}: request completes successfully`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bundled continuity recovers capped provider turns only while selected for allowed roles', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-continuity-provider-'));
  const agent = join(directory, 'agent');
  const global = join(directory, 'global');
  for (const path of [agent, global]) mkdirSync(path);
  const requests = [];
  const serverErrors = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const first = requests.length === 1;
      const chunk = (delta, finish_reason) => ({ id: 'continuity-audit', object: 'chat.completion.chunk', created: 1, model: 'local',
        choices: [{ index: 0, delta, finish_reason }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: first ? 'partial progress' : 'recovered final' }, null))}\n\ndata: ${JSON.stringify(chunk({}, first ? 'length' : 'stop'))}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      serverErrors.push(error);
      response.writeHead(500);
      response.end('Audit server failed');
    }
  });
  const run = (role, noExtensions) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'engine/entrypoint.mjs'), '--mode', 'rpc', '--no-session',
      '--no-context-files', '--no-skills', '--no-tools', '--model', 'continuity-audit/local', '--thinking', 'off',
      ...(noExtensions ? ['--no-extensions'] : [])], {
      cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_CODING_AGENT_DIR: agent, GRAPHER_GLOBAL_PI_AGENT_DIR: global,
        GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_MODE: role, GRAPHER_EXECUTION_KIND: 'source', PI_OFFLINE: '1' },
    });
    let stderr = '';
    const events = [];
    child.stderr.on('data', value => { stderr += value.toString(); });
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        events.push(event);
        // agent_end can precede extension recovery; wait for the public settled boundary.
        if (event.type === 'agent_settled') settleRpc(child, role);
      } catch {}
    });
    const timeout = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else child.kill('SIGTERM');
      reject(new Error(`${role} continuity audit timed out: ${stderr}`));
    }, 20000);
    child.once('error', error => { clearTimeout(timeout); lines.close(); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      lines.close();
      if (code !== 0) reject(new Error(`${role} exited ${code}: ${stderr}`));
      else resolve(events);
    });
    child.stdin.write(`${JSON.stringify({ id: role, type: 'prompt', message: 'Complete CONTINUITY_AUDIT' })}\n`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'continuity-audit': {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-audit-only',
      models: [{ id: 'local', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    for (const [role, enabled, noExtensions] of [
      ['planner', true, false], ['node', true, false], ['planner', false, false], ['node', false, false],
      ['node', true, false], ['node', true, true], ['partition', true, true], ['merger', true, true],
      ['merger', true, false], ['merger', false, false],
    ]) {
      writeFileSync(join(agent, 'extensions.json'), JSON.stringify({ overrides: { 'npm:pi-continuity': enabled } }));
      requests.length = 0;
      const events = await run(role, noExtensions);
      assert.deepEqual(serverErrors, []);
      const recover = enabled && !noExtensions && (role === 'planner' || role === 'node' || role === 'merger');
      assert.equal(requests.length, recover ? 2 : 1, `${role}: selected=${enabled}, noExtensions=${noExtensions}`);
      const assistants = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant');
      assert.equal(assistants.at(-1)?.message.stopReason, recover ? 'stop' : 'length');
      assert.ok(events.some(event => event.type === 'agent_settled'));
      if (recover) {
        const recovery = JSON.stringify(requests[1].messages);
        assert.ok(recovery.includes('Complete CONTINUITY_AUDIT'), 'recovery request keeps the original instruction');
        assert.ok(!recovery.includes('partial progress'), 'interrupted partial text is dropped instead of replayed');
        assert.ok(!requests[1].messages.some(message => message.role === 'assistant'), 'interrupted assistant protocol is omitted');
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('manual continuation preserves tool history and uses Pi native missing-result normalization', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-continuation-context-'));
  const agent = join(directory, 'agent'), global = join(directory, 'global');
  for (const path of [agent, global]) mkdirSync(path);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const chunk = (delta, finish_reason) => ({ id: 'context-audit', object: 'chat.completion.chunk', created: 1, model: 'local',
      choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'done' }, null))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'context-audit': {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-audit-only',
      models: [{ id: 'local', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    for (const [index, role, complete, continuity, stopReason = 'toolUse'] of [[1, 'node', false, true], [2, 'node', true, true],
      [3, 'planner', false, true], [4, 'planner', true, true], [5, 'node', false, false], [6, 'planner', false, false],
      [7, 'node', false, false, 'error'], [8, 'planner', false, false, 'length']]) {
      writeFileSync(join(agent, 'extensions.json'), JSON.stringify({ overrides: { 'npm:pi-continuity': continuity } }));
      const sessions = join(directory, `sessions-${index}`); mkdirSync(sessions);
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const now = new Date().toISOString();
      const entry = (id, parentId, message) => ({ type: 'message', id, parentId, timestamp: now, message });
      const call = (id, name) => ({ type: 'toolCall', id, name, arguments: { command: 'echo test' } });
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const entries = [
        { type: 'session', version: 3, id, timestamp: now, cwd: directory },
        entry('user', null, { role: 'user', content: [{ type: 'text', text: 'ORIGINAL_TASK_ONLY' }], timestamp: 1 }),
        entry('assistant', 'user', { role: 'assistant', content: [call('call_alpha', 'bash'), call('call_beta', 'bash')],
          api: 'openai-completions', provider: 'context-audit', model: 'local', usage, stopReason, timestamp: 2 }),
        entry('result-a', 'assistant', { role: 'toolResult', toolCallId: 'call_alpha', toolName: 'bash',
          content: [{ type: 'text', text: 'SAVED_RESULT_ALPHA' }], isError: false, timestamp: 3 }),
      ];
      if (complete) entries.push(entry('result-b', 'result-a', { role: 'toolResult', toolCallId: 'call_beta', toolName: 'bash',
        content: [{ type: 'text', text: 'SAVED_RESULT_BETA' }], isError: false, timestamp: 4 }));
      const sessionFile = join(sessions, `audit_${id}.jsonl`);
      writeFileSync(sessionFile, entries.map(item => JSON.stringify(item)).join('\n') + '\n');
      const events = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(root, 'engine/entrypoint.mjs'), '--mode', 'rpc', '--no-context-files',
          '--no-skills', '--no-tools', '--model', 'context-audit/local', '--thinking', 'off', '--session-id', id, '--session-dir', sessions], {
          cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_CODING_AGENT_DIR: agent,
            GRAPHER_GLOBAL_PI_AGENT_DIR: global, GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_MODE: role,
            GRAPHER_EXECUTION_KIND: 'source', GRAPHER_CONTINUE_INTERRUPTED: 'true', PI_OFFLINE: '1' },
        });
        let stderr = ''; const seen = [];
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.stdin.on('error', () => {});
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => { try { const event = JSON.parse(line); seen.push(event); if (event.type === 'agent_settled') settleRpc(child, role); } catch {} });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`${role} continuation timed out: ${stderr}`)); }, 20000);
        child.once('error', error => { clearTimeout(timer); lines.close(); reject(error); });
        child.once('close', code => { clearTimeout(timer); lines.close(); code === 0 ? resolve(seen) : reject(new Error(`${role} exited ${code}: ${stderr}`)); });
        child.stdin.write(`${JSON.stringify({ id: 'continue', type: 'prompt', message: '__grapher_continue_interrupted__' })}\n`);
      });
      assert.ok(events.some(event => event.type === 'message_end' && event.message?.role === 'assistant' && event.message.stopReason === 'stop'));
      assert.equal(requests.length, index);
      const messages = requests.at(-1).messages;
      const serialized = JSON.stringify(messages);
      assert.equal(messages.filter(message => message.role === 'user').length, 1);
      assert.ok(serialized.includes('ORIGINAL_TASK_ONLY'));
      assert.ok(!serialized.includes('__grapher_continue_interrupted__'));
      const retainedBatch = stopReason === 'toolUse';
      assert.equal(serialized.includes('No result provided'), retainedBatch && !complete,
        'only Pi supplies its native missing-result text');
      assert.ok(!serialized.includes('side effects are unknown'), 'Grapher adds no custom warning');
      assert.equal(serialized.includes('SAVED_RESULT_ALPHA'), retainedBatch, 'saved sibling results are retained');
      assert.equal(serialized.includes('SAVED_RESULT_BETA'), complete);
      assert.ok(readFileSync(sessionFile, 'utf8').includes('SAVED_RESULT_ALPHA'), 'raw session history stays intact');
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a resumed Pi session honors a replacement model while retaining its conversation', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-model-retry-'));
  const agent = join(directory, 'agent');
  const global = join(directory, 'global');
  const sessions = join(directory, 'sessions');
  for (const path of [agent, global, sessions]) mkdirSync(path);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const chunk = (delta, finish_reason) => ({ id: 'model-retry', object: 'chat.completion.chunk', created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'recorded answer' }, null))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  const run = (model, message) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'engine/entrypoint.mjs'), '--mode', 'rpc', '--no-context-files',
      '--no-skills', '--no-tools', '--model', model, '--thinking', 'off', '--session-id',
      '6816076a-c027-4f14-aa58-17f22416754c', '--session-dir', sessions], {
      cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_CODING_AGENT_DIR: agent,
        GRAPHER_GLOBAL_PI_AGENT_DIR: global, GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_MODE: 'node',
        GRAPHER_EXECUTION_KIND: 'source', PI_OFFLINE: '1' },
    });
    let stderr = '';
    const events = [];
    child.stderr.on('data', value => { stderr += value.toString(); });
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === 'agent_settled') settleRpc(child, 'node');
      } catch {}
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Pi model retry timed out: ${stderr}`)); }, 20000);
    child.once('error', error => { clearTimeout(timer); lines.close(); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); lines.close();
      if (code !== 0) reject(new Error(`Pi exited ${code}: ${stderr}`));
      else resolve(events);
    });
    child.stdin.write(`${JSON.stringify({ id: 'turn', type: 'prompt', message })}\n`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const provider = id => ({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions',
      apiKey: 'local-audit-only', models: [{ id, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: {
      'original-audit': provider('old'), 'replacement-audit': provider('new'),
    } }));
    await run('original-audit/old', 'Original task');
    await run('replacement-audit/new', 'Continue task');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].model, 'old');
    assert.equal(requests[1].model, 'new');
    assert.ok(JSON.stringify(requests[1].messages).includes('Original task'), 'the resumed session keeps its history');
    assert.ok(JSON.stringify(requests[1].messages).includes('Continue task'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Provider refresh and Pi CLI use the same refreshed local model overlay', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-overlay-contract-'));
  const agent = join(directory, 'agent');
  const source = join(directory, 'upstream-models.json');
  mkdirSync(agent);
  const model = id => ({ id, contextWindow: 32000, maxTokens: 4096 });
  const provider = models => ({ baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture-key', models });
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'overlay-audit': provider([model('dedicated')]) } }));
  const writeSource = id => writeFileSync(source, `// Pi supports JSONC\n${JSON.stringify({ providers: { 'overlay-audit': provider([model(id)]) } })}`);
  writeSource('first');
  // Managed execution replaces HOME; the explicit host path must still win.
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, PI_CODING_AGENT_DIR: agent, GRAPHER_UPSTREAM_PI_MODELS: source,
    GRAPHER_ISOLATED_PI_MODELS: '0', PI_OFFLINE: '1' };
  const child = spawn(process.execPath, ['--import', resolverUrl, join(root, 'engine/provider-host.ts')], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let diagnostics = '';
  child.stderr.on('data', bytes => { diagnostics += bytes; });
  async function catalog() {
    child.stdin.write(`${JSON.stringify({ version: 1, operation: 'catalog', refresh: true })}\n`);
    const next = await iterator.next();
    assert.equal(next.done, false, diagnostics);
    const reply = JSON.parse(next.value);
    assert.ok(reply.result, JSON.stringify(reply));
    return reply.result;
  }
  const ids = catalog => catalog.models.filter(m => m.provider === 'overlay-audit').map(m => m.id).sort();
  try {
    assert.deepEqual(ids(await catalog()), ['dedicated', 'first']);
    writeSource('second');
    assert.deepEqual(ids(await catalog()), ['dedicated', 'second']);
    const cli = execFileSync(process.execPath, [join(root, 'engine/entrypoint.mjs'), '--list-models', 'overlay-audit'], {
      cwd: root, env, encoding: 'utf8', timeout: 45000,
    });
    assert.match(cli, /second/);
    assert.match(cli, /dedicated/);
    assert.doesNotMatch(cli, /first/);
    // The preferred layer must not mask an invalid dedicated layer. Pi should
    // report the configuration error while retaining its built-in catalog.
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'overlay-audit': { models: 'invalid' } } }));
    const invalid = await catalog();
    assert.ok(invalid.warning, 'invalid schema should produce the normal Pi warning');
    assert.ok(invalid.providers.length > 0, 'built-in providers remain available');
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: {} }));
    writeFileSync(source, JSON.stringify({ providers: { 'overlay-audit': { models: 'invalid' } } }));
    const invalidUpstream = await catalog();
    assert.ok(invalidUpstream.warning, 'an invalid Pi schema must not be masked by dedicated settings');
    assert.ok(invalidUpstream.providers.length > 0, 'built-in providers remain available');
    writeFileSync(source, '{ invalid');
    const malformed = await catalog();
    assert.ok(malformed.warning, 'invalid JSON should produce the normal Pi warning');
    assert.ok(malformed.providers.length > 0, 'built-in providers remain available');
  } finally {
    child.stdin.end();
    await exit;
    lines.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('execution sends requests to a model loaded from the Pi overlay', { timeout: 45000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-overlay-execution-'));
  const agent = join(directory, 'agent');
  const source = join(directory, 'upstream.json');
  mkdirSync(agent);
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: {} }));
  let requestModel;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestModel = JSON.parse(Buffer.concat(chunks).toString()).model;
    const chunk = (delta, finish_reason) => ({ id: 'overlay', object: 'chat.completion.chunk', created: 1, model: 'fresh',
      choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'ok' }, null))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    writeFileSync(source, JSON.stringify({ providers: { 'overlay-execution': {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture-key',
      models: [{ id: 'fresh', contextWindow: 32000, maxTokens: 4096 }],
    } } }));
    const child = spawn(process.execPath, [join(root, 'engine/entrypoint.mjs'), '--mode', 'rpc', '--no-session',
      '--no-context-files', '--no-extensions', '--no-skills', '--model', 'overlay-execution/fresh'], {
      cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: directory, USERPROFILE: directory,
        PI_CODING_AGENT_DIR: agent, GRAPHER_UPSTREAM_PI_MODELS: source, GRAPHER_ISOLATED_PI_MODELS: '0', PI_OFFLINE: '1' },
    });
    let stderr = '';
    child.stderr.on('data', value => { stderr += value; });
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try { if (JSON.parse(line).type === 'agent_settled') settleRpc(child, 'node'); } catch {}
    });
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Pi exited ${code}: ${stderr}`)));
    });
    child.stdin.write(`${JSON.stringify({ type: 'prompt', message: 'test overlay' })}\n`);
    await exit;
    lines.close();
    assert.equal(requestModel, 'fresh');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Provider/Auth IPC returns a catalog after input EOF without exposing credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-pi-provider-'));
  try {
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { 'thinking-audit': {
      baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'local-audit-only',
      models: [{ id: 'restricted', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } }],
    } } }));
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      SystemRoot: process.env.SystemRoot,
      windir: process.env.windir,
      PI_CODING_AGENT_DIR: dir,
      GRAPHER_ISOLATED_PI_MODELS: '1',
      PI_OFFLINE: '1',
    };
    const output = execFileSync(process.execPath, ['--import', resolverUrl, join(root, 'engine/provider-host.ts')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 8 * 1024 * 1024,
      input: [
        { version: 1, operation: 'catalog', refresh: false },
        { version: 0, operation: 'catalog', refresh: false },
      ].map(request => JSON.stringify(request)).join('\n') + '\n',
      env,
    });
    const lines = output.trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(Buffer.byteLength(line) <= 4 * 1024 * 1024, 'Rust adapter rejects responses over 4 MiB');
    const replies = lines.map(JSON.parse);
    const catalog = replies.find(reply => reply.result?.providers);
    assert.equal(catalog?.version, 1);
    assert.ok(Array.isArray(catalog.result.providers) && catalog.result.providers.length > 0);
    assert.ok(catalog.result.providers.every(p => typeof p.id === 'string' && Array.isArray(p.methods)));
    assert.ok(Array.isArray(catalog.result.models) && catalog.result.models.length > 0);
    assert.ok(catalog.result.models.every(m => typeof m.id === 'string' && typeof m.provider === 'string' && typeof m.available === 'boolean'));
    const vocabulary = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const model of catalog.result.models) {
      assert.ok(Array.isArray(model.thinkingLevels) && model.thinkingLevels.every(level => vocabulary.includes(level)));
      assert.ok(model.thinkingLevelFallbacks && Object.values(model.thinkingLevelFallbacks).every(level => model.thinkingLevels.includes(level)));
    }
    const restricted = catalog.result.models.find(model => model.provider === 'thinking-audit');
    assert.deepEqual(restricted.thinkingLevels, ['low', 'high', 'max'], 'custom models use the same upstream capability lookup');
    assert.deepEqual(restricted.thinkingLevelFallbacks, { off: 'low', minimal: 'low', medium: 'high', xhigh: 'max' });
    const plain = catalog.result.models.find(model => model.provider === 'azure' && model.id === 'gpt-4o-mini');
    assert.deepEqual(plain.thinkingLevels, ['off']);
    assert.equal(plain.thinkingLevelFallbacks.high, 'off');
    assert.ok(!output.includes('local-audit-only'), 'model metadata must not expose custom provider credentials');
    assert.ok(catalog.result.providers.some(provider => provider.id === 'azure'));
    assert.ok(!catalog.result.providers.some(provider => provider.id === 'azure-openai-responses'));
    const azure = catalog.result.models.filter(model => model.provider === 'azure');
    assert.ok(azure.some(model => model.api === 'azure-openai-responses'), 'Responses API id is unchanged');
    assert.ok(azure.some(model => model.id === 'deepseek-v4-pro' && model.api === 'openai-completions'));
    assert.deepEqual(replies.find(reply => reply.error), { version: 1, error: 'Provider/Auth operation failed. Refresh providers or restart login.' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
