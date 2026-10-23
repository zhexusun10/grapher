// Real end-to-end graph run through the browser UI, the production backend,
// real Git and the real configured provider model. Unlike accept-ui-headless.mjs
// the model responses are NOT mocked: the UI drives planning and execution
// against the user's configured provider.
//
// The harness owns its own backend on an unused port, isolated data/cache dirs
// and a throwaway project repository. It never touches an existing service.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { createServer as createVite } from 'vite';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const label = process.env.ACCEPT_LABEL || 'graph';
const stopMode = process.env.ACCEPT_STOP === '1';
const goal = process.env.ACCEPT_GOAL
  || (stopMode
    ? 'Run the shell command `sleep 900` in the project root and wait for it to finish. Do not create or modify any files.'
    : 'Create two independent files: alpha.txt containing the single word alpha, and beta.txt containing the single word beta.');
const model = process.env.ACCEPT_MODEL || 'antigravity/gemini-3.8-flash-tiered';
const thinkingLevel = process.env.ACCEPT_THINKING || 'high';
const timeoutMs = Number(process.env.ACCEPT_TIMEOUT_MS || 900000);

const directory = await mkdtemp(join(tmpdir(), 'grapher-ui-graph-'));
const repository = join(directory, 'project');
const target = resolve(process.env.CARGO_TARGET_DIR || 'backend/target');
const executable = join(target, 'debug', `grapher${process.platform === 'win32' ? '.exe' : ''}`);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@localhost',
  '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

let backend, vite, browser, diagnostics = '', port, origin;
const errors = [];
const monitor = process.env.ACCEPT_MONITOR === '1';
let monitorTimer;
const observe = detail => console.log(`[${label}][ui] ${detail}`);

const api = async (command, body = {}, timeout = timeoutMs) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const value = await response.json();
  if (!response.ok || value.error) throw Error(`${command}: ${value.error || response.status}\n${diagnostics}`);
  return value.result;
};
const until = async (callback, deadlineMs = timeoutMs) => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (backend?.exitCode !== null && backend?.exitCode !== undefined) throw Error(`backend exited: ${diagnostics}`);
    const result = await callback();
    if (result) return result;
    await pause(200);
  }
  throw Error(`acceptance timed out\n${diagnostics}`);
};

try {
  await mkdir(repository);
  git(repository, 'init', '-q');
  await writeFile(join(repository, 'base.txt'), 'base\n');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'initial');
  const original = git(repository, 'rev-parse', 'HEAD');

  const listener = createHttp();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));

  process.env.GRAPHER_PORT = String(port);
  vite = await createVite({ cacheDir: 'node_modules/.vite-ui-graph',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false, hmr: false } });
  await vite.listen();
  origin = `http://127.0.0.1:${vite.httpServer.address().port}`;

  // No PI_CODING_AGENT_DIR override and no GRAPHER_ISOLATED_PI_MODELS: the real
  // configured provider is used. Strip the harness's own control variables so
  // the model's `env` cannot discover the harness goal/install path.
  const env = { ...process.env, GRAPHER_DATA_DIR: join(directory, 'data'), GRAPHER_PORT: String(port),
    GRAPHER_CACHE_DIR: join(directory, 'cache'), GRAPHER_WORKSPACE_PARENT: join(directory, 'workspaces'),
    GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'runtime'), GRAPHER_ALLOWED_ORIGINS: origin };
  delete env.GRAPHER_ISOLATED_PI_MODELS;
  for (const key of Object.keys(env)) if (key.startsWith('ACCEPT_')) delete env[key];

  backend = spawn(executable, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  backend.stderr.on('data', bytes => { diagnostics += bytes.toString(); });
  await until(async () => { try { return await api('bootstrap'); } catch { return false; } }, 60000);

  const config = { repository, model, thinkingLevel, maxParallel: 2,
    maxFeedback: 1, autoApprove: true, postTaskReview: process.env.ACCEPT_POST_TASK_REVIEW === '1', plannerWriteTools: false, environment: null };
  await api('save_config', { config });

  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  await context.addInitScript(() => { try { localStorage.setItem('grapher_plan_mode', 'graph'); } catch {} });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`pageerror: ${error}`));
  page.on('console', message => { if (message.type() === 'error') console.log(`[${label}][ui] console-error: ${message.text()}`); });
  page.on('requestfailed', request => {
    const error = request.failure()?.errorText || '';
    const designedTeardown = request.url().includes('/api/events') ||
      (request.url().includes('/api/plan_goal_stream') && error.includes('ERR_ABORTED'));
    if (request.url().includes('/api/') && !designedTeardown) {
      errors.push(`requestfailed: ${request.method()} ${request.url()} ${error}`);
    }
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });

  const composer = page.locator('.landing-screen textarea');
  await composer.waitFor({ timeout: 60000 });
  await composer.fill(goal);
  await composer.press('Enter');

  if (monitor) {
    let previous = '';
    monitorTimer = setInterval(async () => {
      try {
        const boot = await api('bootstrap', {}, 15000);
        const runId = boot.runs?.[0];
        if (!runId) return;
        const snapshot = await api('snapshot', { runId }, 15000);
        const nodes = Object.entries(snapshot.nodes || {}).map(([name, value]) => `${name}:${value.status}`).join(',');
        const running = (snapshot.executions || []).filter(item => item.status === 'running').map(item => item.node).join(',');
        const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 220));
        const line = `phase=${snapshot.phase} nodes=[${nodes}] running=[${running}] ui="${text}"`;
        if (line !== previous) { observe(line); previous = line; }
        await page.screenshot({ path: join(directory, `monitor-${Date.now()}.png`) }).catch(() => {});
      } catch (error) { observe(`monitor-error: ${String(error)}`); }
    }, 5000);
  }

  if (stopMode) {
    const running = await until(async () => {
      const boot = await api('bootstrap', {}, 30000);
      const runId = boot.runs?.[0];
      if (!runId) return false;
      const snapshot = await api('snapshot', { runId }, 30000);
      if (snapshot.phase === 'completed') throw Error(`run finished before it could be stopped: ${JSON.stringify(snapshot.nodes)}`);
      return (snapshot.executions || []).some(item => item.status === 'running') ? snapshot : false;
    });
    await pause(Number(process.env.ACCEPT_STOP_AFTER_MS || 8000));
    await page.locator('button', { hasText: /Pause|暂停/ }).first().click();
    const settled = await until(async () => {
      const snapshot = await api('snapshot', { runId: running.runId }, 30000);
      return snapshot.paused && !(snapshot.executions || []).some(item => item.status === 'running') ? snapshot : false;
    }, 120000);
    assert.equal(settled.paused, true, 'the run must report paused after the stop');
    console.log(`[${label}] PASS; run=${settled.runId}; phase=${settled.phase}; paused=${settled.paused}; stopped a stuck node`);
    console.log(`[${label}] Evidence retained: ${directory}`);
    throw { __stopModeDone: true };
  }

  const state = await until(async () => {
    const boot = await api('bootstrap', {}, 30000);
    const runId = boot.runs?.[0];
    if (!runId) return false;
    const snapshot = await api('snapshot', { runId }, 30000);
    if (snapshot.phase === 'completed') return snapshot;
    assert.ok(!['needs_attention', 'failed', 'publication_failed'].includes(snapshot.phase),
      `run entered ${snapshot.phase}: ${JSON.stringify(snapshot.nodes)}`);
    return false;
  });

  const nodeNames = Object.keys(state.nodes || {});
  assert.equal(state.planType, 'graph', `expected a graph run, got ${state.planType}`);
  assert.equal(state.publication?.status, 'completed', 'publication must complete');
  assert.ok(nodeNames.every(name => state.nodes[name].status === 'completed'),
    `all nodes must complete: ${JSON.stringify(Object.fromEntries(nodeNames.map(n => [n, state.nodes[n].status])))}`);

  const files = git(repository, 'status', '--porcelain');
  assert.notEqual(files, '', 'delivered files remain uncommitted in the project');
  assert.equal(git(repository, 'rev-parse', 'HEAD'), original, 'publication must not advance source HEAD');
  assert.deepEqual(errors, [], 'the browser must not report page errors or failed API requests');

  console.log(`[${label}] PASS; run=${state.runId}; planType=${state.planType}; nodes=${nodeNames.join(',')}; phase=${state.phase}`);
  console.log(`[${label}] delivered: ${files.replace(/\n/g, ' | ')}`);
  console.log(`[${label}] Evidence retained: ${directory}`);

  if (process.env.ACCEPT_INSPECT_FILE) {
    const content = await readFile(join(repository, process.env.ACCEPT_INSPECT_FILE), 'utf8');
    const grapherKeys = content.split('\n').filter(line => /^GRAPHER_/.test(line));
    const dataPaths = content.split('\n').filter(line => /[\\/]data[\\/]/i.test(line));
    console.log(`[${label}] ${process.env.ACCEPT_INSPECT_FILE}: GRAPHER_*=${grapherKeys.length} data-paths=${dataPaths.length}`);
    for (const line of grapherKeys) console.log(`[${label}]   LEAK ${line.slice(0, 160)}`);
    for (const line of dataPaths) console.log(`[${label}]   DATA ${line.slice(0, 160)}`);
  }
} catch (error) {
  if (error && error.__stopModeDone) {
    // Stop-mode success already reported.
  } else {
    console.error(`[${label}] FAIL: ${error?.stack || error}`);
    if (diagnostics) console.error(diagnostics.slice(-6000));
    process.exitCode = 1;
  }
} finally {
  if (monitorTimer) clearInterval(monitorTimer);
  if (browser) await browser.close().catch(() => {});
  if (vite) await vite.close().catch(() => {});
  if (backend && backend.exitCode === null) {
    const exited = once(backend, 'exit');
    backend.kill('SIGKILL');
    await exited;
  }
}
