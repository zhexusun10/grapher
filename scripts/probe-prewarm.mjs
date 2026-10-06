// Compare fresh verified CLI startup with a verified bare-Core lower bound.
// No prompts, provider requests, user credentials or native-runtime copies.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { root, source, verifyBaseline } from './pi-baseline.mjs';
import { verifyPiDependencies } from './pi-dependencies.mjs';

const runs = process.argv[2] === '--runs' ? Number(process.argv[3]) : 3;
assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 10, 'Usage: probe-prewarm.mjs [--runs 1..10]');
verifyBaseline();
verifyPiDependencies(root);
const directory = await mkdtemp(join(tmpdir(), 'grapher-prewarm-probe-'));

async function sample(kind, index) {
  const own = join(directory, `${kind}-${index}`);
  const repository = join(own, 'source');
  const agent = join(own, 'agent');
  const sessions = join(own, 'sessions');
  for (const path of [repository, agent, sessions]) await mkdir(path, { recursive: true });
  const prompt = join(own, 'system-prompt.md');
  await writeFile(prompt, 'Select serial or parallel.');
  const args = kind === 'cli' ? [join(root, 'engine/entrypoint.mjs'), '--mode', 'rpc',
    '--no-prompt-templates', '--no-themes', '--no-extensions', '--no-skills', '--no-approve',
    '--no-tools', '--no-context-files', '--model', 'openai-codex/gpt-6-sol', '--thinking', 'off',
    '--system-prompt', prompt, '--session-dir', sessions]
    : ['--import', pathToFileURL(join(source, 'packages/coding-agent/src/experimental/source-resolver.ts')).href,
      join(root, 'scripts/fixtures/prewarm-core-probe.ts')];
  const started = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: repository, detached: process.platform !== 'win32',
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, GRAPHER_ISOLATED_PI_MODELS: '1',
      GRAPHER_GLOBAL_PI_AGENT_DIR: join(own, 'global-agent'), GRAPHER_MODE: 'partition',
      GRAPHER_EXECUTION_KIND: 'source', GRAPHER_SOURCE_ALIAS: repository,
      GRAPHER_WORKSPACE_ROOT: repository, GRAPHER_ORIGINAL_ROOT: repository },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  // Observe spawn errors even while the first RPC probe is awaiting its reply.
  closed.catch(() => {});
  const pending = new Map();
  let diagnostics = '';
  child.stderr.on('data', bytes => { diagnostics += bytes; });
  const fail = error => {
    for (const callback of pending.values()) callback.reject(error);
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', (code, signal) => fail(new Error(`${kind} exited: ${code}/${signal}\n${diagnostics}`)));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const callback = pending.get(event.id);
    if (!callback) return;
    pending.delete(event.id);
    if (event.success) callback.resolve(event);
    else callback.reject(new Error(JSON.stringify(event)));
  });
  const probe = async id => {
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`${kind} RPC probe timed out\n${diagnostics}`)), 30000);
        child.stdin.write(`${JSON.stringify({ id, type: 'get_state' })}\n`, error => { if (error) reject(error); });
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  try {
    await probe('startup');
    const startupMs = performance.now() - started;
    const ready = performance.now();
    await probe('ready');
    const readyRpcMs = performance.now() - ready;
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 0, diagnostics);
    return { startupMs, readyRpcMs };
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
      await closed.catch(() => {});
    }
    lines.close();
  }
}

try {
  const samples = { cli: [], core: [] };
  for (let index = 0; index < runs; index++) {
    for (const kind of ['cli', 'core']) samples[kind].push(await sample(kind, index));
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(JSON.stringify({ platform: process.platform, node: process.version, runs,
    modelRequests: 0, coreIsProductionEquivalent: false,
    note: 'Fresh-process timings include baseline/dependency verification. Core excludes provider/auth, persisted sessions and required extension policies; it is only a lower bound, not a replacement.',
    medianMs: Object.fromEntries(Object.entries(samples).map(([kind, values]) => [kind, {
      startup: median(values.map(value => value.startupMs)), readyRpc: median(values.map(value => value.readyRpcMs)),
    }])), samples }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
