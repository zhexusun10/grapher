import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkInventory, root, runSteps } from './test.mjs';
import { suiteSteps } from './test-suites.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-tests-中文 space-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'scripts'));
  // macOS may expose its temporary directory through the /var symlink.
  return realpathSync.native(directory);
}

function inventoryFixture(t) {
  const directory = fixture(t);
  const catalog = { small: { steps: [['--test', 'scripts/one.test.mjs']] } };
  const scripts = { 'test:small': 'node scripts/test.mjs small' };
  const save = () => writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts }));
  writeFileSync(join(directory, 'scripts/one.test.mjs'), 'throw new Error("must not execute during inventory");');
  save();
  return { directory, catalog, scripts, save, check: () => checkInventory({ directory, catalog }) };
}

const cli = (...args) => spawnSync(process.execPath, [join(root, 'scripts/test.mjs'), ...args], {
  // The entry point must work from outside the repository too.
  cwd: tmpdir(), encoding: 'utf8',
});

test('every script test has an executable suite and every suite has an npm entry point', () => {
  const inventory = checkInventory();
  assert.ok(inventory.suites > 0);
  assert.ok(inventory.tests > 0);
});

test('suite expansion preserves step order and does not mutate shared commands', () => {
  const catalog = {
    small: { steps: [['--test', 'small.test.mjs']] },
    broad: { steps: [['build.mjs'], { suite: 'small' }, ['accept.mjs']] },
  };
  const steps = suiteSteps('broad', catalog);
  assert.deepEqual(steps, [['build.mjs'], ['--test', 'small.test.mjs'], ['accept.mjs']]);
  steps[1].push('extra');
  assert.deepEqual(suiteSteps('small', catalog), [['--test', 'small.test.mjs']]);
  assert.throws(() => suiteSteps('missing', catalog), /Unknown test suite/);
  assert.throws(() => suiteSteps('toString', catalog), /Unknown test suite/);
  catalog.small.steps = [{ suite: 'broad' }];
  assert.throws(() => suiteSteps('broad', catalog), /cycle: broad -> small -> broad/);
});

test('inventory is read-only and detects unregistered tests, including nested files', t => {
  const f = inventoryFixture(t);
  assert.deepEqual(f.check(), { suites: 1, tests: 1 });
  mkdirSync(join(f.directory, 'scripts/nested'));
  writeFileSync(join(f.directory, 'scripts/nested/two.test.ts'), '');
  assert.throws(f.check, /Tests without a suite:\nscripts\/nested\/two.test.ts/);
  f.catalog.small.steps[0].push('scripts/nested/two.test.ts');
  assert.deepEqual(f.check(), { suites: 1, tests: 2 });
});

test('inventory rejects missing files, duplicate execution and broken npm wiring', t => {
  const f = inventoryFixture(t);
  f.catalog.small.steps.push(['scripts/missing.mjs']);
  assert.throws(f.check, /Missing script/);
  f.catalog.small.steps.pop();
  f.catalog.small.steps.push(['--test', 'scripts/one.test.mjs']);
  assert.throws(f.check, /Duplicate test/);
  f.catalog.small.steps.pop();
  f.scripts['test:small'] = 'node scripts/test.mjs typo';
  f.save();
  assert.throws(f.check, /stale npm entry point/);
  f.scripts['test:small'] = 'node scripts/test.mjs small';
  f.scripts['test:typo'] = 'node scripts/test.mjs typo';
  f.save();
  assert.throws(f.check, /Unknown suite in test:typo/);
});

test('inventory rejects empty suites and invalid argument arrays', t => {
  const f = inventoryFixture(t);
  f.catalog.small.steps = [];
  assert.throws(f.check, /Empty test suite/);
  for (const args of [[], [''], [42]]) {
    f.catalog.small.steps = [args];
    assert.throws(f.check, /Invalid command/);
  }
});

test('CLI lists suites and expanded build prerequisites without executing them', () => {
  const list = cli('--list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /test:frontend/);
  assert.match(list.stdout, /test:environment/);
  const preview = cli('native', '--list');
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /workspace-paths.test.mjs/);
  assert.match(preview.stdout, /planner-workspace-runtime.test.ts/);
  assert.match(preview.stdout, /scripts\/cargo.mjs test/);
  assert.doesNotMatch(preview.stdout, /prewarm/);
  const inventory = cli('--check');
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.match(inventory.stdout, /Test inventory OK/);
});

test('CLI never defaults to all tests or silently ignores unsupported arguments', () => {
  for (const args of [[], ['missing'], ['--unknown'], ['frontend', '--unknown'],
    ['frontend', '--list', 'extra'], ['--list', 'frontend']]) {
    const result = cli(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Usage:|Unknown test suite/);
  }
  assert.equal(cli('--help').status, 0);
});

test('steps preserve arguments/environment/cwd and stop at the first failure', t => {
  const cwd = fixture(t);
  const evidence = join(cwd, 'result.json');
  const sentinel = join(cwd, 'must-not-run');
  const argument = 'spaces 中文 & $HOME "quotes"';
  const code = runSteps([
    ['-e', 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({cwd:process.cwd(),arg:process.argv[2],target:process.env.CARGO_TARGET_DIR})); process.exit(7)', evidence, argument],
    ['-e', 'require("node:fs").writeFileSync(process.argv[1],"unexpected")', sentinel],
  ], { cwd, env: { ...process.env, CARGO_TARGET_DIR: 'caller-owned target' }, log() {} });
  assert.equal(code, 7);
  assert.deepEqual(JSON.parse(readFileSync(evidence, 'utf8')), { cwd, arg: argument, target: 'caller-owned target' });
  assert.equal(existsSync(sentinel), false);
});

test('steps use the current Node without a shell and preserve spawn/signal failures', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };
  assert.equal(runSteps([['one.mjs'], ['two.mjs']], { spawn, log() {} }), 0);
  assert.deepEqual(calls.map(call => call.args), [['one.mjs'], ['two.mjs']]);
  for (const call of calls) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, root);
    assert.equal(call.options.env, process.env);
  }
  const errors = [];
  assert.equal(runSteps([['missing']], {
    spawn: () => ({ error: new Error('spawn failed') }), log() {}, error: message => errors.push(message),
  }), 1);
  assert.deepEqual(errors, ['spawn failed']);
  assert.equal(runSteps([['interrupted']], {
    spawn: () => ({ status: null, signal: 'SIGTERM' }), log() {},
  }), 143);
  assert.equal(runSteps([['unknown exit']], {
    spawn: () => ({ status: null }), log() {},
  }), 1);
});
