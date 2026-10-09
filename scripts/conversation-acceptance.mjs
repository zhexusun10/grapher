// Full TC-01..TC-14 acceptance. Original history is read-only; all destructive
// operations use retained, reproducible copies under .grapher/acceptance/.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { chromium } from '@playwright/test';
import { workerBody } from './fixtures/conversation-acceptance-worker.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const md5 = text => createHash('md5').update(text, 'utf8').digest('hex');
const root = resolve(process.env.GRAPHER_ACCEPTANCE_DIR || `.grapher/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const source = resolve(process.env.GRAPHER_ACCEPTANCE_SOURCE || '.grapher/events.sqlite');
const target = resolve('backend/target/acceptance');
const suffix = process.platform === 'win32' ? '.exe' : '';
const executable = join(target, 'release', `grapher${suffix}`);
const benchmark = join(target, 'release', 'examples', `conversation_acceptance${suffix}`);
const evidence = { startedAt: new Date().toISOString(), platform: process.platform, machine: { cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem(), arch: process.arch, os: os.release(), node: process.version }, root, cases: {} };
const children = new Set();
const proxies = new Set();
const contexts = new Set();
let browser;
const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
const command = (file, args, extra = {}) => execFileSync(file, args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...extra });
const sql = (mode, path, ...args) => JSON.parse(command(process.env.PYTHON || 'python', ['scripts/conversation-acceptance-db.py', mode, path, ...args]));
const cargo = (...args) => command(process.execPath, ['scripts/cargo.mjs', ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
function record(id, data) {
  const entry = evidence.cases[id] ||= { status: 'passed', checks: [] };
  entry.checks.push(data);
  console.log(`${id}: PASS ${JSON.stringify(data)}`);
}
async function port() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(done => server.close(done));
  // Windows may allocate low dynamic ports. Fetch/Chromium reject SIP, X11,
  // IRC and Amanda ports even though a local HTTP server can bind them.
  const blocked = [2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080];
  return blocked.includes(value) ? port() : value;
}
async function until(check, message, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(50); }
  throw new Error(message);
}
async function stop(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const done = once(child, 'exit');
  if (process.platform === 'win32') {
    try { command('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {}
  } else process.kill(-child.pid, 'SIGKILL');
  await Promise.race([done, sleep(10_000)]);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'backend failed to stop'); children.delete(child);
}
async function backend(data, origin) {
  const apiPort = await port();
  const log = fs.createWriteStream(join(root, `${data}-backend-${apiPort}.log`));
  const child = spawn(executable, [], { detached: process.platform !== 'win32', env: { ...env, GRAPHER_DATA_DIR: join(root, data), GRAPHER_PORT: String(apiPort), GRAPHER_DEV_LAZY_PRIMARY: '1', GRAPHER_ALLOWED_ORIGINS: origin || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.stdout.pipe(log); child.stderr.pipe(log);
  child.on('exit', () => log.end());
  const api = async (name, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, detail: 'metadata', compact: true }), signal: AbortSignal.timeout(120_000) });
    const value = await response.json();
    assert.equal(response.status, 200, `${name}: ${value.error}`);
    return value.result;
  };
  await until(async () => {
    assert.equal(child.exitCode, null, 'backend exited during startup');
    assert.equal(child.signalCode, null, 'backend was killed during startup');
    try { await api('bootstrap'); return true; } catch { return false; }
  }, 'backend startup failed');
  return { child, api, apiPort };
}

async function frontend(server, delay = {}) {
  const entries = [];
  const frontPort = await port();
  const proxy = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/api/')) {
      const relative = req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
      const path = resolve('dist', relative);
      if (!path.startsWith(resolve('dist') + '/') && !path.startsWith(resolve('dist') + '\\')) { res.writeHead(404); res.end(); return; }
      try {
        const body = await readFile(path);
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(path)] || 'application/octet-stream'); res.end(body);
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || '{}'); const name = req.url.slice('/api/'.length);
    const entry = { name, runId: body.runId, executionId: body.executionId, started: Date.now(), aborted: false, completed: false };
    entries.push(entry);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) { entry.aborted = true; abort.abort(); } });
    try {
      await sleep(delay[name] || 0);
      if (abort.signal.aborted) return;
      const response = await fetch(`http://127.0.0.1:${server.apiPort}${req.url}`, { method: req.method, headers: { 'Content-Type': 'application/json' }, body: text, signal: abort.signal });
      const data = Buffer.from(await response.arrayBuffer());
      if (abort.signal.aborted) return;
      res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(data); entry.completed = true;
    } catch (error) { if (!abort.signal.aborted) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); } }
  });
  proxies.add(proxy);
  proxy.listen(frontPort, '127.0.0.1'); await once(proxy, 'listening');
  return { url: `http://127.0.0.1:${frontPort}`, entries, delay, close: () => new Promise(done => { proxies.delete(proxy); proxy.closeAllConnections(); proxy.close(done); }) };
}
async function pageFor(front, manifest, runs, label) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' });
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.addInitScript(({ repository, runs }) => {
    localStorage.setItem('grapher_projects', JSON.stringify([{ id: repository, path: repository, name: 'Acceptance', branch: 'master', clean: true, lastOpened: Date.now() }]));
    localStorage.setItem('grapher_workspace_runs', JSON.stringify({ [repository]: runs }));
    localStorage.setItem('grapher_run_labels', JSON.stringify(Object.fromEntries(runs.map(id => [id, id]))));
    localStorage.setItem('grapher_config', JSON.stringify({ repository, model: 'test', maxParallel: 1, maxFeedback: 0 }));
    window.acceptanceFrames = [];
    const sample = () => {
      const chosen = document.querySelector('button.run-item.chosen')?.dataset.runId;
      const pane = document.querySelector('.conversation-pane');
      let hidden = !pane || pane.getBoundingClientRect().width === 0 || pane.getBoundingClientRect().height === 0;
      for (let el = pane; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0.01) hidden = true;
      }
      const mismatched = [...document.querySelectorAll('[data-execution-id]')].filter(el => chosen && el.dataset.runId !== chosen).map(el => el.dataset.runId);
      if (chosen) window.acceptanceFrames.push({ time: performance.now(), chosen, blank: hidden || pane.innerText.trim().length === 0, mismatched });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { repository: manifest.repository, runs });
  const page = await context.newPage();
  const resources = { page, context, label }; contexts.add(resources);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
  const urls = new Map(); const cancelled = [];
  cdp.on('Network.requestWillBeSent', event => urls.set(event.requestId, event.request.url));
  cdp.on('Network.loadingFailed', event => { if (event.canceled) cancelled.push({ url: urls.get(event.requestId), error: event.errorText }); });
  await page.goto(front.url, { waitUntil: 'domcontentloaded' });
  await page.locator(`button[data-run-id="${runs[0]}"]`).waitFor({ timeout: 120_000 });
  return { page, context, errors, cancelled, finish: async () => {
    await page.screenshot({ path: join(root, `${label}.png`), fullPage: true });
    await context.tracing.stop({ path: join(root, `${label}.trace.zip`) });
    await context.close(); contexts.delete(resources); assert.deepEqual(errors, [], 'uncaught browser errors');
  } };
}
async function assertPageGraph(page, nodes) {
  await until(async () => await page.locator('[data-node-name]').count() === nodes.length, 'DAG topology did not render');
  assert.deepEqual((await page.locator('[data-node-name]').evaluateAll(els => els.map(el => el.dataset.nodeName))).sort(), [...nodes].sort());
}
async function chooseNode(page, name) {
  // Nodes outside the fitted viewport are still mounted by React Flow. A DOM
  // click performs the actual React onClick, without fabricating component state.
  await page.locator('[data-node-name]').evaluateAll((els, name) => {
    const node = els.find(el => el.dataset.nodeName === name); assertExists(node); node.click();
    function assertExists(value) { if (!value) throw new Error('node missing'); }
  }, name);
}
async function verifyHttpLogs(server, db, expected) {
  for (const exec of expected) {
    const response = await server.api('get_execution_output', { runId: exec.runId, executionId: exec.id, full: true });
    assert.equal(response.complete, true); assert.equal(response.totalBytes, exec.bytes); assert.equal(md5(response.content), exec.md5);
    if (exec.id === 'merge-exec') assert.ok(response.content.endsWith('\nMerger failed: unresolved fixture conflict\n'));
    const saved = sql('logs', db, exec.runId, exec.id);
    assert.equal(saved.bytes, exec.bytes); assert.equal(saved.md5, exec.md5);
    global.gc?.();
  }
}
function offlineMigrate(data) {
  return npmWithEnv(['run', 'migrate'], { GRAPHER_DATA_DIR: join(root, data) });
}
function npmWithEnv(args, extra) {
  const npmPath = process.env.npm_execpath;
  assert.ok(npmPath, 'run this harness via npm run test:conversation-acceptance');
  return command(process.execPath, [npmPath, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'inherit'] });
}

try {
  await mkdir(root, { recursive: true });
  console.log('Constructing read-only real-history copies and >=720 MiB legacy fixture...');
  const debuggingSwitch = process.env.GRAPHER_ACCEPTANCE_DEBUG_SWITCH === '1';
  const debuggingRemaining = process.env.GRAPHER_ACCEPTANCE_DEBUG_REMAINING === '1';
  const debugging = debuggingSwitch || debuggingRemaining;
  const manifest = debugging ? JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) : sql('init', root, source);
  evidence.fixtures = manifest;
  evidence.mode = debugging ? 'partial-debug-not-acceptance' : 'full';
  npmWithEnv(['run', 'build'], {});
  cargo('build', '--release', '--manifest-path', 'backend/Cargo.toml', '--no-default-features', '--features', 'fixture,acceptance', '--target-dir', target, '--bin', 'grapher', '--example', 'conversation_acceptance');
  const browserChannel = process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({ channel: browserChannel, headless: true });
  evidence.browser = { channel: browserChannel, version: browser.version() };

  for (const data of debugging ? [] : ['real', 'large']) {
    const fixture = manifest[data]; const db = fixture.path;
    sql('guards', db); const before = sql('events', db);
    const server = await backend(data);
    const front = await frontend(server, { get_execution_output: 300 });
    const view = await pageFor(front, manifest, [fixture.runId], `TC01-${data}`);
    await view.page.locator(`button[data-run-id="${fixture.runId}"]`).click();
    await assertPageGraph(view.page, fixture.nodes);
    assert.equal(front.entries.filter(e => e.name === 'get_execution_output').length, 0, 'DAG opening must not bulk-load logs');
    const snapshot = await server.api('snapshot', { runId: fixture.runId });
    const displayed = [...snapshot.executions].reverse().filter((exec, index, all) => fixture.nodes.includes(exec.node) && all.findIndex(e => e.node === exec.node) === index);
    for (const exec of displayed) {
      await chooseNode(view.page, exec.node);
      const card = view.page.locator(`[data-execution-id="${exec.id}"]`);
      await card.locator('.transcript-loading').waitFor({ state: 'visible', timeout: 30_000 });
      await until(async () => await card.getAttribute('aria-busy') === 'false' && await card.locator('.virtualized-transcript-container').count() > 0, `history ${exec.id} stayed blank`, 180_000);
      assert.ok((await card.innerText()).trim().length > 0, 'empty settled node card');
      const expected = fixture.executions.find(item => item.id === exec.id);
      if (expected?.marker) {
        // Markdown changes punctuation, not the first 20 letters of the known
        // real final reply. A generic empty-state message cannot pass this.
        const needle = expected.marker.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 20);
        await until(async () => (await card.innerText()).replace(/[^\p{L}\p{N}]/gu, '').includes(needle), `real final reply missing from node ${exec.node}`);
      }
      await view.page.screenshot({ path: join(root, `TC01-${data}-${exec.id}.png`) });
    }
    await verifyHttpLogs(server, db, fixture.executions);
    assert.deepEqual(sql('events', db), before, 'JIT updated/deleted events');
    await view.finish(); await front.close(); await stop(server.child);
    sql('unguard', db);
    record('TC-01', { data, fileBytes: sql('stats', db).fileBytes, nodes: fixture.nodes.length, browserNodesOpened: displayed.length, transcriptsVerified: fixture.executions.length, md5: 'all match', noBulkPrefetch: true });
    record('TC-14', { data, before, after: sql('events', db), rejectingUpdateDeleteTriggers: true });
  }

  const db = manifest.small.path;
  let server;
  if (!debuggingRemaining) {
  sql('guards', db); const beforeJit = sql('events', db);
  server = await backend('small');
  const exec = manifest.small.executions.find(e => e.id === 'alpha-exec');
  const pair = await Promise.all([0, 1].map(() => server.api('get_execution_output', { runId: exec.runId, executionId: exec.id, full: true })));
  assert.deepEqual(pair[0], pair[1]); assert.equal(md5(pair[0].content), exec.md5);
  const saved = sql('logs', db, exec.runId, exec.id); assert.equal(saved.bytes, exec.bytes); assert.equal(saved.md5, exec.md5);
  assert.deepEqual(sql('events', db), beforeJit);
  record('TC-10', { simultaneousHttpRequests: 2, identicalResponses: true, chunks: saved.chunks, eventsUnchanged: true });
  await verifyHttpLogs(server, db, manifest.small.executions);
  assert.deepEqual(sql('events', db), beforeJit);
  record('TC-11', { stage: 'beforeMigration', ...sql('logs', db, 'acceptance-failed', 'merge-exec') });

  const front = await frontend(server, { snapshot: 150, get_execution_output: 3000 });
  const ids = manifest.small.runs.map(run => run.id);
  const view = await pageFor(front, manifest, [...ids, manifest.small.failedRunId], 'TC08-switching');
  await view.page.locator(`button[data-run-id="${ids[0]}"]`).click();
  await view.page.locator('[data-execution-id="alpha-exec"] .transcript-loading').waitFor({ timeout: 30_000 });
  const clicked = await view.page.evaluate(async ids => {
    const times = [];
    for (let i = 0; i < 30; i++) { document.querySelector(`button[data-run-id="${ids[i % 3]}"]`).click(); times.push(performance.now()); await new Promise(done => setTimeout(done, 50)); }
    return times;
  }, ids);
  const finalId = ids[29 % 3]; const finalRun = manifest.small.runs.find(run => run.id === finalId);
  await view.page.locator(`button[data-run-id="${finalId}"].chosen`).waitFor();
  await view.page.getByText(finalRun.marker, { exact: false }).first().waitFor({ timeout: 60_000 });
  // TC-08 starts from the first 50ms switch click, after the initial terminal
  // skeleton is mounted. Bootstrap's landing-to-workbench animation is a
  // separate navigation, not a blank conversation frame during this workload.
  const allFrames = await view.page.evaluate(() => window.acceptanceFrames);
  const frames = allFrames.filter(frame => frame.time >= clicked[0]);
  await writeFile(join(root, 'TC08-frames.json'), JSON.stringify({ clicked, frames, cancelled: view.cancelled, requests: front.entries }, null, 2));
  assert.ok(frames.length > 20);
  assert.ok(frames.every(frame => !frame.blank && !frame.mismatched.length), 'blank frame or cross-run transcript');
  assert.ok(view.cancelled.some(item => item.url?.includes('/api/snapshot')), 'snapshot network abort was not observed');
  assert.ok(view.cancelled.some(item => item.url?.includes('/api/get_execution_output')), 'log network abort was not observed');
  assert.ok(front.entries.some(e => e.name === 'get_execution_output' && e.aborted), 'upstream log request not cancelled');
  await writeFile(join(root, 'TC08-frames.json'), JSON.stringify({ clicked, frames, cancelled: view.cancelled, requests: front.entries }, null, 2));
  record('TC-08', { clicks: clicked.length, intervalMs: 50, sampledFrames: frames.length, blankFrames: 0, crossedFrames: 0, abortedSnapshots: view.cancelled.filter(e => e.url?.includes('/api/snapshot')).length, abortedLogs: view.cancelled.filter(e => e.url?.includes('/api/get_execution_output')).length, finalRun: finalId });
  await view.finish(); await front.close(); await stop(server.child); sql('unguard', db);
  if (debuggingSwitch) throw new Error('Partial browser debug finished; run the full suite for acceptance');
  }

  for (const data of debuggingRemaining ? [] : ['small', 'large', 'real']) {
    const path = manifest[data].path; const before = sql('stats', path);
    const first = offlineMigrate(data); const after = sql('stats', path); const second = offlineMigrate(data);
    assert.match(second, /backfilled 0 rows, migrated 0 executions, updated 0 rows, deleted 0 output chunks/);
    assert.equal(after.outputEvents, 0); assert.equal(after.autoVacuum, 2); assert.equal(after.freePages, 0);
    if (data === 'large') {
      assert.ok(after.fileBytes < before.fileBytes * 0.5, 'uncompacted legacy DB did not shrink by >50%');
      assert.ok(after.fileBytes < manifest.large.before.fileBytes * 0.5, 'pre-JIT legacy DB did not shrink by >50%');
    }
    await writeFile(join(root, `TC03-${data}-migrate.txt`), first + '\nSECOND RUN\n' + second);
    record('TC-03', { data, before, after, preJitFileBytes: manifest[data].before.fileBytes, reductionPercentFromPreJit: 100 * (1 - after.fileBytes / manifest[data].before.fileBytes), reductionPercent: 100 * (1 - after.fileBytes / before.fileBytes), secondRunUpdatedRows: 0 });
    for (const exec of manifest[data].executions) {
      const digest = sql('logs', path, exec.runId, exec.id); assert.equal(digest.md5, exec.md5); assert.equal(digest.bytes, exec.bytes);
    }
  }

  server = await backend('small');
  const failedSnapshot = await server.api('snapshot', { runId: 'acceptance-failed' });
  assert.ok(failedSnapshot.executions.find(e => e.id === 'failed-exec').outputBytes > 0);
  await verifyHttpLogs(server, db, manifest.small.executions.filter(e => e.runId === 'acceptance-failed'));
  const failedFront = await frontend(server, { get_execution_output: 300 });
  const failedView = await pageFor(failedFront, manifest, ['acceptance-failed'], 'TC12-failed-after-restart');
  await failedView.page.locator('button[data-run-id="acceptance-failed"]').click();
  await assertPageGraph(failedView.page, ['done', 'failed', 'merger · failed']); await chooseNode(failedView.page, 'failed');
  const failedCard = failedView.page.locator('[data-execution-id="failed-exec"]');
  await until(async () => await failedCard.getAttribute('aria-busy') === 'false', 'Failed transcript did not settle');
  // The failed merger is the latest attempt, so initial auto-follow correctly
  // lands on its output. Scroll back to the preceding failed Worker, including
  // the virtualized transcript's final assistant row.
  await until(async () => {
    await failedCard.evaluate(card => {
      const parent = card.closest('.initial-query-scroll');
      parent.scrollTop += card.getBoundingClientRect().bottom - parent.getBoundingClientRect().bottom + 24;
    });
    await sleep(100);
    return await failedCard.getByText('FAILED_ONLY: failure history preserved', { exact: false }).isVisible();
  }, 'Failed Worker history was not navigable', 60_000);
  await failedView.finish(); await failedFront.close();
  record('TC-12', { backendRestarted: true, outputBytes: failedSnapshot.executions.find(e => e.id === 'failed-exec').outputBytes, browserExpandedFailedNode: true });
  record('TC-11', { stage: 'afterMigrationAndRestart', ...sql('logs', db, 'acceptance-failed', 'merge-exec') });

  // Real processes, no /bin/sh and no Windows skip. SQL triggers assert Flush
  // and final-response persistence at the exact Finished INSERT boundary.
  sql('worker-guard', db);
  const startWorker = async mode => {
    const marker = join(root, `${mode}-${Date.now()}.ready.json`);
    const config = { repository: manifest.repository, model: 'test', engine: 'pi', piCommand: process.execPath, piArgs: [resolve('scripts/fixtures/conversation-acceptance-worker.mjs'), mode, marker], maxParallel: 1, maxFeedback: 0 };
    const graph = { originalGoal: `ACCEPTANCE-${mode}`, nodes: [{ name: 'worker', task: mode }], edges: [] };
    const snapshot = await server.api('save_graph', { graph, config });
    await server.api('control', { action: 'approve', runId: snapshot.runId });
    await until(async () => fs.existsSync(marker), 'Worker never produced its stdout prefix');
    const ready = JSON.parse(await readFile(marker, 'utf8'));
    let state, execution, output;
    await until(async () => {
      state = await server.api('snapshot', { runId: snapshot.runId }); execution = state.executions[0];
      if (!execution) return false;
      output = await server.api('get_execution_output', { runId: state.runId, executionId: execution.id, full: true, limit: 1024 * 1024 });
      // A running execution pages at 1 MiB; hold bodies are smaller than that.
      return output.content.includes(`ACCEPTANCE-END|${mode}|`);
    }, 'Worker prefix was not committed');
    return { runId: snapshot.runId, executionId: execution.id, ready, before: output.content };
  };
  const flood = await startWorker('flood');
  let floodState;
  await until(async () => { floodState = await server.api('snapshot', { runId: flood.runId }); return floodState.executions[0].status === 'completed'; }, 'Flood Worker did not finish');
  const floodPage = await server.api('get_execution_output', { runId: flood.runId, executionId: flood.executionId, full: true });
  const expectedBody = workerBody('flood');
  const bodyStart = floodPage.content.indexOf('ACCEPTANCE-LINE|000000|');
  const bodyEnd = floodPage.content.indexOf('ACCEPTANCE-END|flood|50000\n') + 'ACCEPTANCE-END|flood|50000\n'.length;
  assert.equal(md5(floodPage.content.slice(bodyStart, bodyEnd)), md5(expectedBody));
  assert.ok(floodPage.content.endsWith('\n── Final response ──\nACCEPTANCE_FINAL: complete worker response 完成🚀\n'));
  assert.deepEqual(floodState.executions[0].metrics.usage, { input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 });
  const exited = floodPage.content.split('\n').filter(line => line.startsWith('{') && line.includes('grapher_process_exited')).map(line => JSON.parse(line)).find(event => event.type === 'grapher_process_exited');
  assert.equal(floodState.executions[0].metrics.durationSeconds, exited.elapsedMs / 1000);
  assert.ok(floodState.executions[0].metrics.durationSeconds > 0);
  assert.equal(floodState.executions[0].outputBytes, floodPage.totalBytes);
  assert.equal(floodPage.content.includes('\uFFFD'), false);
  const floodSaved = sql('logs', db, flood.runId, flood.executionId);
  assert.equal(floodSaved.bytes, floodPage.totalBytes); assert.equal(floodSaved.md5, md5(floodPage.content));
  record('TC-04', { runId: flood.runId, executionId: flood.executionId, finalResponseComplete: true, metrics: floodState.executions[0].metrics });
  record('TC-05', { stdoutLines: 50_000, checkedAtFinishedInsert: true, tail: 'ACCEPTANCE-END|flood|50000', bytes: floodSaved.bytes });
  record('TC-06', { stdoutMd5: md5(expectedBody), databaseMd5: floodSaved.md5, chunks: floodSaved.chunks, longChineseEmojiAnsi: true, exactSourceBytes: true });

  const failed = await startWorker('fail');
  await until(async () => (await server.api('snapshot', { runId: failed.runId })).executions[0].status === 'failed', 'Exit-13 Worker did not fail');
  const killed = await startWorker('hold');
  if (process.platform === 'win32') command('taskkill', ['/PID', String(killed.ready.pid), '/T', '/F']); else process.kill(killed.ready.pid, 'SIGKILL');
  await until(async () => (await server.api('snapshot', { runId: killed.runId })).executions[0].status === 'failed', 'Killed Worker did not settle');
  const interrupted = await startWorker('hold'); await stop(server.child);
  const interruptedBefore = sql('logs', db, interrupted.runId, interrupted.executionId);
  offlineMigrate('small');
  server = await backend('small');
  assert.equal((await server.api('snapshot', { runId: interrupted.runId })).executions[0].status, 'failed');
  for (const worker of [failed, killed, interrupted]) {
    const page = await server.api('get_execution_output', { runId: worker.runId, executionId: worker.executionId, full: true });
    assert.ok(page.content.startsWith(worker.before), 'Failure/kill lost the committed prefix');
    const mode = worker === failed ? 'fail' : 'hold';
    const begin = page.content.indexOf('ACCEPTANCE-LINE|000000|'); const end = page.content.indexOf(`ACCEPTANCE-END|${mode}|5000\n`) + `ACCEPTANCE-END|${mode}|5000\n`.length;
    assert.equal(md5(page.content.slice(begin, end)), md5(workerBody(mode)));
    assert.equal(sql('logs', db, worker.runId, worker.executionId).md5, md5(page.content));
  }
  assert.deepEqual(sql('logs', db, interrupted.runId, interrupted.executionId), interruptedBefore);
  record('TC-02', { naturalExitCode: 13, actualWorkerKilled: killed.ready.pid, actualBackendKilled: true, migratedAndRestarted: true, legacyFailedAlsoVerified: true, md5AllMatch: true });

  const beforeDelete = sql('stats', db);
  await server.api('snapshot', { runId: flood.runId }); // pin the Service
  await server.api('delete_run', { runId: flood.runId });
  assert.equal(sql('logs', db, flood.runId, flood.executionId).chunks, 0);
  const afterDelete = sql('stats', db);
  assert.ok(afterDelete.pageCount < beforeDelete.pageCount - 1, 'incremental_vacuum only stepped its first row');
  assert.ok(afterDelete.fileBytes < beforeDelete.fileBytes, 'WAL truncation did not shrink the physical DB');
  assert.equal(afterDelete.freePages, 0, '9 MiB deletion should be fully reclaimed within the 4096-page budget');
  let missing = false; try { await server.api('snapshot', { runId: flood.runId }); } catch { missing = true; } assert.ok(missing, 'deleted cached service resurrected');
  cargo('test', '--manifest-path', 'backend/Cargo.toml', '--features', 'fixture', '--lib', 'server::service_cache_tests');
  record('TC-07', { beforeDelete, afterDelete, logRowsForDeletedRun: 0, staleCacheRejected: true, pageCountDecreased: true });
  await stop(server.child);

  const largePerf = JSON.parse(command(benchmark, [manifest.large.path, manifest.large.runId, '50']));
  const business = sql('business', manifest.large.path, manifest.large.runId);
  const businessPerf = JSON.parse(command(benchmark, [manifest.large.path, business.runId, '100', '--checkpoint']));
  assert.equal(largePerf.logTextDeserializedBytes, 0, 'acceptance instrumentation is not enabled');
  assert.equal(businessPerf.logTextDeserializedBytes, 0);
  record('TC-09', { migratedOutputRows: 890_000, realHistoryBusinessEvents: largePerf.businessEvents, history: largePerf, business: businessPerf, allocationCountersEnabled: true, deserializedLogBytes: 0 });
  const cursorTests = cargo('test', '--manifest-path', 'backend/Cargo.toml', '--features', 'fixture', '--test', 'store_optimization', 'utf8_paging_and_interleaved_cursors_survive_reopen_and_cascade_deletion');
  assert.match(cursorTests, /1 passed; 0 failed/);
  record('TC-13', { multiExecutionInterleaving: true, utf8BoundaryOffsets: true, databaseCursorRecovery: true, maxOffsetEqualsLiveBuffer: true });
  const finalSource = sql('identity', source);
  assert.deepEqual(finalSource, manifest.source, 'source DB file, tables or events changed during acceptance');
  evidence.originalSourceUnchanged = true;
  if (debugging) throw new Error('Partial debug finished; run the full suite for acceptance');
  for (let i = 1; i <= 14; i++) assert.equal(evidence.cases[`TC-${String(i).padStart(2, '0')}`]?.status, 'passed', 'missing acceptance case');
  evidence.completedAt = new Date().toISOString(); evidence.durationSeconds = (Date.now() - Date.parse(evidence.startedAt)) / 1000; evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error.stack || error); console.error(evidence.error); process.exitCode = 1;
} finally {
  for (const { page, context, label } of contexts) {
    try { await page.screenshot({ path: join(root, `${label}-failure.png`), fullPage: true }); } catch {}
    try { await context.tracing.stop({ path: join(root, `${label}-failure.trace.zip`) }); } catch {}
  }
  await browser?.close();
  for (const proxy of proxies) { proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); }
  for (const child of children) await stop(child);
  await writeFile(join(root, 'report.json'), JSON.stringify(evidence, null, 2));
  console.log(`Acceptance evidence: ${join(root, 'report.json')}`);
}
