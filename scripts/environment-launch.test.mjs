import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, join, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

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

test('Pi PATH preprocessing and shell startup variables cannot change managed Bash binding', () => {
  const result = run(base(), "console.log(JSON.stringify(managedBashOptions({env:{PATH:'old',Path:'old-too',bAsH_EnV:'poison',ENV:'poison',KEEP:'yes'}}).env))");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { KEEP: 'yes', PATH: dirname(process.execPath) });
});

test('actual native Bash PATH has no implicit MSYS host bins and temporary exports do not rebind the next call', () => {
  const command = `${JSON.stringify(process.execPath.replaceAll('\\', '/'))} -p process.env.PATH`;
  const result = run(base(), `const execute=command=>execFileSync(${JSON.stringify(shell)},['--noprofile','--norc','-c',managedBashCommand(command)],{env:managedBashOptions({env:{...process.env}}).env,encoding:'utf8'}).trim(); execute('export PATH=/temporary'); console.log(execute(${JSON.stringify(command)}))`);
  assert.equal(result.status, 0, result.stderr);
  const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  assert.deepEqual(result.stdout.trim().split(delimiter).map(canonical), [canonical(dirname(process.execPath))]);
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

test('unmanaged compatibility process has no binding or additional PATH processing', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {applyLaunchBinding,managedBashOptions} from ${JSON.stringify(module)}; applyLaunchBinding(); console.log(JSON.stringify(managedBashOptions({env:{PATH:'legacy'}})))`], {
    encoding: 'utf8', env: { ...process.env, GRAPHER_LAUNCH_BINDING: '' }, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { env: { PATH: 'legacy' } });
  assert.ok(delimiter);
});
