// Browser-driven production E2E: plan, approve, execute, publish, and verify a
// deterministic graph task in a disposable Git repository.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
const evidence = path.resolve(process.env.E2E_EVIDENCE_DIR || path.join(repo, 'benchmark-results', `e2e-full-chain-${stamp}`));
const project = path.join(evidence, 'fixture-project');
const data = path.join(evidence, 'runtime-data');
const binary = path.resolve(process.env.E2E_BINARY || path.join(repo, 'backend/target/debug/grapher'));
const playwrightModule = process.env.PLAYWRIGHT_MODULE || '/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
const model = process.env.E2E_MODEL || process.env.PLANNER_MODEL || 'dashscope/qwen3.8-flash';
const port = Number(process.env.E2E_PORT || 1555);
const base = `http://127.0.0.1:${port}`;

const goal = `Implement and verify the deterministic catalog task defined by README.md. Use at least five substantive execution nodes with these distinct owned outcomes: (1) contracts/catalog.md records the public data and behavior contract without changing README.md or package.json; (2) src/catalog.mjs and tests/catalog.test.mjs implement and unit-test parseCatalogCsv; (3) src/search.mjs and tests/search.test.mjs independently implement and unit-test searchCatalog; (4) tests/integration.test.mjs verifies parser and search interoperability; (5) reports/verification.md records the exact test commands, actual results, covered acceptance cases, and remaining limitations. The contract outcome must precede both implementation branches, the two implementation branches should run in parallel, integration must consume both, and final verification must consume the integrated result. Use only Node built-ins, add no dependencies, preserve the exports and package manifest, and do not modify files outside those seven owned paths. All tests must pass with npm test.`;

const readme = `# Deterministic catalog contract

The package exposes two ESM functions and uses only Node built-ins.

## parseCatalogCsv(text)

- Export from \`src/catalog.mjs\` as \`parseCatalogCsv\`.
- Accept the exact header \`sku,name,price,stock\` and both LF and CRLF input.
- Parse quoted CSV fields, including commas and doubled quote escapes.
- Return records shaped as \`{ sku, name, priceCents, stock }\` in input order.
- SKU and name must be non-empty. SKU values must be unique.
- Price must be a non-negative decimal with exactly two fractional digits and is returned as integer cents.
- Stock must be a non-negative integer.
- Empty input, malformed quoting, wrong columns, invalid numbers, and duplicate SKU values must throw \`Error\`.

## searchCatalog(records, options)

- Export from \`src/search.mjs\` as \`searchCatalog\`.
- \`options\` may contain \`query\`, \`minPriceCents\`, and \`maxPriceCents\`.
- Query matching is case-insensitive against SKU or name.
- Price bounds are inclusive. Omitted filters do not restrict results.
- Preserve input order and do not mutate the records array or its objects.
- Invalid negative/non-integer bounds, or a minimum above the maximum, must throw \`Error\`.
`;

fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'README.md'), readme);
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'catalog-e2e-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.writeFileSync(path.join(project, 'src/catalog.mjs'), 'export function parseCatalogCsv(_text) { throw new Error("not implemented"); }\n');
fs.writeFileSync(path.join(project, 'src/search.mjs'), 'export function searchCatalog(_records, _options = {}) { throw new Error("not implemented"); }\n');
for (const args of [
  ['init', '-q'],
  ['add', '.'],
  ['-c', 'user.name=E2E Validation', '-c', 'user.email=e2e@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline'],
]) execFileSync('git', args, { cwd: project });

const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
const metadata = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  evidence,
  project,
  data,
  baseline,
  model,
  goal,
  port,
  status: 'RUNNING',
  sourceManifest: Object.fromEntries([
    'backend/resources/prompts/partitioner.md',
    'backend/resources/prompts/planner.md',
    'backend/resources/planner.ts',
    'backend/resources/planning-inspection.mjs',
    'backend/resources/workspace-paths.mjs',
    'backend/src/compiler.rs',
    'backend/src/engine.rs',
    'backend/src/runtime.rs',
    'backend/src/server.rs',
    'engine/prompt-extension.ts',
    'src/App.tsx',
    'src/services/runtime.ts',
  ].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')])),
};
const writeJson = (name, value) => {
  const target = path.join(evidence, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
};
const appendJson = (name, value) => fs.appendFileSync(path.join(evidence, name), JSON.stringify(value) + '\n');
const trace = (step, details = {}) => {
  const event = { at: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(metadata.startedAt), step, ...details };
  appendJson('run-trajectory.jsonl', event);
  console.log(`[e2e] ${step}`, details);
};
writeJson('metadata.json', metadata);
fs.writeFileSync(path.join(evidence, 'goal.txt'), goal + '\n');
trace('fixture_initialized', { project, baseline });

const serverLog = fs.openSync(path.join(evidence, 'server.log'), 'w');
const env = { ...process.env, GRAPHER_DATA_DIR: data, GRAPHER_PORT: String(port) };
for (const role of ['PARTITIONER', 'PLANNER', 'NODE_AGENT', 'MERGER']) {
  env[`${role}_MODEL`] = model;
  env[`${role}_THINKING`] = role === 'PARTITIONER' ? 'off' : 'medium';
  env[`${role}_TIMEOUT_SECONDS`] = role === 'PARTITIONER' ? '90' : role === 'PLANNER' ? '360' : '900';
}
const server = spawn(binary, [], { cwd: project, env, stdio: ['ignore', serverLog, serverLog] });
server.on('exit', (code, signal) => trace('server_exited', { code, signal }));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const api = async (command, body = {}, timeout = 30_000) => {
  const startedAt = new Date().toISOString();
  const response = await fetch(`${base}/api/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const json = await response.json();
  appendJson('api-trajectory.jsonl', { startedAt, endedAt: new Date().toISOString(), command, request: body, status: response.status, response: json });
  if (!response.ok || json.error) throw new Error(json.error || `${command} failed with ${response.status}`);
  return json.result;
};

function parseEvents(text) {
  return text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function roleMetrics(text) {
  const events = parseEvents(text);
  const starts = events.filter(event => event.type === 'tool_execution_start');
  const ends = events.filter(event => event.type === 'tool_execution_end');
  const processStart = events.find(event => event.type === 'grapher_process_started');
  const processEnd = events.findLast(event => event.type === 'grapher_process_exited');
  const firstAssistant = events.find(event => event.type === 'message_update' || event.type === 'message_end');
  return {
    eventCount: events.length,
    elapsedMs: processEnd?.elapsedMs ?? null,
    firstAssistantMs: firstAssistant && processStart ? firstAssistant.grapherReceivedAt - processStart.timestamp : null,
    tools: starts.map(event => ({ at: event.grapherReceivedAt, name: event.toolName, callId: event.toolCallId, args: event.args })),
    toolResults: ends.map(event => ({ at: event.grapherReceivedAt, name: event.toolName, callId: event.toolCallId, isError: Boolean(event.isError || event.result?.isError), result: event.result })),
    toolErrors: ends.filter(event => event.isError || event.result?.isError).length,
    assistantMessages: events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').map(event => event.message),
    usage: events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').reduce((sum, event) => {
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens']) sum[key] = (sum[key] || 0) + (event.message.usage?.[key] || 0);
      return sum;
    }, {}),
  };
}

let browser;
const browserEvents = [];
let snapshot;
try {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await api('bootstrap'); break; } catch (error) {
      if (attempt === 199) throw error;
      await delay(100);
    }
  }
  trace('backend_ready', { base });
  const { chromium } = await import(playwrightModule);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('console', message => browserEvents.push({ at: new Date().toISOString(), type: 'console', level: message.type(), text: message.text() }));
  page.on('pageerror', error => browserEvents.push({ at: new Date().toISOString(), type: 'pageerror', error: String(error) }));
  page.on('request', request => {
    if (request.url().includes('/api/')) browserEvents.push({ at: new Date().toISOString(), type: 'request', method: request.method(), url: request.url(), body: request.postData() });
  });
  page.on('response', response => {
    if (response.url().includes('/api/') || response.status() >= 400) {
      browserEvents.push({ at: new Date().toISOString(), type: 'response', status: response.status(), url: response.url() });
    }
  });
  page.on('requestfailed', request => browserEvents.push({
    at: new Date().toISOString(), type: 'requestfailed', url: request.url(), failure: request.failure(),
  }));

  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByText('How Can I Help You', { exact: true }).waitFor();
  trace('frontend_loaded');
  await page.getByRole('button', { name: '运行配置', exact: true }).click();
  await page.getByPlaceholder('/Users/username/Projects/my-app').fill(project);
  await page.getByRole('button', { name: /检测状态/ }).click();
  await page.getByText('工作树干净 (Clean)', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(evidence, '01-workspace-configured.png'), fullPage: true });
  await page.getByRole('button', { name: /保存所有配置/ }).click();
  await page.getByText('How Can I Help You', { exact: true }).waitFor();
  trace('workspace_bound_via_frontend');

  await page.getByPlaceholder('描述你想完成的工作或项目目标...').fill(goal);
  const planningRequest = page.waitForRequest(request => request.url().endsWith('/api/plan_goal_stream'));
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await planningRequest;
  trace('goal_submitted_via_frontend');
  await page.getByText(/任务路线决策：多节点依赖拓扑图架构/).waitFor({ timeout: 180_000 });
  await page.screenshot({ path: path.join(evidence, '02-planner-stream.png'), fullPage: true });
  trace('partitioner_selected_graph');
  await page.getByRole('button', { name: 'Approve & Start', exact: true }).waitFor({ timeout: 600_000 });
  snapshot = await api('snapshot', { detail: 'metadata' });
  writeJson('planned-snapshot.json', snapshot);
  writeJson('graph.json', snapshot.graph);
  await page.screenshot({ path: path.join(evidence, '03-planned-graph.png'), fullPage: true });
  trace('planning_completed', { planningId: snapshot.planningId, runId: snapshot.runId, nodes: snapshot.graph.nodes.length, edges: snapshot.graph.edges.length });
  assert.equal(snapshot.phase, 'awaiting_approval');
  assert.ok(snapshot.graph.nodes.length >= 5, `Planner produced only ${snapshot.graph.nodes.length} nodes`);

  await page.getByRole('button', { name: 'Approve & Start', exact: true }).click();
  await page.getByRole('dialog', { name: '审批执行图计划' }).waitFor();
  await page.screenshot({ path: path.join(evidence, '04-approval.png'), fullPage: true });
  await page.getByRole('button', { name: /确认审批并启动/ }).click();
  trace('graph_approved_via_frontend');

  let lastState = '';
  let runningCaptured = false;
  const executionStart = Date.now();
  while (Date.now() - executionStart < 2_400_000) {
    snapshot = await api('snapshot', { detail: 'metadata' });
    const state = `${snapshot.phase}:${snapshot.executions.map(item => `${item.node}/${item.attempt}/${item.status}`).join(',')}`;
    if (state !== lastState) {
      trace('runtime_state_changed', { state });
      appendJson('state-trajectory.jsonl', { at: new Date().toISOString(), phase: snapshot.phase, nodes: snapshot.nodes, executions: snapshot.executions });
      lastState = state;
    }
    if (!runningCaptured && snapshot.executions.filter(item => item.status === 'running').length >= 2) {
      // Let the frontend's next metadata poll render the backend state before capture.
      await delay(1500);
      await page.screenshot({ path: path.join(evidence, '05-parallel-execution.png'), fullPage: true });
      runningCaptured = true;
    }
    if (['completed', 'needs_attention', 'publication_failed'].includes(snapshot.phase)) break;
    await delay(1500);
  }
  writeJson('snapshot.json', snapshot);
  assert.equal(snapshot.phase, 'completed', `Unexpected final phase: ${snapshot.phase}`);
  trace('runtime_completed', { executionWallMs: Date.now() - executionStart, executions: snapshot.executions.length });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByText(/已写回/, { exact: false }).first().waitFor({ timeout: 60_000 });
  await page.screenshot({ path: path.join(evidence, '06-completed.png'), fullPage: true });
  fs.writeFileSync(path.join(evidence, 'final-browser.txt'), await page.locator('body').innerText());

  const planningDir = path.join(data, 'planning', snapshot.planningId);
  for (const file of fs.readdirSync(planningDir)) {
    const source = path.join(planningDir, file);
    if (fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(evidence, `planning-${file}`));
  }
  const planningAnalysis = {};
  for (const role of ['partition', 'planner']) {
    const raw = fs.readFileSync(path.join(planningDir, `${role}.jsonl`), 'utf8');
    planningAnalysis[role] = roleMetrics(raw);
  }
  writeJson('planning-analysis.json', planningAnalysis);

  const executionAnalysis = [];
  for (const execution of snapshot.executions) {
    let output = '';
    let offset = 0;
    while (true) {
      const pageResult = await api('get_execution_output', { runId: snapshot.runId, executionId: execution.id, offset }, 60_000);
      output += pageResult.content;
      offset = pageResult.nextOffset;
      if (pageResult.complete) break;
    }
    const filename = `execution-${execution.node}-${execution.attempt}-${execution.id}.jsonl`;
    fs.writeFileSync(path.join(evidence, filename), output);
    executionAnalysis.push({ id: execution.id, node: execution.node, attempt: execution.attempt, status: execution.status, startedAt: execution.startedAt, completedAt: execution.completedAt, metrics: roleMetrics(output), file: filename });
  }
  writeJson('execution-analysis.json', executionAnalysis);

  const testOutput = execFileSync('npm', ['test'], { cwd: project, encoding: 'utf8', timeout: 120_000 });
  fs.writeFileSync(path.join(evidence, 'npm-test.txt'), testOutput);
  const hiddenAcceptance = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { parseCatalogCsv } from './src/catalog.mjs';
    import { searchCatalog } from './src/search.mjs';
    const csv = 'sku,name,price,stock\\r\\nA-1,"Alpha, One",10.00,2\\r\\nB-2,"Say ""Hi""",2.50,0\\r\\nC-3,charlie,7.25,5\\r\\n';
    const rows = parseCatalogCsv(csv);
    assert.deepEqual(rows, [
      { sku: 'A-1', name: 'Alpha, One', priceCents: 1000, stock: 2 },
      { sku: 'B-2', name: 'Say "Hi"', priceCents: 250, stock: 0 },
      { sku: 'C-3', name: 'charlie', priceCents: 725, stock: 5 },
    ]);
    assert.throws(() => parseCatalogCsv('sku,name,price,stock\\nA,a,1.00,1\\nA,b,2.00,2'));
    assert.throws(() => parseCatalogCsv('sku,name,price,stock\\nA,a,1.0,1'));
    const before = structuredClone(rows);
    assert.deepEqual(searchCatalog(rows, { query: 'A', minPriceCents: 700, maxPriceCents: 1000 }).map(row => row.sku), ['A-1', 'C-3']);
    assert.deepEqual(rows, before);
    assert.throws(() => searchCatalog(rows, { minPriceCents: 10, maxPriceCents: 9 }));
    console.log('hidden acceptance: PASS');
  `], { cwd: project, encoding: 'utf8', timeout: 30_000 });
  fs.writeFileSync(path.join(evidence, 'hidden-acceptance.txt'), hiddenAcceptance);

  const changed = execFileSync('git', ['diff', '--name-only', baseline, 'HEAD'], { cwd: project, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const allowed = new Set(['contracts/catalog.md', 'src/catalog.mjs', 'src/search.mjs', 'tests/catalog.test.mjs', 'tests/search.test.mjs', 'tests/integration.test.mjs', 'reports/verification.md']);
  const unexpected = changed.filter(file => !allowed.has(file));
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).trim();
  const gitLog = execFileSync('git', ['log', '--oneline', '--graph', '--decorate', '--all'], { cwd: project, encoding: 'utf8' });
  const diff = execFileSync('git', ['diff', '--stat', baseline, 'HEAD'], { cwd: project, encoding: 'utf8' });
  fs.writeFileSync(path.join(evidence, 'git-log.txt'), gitLog);
  fs.writeFileSync(path.join(evidence, 'published.diff-stat.txt'), diff);
  const browserConsoleErrors = browserEvents.filter(event => event.type === 'console' && event.level === 'error');
  const browserBlockingErrors = browserEvents.filter(event =>
    event.type === 'pageerror' ||
    event.type === 'requestfailed' ||
    (event.type === 'response' && event.status >= 400 && (/\/api\//.test(event.url) || /\.(?:js|css)(?:\?|$)/.test(event.url)))
  );
  const acceptance = {
    phase: snapshot.phase,
    allNodesDone: Object.values(snapshot.nodes).every(node => node.status === 'done'),
    publicationCompleted: snapshot.publication?.status === 'completed',
    cleanRepository: status === '',
    changed,
    unexpected,
    npmTest: 'PASS',
    hiddenAcceptance: 'PASS',
    browserConsoleErrors,
    browserBlockingErrors,
  };
  writeJson('acceptance.json', acceptance);
  assert.ok(acceptance.allNodesDone);
  assert.ok(acceptance.publicationCompleted);
  assert.equal(status, '');
  assert.deepEqual(unexpected, []);
  assert.deepEqual(acceptance.browserBlockingErrors, []);
  metadata.status = 'PASS';
  metadata.runId = snapshot.runId;
  metadata.planningId = snapshot.planningId;
  metadata.nodeCount = snapshot.graph.nodes.length;
  metadata.executionCount = snapshot.executions.length;
  trace('independent_acceptance_passed', acceptance);
} catch (error) {
  metadata.status = 'FAIL';
  metadata.error = error instanceof Error ? `${error.stack || error.message}` : String(error);
  trace('validation_failed', { error: metadata.error });
  if (snapshot) writeJson('failure-snapshot.json', snapshot);
  process.exitCode = 1;
} finally {
  metadata.endedAt = new Date().toISOString();
  writeJson('browser-trajectory.json', browserEvents);
  writeJson('metadata.json', metadata);
  if (browser) await browser.close();
  if (server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGINT');
    await Promise.race([exited, delay(10_000)]);
  }
  fs.closeSync(serverLog);
  console.log(`E2E evidence: ${evidence}`);
}
