import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { configurePlannerWorkspace, switchPlannerWorkspace, plannerWorkspaceState } from '../engine/planner-workspace.ts';
import { managedBashOptions, rebindWorkspaceEnvironment } from '../engine/launch-binding.mjs';

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
    switchPlannerWorkspace('b');
    assert.equal(process.cwd(), b);
    assert.equal(plannerWorkspaceState().workspace, b);
    assert.equal(readFileSync('project-file', 'utf8'), 'b', 'arbitrary filesystem APIs follow the selection');
    const env = managedBashOptions({ env: { ...process.env, HOME: project, XDG_CACHE_HOME: project, GIT_CONFIG_GLOBAL: 'wrong' } }).env;
    for (const [key, value] of Object.entries(be)) assert.equal(env[key], value);
    const shell = process.platform === 'win32'
      ? join(resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../..'), 'bin/bash.exe') : '/bin/bash';
    const output = spawnSync(shell, ['--noprofile', '--norc', '-c', 'test "$(cat project-file)" = b && git config --global --get user.name'], { env, encoding: 'utf8' });
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout.trim(), 'b');
    assert.throws(() => switchPlannerWorkspace('broken'), /Invalid backend workspace runtime binding/);
    assert.equal(process.cwd(), b, 'a refused binding must not partially switch cwd');
    assert.equal(process.env.HOME, be.HOME);
  } finally {
    process.chdir(original);
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    rmSync(root, { recursive: true, force: true });
  }
});
