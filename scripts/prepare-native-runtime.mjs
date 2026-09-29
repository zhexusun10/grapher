// Host-only preparation, once per backend process. Share one native runtime
// copy across Graph nodes so source exclusions also work when Grapher hosts itself.
import { cpSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const tsxTempModule = readdirSync(join(destination, 'pi/node_modules/tsx/dist'))
    .find(name => name.startsWith('temporary-directory-') && name.endsWith('.cjs'));
  if (tsxTempModule) {
    const path = join(destination, 'pi/node_modules/tsx/dist', tsxTempModule);
    const contents = readFileSync(path, 'utf8').replace(
      'tsx-${t}`',
      'tsx-${t}-${process.env.GRAPHER_TSX_PIPE_ID || process.pid}`',
    );
    writeFileSync(path, contents);
  }
  const tsxCliModule = join(destination, 'pi/node_modules/tsx/dist/cli.cjs');
  const tsxCli = readFileSync(tsxCliModule, 'utf8')
    .replace(
      'he.require.resolve("./preflight.cjs")',
      'process.env.GRAPHER_WINDOWS_SANDBOX_TSX_PREFLIGHT || he.require.resolve("./preflight.cjs")',
    )
    .replace(
      '_u.pathToFileURL(he.require.resolve("./loader.mjs")).toString()',
      'process.env.GRAPHER_WINDOWS_SANDBOX_TSX_LOADER || _u.pathToFileURL(he.require.resolve("./loader.mjs")).toString()',
    )
    .replace(
      'const D=await _n(),o=ir(',
      'const D={on(){return D}},o=ir(',
    );
  writeFileSync(tsxCliModule, tsxCli);
  cpSync(join(root, 'engine'), join(destination, 'engine'), options);
  // tsx resolves the module format of execution-cli.ts from the nearest
  // package.json. Preserve the installation's ESM boundary in the copy.
  cpSync(join(root, 'package.json'), join(destination, 'package.json'));
  if (process.platform === 'win32') {
    // AppContainer cannot safely add an ACL to Node under Program Files.
    // Run the sandbox from this Grapher-owned copy instead.
    cpSync(process.execPath, join(destination, 'node.exe'), { mode: constants.COPYFILE_FICLONE });
    if (process.env.GRAPHER_NATIVE_COMPILER) {
      cpSync(process.env.GRAPHER_NATIVE_COMPILER, join(destination, 'grapher-compiler.exe'), {
        mode: constants.COPYFILE_FICLONE,
      });
    }
  }
  mkdirSync(join(destination, 'scripts'));
  for (const name of ['pi-baseline.mjs', 'cargo.mjs']) cpSync(join(root, 'scripts', name), join(destination, 'scripts', name));
  // Populate the clone index without checking out over the installed dependencies.
  execFileSync('git', ['-C', gitPath(join(destination, 'pi')), 'reset', '--mixed', 'HEAD'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  execFileSync(process.execPath, [gitPath(join(destination, 'scripts/pi-baseline.mjs')), 'verify'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  process.stdout.write(destination);
} catch (error) {
  rmSync(destination, { recursive: true, force: true });
  throw error;
}
