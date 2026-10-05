import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { bundledExtensionNames, missingBundledExtensions, verifyBundledExtensions } from './bundled-extensions.mjs';
import { rootDependenciesReady } from './ensure-deps.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grapher-deps-安装 # %-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const dependencies = Object.fromEntries(bundledExtensionNames.map(name => [name, '1.2.3']));
  write('package.json', JSON.stringify({ type: 'module', dependencies }));
  write('node_modules/vite/bin/vite.js', '');
  write('node_modules/tsx/dist/cli.mjs', '');
  for (const name of bundledExtensionNames) {
    write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: dependencies[name] }));
    write(`node_modules/${name}/extensions/index.ts`, 'throw new Error("Readiness must not load extension code");');
  }
  return { root, write };
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

for (const name of bundledExtensionNames) {
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
    rmSync(join(f.root, 'node_modules', name, 'extensions/index.ts'));
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
