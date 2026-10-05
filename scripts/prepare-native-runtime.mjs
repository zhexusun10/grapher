// Host-only preparation, once per backend process. Share one native runtime
// copy across Graph nodes so source exclusions also work when Grapher hosts itself.
import { cpSync, constants, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, source, verifyBaseline } from './pi-baseline.mjs';
import { verifyPiDependencies } from './pi-dependencies.mjs';
import { bundledExtensionNames, verifyBundledExtensions } from './bundled-extensions.mjs';

// Fail before the expensive Pi copy when an existing checkout needs npm ci.
verifyBundledExtensions(root);
verifyBaseline();
verifyPiDependencies(root);
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
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '--no-checkout', gitPath(source), gitPath(join(destination, 'pi'))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  cpSync(source, join(destination, 'pi'), { ...options, filter: path => resolve(path) !== join(source, '.git') });
  cpSync(join(root, 'engine'), join(destination, 'engine'), {
    ...options,
    // Only the profile manifests are needed at runtime; Pi has the audited
    // dependency copy already. Avoid doubling the install in every Graph copy.
    filter: path => resolve(path) !== join(root, 'engine/pi-dependencies/node_modules'),
  });
  // Bundled extensions have only type-only peer imports; do not copy another Pi runtime.
  for (const name of bundledExtensionNames) {
    cpSync(join(root, 'node_modules', name), join(destination, 'node_modules', name), options);
  }
  // Preserve the installation's ESM boundary in the copy.
  cpSync(join(root, 'package.json'), join(destination, 'package.json'));
  mkdirSync(join(destination, 'scripts'));
  for (const script of ['pi-baseline.mjs', 'pi-dependencies.mjs', 'bundled-extensions.mjs', 'cargo.mjs', 'prepare-native-runtime.mjs']) {
    cpSync(join(root, 'scripts', script), join(destination, 'scripts', script));
  }
  execFileSync('git', ['-C', gitPath(join(destination, 'pi')), 'reset', '--mixed', 'HEAD'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  execFileSync(process.execPath, [gitPath(join(destination, 'scripts/pi-baseline.mjs')), 'verify'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  process.stdout.write(destination);
} catch (error) {
  rmSync(destination, { recursive: true, force: true });
  throw error;
}
