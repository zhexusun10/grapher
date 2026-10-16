// Own only targets created here. Never sweep a caller's CARGO_TARGET_DIR,
// the normal backend/target, runtime data, or another invocation's directory.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const markerName = '.grapher-temporary-target.json';

export async function createTemporaryTarget({ env = process.env, parent = tmpdir(), warn = console.warn } = {}) {
  if (env.CARGO_TARGET_DIR) {
    const directory = resolve(env.CARGO_TARGET_DIR);
    return { directory, owned: false, env: { ...env, CARGO_TARGET_DIR: directory }, cleanup: async () => true };
  }
  const directory = await mkdtemp(join(await realpath(parent), 'grapher-rust-'));
  const canonical = await realpath(directory);
  const marker = join(directory, markerName);
  const identity = { version: 1, owner: randomUUID() };
  try {
    await writeFile(marker, JSON.stringify(identity), { flag: 'wx' });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  let cleaned = false;
  return {
    directory, owned: true, env: { ...env, CARGO_TARGET_DIR: directory },
    async cleanup() {
      if (cleaned) return true;
      try {
        const stat = await lstat(directory).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!stat) { cleaned = true; return true; }
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== canonical) {
          throw new Error('temporary target was replaced or redirected');
        }
        const markerStat = await lstat(marker);
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('invalid target ownership marker');
        const saved = JSON.parse(await readFile(marker, 'utf8'));
        if (saved.version !== identity.version || saved.owner !== identity.owner) throw new Error('target ownership changed');
        // Keep the ownership marker until all generated files are gone. Locked
        // executables leave a marked, retryable directory instead of losing proof.
        for (const name of await readdir(directory)) {
          if (name !== markerName) await rm(join(directory, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
        await unlink(marker);
        await rmdir(directory);
        cleaned = true;
        return true;
      } catch (error) {
        warn(`[rust-target] Cleanup deferred; retained ${directory}: ${error.message}`);
        return false;
      }
    },
  };
}

export async function withTemporaryTarget(work, options = {}) {
  const target = await createTemporaryTarget(options);
  try {
    return await work(target.env, target);
  } finally {
    await target.cleanup();
  }
}

function terminate(child, signal, force = false) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : signal); }
    catch { try { child.kill(force ? 'SIGKILL' : signal); } catch {} }
  }
}

export async function runWithTemporaryTarget(args, options = {}) {
  if (!args.length) throw new Error('A command is required');
  return withTemporaryTarget(async (env, target) => {
    if (target.owned) console.error(`[rust-target] Disposable Cargo target: ${target.directory}`);
    const child = spawn(args[0], args.slice(1), {
      env, stdio: options.stdio ?? 'inherit', detached: process.platform !== 'win32',
    });
    let interrupted;
    let timer;
    const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
      interrupted ??= signal;
      terminate(child, signal);
      timer ??= setTimeout(() => terminate(child, signal, true), 5000).unref();
    }]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    try {
      const result = await new Promise((completed, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => completed({ code, signal }));
      });
      const signal = interrupted ?? result.signal;
      return { code: signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : result.code ?? 1, signal };
    } finally {
      clearTimeout(timer);
      for (const [signal, handler] of handlers) process.off(signal, handler);
    }
  }, options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  if (!args.length) {
    console.error('Usage: temporary-target.mjs -- node <script> [arguments...] OR --npm-script <name> [arguments...]');
    process.exitCode = 2;
  } else {
    try {
      if (args[0] === '--npm-script') {
        const [, script, ...extra] = args;
        if (!script || !process.env.npm_execpath) throw new Error('--npm-script requires a script name and must be invoked through npm run');
        // Invoke npm through Node, not npm.cmd/shell quoting on Windows. Its
        // complete build/test chain inherits the same disposable target.
        args = [process.execPath, process.env.npm_execpath, 'run', script, ...(extra.length ? ['--', ...extra] : [])];
      }
      process.exitCode = (await runWithTemporaryTarget(args)).code;
    } catch (error) { console.error(`[rust-target] ${error.message}`); process.exitCode = 1; }
  }
}
