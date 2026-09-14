// Real production backend + browser acceptance. Requires an installed playwright-core.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node benchmark/computer-use-2026-09-14/accept-v6.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cases, repositoryFiles } from '../planning-cases.mjs';
const repo = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(process.env.V6_EVIDENCE_DIR || path.join(import.meta.dirname, 'v6'));
const basePort = Number(process.env.V6_PORT || 1467);
fs.mkdirSync(out, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grapher-v6-')));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); };
const log = text => { console.log(text); fs.appendFileSync(path.join(out, 'progress.log'), `${new Date().toISOString()} ${text}\n`); };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const manifest = {};
for (const file of git(repo, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(f => /^(src\/|backend\/(src|resources)\/|engine\/|package|pi\/.*lock)/.test(f))) {
  if (fs.statSync(path.join(repo, file)).isFile()) manifest[file] = createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex');
}
write(path.join(out, 'source-manifest.json'), manifest);
write(path.join(out, 'source.diff'), git(repo, 'diff', 'HEAD', '--', 'src', 'scripts'));
const model = 'dashscope/qwen3.8-flash';
const metadata = { baseline: git(repo, 'rev-parse', 'HEAD'), sourceSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), root, model, thinking: 'medium', maxParallel: 2, maxFeedback: 2, roleTimeoutSeconds: 600, startedAt: new Date().toISOString(), node: process.version, backend: 'production, no fixture', evidence: 'real browser + shipping API + real Pi provider' };
write(path.join(out, 'metadata.json'), metadata);
const servers = [];
let browser;
const api = async (port, command, body = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/${command === 'plan_goal' ? 'plan_goal_stream' : command}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (command === 'plan_goal') {
    const text = await response.text();
    const events = text.split('\n\n').flatMap(block => {
      const line = block.split('\n').find(line => line.startsWith('data: '));
      return line ? [{ type: block.split('\n')[0], value: JSON.parse(line.slice(6)) }] : [];
    });
    const failure = events.find(e => e.type === 'event: error');
    if (failure) throw Error(failure.value.error);
    const done = events.findLast(e => e.type === 'event: complete');
    if (!done) throw Error('Planning stream ended without completion');
    return done.value.snapshot;
  }
  const data = await response.json();
  if (!response.ok || data.error) throw Error(data.error || String(response.status));
  return data.result;
};
const delay = ms => new Promise(r => setTimeout(r, ms));
async function setup(name, port, files) {
  const directory = path.join(root, name);
  const project = path.join(directory, 'project');
  const data = path.join(directory, 'data');
  fs.mkdirSync(project, { recursive: true });
  for (const [file, content] of Object.entries(files)) write(path.join(project, file), content);
  git(project, 'init', '-q'); git(project, 'add', '.'); git(project, '-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Acceptance baseline');
  const baseline = git(project, 'rev-parse', 'HEAD');
  const fd = fs.openSync(path.join(out, `${name}-server.log`), 'w');
  const env = { ...process.env, GRAPHER_PORT: String(port), GRAPHER_DATA_DIR: data };
  for (const role of ['PARTITIONER', 'PLANNER', 'NODE_AGENT', 'MERGER']) { env[`${role}_MODEL`] = model; env[`${role}_THINKING`] = 'medium'; env[`${role}_TIMEOUT_SECONDS`] = '600'; }
  const child = spawn(path.join(repo, 'backend/target/debug/grapher'), [], { cwd: project, env, stdio: ['ignore', fd, fd] });
  servers.push(child);
  for (let i = 0; i < 100; i++) { try { await api(port, 'bootstrap'); break; } catch { await delay(100); } }
  const config = { repository: project, model, maxParallel: 2, maxFeedback: 2 };
  return { name, port, directory, project, data, config, baseline };
}
function collect(sample, snapshot) {
  const dest = path.join(out, sample.name);
  write(path.join(dest, 'snapshot.json'), snapshot);
  write(path.join(dest, 'graph.json'), snapshot.graph);
  write(path.join(dest, 'config.json'), { ...sample, goal: sample.goal });
  const planning = path.join(sample.data, 'planning', snapshot.planningId || snapshot.planning?.planningId || '');
  if (fs.existsSync(planning)) fs.cpSync(planning, path.join(dest, 'planning'), { recursive: true });
}
async function plan(sample, goal) {
  sample.goal = goal;
  log(`${sample.name}: real planning started`);
  const snap = await api(sample.port, 'plan_goal', { goal, config: sample.config });
  collect(sample, snap);
  write(path.join(out, sample.name, 'compiler.json'), await api(sample.port, 'compile_graph', { graph: snap.graph }));
  assert.equal(snap.phase, 'awaiting_approval');
  assert.equal(snap.executions.length, 0);
  assert.equal(git(sample.project, 'rev-parse', 'HEAD'), sample.baseline);
  assert.equal(git(sample.project, 'status', '--porcelain'), '');
  log(`${sample.name}: ${snap.graph.nodes.length} nodes, ${snap.graph.edges.length} edges, waiting for approval`);
  return snap;
}
try {
  const contract = fs.readFileSync(path.join(import.meta.dirname, 'contract.md'), 'utf8');
  const catalog = await setup('catalog', basePort, { 'README.md': contract, 'package.json': '{"name":"catalog-acceptance","type":"module","scripts":{"test":"node --test"}}\n', 'src/csv.mjs': '// Implement parseCatalog according to README.md\n', 'src/search.mjs': '// Implement searchCatalog according to README.md\n' });
  const sdk = await setup('sdk', basePort + 1, repositoryFiles);
  const audit = await setup('audit', basePort + 2, repositoryFiles);
  const otherPlans = Promise.allSettled([plan(sdk, cases.find(c => c.id === 'P005').goal), plan(audit, cases.find(c => c.id === 'P006').goal)]);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  metadata.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', err => browserErrors.push(String(err)));
  page.on('response', async response => {
    if (response.url().endsWith('/api/plan_goal_stream')) {
      try { write(path.join(out, 'catalog', 'browser-planning.sse'), await response.text()); } catch {}
    }
  });
  await page.goto(`http://127.0.0.1:${basePort}`);
  await page.getByPlaceholder('描述你想完成的工作或项目目标...').waitFor();
  await page.screenshot({ path: path.join(out, '01-landing.png') });
  catalog.goal = 'Implement the two independent modules defined in README.md: the CSV catalog parser and the catalog search/filter module. Each needs thorough Node built-in unit tests in separate test files. Then add tests/integration.test.mjs that verifies their interoperability, and write reports/verification.md with commands, results and remaining limitations. Preserve the existing public contract and package.json, use no dependencies or network services. Verify malformed CSV, quoted commas and escaped quotes, CRLF, empty input, price validation, case-insensitive query, inclusive bounds, stable ordering and no mutation. Deliver working source files, tests and the final verification report.';
  await page.getByPlaceholder('描述你想完成的工作或项目目标...').fill(catalog.goal);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  log('catalog: submitted via browser');
  await page.getByRole('button', { name: 'Approve & Start', exact: true }).waitFor({ timeout: 600000 });
  let snap = await api(catalog.port, 'snapshot');
  assert.equal(snap.phase, 'awaiting_approval');
  assert.equal(snap.executions.length, 0);
  collect(catalog, snap);
  write(path.join(out, 'catalog', 'compiler.json'), await api(catalog.port, 'compile_graph', { graph: snap.graph }));
  await page.screenshot({ path: path.join(out, '02-planned.png'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Approve & Start', exact: true }).click();
  await page.getByRole('heading', { name: '审批执行图计划' }).waitFor();
  await page.screenshot({ path: path.join(out, '03-approval.png') });
  await page.getByRole('button', { name: '确认审批并启动' }).click();
  log('catalog: approved in browser after reload');
  const started = Date.now();
  let runningSaved = false;
  let lastPhase;
  while (Date.now() - started < 1200000) {
    snap = await api(catalog.port, 'snapshot');
    const phase = `${snap.phase}:${snap.executions.map(e => `${e.node}/${e.attempt}/${e.status}`).join(',')}`;
    if (phase !== lastPhase) { log(`catalog: ${phase}`); lastPhase = phase; }
    if (!runningSaved && snap.executions.some(e => e.status === 'running')) {
      await delay(2500);
      await page.screenshot({ path: path.join(out, '04-running.png') });
      await page.reload();
      runningSaved = true;
    }
    if (['completed', 'needs_attention', 'publication_failed'].includes(snap.phase)) break;
    await delay(1500);
  }
  collect(catalog, snap);
  await page.reload();
  await delay(2000);
  await page.screenshot({ path: path.join(out, '05-final.png'), fullPage: true });
  write(path.join(out, 'catalog', 'final-browser.txt'), await page.locator('body').innerText());
  write(path.join(out, 'catalog', 'published.diff'), git(catalog.project, 'diff', catalog.baseline, 'HEAD'));
  write(path.join(out, 'catalog', 'git-log.txt'), git(catalog.project, 'log', '--oneline', '--all', '--graph'));
  if (snap.phase === 'completed') {
    const acceptance = execFileSync(process.execPath, [path.join(import.meta.dirname, 'acceptance.mjs'), catalog.project], { encoding: 'utf8' });
    write(path.join(out, 'catalog', 'independent-acceptance.json'), acceptance);
    write(path.join(out, 'catalog', 'published-test-output.txt'), execFileSync(process.execPath, ['--test'], { cwd: catalog.project, encoding: 'utf8' }));
    fs.cpSync(path.join(catalog.project, 'reports'), path.join(out, 'catalog', 'reports'), { recursive: true });
  }
  write(path.join(out, 'browser-errors.json'), browserErrors);
  await context.tracing.stop({ path: path.join(out, 'browser-trace.zip') });
  const results = await otherPlans;
  write(path.join(out, 'supplemental-results.json'), results.map(r => r.status === 'fulfilled' ? { status: r.status, runId: r.value.runId } : { status: r.status, error: String(r.reason) }));
  assert.equal(snap.phase, 'completed');
  assert.equal(browserErrors.length, 0);
  for (const result of results) assert.equal(result.status, 'fulfilled');
  metadata.status = 'PASS';
  log('Real graph execution, publication, independent acceptance and supplemental planning finished');
} catch (error) {
  metadata.status = 'FAIL'; metadata.error = String(error); log(String(error)); process.exitCode = 1;
} finally {
  metadata.endedAt = new Date().toISOString();
  write(path.join(out, 'metadata.json'), metadata);
  if (browser) await browser.close();
  for (const server of servers) server.kill('SIGINT');
}
