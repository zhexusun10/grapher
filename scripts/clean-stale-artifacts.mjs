import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

export async function parseActiveArtifacts({
  installationRoot = projectRoot,
  manifestPath = 'backend/Cargo.toml',
  bin = 'grapher',
  release = false,
  extraCargoArgs = [],
  env = process.env,
  signal,
} = {}) {
  const fullManifest = resolve(installationRoot, manifestPath);
  if (!existsSync(fullManifest) || signal?.aborted) {
    return { activeFiles: new Set(), activeBuildDirs: new Set(), profile: release ? 'release' : 'debug', targetDir: '', failed: true };
  }

  const targetBase = env.CARGO_TARGET_DIR
    ? resolve(installationRoot, env.CARGO_TARGET_DIR)
    : resolve(installationRoot, 'backend', 'target');

  return new Promise((resolveArtifacts, reject) => {
    const cargoScript = join(installationRoot, 'scripts', 'cargo.mjs');
    const args = [
      cargoScript,
      'build',
      '--locked',
      '--manifest-path',
      fullManifest,
      '--bin',
      bin,
      '--message-format=json',
    ];
    if (release) args.push('--release');
    args.push(...extraCargoArgs);

    const child = spawn(process.execPath, args, {
      cwd: installationRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch {}
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const activeFiles = new Set();
    const activeBuildDirs = new Set();
    let buffer = '';
    const processLine = line => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.reason === 'compiler-artifact') {
          if (Array.isArray(msg.filenames)) {
            for (const filename of msg.filenames) {
              const fullPath = resolve(installationRoot, filename);
              activeFiles.add(fullPath);

              const fileDir = dirname(fullPath);
              const fileBase = basename(fullPath);

              if (fullPath.includes(targetBase) && fileDir.includes('build')) {
                activeBuildDirs.add(fileDir);
              }

              activeFiles.add(join(fileDir, fileBase.replace(/\.[^.]+$/, '.d')));
              if (fileBase.startsWith('lib')) {
                activeFiles.add(join(fileDir, fileBase.replace(/^lib/, '').replace(/\.[^.]+$/, '.d')));
              }
            }
          }
          if (msg.executable) {
            activeFiles.add(resolve(installationRoot, msg.executable));
          }
        } else if (msg.reason === 'build-script-executed' && msg.out_dir) {
          activeBuildDirs.add(resolve(msg.out_dir, '..'));
        }
      } catch {}
    };

    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    });

    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        resolveArtifacts({ activeFiles: new Set(), activeBuildDirs: new Set(), profile: release ? 'release' : 'debug', targetDir: '', failed: true });
        return;
      }
      if (buffer) processLine(buffer);
      const profile = release ? 'release' : 'debug';
      const targetDir = join(targetBase, profile);
      const artifactTracked = activeFiles.size > 0 && code === 0;
      const escapedBin = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const exts = ['.exe', '.pdb', '.d', '.lib', '.exp', '.dSYM', ''];
      for (const ext of exts) {
        activeFiles.add(resolve(targetDir, `${bin}${ext}`));
        activeFiles.add(resolve(targetDir, 'deps', `${bin}${ext}`));
      }
      // Cargo emits only `target/<profile>/<bin>` in compiler-artifact filenames
      // for the binary target, while storing the linked binary and dep-info at
      // `target/<profile>/deps/<bin>-<hash>` on macOS/Linux. Protect the active
      // binary hash so a subsequent `cargo run` does not have to relink `bin`.
      const activeBinHashes = new Set();
      const fpRoot = join(targetDir, '.fingerprint');
      const fpPattern = new RegExp(`^${escapedBin}-([0-9a-f]{16})$`);
      if (existsSync(fpRoot)) {
        let newestHash = null;
        let newestMtime = -1;
        for (const name of readdirSync(fpRoot)) {
          const match = fpPattern.exec(name);
          if (!match) continue;
          const marker = join(fpRoot, name, `bin-${bin}`);
          try {
            const s = statSync(marker);
            if (s.mtimeMs > newestMtime) {
              newestMtime = s.mtimeMs;
              newestHash = match[1];
            }
          } catch {}
        }
        if (newestHash) activeBinHashes.add(newestHash);
      }
      const depsDir = join(targetDir, 'deps');
      const binExecPattern = new RegExp(`^${escapedBin}-([0-9a-f]{16})(?:\\.exe)?$`);
      if (existsSync(depsDir)) {
        let binIno = null;
        try {
          const binPath = resolve(targetDir, process.platform === 'win32' ? `${bin}.exe` : bin);
          if (existsSync(binPath)) binIno = statSync(binPath).ino;
        } catch {}
        let newestDepHash = null;
        let newestDepMtime = -1;
        for (const name of readdirSync(depsDir)) {
          const match = binExecPattern.exec(name);
          if (!match) continue;
          try {
            const s = statSync(join(depsDir, name));
            if (binIno && s.ino === binIno) activeBinHashes.add(match[1]);
            if (s.mtimeMs > newestDepMtime) {
              newestDepMtime = s.mtimeMs;
              newestDepHash = match[1];
            }
          } catch {}
        }
        if (newestDepHash) activeBinHashes.add(newestDepHash);
      }
      for (const hash of activeBinHashes) {
        for (const ext of exts) {
          activeFiles.add(resolve(targetDir, 'deps', `${bin}-${hash}${ext}`));
        }
      }
      resolveArtifacts({ activeFiles, activeBuildDirs, profile, targetDir, failed: !artifactTracked });
    });

    child.on('error', error => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

function calculateDirSize(dirPath) {
  let total = 0;
  try {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += calculateDirSize(full);
      } else if (entry.isFile()) {
        total += statSync(full).size;
      }
    }
  } catch {}
  return total;
}

export async function cleanStaleArtifacts({
  installationRoot = projectRoot,
  manifestPath = 'backend/Cargo.toml',
  bin = 'grapher',
  dryRun = false,
  release = false,
  silent = false,
  verbose = false,
  log = console.log,
  env = process.env,
  signal,
} = {}) {
  const fullManifest = resolve(installationRoot, manifestPath);
  if (!existsSync(fullManifest) || signal?.aborted) {
    return {
      dryRun,
      activeCount: 0,
      activeBytes: 0,
      staleCount: 0,
      deletedCount: 0,
      reclaimedBytes: 0,
    };
  }

  if (!silent) {
    log(`[clean-stale] Collecting active artifacts from Cargo (${release ? 'release' : 'debug'})...`);
  }

  const { activeFiles, activeBuildDirs, profile, targetDir, failed } = await parseActiveArtifacts({
    installationRoot,
    manifestPath,
    bin,
    release,
    env,
    signal,
  });
  if (failed) {
    return {
      dryRun,
      activeCount: 0,
      activeBytes: 0,
      staleCount: 0,
      deletedCount: 0,
      reclaimedBytes: 0,
    };
  }

  const depsDir = join(targetDir, 'deps');
  const buildDir = join(targetDir, 'build');

  let activeBytes = 0;
  for (const filePath of activeFiles) {
    try {
      if (existsSync(filePath)) {
        activeBytes += statSync(filePath).size;
      }
    } catch {}
  }

  const staleDeps = [];
  let staleDepsBytes = 0;

  if (existsSync(depsDir)) {
    for (const file of readdirSync(depsDir)) {
      if (file.startsWith('.rustc') || file === 'CACHEDIR.TAG') continue;
      const fullPath = join(depsDir, file);
      if (!activeFiles.has(fullPath)) {
        try {
          const s = statSync(fullPath);
          const isDirectory = s.isDirectory();
          const size = isDirectory ? calculateDirSize(fullPath) : s.size;
          staleDeps.push({ path: fullPath, name: file, size, isDirectory });
          staleDepsBytes += size;
        } catch {}
      }
    }
  }

  const staleBuildDirs = [];
  let staleBuildBytes = 0;

  if (existsSync(buildDir)) {
    for (const name of readdirSync(buildDir)) {
      const fullPath = join(buildDir, name);
      try {
        const s = statSync(fullPath);
        if (s.isDirectory() && !activeBuildDirs.has(fullPath)) {
          const dirSize = calculateDirSize(fullPath);
          staleBuildDirs.push({ path: fullPath, name, size: dirSize });
          staleBuildBytes += dirSize;
        }
      } catch {}
    }
  }

  let viteTempBytes = 0;
  const viteTemp = join(installationRoot, 'node_modules', '.vite-temp');
  if (existsSync(viteTemp)) {
    try {
      const entries = readdirSync(viteTemp);
      if (entries.length > 0) {
        viteTempBytes = calculateDirSize(viteTemp);
      }
    } catch {}
  }

  const totalStaleBytes = staleDepsBytes + staleBuildBytes + viteTempBytes;
  const totalStaleCount = staleDeps.length + staleBuildDirs.length + (viteTempBytes > 0 ? 1 : 0);
  const formatMB = bytes => (bytes / (1024 * 1024)).toFixed(2) + ' MB';

  if (!silent) {
    log(`[clean-stale] Active dependencies protected: ${activeFiles.size} files (${formatMB(activeBytes)})`);
    log(`[clean-stale] Active build directories protected: ${activeBuildDirs.size}`);
    log(`[clean-stale] Stale deps artifacts found: ${staleDeps.length} (${formatMB(staleDepsBytes)})`);
    log(`[clean-stale] Stale build directories found: ${staleBuildDirs.length} (${formatMB(staleBuildBytes)})`);
    if (viteTempBytes > 0) {
      log(`[clean-stale] Stale frontend temp found: node_modules/.vite-temp (${formatMB(viteTempBytes)})`);
    }
  }

  if (dryRun) {
    if (!silent || totalStaleCount > 0) {
      log(`[clean-stale] (Dry run) Would reclaim ${formatMB(totalStaleBytes)} without deleting any files.`);
    }
    return {
      dryRun: true,
      activeCount: activeFiles.size,
      activeBytes,
      staleCount: totalStaleCount,
      reclaimedBytes: totalStaleBytes,
    };
  }

  let deletedCount = 0;
  let skippedCount = 0;

  for (const item of staleDeps) {
    try {
      if (item.isDirectory) {
        rmSync(item.path, { recursive: true, force: true });
      } else {
        unlinkSync(item.path);
      }
      deletedCount++;
      if (verbose) log(`  - Deleted file: ${item.name}`);
    } catch (error) {
      skippedCount++;
      if (verbose) log(`  ! Locked/skipped: ${item.name} (${error.message})`);
    }
  }

  for (const dir of staleBuildDirs) {
    try {
      rmSync(dir.path, { recursive: true, force: true });
      deletedCount++;
      if (verbose) log(`  - Deleted dir: ${dir.name}`);
    } catch (error) {
      skippedCount++;
      if (verbose) log(`  ! Locked/skipped: ${dir.name} (${error.message})`);
    }
  }

  if (existsSync(viteTemp) && viteTempBytes > 0) {
    try {
      rmSync(viteTemp, { recursive: true, force: true });
      deletedCount++;
    } catch {}
  }

  if (!silent || deletedCount > 0) {
    log(`[clean-stale] Cleaned ${deletedCount} stale items; reclaimed ${formatMB(totalStaleBytes)}.`);
    if (skippedCount > 0) {
      log(`[clean-stale] (${skippedCount} active/locked files skipped safely)`);
    }
  }

  return {
    dryRun: false,
    activeCount: activeFiles.size,
    activeBytes,
    deletedCount,
    skippedCount,
    reclaimedBytes: totalStaleBytes,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-d');
  const release = args.includes('--release');
  const verbose = args.includes('--verbose') || args.includes('-v');

  try {
    await cleanStaleArtifacts({ dryRun, release, verbose });
  } catch (error) {
    console.error(`[clean-stale] Failed: ${error.message}`);
    process.exitCode = 1;
  }
}
