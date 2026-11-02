// End-to-end macOS browser acceptance: real UI, production backend, pinned Pi,
// Seatbelt and Git. Only model responses come from a deterministic local server.
// Every repository, credential directory and backend is owned by this test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer as createViteServer } from 'vite';

const root = resolve('.');
const delay = ms => new Promise(done => setTimeout(done, ms));

async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

test('macOS browser drives Graph publication and a persistent Serial follow-up',
  { skip: process.platform !== 'darwin', timeout: 240_000 }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'grapher-macos-browser-')));
    const project = join(directory, 'Cafe\u0301 中文 # % project');
    const agent = join(directory, 'agent');
    const data = join(directory, 'data');
    const errors = [], calls = [], browserErrors = [], requests = [];
    let backend, vite, browser, context, page, serialRunId, api, diagnostics = '', success = false;
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@localhost', ...args], {
      cwd: project, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const model = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const messages = body.messages;
        const userIndex = messages.findLastIndex(message => message.role === 'user');
        assert.ok(userIndex >= 0, 'model request must contain a user turn');
        const prompt = JSON.stringify(messages[userIndex].content);
        const results = messages.slice(userIndex + 1).filter(message => message.role === 'tool');
        assert.ok(results.every(result => !JSON.stringify(result.content).includes('exited with code')),
          `Native tool failed: ${JSON.stringify(results)}`);
        const planner = body.tools?.some(tool => tool.function.name === 'node');
        let tool, text = 'Planner ready';
        if (planner) {
          if (results.length === 0) tool = { name: 'node', arguments: { nodes: [
            { name: 'alpha', task: 'BROWSER_MAC_ALPHA' },
            { name: 'beta', task: 'BROWSER_MAC_BETA' },
            { name: 'join', task: 'BROWSER_MAC_JOIN' },
          ] } };
          if (results.length === 1) tool = { name: 'edge', arguments: { edges: [
            { from: 'alpha', to: 'join' }, { from: 'beta', to: 'join' },
          ] } };
        } else {
          const command = prompt.includes('BROWSER_MAC_ALPHA')
            ? 'test "$(cat input.txt)" = "unstaged latest" && test ! -e .DS_Store && printf alpha > alpha.txt'
            : prompt.includes('BROWSER_MAC_BETA') ? 'printf beta > beta.txt'
              : prompt.includes('BROWSER_MAC_JOIN')
                ? 'test "$(cat alpha.txt)" = alpha && test "$(cat beta.txt)" = beta && printf combined > result.txt'
                : prompt.includes('BROWSER_MAC_SERIAL') ? 'printf first > serial.txt'
                  : prompt.includes('BROWSER_MAC_FOLLOWUP') ? 'test "$(cat serial.txt)" = first && printf continued > serial.txt'
                    : undefined;
          assert.ok(command, `Unexpected node prompt: ${prompt}`);
          if (!results.length) tool = { name: 'bash', arguments: { command } };
          text = prompt.includes('BROWSER_MAC_JOIN') ? 'UI_JOIN_DONE'
            : prompt.includes('BROWSER_MAC_SERIAL') ? 'UI_SERIAL_DONE'
              : prompt.includes('BROWSER_MAC_FOLLOWUP') ? 'UI_FOLLOWUP_DONE' : 'UI_NODE_DONE';
        }
        calls.push({ role: planner ? 'planner' : 'node', tool: tool?.name ?? null });
        const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${calls.length}`,
          type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
          : { role: 'assistant', content: text };
        const chunk = (value, reason) => ({ id: 'local-browser', object: 'chat.completion.chunk', created: 1,
          model: 'native', choices: [{ index: 0, delta: value, finish_reason: reason }] });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
      } catch (error) {
        errors.push(String(error));
        response.writeHead(500); response.end(String(error));
      }
    });
    try {
      for (const dir of [project, agent, join(directory, 'home'), join(directory, 'global')]) await mkdir(dir);
      await writeFile(join(project, 'input.txt'), 'baseline\n');
      git('init', '-q'); git('add', 'input.txt'); git('commit', '-qm', 'baseline');
      const head = git('rev-parse', 'HEAD');
      await writeFile(join(project, 'input.txt'), 'staged\n'); git('add', 'input.txt');
      await writeFile(join(project, 'input.txt'), 'unstaged latest\n');
      await writeFile(join(project, '.DS_Store'), 'finder metadata');
      const objects = git('cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)');
      await new Promise(done => model.listen(0, '127.0.0.1', done));
      await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'browser-local': {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'local-test-only',
        models: [{ id: 'native', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      } } }));
      const port = await freePort();
      vite = await createViteServer({ cacheDir: join(directory, 'vite-cache'), server: {
        host: '127.0.0.1', port: 0, strictPort: false, open: false, hmr: false, watch: null,
        proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true } },
      } });
      await vite.listen();
      const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
      // Do not inherit the host's model credentials, Pi configuration, data
      // directories, or NODE_OPTIONS. This process serves only this test.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|TMPDIR|TMP|TEMP|LANG|LC_ALL)$/i.test(key)));
      Object.assign(env, { HOME: join(directory, 'home'), GRAPHER_DATA_DIR: data, GRAPHER_PORT: String(port),
        GRAPHER_CACHE_DIR: join(directory, 'cache'), GRAPHER_WORKSPACE_PARENT: join(directory, 'workspaces'),
        GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'runtime'), GRAPHER_ALLOWED_ORIGINS: origin,
        GRAPHER_GLOBAL_PI_AGENT_DIR: join(directory, 'global'), PI_CODING_AGENT_DIR: agent,
        GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_DEV_LAZY_PRIMARY: '1',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        PLANNER_MODEL: 'browser-local/native', NODE_AGENT_MODEL: 'browser-local/native',
        PARTITIONER_MODEL: 'browser-local/native', MERGER_MODEL: 'browser-local/native',
        PLANNER_THINKING: 'off', NODE_AGENT_THINKING: 'off', PARTITIONER_THINKING: 'off', MERGER_THINKING: 'off' });
      const target = resolve(process.env.CARGO_TARGET_DIR || 'backend/target');
      backend = spawn(join(target, 'debug', 'grapher'), [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      backend.stderr.on('data', chunk => { diagnostics += chunk; });
      backend.on('error', error => { diagnostics += `${error}\n`; });
      api = async (command, body = {}) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
        const value = await response.json();
        assert.ok(response.ok && !value.error, `${command}: ${JSON.stringify(value)}`);
        return value.result;
      };
      const until = async (check, label, timeout = 120_000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
          assert.deepEqual(errors, [], 'local model must not encounter errors');
          if (backend.exitCode !== null || backend.signalCode !== null) throw new Error(`Backend exited: ${diagnostics}`);
          const value = await check();
          if (value) return value;
          await delay(100);
        }
        throw new Error(`${label} timed out\n${diagnostics}`);
      };
      const bootstrap = await until(async () => { try { return await api('bootstrap'); } catch { return false; } }, 'backend startup');
      const config = { ...bootstrap.config, repository: project, model: 'browser-local/native', thinkingLevel: 'off',
        maxParallel: 2, autoApprove: false, postTaskReview: false };
      await api('save_config', { config });
      browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || 'chromium', headless: true });
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
      await context.addInitScript(({ project, config }) => {
        localStorage.setItem('grapher_language_v1', 'en');
        localStorage.setItem('grapher_plan_mode', 'graph');
        localStorage.setItem('grapher_config', JSON.stringify(config));
        localStorage.setItem('grapher_projects', JSON.stringify([{ id: project, path: project, name: 'macOS acceptance', lastOpened: 1 }]));
      }, { project, config });
      page = await context.newPage();
      page.on('pageerror', error => browserErrors.push(String(error)));
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/api/')) requests.push(`${url.pathname}: ${response.status()}`);
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const composer = page.locator('.landing-screen textarea');
      await composer.waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Graph', exact: true }).click();
      await composer.fill('BROWSER_MAC create two branches and combine their results');
      await composer.press('Enter');
      const approve = page.getByRole('button', { name: 'Approve', exact: true });
      await approve.waitFor({ timeout: 120_000 });
      const runs = (await api('bootstrap')).runs;
      assert.equal(runs.length, 1);
      const runId = runs[0];
      const planned = await api('snapshot', { runId });
      assert.equal(planned.phase, 'awaiting_approval');
      assert.equal(planned.graph.nodes.length, 3);
      assert.equal(planned.graph.edges.length, 2);
      await assert.rejects(readFile(join(project, 'result.txt')), { code: 'ENOENT' }, 'no node runs before approval');
      await approve.click();
      await page.getByRole('button', { name: 'Approve and start', exact: true }).click();
      const completed = await until(async () => {
        const state = await api('snapshot', { runId });
        if (['needs_attention', 'failed', 'publication_failed'].includes(state.phase)) throw new Error(JSON.stringify(state));
        return state.phase === 'completed' && state;
      }, 'Graph publication');
      assert.equal(completed.publication.status, 'completed');
      for (const name of ['alpha', 'beta', 'join']) assert.equal(completed.nodes[name].status, 'completed');
      assert.equal(await readFile(join(project, 'result.txt'), 'utf8'), 'combined');
      assert.equal(await readFile(join(project, 'input.txt'), 'utf8'), 'unstaged latest\n');
      assert.equal(await readFile(join(project, '.DS_Store'), 'utf8'), 'finder metadata');
      assert.equal(git('show', ':input.txt'), 'staged');
      assert.equal(git('rev-parse', 'HEAD'), head, 'Graph delivery must not add a source commit');
      assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/grapher'), '');
      assert.equal(git('cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'), objects,
        'private Graph objects must not enter the source repository');
      await page.locator('[data-node-name="join"]').click();
      await page.getByText('UI_JOIN_DONE', { exact: true }).waitFor({ timeout: 30_000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator(`[data-run-id="${runId}"]`).click({ timeout: 30_000 });
      await page.locator('[data-node-name="join"]').click({ timeout: 30_000 });
      await page.getByText('UI_JOIN_DONE', { exact: true }).waitFor({ timeout: 30_000 });

      // Serial uses the source project and must keep its Pi process/session for
      // the next turn, instead of treating it as a private Graph workspace.
      await page.getByRole('button', { name: 'New conversation', exact: true }).click();
      await page.getByRole('button', { name: 'Serial', exact: true }).click();
      const serialComposer = page.locator('.landing-screen textarea');
      await serialComposer.fill('BROWSER_MAC_SERIAL create a serial file');
      await serialComposer.press('Enter');
      await page.getByText('UI_SERIAL_DONE', { exact: true }).waitFor({ timeout: 60_000 });
      serialRunId = await until(async () => (await api('bootstrap')).runs.find(id => id !== runId), 'Serial Run');
      const firstTurn = await until(async () => {
        const state = await api('snapshot', { runId: serialRunId });
        if (state.phase === 'needs_attention') throw new Error(JSON.stringify(state));
        return state.phase === 'completed' && state;
      }, 'Serial completion');
      assert.equal(firstTurn.planType, 'serial');
      assert.equal(firstTurn.executions.length, 1);
      assert.equal(await realpath(firstTurn.executions[0].worktree), await realpath(project));
      assert.equal(await readFile(join(project, 'serial.txt'), 'utf8'), 'first');
      // A streamed final answer can precede the terminal snapshot in the UI.
      // Send promptly: if the stale view tries a Steer, the backend must reject
      // it without losing the draft; retry only once the UI reflects completion.
      const followup = page.locator('.pane-bottom-chat textarea');
      const instruction = 'BROWSER_MAC_FOLLOWUP continue the same conversation';
      const sent = page.waitForResponse(response => {
        if (!new URL(response.url()).pathname.endsWith('/api/control')) return false;
        const body = response.request().postDataJSON();
        return body?.action === 'steer' || body?.action === 'intervene';
      }, { timeout: 30_000 });
      await followup.fill(instruction);
      await followup.press('Enter');
      const response = await sent;
      let retried = false;
      if (!response.ok()) {
        assert.equal(response.status(), 400);
        assert.match((await response.json()).error, /Node execution is no longer running/);
        await page.waitForFunction(value => {
          const input = document.querySelector('.pane-bottom-chat textarea');
          return input && !input.disabled && input.value === value;
        }, instruction);
        await page.getByText('Node execution is no longer running; send a new instruction instead', { exact: true }).waitFor();
        await page.locator('.pane-bottom-chat').getByRole('button', { name: 'Send message', exact: true })
          .waitFor({ timeout: 30_000 });
        await followup.press('Enter');
        retried = true;
      }
      await page.getByText('UI_FOLLOWUP_DONE', { exact: true }).waitFor({ timeout: 60_000 });
      const secondTurn = await until(async () => {
        const state = await api('snapshot', { runId: serialRunId });
        if (state.phase === 'needs_attention') throw new Error(JSON.stringify(state));
        return state.phase === 'completed' && state.executions.length === 2 && state;
      }, 'Serial follow-up');
      assert.equal(secondTurn.executions[1].sessionId, firstTurn.executions[0].sessionId);
      assert.equal(await readFile(join(project, 'serial.txt'), 'utf8'), 'continued');
      const logs = await Promise.all(secondTurn.executions.map(execution => api('get_execution_output', {
        runId: serialRunId, executionId: execution.id, full: true,
      })));
      const event = (content, type) => content.split('\n').flatMap(line => {
        try { const value = JSON.parse(line); return value.type === type ? [value] : []; } catch { return []; }
      })[0];
      const parked = event(logs[0].content, 'grapher_session_parked');
      const resumed = event(logs[1].content, 'grapher_session_resumed');
      assert.ok(parked && resumed, 'Serial must park and resume the real Pi process');
      assert.equal(resumed.pid, parked.pid, 'the follow-up uses the same process');
      assert.deepEqual(browserErrors, []);
      assert.ok(calls.some(call => call.role === 'planner' && call.tool === 'node'));
      assert.ok(calls.filter(call => call.role === 'node' && call.tool === 'bash').length >= 5);
      success = true;
      console.log(`macOS browser acceptance: Graph, Serial, Seatbelt, Git and pinned Pi; ${calls.length} local model calls; stale send retried: ${retried}`);
    } catch (error) {
      const view = page && await page.evaluate(() => ({ text: document.body.innerText.slice(-6000),
        inputs: [...document.querySelectorAll('textarea')].map(input => ({ value: input.value, disabled: input.disabled })) })).catch(() => null);
      const snapshot = serialRunId && api && await api('snapshot', { runId: serialRunId }).catch(() => null);
      const serial = snapshot && { phase: snapshot.phase, nodes: snapshot.nodes,
        executions: snapshot.executions.map(({ id, status, sessionId }) => ({ id, status, sessionId })) };
      console.error(`macOS browser acceptance failed; backend:\n${diagnostics}\nModel calls: ${JSON.stringify(calls)}\nErrors: ${JSON.stringify(errors)}\nBrowser errors: ${JSON.stringify(browserErrors)}\nRequests: ${JSON.stringify(requests.slice(-40))}\nView: ${JSON.stringify(view)}\nSerial: ${JSON.stringify(serial)}`);
      throw error;
    } finally {
      // A failed browser cleanup must not strand the separately owned backend
      // or delete anything outside this test's temporary directory.
      const cleanupErrors = [];
      const clean = async (label, work) => {
        try { await work(); } catch (error) { cleanupErrors.push(`${label}: ${error}`); }
      };
      await clean('browser context', () => context?.close());
      await clean('browser', () => browser?.close());
      await clean('backend', async () => {
        if (backend?.pid && backend.exitCode === null && backend.signalCode === null) {
          const exit = once(backend, 'exit');
          backend.kill('SIGTERM');
          const exited = await Promise.race([exit.then(() => true), delay(5000).then(() => false)]);
          if (!exited && backend.exitCode === null && backend.signalCode === null) { backend.kill('SIGKILL'); await exit; }
        }
      });
      await clean('Vite', () => vite?.close());
      await clean('local model', async () => {
        model.closeAllConnections();
        if (model.listening) await new Promise(done => model.close(done));
      });
      await clean('temporary data', () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
      if (cleanupErrors.length) {
        const message = `Acceptance cleanup failed: ${cleanupErrors.join('; ')}`;
        if (success) throw new Error(message);
        console.error(message);
      }
    }
  });
