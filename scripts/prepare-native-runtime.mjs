// Host-only preparation, once per backend process. Share one native runtime
// copy across Graph nodes so source exclusions also work when Grapher hosts itself.
import { cpSync, constants, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, source, verifyBaseline } from './pi-baseline.mjs';

verifyBaseline();
const destination = mkdtempSync(join(tmpdir(), 'grapher-native-engine-'));
try {
  const options = { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  // Independent metadata; never retain the submodule's pointer into source/.git.
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '--no-checkout', source, join(destination, 'pi')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  cpSync(source, join(destination, 'pi'), { ...options, filter: path => resolve(path) !== join(source, '.git') });
  cpSync(join(root, 'engine'), join(destination, 'engine'), options);
  mkdirSync(join(destination, 'scripts'));
  for (const name of ['pi-baseline.mjs', 'cargo.mjs']) cpSync(join(root, 'scripts', name), join(destination, 'scripts', name));
  // Populate the clone index without checking out over the installed dependencies.
  execFileSync('git', ['-C', join(destination, 'pi'), 'reset', '--mixed', 'HEAD'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  execFileSync(process.execPath, [join(destination, 'scripts/pi-baseline.mjs'), 'verify'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  process.stdout.write(destination);
} catch (error) {
  rmSync(destination, { recursive: true, force: true });
  throw error;
}
