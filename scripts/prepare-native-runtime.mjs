// Host-only preparation, once per backend process. Share one native runtime
// copy across Graph nodes so source exclusions also work when Grapher hosts itself.
import { cpSync, constants, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, source, verifyBaseline } from './pi-baseline.mjs';

verifyBaseline();
const runtimeParent = process.env.GRAPHER_NATIVE_RUNTIME_PARENT
  ? resolve(process.env.GRAPHER_NATIVE_RUNTIME_PARENT)
  : tmpdir();
mkdirSync(runtimeParent, { recursive: true });
const destination = mkdtempSync(join(runtimeParent, 'grapher-native-engine-'));
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
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  // Independent metadata; never retain the submodule's pointer into source/.git.
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '--no-checkout', gitPath(source), gitPath(join(destination, 'pi'))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  cpSync(source, join(destination, 'pi'), { ...options, filter: path => resolve(path) !== join(source, '.git') });
  cpSync(join(root, 'engine'), join(destination, 'engine'), options);
  // Preserve the installation's ESM boundary in the copy.
  cpSync(join(root, 'package.json'), join(destination, 'package.json'));
  mkdirSync(join(destination, 'scripts'));
  for (const script of ['pi-baseline.mjs', 'cargo.mjs']) {
    cpSync(join(root, 'scripts', script), join(destination, 'scripts', script));
  }
  execFileSync('git', ['-C', gitPath(join(destination, 'pi')), 'reset', '--mixed', 'HEAD'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  execFileSync(process.execPath, [gitPath(join(destination, 'scripts/pi-baseline.mjs')), 'verify'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  process.stdout.write(destination);
} catch (error) {
  rmSync(destination, { recursive: true, force: true });
  throw error;
}
