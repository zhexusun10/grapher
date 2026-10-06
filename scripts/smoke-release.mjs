// Test the actual archive after extraction away from the build checkout.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
let logs = '';
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
    'scripts/cargo.mjs', 'scripts/bundled-extensions.mjs', 'package.json', 'dist/index.html', 'pi/.git/HEAD',
    'node_modules/pi-trim/extensions/index.ts', 'node_modules/pi-continuity/extensions/index.ts']) {
    assert.ok(existsSync(join(installation, file)), `Missing package file: ${file}`);
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
  console.log(`Release smoke passed: ${platform}-${arch} (CLI, provider IPC, extensions, Graph runtime, backend and UI)`);
} finally {
  if (child?.pid && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('close', resolve));
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      timer.unref();
      await exited;
      clearTimeout(timer);
    }
    if (process.platform === 'win32') await exited;
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
