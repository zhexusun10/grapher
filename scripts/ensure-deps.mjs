import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingBundledExtensions } from './bundled-extensions.mjs';
import { toolchainEnv, pathValue, prependPath } from './cargo.mjs';
import { verifyPiDependencies } from './pi-dependencies.mjs';
import { piBuildReady } from './pi-build-state.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));

export function findCargoExecutable(env = process.env) {
  if (env.CARGO) return env.CARGO;
  const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  for (const directory of [join(homedir(), '.cargo/bin'), ...pathValue(env).split(delimiter)]) {
    if (directory && existsSync(join(directory, cargoName))) return join(directory, cargoName);
  }
  return null;
}

export function assertSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!(major > 22 || (major === 22 && minor >= 19))) {
    throw new Error(`Node.js 22.19+ is required (found ${version}). Install a supported Node.js release, reopen your terminal, and run npm run dev again.`);
  }
}

export function rootDependenciesReady(installationRoot = root) {
  try {
    const project = json(join(installationRoot, 'package.json'));
    const lock = json(join(installationRoot, 'package-lock.json'));
    for (const group of ['dependencies', 'devDependencies']) {
      if (JSON.stringify(project[group] ?? {}) !== JSON.stringify(lock.packages?.['']?.[group] ?? {})) return false;
    }
    // Include dev dependencies even under NODE_ENV=production, and detect partial
    // installs/lock changes without importing third-party or extension code.
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path) continue;
      const metadata = join(installationRoot, path, 'package.json');
      if (!existsSync(metadata) && entry.optional) continue;
      if (!existsSync(metadata) || json(metadata).version !== entry.version) return false;
    }
    return ['vite/bin/vite.js', 'tsx/dist/cli.mjs', 'typescript/bin/tsc'].every(path =>
      existsSync(join(installationRoot, 'node_modules', path))) && missingBundledExtensions(installationRoot).length === 0;
  } catch {
    return false;
  }
}

export function checkDependenciesFast(installationRoot = root) {
  const missingSubmodule = !existsSync(join(installationRoot, 'pi/package.json'));
  const missingRootModules = !rootDependenciesReady(installationRoot);
  let missingPiDependencies = true;
  if (!missingSubmodule) {
    try { verifyPiDependencies(installationRoot); missingPiDependencies = false; } catch {}
  }
  const missingPiDist = !piBuildReady(installationRoot);
  const cargoPath = findCargoExecutable();
  return { missingSubmodule, missingRootModules, missingPiDependencies, missingPiDist, cargoPath,
    missingCargo: !cargoPath,
    allReady: !missingSubmodule && !missingRootModules && !missingPiDependencies && !missingPiDist && !!cargoPath };
}

export async function ensureDependencies({
  installationRoot = root, env = process.env, run = execFileSync,
  cargoPath = findCargoExecutable(env), log = console.log,
} = {}) {
  assertSupportedNode();
  // Fail before network/download work if the host cannot build the backend.
  if (!cargoPath) throw new Error('Rust/Cargo is required. Install stable Rust from https://rustup.rs/ and your native compiler/linker, reopen your terminal, then run npm run dev again.');
  const childEnv = toolchainEnv(prependPath({ ...env }, dirname(cargoPath)));
  const options = { cwd: installationRoot, env: childEnv, stdio: 'inherit' };
  for (const [command, name] of [['git', 'Git'], [cargoPath, 'Rust/Cargo']]) {
    try { await run(command, ['--version'], { ...options, stdio: 'pipe' }); }
    catch { throw new Error(`${name} is not usable. Install ${name === 'Git' ? 'Git (Git for Windows includes Bash)' : 'a stable Rust toolchain from https://rustup.rs/ and native compiler/linker tools'}, reopen your terminal, and run npm run dev again.`); }
  }
  const npmCli = env.npm_execpath;
  const runNpm = async args => {
    if (npmCli && existsSync(npmCli)) return run(process.execPath, [npmCli, ...args], options);
    if (process.platform === 'win32') throw new Error('Start setup with npm run dev so npm_execpath is available.');
    return run('npm', args, options);
  };

  if (!existsSync(join(installationRoot, 'pi/package.json'))) {
    log('[dev] Initializing the pinned Pi submodule...');
    await run('git', ['submodule', 'update', '--init', '--recursive'], options);
  }
  if (!rootDependenciesReady(installationRoot)) {
    log('[dev] Installing locked Grapher dependencies (including development tools)...');
    try { await runNpm(['ci', '--ignore-scripts', '--include=dev']); }
    catch { throw new Error('Locked npm installation failed. Check the error above, network/proxy access and package-lock.json, then retry npm run dev. Startup does not fall back to npm install or rewrite the lockfile.'); }
    if (!rootDependenciesReady(installationRoot)) throw new Error('npm ci completed but required Grapher dependencies are still missing; check npm omit/optional settings and retry npm run dev.');
  }
  let action = 'build';
  try { verifyPiDependencies(installationRoot); } catch { action = 'setup'; }
  if (action === 'setup' || !piBuildReady(installationRoot)) {
    log(`[dev] Preparing Pi (${action === 'setup' ? 'install, audit and build' : 'rebuild from local reviewed dependencies'})...`);
    await run(process.execPath, [join(installationRoot, 'scripts/pi-baseline.mjs'), action], options);
    verifyPiDependencies(installationRoot);
    if (!piBuildReady(installationRoot)) throw new Error('Pi build is incomplete or stale. Inspect the error above and run npm run pi:setup.');
  }
  log('[dev] Dependencies ready.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureDependencies().catch(error => { console.error(`[dev] ${error.message}`); process.exitCode = 1; });
}
