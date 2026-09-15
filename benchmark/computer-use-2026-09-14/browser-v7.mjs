// Browser acceptance: real planning reconnection + transport fixtures carrying
// the original long v6 traces. Fixture browsing is not model-quality evidence.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const out = path.join(import.meta.dirname, 'v7-validation');
fs.mkdirSync(out, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = { startedAt: new Date().toISOString(), errors: [], heap: [], reloads: [], pages: 0, snapshotRequests: 0 };
const save = () => fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
let server;
try {
  const live = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  if (!process.env.V7_SKIP_LIVE) {
  const submitted = [];
  live.on('request', request => { if (/\/api\/plan_goal/.test(request.url())) submitted.push(request.url()); });
  await live.goto('http://127.0.0.1:1531', { waitUntil: 'domcontentloaded' });
  await live.getByRole('status').filter({ hasText: '已连接正在进行的规划' }).waitFor({ timeout: 10000 });
  await live.locator('.planning-activity-output').waitFor();
  await live.getByRole('button', { name: 'Planner', exact: true }).click();
  await live.locator('.planning-activity-output .transcript-row').first().waitFor();
  const firstId = await live.locator('.planning-id-chip').getAttribute('title');
  await live.reload({ waitUntil: 'domcontentloaded' });
  await live.getByRole('status').filter({ hasText: '已连接正在进行的规划' }).waitFor();
  assert.equal(await live.locator('.planning-id-chip').getAttribute('title'), firstId);
  assert.equal(submitted.length, 0);
  result.liveRecovery = { samePlanningId: firstId, submittedModelRequests: submitted.length, restoredOnRefresh: true };
  await live.screenshot({ path: path.join(out, 'planning-recovery.png') });
  } else {
    result.liveRecovery = JSON.parse(fs.readFileSync(path.join(out, 'browser.json'))).liveRecovery;
  }
  await live.close(); save();

  const full = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'v6-e2e-recovery/snapshot.json')));
  const outputs = new Map([...full.executions, ...(full.mergers || [])].map(e => [e.id, Buffer.from(e.output)]));
  const metadata = structuredClone(full);
  for (const e of [...metadata.executions, ...(metadata.mergers || [])]) { e.outputBytes = Buffer.byteLength(e.output); e.output = ''; }
  metadata.events = metadata.events.filter(e => e.type !== 'output').map(e => { delete e.output; return e; });
  const cfg = full.config;
  const info = { path: cfg.repository, name: 'Atlas trace validation', clean: true, branch: 'main', head: full.publication.head, isShadow: false };
  const originalNode = 'storage_crash_audit';
  let snapshotBytes = 0, outputBytes = 0;
  server = http.createServer(async (request, response) => {
    if (request.url.startsWith('/api/')) {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), command = request.url.slice(5);
      let value;
      if (command === 'bootstrap') value = { snapshot: metadata, config: cfg, repositoryInfo: info, runs: [full.runId], dataPath: 'browser-transport-fixture' };
      else if (command === 'snapshot' || command === 'load_run' || command === 'history') { value = metadata; result.snapshotRequests++; }
      else if (command === 'list_plannings') value = [];
      else if (command === 'detect_repository') value = info;
      else if (command === 'get_execution_output') {
        assert.equal(body.runId, full.runId);
        const bytes = outputs.get(body.executionId); assert.ok(bytes);
        const offset = body.offset || 0; let end = Math.min(offset + 256 * 1024, bytes.length);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        value = { runId: full.runId, executionId: body.executionId, content: bytes.subarray(offset, end).toString('utf8'), nextOffset: end, totalBytes: bytes.length, complete: end === bytes.length, status: 'completed' };
        outputBytes += end - offset; result.pages++;
      } else if (command === 'get_planning_output') value = { content: '', nextOffset: 0, totalBytes: 0, complete: true, running: false };
      else value = null;
      const payload = JSON.stringify({ result: value });
      if (command === 'snapshot') snapshotBytes += Buffer.byteLength(payload);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(payload); return;
    }
    const filename = path.join(path.resolve(import.meta.dirname, '../../dist'), request.url === '/' ? 'index.html' : request.url);
    const type = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
    try { const bytes = fs.readFileSync(filename); response.writeHead(200, { 'Content-Type': type }); response.end(bytes); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(1540, '127.0.0.1', resolve));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => result.errors.push(String(error)));
  page.on('crash', () => result.errors.push('page crashed'));
  const cdp = await context.newCDPSession(page);
  await page.goto('http://127.0.0.1:1540', { waitUntil: 'domcontentloaded' });
  await page.getByText('已写回工作文件夹', { exact: true }).waitFor();
  assert.equal(result.pages, 0, 'No transcript fetch before selection');
  result.responseBytes = { full: Buffer.byteLength(JSON.stringify(full)), metadata: Buffer.byteLength(JSON.stringify(metadata)) };
  const selectNode = async name => {
    await page.locator('.react-flow__node').filter({ hasText: name }).click();
    await page.locator('.transcript-row').first().waitFor();
    await delay(1000);
  };
  await selectNode(originalNode);
  const scroll = page.locator('.transcript-scroll-area').first();
  const positions = [];
  for (let step = 0; step <= 20; step++) {
    await scroll.evaluate((el, fraction) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction; el.dispatchEvent(new Event('scroll')); }, step / 20);
    await delay(100);
    const observed = await scroll.evaluate(el => {
      const viewport = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll('[data-transcript-id]')].map(row => row.getBoundingClientRect());
      return { top: el.scrollTop, rendered: rows.length, intersects: rows.some(row => row.bottom >= viewport.top && row.top <= viewport.bottom) };
    });
    assert.ok(observed.intersects, JSON.stringify(observed)); positions.push(observed);
  }
  await scroll.evaluate(el => { el.scrollTop = 0; }); await delay(200);
  const tool = page.locator('.tool-call-header').first();
  await tool.click(); await delay(200);
  const expandedRow = await tool.locator('xpath=ancestor::*[@data-transcript-id]').getAttribute('data-transcript-id');
  const before = await page.locator(`[data-transcript-id="${expandedRow}"]`).evaluate(el => el.getBoundingClientRect().height);
  await tool.click(); await delay(200);
  const after = await page.locator(`[data-transcript-id="${expandedRow}"]`).evaluate(el => el.getBoundingClientRect().height);
  assert.notEqual(before, after, 'Row height must reflect expand/collapse');
  assert.ok(positions.some(position => position.top > 0), 'Must exercise a genuinely scrollable viewport');
  result.virtualization = { positions, before, after };
  await page.screenshot({ path: path.join(out, 'long-transcript.png') }); save();
  const start = Date.now(), duration = Number(process.env.V7_STRESS_SECONDS || 2400) * 1000;
  let cycle = 0;
  while (Date.now() - start < duration) {
    if (cycle % 2 === 0) {
      const started = Date.now(); await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('已写回工作文件夹', { exact: true }).waitFor();
      result.reloads.push(Date.now() - started);
    }
    await selectNode(cycle % 2 ? 'release_readiness_assessment' : originalNode);
    await cdp.send('HeapProfiler.collectGarbage');
    result.heap.push({ elapsedMs: Date.now() - start, ...await cdp.send('Runtime.getHeapUsage') });
    assert.deepEqual(result.errors, []);
    result.elapsedMs = Date.now() - start; result.snapshotBytes = snapshotBytes; result.outputBytes = outputBytes; save();
    cycle++; await delay(Math.min(30000, Math.max(0, duration - (Date.now() - start))));
  }
  result.status = 'PASS';
} catch (error) { result.status = 'FAIL'; result.error = String(error); console.error(error); process.exitCode = 1; }
finally { result.endedAt = new Date().toISOString(); save(); await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
