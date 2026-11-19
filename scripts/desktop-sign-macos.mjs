// macOS inside-out nested Mach-O executable signing and verification for Grapher.app.
// Ensures bundled Node.js, the `grapher` backend binary, and any native `.node`/`.dylib`/`.so`
// modules inside `Contents/Resources/` are signed with exact entitlements before signing `.app`.
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './ensure-deps.mjs';
import { BUNDLED_PI_MANIFEST_FILE, buildBundledPiManifest } from './pi-baseline.mjs';

const MACH_O_MAGICS = new Set([
  0xfeedface, // MH_MAGIC
  0xcefaedfe, // MH_CIGAM
  0xfeedfacf, // MH_MAGIC_64
  0xcffaedfe, // MH_CIGAM_64
]);

const FAT_MAGICS = new Set([
  0xcafebabe, // FAT_MAGIC (also Java .class magic; disambiguated via arch count)
  0xbebafeca, // FAT_CIGAM
  0xcafebabf, // FAT_MAGIC_64
  0xbfbafeca, // FAT_CIGAM_64
]);

/**
 * Inspect the first 8 bytes of a file to determine whether it is a Mach-O
 * executable, library, or universal binary (excluding Java `.class` files).
 */
export function isMachOBuffer(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const magic = buffer.readUInt32BE(0);
  if (MACH_O_MAGICS.has(magic)) return true;
  if (FAT_MAGICS.has(magic)) {
    if (buffer.length < 8) return false;
    // Universal Mach-O headers store nfat_arch (typically 1..16) in bytes 4..8,
    // whereas Java .class files store minor_version/major_version (>= 45).
    const secondWord =
      magic === 0xcafebabe || magic === 0xcafebabf
        ? buffer.readUInt32BE(4)
        : buffer.readUInt32LE(4);
    return secondWord >= 1 && secondWord <= 32;
  }
  return false;
}

export function isMachOBinary(filePath) {
  let fd;
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 4) return false;
    fd = openSync(filePath, 'r');
    const header = Buffer.alloc(8);
    const bytesRead = readSync(fd, header, 0, 8, 0);
    return isMachOBuffer(header.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Returns true if `filePath` is a Git-tracked file inside a live `pi/` Git
 * checkout (outside `pi/node_modules/`). Mutating tracked `pi` files in place
 * with `codesign` would dirty `git status` and fail `pi-baseline.mjs verify`.
 *
 * Lean desktop bundles omit `runtime/pi/.git` and verify `runtime/pi/` via
 * `.grapher-pi-runtime-manifest.json`, so native prebuilds such as
 * `darwin-platform.node` MUST be signed for Apple notarization and the bundled
 * manifest re-sealed before signing the outer `.app` bundle.
 */
export function isTrackedPiCheckoutFile(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const marker = '/runtime/pi/';
  const idx = normalized.indexOf(marker);
  if (idx === -1 || normalized.includes('/runtime/pi/node_modules/')) {
    return false;
  }
  const piRoot = filePath.slice(0, idx + marker.length - 1);
  return existsSync(join(piRoot, '.git'));
}

/**
 * Re-seal `Contents/Resources/runtime/pi/.grapher-pi-runtime-manifest.json`
 * after signing nested Mach-O binaries (such as `darwin-platform.node`) so
 * bundled Pi integrity verification matches the signed bytes and the outer
 * `.app` signature covers the updated manifest.
 */
export function resealBundledPiManifest(appBundlePath) {
  const bundledPiDir = join(resolve(appBundlePath), 'Contents', 'Resources', 'runtime', 'pi');
  const manifestPath = join(bundledPiDir, BUNDLED_PI_MANIFEST_FILE);
  if (existsSync(join(bundledPiDir, '.git')) || !existsSync(manifestPath)) {
    return false;
  }
  const manifest = buildBundledPiManifest(bundledPiDir);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

/**
 * Find every signable Mach-O binary inside a `.app` bundle, sorted
 * deepest-path-first for strict inside-out signing order.
 */
export function findMachOBinaries(appBundlePath) {
  const binaries = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (
        stat.isFile() &&
        !isTrackedPiCheckoutFile(fullPath) &&
        isMachOBinary(fullPath)
      ) {
        binaries.push(fullPath);
      }
    }
  };
  walk(appBundlePath);
  binaries.sort((a, b) => {
    const depthDiff = b.split(/[/\\]/).length - a.split(/[/\\]/).length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });
  return binaries;
}

export function entitlementsForBinary(
  binaryPath,
  {
    appEntitlements = join(root, 'src-tauri', 'Entitlements.plist'),
    nodeEntitlements = join(root, 'src-tauri', 'NodeEntitlements.plist'),
  } = {},
) {
  const name = basename(binaryPath);
  const ext = extname(binaryPath);
  if (name === 'node' || ext === '.node' || ext === '.dylib' || ext === '.so') {
    return nodeEntitlements;
  }
  return appEntitlements;
}

function runCodesign(args) {
  execFileSync('codesign', args, { stdio: 'inherit' });
}

export function signMacosAppBundle(
  appBundlePath,
  {
    identity = process.env.APPLE_SIGNING_IDENTITY || '-',
    appEntitlements = join(root, 'src-tauri', 'Entitlements.plist'),
    nodeEntitlements = join(root, 'src-tauri', 'NodeEntitlements.plist'),
  } = {},
) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS bundle signing can only run on macOS.');
  }
  const appPath = resolve(appBundlePath);
  if (!existsSync(appPath)) {
    throw new Error(`macOS app bundle not found: ${appPath}`);
  }
  const adhoc = !identity || identity === '-';
  const signBaseArgs = adhoc
    ? ['--force', '--sign', '-']
    : ['--force', '--timestamp', '--options', 'runtime', '--sign', identity];

  const nestedBinaries = findMachOBinaries(appPath);
  console.log(
    `[desktop:sign] Signing ${nestedBinaries.length} nested Mach-O binary(ies) inside ${basename(appPath)} (${adhoc ? 'ad-hoc' : identity})...`,
  );
  for (const binary of nestedBinaries) {
    const entitlements = entitlementsForBinary(binary, { appEntitlements, nodeEntitlements });
    const args = [...signBaseArgs];
    if (entitlements && existsSync(entitlements)) {
      args.push('--entitlements', entitlements);
    }
    args.push(binary);
    runCodesign(args);
  }

  if (resealBundledPiManifest(appPath)) {
    console.log(`[desktop:sign] Re-sealed bundled Pi runtime manifest inside ${basename(appPath)}.`);
  }

  // Sign the outer .app bundle last (without --deep so per-binary entitlements survive).
  const outerArgs = [...signBaseArgs];
  if (appEntitlements && existsSync(appEntitlements)) {
    outerArgs.push('--entitlements', appEntitlements);
  }
  outerArgs.push(appPath);
  runCodesign(outerArgs);

  console.log(`[desktop:sign] Verifying ${basename(appPath)}...`);
  runCodesign(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  return { signedCount: nestedBinaries.length, adhoc };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let appPath = null;
  let identity = process.env.APPLE_SIGNING_IDENTITY || '-';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--identity' && args[i + 1]) {
      identity = args[++i];
    } else if (!appPath) {
      appPath = args[i];
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }
  if (!appPath) {
    console.error('Usage: node scripts/desktop-sign-macos.mjs <Grapher.app> [--identity <id>]');
    process.exit(2);
  }
  try {
    signMacosAppBundle(appPath, { identity });
  } catch (error) {
    console.error(`[desktop:sign] ${error.message}`);
    process.exitCode = 1;
  }
}
