// Current-format acceptance. Every Run is created through the fixture backend;
// all mutations are confined to a fresh evidence directory. No user DB is read.
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
import { privateGraph } from './fixtures/current-run.mjs';
import { createTemporaryTarget } from './temporary-target.mjs';

const root = resolve(process.env.GRAPHER_ACCEPTANCE_DIR || `.grapher/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const repository = join(root, 'repo');
const data = join(root, 'data');
const db = join(data, 'events.sqlite');
const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const report = { format: 1, startedAt: new Date().toISOString(), platform: process.platform, node: process.version, root, checks: [] };
const children = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const md5 = text => createHash('md5').update(text, 'utf8').digest('hex');
const command = (file, args, extra = {}) => execFileSync(file, args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...extra });
const sql = (operation, ...args) => JSON.parse(command(python, ['scripts/conversation-acceptance-db.py', operation, db, ...args]));
const cargo = (...args) => command(process.execPath, ['scripts/cargo.mjs', ...args], { stdio: 'inherit' });
const record = (name, evidence) => { report.checks.push({ name, ...evidence }); console.log(`PASS ${name}`); };
let target, executable, browser, proxy;

async function port() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return [2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080].includes(value) ? port() : value;
}
async function until(check, message, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(50); }
  throw new Error(message);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (process.platform === 'win32') command('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  await Promise.race([exited, sleep(10_000)]);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'backend failed to stop');
  children.delete(child);
}
async function backend() {
  const apiPort = await port();
  const log = fs.createWriteStream(join(root, `backend-${apiPort}.log`));
  const child = spawn(executable, [], { detached: process.platform !== 'win32', env: { ...env,
    GRAPHER_DATA_DIR: data, GRAPHER_PORT: String(apiPort), GRAPHER_DEV_LAZY_PRIMARY: '1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.stdout.pipe(log); child.stderr.pipe(log); child.on('exit', () => log.end());
  const api = async (name, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/${name}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, detail: 'metadata', compact: true }),
      signal: AbortSignal.timeout(120_000) });
    const value = await response.json();
    assert.equal(response.status, 200, `${name}: ${value.error}`);
    if (value.error) throw new Error(value.error);
    return value.result;
  };
  await until(async () => {
    assert.equal(child.exitCode, null, 'backend exited during startup');
    assert.equal(child.signalCode, null, 'backend was killed during startup');
    try { await api('bootstrap'); return true; } catch { return false; }
  }, 'backend startup failed');
  return { child, api, apiPort };
}
async function startWorker(server, mode) {
  const marker = join(root, `${mode}-${Date.now()}.ready.json`);
  const config = { repository, model: 'fixture/model', engine: 'pi', piCommand: process.execPath,
    piArgs: [resolve('scripts/fixtures/conversation-acceptance-worker.mjs'), mode, marker],
    maxParallel: 2, maxFeedback: 0, autoApprove: false, postTaskReview: false };
  const graph = { originalGoal: `ACCEPTANCE-${mode}`, nodes: [{ id: 'worker', task: mode }], edges: [] };
  const state = await server.api('save_graph', { graph, config });
  await server.api('control', { action: 'approve', runId: state.runId });
  await until(() => fs.existsSync(marker), 'worker did not write its stdout prefix');
  const ready = JSON.parse(await readFile(marker, 'utf8'));
  let execution, output;
  await until(async () => {
    execution = (await server.api('snapshot', { runId: state.runId })).executions[0];
    if (!execution) return false;
    output = await server.api('get_execution_output', { runId: state.runId, executionId: execution.id, full: true, limit: 1024 * 1024 });
    return output.content.includes(`ACCEPTANCE-END|${mode}|`);
  }, 'stdout prefix was not committed');
  return { runId: state.runId, executionId: execution.id, mode, ready, before: output.content };
}
async function verifyLog(server, worker, mode) {
  const page = await server.api('get_execution_output', { runId: worker.runId, executionId: worker.executionId, full: true });
  const start = page.content.indexOf('ACCEPTANCE-LINE|000000|');
  const marker = `ACCEPTANCE-END|${mode}|${mode === 'flood' ? 50000 : 5000}\n`;
  const end = page.content.indexOf(marker) + marker.length;
  assert.ok(start >= 0 && end > start);
  assert.equal(md5(page.content.slice(start, end)), md5(workerBody(mode)));
  assert.equal(page.content.includes('\uFFFD'), false);
  assert.equal(page.startOffset, 0);
  assert.equal(page.nextOffset, page.totalBytes);
  const saved = sql('logs', worker.runId, worker.executionId);
  assert.equal(saved.md5, md5(page.content));
  assert.equal(saved.bytes, page.totalBytes);
  return { page, saved };
}
async function browserChecks(server, workers) {
  proxy = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) {
        let body = ''; for await (const chunk of req) body += chunk;
        const response = await fetch(`http://127.0.0.1:${server.apiPort}${req.url}`, {
          method: req.method, headers: { 'Content-Type': 'application/json' }, body,
        });
        res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(Buffer.from(await response.arrayBuffer()));
      } else {
        const path = resolve('dist', req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0].slice(1));
        if (!path.startsWith(resolve('dist') + '/') && !path.startsWith(resolve('dist') + '\\')) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(path)] || 'application/octet-stream');
        res.end(await readFile(path));
      }
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  const frontPort = await port(); proxy.listen(frontPort, '127.0.0.1'); await once(proxy, 'listening');
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium') });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' });
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.addInitScript(repository => {
    localStorage.setItem('grapher_projects', JSON.stringify([{ id: repository, path: repository, name: 'Acceptance', branch: 'main', clean: true, lastOpened: Date.now() }]));
  }, repository);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(`http://127.0.0.1:${frontPort}`, { waitUntil: 'domcontentloaded' });
    for (const worker of workers) {
      await page.locator(`button[data-run-id="${worker.runId}"]`).click();
      await until(async () => (await page.locator('[data-node-id="worker"]').count()) === 1, 'current graph did not render');
      await page.locator('[data-node-id="worker"]').click();
      await page.locator(`[data-execution-id="${worker.executionId}"]`).waitFor();
      assert.equal(await page.locator(`[data-execution-id="${worker.executionId}"]`).getAttribute('data-run-id'), worker.runId);
      await page.locator(`[data-execution-id="${worker.executionId}"]`).getByText(
        worker.mode === 'flood' ? 'ACCEPTANCE_FINAL' : `ACCEPTANCE-END|${worker.mode}|5000`, { exact: false }).last().waitFor();
    }
    for (let index = 0; index < 12; index++) {
      await page.locator(`button[data-run-id="${workers[index % workers.length].runId}"]`).click();
      await sleep(50);
    }
    const last = workers[11 % workers.length];
    await page.locator('[data-node-id="worker"]').click();
    await page.locator(`[data-execution-id="${last.executionId}"]`).waitFor();
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(root, 'current-history.png'), fullPage: true });
    record('browser current graph, failed history and conversation switching', { runs: workers.length, switches: 12 });
  } finally { await context.tracing.stop({ path: join(root, 'current-history.trace.zip') }); await context.close(); }
}

try {
  assert.ok(!fs.existsSync(root) || fs.readdirSync(root).length === 0, 'Use a new empty acceptance directory');
  await mkdir(repository, { recursive: true });
  command('git', ['init', '-q', repository]);
  command('git', ['-C', repository, 'config', 'user.name', 'Acceptance']);
  command('git', ['-C', repository, 'config', 'user.email', 'acceptance@example.invalid']);
  await writeFile(join(repository, 'README.md'), '# Disposable acceptance project\n');
  command('git', ['-C', repository, 'add', '.']); command('git', ['-C', repository, 'commit', '-qm', 'fixture']);
  target = await createTemporaryTarget({ env }); env.CARGO_TARGET_DIR = target.directory;
  cargo('build', '--manifest-path', 'backend/Cargo.toml', '--no-default-features', '--features', 'fixture', '--bin', 'grapher');
  executable = join(target.directory, 'debug', `grapher${process.platform === 'win32' ? '.exe' : ''}`);
  for (const name of ['store_optimization', 'load_allocation']) {
    cargo('test', '--manifest-path', 'backend/Cargo.toml', '--no-default-features', '--features', 'fixture', '--test', name);
    record(name, { currentFormat: true });
  }
  let server = await backend();
  const admission = await privateGraph(server.api, data, {
    graph: { originalGoal: 'current private admission', nodes: [{ id: 'probe', task: 'probe' }], edges: [] },
    config: { repository, model: 'fixture/model', autoApprove: false, maxParallel: 2, postTaskReview: false },
  });
  await server.api('delete_run', { runId: admission.runId });
  record('current private fixture admission', { runId: admission.runId });
  sql('worker-guard');
  const flood = await startWorker(server, 'flood');
  await until(async () => (await server.api('snapshot', { runId: flood.runId })).executions[0].status === 'completed', 'flood worker did not finish');
  const { page: floodPage, saved } = await verifyLog(server, flood, 'flood');
  assert.ok(floodPage.content.endsWith('\n── Final response ──\nACCEPTANCE_FINAL: complete worker response 完成🚀\n'));
  record('stdout tail, UTF-8 and atomic terminal commit', saved);
  const failed = await startWorker(server, 'fail');
  await until(async () => (await server.api('snapshot', { runId: failed.runId })).executions[0].status === 'failed', 'failed worker did not settle');
  const killed = await startWorker(server, 'hold');
  if (process.platform === 'win32') command('taskkill', ['/PID', String(killed.ready.pid), '/T', '/F']); else process.kill(killed.ready.pid, 'SIGKILL');
  await until(async () => (await server.api('snapshot', { runId: killed.runId })).executions[0].status === 'failed', 'killed worker did not settle');
  const interrupted = await startWorker(server, 'hold'); await stop(server.child); server = await backend();
  for (const worker of [failed, killed, interrupted]) {
    const { page } = await verifyLog(server, worker, worker === failed ? 'fail' : 'hold');
    assert.ok(page.content.startsWith(worker.before), 'restart lost committed log bytes');
    assert.equal((await server.api('snapshot', { runId: worker.runId })).executions[0].status, worker === interrupted ? 'paused' : 'failed');
  }
  record('failure, worker termination and backend restart', { preservedLogs: 3 });
  const before = sql('events'); sql('guards');
  const [first, second] = await Promise.all([verifyLog(server, flood, 'flood'), verifyLog(server, flood, 'flood')]);
  assert.equal(first.saved.md5, second.saved.md5); assert.deepEqual(sql('events'), before); sql('unguard');
  record('concurrent reads preserve append-only history', before);
  const npm = process.env.npm_execpath; assert.ok(npm, 'Run via npm run test:conversation-acceptance');
  command(process.execPath, [npm, 'run', 'build'], { stdio: 'inherit' });
  await browserChecks(server, [flood, failed, interrupted]);
  await server.api('delete_run', { runId: flood.runId });
  assert.equal(sql('logs', flood.runId, flood.executionId).chunks, 0);
  await assert.rejects(server.api('history', { runId: flood.runId }));
  record('deletion reclaims logs and rejects stale history', { runId: flood.runId });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack || String(error); process.exitCode = 1; }
finally {
  await browser?.close();
  if (proxy) await new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); });
  for (const child of children) await stop(child);
  await target?.cleanup();
  if (fs.existsSync(root)) await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
}
if (report.error) console.error(report.error);
