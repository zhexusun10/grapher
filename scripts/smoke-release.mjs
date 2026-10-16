// Test the actual archive after extraction away from the build checkout.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { root, lock } from './pi-baseline.mjs';

const [artifact, platform, arch] = process.argv.slice(2);
const directory = mkdtempSync(join(tmpdir(), 'grapher-smoke-'));
const extracted = join(directory, 'Relocated 安装 # %');
mkdirSync(extracted);
const installation = join(extracted, `grapher-${platform}-${arch}`);
const home = join(directory, 'home');
mkdirSync(home);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SystemRoot|windir|COMSPEC|PATHEXT|TMPDIR|TEMP|TMP|APPDATA|LOCALAPPDATA)$/i.test(key)));
Object.assign(env, {
  HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(directory, 'agent'),
  GRAPHER_GLOBAL_PI_AGENT_DIR: join(directory, 'global'), GRAPHER_ISOLATED_PI_MODELS: '1',
  GRAPHER_DATA_DIR: join(directory, 'data'), GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'runtimes'), GRAPHER_WORKSPACE_PARENT: join(directory, 'workspaces'),
  PI_OFFLINE: '1',
});
let child;
let launcher;
let logs = '';
const stopProcess = async process_ => {
  if (!process_ || !process_.pid || process_.exitCode !== null || process_.signalCode !== null) return;
  const exited = new Promise(resolve => process_.once('close', resolve));
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(process_.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    process_.kill('SIGTERM');
    const timer = setTimeout(() => process_.kill('SIGKILL'), 5000);
    timer.unref();
    clearTimeout(timer);
  }
  await exited;
};
const run = (script, args = [], options = {}) => execFileSync(process.execPath, [join(installation, script), ...args], {
  cwd: directory, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, ...options,
});
try {
  if (platform === 'windows') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:GRAPHER_PACKAGE_ARCHIVE, $env:GRAPHER_PACKAGE_EXTRACT)'], {
      env: { ...process.env, GRAPHER_PACKAGE_ARCHIVE: resolve(artifact), GRAPHER_PACKAGE_EXTRACT: extracted }, stdio: 'inherit',
    });
  } else {
    execFileSync('tar', ['xzf', resolve(artifact), '-C', extracted], { stdio: 'inherit' });
  }
  for (const file of ['scripts/pi-baseline.mjs', 'scripts/pi-dependencies.mjs', 'scripts/prepare-native-runtime.mjs',
    'scripts/cargo.mjs', 'scripts/bundled-extensions.mjs', 'scripts/model-data-manifest.mjs', 'package.json', 'dist/index.html', 'pi/.git/HEAD',
    'node_modules/pi-trim/extensions/index.ts', 'node_modules/pi-continuity/extensions/index.ts',
    'START-HERE.md', platform === 'windows' ? 'start.bat' : 'start.sh']) {
    assert.ok(existsSync(join(installation, file)), `Missing package file: ${file}`);
  }
  assert.match(readFileSync(join(installation, 'START-HERE.md'), 'utf8'), /Node\.js 22\.19\+/);
  if (platform !== 'windows') {
    assert.ok(statSync(join(installation, 'start.sh')).mode & 0o111, 'start.sh must stay executable inside the archive');
  }
  assert.equal(run('engine/entrypoint.mjs', ['--version']).trim(), lock.packageVersion);
  // Real CLI/IPC and bounded local-provider tests, not just a --version check.
  cpSync(join(root, 'scripts/pi-process-contract.test.mjs'), join(installation, 'scripts/pi-process-contract.test.mjs'));
  const contracts = execFileSync(process.execPath, ['--test', join(installation, 'scripts/pi-process-contract.test.mjs')], {
    cwd: directory, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(contracts);
  rmSync(join(installation, 'scripts/pi-process-contract.test.mjs'));
  const runtime = run('scripts/prepare-native-runtime.mjs').trim();
  const graphVersion = execFileSync(process.execPath, [join(runtime, 'engine/entrypoint.mjs'), '--version'], {
    cwd: directory, env, encoding: 'utf8', timeout: 60000,
  }).trim();
  assert.equal(graphVersion, lock.packageVersion, 'Prepared Graph runtime must work without the checkout');

  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  env.GRAPHER_PORT = String(port);

  // The packaged launcher must refuse to start without its runtime
  // prerequisites and explain exactly what to install, instead of crashing.
  const systemRoot = env.SystemRoot ?? env.windir ?? process.env.SystemRoot;
  const shimDirectory = label => {
    const path = join(directory, `shim-${label}`);
    mkdirSync(path);
    return path;
  };
  const writeNodeShim = (shimPath, printedVersion) => {
    if (platform === 'windows') {
      writeFileSync(join(shimPath, 'node.cmd'), `@echo ${printedVersion}\r\n`);
    } else {
      writeFileSync(join(shimPath, 'node'), `#!/bin/sh\n[ "$1" = "-p" ] && echo ${printedVersion}\nexit 0\n`);
      execFileSync('chmod', ['+x', join(shimPath, 'node')]);
    }
  };
  const failClosed = async (label, launcherPath, expected) => {
    try {
      if (platform === 'windows') {
        execFileSync('cmd.exe', ['/d', '/c', join(installation, 'start.bat')], {
          cwd: directory, env: launcherPath, encoding: 'utf8', input: '\n', timeout: 30000, maxBuffer: 1024 * 1024,
        });
      } else {
        execFileSync(join(installation, 'start.sh'), [], {
          cwd: directory, env: launcherPath, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
        });
      }
    } catch (error) {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      assert.match(output, expected, `${label} launcher output: ${output}`);
      return;
    }
    assert.fail(`${label}: the launcher must refuse to start without its prerequisites`);
  };
  const launcherEnv = pathValue => ({ ...env, PATH: pathValue, PATHEXT: '.COM;.EXE;.BAT;.CMD' });
  if (platform === 'windows') {
    await failClosed('missing Node', launcherEnv(join(systemRoot, 'System32')), /\[ERROR\] Node\.js 22\.19\+ was not found on PATH\./);
    const nodeShim = shimDirectory('node');
    writeNodeShim(nodeShim, '22.19.0');
    await failClosed('missing Git', launcherEnv(`${nodeShim};${join(systemRoot, 'System32')}`), /\[ERROR\] Git was not found on PATH\./);
    const oldNode = shimDirectory('old-node');
    writeNodeShim(oldNode, '18.2.0');
    await failClosed('old Node', launcherEnv(`${oldNode};${join(systemRoot, 'System32')}`), /Node\.js 22\.19 or newer is required/);
  } else {
    await failClosed('missing Node', launcherEnv(shimDirectory('empty')), /\[ERROR\] Node\.js 22\.19\+ was not found on PATH\./);
    const nodeShim = shimDirectory('node');
    writeNodeShim(nodeShim, '22.19.0');
    await failClosed('missing Git', launcherEnv(nodeShim), /\[ERROR\] Git was not found on PATH\./);
    const oldNode = shimDirectory('old-node');
    writeNodeShim(oldNode, '18.2.0');
    await failClosed('old Node', launcherEnv(oldNode), /Node\.js 22\.19 or newer is required/);
  }
  // This unique file proves Rust serves the relocated package, not CI's dist.
  writeFileSync(join(installation, 'dist/release-smoke.txt'), 'relocated-release');
  child = spawn(join(installation, platform === 'windows' ? 'grapher.exe' : 'grapher'), [], {
    cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', value => { logs += value; });
  child.stderr.on('data', value => { logs += value; });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Backend exited: ${logs}`);
    try {
      const response = await fetch(`${base}/release-smoke.txt`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && await response.text() === 'relocated-release') { ready = true; break; }
    } catch {}
    await sleep(500);
  }
  assert.ok(ready, `Relocated backend did not serve its assets: ${logs}`);
  const index = await fetch(base);
  assert.equal(await index.text(), readFileSync(join(installation, 'dist/index.html'), 'utf8'));
  const api = async (command, body) => {
    const response = await fetch(`${base}/api/${command}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const value = await response.json();
    assert.ok(response.ok && !value.error, `${command}: ${JSON.stringify(value)}\n${logs}`);
    return value.result;
  };
  const catalog = await api('provider_auth', { version: 1, operation: 'catalog', refresh: false });
  assert.ok(catalog.providers.length > 0 && catalog.models.length > 0);
  const extensions = await api('pi_extensions', { version: 1, operation: 'catalog' });
  for (const id of ['npm:pi-trim', 'npm:pi-continuity']) {
    const extension = extensions.extensions.find(value => value.id === id);
    assert.ok(extension?.bundled && extension.enabled, `${id} must be bundled and enabled`);
    assert.ok(extension.path.replaceAll('\\', '/').includes('Relocated 安装 # %'), 'Backend must load relocated extensions');
  }
  await stopProcess(child);

  // The real launcher must start a serving backend and print its URL. It uses
  // its own data directory so a force-killed lease cannot affect the checks
  // above; this is the last backend this smoke test starts.
  const launcherListener = createServer();
  await new Promise(resolve => launcherListener.listen(0, '127.0.0.1', resolve));
  const launcherPort = launcherListener.address().port;
  await new Promise(resolve => launcherListener.close(resolve));
  const launcherEnvFull = { ...env, GRAPHER_PORT: String(launcherPort), GRAPHER_DATA_DIR: join(directory, 'launcher-data') };
  launcher = spawn(process.platform === 'win32' ? 'cmd.exe' : join(installation, 'start.sh'),
    process.platform === 'win32' ? ['/d', '/c', join(installation, 'start.bat')] : [], {
    cwd: directory, env: launcherEnvFull, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let launcherLogs = '';
  launcher.stdout.on('data', value => { launcherLogs += value; });
  launcher.stderr.on('data', value => { launcherLogs += value; });
  let launcherError;
  launcher.on('error', error => { launcherError = error; });
  let launcherReady = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (launcherError) throw launcherError;
    if (launcher.exitCode !== null) throw new Error(`Launcher backend exited: ${launcherLogs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${launcherPort}`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { launcherReady = true; break; }
    } catch {}
    await sleep(500);
  }
  assert.ok(launcherReady, `The packaged launcher did not serve the UI: ${launcherLogs}`);
  assert.ok(launcherLogs.includes(`http://127.0.0.1:${launcherPort}`), `The launcher must print its URL: ${launcherLogs}`);
  console.log(`Release smoke passed: ${platform}-${arch} (CLI, provider IPC, extensions, Graph runtime, backend, UI and launcher)`);
} finally {
  await stopProcess(child);
  await stopProcess(launcher);
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
