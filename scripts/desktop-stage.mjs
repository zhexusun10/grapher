// Stage the relocatable Pi/engine/frontend runtime, compiled backend binary,
// and matching pinned Node.js runtime into `src-tauri/resources/` for Tauri v2
// desktop bundling (macOS arm64/x64 and Windows x64).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledExtensionNames, verifyBundledExtensions } from './bundled-extensions.mjs';
import { toolchainEnv } from './cargo.mjs';
import { findCargoExecutable, root } from './ensure-deps.mjs';
import {
  buildBundledPiManifest,
  BUNDLED_PI_MANIFEST_FILE,
  lock as piBaselineLock,
  verifyBaseline,
} from './pi-baseline.mjs';
import {
  computeRuntimeDependencyKeys,
  corePackages,
  PI_DEPENDENCIES_MODE_RUNTIME_ONLY,
  verifyDependencyProfile,
  verifyPiDependencies,
} from './pi-dependencies.mjs';

export const PINNED_NODE_VERSION = '22.19.0';

export const DESKTOP_TARGETS = {
  'macos-arm64': {
    id: 'macos-arm64',
    platform: 'darwin',
    arch: 'arm64',
    rustTriple: 'aarch64-apple-darwin',
    backendBinary: 'grapher',
    nodeRelPath: 'node/bin/node',
    nodeArchive: `node-v${PINNED_NODE_VERSION}-darwin-arm64.tar.gz`,
    nodeArchiveEntry: `node-v${PINNED_NODE_VERSION}-darwin-arm64/bin/node`,
    nodeSha256: 'c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d',
    bundleKind: 'dmg',
  },
  'macos-x64': {
    id: 'macos-x64',
    platform: 'darwin',
    arch: 'x64',
    rustTriple: 'x86_64-apple-darwin',
    backendBinary: 'grapher',
    nodeRelPath: 'node/bin/node',
    nodeArchive: `node-v${PINNED_NODE_VERSION}-darwin-x64.tar.gz`,
    nodeArchiveEntry: `node-v${PINNED_NODE_VERSION}-darwin-x64/bin/node`,
    nodeSha256: '3cfed4795cd97277559763c5f56e711852d2cc2420bda1cea30c8aa9ac77ce0c',
    bundleKind: 'dmg',
  },
  'windows-x64': {
    id: 'windows-x64',
    platform: 'win32',
    arch: 'x64',
    rustTriple: 'x86_64-pc-windows-msvc',
    backendBinary: 'grapher.exe',
    nodeRelPath: 'node/node.exe',
    nodeArchive: `node-v${PINNED_NODE_VERSION}-win-x64.zip`,
    nodeArchiveEntry: `node-v${PINNED_NODE_VERSION}-win-x64/node.exe`,
    nodeSha256: 'ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86',
    bundleKind: 'nsis',
  },
};

export function resolveDesktopTarget(spec, platform = process.platform, arch = process.arch) {
  if (!spec) {
    for (const target of Object.values(DESKTOP_TARGETS)) {
      if (target.platform === platform && target.arch === arch) return target;
    }
    throw new Error(
      `Unsupported host platform/arch for desktop bundling: ${platform}/${arch}. Supported targets: ${Object.keys(DESKTOP_TARGETS).join(', ')}.`,
    );
  }
  if (Object.hasOwn(DESKTOP_TARGETS, spec)) return DESKTOP_TARGETS[spec];
  const byTriple = Object.values(DESKTOP_TARGETS).find(target => target.rustTriple === spec);
  if (byTriple) return byTriple;
  throw new Error(
    `Unknown desktop target "${spec}". Supported targets: ${Object.keys(DESKTOP_TARGETS).join(', ')}.`,
  );
}

export function hostTargetMatches(target, platform = process.platform, arch = process.arch) {
  return target.platform === platform && target.arch === arch;
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function assertMinimumNodeVersion(versionText, minMajor = 22, minMinor = 19) {
  const cleaned = versionText.trim().replace(/^v/i, '');
  const parts = cleaned.split('.').map(Number);
  const [major, minor] = parts;
  if (
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < minMajor ||
    (major === minMajor && minor < minMinor)
  ) {
    throw new Error(
      `Bundled Node.js must be >= ${minMajor}.${minMinor}.0 (found ${versionText.trim()}).`,
    );
  }
  return cleaned;
}

/**
 * Replace any symbolic links inside `directory` with concrete copies of their
 * targets so Tauri v2's `WalkDir`-based resource bundler preserves workspace
 * bindings (`pi/node_modules/@earendil-works/*`) instead of skipping directory
 * symlinks.
 */
export function dereferenceSymlinksInPlace(directory) {
  const visitedAncestors = new Set();
  const walk = current => {
    const physical = realpathSync.native(current);
    if (visitedAncestors.has(physical)) {
      throw new Error(`Cyclic directory detected while staging desktop resources: ${current}`);
    }
    visitedAncestors.add(physical);
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const fullPath = join(current, entry.name);
        const linkMeta = lstatSync(fullPath);
        if (linkMeta.isSymbolicLink()) {
          let targetStat;
          try {
            targetStat = statSync(fullPath);
          } catch {
            // Remove dangling `.bin` symlinks that cannot be bundled.
            rmSync(fullPath, { force: true });
            continue;
          }
          const resolvedTarget = realpathSync.native(fullPath);
          if (targetStat.isDirectory()) {
            const tempCopy = `${fullPath}.grapher-deref-${process.pid}`;
            rmSync(tempCopy, { recursive: true, force: true });
            cpSync(resolvedTarget, tempCopy, { recursive: true, dereference: true });
            rmSync(fullPath, { force: true });
            renameSync(tempCopy, fullPath);
            walk(fullPath);
          } else if (targetStat.isFile()) {
            const tempCopy = `${fullPath}.grapher-deref-${process.pid}`;
            rmSync(tempCopy, { force: true });
            cpSync(resolvedTarget, tempCopy, { dereference: true });
            rmSync(fullPath, { force: true });
            renameSync(tempCopy, fullPath);
          } else {
            rmSync(fullPath, { force: true });
          }
        } else if (linkMeta.isDirectory()) {
          walk(fullPath);
        }
      }
    } finally {
      visitedAncestors.delete(physical);
    }
  };
  walk(directory);
}

export function findRemainingSymlinks(directory) {
  const symlinks = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      const meta = lstatSync(fullPath);
      if (meta.isSymbolicLink()) {
        symlinks.push(fullPath);
      } else if (meta.isDirectory()) {
        walk(fullPath);
      }
    }
  };
  walk(directory);
  return symlinks;
}

/**
 * Tauri's resource bundler only emits files and skips empty directories.
 * Standalone cloned `.git/` metadata stores refs in `packed-refs`, leaving
 * `.git/refs/` empty, which causes Git to reject the directory as a repository
 * after bundling. Materializing a valid ref under `.git/refs/heads/` keeps
 * `.git/refs/` non-empty across macOS `.app` and Windows NSIS bundles while
 * leaving `HEAD` and `git status` untouched.
 */
export function ensureBundleableGitMetadata(piDir) {
  const gitDir = join(piDir, '.git');
  const headPath = join(gitDir, 'HEAD');
  if (!existsSync(headPath)) {
    throw new Error(`Staged Pi runtime is missing standalone .git/HEAD: ${headPath}`);
  }
  const head = readFileSync(headPath, 'utf8').trim();
  if (!/^[a-f0-9]{40}$/.test(head)) {
    throw new Error(`Expected detached commit SHA in ${headPath}, found: ${head}`);
  }
  const headsDir = join(gitDir, 'refs', 'heads');
  mkdirSync(headsDir, { recursive: true });
  writeFileSync(join(headsDir, 'grapher-baseline'), `${head}\n`);
}

const NODE_MODULES_BLOAT_FILE = /(?:\.d\.[cm]?ts|\.map|\.(?:md|markdown))$/i;
const PRESERVED_LEGAL_FILE = /^(?:license|notice|copying)/i;

/**
 * Remove non-runtime type declarations, source maps, and Markdown docs from
 * staged `node_modules` directories while keeping runtime code, `package.json`,
 * and license/notice files intact.
 */
export function pruneNodeModulesBloat(directory) {
  let removedFiles = 0;
  let removedBytes = 0;
  const walk = current => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      const meta = lstatSync(fullPath);
      if (meta.isSymbolicLink()) continue;
      if (meta.isDirectory()) {
        walk(fullPath);
        if (readdirSync(fullPath).length === 0) {
          rmSync(fullPath, { recursive: true, force: true });
        }
      } else if (
        meta.isFile() &&
        NODE_MODULES_BLOAT_FILE.test(entry.name) &&
        !PRESERVED_LEGAL_FILE.test(entry.name)
      ) {
        removedFiles += 1;
        removedBytes += meta.size;
        rmSync(fullPath, { force: true });
      }
    }
  };
  walk(directory);
  return { removedFiles, removedBytes };
}

export function measureDirectory(directory) {
  let bytes = 0;
  let files = 0;
  const walk = current => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      const meta = lstatSync(fullPath);
      if (meta.isDirectory()) {
        walk(fullPath);
      } else if (meta.isFile()) {
        bytes += meta.size;
        files += 1;
      }
    }
  };
  walk(directory);
  return { bytes, files };
}

const RUNTIME_SCRIPTS = [
  'pi-baseline.mjs',
  'pi-dependencies.mjs',
  'bundled-extensions.mjs',
  'cargo.mjs',
  'model-data-manifest.mjs',
  'prepare-native-runtime.mjs',
];

/**
 * Stage a lean, production-only Pi runtime for desktop bundles:
 * - Omits `.git/`, `apps/`, non-core packages, `dist/`, `test/`, `docs/`, `examples/`
 * - Copies only runtime-reachable `pi/node_modules` dependencies (no devDependencies)
 * - Prunes `.d.ts`, `.map`, and `.md` bloat inside `node_modules`
 * - Materializes lightweight workspace binding stubs (`package.json` only) instead of
 *   duplicating `pi/packages/*` into `pi/node_modules/@earendil-works/*`
 * - Seals the resulting `pi/` tree with `.grapher-bundled-manifest.json`
 */
export function stageLeanPiRuntime({
  sourceRoot = root,
  destinationPiDir,
  target,
  baseline = piBaselineLock,
} = {}) {
  const sourcePi = join(sourceRoot, 'pi');
  const portableCopyOptions = {
    recursive: true,
    dereference: true,
    filter: () => true,
  };
  mkdirSync(destinationPiDir, { recursive: true });

  for (const requiredFile of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json']) {
    cpSync(join(sourcePi, requiredFile), join(destinationPiDir, requiredFile));
  }
  if (existsSync(join(sourcePi, 'LICENSE'))) {
    cpSync(join(sourcePi, 'LICENSE'), join(destinationPiDir, 'LICENSE'));
  }

  for (const pkgDir of corePackages) {
    const srcPkgRoot = join(sourcePi, 'packages', pkgDir);
    const destPkgRoot = join(destinationPiDir, 'packages', pkgDir);
    mkdirSync(destPkgRoot, { recursive: true });
    cpSync(join(srcPkgRoot, 'package.json'), join(destPkgRoot, 'package.json'));
    if (existsSync(join(srcPkgRoot, 'src'))) {
      cpSync(join(srcPkgRoot, 'src'), join(destPkgRoot, 'src'), portableCopyOptions);
    }
    if (existsSync(join(srcPkgRoot, 'THIRD_PARTY_NOTICES'))) {
      cpSync(
        join(srcPkgRoot, 'THIRD_PARTY_NOTICES'),
        join(destPkgRoot, 'THIRD_PARTY_NOTICES'),
        portableCopyOptions,
      );
    }
    if (pkgDir === 'ai') {
      const modelDataScript = join(srcPkgRoot, 'scripts', 'model-data.ts');
      if (existsSync(modelDataScript)) {
        const destScript = join(destPkgRoot, 'scripts', 'model-data.ts');
        mkdirSync(dirname(destScript), { recursive: true });
        cpSync(modelDataScript, destScript);
      }
    }
    if (pkgDir === 'tui' && target) {
      const targetPrebuild = join(
        srcPkgRoot,
        'native',
        target.platform,
        'prebuilds',
        `${target.platform}-${target.arch}`,
      );
      if (existsSync(targetPrebuild)) {
        const destPrebuild = join(
          destPkgRoot,
          'native',
          target.platform,
          'prebuilds',
          `${target.platform}-${target.arch}`,
        );
        mkdirSync(dirname(destPrebuild), { recursive: true });
        cpSync(targetPrebuild, destPrebuild, portableCopyOptions);
      }
    }
  }

  // Always hydrate reviewed model-data cleanly into packages/ai/src/providers/data
  // so personal git-ignored engine/model-data-local overlays never leak into bundles.
  const modelDataSource = join(sourceRoot, 'engine', 'model-data');
  const modelDataDest = join(destinationPiDir, 'packages', 'ai', 'src', 'providers', 'data');
  rmSync(modelDataDest, { recursive: true, force: true });
  mkdirSync(modelDataDest, { recursive: true });
  for (const name of Object.keys(baseline.modelData ?? {})) {
    cpSync(join(modelDataSource, name), join(modelDataDest, name));
  }

  // Copy only runtime-reachable dependencies from pi/node_modules (omitting devDependencies).
  const { lock: depLock, hashes: depHashes } = verifyDependencyProfile(sourceRoot);
  const runtimeKeys = computeRuntimeDependencyKeys(sourceRoot, depLock);
  const sortedRuntimeKeys = [...runtimeKeys].sort((a, b) => {
    const depthDiff = a.split('node_modules/').length - b.split('node_modules/').length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });
  const destNodeModules = join(destinationPiDir, 'node_modules');
  mkdirSync(destNodeModules, { recursive: true });
  for (const pkgKey of sortedRuntimeKeys) {
    const srcPkg = join(sourcePi, pkgKey);
    const entry = depLock.packages[pkgKey];
    if (!existsSync(srcPkg)) {
      if (entry?.optional) continue;
      throw new Error(`Missing runtime Pi dependency while staging desktop bundle: ${pkgKey}`);
    }
    const destPkg = join(destinationPiDir, pkgKey);
    mkdirSync(dirname(destPkg), { recursive: true });
    const nestedModulesDir = resolve(srcPkg, 'node_modules');
    cpSync(srcPkg, destPkg, {
      recursive: true,
      dereference: true,
      filter: candidate => resolve(candidate) !== nestedModulesDir,
    });
  }

  pruneNodeModulesBloat(destNodeModules);

  // Materialize lightweight workspace binding stubs (package.json only) so
  // pi/packages/* is never duplicated into pi/node_modules/@earendil-works/*.
  // Runtime ESM/jiti resolution maps @earendil-works/* directly to pi/packages/*/src.
  for (const pkgDir of corePackages) {
    const pkgJsonPath = join(destinationPiDir, 'packages', pkgDir, 'package.json');
    const pkgMeta = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const stubDir = join(destNodeModules, pkgMeta.name);
    mkdirSync(stubDir, { recursive: true });
    cpSync(pkgJsonPath, join(stubDir, 'package.json'));
  }

  writeFileSync(
    join(destNodeModules, '.grapher-pi-dependencies.json'),
    `${JSON.stringify({ ...depHashes, mode: PI_DEPENDENCIES_MODE_RUNTIME_ONLY })}\n`,
  );

  dereferenceSymlinksInPlace(destinationPiDir);
  const remaining = findRemainingSymlinks(destinationPiDir);
  if (remaining.length > 0) {
    throw new Error(`Unexpected symlinks remain in staged Pi runtime: ${remaining.slice(0, 5).join(', ')}`);
  }

  const manifest = buildBundledPiManifest(destinationPiDir, baseline);
  writeFileSync(join(destinationPiDir, BUNDLED_PI_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    manifestFileCount: Object.keys(manifest.files).length,
    runtimeDependencyCount: runtimeKeys.size,
  };
}

export function verifyStagedRuntimeWithNode(nodePath, stagedRuntime, env = process.env) {
  const cleanEnv = { ...env, NODE_OPTIONS: '', NODE_PATH: '' };
  for (const key of [
    'GRAPHER_BASELINE_CONTEXT',
    'GRAPHER_VERIFIED_BASELINE',
    'GRAPHER_INSTALLATION_ROOT',
    'GRAPHER_TRUSTED_NODE',
    'GRAPHER_TRUSTED_GIT',
  ]) {
    delete cleanEnv[key];
  }
  execFileSync(nodePath, [join(stagedRuntime, 'scripts', 'pi-baseline.mjs'), 'verify'], {
    env: cleanEnv,
    stdio: 'inherit',
  });
  const cacheKey = execFileSync(
    nodePath,
    [join(stagedRuntime, 'scripts', 'prepare-native-runtime.mjs'), '--cache-key'],
    {
      env: cleanEnv,
      encoding: 'utf8',
    },
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
    throw new Error(`Unexpected staged runtime cache key: ${cacheKey}`);
  }
  const probeDir = mkdtempSync(join(tmpdir(), 'grapher-stage-probe-'));
  try {
    const version = execFileSync(
      nodePath,
      [join(stagedRuntime, 'engine', 'entrypoint.mjs'), '--version'],
      {
        cwd: probeDir,
        encoding: 'utf8',
        env: {
          ...cleanEnv,
          HOME: probeDir,
          USERPROFILE: probeDir,
          PI_CODING_AGENT_DIR: join(probeDir, 'agent'),
          GRAPHER_GLOBAL_PI_AGENT_DIR: join(probeDir, 'global'),
          GRAPHER_ISOLATED_PI_MODELS: '1',
          PI_OFFLINE: '1',
        },
        timeout: 60000,
      },
    ).trim();
    if (version !== piBaselineLock.packageVersion) {
      throw new Error(
        `Staged engine/entrypoint.mjs reported version "${version}", expected "${piBaselineLock.packageVersion}"`,
      );
    }
    return { cacheKey, version };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

export function backendReleaseBinary(target, env = process.env, installationRoot = root) {
  const targetBase = env.CARGO_TARGET_DIR
    ? resolve(installationRoot, env.CARGO_TARGET_DIR)
    : join(installationRoot, 'backend', 'target');
  const triplePath = join(targetBase, target.rustTriple, 'release', target.backendBinary);
  const hostPath = join(targetBase, 'release', target.backendBinary);
  if (existsSync(triplePath)) return triplePath;
  if (hostTargetMatches(target) && existsSync(hostPath)) return hostPath;
  return hostTargetMatches(target) ? hostPath : triplePath;
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed downloading ${url} (HTTP ${response.status} ${response.statusText})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${process.pid}`;
  writeFileSync(temp, bytes);
  renameSync(temp, destination);
}

async function acquirePinnedNodeArchive(target, cacheDir) {
  const archivePath = join(cacheDir, target.nodeArchive);
  if (existsSync(archivePath) && sha256File(archivePath) === target.nodeSha256) {
    return archivePath;
  }
  const url = `https://nodejs.org/dist/v${PINNED_NODE_VERSION}/${target.nodeArchive}`;
  console.log(`[desktop:stage] Downloading Node.js v${PINNED_NODE_VERSION} (${target.id})...`);
  await downloadFile(url, archivePath);
  const actual = sha256File(archivePath);
  if (actual !== target.nodeSha256) {
    rmSync(archivePath, { force: true });
    throw new Error(
      `SHA-256 mismatch for ${target.nodeArchive}: expected ${target.nodeSha256}, got ${actual}`,
    );
  }
  return archivePath;
}

function extractNodeBinary(archivePath, target, destinationFile) {
  const extractDir = mkdtempSync(join(tmpdir(), 'grapher-node-extract-'));
  try {
    mkdirSync(dirname(destinationFile), { recursive: true });
    if (target.nodeArchive.endsWith('.tar.gz')) {
      execFileSync('tar', ['xzf', archivePath, '-C', extractDir, target.nodeArchiveEntry], {
        stdio: 'inherit',
      });
    } else if (target.nodeArchive.endsWith('.zip')) {
      if (process.platform === 'win32') {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:GRAPHER_NODE_ZIP, $env:GRAPHER_NODE_EXTRACT)',
          ],
          {
            env: {
              ...process.env,
              GRAPHER_NODE_ZIP: archivePath,
              GRAPHER_NODE_EXTRACT: extractDir,
            },
            stdio: 'inherit',
          },
        );
      } else {
        execFileSync('unzip', ['-q', archivePath, target.nodeArchiveEntry, '-d', extractDir], {
          stdio: 'inherit',
        });
      }
    } else {
      throw new Error(`Unsupported Node archive format: ${target.nodeArchive}`);
    }
    const extracted = join(extractDir, target.nodeArchiveEntry);
    if (!existsSync(extracted)) {
      throw new Error(`Expected Node binary not found in archive: ${target.nodeArchiveEntry}`);
    }
    cpSync(extracted, destinationFile);
    if (target.platform !== 'win32') {
      chmodSync(destinationFile, 0o755);
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

async function stageBundledNode(target, resourcesDir, { explicitNodeBinary, cacheDir }) {
  const destinationFile = join(resourcesDir, target.nodeRelPath);
  mkdirSync(dirname(destinationFile), { recursive: true });

  if (explicitNodeBinary) {
    const resolved = resolve(explicitNodeBinary);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new Error(`Configured Node binary does not exist: ${resolved}`);
    }
    cpSync(resolved, destinationFile);
    if (target.platform !== 'win32') chmodSync(destinationFile, 0o755);
  } else {
    const archivePath = await acquirePinnedNodeArchive(target, cacheDir);
    extractNodeBinary(archivePath, target, destinationFile);
  }

  let stagedNodeVersion = PINNED_NODE_VERSION;
  if (hostTargetMatches(target)) {
    const probe = execFileSync(
      destinationFile,
      ['-p', 'JSON.stringify({version: process.versions.node, platform: process.platform, arch: process.arch})'],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } },
    ).trim();
    const parsed = JSON.parse(probe);
    stagedNodeVersion = assertMinimumNodeVersion(parsed.version);
    if (parsed.platform !== target.platform || parsed.arch !== target.arch) {
      throw new Error(
        `Staged Node binary platform/arch mismatch: expected ${target.platform}/${target.arch}, got ${parsed.platform}/${parsed.arch}`,
      );
    }
  } else if (process.platform === 'darwin' && target.platform === 'darwin') {
    const lipo = execFileSync('lipo', ['-info', destinationFile], { encoding: 'utf8' }).trim();
    const expectedArch = target.arch === 'arm64' ? 'arm64' : 'x86_64';
    if (!lipo.includes(expectedArch)) {
      throw new Error(`Staged macOS Node binary does not match ${expectedArch}: ${lipo}`);
    }
  }
  return { nodePath: destinationFile, nodeVersion: stagedNodeVersion };
}

const SENSITIVE_RELEASE_ENV_VARS = [
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PATH',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_API_KEY_P8',
  'APPLE_PASSWORD',
];

function stripReleaseSecrets(env) {
  const sanitized = { ...env };
  for (const key of SENSITIVE_RELEASE_ENV_VARS) {
    delete sanitized[key];
  }
  return sanitized;
}

function buildFrontend(env) {
  console.log('[desktop:stage] Building frontend production bundle...');
  // Invoke via Node directly instead of npm.cmd so Windows Node 22+ never fails with EINVAL.
  if (env.npm_execpath && existsSync(env.npm_execpath)) {
    execFileSync(process.execPath, [env.npm_execpath, 'run', 'build'], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    return;
  }
  const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [tscBin, '--noEmit'], { cwd: root, env, stdio: 'inherit' });
  execFileSync(process.execPath, [viteBin, 'build'], { cwd: root, env, stdio: 'inherit' });
}

function buildBackendRelease(target, env) {
  const cargo = findCargoExecutable(env) ?? 'cargo';
  const args = [
    'build',
    '--release',
    '--locked',
    '--manifest-path',
    'backend/Cargo.toml',
    '--bin',
    'grapher',
  ];
  if (!hostTargetMatches(target)) {
    args.push('--target', target.rustTriple);
  }
  console.log(`[desktop:stage] Building release backend for ${target.rustTriple}...`);
  execFileSync(cargo, args, { cwd: root, env, stdio: 'inherit' });
}

export async function stageDesktopResources({
  targetSpec,
  skipBuild = false,
  explicitNodeBinary = process.env.GRAPHER_DESKTOP_NODE_BINARY || null,
  resourcesDir = join(root, 'src-tauri', 'resources'),
  cacheDir = join(root, '.tmp', 'desktop-node-cache'),
  env: baseEnv = process.env,
} = {}) {
  const target = resolveDesktopTarget(targetSpec);
  const env = toolchainEnv(stripReleaseSecrets(baseEnv));
  const appVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

  if (!skipBuild || !existsSync(join(root, 'dist', 'index.html'))) {
    buildFrontend(env);
  }
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('Frontend build output dist/index.html is missing.');
  }

  let backendBin = backendReleaseBinary(target, env, root);
  if (!skipBuild || !existsSync(backendBin)) {
    buildBackendRelease(target, env);
    backendBin = backendReleaseBinary(target, env, root);
  }
  if (!existsSync(backendBin)) {
    throw new Error(`Compiled backend binary not found at ${backendBin}`);
  }

  // Verify source repository integrity before staging desktop resources.
  verifyBundledExtensions(root);
  verifyBaseline({ installationRoot: root });
  verifyPiDependencies(root);

  const stagingTemp = mkdtempSync(join(tmpdir(), 'grapher-desktop-stage-'));
  try {
    console.log('[desktop:stage] Staging lean production Pi/engine runtime...');
    const stagedRoot = join(stagingTemp, 'resources');
    const stagedRuntime = join(stagedRoot, 'runtime');
    mkdirSync(stagedRuntime, { recursive: true });

    const portableCopyOptions = {
      recursive: true,
      dereference: true,
      filter: () => true,
    };

    const excludedEngineDirs = new Set([
      resolve(root, 'engine', 'pi-dependencies', 'node_modules'),
      resolve(root, 'engine', 'model-data-local'),
    ]);
    cpSync(join(root, 'engine'), join(stagedRuntime, 'engine'), {
      recursive: true,
      dereference: true,
      filter: candidate => !excludedEngineDirs.has(resolve(candidate)),
    });

    for (const name of bundledExtensionNames) {
      const destExt = join(stagedRuntime, 'node_modules', name);
      mkdirSync(dirname(destExt), { recursive: true });
      cpSync(join(root, 'node_modules', name), destExt, portableCopyOptions);
    }
    pruneNodeModulesBloat(join(stagedRuntime, 'node_modules'));

    for (const name of ['package.json', 'package-lock.json']) {
      cpSync(join(root, name), join(stagedRuntime, name));
    }
    mkdirSync(join(stagedRuntime, 'scripts'), { recursive: true });
    for (const script of RUNTIME_SCRIPTS) {
      cpSync(join(root, 'scripts', script), join(stagedRuntime, 'scripts', script));
    }

    stageLeanPiRuntime({
      sourceRoot: root,
      destinationPiDir: join(stagedRuntime, 'pi'),
      target,
      baseline: piBaselineLock,
    });

    // Stage frontend dist/ and backend executable inside the relocatable runtime root.
    cpSync(join(root, 'dist'), join(stagedRuntime, 'dist'), portableCopyOptions);
    const stagedBackend = join(stagedRuntime, target.backendBinary);
    cpSync(backendBin, stagedBackend);
    if (target.platform !== 'win32') chmodSync(stagedBackend, 0o755);

    // Dereference any remaining symlinks so Tauri's WalkDir resource bundler
    // copies every file intact on macOS and Windows.
    dereferenceSymlinksInPlace(stagedRuntime);
    const remaining = findRemainingSymlinks(stagedRuntime);
    if (remaining.length > 0) {
      throw new Error(`Unexpected symlinks remain in staged runtime: ${remaining.slice(0, 5).join(', ')}`);
    }

    const { nodePath, nodeVersion } = await stageBundledNode(target, stagedRoot, {
      explicitNodeBinary,
      cacheDir,
    });

    writeFileSync(
      join(stagedRuntime, '.grapher-desktop-stage.json'),
      `${JSON.stringify(
        {
          version: appVersion,
          target: target.id,
          rustTriple: target.rustTriple,
          nodeVersion,
          runtimeMode: 'bundled-desktop',
          dependencyMode: PI_DEPENDENCIES_MODE_RUNTIME_ONLY,
          stagedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    // Verify the relocated staged runtime using the bundled Node executable on host builds.
    if (hostTargetMatches(target)) {
      console.log('[desktop:stage] Verifying staged runtime with bundled Node...');
      verifyStagedRuntimeWithNode(nodePath, stagedRuntime, env);
    }

    const runtimeStats = measureDirectory(stagedRuntime);
    const nodeStats = measureDirectory(join(stagedRoot, 'node'));
    const formatMb = bytes => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

    // Replace src-tauri/resources cleanly.
    rmSync(resourcesDir, { recursive: true, force: true });
    mkdirSync(dirname(resourcesDir), { recursive: true });
    cpSync(stagedRoot, resourcesDir, portableCopyOptions);
    console.log(
      `[desktop:stage] Staged desktop resources for ${target.id} into ${resourcesDir} (runtime: ${formatMb(runtimeStats.bytes)} across ${runtimeStats.files} files, node: ${formatMb(nodeStats.bytes)})`,
    );
    return {
      target,
      resourcesDir,
      runtimeDir: join(resourcesDir, 'runtime'),
      nodePath: join(resourcesDir, target.nodeRelPath),
      backendPath: join(resourcesDir, 'runtime', target.backendBinary),
      nodeVersion,
    };
  } finally {
    rmSync(stagingTemp, { recursive: true, force: true });
  }
}

function parseCliArgs(argv) {
  const options = { targetSpec: null, skipBuild: false, explicitNodeBinary: process.env.GRAPHER_DESKTOP_NODE_BINARY || null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target' && argv[i + 1]) {
      options.targetSpec = argv[++i];
    } else if (arg === '--skip-build') {
      options.skipBuild = true;
    } else if (arg === '--node-binary' && argv[i + 1]) {
      options.explicitNodeBinary = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/desktop-stage.mjs [--target macos-arm64|macos-x64|windows-x64] [--skip-build] [--node-binary <path>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    await stageDesktopResources(options);
  } catch (error) {
    console.error(`[desktop:stage] ${error.message}`);
    process.exitCode = 1;
  }
}
