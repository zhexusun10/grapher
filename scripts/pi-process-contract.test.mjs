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
  const identity = 'You are an expert coding assistant operating inside pi, a coding agent harness.';
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
        if (event.type === 'agent_end') child.stdin.end();
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
      const args = role === 'node' ? ['--approve'] : role === 'planner' ? ['--exclude-tools', 'edit,write,ls,find,grep']
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
        assert.ok(system.includes('You are an expert coding assistant.'), `${role}: trim Pi identity; provider roles=${body.messages.map(message => message.role)}\n${system}`);
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
        if (event.type === 'agent_settled') child.stdin.end();
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
    ]) {
      writeFileSync(join(agent, 'extensions.json'), JSON.stringify({ overrides: { 'npm:pi-continuity': enabled } }));
      requests.length = 0;
      const events = await run(role, noExtensions);
      assert.deepEqual(serverErrors, []);
      const recover = enabled && !noExtensions && (role === 'planner' || role === 'node');
      assert.equal(requests.length, recover ? 2 : 1, `${role}: selected=${enabled}, noExtensions=${noExtensions}`);
      const assistants = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant');
      assert.equal(assistants.at(-1)?.message.stopReason, recover ? 'stop' : 'length');
      assert.ok(events.some(event => event.type === 'agent_settled'));
      if (recover) {
        assert.ok(JSON.stringify(requests[1].messages).includes('partial progress'), 'bounded checkpoint reaches the recovery request');
        assert.ok(!requests[1].messages.some(message => message.role === 'assistant'), 'interrupted assistant protocol is omitted');
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Provider/Auth IPC returns a catalog after input EOF without exposing credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-pi-provider-'));
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      SystemRoot: process.env.SystemRoot,
      windir: process.env.windir,
      PI_CODING_AGENT_DIR: dir,
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
    assert.deepEqual(replies.find(reply => reply.error), { version: 1, error: 'Provider/Auth operation failed. Refresh providers or restart login.' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
