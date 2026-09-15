import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const out = path.join(import.meta.dirname, 'v7-validation');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const files = ['src/App.tsx', 'src/components/ExecutionTranscript.tsx', 'src/components/VirtualizedTranscript.tsx', 'src/services/planningRecovery.ts'];
const result = { errors: [], requests: [], sourceManifest: Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dirname, '../..', file))).digest('hex')])) };
const line = value => JSON.stringify(value) + '\n';
const a = '/fixture/project-a', b = '/fixture/project-b';
const config = repository => ({ repository, model: 'transport-fixture', maxParallel: 2, maxFeedback: 2 });
const repoInfo = repository => ({ path: repository, name: repository.split('/').at(-1), clean: true, branch: 'main', head: 'baseline' });
const snapshots = Object.fromEntries([a, b].map((repository, index) => [repository, {
  runId: `run-${index}`, graph: { originalGoal: `Goal ${repository}`, nodes: [{ name: 'worker', task: 'Show execution output' }], edges: [] },
  config: config(repository), plan: { executionBatches: [['worker']], roots: ['worker'], terminals: ['worker'], warnings: [] },
  nodes: { worker: { status: 'done', revision: 1, head: 'head', instruction: '', error: null } },
  executions: [{ id: `execution-${index}`, node: 'worker', revision: 1, attempt: 1, sessionId: `session-${index}`, worktree: repository, before: 'baseline', after: 'head', status: 'completed', output: '', outputBytes: 1000, startedAt: Date.now(), completedAt: Date.now() }],
  mergers: [], events: [], approved: true, paused: false, phase: 'completed', base: 'baseline', feedbackCounts: {},
}]));
let stage = 0, delayA = false, releaseA;
const gate = new Promise(resolve => { releaseA = resolve; });
const outputs = () => ({
  'execution-0': line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'PROJECT_A_ONLY' } }),
  'execution-1': [
    line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'PROJECT_B_THINK' } }),
    line({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: ' UPDATED' } }),
    line({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'b-tool', args: { command: 'node verification.js' } }),
    line({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'b-tool', result: { content: [{ type: 'text', text: 'B_ONLY_RESULT' }], details: { exitCode: 0 } } }),
  ].slice(0, stage + 1).join(''),
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ a, b, snapshots }) => {
    localStorage.setItem('grapher_projects', JSON.stringify([a, b].map(path => ({ path, id: path, name: path.split('/').at(-1), branch: 'main', clean: true }))));
    localStorage.setItem('grapher_workspace_runs', JSON.stringify({ [a]: [snapshots[a].runId], [b]: [snapshots[b].runId] }));
  }, { a, b, snapshots });
  const page = await context.newPage(); page.on('pageerror', error => result.errors.push(String(error)));
  await page.route('**/api/*', async route => {
    const cmd = route.request().url().split('/').at(-1), body = route.request().postDataJSON();
    let value;
    if (cmd === 'bootstrap') value = { snapshot: snapshots[a], config: config(a), repositoryInfo: repoInfo(a), runs: ['run-0', 'run-1'], dataPath: 'transport-fixture' };
    else if (cmd === 'snapshot') value = snapshots[a];
    else if (cmd === 'history' || cmd === 'load_run') value = Object.values(snapshots).find(s => s.runId === body.runId);
    else if (cmd === 'detect_repository') value = repoInfo(body.path);
    else if (cmd === 'list_plannings') value = [];
    else if (cmd === 'get_execution_output') {
      result.requests.push(body);
      const text = Buffer.from(outputs()[body.executionId]); const offset = body.offset || 0;
      value = { runId: body.runId, executionId: body.executionId, content: text.subarray(offset).toString(), nextOffset: text.length, totalBytes: text.length, complete: true, status: body.executionId === 'execution-1' && stage < 3 ? 'running' : 'completed' };
      if (body.executionId === 'execution-0' && delayA) await gate;
    } else value = null;
    await route.fulfill({ json: { result: value } }).catch(() => {});
  });
  await page.goto(process.env.V7_BROWSER_URL || 'http://127.0.0.1:1540', { waitUntil: 'domcontentloaded' });
  await page.locator('.react-flow__node').click();
  await page.getByText('PROJECT_A_ONLY', { exact: true }).waitFor();
  const select = async repository => {
    await page.locator('.project-workspace-item').filter({ hasText: repository }).click();
    await page.locator('.react-flow__node').click();
  };
  await select(b);
  await page.getByText('PROJECT_B_THINK', { exact: true }).waitFor();
  assert.equal(await page.getByText('PROJECT_A_ONLY', { exact: true }).count(), 0);
  stage = 1; await page.getByText('PROJECT_B_THINK UPDATED', { exact: true }).waitFor();
  stage = 2; await page.locator('.tool-call-card.running').waitFor();
  stage = 3; await page.locator('.tool-call-card.success').waitFor();
  await page.locator('.tool-call-header').click(); await page.getByText('B_ONLY_RESULT', { exact: true }).waitFor();
  delayA = true;
  const pendingA = page.waitForRequest(request => request.url().endsWith('/get_execution_output') && request.postDataJSON().executionId === 'execution-0');
  await select(a);
  await pendingA;
  await select(b);
  releaseA();
  await page.getByText('PROJECT_B_THINK UPDATED', { exact: true }).waitFor();
  assert.equal(await page.getByText('PROJECT_A_ONLY', { exact: true }).count(), 0);
  assert.deepEqual(result.errors, []);
  result.status = 'PASS'; result.streaming = true; result.delayedProjectSwitch = true;
  await page.screenshot({ path: path.join(out, 'project-stream-isolation.png') });
} catch (error) { result.status = 'FAIL'; result.error = String(error); console.error(error); process.exitCode = 1; }
finally { fs.writeFileSync(path.join(out, 'project-stream.json'), JSON.stringify(result, null, 2) + '\n'); await browser.close(); }
