// Native Windows acceptance: stock Pi/Planner Bash, then the production HTTP
// backend + pinned Pi + Git. Only model responses are deterministic/local;
// there is no fixture engine, sandbox, VM, provider credential, or external API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBashToolDefinition } from '../pi/packages/coding-agent/src/core/tools/bash.ts';
import { loadExtensions } from '../pi/packages/coding-agent/src/core/extensions/loader.ts';
import { getShellConfig } from '../pi/packages/coding-agent/src/utils/shell.ts';

const windows = process.platform === 'win32';
const root = resolve('.');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));

test('Planner uses the same unmodified Bash definition and semantics as pinned Pi', { skip: !windows }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-bash-'));
  const workspace = join(directory, '中文 space');
  const previous = process.cwd();
  try {
    await mkdir(workspace);
    process.chdir(workspace);
    const loaded = await loadExtensions([join(root, 'backend/resources/planner.ts')], workspace);
    assert.deepEqual(loaded.errors, []);
    const planner = loaded.extensions[0].tools.get('bash')!.definition;
    const builtin = createBashToolDefinition(workspace);
    assert.equal(planner.execute.toString(), builtin.execute.toString());
    const shell = getShellConfig();
    assert.match(shell.shell.replaceAll('\\', '/'), /\/Git\/bin\/bash\.exe$/i);
    const cases = [
      ["values=(alpha beta); printf '%s ' \"${values[@]}\"", 'alpha beta'],
      ["printf 'b\\na\\n' | sort | tr '\\n' ','", 'a,b,'],
      ['value=$(printf substitution); printf %s "$value"', 'substitution'],
      ['(printf subshell)', 'subshell'],
      ['printf background > background.txt & child=$!; wait "$child"; cat background.txt', 'background'],
      ['bash -c \'sh -c "printf nested"\'', 'nested'],
      ['printf redirected > redirected.txt; cat < redirected.txt', 'redirected'],
      ['false | true; false; printf native', 'native'],
      ['printf stdout; printf stderr >&2', /stdout.*stderr|stderr.*stdout/s],
      [`${quote(process.execPath)} -e 'process.stdout.write("node-ok")'`, 'node-ok'],
      ['git --version', /^git version /],
      ['rustc --version', /^rustc /],
    ] as const;
    const context = { cwd: workspace, sessionManager: { getSessionId: () => 'bash-test', getSessionFile: () => undefined } } as any;
    for (const tool of [builtin, planner]) {
      for (const [command, expected] of cases) {
        const input = { command };
        const response = await tool.execute('bash-test', input, undefined, undefined, context);
        const output = response.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
        if (typeof expected === 'string') assert.equal(output, expected);
        else assert.match(output, expected);
        assert.equal(input.command, command);
      }
      await assert.rejects(() => tool.execute('nonzero', { command: 'exit 7' }, undefined, undefined, context), /exited with code 7/);
      await assert.rejects(() => tool.execute('timeout', { command: 'sleep 5', timeout: 0.1 }, undefined, undefined, context), /timed out/i);
    }
  } finally {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  }
});

test('production Windows Planner/Graph: concurrent runs, dependencies, publication, cancellation and crash recovery', { skip: !windows, timeout: 300000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-windows-'));
  const agent = join(directory, 'agent');
  const data = join(directory, 'data');
  let backend: ChildProcess | undefined;
  let diagnostics = '';
  const toolRequests: string[] = [];
  const failures: unknown[] = [];
  const repositories = new Map<string, string>();
  const config = (repository: string) => ({ repository, model: 'windows-test/native', thinkingLevel: 'off', maxParallel: 2, maxFeedback: 1 });
  const git = (repository: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd: repository, encoding: 'utf8' }).trim();
  const modelServer = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const messages = body.messages;
      const prompt = messages.filter((message: any) => message.role === 'user').map((message: any) => JSON.stringify(message.content)).join('\n');
      const label = [...repositories.keys()].find(key => prompt.includes(key));
      assert.ok(label, `Missing test task marker: ${prompt}`);
      const repository = repositories.get(label)!;
      const planner = body.tools?.some((tool: any) => tool.function.name === 'node');
      const results = messages.filter((message: any) => message.role === 'tool').length;
      let tool: { name: string; arguments: any } | undefined;
      let text = 'Completed';
      if (planner) {
        if (results === 0) tool = { name: 'bash', arguments: { command: 'printf planned > planned.txt' } };
        if (results === 1) tool = { name: 'node', arguments: { nodes: [
          { name: 'alpha', task: `${label} LEAF_ALPHA: create a.txt containing alpha using Bash.` },
          { name: 'beta', task: `${label} LEAF_BETA: create b.txt containing beta using Bash.` },
          { name: 'join', task: `${label} JOIN_BRANCHES: verify a.txt and b.txt and create joined.txt containing alpha-beta.` },
        ] } };
        if (results === 2) tool = { name: 'edge', arguments: { edges: [
          { from: 'alpha', to: 'join', relation: 'alpha result' },
          { from: 'beta', to: 'join', relation: 'beta result' },
        ] } };
      } else if (results === 0) {
        let command;
        if (prompt.includes('LEAF_ALPHA')) command = `sleep 0.5; printf alpha > ${quote(join(repository, 'a.txt'))}`;
        else if (prompt.includes('LEAF_BETA')) command = 'sleep 0.5; printf beta > b.txt';
        else if (prompt.includes('JOIN_BRANCHES')) command = 'test "$(cat a.txt)" = alpha && test "$(cat b.txt)" = beta && printf alpha-beta > joined.txt';
        else if (prompt.includes('LONG_RUNNING')) {
          // An unpatched Windows Node grandchild writing outside the repository.
          // Job ownership, not filesystem sandboxing, must terminate it.
          const marker = join(directory, `writer-${label}.txt`);
          const program = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker.replaceAll('\\', '/'))},'x'),50)`;
          command = `${quote(process.execPath)} -e ${quote(program)} & wait`;
        } else throw new Error(`Unknown node task: ${prompt}`);
        tool = { name: 'bash', arguments: { command } };
      }
      if (tool) toolRequests.push(`${label}:${planner ? 'planner' : 'node'}:${tool.name}`);
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${toolRequests.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: text };
      const chunk = (delta: any, finish_reason: string | null) => ({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'native', choices: [{ index: 0, delta, finish_reason }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      failures.push(error);
      response.writeHead(500);
      response.end(String(error));
    }
  });
  const killBackend = async () => {
    if (backend?.pid && backend.exitCode === null) {
      const exited = once(backend, 'exit');
      // Terminate only the test-owned backend. Kill-on-close must handle agents.
      execFileSync('taskkill', ['/PID', String(backend.pid), '/F'], { stdio: 'ignore' });
      await exited;
    }
  };
  try {
    await mkdir(agent);
    await new Promise<void>(done => modelServer.listen(0, '127.0.0.1', done));
    const modelPort = (modelServer.address() as AddressInfo).port;
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'windows-test': {
      baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', apiKey: 'local-test-only',
      models: [{ id: 'native', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const listener = createServer();
    await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
    const port = (listener.address() as AddressInfo).port;
    await new Promise<void>(done => listener.close(() => done()));
    const env = { ...process.env, GRAPHER_DATA_DIR: data, GRAPHER_PORT: String(port), PI_CODING_AGENT_DIR: agent,
      GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'runtime'),
      PLANNER_MODEL: 'windows-test/native', NODE_AGENT_MODEL: 'windows-test/native', PARTITIONER_MODEL: 'windows-test/native', MERGER_MODEL: 'windows-test/native',
      PLANNER_THINKING: 'off', NODE_AGENT_THINKING: 'off', PARTITIONER_THINKING: 'off', MERGER_THINKING: 'off' };
    const startBackend = () => {
      backend = spawn(join(root, 'backend/target/debug/grapher.exe'), [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      backend.stderr!.on('data', value => { diagnostics += value.toString(); });
    };
    const api = async (command: string, body: any = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const payload = await response.json() as any;
      if (!response.ok || payload.error) throw new Error(payload.error || String(response.status));
      return payload.result;
    };
    const until = async (check: () => Promise<any>, message: string) => {
      const start = Date.now();
      while (Date.now() - start < 180000) {
        assert.deepEqual(failures, []);
        if (backend?.exitCode !== null) throw new Error(`Backend exited: ${diagnostics}`);
        const result = await check();
        if (result) return result;
        await delay(100);
      }
      throw new Error(`${message}\n${diagnostics}`);
    };
    const ready = () => until(async () => { try { return await api('bootstrap'); } catch { return false; } }, 'Backend did not start');
    startBackend();
    await ready();
    for (const label of ['WIN_ONE', 'WIN_TWO', 'WIN_CANCEL', 'WIN_CRASH']) {
      const repository = join(directory, `中文 ${label} repo`);
      await mkdir(repository);
      await writeFile(join(repository, 'base.txt'), 'base');
      git(repository, 'init', '-q'); git(repository, 'add', '-A'); git(repository, 'commit', '-qm', 'base');
      repositories.set(label, repository);
    }
    const plans = await Promise.all(['WIN_ONE', 'WIN_TWO'].map(async label => {
      const repository = repositories.get(label)!;
      const snapshot = await api('plan_goal', { goal: `${label}: implement two independent branches and combine them`, mode: 'graph', config: config(repository) });
      assert.equal(snapshot.planType, 'graph');
      assert.equal(snapshot.phase, 'awaiting_approval');
      assert.equal(snapshot.graph.nodes.length, 3);
      assert.equal(snapshot.graph.edges.length, 2);
      assert.equal(await readFile(join(repository, 'planned.txt'), 'utf8'), 'planned');
      return { label, repository, runId: snapshot.runId };
    }));
    assert.notEqual(plans[0].runId, plans[1].runId);
    await Promise.all(plans.map(plan => api('control', { action: 'approve', runId: plan.runId })));
    const completed = await Promise.all(plans.map(plan => until(async () => {
      const snapshot = await api('snapshot', { runId: plan.runId });
      assert.ok(!['failed', 'publication_failed'].includes(snapshot.phase), JSON.stringify(snapshot));
      return snapshot.phase === 'completed' && snapshot;
    }, `Graph ${plan.label} did not complete`)));
    for (const [index, plan] of plans.entries()) {
      const snapshot = completed[index];
      for (const name of ['alpha', 'beta', 'join']) assert.equal(snapshot.nodes[name].status, 'done');
      assert.equal(await readFile(join(plan.repository, 'a.txt'), 'utf8'), 'alpha');
      assert.equal(await readFile(join(plan.repository, 'b.txt'), 'utf8'), 'beta');
      assert.equal(await readFile(join(plan.repository, 'joined.txt'), 'utf8'), 'alpha-beta');
      assert.equal(git(plan.repository, 'status', '--porcelain'), '');
      const executions = snapshot.executions;
      assert.equal(executions.length, 3);
      assert.equal(new Set(executions.map((execution: any) => execution.sessionId)).size, 3);
      const alpha = executions.find((execution: any) => execution.node === 'alpha');
      const beta = executions.find((execution: any) => execution.node === 'beta');
      assert.ok(alpha.startedAt <= beta.completedAt && beta.startedAt <= alpha.completedAt, 'Branches must overlap');
      for (const execution of executions) {
        assert.notEqual(execution.worktree, plan.repository);
        git(plan.repository, 'merge-base', '--is-ancestor', execution.after, 'HEAD');
      }
    }
    const startWriter = async (label: string) => {
      const snapshot = await api('save_graph', { graph: { originalGoal: label, nodes: [{ name: 'worker', task: `${label} LONG_RUNNING` }], edges: [] }, config: config(repositories.get(label)!) });
      await api('control', { action: 'approve', runId: snapshot.runId });
      const marker = join(directory, `writer-${label}.txt`);
      try {
        await until(async () => { try { return (await stat(marker)).size > 0; } catch { return false; } }, 'Background writer did not start');
      } catch (error) {
        const state = await api('snapshot', { runId: snapshot.runId });
        const execution = state.executions.at(-1);
        const output = execution && await api('get_execution_output', { runId: snapshot.runId, executionId: execution.id });
        throw new Error(`${error}\nRequests: ${JSON.stringify(toolRequests)}\nExecution: ${JSON.stringify(output)}`);
      }
      return { runId: snapshot.runId, marker };
    };
    const stable = async (marker: string) => {
      await delay(300);
      const before = (await stat(marker)).size;
      await delay(500);
      assert.equal((await stat(marker)).size, before, 'Job descendants must stop writing');
    };
    const cancelled = await startWriter('WIN_CANCEL');
    await api('control', { action: 'cancel', runId: cancelled.runId });
    await stable(cancelled.marker);
    await until(async () => (await api('snapshot', { runId: cancelled.runId })).executions.every((execution: any) => execution.status !== 'running'), 'Cancellation did not settle');
    const crashed = await startWriter('WIN_CRASH');
    await killBackend();
    await stable(crashed.marker);
    startBackend();
    await ready();
    const recovered = await api('snapshot', { runId: crashed.runId });
    assert.equal(recovered.paused, true);
    assert.equal(recovered.executions[0].status, 'failed');
    assert.equal(recovered.nodes.worker.status, 'failed');
    assert.deepEqual(failures, []);
    assert.ok(toolRequests.filter(value => value.includes(':planner:bash')).length >= 2);
  } finally {
    await killBackend();
    modelServer.closeAllConnections();
    await new Promise<void>(done => modelServer.close(() => done()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
