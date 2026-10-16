// Focused real pinned Pi + native Python acceptance for default environment
// discovery/binding. A fresh Git project runs a small Graph with a parallel
// branch, a serial create -> verify -> report environment chain, publication,
// and negative host/new-Run isolation checks. The deterministic localhost
// model is not evidence; backend records, snapshots, reports and the native
// environment store are. No provider credentials or network packages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { venvCreationCommand } from './fixtures/environment-native.mjs';

const root = resolve('.');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise(completed => setTimeout(completed, ms));

function nativePython() {
  for (const executable of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    try {
      return execFileSync(executable, ['-I', '-c', 'import sys,venv; print(sys.executable)'], { encoding: 'utf8' }).trim();
    } catch {}
  }
  throw new Error('A native Python with venv is required; no installation fallback');
}

function nativeShell() {
  if (process.platform !== 'win32') return '/bin/bash';
  const git = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  return join(resolve(git, '../../..'), 'bin/bash.exe');
}

// The three environment steps use only the interpreter Runtime binds.
const createProbe = [
  'import json,pathlib,sys,sysconfig,uuid',
  'marker=uuid.uuid4().hex',
  "site=pathlib.Path(sysconfig.get_paths()['purelib'])",
  'site.mkdir(parents=True,exist_ok=True)',
  "module=site/'grapher_probe.py'",
  "module.write_text('MARKER='+repr(marker)+'\\n',encoding='utf-8')",
  "record={'marker':marker,'python':sys.executable,'prefix':str(pathlib.Path(sys.prefix).resolve()),'module':str(module.resolve())}",
  "pathlib.Path('environment-probe.json').write_text(json.dumps(record,sort_keys=True),encoding='utf-8')",
  "print('PROBE_CREATED '+json.dumps(record,sort_keys=True))",
].join('\n');
const verifyProbe = [
  'import json,pathlib,sys,grapher_probe',
  "record=json.loads(pathlib.Path('environment-probe.json').read_text(encoding='utf-8'))",
  "assert grapher_probe.MARKER==record['marker'], 'probe marker mismatch'",
  "root=pathlib.Path('.venv').resolve()",
  'prefix=pathlib.Path(sys.prefix).resolve()',
  'assert prefix==root, (str(prefix),str(root))',
  'module=pathlib.Path(grapher_probe.__file__).resolve()',
  'assert root in module.parents, str(module)',
  "result={'marker':grapher_probe.MARKER,'prefix':str(prefix),'module':str(module),'python':sys.executable}",
  "pathlib.Path('reports').mkdir(exist_ok=True)",
  "pathlib.Path('reports/verify.json').write_text(json.dumps(result,sort_keys=True),encoding='utf-8')",
  "print('PROBE_VERIFIED '+json.dumps(result,sort_keys=True))",
].join('\n');
const reportProbe = verifyProbe
  .replace("pathlib.Path('reports/verify.json')", "pathlib.Path('reports/report.json')")
  .replace('PROBE_VERIFIED', 'PROBE_REPORTED');

test('default environment discovery binds one private venv across a parallel Graph and isolates new Runs', { timeout: 900000 }, async t => {
  const started = Date.now();
  const directory = await mkdtemp(join(tmpdir(), 'ge-chain-中 space-'));
  const source = join(directory, 'source 中文 space');
  const data = join(directory, 'data');
  const agent = join(directory, 'agent');
  const shell = nativeShell();
  const python = nativePython();
  const activate = process.platform === 'win32'
    ? `source '.venv/Scripts/activate' && `
    : `source '.venv/bin/activate' && `;
  let backend: ChildProcess | undefined;
  let diagnostics = ''; let modelCalls = 0;
  const failures: unknown[] = []; const commands: string[] = [];
  const modelServer = createServer(async (request, response) => {
    try {
      modelCalls++;
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const messages = JSON.parse(Buffer.concat(chunks).toString()).messages;
      const lastUser = messages.findLastIndex((message: any) => message.role === 'user');
      const prompt = JSON.stringify(messages[lastUser].content);
      const tools = messages.slice(lastUser + 1).filter((message: any) => message.role === 'tool');
      for (const result of tools) {
        const output = JSON.stringify(result.content);
        assert.doesNotMatch(output, /Native environment observation refused|Traceback|command not found|No such file or directory|AssertionError|exited with code [1-9]/i, `native tool failed: ${output.slice(-12000)}`);
      }
      let tool: { name: string; arguments: any } | undefined;
      if (tools.length === 0) {
        let command: string;
        if (prompt.includes('PREP_BRANCH')) {
          command = `node -e ${quote("const fs=require('node:fs');fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/'+process.env.GRAPHER_NODE_NAME+'.txt',process.env.GRAPHER_NODE_NAME+'\\n')")}`;
        } else if (prompt.includes('CREATE_PROBE')) {
          command = `${venvCreationCommand(python)} --without-pip && ${activate}python -c ${quote(createProbe)}`;
        } else if (prompt.includes('VERIFY_PROBE')) {
          command = `python -c ${quote(verifyProbe)}`;
        } else if (prompt.includes('REPORT_PROBE')) {
          command = `python -c ${quote(reportProbe)}`;
        } else if (prompt.includes('NOOP_ISOLATED_RUN')) {
          command = `node -e ${quote("console.log('ISOLATED_NOOP')")}`;
        } else {
          throw new Error(`Unexpected prompt ${prompt.slice(0, 500)}`);
        }
        commands.push(command);
        tool = { name: 'bash', arguments: { command } };
      }
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `chain-${modelCalls}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: 'Completed environment chain' };
      const chunk = (value: any, reason: string | null) => ({ id: 'chain', object: 'chat.completion.chunk', created: 1, model: 'chain', choices: [{ index: 0, delta: value, finish_reason: reason }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
    } catch (error) { failures.push(error); response.writeHead(500); response.end(String(error)); }
  });
  const stop = async () => {
    if (backend?.pid && backend.exitCode === null && backend.signalCode === null) {
      const exited = once(backend, 'exit'); backend.kill('SIGKILL'); await exited;
    }
  };
  try {
    await mkdir(source); await mkdir(agent);
    await writeFile(join(source, '.gitignore'), '.venv/\n.agent-home/\n.runtime-cache/\n');
    await writeFile(join(source, 'README.md'), 'Default environment discovery acceptance project.\n');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd: source, encoding: 'utf8' }).trim();
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'baseline');
    // Host Python must not see the probe before the Run creates it.
    assert.throws(() => execFileSync(python, ['-I', '-c', 'import grapher_probe'], { cwd: source, stdio: 'pipe' }), 'host Python must not import the private probe before the Run');
    await new Promise<void>(completed => modelServer.listen(0, '127.0.0.1', completed));
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'environment-chain': {
      baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`, api: 'openai-completions', apiKey: 'local-only',
      models: [{ id: 'chain', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const listener = createServer(); await new Promise<void>(completed => listener.listen(0, '127.0.0.1', completed));
    const port = (listener.address() as AddressInfo).port; await new Promise<void>(completed => listener.close(() => completed()));
    const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'backend/target');
    const built = join(target, 'debug', process.platform === 'win32' ? 'grapher.exe' : 'grapher');
    const executable = join(directory, process.platform === 'win32' ? 'grapher.exe' : 'grapher');
    await copyFile(built, executable);
    if (process.platform !== 'win32') await chmod(executable, (await stat(built)).mode & 0o777);
    const env = { ...process.env, GRAPHER_DATA_DIR: data, GRAPHER_PORT: String(port), PI_CODING_AGENT_DIR: agent,
      GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'engine-cache'), GRAPHER_WORKSPACE_PARENT: join(directory, 'workspaces'),
      GRAPHER_GLOBAL_PI_AGENT_DIR: join(directory, 'global-agent'), NODE_AGENT_MODEL: 'environment-chain/chain', NODE_AGENT_THINKING: 'off',
      VIRTUAL_ENV: 'outer-poison', CONDA_PREFIX: 'outer-poison', PYTHONPATH: 'outer-poison', PYTHONHOME: 'outer-poison', BASH_ENV: 'outer-poison',
      LOCALAPPDATA: join(directory, 'local-app-data'), USERPROFILE: join(directory, 'profile') };
    backend = spawn(executable, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    backend.stderr!.on('data', chunk => { diagnostics += chunk.toString(); });
    const api = async (command: string, body: any = {}, timeout = 120000) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([t.signal, AbortSignal.timeout(timeout)]) });
      const payload = await response.json() as any;
      if (!response.ok || payload.error) throw new Error(payload.error || response.status);
      return payload.result;
    };
    const until = async (check: () => Promise<any>, label: string) => {
      const timeout = Date.now() + 300000;
      while (Date.now() < timeout) {
        t.signal.throwIfAborted(); assert.deepEqual(failures, []);
        if (backend!.exitCode !== null || backend!.signalCode !== null) throw new Error(diagnostics);
        const result = await check(); if (result) return result; await delay(100);
      }
      throw new Error(`${label}\n${diagnostics}`);
    };
    await until(async () => { try { return await api('bootstrap', {}, 5000); } catch { return false; } }, 'backend startup');
    const graph = {
      originalGoal: 'Default environment discovery with a parallel branch and a serial create/verify/report chain',
      nodes: [
        { name: 'left', task: 'PREP_BRANCH' }, { name: 'right', task: 'PREP_BRANCH' },
        { name: 'create', task: 'CREATE_PROBE' }, { name: 'verify', task: 'VERIFY_PROBE' }, { name: 'report', task: 'REPORT_PROBE' },
      ],
      edges: [
        { from: 'left', to: 'create', feedback: false }, { from: 'right', to: 'create', feedback: false },
        { from: 'create', to: 'verify', feedback: false }, { from: 'verify', to: 'report', feedback: false },
      ],
    };
    // The post-task Planner review is accepted by its own harness; this deterministic
    // local model only speaks this Run's chain tasks, so opt the review out.
    const config = { repository: source, model: 'environment-chain/chain', thinkingLevel: 'off', maxParallel: 4, maxFeedback: 1, postTaskReview: false };
    const saved = await api('save_graph', { graph, config });
    assert.equal(saved.environmentPolicy, 'automatic-pending', 'no client environment policy is supplied');
    const runId = saved.runId;
    await api('control', { runId, action: 'approve' });
    const settled = () => until(async () => {
      const state = await api('snapshot', { runId, detail: 'metadata' });
      if (['needs_attention', 'publication_failed', 'paused'].includes(state.phase)) throw new Error(JSON.stringify(state.nodes) + '\n' + diagnostics);
      return state.phase === 'completed' && state;
    }, 'environment chain execution');
    const state = await settled();
    assert.equal(state.environmentPolicy, 'automatic-lazy');
    assert.equal(state.config.environment.discovery, true, 'automatic policy uses lazy discovery');
    assert.equal(state.config.environment.bestEffort, true, 'new Runs do not require matching parent environments');
    assert.deepEqual(state.config.environment.authority, {});
    assert.equal(state.config.environment.allowDescendant, true);
    assert.equal(state.config.environment.layout, 'fixed');
    assert.deepEqual(state.config.environment.initialize, [], 'no eager environment setup');
    assert.equal(state.executions.length, 5);
    const byNode: Record<string, any> = Object.fromEntries(state.executions.map((execution: any) => [execution.node, execution]));
    // The managed Bash delegate writes these receipts in the backend; they are
    // actual native tool observations, not model text.
    const receipts = async (execution: any) => {
      const directory = join(data, 'sessions', execution.id, 'environment-observations', execution.id);
      const names = await readdir(directory).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
      return Promise.all(names.map((name: string) => readFile(join(directory, name), 'utf8').then(JSON.parse)));
    };
    // Parallel roots actually overlap and both feed the environment chain.
    assert.notEqual(byNode.left.worktree, byNode.right.worktree, 'parallel roots use independent slots');
    assert.ok(Math.min(byNode.left.completedAt, byNode.right.completedAt) >= Math.max(byNode.left.startedAt, byNode.right.startedAt), 'left and right executions overlap in time');
    assert.ok(byNode.create.startedAt >= Math.max(byNode.left.completedAt, byNode.right.completedAt), 'the serial chain waits for both parallel roots');
    const launch = (ref: string) => readFile(join(data, 'environments', runId, 'launches', `${ref}.json`), 'utf8').then(JSON.parse);
    assert.equal((await launch(byNode.left.result.launchRef)).environment, undefined, 'ordinary parallel roots stay unbound');
    assert.equal((await launch(byNode.create.input.launchRef)).environment, undefined, 'the chain starts from the unbound baseline');
    assert.equal((await launch(byNode.create.result.launchRef)).environment.kind, 'venv');
    assert.equal((await launch(byNode.create.result.launchRef)).environment.prefix, '.venv');
    // E/L inheritance across create -> verify -> report without re-creation.
    assert.equal(byNode.verify.input.environmentRef, byNode.create.result.environmentRef);
    assert.equal(byNode.verify.input.launchRef, byNode.create.result.launchRef);
    assert.equal(byNode.verify.result.environmentRef, byNode.verify.input.environmentRef, 'verification does not fork E');
    assert.equal(byNode.report.input.environmentRef, byNode.create.result.environmentRef);
    assert.equal(byNode.report.input.launchRef, byNode.create.result.launchRef);
    const created = JSON.parse(await readFile(join(source, 'environment-probe.json'), 'utf8'));
    assert.match(created.marker, /^[0-9a-f]{32}$/);
    const createReceipts = await receipts(byNode.create);
    assert.ok(createReceipts.some((receipt: any) => receipt.created === true && receipt.prefix === '.venv' && receipt.kind === 'venv'), 'create records the observed venv creation');
    assert.ok(createReceipts.some((receipt: any) => receipt.created === false && receipt.prefix === '.venv'), 'create records the observed venv use');
    for (const name of ['verify', 'report']) {
      const observed = await receipts(byNode[name]);
      assert.ok(observed.some((receipt: any) => receipt.created === false && receipt.prefix === '.venv'), `${name} records the inherited venv use`);
      assert.ok(!observed.some((receipt: any) => receipt.created === true), `${name} must not recreate the venv`);
      const binding = JSON.parse(await readFile(join(data, 'sessions', byNode[name].id, `launch-${byNode[name].id}.json`), 'utf8'));
      assert.equal(binding.environment.prefix, '.venv', `${name} runs through the Runtime-bound venv entry`);
    }
    assert.equal(commands.filter(command => command.includes('-m venv')).length, 1, 'the venv is created exactly once');
    assert.equal(commands.filter(command => /pip install|conda (create|install)/.test(command)).length, 0, 'no package installation or network provisioning');
    assert.ok(commands.some(command => command.includes('--without-pip')), 'the venv is created without pip');
    // Reports come from real interpreter runs, not model text.
    const verifyReport = JSON.parse(await readFile(join(source, 'reports/verify.json'), 'utf8'));
    const finalReport = JSON.parse(await readFile(join(source, 'reports/report.json'), 'utf8'));
    for (const report of [verifyReport, finalReport]) {
      assert.equal(report.marker, created.marker);
      assert.ok(report.prefix.endsWith(`${sep}.venv`), `sys.prefix must be the private venv: ${report.prefix}`);
      assert.ok(report.module.includes('.venv'), `module must live in the venv: ${report.module}`);
    }
    assert.ok((await readFile(join(source, 'reports/left.txt'), 'utf8')).trim() === 'left');
    assert.ok((await readFile(join(source, 'reports/right.txt'), 'utf8')).trim() === 'right');
    // Environment scope stays in Runtime storage and out of source/Git.
    await assert.rejects(stat(join(source, '.venv')), /ENOENT/, 'the private venv is never copied to source');
    assert.doesNotMatch(git('ls-files'), /(^|\n)\.venv\//, '.venv stays outside published Git');
    assert.equal(git('status', '--porcelain'), '', 'publication leaves a clean source tree');
    const manifest = JSON.parse(await readFile(join(data, 'environments', runId, 'files', 'versions', `${byNode.create.result.environmentRef}.json`), 'utf8'));
    assert.ok(Object.keys(manifest.entries).some((name: string) => name.startsWith('.venv/') && name.endsWith('grapher_probe.py')), 'E snapshot contains the private probe only inside .venv');
    assert.ok(manifest.parents.includes(byNode.create.input.environmentRef), 'E snapshot links the unbound input');
    for (const name of ['create', 'verify', 'report']) {
      const execution = byNode[name];
      const before = JSON.parse(await readFile(join(data, 'environments', runId, 'records', `before-${execution.id}.json`), 'utf8'));
      const after = JSON.parse(await readFile(join(data, 'environments', runId, 'records', `after-${execution.id}.json`), 'utf8'));
      assert.equal(before.codeRef, execution.before);
      assert.equal(after.codeRef, execution.after);
      assert.equal(before.environmentRef, execution.input.environmentRef);
    }
    // Host Python still cannot provide the private probe.
    assert.throws(() => execFileSync(python, ['-I', '-c', 'import grapher_probe'], { cwd: source, stdio: 'pipe' }), 'host Python never provides the private probe');
    // A new Run starts unbound and never references the previous Run's E.
    const isolated = await api('save_graph', { graph: { originalGoal: 'New Run isolation', nodes: [{ name: 'plain', task: 'NOOP_ISOLATED_RUN' }], edges: [] }, config });
    await api('control', { runId: isolated.runId, action: 'approve' });
    const plain = await until(async () => {
      const check = await api('snapshot', { runId: isolated.runId, detail: 'metadata' });
      if (['needs_attention', 'publication_failed'].includes(check.phase)) throw new Error(JSON.stringify(check.nodes));
      return check.phase === 'completed' && check;
    }, 'isolation Run');
    const execution = plain.executions[0];
    assert.equal((await launch(execution.input.launchRef)).environment, undefined, 'a new Run is unbound at start');
    assert.equal((await launch(execution.result.launchRef)).environment, undefined, 'an isolated no-op Run never adopts another Run environment');
    assert.notEqual(execution.input.environmentRef, byNode.create.result.environmentRef);
    const isolatedManifest = JSON.parse(await readFile(join(data, 'environments', isolated.runId, 'files', 'versions', `${execution.result.environmentRef}.json`), 'utf8'));
    assert.ok(!Object.keys(isolatedManifest.entries).some((name: string) => name.startsWith('.venv/')), 'a new Run does not see the previous environment');
    // Reuse the existing business tasks, with no new prompt or reconciliation
    // session: a bound parent forks into a local bound and a fresh unbound task.
    const fork = await api('save_graph', { graph: { originalGoal: graph.originalGoal,
      nodes: [{ name: 'create', task: 'CREATE_PROBE' }, { name: 'left', task: 'PREP_BRANCH' }, { name: 'right', task: 'PREP_BRANCH' }],
      edges: [{ from: 'create', to: 'left', feedback: false }, { from: 'create', to: 'right', feedback: false }] }, config });
    await api('control', { runId: fork.runId, action: 'approve' });
    const forkSettled = () => until(async () => {
      const check = await api('snapshot', { runId: fork.runId, detail: 'metadata' });
      if (['needs_attention', 'publication_failed'].includes(check.phase)) throw new Error(JSON.stringify(check.nodes) + '\n' + diagnostics);
      return check.phase === 'completed' && check;
    }, 'bound fan-out and independent publication');
    const forked = await forkSettled();
    const forkNodes: Record<string, any> = Object.fromEntries(forked.executions.map((execution: any) => [execution.node, execution]));
    const forkLaunch = (ref: string) => readFile(join(data, 'environments', fork.runId, 'launches', `${ref}.json`), 'utf8').then(JSON.parse);
    assert.equal(forked.executions.length, 3, 'no added environment Agent');
    assert.equal(forked.mergers.length, 0, 'environment differences do not dispatch a Merger');
    assert.notEqual(forkNodes.left.worktree, forkNodes.right.worktree);
    assert.ok(Math.min(forkNodes.left.completedAt, forkNodes.right.completedAt) >= Math.max(forkNodes.left.startedAt, forkNodes.right.startedAt), 'bound fan-out remains parallel');
    assert.equal((await forkLaunch(forkNodes.left.input.launchRef)).environment.kind, 'venv');
    assert.equal((await forkLaunch(forkNodes.right.input.launchRef)).environment, undefined);
    assert.equal(forkNodes.right.input.inheritance.reason, 'fixed-layout-not-reusable');
    await assert.rejects(stat(join(forkNodes.right.worktree, '.venv')), /ENOENT/, 'Runtime does not copy an unportable environment');
    const descriptor = await api('result_descriptor', { runId: fork.runId });
    assert.equal(descriptor.schema, 2);
    assert.deepEqual(descriptor.entries.map((entry: any) => entry.name), ['left', 'right']);
    assert.equal(descriptor.defaultEntry, undefined, 'different environments have no guessed default');
    assert.ok(descriptor.entries.every((entry: any) => entry.result.codeRef === git('rev-parse', 'HEAD')));
    await assert.rejects(api('launch_result', { runId: fork.runId, args: [] }), /entryId/);
    const callsBeforeLaunch = modelCalls;
    const expectedProbe = JSON.parse(await readFile(join(source, 'environment-probe.json'), 'utf8'));
    const launched = await api('launch_result', { runId: fork.runId, entryId: 'left', args: ['-c', 'import grapher_probe; print(grapher_probe.MARKER)'] });
    assert.equal(launched.output.trim(), expectedProbe.marker);
    const republished = await forkSettled();
    assert.equal(republished.publishedResult.entries.length, 2);
    assert.equal(modelCalls, callsBeforeLaunch, 'entry launch and republication do not call a model');
    assert.doesNotMatch(git('ls-files'), /(^|\n)\.venv\//);
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, python, shell, modelCalls, executions: state.executions.length, fanoutExecutions: forked.executions.length,
      parallelOverlapMs: Math.min(byNode.left.completedAt, byNode.right.completedAt) - Math.max(byNode.left.startedAt, byNode.right.startedAt),
      elapsedMs: Date.now() - started }));
  } catch (error) { throw new Error(`${error}\nEnvironment chain elapsed=${Date.now() - started}ms; modelCalls=${modelCalls}; toolRequests=${commands.length}\n${diagnostics}`); }
  finally {
    await stop(); await new Promise<void>(completed => modelServer.close(() => completed()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
