import { spawn, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ensureDependencies, findCargoExecutable, root } from './ensure-deps.mjs';
import { toolchainEnv, prependPath } from './cargo.mjs';
import { cleanStaleArtifacts } from './clean-stale-artifacts.mjs';

function devDebugDir(installationRoot, env = process.env) {
  const targetBase = env.CARGO_TARGET_DIR
    ? resolve(installationRoot, env.CARGO_TARGET_DIR)
    : join(installationRoot, 'backend', 'target');
  return join(targetBase, 'debug');
}

export function devBackendExecutable(installationRoot, env = process.env) {
  const debugDir = devDebugDir(installationRoot, env);
  const binary = join(debugDir, process.platform === 'win32' ? 'grapher.exe' : 'grapher');
  // On macOS, even a no-op `cargo build` unlinks and re-clones `target/debug/grapher`
  // with a fresh inode, invalidating AMFI/XProtect binary trust caching (~500ms per launch).
  // The underlying `deps/grapher-<hash>` keeps a stable inode until rustc actually relinks.
  if (process.platform === 'darwin' && existsSync(binary)) {
    try {
      const binStat = lstatSync(binary);
      const depsDir = join(debugDir, 'deps');
      const matches = [];
      for (const name of readdirSync(depsDir)) {
        if (!/^grapher-[0-9a-f]{16}$/.test(name)) continue;
        const candidate = join(depsDir, name);
        const stat = lstatSync(candidate);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size === binStat.size && Math.trunc(stat.mtimeMs) === Math.trunc(binStat.mtimeMs)) {
          matches.push(candidate);
        }
      }
      if (matches.length === 1) return matches[0];
    } catch {}
  }
  return binary;
}

export function backendBuildUpToDate(installationRoot, env = process.env) {
  if (env.GRAPHER_FORCE_BUILD === '1' || env.RUSTFLAGS || env.CARGO_ENCODED_RUSTFLAGS) {
    return false;
  }
  if (Object.keys(env).some(key => key.startsWith('CARGO_PROFILE_DEV_'))) {
    return false;
  }
  try {
    const debugDir = devDebugDir(installationRoot, env);
    const binary = join(debugDir, process.platform === 'win32' ? 'grapher.exe' : 'grapher');
    const binStat = statSync(binary);
    if (!binStat.isFile() || binStat.size === 0) return false;
    if (!existsSync(join(debugDir, '.fingerprint'))) return false;
    const binaryMtimeMs = binStat.mtimeMs;

    const isFresh = path => statSync(path).mtimeMs < binaryMtimeMs;
    for (const file of ['backend/Cargo.toml', 'backend/Cargo.lock', 'backend/build.rs']) {
      if (!isFresh(join(installationRoot, file))) return false;
    }
    for (const optional of ['.cargo/config.toml', 'backend/.cargo/config.toml']) {
      const path = join(installationRoot, optional);
      if (existsSync(path) && !isFresh(path)) return false;
    }

    // Check both directory mtimes (catches deletions/renames) and file mtimes.
    const treeFresh = directory => {
      if (!isFresh(directory)) return false;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!treeFresh(child)) return false;
        } else if (!isFresh(child)) {
          return false;
        }
      }
      return true;
    };
    for (const dir of ['backend/src', 'backend/resources']) {
      if (!treeFresh(join(installationRoot, dir))) return false;
    }

    // Debug `build.rs` embeds HEAD commit; rebuild if HEAD moved.
    const dotGit = join(installationRoot, '.git');
    if (existsSync(dotGit)) {
      let gitDir = dotGit;
      const dotGitStat = statSync(dotGit);
      if (dotGitStat.isFile()) {
        if (!isFresh(dotGit)) return false;
        const pointer = readFileSync(dotGit, 'utf8').trim();
        if (!pointer.startsWith('gitdir:')) return false;
        gitDir = resolve(installationRoot, pointer.slice(7).trim());
      }
      const headPath = join(gitDir, 'HEAD');
      if (existsSync(headPath)) {
        if (!isFresh(headPath)) return false;
        const head = readFileSync(headPath, 'utf8').trim();
        if (head.startsWith('ref:')) {
          const refRel = head.slice(4).trim();
          const refPath = join(gitDir, refRel);
          if (existsSync(refPath) && !isFresh(refPath)) return false;
          const packedRefs = join(gitDir, 'packed-refs');
          if (existsSync(packedRefs) && !isFresh(packedRefs)) return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

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
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      // /api/ is deliberately a lightweight HTTP readiness probe, not bootstrap
      // (which can load history/providers). GET returns JSON-POST-required (415).
      const response = await fetch(`http://127.0.0.1:${port}/api/`, {
        headers: { Connection: 'close' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(800, timeoutMs))]),
      });
      await response.body?.cancel();
      if (response.status === 415) return;
    } catch { signal.throwIfAborted(); }
    const elapsed = Date.now() - started;
    const pollMs = elapsed < 300 ? 15 : elapsed < 1000 ? 40 : 100;
    await delay(pollMs, undefined, { signal });
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
  // Closing the terminal window sends SIGHUP. Treat it like other shutdown
  // signals so detached backend/Vite process groups are not left running.
  const onHangup = process.platform === 'win32' ? null : () => { void stop(129); };
  async function stop(code = 0) {
    if (stopPromise) return stopPromise;
    stopping = true;
    controller.abort();
    signals.off('SIGINT', onInterrupt);
    signals.off('SIGTERM', onTerminate);
    if (onHangup) signals.off('SIGHUP', onHangup);
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
  if (onHangup) signals.on('SIGHUP', onHangup);
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
    // Keep Cargo's versioned progress lines out of startup; warnings and errors
    // still inherit the terminal, alongside our version-independent status.
    const cargoArgs = ['--quiet', '--locked', '--manifest-path', 'backend/Cargo.toml', '--bin', 'grapher'];
    const skipBuild = backendBuildUpToDate(installationRoot, env);
    if (!skipBuild) {
      log('[dev] Building backend. The first download/compilation can take several minutes; Ctrl+C cancels.');
      await run(cargo, ['build', ...cargoArgs]);
      controller.signal.throwIfAborted();
      // Recheck after the potentially long build without killing a new listener.
      await assertPortAvailable(frontendPort);
      await assertPortAvailable(backendPort);
    }
    const watch = (child, label) => {
      child.once('error', error => {
        if (!stopping) { logError(`[dev] Cannot start ${label}: ${error.message}`); void stop(1); }
      });
      child.once('exit', (code, signal) => {
        if (!stopping) { logError(`[dev] ${label} exited unexpectedly (${signal ?? code}).`); void stop(code || 1); }
      });
    };
    log(`[dev] Starting backend; waiting for port ${backendPort}...`);
    const backendEnv = {
      ...env, GRAPHER_DEV_LAZY_PRIMARY: '1', GRAPHER_DEV_HIDE_BACKEND_URL: '1',
    };
    // Cargo just built this target; launch the compiled binary directly when
    // present instead of paying for a second `cargo run` invocation on every start.
    const compiledBinary = devBackendExecutable(installationRoot, env);
    const backend = existsSync(compiledBinary)
      ? start(compiledBinary, [], { env: backendEnv })
      : start(cargo, ['run', ...cargoArgs], { env: backendEnv });
    watch(backend, 'Backend');
    await waitForBackend(backendPort, controller.signal, startupTimeoutMs);
    controller.signal.throwIfAborted();
    await assertPortAvailable(frontendPort);
    log('[dev] Backend ready. Starting frontend...');
    const frontend = start(process.execPath, [join(installationRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(frontendPort)]);
    watch(frontend, 'Frontend');
    // Stale Cargo artifact cleanup is housekeeping, not a startup prerequisite.
    // Defer it until after Vite and the initial page load settle.
    if (typeof cleanStale === 'function') {
      void delay(3000, undefined, { signal: controller.signal })
        .then(() => cleanStale({ installationRoot, env, silent: true, log, signal: controller.signal }))
        .catch(() => {});
    }
  } catch (error) {
    if (!stopping) { logError(`[dev] ${error.message}`); await stop(1); }
  }
  return handle;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dev = await runDev();
  process.exitCode = await dev.completed;
}
