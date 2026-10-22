// Manual acceptance for files-only Graph delivery against a production backend,
// pinned Pi, native tools and real Git. Only provider responses are local.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const directory = await mkdtemp(join(tmpdir(), 'grapher-files-only-acceptance-'));
const agent = join(directory, 'agent');
const target = resolve(process.env.CARGO_TARGET_DIR || 'backend/target');
const executable = join(target, 'debug', `grapher${process.platform === 'win32' ? '.exe' : ''}`);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@localhost',
  '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let backend, diagnostics = '', port;
const errors = [], calls = [], cases = new Map(), evidence = [];
const model = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const messages = body.messages;
    const text = messages.filter(m => ['system', 'user'].includes(m.role)).map(m => JSON.stringify(m.content)).join('\n');
    const label = [...cases.keys()].find(label => text.includes(label));
    assert.ok(label, 'provider request must belong to this acceptance');
    const scenario = cases.get(label);
    const planner = body.tools?.some(t => t.function.name === 'node');
    const merger = !planner && text.includes('Your sole responsibility is Git conflict repair');
    const lastUser = messages.findLastIndex(m => m.role === 'user');
    const results = messages.slice(lastUser + 1).filter(m => m.role === 'tool');
    assert.ok(results.every(result => !JSON.stringify(result.content).includes('exited with code')), JSON.stringify(results));
    let tool;
    if (planner) {
      if (!results.length) tool = { name: 'bash', arguments: { command: 'printf planned > planner.txt' } };
      if (results.length === 1) tool = { name: 'node', arguments: { nodes: [
        { name: 'alpha', task: `${label} WRITE_ALPHA` }, { name: 'beta', task: `${label} WRITE_BETA` },
        { name: 'join', task: `${label} JOIN_BRANCHES` }, { name: 'tail', task: `${label} WRITE_TAIL` },
      ] } };
      if (results.length === 2) tool = { name: 'edge', arguments: { edges: [{ from: 'alpha', to: 'join' }, { from: 'beta', to: 'join' }] } };
    } else if (merger) {
      // Fail the first repair without staging anything. A real unresolved Git
      // merge must become publication_failed, never fabricated completion.
      if (scenario.failFirst && !scenario.failed) scenario.failed = true;
      else if (!results.length) tool = { name: 'bash', arguments: { command:
        'test -n "$(git diff --name-only --diff-filter=U)" && printf "left\\nright\\n" > shared.txt && git add -f shared.txt' } };
    } else if (!results.length) {
      const projectView = 'test -d .git && test -z "$(git for-each-ref --format="%(refname)" refs/grapher/)" && test "$(git branch --show-current)" != grapher-node && ';
      const command = text.includes('WRITE_ALPHA') ? 'printf alpha > alpha.txt'
        : text.includes('WRITE_BETA') ? 'printf beta > beta.txt'
        : text.includes('WRITE_TAIL') ? 'printf tail > tail.txt'
        : text.includes('JOIN_BRANCHES') ? 'test "$(cat alpha.txt)" = alpha && test "$(cat beta.txt)" = beta && printf joined > joined.txt'
        : text.includes('WRITE_LEFT') ? 'printf "left\\n" > shared.txt'
        : text.includes('WRITE_RIGHT') ? 'printf "right\\n" > shared.txt'
        : text.includes('VERIFY_MERGED') ? 'test "$(wc -l < shared.txt)" = 2 && printf verified > verified.txt'
        : undefined;
      assert.ok(command, `unknown task: ${text}`);
      tool = { name: 'bash', arguments: { command: projectView + command } };
    }
    calls.push({ label, role: planner ? 'planner' : merger ? 'merger' : 'node', tool: tool?.name || null });
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${calls.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: 'assistant', content: 'Acceptance task completed.' };
    const chunk = (delta, finish_reason) => ({ id: 'acceptance', object: 'chat.completion.chunk', created: 1,
      model: 'native', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
  } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(String(error)); }
});
const api = async (command, body = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const value = await response.json();
  if (!response.ok || value.error) throw Error(`${command}: ${value.error || response.status}\n${diagnostics}`);
  return value.result;
};
const until = async callback => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, []);
    if (backend?.exitCode !== null) throw Error(`backend exited: ${diagnostics}`);
    const result = await callback();
    if (result) return result;
    await pause(100);
  }
  throw Error(`acceptance timed out\n${diagnostics}`);
};
const stopOwnedBackend = async () => {
  if (backend && backend.exitCode === null) {
    const exited = once(backend, 'exit');
    backend.kill('SIGKILL'); // Only this harness's child, never an existing service.
    await exited;
  }
};
let env;
const start = async () => {
  backend = spawn(executable, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  backend.stderr.on('data', bytes => { diagnostics += bytes.toString(); });
  await until(async () => { try { return await api('bootstrap'); } catch { return false; } });
};
const config = repository => ({ repository, model: 'files-only-acceptance/native', thinkingLevel: 'off',
  maxParallel: 3, maxFeedback: 1, postTaskReview: false, environment: null });
const waitPhase = (runId, phase) => until(async () => {
  const state = await api('snapshot', { runId });
  if (state.phase === phase) return state;
  assert.ok(!['needs_attention', 'failed', ...(phase === 'completed' ? ['publication_failed'] : [])].includes(state.phase), JSON.stringify(state));
  return false;
});
const verify = (repository, original, state, before) => {
  const head = git(repository, 'rev-parse', 'HEAD');
  assert.equal(head, original, 'publication must not advance source HEAD');
  assert.equal(state.publication.status, 'completed');
  assert.equal(git(repository, 'for-each-ref', '--format=%(refname)', 'refs/grapher'), '');
  assert.equal(git(repository, 'rev-parse', 'HEAD'), original);
  assert.equal(git(repository, 'diff', '--cached', '--name-only'), before.indexStaged);
  assert.notEqual(git(repository, 'status', '--porcelain'), '', 'delivered files remain uncommitted');
  const objects = git(repository, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)');
  const commits = objects.split('\n').filter(line => line.endsWith(' commit')).map(line => line.split(' ')[0]);
  assert.deepEqual(new Set(commits), new Set([original]), 'no internal commit object may enter the user database');
  for (const execution of state.executions) if (execution.after && execution.after !== original)
    assert.ok(!commits.includes(execution.after), 'node result must remain private');
  evidence.push({ repository, original, head, runId: state.runId, phase: state.phase, commitCount: commits.length,
    nodeCount: state.executions.length, mergerCount: state.mergers.length, log: git(repository, 'log', '--oneline', '--all') });
};
try {
  await mkdir(agent);
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'files-only-acceptance': {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'local-acceptance-only',
    models: [{ id: 'native', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  env = { ...process.env, GRAPHER_DATA_DIR: join(directory, 'data'), GRAPHER_PORT: String(port),
    GRAPHER_CACHE_DIR: join(directory, 'cache'), GRAPHER_WORKSPACE_PARENT: join(directory, 'workspaces'),
    GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'runtime'), PI_CODING_AGENT_DIR: agent, GRAPHER_ISOLATED_PI_MODELS: '1' };
  for (const role of ['PLANNER', 'PARTITIONER', 'NODE_AGENT', 'MERGER']) {
    env[`${role}_MODEL`] = 'files-only-acceptance/native'; env[`${role}_THINKING`] = 'off';
  }
  await start();
  for (const label of ['PLANNED_PARALLEL', 'PUBLICATION_RETRY', 'NODE_FANIN']) {
    const repository = join(directory, `${label} 项目`);
    await mkdir(repository);
    await writeFile(join(repository, 'shared.txt'), 'base\n');
    git(repository, 'init', '-q'); git(repository, 'add', '-A'); git(repository, 'commit', '-qm', 'initial');
    const original = git(repository, 'rev-parse', 'HEAD');
    const before = { commits: git(repository, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'),
      indexStaged: git(repository, 'diff', '--cached', '--name-only') };
    cases.set(label, { repository, failFirst: label === 'PUBLICATION_RETRY', failed: false });
    let initial;
    if (label === 'PLANNED_PARALLEL') {
      await writeFile(join(repository, 'user.txt'), 'staged\n'); git(repository, 'add', 'user.txt');
      await writeFile(join(repository, 'user.txt'), 'unstaged latest\n');
      before.indexStaged = git(repository, 'diff', '--cached', '--name-only');
      before.commits = git(repository, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)');
      initial = await api('plan_goal', { goal: `${label} implement parallel branches, join them and deliver an independent tail`, mode: 'graph', config: config(repository) });
      assert.equal(await readFile(join(repository, 'planner.txt'), 'utf8'), 'planned');
      assert.equal(git(repository, 'rev-parse', 'HEAD'), original, 'Planner snapshots must not advance source HEAD');
      assert.equal(git(repository, 'show', ':user.txt'), 'staged', 'snapshot must preserve the real source index');
    } else {
      const nodes = [{ name: 'left', task: `${label} WRITE_LEFT` }, { name: 'right', task: `${label} WRITE_RIGHT` }];
      if (label === 'NODE_FANIN') nodes.push({ name: 'join', task: `${label} VERIFY_MERGED` });
      initial = await api('save_graph', { config: config(repository), graph: { originalGoal: label, nodes,
        edges: label === 'NODE_FANIN' ? [{ from: 'left', to: 'join', feedback: false }, { from: 'right', to: 'join', feedback: false }] : [] } });
    }
    console.log(`[acceptance] ${label}: approving ${initial.runId}`);
    await api('control', { action: 'approve', runId: initial.runId });
    if (label === 'PUBLICATION_RETRY') {
      const failed = await waitPhase(initial.runId, 'publication_failed');
      assert.equal(git(repository, 'rev-parse', 'HEAD'), original);
      assert.equal(await readFile(join(repository, 'shared.txt'), 'utf8'), 'base\n');
      assert.throws(() => git(repository, 'rev-parse', '--verify', 'MERGE_HEAD'));
      await writeFile(join(directory, 'failed-snapshot.json'), JSON.stringify(failed, null, 2));
      await stopOwnedBackend();
      await start();
      assert.equal((await api('snapshot', { runId: initial.runId })).phase, 'publication_failed');
      await api('control', { action: 'retry_publication', runId: initial.runId });
    }
    const state = await waitPhase(initial.runId, 'completed');
    verify(repository, original, state, before);
    await writeFile(join(directory, `${label}-snapshot.json`), JSON.stringify(state, null, 2));
    if (label === 'PLANNED_PARALLEL') {
      assert.equal(await readFile(join(repository, 'joined.txt'), 'utf8'), 'joined');
      assert.equal(await readFile(join(repository, 'tail.txt'), 'utf8'), 'tail');
      assert.equal(git(repository, 'show', ':user.txt'), 'staged');
      assert.equal((await readFile(join(repository, 'user.txt'), 'utf8')).trim(), 'unstaged latest');
    } else assert.equal((await readFile(join(repository, 'shared.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'left\nright\n');
    const deliveredHead = git(repository, 'rev-parse', 'HEAD');
    await api('control', { action: 'resume', runId: initial.runId });
    await waitPhase(initial.runId, 'completed');
    assert.equal(git(repository, 'rev-parse', 'HEAD'), deliveredHead, 'settle/resume must not publish twice');
    assert.equal(git(repository, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'), before.commits, 'settle/resume must not add Git objects');
    console.log(`[acceptance] ${label}: PASS; ${deliveredHead}; files only, no new commit`);
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify({ status: 'passed', executable, directory, evidence, calls }, null, 2));
  console.log(`[acceptance] PASS. Evidence retained: ${directory}`);
} catch (error) {
  await writeFile(join(directory, 'failure.txt'), `${error.stack || error}\n${diagnostics}\n${JSON.stringify(errors)}`);
  console.error(`[acceptance] FAILED. Evidence retained: ${directory}`);
  throw error;
} finally {
  await stopOwnedBackend();
  await new Promise(resolve => model.close(resolve));
  await writeFile(join(directory, 'backend.log'), diagnostics);
}
