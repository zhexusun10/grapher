// Production backend, real pinned Pi/tools/Git, deterministic local model.
// Exercise the actual Merger launch path, including private platform boundaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, toNamespacedPath } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { removeSandboxMasks } from './fixtures/sandbox-masks.mjs';

const root = resolve('.');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const normalize = (value: string) => value.replace(/^\\\\\?\\/, '').replaceAll('\\', '/');
// Backend slots name their host-only graph Git after a digest of the slot label.
const privateGitDirectory = (worktree: string) => {
  const name = basename(worktree);
  const digest = createHash('sha1').update(`blob ${Buffer.byteLength(name)}\0${name}`).digest('hex');
  return join(dirname(worktree), '.grapher-git', `${digest.slice(0, 16)}.git`);
};
const delay = (ms: number) => new Promise(completed => setTimeout(completed, ms));

// Real Pi processes make the Windows production path roughly twice as slow
// as local runs; keep headroom so host load is not reported as a hang.
test('production Planner writes source directly; Merger repairs node and publication conflicts', { timeout: 600000 }, async () => {
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
    '-c', 'core.longpaths=true', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args,
  ], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // Exercise Windows' canonical extended prefix through the real HTTP/CLI path.
  // The post-task Planner review is a Planning turn accepted by its own harness; this
  // deterministic local model must only answer the Merger/node turns under test, so
  // the review would otherwise write the source out from under these assertions.
  const config = (repository: string) => ({ repository: toNamespacedPath(repository), model: 'merger-test/native', thinkingLevel: 'off', maxParallel: 2, maxFeedback: 1, postTaskReview: false });
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
      const userTurn = messages[messages.findLastIndex((message: any) => message.role === 'user')];
      const userInstruction = typeof userTurn.content === 'string' ? userTurn.content
        : userTurn.content.map((part: any) => part.text ?? '').join('');
      const continuation = userInstruction.includes('CONTINUE_PUBLICATION');
      const merger = prompt.includes('Resolve the current Git merge conflicts.')
        || prompt.includes('Resolve the conflicting project files in this workspace.')
        || continuation;
      const results = messages.filter((message: any) => message.role === 'tool');
      assert.ok(results.every((result: any) => !JSON.stringify(result.content).includes('exited with code')),
        `Tool failed for ${label}: ${JSON.stringify(results)}`);
      const role = planner ? 'planner' : merger ? 'merger' : 'node';
      let tool: { name: string; arguments: any } | undefined;
      if (planner) {
        const userIndex = messages.findLastIndex((message: any) => message.role === 'user');
        const turn = JSON.stringify(messages[userIndex].content);
        const turnResults = messages.slice(userIndex + 1).filter((message: any) => message.role === 'tool');
        const failedRevision = turn.includes('FAILED_REVISION');
        const revision = turn.includes('REVISE_SOURCE');
        const expected = failedRevision ? 'failed revision' : revision ? 'planner revision' : 'planner change';
        if (turnResults.length === 0) {
          // Native Planner Bash must modify this exact source, without a preview merge.
          await writeFile(join(scenario.repository, 'shared.txt'), 'source change\n');
          const extra = failedRevision ? ' && printf survived > failed.txt'
            : revision ? ' && printf latest > revision.txt' : '';
          tool = { name: 'bash', arguments: { command: `printf '${expected}\\n' > shared.txt${extra}` } };
        } else if (turnResults.length === 1) {
          assert.equal((await readFile(join(scenario.repository, 'shared.txt'), 'utf8')).trim(), expected,
            'Bash writes must already be in the source before planning finishes');
          if (failedRevision) tool = { name: 'node', arguments: { nodes: [{ name: 'verify', delete: true }] } };
          else if (!scenario.fail) tool = { name: 'node', arguments: { nodes: [{ name: revision ? 'late' : 'verify',
            task: `${label} ${revision ? 'VERIFY_PLANNER_REVISION' : 'VERIFY_PLANNER_SOURCE'}` }] } };
        } else if (revision && turnResults.length === 2) {
          tool = { name: 'edge', arguments: { edges: [{ from: 'verify', to: 'late' }] } };
        }
      } else if (merger) {
        const system = messages.filter((message: any) => message.role === 'system')
          .map((message: any) => JSON.stringify(message.content)).join('\n');
        assert.ok(system.includes('You are an expert coding assistant'), 'Merger must retain the default coding prompt');
        assert.ok(system.includes('<tools>') && system.includes('<rules>'), 'Merger must retain Pi tool guidance and rules');
        const pathGuideline = 'Use project-root-relative paths in Bash commands and project files.';
        assert.ok(system.includes(pathGuideline), 'all Merger turns retain the shared path convention');
        if (continuation) {
          assert.ok(!system.includes('Continue the previous conflict-repair conversation'), 'follow-ups must not append continuation instructions');
          assert.ok(!system.includes('leave the working tree clean'), 'follow-ups must not append Git workflow instructions');
          assert.ok(!system.includes('git add -f -- <paths>'), 'follow-ups must not re-append the initial collection instructions');
          assert.ok(!system.includes('CONTINUE_PUBLICATION'), 'the follow-up belongs only in the user message');
          assert.equal(userInstruction, `${label} CONTINUE_PUBLICATION`, 'send the user instruction unchanged');
        } else {
          assert.ok(system.includes('git add -f -- <paths>'), 'initial repair must stage resolved project paths');
          assert.ok(system.includes('internal composition commits are not part of it'), 'project Git must not expose graph history');
          assert.ok(system.includes('Do not invent a merge or snapshot commit.'));
          assert.ok(system.includes('If the source has no .git, resolve the files directly without initializing Git.'));
          assert.ok(system.includes(`preserves the composition parents.\\n${pathGuideline}`), 'path convention must directly follow the initial addendum without a blank line');
        }
        // A continued session carries the original turn's tool results, so
        // count results after the latest user message for this turn.
        const turnResults = messages
          .slice(messages.findLastIndex((message: any) => message.role === 'user') + 1)
          .filter((message: any) => message.role === 'tool');
        if (continuation && turnResults.length === 0) {
          // After delivery the same conversation edits source directly, without
          // manufacturing another visible commit or re-entering publication.
          tool = { name: 'bash', arguments: { command: "printf 'continued\\n' > continued.txt" } };
        } else if (!scenario.fail && results.length === 0) {
          // Absolute source aliases select the conflicted private file for both
          // node and publication Mergers, never the user's source file. The
          // Merger's Git targets the graph metadata, which carries the pending
          // merge (MERGE_HEAD) and the unmerged index; the visible project Git
          // is only a mirror of that conflicted index.
          const visible = scenario.plain
            ? 'test ! -e .git && '
            : 'test -n "$(git diff --name-only --diff-filter=U)" && test -n "$(git rev-parse --verify -q MERGE_HEAD)" && ';
          tool = { name: 'bash', arguments: { command:
            `${visible}printf 'resolved\\n' > ${quote(join(scenario.repository, 'shared.txt'))}${scenario.plain ? '' : ' && git add -f shared.txt'}`,
          } };
        }
      } else if (results.length === 0) {
        const projectView = scenario.plain
          ? 'test ! -e .git && '
          : 'test -d .git && test -z "$(git for-each-ref --format=\"%(refname)\" refs/grapher/)" && test "$(git branch --show-current)" != grapher-node && ';
        const command = prompt.includes('WRITE_LEFT') ? "printf 'left\\n' > shared.txt"
          : prompt.includes('WRITE_RIGHT') ? "printf 'right\\n' > shared.txt"
          : prompt.includes('VERIFY_PLANNER_REVISION') ? 'test "$(cat shared.txt)" = "planner revision" && test "$(cat revision.txt)" = latest && test "$(cat failed.txt)" = survived && test "$(cat verified.txt)" = verified && printf inherited > late.txt'
          : prompt.includes('VERIFY_PLANNER_SOURCE') ? 'test "$(cat shared.txt)" = "planner change" && printf verified > verified.txt'
          : 'test "$(cat shared.txt)" = resolved && printf verified > verified.txt';
        tool = { name: 'bash', arguments: { command: `${projectView}${command}` } };
      }
      requests.push(`${label}:${role}:${tool?.name ?? 'completed'}`);
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
    await new Promise<void>(completed => modelServer.listen(0, '127.0.0.1', completed));
    const modelPort = (modelServer.address() as AddressInfo).port;
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'merger-test': {
      baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', apiKey: 'local-test-only',
      models: [{ id: 'native', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const listener = createServer();
    await new Promise<void>(completed => listener.listen(0, '127.0.0.1', completed));
    const port = (listener.address() as AddressInfo).port;
    await new Promise<void>(completed => listener.close(() => completed()));
    const env = { ...process.env, GRAPHER_DATA_DIR: data, GRAPHER_PORT: String(port), PI_CODING_AGENT_DIR: agent,
      GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'runtime'), GRAPHER_WORKSPACE_PARENT: join(directory, 'workspaces'),
      PLANNER_MODEL: 'merger-test/native', NODE_AGENT_MODEL: 'merger-test/native',
      PARTITIONER_MODEL: 'merger-test/native', MERGER_MODEL: 'merger-test/native',
      PLANNER_THINKING: 'off', NODE_AGENT_THINKING: 'off', PARTITIONER_THINKING: 'off', MERGER_THINKING: 'off' };
    const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'backend/target');
    backend = spawn(join(target, `debug/grapher${process.platform === 'win32' ? '.exe' : ''}`), [],
      { env, stdio: ['ignore', 'ignore', 'pipe'] });
    backend.stderr!.on('data', value => { diagnostics += value.toString(); });
    const api = async (command: string, body: any = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const payload = await response.json() as any;
      if (!response.ok || payload.error) throw new Error(`${payload.error || String(response.status)}\n${diagnostics}`);
      return payload.result;
    };
    // Revisions use the same SSE endpoint as the frontend, not draft plan_goal.
    const revise = async (goal: string, runId: string, repository: string) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/plan_goal_stream`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
          body: JSON.stringify({ goal, mode: 'graph', revisionRunId: runId, config: config(repository) }) });
        if (!response.ok) throw new Error((await response.json() as any).error || String(response.status));
        let snapshot: any;
        for (const frame of (await response.text()).split(/\r?\n\r?\n/)) {
          const event = frame.split(/\r?\n/).find(line => line.startsWith('event: '))?.slice(7);
          const data = frame.split(/\r?\n/).find(line => line.startsWith('data: '))?.slice(6);
          if (!data) continue;
          const payload = JSON.parse(data);
          if (event === 'error') throw new Error(payload.error);
          if (event === 'complete') snapshot = payload.snapshot;
        }
        assert.ok(snapshot, 'revision SSE must finish with a snapshot');
        return snapshot;
      } catch (error) {
        let state: unknown = 'unavailable';
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(2000),
            body: JSON.stringify({ runId }) });
          state = await response.json();
        } catch (snapshotError) {
          state = String(snapshotError);
        }
        let planning: unknown = 'unavailable';
        try { planning = await readdir(join(data, 'planning')); } catch (planningError) { planning = String(planningError); }
        throw new Error(`${error}\nRevision state: ${JSON.stringify(state)}\nPlanning: ${JSON.stringify(planning)}\nRequests: ${JSON.stringify(requests)}\nDiagnostics:\n${diagnostics}`);
      }
    };
    const until = async (check: () => Promise<any>) => {
      const start = Date.now();
      while (Date.now() - start < 180000) {
        assert.deepEqual(errors, [], diagnostics);
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
      const originalHead = plain ? undefined : git(repository, 'rev-parse', 'HEAD');
      cases.set(label, { repository, kind, plain, fail });
      let initial;
      if (kind === 'planner') {
        if (fail) {
          await assert.rejects(api('plan_goal', { goal: `${label} plan a verification task`, mode: 'graph', config: config(repository) }),
            /Graph must contain at least one node/);
          assert.equal((await readFile(join(repository, 'shared.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'planner change\n');
          const attempts = await api('list_plannings', { repository });
          const configured = await api('list_plannings', { repository: config(repository).repository });
          assert.deepEqual(attempts, configured, 'ordinary and extended Windows bindings must return identical history');
          const attempt = attempts.find((item: any) => item.status === 'failed');
          assert.ok(attempt);
          const failed = await api('get_planning_snapshot', { planningId: attempt.planningId, repository });
          assert.equal(failed.phase, 'planning_failed');
          assert.ok(!requests.some(request => request.startsWith(`${label}:merger:`)), 'failed planning does not merge or roll back source');
          continue;
        }
        initial = await api('plan_goal', { goal: `${label} plan a verification task`, mode: 'graph', config: config(repository) });
        assert.equal(initial.phase, 'awaiting_approval');
        assert.equal((await readFile(join(repository, 'shared.txt'), 'utf8')).trim(), 'planner change');
        assert.equal(initial.planning.roles.merger, undefined, 'source-native planning needs no publication Merger');
      } else {
        const nodes = [{ name: 'left', task: `${label} WRITE_LEFT` }, { name: 'right', task: `${label} WRITE_RIGHT` }];
        if (kind === 'node') nodes.push({ name: 'join', task: `${label} VERIFY_RESOLUTION` });
        initial = await api('save_graph', { config: config(repository), graph: { originalGoal: label, nodes,
          edges: kind === 'node' ? [{ from: 'left', to: 'join', feedback: false },
            { from: 'right', to: 'join', feedback: false }] : [] } });
      }
      await api('control', { action: 'approve', runId: initial.runId });
      const state = await until(async () => {
        const current = await api('snapshot', { runId: initial.runId });
        if (fail) return current.nodes.join.status === 'blocked' && current;
        assert.ok(!['needs_attention', 'publication_failed', 'failed'].includes(current.phase),
          `${JSON.stringify(current)}\n${diagnostics}`);
        return current.phase === 'completed' && current;
      });
      if (kind === 'planner') assert.ok(!requests.some(request => request.startsWith(`${label}:merger:`)));
      else assert.ok(requests.includes(`${label}:merger:completed`));
      const merger = kind === 'planner' ? undefined : state.mergers[0];
      if (kind !== 'planner') {
        assert.equal(state.mergers.length, 1);
        assert.equal(merger.node, kind === 'node' ? 'merge:join' : 'merger');
        assert.equal(merger.status, fail ? 'failed' : 'completed');
        assert.notEqual(normalize(merger.worktree), normalize(repository), 'all conflict repair stays private');
        const log = await api('get_execution_output', { runId: state.runId, executionId: merger.id, full: true });
        assert.ok(log.content.includes('Completed'));
      }
      if (fail) {
        assert.equal((await readFile(join(repository, 'shared.txt'), 'utf8')).trim(), 'base');
        const privateGit = (...args: string[]) => git(merger.worktree, '--git-dir',
          normalize(privateGitDirectory(merger.worktree)), '--work-tree', normalize(merger.worktree), ...args);
        assert.ok(privateGit('diff', '--name-only', '--diff-filter=U'));
        assert.ok(privateGit('rev-parse', '--verify', 'MERGE_HEAD'));
        assert.equal(state.publication, null);
      } else {
        assert.equal((await readFile(join(repository, 'shared.txt'), 'utf8')).trim(), kind === 'planner' ? 'planner change' : 'resolved');
        if (kind !== 'publication') assert.equal(await readFile(join(repository, 'verified.txt'), 'utf8'), 'verified');
        assert.equal(state.publication.status, 'completed');
        if (kind === 'publication') {
          // The publication Merger accepts follow-ups after it settles, without
          // re-entering the publication lifecycle.
          const continued = await api('control', { runId: state.runId, action: 'continue_merger',
            node: 'merger', executionId: merger.id, instruction: `${label} CONTINUE_PUBLICATION` });
          assert.equal(continued.mergers.length, 2);
          const followUp = await until(async () => {
            const current = await api('snapshot', { runId: state.runId });
            return current.mergers.find((item: any) => item.id !== merger.id)?.status === 'completed' && current;
          });
          const attempt = followUp.mergers.find((item: any) => item.id !== merger.id);
          assert.equal(attempt.node, 'merger');
          assert.equal(attempt.sessionId, merger.sessionId);
          assert.equal(normalize(attempt.worktree), normalize(repository), 'settled publication follow-ups return to source');
          assert.equal(followUp.phase, 'completed', 'a follow-up must not re-enter publication');
          assert.equal(followUp.publication.status, 'completed');
          assert.equal(await readFile(join(repository, 'continued.txt'), 'utf8'), 'continued\n');
          if (!plain) {
            const status = git(repository, 'status', '--porcelain');
            assert.match(status, /\?\? continued\.txt/);
            assert.match(status, /shared\.txt|verified\.txt/);
          }
        }
        if (!plain) {
          assert.equal(git(repository, 'rev-parse', 'HEAD'), originalHead);
          assert.equal(git(repository, 'log', '--format=%s', `${originalHead}..HEAD`), '');
          assert.equal(git(repository, 'for-each-ref', '--format=%(refname)', 'refs/grapher'), '');
          for (const execution of state.executions) assert.throws(() => git(repository, 'cat-file', '-e', `${execution.after}^{commit}`));
          assert.ok(git(repository, 'status', '--porcelain').includes('shared.txt') || git(repository, 'status', '--porcelain').includes('verified.txt'));
        } else {
          await assert.rejects(readFile(join(repository, '.git')), /ENOENT/);
        }
      }
      if (kind === 'planner' && !fail) {
        // A revision the Planner cannot apply keeps both the old graph and its
        // source writes. Deleting a node whose result this run already published
        // is refused where the Planner can still react, so the turn ends on the
        // untouched graph instead of producing an empty one.
        await revise(`${label} FAILED_REVISION`, state.runId, repository);
        const failedState = await api('snapshot', { runId: state.runId });
        assert.deepEqual(failedState.graph, state.graph);
        assert.equal(failedState.base, state.base);
        assert.deepEqual(failedState.executions, state.executions);
        assert.equal(failedState.phase, 'completed', 'a refused revision does not re-enter execution');
        assert.equal(failedState.nodes.verify.status, 'completed', 'a published node survives the refused edit');
        // The Planner writes the user's source directly, so its own writes must
        // survive a revision that changed nothing; the next dispatch collects
        // them as that job's source.
        assert.equal((await readFile(join(repository, 'shared.txt'), 'utf8')).trim(), 'failed revision');

        // The next node receives the new source PLUS the retained parent's output.
        await revise(`${label} REVISE_SOURCE`, state.runId, repository);
        const revised = await until(async () => {
          const current = await api('snapshot', { runId: state.runId });
          assert.ok(!['needs_attention', 'publication_failed', 'failed'].includes(current.phase), JSON.stringify(current));
          return current.phase === 'completed' && current.nodes.late?.status === 'completed' && current;
        });
        assert.equal(revised.base, state.base, 'approval is immutable');
        // A plain folder whose successful publication reclaimed its snapshot
        // records the revision without a source head; the next dispatch
        // materializes from the current source files. Standard Git keeps
        // snapshotting its own repository at revision time.
        assert.ok(revised.events.some((event: any) => event.type === 'graph_revised'));
        if (!plain) {
          assert.ok(revised.events.some((event: any) => event.type === 'graph_revised' && event.source_head));
        }
        assert.equal(revised.executions.filter((execution: any) => execution.node === 'verify').length, 1);
        assert.deepEqual(revised.executions.find((execution: any) => execution.id === state.executions[0].id), state.executions[0]);
        assert.equal(await readFile(join(repository, 'late.txt'), 'utf8'), 'inherited');
        assert.equal(await readFile(join(repository, 'failed.txt'), 'utf8'), 'survived');
        assert.ok(!requests.some(request => request.startsWith(`${label}:merger:`)), 'source-only revisions need no Merger');
        if (!plain) assert.equal(git(repository, 'rev-parse', 'HEAD'), originalHead);
        else await assert.rejects(readFile(join(repository, '.git')), /ENOENT/);
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
    await new Promise<void>(completed => modelServer.close(() => completed()));
    removeSandboxMasks(join(directory, 'runtime'));
    await rm(directory, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
});
