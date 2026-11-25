// Desktop development launcher. Keeps existing browser `npm run dev` completely
// intact while running Vite (without opening a browser tab) alongside the Tauri
// v2 shell and debug backend binary.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macosDesktopToolchainEnv, toolchainEnv } from './cargo.mjs';
import { backendBuildUpToDate, loadDevEnvironment, recordDevBuildStamp } from './dev.mjs';
import { ensureDependencies, findCargoExecutable, root } from './ensure-deps.mjs';

function spawnInherited(command, args, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32' && /\.cmd$/i.test(command),
    });
    const forward = signal => {
      if (process.platform === 'win32' && child.pid) {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        child.kill(signal);
      }
    };
    const onSigint = () => forward('SIGINT');
    const onSigterm = () => forward('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    child.once('error', error => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      rejectPromise(error);
    });
    child.once('exit', (code, signal) => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (code === 0) resolvePromise(0);
      else resolvePromise(code ?? (signal === 'SIGINT' ? 130 : 143));
    });
  });
}

async function runViteForDesktop() {
  const env = {
    ...loadDevEnvironment(root, process.env),
    GRAPHER_DESKTOP_DEV: '1',
  };
  return spawnInherited(
    process.execPath,
    [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '1420'],
    env,
  );
}

async function runDesktopDev(extraArgs) {
  const env = toolchainEnv({
    ...loadDevEnvironment(root, process.env),
    GRAPHER_DESKTOP_DEV: '1',
  });
  await ensureDependencies({ installationRoot: root, env });
  const cargo = findCargoExecutable(env) ?? 'cargo';
  if (!backendBuildUpToDate(root, env)) {
    console.log('[desktop:dev] Building debug backend binary...');
    execFileSync(
      cargo,
      ['build', '--locked', '--manifest-path', 'backend/Cargo.toml', '--bin', 'grapher'],
      { cwd: root, env, stdio: 'inherit' },
    );
    recordDevBuildStamp(root, env);
  }
  const tauriEnv = macosDesktopToolchainEnv(env);
  if (process.platform === 'darwin' && tauriEnv.SDKROOT && tauriEnv.SDKROOT !== env.SDKROOT) {
    console.log(`[desktop:dev] Using macOS compatibility SDK (${tauriEnv.SDKROOT}).`);
  }
  const tauriJs = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  console.log('[desktop:dev] Starting Tauri v2 desktop shell...');
  if (existsSync(tauriJs)) {
    return spawnInherited(process.execPath, [tauriJs, 'dev', ...extraArgs], tauriEnv);
  }
  const tauriBin = join(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
  );
  return spawnInherited(tauriBin, ['dev', ...extraArgs], tauriEnv);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  try {
    const code = args.includes('--vite-only')
      ? await runViteForDesktop()
      : await runDesktopDev(args);
    process.exitCode = code;
  } catch (error) {
    console.error(`[desktop:dev] ${error.message}`);
    process.exitCode = 1;
  }
}
