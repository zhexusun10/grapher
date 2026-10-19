import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ensureDependencies, findCargoExecutable, root } from './ensure-deps.mjs';
import { toolchainEnv, prependPath } from './cargo.mjs';
import { cleanStaleArtifacts } from './clean-stale-artifacts.mjs';

export function loadDevEnvironment(installationRoot, base = process.env) {
  const env = { ...base };
  // Match the backend's first-existing-file and inherited-environment precedence.
  // Pass the same values to Vite so .env-only GRAPHER_PORT cannot split the proxy.
  for (const path of ['.env', 'backend/.env']) {
    let content;
    try { content = readFileSync(join(installationRoot, path), 'utf8'); } catch { continue; }
    for (const line of content.split(/\r?\n/)) {
      const text = line.trim();
      const separator = text.indexOf('=');
      if (text.startsWith('#') || separator < 0) continue;
      const key = text.slice(0, separator).trim();
      if (key && env[key] === undefined) env[key] = text.slice(separator + 1).trim().replace(/^["']+|["']+$/g, '');
    }
    break;
  }
  // Keep the launcher-delivered key casing ("Path" vs "PATH") so the child
  // environment never carries both names, which breaks spawn's executable
  // search on Windows.
  prependPath(env, join(homedir(), '.cargo/bin'));
  return toolchainEnv(env);
}

export function devPort(value, fallback, name) {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

export function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => reject(new Error(`Port ${port} is unavailable (${error.code}). Stop its owner manually or select a different port; dev will not terminate unrelated processes.`)));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}

async function waitForBackend(port, signal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      // /api/ is deliberately a lightweight HTTP readiness probe, not bootstrap
      // (which can load history/providers). GET returns JSON-POST-required (415).
      const response = await fetch(`http://127.0.0.1:${port}/api/`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(800, timeoutMs))]),
      });
      await response.body?.cancel();
      if (response.status === 415) return;
    } catch { signal.throwIfAborted(); }
    await delay(100, undefined, { signal });
  }
  throw new Error(`Backend did not become ready on port ${port} within ${timeoutMs / 1000}s after compilation finished.`);
}

function terminateChild(child, force = false) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
  }
}

// Importable for isolated lifecycle tests; the CLI never accepts custom engine commands.
export async function runDev({
  installationRoot = root, env: baseEnv = process.env, spawnProcess = spawn,
  ensureReady = ensureDependencies, startupTimeoutMs = 60_000,
  cleanStale = cleanStaleArtifacts,
  signals = process, log = console.log, logError = console.error,
} = {}) {
  const children = new Set();
  const controller = new AbortController();
  let stopping = false;
  let stopPromise;
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const onInterrupt = () => { void stop(130); };
  const onTerminate = () => { void stop(143); };
  async function stop(code = 0) {
    if (stopPromise) return stopPromise;
    stopping = true;
    controller.abort();
    signals.off('SIGINT', onInterrupt);
    signals.off('SIGTERM', onTerminate);
    stopPromise = Promise.all([...children].map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
      const timer = setTimeout(() => { terminateChild(child, true); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      terminateChild(child);
    }))).then(() => { finish(code); });
    return stopPromise;
  }
  signals.on('SIGINT', onInterrupt);
  signals.on('SIGTERM', onTerminate);
  const handle = { stop, completed };
  try {
    const env = loadDevEnvironment(installationRoot, baseEnv);
    const frontendPort = devPort(env.GRAPHER_FRONTEND_PORT, 1420, 'GRAPHER_FRONTEND_PORT');
    const backendPort = devPort(env.GRAPHER_PORT, 1421, 'GRAPHER_PORT');
    if (frontendPort === backendPort) throw new Error('Frontend and backend ports must be different.');
    await assertPortAvailable(frontendPort);
    await assertPortAvailable(backendPort);
    const options = { cwd: installationRoot, env, stdio: 'inherit', detached: process.platform !== 'win32' };
    const start = (command, args, overrides = {}) => {
      controller.signal.throwIfAborted();
      const child = spawnProcess(command, args, { ...options, ...overrides });
      children.add(child);
      return child;
    };
    // Downloads, audits and cold compilation have no server-readiness deadline.
    // They are owned children too, so Ctrl+C cancels setup rather than orphaning it.
    const run = (command, args, overrides) => new Promise((resolve, reject) => {
      const child = start(command, args, overrides);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code}).`));
      });
    });
    await ensureReady({ installationRoot, env, run, log });
    const cargo = findCargoExecutable(env) ?? 'cargo';
    const cargoArgs = ['--locked', '--manifest-path', 'backend/Cargo.toml', '--bin', 'grapher'];
    log('[dev] Building backend. The first download/compilation can take several minutes; Ctrl+C cancels.');
    await run(cargo, ['build', ...cargoArgs]);
    controller.signal.throwIfAborted();
    if (typeof cleanStale === 'function') {
      try {
        await cleanStale({ installationRoot, silent: true, log });
      } catch {}
    }
    // Recheck after the potentially long build without killing a new listener.
    await assertPortAvailable(frontendPort);
    await assertPortAvailable(backendPort);
    const watch = (child, label) => {
      child.once('error', error => {
        if (!stopping) { logError(`[dev] Cannot start ${label}: ${error.message}`); void stop(1); }
      });
      child.once('exit', (code, signal) => {
        if (!stopping) { logError(`[dev] ${label} exited unexpectedly (${signal ?? code}).`); void stop(code || 1); }
      });
    };
    log(`[dev] Starting backend; waiting for port ${backendPort}...`);
    const backend = start(cargo, ['run', ...cargoArgs], { env: {
      ...env, GRAPHER_DEV_LAZY_PRIMARY: '1', GRAPHER_DEV_HIDE_BACKEND_URL: '1',
    } });
    watch(backend, 'Backend');
    await waitForBackend(backendPort, controller.signal, startupTimeoutMs);
    controller.signal.throwIfAborted();
    await assertPortAvailable(frontendPort);
    log('[dev] Backend ready. Starting frontend...');
    const frontend = start(process.execPath, [join(installationRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(frontendPort)]);
    watch(frontend, 'Frontend');
  } catch (error) {
    if (!stopping) { logError(`[dev] ${error.message}`); await stop(1); }
  }
  return handle;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dev = await runDev();
  process.exitCode = await dev.completed;
}
