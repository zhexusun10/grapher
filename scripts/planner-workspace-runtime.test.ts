import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { configurePlannerWorkspace, switchPlannerWorkspace, plannerWorkspaceState } from '../engine/planner-workspace.ts';
import { managedBashOptions, rebindWorkspaceEnvironment } from '../engine/launch-binding.mjs';
import workspacePolicy from '../engine/prompt-extension.ts';

test('backend Planner target rebinds cwd, HOME/cache/Git and native Bash together', () => {
  const original = process.cwd();
  const originalEnvironment = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'grapher-planner-state-'));
  try {
    const project = join(root, 'source'); mkdirSync(project);
    const run = join(root, '.grapher-worktrees/run');
    const bindings = (label: string) => {
      const state = join(run, '.grapher-state', label, 'process');
      const home = join(state, '.agent-home');
      mkdirSync(home, { recursive: true });
      const config = join(state, 'git-global');
      writeFileSync(config, `[user]\n\tname = ${label}\n`);
      return { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(state, 'cache'),
        npm_config_cache: join(state, 'npm'), GIT_CONFIG_GLOBAL: config, GIT_CEILING_DIRECTORIES: run };
    };
    const a = join(run, 'a'), b = join(run, 'b');
    for (const [path, label] of [[a, 'a'], [b, 'b']]) {
      mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'project-file'), label);
    }
    const ae = bindings('a'), be = bindings('b');
    process.env.GRAPHER_EXECUTION_KIND = 'graph';
    delete process.env.GRAPHER_PLANNER_WORKSPACES_FILE;
    rebindWorkspaceEnvironment(ae, a);
    configurePlannerWorkspace(a, project, project, JSON.stringify({ b: {
      requestedNode: 'b', actualNode: 'b', executionId: 'execution-b', workspace: b, runtimeEnvironment: be,
    }, broken: { requestedNode: 'broken', actualNode: 'broken', executionId: 'broken', workspace: a } }));
    // Keep the target's original spelling as input. On macOS /var is an
    // alias for /private/var, while Pi and the switch use the real cwd.
    const actualB = realpathSync.native(b);
    const target = switchPlannerWorkspace('b');
    assert.equal(target.workspace, actualB);
    assert.equal(process.cwd(), actualB);
    assert.equal(plannerWorkspaceState().workspace, actualB);
    assert.equal(readFileSync('project-file', 'utf8'), 'b', 'arbitrary filesystem APIs follow the selection');
    const env = managedBashOptions({ env: { ...process.env, HOME: project, XDG_CACHE_HOME: project, GIT_CONFIG_GLOBAL: 'wrong' } }).env;
    for (const [key, value] of Object.entries(be)) assert.equal(env[key], value);
    assert.ok(!Object.keys(env).some(key => /^GRAPHER_/i.test(key)), 'Grapher control keys must not reach the model shell');
    assert.equal(env.TMPDIR.replaceAll('\\', '/'), join(be.XDG_CACHE_HOME, 'tmp').replaceAll('\\', '/'), 'session temp is retargeted away from data/');
    assert.equal(env.XDG_RUNTIME_DIR, env.TMPDIR);
    const shell = process.platform === 'win32'
      ? join(resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../..'), 'bin/bash.exe') : '/bin/bash';
    const output = spawnSync(shell, ['--noprofile', '--norc', '-c', 'test "$(cat project-file)" = b && git config --global --get user.name'], { env, encoding: 'utf8' });
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout.trim(), 'b');
    assert.throws(() => switchPlannerWorkspace('broken'), /Invalid backend workspace runtime binding/);
    assert.equal(process.cwd(), actualB, 'a refused binding must not partially switch cwd');
    assert.equal(process.env.HOME, be.HOME);
  } finally {
    process.chdir(original);
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the mandatory Planner extension removes steer identity from every model context', async () => {
  const previous = { ...process.env };
  try {
    process.env.GRAPHER_MODE = 'planner';
    delete process.env.GRAPHER_EXECUTION_KIND;
    delete process.env.GRAPHER_CONTINUE_INTERRUPTED;
    delete process.env.GRAPHER_PLANNER_FOLLOWUP;
    const handlers = new Map<string, Array<(event: any) => any>>();
    const pi = { on(name: string, handler: (event: any) => any) {
      const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
    }, registerTool() {} };
    workspacePolicy(pi as any);
    const id = '12345678-1234-4234-8234-123456789abc';
    const marked = `inspect 🚀\n\n<grapher-steer-id>${id}</grapher-steer-id>`;
    const image = { type: 'image', mimeType: 'image/png', data: 'abc' };
    const stored = [{ role: 'user', content: [{ type: 'text', text: marked }, image] }];
    let messages: any[] = stored;
    for (const handler of handlers.get('context') ?? []) {
      messages = (await handler({ type: 'context', messages }))?.messages ?? messages;
    }
    assert.equal(messages[0].content[0].text, 'inspect 🚀');
    assert.deepEqual(messages[0].content[1], image);
    assert.equal(stored[0].content[0].text, marked, 'the durable Pi session is not rewritten');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
