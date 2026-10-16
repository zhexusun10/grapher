// Opt-in paid-provider acceptance: real Rust backend, Pi, saved model and browser.
// Uses disposable projects/data; never changes the saved config or project.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';

if (process.env.GRAPHER_PAID_ACCEPTANCE !== '1') throw Error('Set GRAPHER_PAID_ACCEPTANCE=1 to authorize saved-provider requests.');
const saved = JSON.parse(await readFile(process.env.GRAPHER_SAVED_CONFIG || '.grapher/config.json', 'utf8'));
const model = saved.roleModels?.planner?.model || saved.model;
assert.equal(model, 'antigravity/gemini-3.8-flash', 'This acceptance must use the requested saved Gemini 3.8 Flash model.');
const root = await mkdtemp(join(tmpdir(), 'grapher-planner-review-'));
console.log(`Disposable acceptance root: ${root}`);
const binary = join(resolve(process.env.CARGO_TARGET_DIR || '.grapher/verification-target'), 'debug', `grapher${process.platform === 'win32' ? '.exe' : ''}`);
const delay = ms => new Promise(done => setTimeout(done, ms));
async function port() {
  const server = netServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const value = server.address().port; await new Promise(done => server.close(done)); return value;
}
const browser = await chromium.launch({ headless: true, channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium') });
try {
  for (const auto of [false, true]) {
    const label = auto ? 'automatic' : 'manual';
    const directory = join(root, label), repository = join(directory, 'project'), data = join(directory, 'data');
    await mkdir(repository, { recursive: true }); await mkdir(data);
    const agent = join(directory, 'agent'); await mkdir(agent);
    const savedAgent = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.grapher', 'pi-agent');
    for (const file of ['auth.json', 'models.json', 'models-store.json', 'disabled-providers.json', 'settings.json']) {
      try { await copyFile(join(savedAgent, file), join(agent, file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Optional recovery turns obscure the turn boundary under test. Disable
    // only in this disposable agent directory; never touch the user's settings.
    await writeFile(join(agent, 'extensions.json'), JSON.stringify({ overrides: { 'npm:pi-continuity': false } }));
    execFileSync('git', ['init', '-q', repository]);
    await writeFile(join(repository, 'README.md'), 'Disposable Planner continuation acceptance.\n');
    execFileSync('git', ['-C', repository, 'add', '.']);
    execFileSync('git', ['-C', repository, '-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@localhost', 'commit', '-qm', 'Initial']);
    const config = { ...saved, repository, model, postTaskReview: false, autoApprove: false,
      roleModels: Object.fromEntries(['nodeAgent', 'planner', 'partitioner'].map(role => [role, { model, thinkingLevel: 'low' }])) };
    await writeFile(join(data, 'config.json'), JSON.stringify(config));
    const backendPort = await port(), frontendPort = await port();
    const env = { ...process.env, GRAPHER_PORT: String(backendPort), GRAPHER_DATA_DIR: data,
      GRAPHER_ALLOWED_ORIGINS: `http://127.0.0.1:${frontendPort}`,
      PI_CODING_AGENT_DIR: agent, GRAPHER_ISOLATED_PI_MODELS: '1',
      GRAPHER_WORKSPACE_PARENT: join(directory, 'workspaces'),
      PLANNER_MODEL: model, NODE_AGENT_MODEL: model, PARTITIONER_MODEL: model, MERGER_MODEL: model };
    let diagnostics = '';
    const backend = spawn(binary, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    backend.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-24000); });
    let vite, context;
    const api = async (command, body = {}) => {
      const response = await fetch(`http://127.0.0.1:${backendPort}/api/${command}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      const payload = await response.json(); if (payload.error) throw Error(payload.error); return payload.result;
    };
    try {
      for (let i = 0; ; i++) {
        try { await api('bootstrap', { detail: 'metadata' }); break; }
        catch (error) { if (backend.exitCode !== null || i > 120) throw Error(`${error}\n${diagnostics}`); await delay(250); }
      }
      vite = await createServer({ cacheDir: 'node_modules/.vite-planner-review-acceptance', server: {
        port: frontendPort, strictPort: true, host: '127.0.0.1', open: false,
        proxy: { '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: true } },
      } });
      await vite.listen();
      context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, locale: 'en-US', reducedMotion: 'reduce' });
      await context.addInitScript(({ repository }) => {
        localStorage.setItem('grapher_language_v1', 'en');
        localStorage.setItem('grapher_plan_mode', 'graph');
        localStorage.setItem('grapher_projects', JSON.stringify([{ id: repository, path: repository, name: 'Review acceptance', lastOpened: 1 }]));
      }, { repository });
      const page = await context.newPage(); page.setDefaultTimeout(30000);
      const errors = []; page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const reviewToggle = page.getByRole('checkbox', { name: 'Post-task Planner review', exact: true });
      assert.equal(await reviewToggle.isChecked(), false);
      await reviewToggle.check();
      if (auto) await page.getByRole('checkbox', { name: 'Auto approve Planner graphs', exact: true }).check();
      await expect(page.locator('.save-config-btn')).toBeEnabled({ timeout: 60000 });
      await page.locator('.save-config-btn').click();
      await page.locator('.settings-modal').waitFor({ state: 'detached' });
      const persisted = (await api('bootstrap', { detail: 'metadata' })).config;
      assert.equal(persisted.postTaskReview, true); assert.equal(persisted.autoApprove, auto);
      const goal = 'Use Node Agents for a two-phase file task. In this first turn, create only phase_one: write phase-one.txt containing PUBLISHED_ONE. '
        + 'Then reply PHASE_ONE_PLANNED and end your turn immediately. Do not wait, poll, inspect runtime data, or execute the work yourself. '
        + 'On a future notification after phase_one completes and is published, create phase_two to verify phase-one.txt contains PUBLISHED_ONE and write phase-two.txt containing VERIFIED_TWO. '
        + 'Add the dependency edge phase_one -> phase_two, reply PHASE_TWO_PLANNED and end that turn immediately. '
        + 'On the next notification after both files are published, reply REVIEW_COMPLETE and create no more nodes. Keep completed nodes unchanged.';
      const composer = page.locator('.landing-screen textarea');
      await composer.fill(goal); await composer.press('Enter');
      let runId, snapshot, approvedInitial = false, approvedContinuation = false;
      let sawLiveNode = false, sawLiveEdge = false, sawLiveText = false, sawReview = false;
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        if (backend.exitCode !== null) throw Error(`Backend exited: ${diagnostics}`);
        if (!runId || runId.startsWith('pending-')) runId = await page.evaluate(() => document.querySelector('[data-run-id]')?.getAttribute('data-run-id'));
        if (!runId || runId.startsWith('pending-')) { await delay(100); continue; }
        snapshot = await api('history', { runId, detail: 'metadata' });
        const starts = snapshot.events.filter(event => event.type === 'planner_review_started');
        sawReview ||= starts.length > 0;
        const live = snapshot.phase === 'planning' && starts.length > 0;
        if (live) {
          if (await page.locator('.react-flow__node').filter({ hasText: 'phase_two' }).count()) sawLiveNode = true;
          if (await page.locator('.react-flow__edge').count()) sawLiveEdge = true;
          if ((await page.locator('.planning-activity').innerText().catch(() => '')).trim()) sawLiveText = true;
        }
        if (snapshot.phase === 'planning_failed' || snapshot.phase === 'publication_failed' || Object.values(snapshot.nodes).some(node => node.status === 'failed')) {
          throw Error(`Execution failed: ${snapshot.phase}\n${diagnostics}`);
        }
        if (!auto && snapshot.phase === 'awaiting_approval' &&
            (starts.length ? !approvedContinuation : !approvedInitial)) {
          if (starts.length) {
            assert.equal(snapshot.executions.length, 1, 'new nodes must not dispatch before manual approval');
            assert.equal(await readFile(join(repository, 'phase-one.txt'), 'utf8').then(s => s.trim()), 'PUBLISHED_ONE');
            await delay(700);
            assert.equal((await api('history', { runId, detail: 'metadata' })).executions.length, 1);
            approvedContinuation = true;
          } else approvedInitial = true;
          await page.getByRole('button', { name: 'Approve', exact: true }).click();
          await page.getByRole('button', { name: 'Approve and start', exact: true }).click();
          await page.getByRole('dialog', { name: 'Approve execution graph' }).waitFor({ state: 'detached' });
        }
        if (starts.length >= 2 && snapshot.phase === 'completed' && snapshot.planning?.status === 'success') break;
        await delay(100);
      }
      assert.ok(snapshot?.phase === 'completed' && snapshot.events.filter(event => event.type === 'planner_review_started').length === 2,
        `workflow did not complete: ${snapshot?.phase}\n${diagnostics}`);
      await page.locator('.planning-activity').getByText('REVIEW_COMPLETE', { exact: true }).last().waitFor({ timeout: 30000 });
      assert.ok(sawReview); assert.ok(sawLiveNode, 'new node rendered while Planner turn was live');
      assert.ok(sawLiveEdge, 'new edge rendered while Planner turn was live');
      assert.ok(sawLiveText, 'durable Planner output streamed while turn was live');
      assert.equal(snapshot.executions.length, 2);
      assert.equal(await readFile(join(repository, 'phase-two.txt'), 'utf8').then(s => s.trim()), 'VERIFIED_TWO');
      assert.equal(await page.locator('body').innerText().then(text => text.includes('All tasks you assigned are completed. Consider your next move.')), false);
      if (!auto) { assert.ok(approvedInitial); assert.ok(approvedContinuation); }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator(`[data-run-id="${runId}"]`).click();
      await page.locator('.planning-activity').getByText('REVIEW_COMPLETE', { exact: true }).last().waitFor({ timeout: 30000 });
      assert.equal(await page.locator('body').innerText().then(text => text.includes('All tasks you assigned are completed. Consider your next move.')), false);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ mode: label, model, runId, executions: snapshot.executions.length, sawLiveNode, sawLiveEdge, sawLiveText, hiddenAfterReload: true }));
    } catch (error) {
      if (context) await context.pages()[0]?.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
      throw Error(`${label}: ${error}\n${diagnostics}`);
    } finally {
      await context?.close(); await vite?.close();
      backend.kill(); await new Promise(done => backend.exitCode !== null ? done() : backend.once('exit', done));
      await rm(agent, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
  for (const label of ['manual', 'automatic']) await rm(join(root, label, 'agent'), { recursive: true, force: true });
}
