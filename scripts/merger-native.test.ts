// Production backend, real pinned Pi/tools/Git, deterministic local model.
// Exercise the actual Merger launch path, including private platform boundaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const root = resolve('.');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const normalize = (value: string) => value.replace(/^\\\\\?\\/, '').replaceAll('\\', '/');
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));

test('production Merger repairs node, Planner preview and source conflicts; failures retain evidence', { timeout: 300000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'grapher-merger-')));
  const agent = join(directory, 'agent');
  const data = join(directory, 'data');
  const cases = new Map<string, { repository: string; kind: 'node' | 'publication' | 'planner'; plain: boolean; fail: boolean }>();
  const requests: string[] = [];
  const errors: unknown[] = [];
  let backend: ChildProcess | undefined;
  let diagnostics = '';
  const git = (repository: string, ...args: string[]) => execFileSync('git', [
    '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args,
  ], { cwd: repository, encoding: 'utf8' }).trim();
  const config = (repository: string) => ({ repository, model: 'merger-test/native', thinkingLevel: 'off', maxParallel: 2, maxFeedback: 1 });
  const modelServer = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const messages = body.messages;
      const prompt = messages.filter((message: any) => ['system', 'user'].includes(message.role))
        .map((message: any) => JSON.stringify(message.content)).join('\n');
      const label = [...cases.keys()].find(key => prompt.includes(key));
      assert.ok(label, `Missing task marker: ${prompt}`);
      const scenario = cases.get(label)!;
      const planner = body.tools?.some((tool: any) => tool.function.name === 'node');
      const merger = prompt.includes('Resolve the current Git merge conflicts.');
      const results = messages.filter((message: any) => message.role === 'tool');
      assert.ok(results.every((result: any) => !JSON.stringify(result.content).includes('exited with code')),
        `Tool failed for ${label}: ${JSON.stringify(results)}`);
      const role = planner ? 'planner' : merger ? 'merger' : 'node';
      let tool: { name: string; arguments: any } | undefined;
      if (planner) {
        if (results.length === 0) {
          // Simulate a source edit concurrent with the private Planner session.
          await writeFile(join(scenario.repository, 'shared.txt'), 'source change\n');
          tool = { name: 'bash', arguments: { command: "printf 'planner change\\n' > shared.txt" } };
        } else if (results.length === 1) {
          tool = { name: 'node', arguments: { nodes: [{ name: 'verify', task: `${label} VERIFY_RESOLUTION` }] } };
        }
      } else if (merger) {
        const system = messages.filter((message: any) => message.role === 'system')
          .map((message: any) => JSON.stringify(message.content)).join('\n');
        assert.ok(system.includes('You are an expert coding assistant.'), 'Merger must retain the default coding prompt');
        assert.ok(system.includes('<tools>') && system.includes('<rules>'), 'Merger must retain Pi tool guidance and rules');
        assert.ok(system.includes('Preserve valid changes. Do not modify unrelated files.'), 'Merger instructions must be appended');
        assert.ok(system.includes('Do not discard the incoming commit.'));
        if (!scenario.fail && results.length === 0) {
          // Absolute source aliases must select the conflicted private file for
          // node/preview Mergers, but remain source paths during publication.
          tool = { name: 'bash', arguments: { command:
            `test -n "$(git diff --name-only --diff-filter=U)" && git rev-parse --verify MERGE_HEAD && printf 'resolved\\n' > ${quote(join(scenario.repository, 'shared.txt'))} && git add shared.txt`,
          } };
        }
      } else if (results.length === 0) {
        const command = prompt.includes('WRITE_LEFT') ? "printf 'left\\n' > shared.txt"
          : prompt.includes('WRITE_RIGHT') ? "printf 'right\\n' > shared.txt"
          : 'test "$(cat shared.txt)" = resolved && printf verified > verified.txt';
        tool = { name: 'bash', arguments: { command } };
      }
      requests.push(`${label}:${role}:${tool?.name ?? 'done'}`);
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function',
        function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
        : { role: 'assistant', content: 'Completed' };
      const chunk = (delta: any, finish_reason: string | null) => ({ id: 'test', object: 'chat.completion.chunk', created: 1,
        model: 'native', choices: [{ index: 0, delta, finish_reason }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      errors.push(error);
      response.writeHead(500);
      response.end(String(error));
    }
  });
  try {
    await mkdir(agent);
    await new Promise<void>(done => modelServer.listen(0, '127.0.0.1', done));
    const modelPort = (modelServer.address() as AddressInfo).port;
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'merger-test': {
      baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', apiKey: 'local-test-only',
      models: [{ id: 'native', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const listener = createServer();
    await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
    const port = (listener.address() as AddressInfo).port;
    await new Promise<void>(done => listener.close(() => done()));
    const env = { ...process.env, GRAPHER_DATA_DIR: data, GRAPHER_PORT: String(port), PI_CODING_AGENT_DIR: agent,
      GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'runtime'),
      PLANNER_MODEL: 'merger-test/native', NODE_AGENT_MODEL: 'merger-test/native',
      PARTITIONER_MODEL: 'merger-test/native', MERGER_MODEL: 'merger-test/native',
      PLANNER_THINKING: 'off', NODE_AGENT_THINKING: 'off', PARTITIONER_THINKING: 'off', MERGER_THINKING: 'off' };
    backend = spawn(join(root, `backend/target/debug/grapher${process.platform === 'win32' ? '.exe' : ''}`), [],
      { env, stdio: ['ignore', 'ignore', 'pipe'] });
    backend.stderr!.on('data', value => { diagnostics += value.toString(); });
    const api = async (command: string, body: any = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const payload = await response.json() as any;
      if (!response.ok || payload.error) throw new Error(payload.error || String(response.status));
      return payload.result;
    };
    const until = async (check: () => Promise<any>) => {
      const start = Date.now();
      while (Date.now() - start < 180000) {
        assert.deepEqual(errors, []);
        if (backend?.exitCode !== null) throw new Error(`Backend exited: ${diagnostics}`);
        const result = await check();
        if (result) return result;
        await delay(100);
      }
      throw new Error(`Merger test timed out\n${diagnostics}\n${JSON.stringify(requests)}`);
    };
    await until(async () => { try { return await api('bootstrap'); } catch { return false; } });
    const specifications = [
      ['FAN_IN_GIT', 'node', false, false], ['FAN_IN_PLAIN', 'node', true, false],
      ['PUBLICATION_GIT', 'publication', false, false], ['PUBLICATION_PLAIN', 'publication', true, false],
      ['PLANNER_GIT', 'planner', false, false], ['PLANNER_PLAIN', 'planner', true, false],
      ['FAILED_NODE', 'node', false, true], ['FAILED_PLANNER', 'planner', true, true],
    ] as const;
    for (const [label, kind, plain, fail] of specifications) {
      const repository = join(directory, `中文 ${label} workspace`);
      await mkdir(repository);
      await writeFile(join(repository, 'shared.txt'), 'base\n');
      if (!plain) {
        git(repository, 'init', '-q'); git(repository, 'add', '-A'); git(repository, 'commit', '-qm', 'base');
      }
      cases.set(label, { repository, kind, plain, fail });
      let initial;
      if (kind === 'planner') {
        if (fail) {
          await assert.rejects(api('plan_goal', { goal: `${label} plan a verification task`, mode: 'graph', config: config(repository) }),
            /Merger left unresolved conflicts/);
          assert.equal((await readFile(join(repository, 'shared.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'source change\n');
          const attempts = await api('list_plannings', { repository });
          const attempt = attempts.find((item: any) => item.status === 'failed');
          assert.ok(attempt);
          const events = (await readFile(join(data, 'planning', attempt.planningId, 'merger-events.jsonl'), 'utf8'))
            .trim().split('\n').map(line => JSON.parse(line));
          assert.ok(events.some((event: any) => event.type === 'merger_failed'));
          const cwd = events.find((event: any) => event.type === 'merger_started').execution.worktree;
          assert.ok(git(cwd, 'diff', '--name-only', '--diff-filter=U'));
          continue;
        }
        initial = await api('plan_goal', { goal: `${label} plan a verification task`, mode: 'graph', config: config(repository) });
        assert.equal(initial.phase, 'awaiting_approval');
        assert.equal((await readFile(join(repository, 'shared.txt'), 'utf8')).trim(), 'resolved');
        const events = (await readFile(join(data, 'planning', initial.planningId, 'merger-events.jsonl'), 'utf8'))
          .trim().split('\n').map(line => JSON.parse(line));
        assert.ok(events.some((event: any) => event.type === 'merger_finished'));
        const execution = events.find((event: any) => event.type === 'merger_started').execution;
        assert.match(normalize(execution.worktree), /\.grapher-workspaces\/[^/]+\/[^/]+-preview$/);
        assert.notEqual(normalize(execution.worktree), normalize(repository));
        assert.ok(initial.planning.roles.merger, 'Planner conflict-repair metrics must be retained');
      } else {
        const nodes = [{ name: 'left', task: `${label} WRITE_LEFT` }, { name: 'right', task: `${label} WRITE_RIGHT` }];
        if (kind === 'node') nodes.push({ name: 'join', task: `${label} VERIFY_RESOLUTION` });
        initial = await api('save_graph', { config: config(repository), graph: { originalGoal: label, nodes,
          edges: kind === 'node' ? [{ from: 'left', to: 'join', feedback: false, relation: '' },
            { from: 'right', to: 'join', feedback: false, relation: '' }] : [] } });
      }
      await api('control', { action: 'approve', runId: initial.runId });
      const state = await until(async () => {
        const current = await api('snapshot', { runId: initial.runId });
        if (fail) return current.nodes.join.status === 'blocked' && current;
        assert.ok(!['needs_attention', 'publication_failed', 'failed'].includes(current.phase),
          `${JSON.stringify(current)}\n${diagnostics}`);
        return current.phase === 'completed' && current;
      });
      assert.ok(requests.includes(`${label}:merger:done`));
      const merger = kind === 'planner' ? undefined : state.mergers[0];
      if (kind !== 'planner') {
        assert.equal(state.mergers.length, 1);
        assert.equal(merger.node, kind === 'node' ? 'merge:join' : 'merger');
        assert.equal(merger.status, fail ? 'failed' : 'completed');
        if (kind === 'node') assert.notEqual(normalize(merger.worktree), normalize(repository));
        else assert.equal(normalize(merger.worktree), normalize(repository));
        const log = await api('get_execution_output', { runId: state.runId, executionId: merger.id, full: true });
        assert.ok(log.content.includes('Completed'));
      }
      if (fail) {
        assert.equal((await readFile(join(repository, 'shared.txt'), 'utf8')).trim(), 'base');
        assert.ok(git(merger.worktree, 'diff', '--name-only', '--diff-filter=U'));
        assert.ok(git(merger.worktree, 'rev-parse', '--verify', 'MERGE_HEAD'));
        assert.equal(state.publication, null);
      } else {
        assert.equal((await readFile(join(repository, 'shared.txt'), 'utf8')).trim(), 'resolved');
        if (kind !== 'publication') assert.equal(await readFile(join(repository, 'verified.txt'), 'utf8'), 'verified');
        assert.equal(state.publication.status, 'completed');
        if (!plain) {
          assert.equal(git(repository, 'status', '--porcelain'), '');
          for (const execution of state.executions) git(repository, 'merge-base', '--is-ancestor', execution.after, 'HEAD');
        } else {
          await assert.rejects(readFile(join(repository, '.git')), /ENOENT/);
        }
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    if (backend?.pid && backend.exitCode === null) {
      const exited = once(backend, 'exit');
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(backend.pid), '/F'], { stdio: 'ignore' });
      else backend.kill('SIGTERM');
      await exited;
    }
    modelServer.closeAllConnections();
    await new Promise<void>(done => modelServer.close(() => done()));
    await rm(directory, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
});
