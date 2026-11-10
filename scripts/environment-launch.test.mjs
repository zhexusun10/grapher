import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, join, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { managedBashCommand } from '../engine/launch-binding.mjs';

const shell = process.platform === 'win32'
  ? join(resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../..'), 'bin/bash.exe') : '/bin/bash';
const module = pathToFileURL(resolve('engine/launch-binding.mjs')).href;
const base = () => ({ entry: process.execPath, path: [dirname(process.execPath)], shell, variables: { LAUNCH_TEST: 'configured' }, inherit: [], hook: null });
const run = (launch, code, extra = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-launch-'));
  try {
    const binding = join(directory, 'launch.json'); writeFileSync(binding, JSON.stringify(launch));
    return spawnSync(process.execPath, ['--input-type=module', '-e', `import {applyLaunchBinding,managedBashOptions,managedBashCommand} from ${JSON.stringify(module)}; import {execFileSync} from 'node:child_process'; applyLaunchBinding(); ${code}`], {
      encoding: 'utf8', env: { ...process.env, GRAPHER_LAUNCH_BINDING: binding, GRAPHER_MODE: 'node', ...extra }, timeout: 15000,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
};

test('declared hook runs before factories and cannot change Pi/Runtime identity or Shell bootstrap', () => {
  const launch = base();
  launch.hook = 'export LAUNCH_TEST=hook; export CONDA_PREFIX="declared-prefix"; export GRAPHER_MODE=other; export NODE_OPTIONS=poison; export BASH_ENV=poison';
  const result = run(launch, "console.log(JSON.stringify({value:process.env.LAUNCH_TEST,prefix:process.env.CONDA_PREFIX,role:process.env.GRAPHER_MODE,options:process.env.NODE_OPTIONS,bash:process.env.BASH_ENV}))");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { value: 'hook', prefix: 'declared-prefix', role: 'node' });
});

test('Pi PATH preprocessing cannot change an explicit managed Bash PATH and shell controls are preserved', () => {
  const result = run(base(), "console.log(JSON.stringify(managedBashOptions({env:{PATH:'old',Path:'old-too',bAsH_EnV:'startup',ENV:'startup-env',SHELLOPTS:'pipefail',BASHOPTS:'nullglob',CDPATH:'project-cd',OLDPWD:'previous-dir',GLOBIGNORE:'*.tmp',PYTHONDONTWRITEBYTECODE:'0',KEEP:'yes'}}).env))");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    bAsH_EnV: 'startup', ENV: 'startup-env', SHELLOPTS: 'pipefail', BASHOPTS: 'nullglob',
    CDPATH: 'project-cd', OLDPWD: 'previous-dir', GLOBIGNORE: '*.tmp',
    PYTHONDONTWRITEBYTECODE: '1', KEEP: 'yes', PATH: dirname(process.execPath),
  });
});

test('a managed shell without an explicit environment preserves PATH and shell controls', () => {
  const moduleUrl = JSON.stringify(module);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {managedBashOptions} from ${moduleUrl}; console.log(JSON.stringify(managedBashOptions({env:{PATH:'host-path',BASH_ENV:'host-startup',SHELLOPTS:'pipefail',TMPDIR:'host-tmp'}},true).env))`], {
    encoding: 'utf8', env: { ...process.env, GRAPHER_LAUNCH_BINDING: '', GRAPHER_EXECUTION_KIND: '' }, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const env = JSON.parse(result.stdout);
  assert.equal(env.PATH, 'host-path');
  assert.equal(env.BASH_ENV, 'host-startup');
  assert.equal(env.SHELLOPTS, 'pipefail');
  assert.equal(env.TMPDIR, 'host-tmp');
});

test('a source-direct Graph Node Agent retains host temp variables while private roles get cache scratch', () => {
  const moduleUrl = JSON.stringify(module);
  const cache = mkdtempSync(join(tmpdir(), 'grapher-bash-cache-'));
  const runOptions = (kind, agentKind) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {managedBashOptions} from ${moduleUrl}; console.log(JSON.stringify(managedBashOptions({env:{PATH:'host-path',XDG_CACHE_HOME:${JSON.stringify(cache)},TMPDIR:'host-tmp',TMP:'host-TMP',TEMP:'host-TEMP'}},true).env))`], {
      encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache, GRAPHER_LAUNCH_BINDING: '', GRAPHER_MODE: 'node', GRAPHER_EXECUTION_KIND: kind, GRAPHER_AGENT_KIND: agentKind }, timeout: 15000,
    });
  try {
    const source = runOptions('source', 'node');
    assert.equal(source.status, 0, source.stderr);
    const hostEnv = JSON.parse(source.stdout);
    assert.equal(hostEnv.TMPDIR, 'host-tmp');
    assert.equal(hostEnv.TMP, 'host-TMP');
    assert.equal(hostEnv.TEMP, 'host-TEMP');
    const graph = runOptions('graph', 'node');
    assert.equal(graph.status, 0, graph.stderr);
    const privateEnv = JSON.parse(graph.stdout);
    const scratch = `${cache.replace(/[\\/]+$/, '')}/tmp`;
    assert.equal(privateEnv.TMPDIR, scratch);
    assert.equal(privateEnv.TMP, scratch);
    assert.equal(privateEnv.TEMP, scratch);
  } finally { rmSync(cache, { recursive: true, force: true }); }
});

test('actual native Bash PATH has no implicit MSYS host bins and temporary exports do not rebind the next call', () => {
  const command = `${JSON.stringify(process.execPath.replaceAll('\\', '/'))} -p process.env.PATH`;
  const result = run(base(), `const execute=command=>execFileSync(${JSON.stringify(shell)},['--noprofile','--norc','-c',managedBashCommand(command)],{env:managedBashOptions({env:{...process.env}}).env,encoding:'utf8'}).trim(); execute('export PATH=/temporary'); console.log(execute(${JSON.stringify(command)}))`);
  assert.equal(result.status, 0, result.stderr);
  const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  assert.deepEqual(result.stdout.trim().split(delimiter).map(canonical), [canonical(dirname(process.execPath))]);
});

test('workspace cwd restoration works in Bash and Pi fallback POSIX sh', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-shell-cwd-'));
  const workspace = join(directory, 'workspace');
  const startupCwd = join(directory, 'startup cwd');
  const startup = join(directory, 'bash-env');
  try {
    mkdirSync(workspace);
    mkdirSync(startupCwd);
    writeFileSync(startup, `cd '${startupCwd.replaceAll("'", "'\\''")}'\ncd() { return 91; }\nshopt -s expand_aliases\nalias builtin='false'\n`);
    const command = managedBashCommand('pwd -P', workspace);
    for (const executable of ['/bin/bash', '/bin/sh']) {
      const result = execFileSync(executable, ['-c', command], {
        cwd: startupCwd,
        env: { ...process.env, BASH_ENV: startup },
        encoding: 'utf8',
      }).trim();
      assert.equal(resolve(result), resolve(workspace), executable);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('symlinked PATH directories identify the declared entry directory', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-launch-alias-'));
  try {
    const real = join(directory, 'real');
    const alias = join(directory, 'alias');
    mkdirSync(real);
    symlinkSync(real, alias, 'dir');
    const entry = join(real, 'node');
    symlinkSync(process.execPath, entry);
    const result = run({ ...base(), entry, path: [alias] }, '');
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('failed activation, replaced default PATH and corrupted reserved variables fail closed', () => {
  for (const hook of ['exit 3', 'export PATH=/a-different-default']) {
    const result = run({ ...base(), hook }, "console.log('FACTORY_RAN')");
    assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout, /FACTORY_RAN/);
  }
  for (const key of ['NODE_OPTIONS', 'GRAPHER_MODE', 'PI_CODING_AGENT_DIR', 'PATH']) {
    const result = run({ ...base(), variables: { [key]: 'poison' } }, "console.log('FACTORY_RAN')");
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Invalid native launch/); assert.doesNotMatch(result.stdout, /FACTORY_RAN/);
  }
});

test('an explicit leased CUDA UUID overrides hook/device visibility before factories and Bash subprocesses', () => {
  const id = 'GPU-01234567-89ab-cdef-0123-456789abcdef';
  const launch = base(); launch.hook = `test "$CUDA_VISIBLE_DEVICES" = '${id}' || exit 9; export CUDA_VISIBLE_DEVICES=all-host-devices; export HIP_VISIBLE_DEVICES=0`;
  const result = run(launch, "const env=managedBashOptions({env:{CUDA_VISIBLE_DEVICES:'host-default'}}).env; const child=execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify({device:process.env.CUDA_VISIBLE_DEVICES,order:process.env.CUDA_DEVICE_ORDER,hip:process.env.HIP_VISIBLE_DEVICES}))'],{env,encoding:'utf8'}); console.log(JSON.stringify({device:process.env.CUDA_VISIBLE_DEVICES,order:process.env.CUDA_DEVICE_ORDER,hip:process.env.HIP_VISIBLE_DEVICES,child:JSON.parse(child)}))", {
    GRAPHER_ACCELERATOR_BINDING: JSON.stringify({ backend: 'cuda', ids: [id], probe: 'trusted-native-probe' }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    device: id, order: 'PCI_BUS_ID', hip: '',
    child: { device: id, order: 'PCI_BUS_ID', hip: '' },
  });
});

test('activation hooks and managed Bash environment retain external runtime paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-state-binding-'));
  try {
    const launch = base();
    launch.variables = { HOME: directory, USERPROFILE: directory, XDG_CACHE_HOME: join(directory, 'cache'), npm_config_cache: join(directory, 'npm') };
    launch.hook = 'export HOME=.; export USERPROFILE=.; export XDG_CACHE_HOME=.; export npm_config_cache=.';
    const result = run(launch, "const explicit=managedBashOptions({env:{HOME:'in-project',npm_config_cache:'in-project'}}).env; const implicit=managedBashOptions({}).env; console.log(JSON.stringify({home:process.env.HOME,cache:process.env.XDG_CACHE_HOME,explicit:explicit.HOME,npm:explicit.npm_config_cache,implicit:implicit.HOME}))");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { home: directory, cache: join(directory, 'cache'), explicit: directory, npm: join(directory, 'npm'), implicit: directory });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unmanaged compatibility process has no binding or additional PATH processing', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {applyLaunchBinding,managedBashOptions} from ${JSON.stringify(module)}; applyLaunchBinding(); console.log(JSON.stringify(managedBashOptions({env:{PATH:'legacy'}})))`], {
    encoding: 'utf8', env: { ...process.env, GRAPHER_LAUNCH_BINDING: '' }, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { env: { PATH: 'legacy' } });
  assert.ok(delimiter);
});
