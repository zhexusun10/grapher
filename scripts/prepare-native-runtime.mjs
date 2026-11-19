// Host-only preparation. Backends cache this verified copy by content, shared
// across projects and processes, including when Grapher hosts itself.
import { createHash } from 'node:crypto';
import { cpSync, constants, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, source, verifyBaseline } from './pi-baseline.mjs';
import { verifyPiDependencies } from './pi-dependencies.mjs';
import { bundledExtensionNames, verifyBundledExtensions } from './bundled-extensions.mjs';

// Fail before the expensive Pi copy when an existing checkout needs npm ci.
verifyBundledExtensions(root);
verifyBaseline();
const profileCache = {};
verifyPiDependencies(root, { profileCache });

async function computeCacheKey(input, { verifyCachedDeps = false } = {}) {
  // Dependency directories are deliberately omitted from the digest. Check the
  // copy's install metadata against the trusted source profile before admission.
  if (verifyCachedDeps) {
    try {
      verifyPiDependencies(root, { installationRoot: input, profileCache });
    } catch (error) {
      throw new Error(`Cached Pi dependency verification failed: ${error.message}`, { cause: error });
    }
  }
  const items = [];
  const directories = new Set();
  const collect = (path, name, dirent) => {
    if (process.platform === 'win32') {
      // Windows copies dereference links. Hash the same bytes/shape that the
      // destination retains, not a junction spelling absent from that copy.
      const stat = statSync(path);
      if (stat.isDirectory()) {
        const physical = realpathSync.native(path);
        if (directories.has(physical)) throw new Error(`Cyclic native runtime input: ${name}`);
        directories.add(physical);
        items.push({ type: 'dir', name });
        try {
          for (const child of readdirSync(path).sort()) {
            if (child !== 'node_modules' && child !== '.git' && !child.startsWith('.grapher-masks-')) {
              collect(join(path, child), `${name}/${child}`);
            }
          }
        } finally {
          directories.delete(physical);
        }
      } else {
        items.push({ type: 'file', name, path });
      }
      return;
    }
    const kind = dirent && (dirent.isSymbolicLink() || dirent.isDirectory() || dirent.isFile())
      ? dirent
      : lstatSync(path);
    if (kind.isSymbolicLink()) {
      items.push({ type: 'link', name, target: readlinkSync(path) });
    } else if (kind.isDirectory()) {
      items.push({ type: 'dir', name });
      const children = readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const child of children) {
        if (child.name !== 'node_modules' && child.name !== '.git' && !child.name.startsWith('.grapher-masks-')) {
          collect(join(path, child.name), `${name}/${child.name}`, child);
        }
      }
    } else {
      items.push({ type: 'file', name, path });
    }
  };
  for (const name of ['engine', 'package.json', 'package-lock.json', 'pi/package.json', 'pi/package-lock.json', 'pi/packages']) collect(join(input, name), name);
  for (const script of ['pi-baseline.mjs', 'pi-dependencies.mjs', 'bundled-extensions.mjs', 'cargo.mjs', 'model-data-manifest.mjs', 'prepare-native-runtime.mjs']) collect(join(input, 'scripts', script), `scripts/${script}`);
  for (const name of bundledExtensionNames) collect(join(input, 'node_modules', name), `node_modules/${name}`);

  const hash = createHash('sha256').update(`grapher-native-runtime-v2:${process.platform}:${process.arch}:${process.versions.modules}\n`);
  const BATCH = 32;
  for (let offset = 0; offset < items.length; offset += BATCH) {
    const slice = items.slice(offset, offset + BATCH);
    const buffers = await Promise.all(slice.map(item => (item.type === 'file' ? readFile(item.path) : null)));
    for (let index = 0; index < slice.length; index++) {
      const item = slice[index];
      hash.update(`${item.name}\0`);
      if (item.type === 'link') {
        hash.update(`link:${item.target}\0`);
      } else if (item.type === 'file') {
        const content = buffers[index];
        hash.update(String(content.length)).update('\0').update(content);
      }
    }
  }
  return hash.digest('hex');
}

// Hash runtime inputs, not project paths, credentials or session state. Pi's
// external dependencies are pinned/verified above; hashing their lock and the
// built core artifacts avoids reading another entire node_modules tree.
if (process.argv[2] === '--cache-key') {
  // Hash a cached copy using this installation's trusted verifier, never run
  // verifier/adapter code from the cache before its inputs have been checked.
  const input = process.argv[3] ? resolve(process.argv[3]) : root;
  const key = await computeCacheKey(input, { verifyCachedDeps: Boolean(process.argv[3]) });
  process.stdout.write(key);
  process.exit(0);
}

// Single-process session used by the backend so baseline and root dependency
// verification run once while cached candidates are verified under their lease.
if (process.argv[2] === '--cache-key-session') {
  const rootKey = await computeCacheKey(root, { verifyCachedDeps: false });
  process.stdout.write(`${JSON.stringify({ ok: true, key: rootKey })}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line);
      if (typeof request?.verify !== 'string' || !request.verify) {
        throw new Error('Invalid cache verification request');
      }
      const key = await computeCacheKey(resolve(request.verify), { verifyCachedDeps: true });
      process.stdout.write(`${JSON.stringify({ ok: true, key })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    }
  }
  process.exit(0);
}

const runtimeParent = process.env.GRAPHER_NATIVE_RUNTIME_PARENT
  ? resolve(process.env.GRAPHER_NATIVE_RUNTIME_PARENT)
  : tmpdir();
mkdirSync(runtimeParent, { recursive: true });
// The backend creates and leases its destination before starting this copy.
// Standalone verification/tests retain the temporary-directory behavior.
const destination = process.env.GRAPHER_NATIVE_RUNTIME_DIR
  ? resolve(process.env.GRAPHER_NATIVE_RUNTIME_DIR)
  : mkdtempSync(join(runtimeParent, 'grapher-native-engine-'));
if (process.env.GRAPHER_NATIVE_RUNTIME_DIR) {
  // Do not let a misconfigured environment turn the failure cleanup below
  // into recursive deletion of the source or an existing engine installation.
  if (!/^grapher-native-engine-[0-9a-f-]{36}$/i.test(basename(destination))
    || realpathSync.native(dirname(destination)) !== realpathSync.native(runtimeParent)
    || !lstatSync(destination).isDirectory() || lstatSync(destination).isSymbolicLink()
    || readdirSync(destination).some(name => !['runtime.lock', '.grapher-native-runtime.json'].includes(name))) {
    throw new Error('Native runtime destination must be an empty, leased child of its runtime parent');
  }
}
const gitPath = value => {
  if (process.platform !== 'win32') return value;
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice('\\\\?\\UNC\\'.length)}`;
  return value.startsWith('\\\\?\\') ? value.slice('\\\\?\\'.length) : value;
};
try {
  const options = {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    dereference: process.platform === 'win32',
    verbatimSymlinks: process.platform !== 'win32',
    // Node 22's native recursive cp fails on Unicode Windows source paths.
    // A filter selects its portable walker (Pi already needs one for .git).
    filter: process.platform === 'win32' ? () => true : undefined,
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  // Independent metadata; never retain the submodule's pointer into source/.git.
  // AppData and Unicode profiles can push Git metadata past MAX_PATH. Enable
  // long paths for the clone itself and persist it for later verification.
  execFileSync('git', ['-c', 'core.longpaths=true', 'clone', '--config', 'core.longpaths=true', '--local', '--no-hardlinks', '--no-checkout', gitPath(source), gitPath(join(destination, 'pi'))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  cpSync(source, join(destination, 'pi'), { ...options, filter: path => resolve(path) !== join(source, '.git') });
  cpSync(join(root, 'engine'), join(destination, 'engine'), {
    ...options,
    // Only the profile manifests are needed at runtime; Pi has the audited
    // dependency copy already. Avoid doubling the install in every Graph copy.
    filter: path => resolve(path) !== join(root, 'engine/pi-dependencies/node_modules'),
  });
  // Bundled extensions resolve Pi peers through the runtime source aliases;
  // copy only their packages, never another Pi runtime.
  for (const name of bundledExtensionNames) {
    cpSync(join(root, 'node_modules', name), join(destination, 'node_modules', name), options);
  }
  // Preserve the ESM boundary and root Pi peer pins for runtime verification.
  for (const name of ['package.json', 'package-lock.json']) cpSync(join(root, name), join(destination, name));
  mkdirSync(join(destination, 'scripts'));
  for (const script of ['pi-baseline.mjs', 'pi-dependencies.mjs', 'bundled-extensions.mjs', 'cargo.mjs', 'model-data-manifest.mjs', 'prepare-native-runtime.mjs']) {
    cpSync(join(root, 'scripts', script), join(destination, 'scripts', script));
  }
  execFileSync('git', ['-C', gitPath(join(destination, 'pi')), 'reset', '--mixed', 'HEAD'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  execFileSync(process.execPath, [gitPath(join(destination, 'scripts/pi-baseline.mjs')), 'verify'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  process.stdout.write(destination);
} catch (error) {
  rmSync(destination, { recursive: true, force: true });
  throw error;
}
