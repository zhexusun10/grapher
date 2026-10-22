// Real end-to-end through the browser UI, the production backend, real Git and
// the Merger. Only provider responses are local. The UI drives planning and
// execution; the backend composes two branches whose merge conflicts, and the
// real Merger resolves it before files-only publication.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { createServer as createVite } from 'vite';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const directory = await mkdtemp(join(tmpdir(), 'grapher-ui-acceptance-'));
const agent = join(directory, 'agent');
const repository = join(directory, 'project');
const target = resolve(process.env.CARGO_TARGET_DIR || 'backend/target');
const executable = join(target, 'debug', `grapher${process.platform === 'win32' ? '.exe' : ''}`);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@localhost',
  '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

let backend, vite, browser, diagnostics = '', port, origin;
const errors = [], calls = [];
const model = createHttp(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const messages = body.messages;
    const text = messages.filter(m => ['system', 'user'].includes(m.role)).map(m => JSON.stringify(m.content)).join('\n');
    const planner = body.tools?.some(t => t.function.name === 'node');
    const merger = !planner && text.includes('Your sole responsibility is Git conflict repair');
    const lastUser = messages.findLastIndex(m => m.role === 'user');
    const results = messages.slice(lastUser + 1).filter(m => m.role === 'tool');
    let tool;
    if (planner) {
      if (!results.length) tool = { name: 'bash', arguments: { command: 'printf planned > planner.txt' } };
      if (results.length === 1) tool = { name: 'node', arguments: { nodes: [
        { name: 'left', task: 'UI_E2E WRITE_LEFT' }, { name: 'right', task: 'UI_E2E WRITE_RIGHT' },
        { name: 'join', task: 'UI_E2E VERIFY_MERGED' } ] } };
      if (results.length === 2) tool = { name: 'edge', arguments: { edges: [
        { from: 'left', to: 'join' }, { from: 'right', to: 'join' } ] } };
    } else if (merger) {
      if (!results.length) tool = { name: 'bash', arguments: { command:
        'test -n "$(git diff --name-only --diff-filter=U)" && printf "left\\nright\\n" > shared.txt && git add -f shared.txt' } };
    } else if (!results.length) {
      const projectView = 'test -d .git && test -z "$(git for-each-ref --format="%(refname)" refs/grapher/)" && test "$(git branch --show-current)" != grapher-node && ';
      const command = text.includes('WRITE_LEFT') ? 'printf "left\\n" > shared.txt'
        : text.includes('WRITE_RIGHT') ? 'printf "right\\n" > shared.txt'
        : text.includes('VERIFY_MERGED') ? 'test "$(wc -l < shared.txt)" = 2 && printf verified > verified.txt'
        : undefined;
      assert.ok(command, `unknown task: ${text}`);
      tool = { name: 'bash', arguments: { command: projectView + command } };
    }
    calls.push({ role: planner ? 'planner' : merger ? 'merger' : 'node', tool: tool?.name || null });
    const delta = tool
      ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${calls.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: 'assistant', content: 'Acceptance task completed.' };
    const chunk = (d, finish) => ({ id: 'acceptance', object: 'chat.completion.chunk', created: 1, model: 'native',
      choices: [{ index: 0, delta: d, finish_reason: finish }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
  } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(String(error)); }
});

const api = async (command, body = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
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

let env;
try {
  // Real project with an initial commit.
  await mkdir(agent);
  await mkdir(repository);
  git(repository, 'init', '-q');
  await writeFile(join(repository, 'base.txt'), 'base\n');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'initial');
  const original = git(repository, 'rev-parse', 'HEAD');
  const beforeStatus = git(repository, 'status', '--porcelain');
  const beforeStaged = git(repository, 'diff', '--cached', '--name-only');

  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'ui-e2e': {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'local-acceptance-only',
    models: [{ id: 'native', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));

  const listener = createHttp();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));

  // Real frontend on Vite, proxying /api to the real backend. vite.config.ts
  // reads GRAPHER_PORT when the config is evaluated; the backend trusts the
  // Vite origin only through the explicit allowlist.
  process.env.GRAPHER_PORT = String(port);
  vite = await createVite({ cacheDir: 'node_modules/.vite-ui-acceptance',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false, hmr: false } });
  await vite.listen();
  origin = `http://127.0.0.1:${vite.httpServer.address().port}`;

  env = { ...process.env, GRAPHER_DATA_DIR: join(directory, 'data'), GRAPHER_PORT: String(port),
    GRAPHER_CACHE_DIR: join(directory, 'cache'), GRAPHER_WORKSPACE_PARENT: join(directory, 'workspaces'),
    GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'runtime'), PI_CODING_AGENT_DIR: agent,
    GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_ALLOWED_ORIGINS: origin };

  backend = spawn(executable, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  backend.stderr.on('data', bytes => { diagnostics += bytes.toString(); });
  await until(async () => { try { return await api('bootstrap'); } catch { return false; } });

  const config = { repository, model: 'ui-e2e/native', thinkingLevel: 'off', maxParallel: 2,
    maxFeedback: 1, autoApprove: true, postTaskReview: false, plannerWriteTools: false, environment: null };
  await api('save_config', { config });

  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });

  // The UI must reach the landing screen with the configured project.
  const composer = page.locator('.landing-screen textarea');
  await composer.waitFor({ timeout: 60000 });
  await composer.fill('UI_E2E conflict graph');
  await composer.press('Enter');

  // The real backend plans, auto-approves, runs the graph, and publishes. Wait
  // until a run exists and reaches a terminal phase.
  const state = await until(async () => {
    const boot = await api('bootstrap');
    const runId = boot.runs?.[0];
    if (!runId) return false;
    const snapshot = await api('snapshot', { runId });
    if (snapshot.phase === 'completed') return snapshot;
    assert.ok(!['needs_attention', 'failed', 'publication_failed'].includes(snapshot.phase), JSON.stringify(snapshot));
    return false;
  });

  // Assert the source repository is unchanged and delivery was files-only.
  assert.equal(state.publication.status, 'completed');
  assert.ok(state.mergers.length >= 1, 'the Merger must have resolved the branch conflict');
  assert.equal(git(repository, 'rev-parse', 'HEAD'), original, 'publication must not advance source HEAD');
  assert.equal(git(repository, 'for-each-ref', '--format=%(refname)', 'refs/grapher'), '');
  assert.equal(git(repository, 'diff', '--cached', '--name-only'), beforeStaged);
  assert.notEqual(git(repository, 'status', '--porcelain'), beforeStatus, 'delivered files remain uncommitted');
  const objects = git(repository, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)');
  const commits = objects.split('\n').filter(line => line.endsWith(' commit')).map(line => line.split(' ')[0]);
  assert.deepEqual(new Set(commits), new Set([original]), 'no internal commit object may enter the user database');
  assert.ok(calls.some(call => call.role === 'merger'), 'the real Merger must have run');

  console.log(`[ui-acceptance] PASS; run=${state.runId}; phase=${state.phase}; mergers=${state.mergers.length}; commits=${commits.length}`);
  console.log(`[ui-acceptance] Evidence retained: ${directory}`);
} catch (error) {
  console.error(`[ui-acceptance] FAIL: ${error?.stack || error}`);
  if (diagnostics) console.error(diagnostics.slice(-4000));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (vite) await vite.close().catch(() => {});
  if (backend && backend.exitCode === null) {
    const exited = once(backend, 'exit');
    backend.kill('SIGKILL'); // Only this harness's child, never an existing service.
    await exited;
  }
  await new Promise(resolve => model.close(resolve)).catch(() => {});
}
