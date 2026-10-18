import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { bundledExtensions, bundledExtensionNames, missingBundledExtensions, verifyBundledExtensions } from './bundled-extensions.mjs';
import { assertSupportedNode, ensureDependencies, findCargoExecutable, rootDependenciesReady } from './ensure-deps.mjs';
import { pathValue, prependPath } from './cargo.mjs';
import { corePackages, dependencyManifest, dependencyProfileHashes } from './pi-dependencies.mjs';
import { piBuildArtifacts, piBuildReady, recordPiBuild } from './pi-build-state.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grapher-deps-安装 # %-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const dependencies = Object.fromEntries(bundledExtensionNames.map(name => [name, '1.2.3']));
  const devDependencies = { vite: '1.2.3', tsx: '1.2.3', typescript: '1.2.3' };
  const packages = Object.fromEntries(Object.keys({ ...dependencies, ...devDependencies }).map(name =>
    [`node_modules/${name}`, { version: '1.2.3' }]));
  write('package.json', JSON.stringify({ type: 'module', dependencies, devDependencies }));
  write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies, devDependencies }, ...packages } }));
  const installRoot = () => {
    for (const name of Object.keys({ ...dependencies, ...devDependencies })) {
      write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.2.3' }));
    }
    write('node_modules/vite/bin/vite.js', '');
    write('node_modules/tsx/dist/cli.mjs', '');
    write('node_modules/typescript/bin/tsc', '');
    for (const { name, entry } of bundledExtensions) {
      write(`node_modules/${name}/${entry}`, 'throw new Error("Readiness must not load extension code");');
    }
  };
  installRoot();
  write('fake-npm.mjs', '');
  return { root, write, installRoot, env: { ...process.env, npm_execpath: join(root, 'fake-npm.mjs') } };
}

test('root readiness checks dev tools and exact bundled releases without loading code', t => {
  const f = fixture(t);
  assert.equal(rootDependenciesReady(f.root), true);
  assert.deepEqual(missingBundledExtensions(f.root), []);
  assert.doesNotThrow(() => verifyBundledExtensions(f.root));
  for (const path of ['node_modules/vite/bin/vite.js', 'node_modules/tsx/dist/cli.mjs']) {
    rmSync(join(f.root, path));
    assert.equal(rootDependenciesReady(f.root), false);
    f.write(path, '');
  }
});

for (const { name, entry } of bundledExtensions) {
  test(`existing dev tools do not hide a missing ${name} installation`, t => {
    const f = fixture(t);
    rmSync(join(f.root, 'node_modules', name), { recursive: true });
    assert.equal(rootDependenciesReady(f.root), false);
    assert.deepEqual(missingBundledExtensions(f.root), [name]);
    assert.throws(() => verifyBundledExtensions(f.root), error =>
      error.message.includes(name) && error.message.includes('npm ci --ignore-scripts') &&
      error.message.includes('restart Grapher'));
  });

  test(`${name} must have the selected version, package metadata and entrypoint`, t => {
    const f = fixture(t);
    const metadata = `node_modules/${name}/package.json`;
    for (const content of ['invalid json', JSON.stringify({ name, version: '0.0.0' }),
      JSON.stringify({ name: 'another-package', version: '1.2.3' })]) {
      f.write(metadata, content);
      assert.equal(rootDependenciesReady(f.root), false);
      assert.deepEqual(missingBundledExtensions(f.root), [name]);
    }
    rmSync(join(f.root, metadata));
    assert.equal(rootDependenciesReady(f.root), false);
    f.write(metadata, JSON.stringify({ name, version: '1.2.3' }));
    rmSync(join(f.root, 'node_modules', name, entry));
    assert.equal(rootDependenciesReady(f.root), false);
    assert.deepEqual(missingBundledExtensions(f.root), [name]);
  });
}

test('native preparation reports missing root extensions before verification or copying', t => {
  const f = fixture(t);
  rmSync(join(f.root, 'node_modules/pi-continuity'), { recursive: true });
  mkdirSync(join(f.root, 'scripts'));
  for (const script of ['prepare-native-runtime.mjs', 'bundled-extensions.mjs']) {
    cpSync(new URL(script, import.meta.url), join(f.root, 'scripts', script));
  }
  f.write('scripts/pi-baseline.mjs', `
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const source = fileURLToPath(new URL('../pi/', import.meta.url));
export function verifyBaseline() { throw new Error('Pi verification must not run'); }
`);
  f.write('scripts/pi-dependencies.mjs', `
export function verifyPiDependencies() { throw new Error('Pi dependency verification must not run'); }
`);
  const runtimeParent = join(f.root, 'runtimes');
  const result = spawnSync(process.execPath, [join(f.root, 'scripts/prepare-native-runtime.mjs')], {
    cwd: f.root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GRAPHER_NATIVE_RUNTIME_PARENT: runtimeParent },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Bundled Pi extensions are missing or outdated \(pi-continuity\)/);
  assert.match(result.stderr, /npm ci --ignore-scripts/);
  assert.doesNotMatch(result.stderr, /ENOENT|verification must not run/);
  assert.equal(existsSync(runtimeParent), false, 'no partial runtime is created');
});

function installPiFixture(f) {
  const version = '1.2.3';
  f.write('pi/package.json', JSON.stringify({ devDependencies: { typescript: version, '@types/node': version } }));
  for (const name of corePackages) {
    const metadata = JSON.stringify({ name: `@fixture/${name}`, version });
    f.write(`pi/packages/${name}/package.json`, metadata);
    f.write(`pi/node_modules/@fixture/${name}/package.json`, metadata);
  }
  const manifest = dependencyManifest(f.root);
  f.write('engine/pi-dependencies/package.json', JSON.stringify(manifest));
  const packages = { '': { dependencies: manifest.dependencies } };
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    packages[`node_modules/${name}`] = { version, resolved: `https://registry.npmjs.org/${name}`, integrity: 'sha512-AAAA' };
    f.write(`pi/node_modules/${name}/package.json`, JSON.stringify({ name, version }));
  }
  f.write('engine/pi-dependencies/package-lock.json', JSON.stringify({ name: manifest.name, version, lockfileVersion: 3, packages }));
  f.write('pi/node_modules/.grapher-pi-dependencies.json', JSON.stringify(dependencyProfileHashes(f.root)));
  const content = '{}\n';
  const hash = createHash('sha256').update(content).digest('hex');
  f.write('engine/pi-lock.json', JSON.stringify({ modelData: { '.manifest.json': hash } }));
  for (const directory of ['src', 'dist']) f.write(`pi/packages/ai/${directory}/providers/data/.manifest.json`, content);
  for (const path of piBuildArtifacts) f.write(`pi/${path}`, '');
  recordPiBuild(f.root);
}

const bootstrap = (f, run, options = {}) => ensureDependencies({
  installationRoot: f.root, env: f.env, cargoPath: process.execPath, log: () => {}, run, ...options,
});

test('unsupported Node versions fail with actionable guidance', () => {
  for (const version of ['18.20.0', '20.19.0', '22.18.0']) assert.throws(() => assertSupportedNode(version), /Node.js 22.19\+/);
  for (const version of ['22.19.0', '22.20.0', '24.0.0']) assert.doesNotThrow(() => assertSupportedNode(version));
});

test('root readiness detects lock changes and incomplete development/transitive installs', t => {
  const f = fixture(t);
  f.write('node_modules/vite/package.json', JSON.stringify({ name: 'vite', version: '0.0.0' }));
  assert.equal(rootDependenciesReady(f.root), false);
  f.installRoot();
  rmSync(join(f.root, 'node_modules/typescript/bin/tsc'));
  assert.equal(rootDependenciesReady(f.root), false);
});

test('missing or unusable host tools fail before installing anything', async t => {
  const f = fixture(t);
  const calls = [];
  await assert.rejects(bootstrap(f, (...args) => calls.push(args), { cargoPath: null }), /Rust\/Cargo is required/);
  assert.equal(calls.length, 0);
  await assert.rejects(bootstrap(f, () => { throw new Error('not installed'); }), /Git is not usable/);
});

test('PATH helpers keep the launcher-delivered key casing for Windows spawn search', t => {
  // Explorer/PowerShell chains deliver "Path", POSIX shells "PATH"; a child env
  // containing both names makes spawn fail to locate any executable.
  for (const key of ['PATH', 'Path']) {
    const env = prependPath({ [key]: 'C:\\Git\\cmd' }, 'C:\\cargo\\bin');
    assert.deepEqual(Object.keys(env).filter(name => /^path$/i.test(name)), [key]);
    assert.equal(env[key], ['C:\\cargo\\bin', 'C:\\Git\\cmd'].join(delimiter));
    assert.equal(pathValue(env), env[key]);
  }
  const first = prependPath({ Path: 'C:\\Git\\cmd' }, 'C:\\cargo\\bin');
  const merged = prependPath({ ...first }, 'C:\\rust\\bin');
  assert.deepEqual(Object.keys(merged).filter(name => /^path$/i.test(name)), ['Path']);
  assert.equal(merged.Path, ['C:\\rust\\bin', 'C:\\cargo\\bin', 'C:\\Git\\cmd'].join(delimiter));
});

test('findCargoExecutable answers identically for either PATH key casing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-cargo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  writeFileSync(join(dir, cargoName), '');
  const viaUpper = findCargoExecutable({ PATH: dir });
  assert.equal(viaUpper, findCargoExecutable({ Path: dir }));
  const homeCandidate = join(homedir(), '.cargo/bin', cargoName);
  if (!existsSync(homeCandidate)) {
    assert.equal(viaUpper, join(dir, cargoName));
    assert.equal(findCargoExecutable({ PATH: `${join(dir, 'absent')}${delimiter}${dir}` }), join(dir, cargoName));
  }
});

test('tool-check child envs keep a single PATH name and the cargo entry first', async t => {
  const f = fixture(t);
  // A Path-cased environment without PATH must not gain a duplicate entry:
  // spawn cannot resolve executables from such child blocks on Windows.
  const base = { npm_execpath: f.env.npm_execpath, Path: 'C:\\Git\\cmd' };
  const childEnvs = [];
  await assert.rejects(ensureDependencies({
    installationRoot: f.root, env: base, cargoPath: process.execPath, log: () => {},
    run: (command, args, options) => { childEnvs.push(options.env); throw new Error('not installed'); },
  }), /Git is not usable/);
  assert.deepEqual(Object.keys(childEnvs[0]).filter(name => /^path$/i.test(name)), ['Path']);
  assert.equal(childEnvs[0].Path, [dirname(process.execPath), 'C:\\Git\\cmd'].join(delimiter));
});

test('clean bootstrap initializes submodule, uses locked dev-inclusive npm install, then prepares Pi', async t => {
  const f = fixture(t);
  rmSync(join(f.root, 'node_modules'), { recursive: true });
  const calls = [];
  await bootstrap(f, async (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'submodule') f.write('pi/package.json', '{}');
    if (args[1] === 'ci') f.installRoot();
    if (args[1] === 'setup') installPiFixture(f);
  });
  assert.deepEqual(calls.slice(2).map(([, args]) => args), [
    ['submodule', 'update', '--init', '--recursive'],
    [f.env.npm_execpath, 'ci', '--ignore-scripts', '--include=dev'],
    [join(f.root, 'scripts/pi-baseline.mjs'), 'setup'],
  ]);
  assert.equal(rootDependenciesReady(f.root), true);
  assert.equal(piBuildReady(f.root), true);
  const second = [];
  await bootstrap(f, (command, args) => second.push([command, args]));
  assert.deepEqual(second.map(([, args]) => args), [['--version'], ['--version']], 'warm starts perform no downloads or builds');
});

test('failed npm ci is not retried with an unlocked install and never starts Pi', async t => {
  const f = fixture(t);
  f.write('pi/package.json', '{}');
  rmSync(join(f.root, 'node_modules'), { recursive: true });
  const calls = [];
  await assert.rejects(bootstrap(f, (command, args) => {
    calls.push(args);
    if (args[1] === 'ci') throw new Error('network unavailable');
  }), /does not fall back to npm install/);
  assert.equal(calls.length, 3);
});

test('missing, interrupted or stale Pi artifacts rebuild without reinstalling reviewed dependencies', async t => {
  const f = fixture(t);
  installPiFixture(f);
  for (const path of piBuildArtifacts) {
    rmSync(join(f.root, 'pi', path));
    assert.equal(piBuildReady(f.root), false, path);
    f.write(`pi/${path}`, '');
  }
  for (const path of ['pi/node_modules/.grapher-pi-build.json', 'pi/packages/ai/src/providers/data/.manifest.json']) {
    rmSync(join(f.root, path));
    const calls = [];
    await bootstrap(f, (command, args) => {
      calls.push(args);
      if (args[1] === 'build') installPiFixture(f);
    });
    assert.deepEqual(calls.slice(2), [[join(f.root, 'scripts/pi-baseline.mjs'), 'build']]);
  }
  f.write('engine/pi-lock.json', JSON.stringify({ modelData: {}, changed: true }));
  assert.equal(piBuildReady(f.root), false, 'baseline updates invalidate the build stamp');
});

test('failed or incomplete Pi setup cannot be reported as ready', async t => {
  const f = fixture(t);
  f.write('pi/package.json', '{}');
  await assert.rejects(bootstrap(f, () => {}));
});
