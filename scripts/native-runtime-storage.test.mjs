import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grapher-runtime-安装 # %-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const scripts = join(root, 'scripts');
  const parent = join(root, 'runtimes');
  mkdirSync(scripts);
  mkdirSync(parent);
  cpSync(new URL('prepare-native-runtime.mjs', import.meta.url), join(scripts, 'prepare-native-runtime.mjs'));
  writeFileSync(join(scripts, 'pi-baseline.mjs'), `
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const source = fileURLToPath(new URL('../pi/', import.meta.url));
export function verifyBaseline() {}
`);
  writeFileSync(join(scripts, 'pi-dependencies.mjs'), 'export function verifyPiDependencies() {}');
  writeFileSync(join(scripts, 'bundled-extensions.mjs'), 'export const bundledExtensionNames = []; export function verifyBundledExtensions() {}');
  writeFileSync(join(scripts, 'cargo.mjs'), '');
  writeFileSync(join(root, 'package.json'), '{"name":"grapher","type":"module"}');
  const run = (destination, runtimeParent = parent) => spawnSync(process.execPath, [join(scripts, 'prepare-native-runtime.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GRAPHER_NATIVE_RUNTIME_PARENT: runtimeParent, GRAPHER_NATIVE_RUNTIME_DIR: destination },
  });
  const child = () => join(parent, `grapher-native-engine-${randomUUID()}`);
  const key = (installation = root, runtimeParent = parent, cachedCopy) => {
    const result = spawnSync(process.execPath, [join(installation, 'scripts/prepare-native-runtime.mjs'), '--cache-key', ...(cachedCopy ? [cachedCopy] : [])], {
      cwd: installation, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, GRAPHER_NATIVE_RUNTIME_PARENT: runtimeParent },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^[a-f0-9]{64}$/);
    return result.stdout;
  };
  return { root, parent, run, child, key };
}

test('leased preparation rejects external, nonempty and linked destinations without deleting data', t => {
  const f = fixture(t);
  const outside = join(f.root, `grapher-native-engine-${randomUUID()}`);
  const occupied = f.child();
  for (const path of [outside, occupied]) {
    mkdirSync(path);
    writeFileSync(join(path, 'keep'), 'user data');
    const result = f.run(path);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /empty, leased child/);
    assert.equal(readFileSync(join(path, 'keep'), 'utf8'), 'user data');
  }
  const linked = f.child();
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.run(linked);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /empty, leased child/);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'user data');
});

test('cache identity follows engine inputs, not workspace, cache parent or installation location', t => {
  const f = fixture(t);
  for (const path of ['engine', 'pi/packages/core/dist', 'node_modules/pi-trim']) mkdirSync(join(f.root, path), { recursive: true });
  for (const path of ['engine/entrypoint.mjs', 'pi/package.json', 'pi/package-lock.json', 'pi/packages/core/dist/index.js', 'node_modules/pi-trim/index.js']) {
    writeFileSync(join(f.root, path), '{}');
  }
  writeFileSync(join(f.root, 'scripts/bundled-extensions.mjs'), 'export const bundledExtensionNames = ["pi-trim"]; export function verifyBundledExtensions() {}');
  const initial = f.key();
  const otherParent = join(f.root, 'another-workspace-cache');
  assert.equal(f.key(f.root, otherParent), initial);
  assert.equal(existsSync(otherParent), false, 'computing identity does not allocate a cache');
  writeFileSync(join(f.root, 'project.txt'), 'another project');
  assert.equal(f.key(), initial);
  const relocated = mkdtempSync(join(tmpdir(), 'grapher-runtime-relocated-'));
  t.after(() => rmSync(relocated, { recursive: true, force: true }));
  // Node 22's native recursive copy can crash on Unicode Windows paths.
  // Select the portable walker, matching prepare-native-runtime.mjs.
  cpSync(f.root, relocated, {
    recursive: true,
    filter: process.platform === 'win32' ? () => true : undefined,
  });
  assert.equal(f.key(relocated), initial);
  assert.equal(f.key(f.root, f.parent, relocated), initial, 'cached artifacts are checked by the installed verifier');
  mkdirSync(join(relocated, 'engine/.grapher-masks-active/empty'), { recursive: true });
  assert.equal(f.key(f.root, f.parent, relocated), initial, 'Linux mount staging is not an engine input');
  writeFileSync(join(relocated, 'engine/entrypoint.mjs'), 'modified cached adapter');
  assert.notEqual(f.key(f.root, f.parent, relocated), initial, 'a changed cached engine must not be reused');
  let previous = initial;
  for (const path of ['engine/entrypoint.mjs', 'pi/packages/core/dist/index.js', 'pi/package-lock.json', 'node_modules/pi-trim/index.js', 'scripts/prepare-native-runtime.mjs']) {
    writeFileSync(join(f.root, path), readFileSync(join(f.root, path), 'utf8') + '\n// changed runtime input');
    const changed = f.key();
    assert.notEqual(changed, previous, `${path} invalidates the engine cache`);
    previous = changed;
  }
});

test('preparation uses the already leased directory, including extended Windows parent paths', t => {
  const f = fixture(t);
  const source = join(f.root, 'pi');
  mkdirSync(source);
  writeFileSync(join(source, 'package.json'), '{"type":"module"}');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { env, stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  mkdirSync(join(f.root, 'engine'));
  writeFileSync(join(f.root, 'engine/entrypoint.mjs'), 'export {};');
  const destination = f.child();
  mkdirSync(destination);
  writeFileSync(join(destination, 'runtime.lock'), '');
  writeFileSync(join(destination, '.grapher-native-runtime.json'), '{"kind":"grapher-native-runtime","version":1}');
  const backslash = String.fromCharCode(92);
  const parent = process.platform === 'win32' ? backslash + backslash + '?' + backslash + f.parent : f.parent;
  const result = f.run(destination, parent);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(realpathSync.native(result.stdout), realpathSync.native(destination));
  assert.equal(readFileSync(join(destination, 'engine/entrypoint.mjs'), 'utf8'), 'export {};');
  assert.ok(existsSync(join(destination, '.grapher-native-runtime.json')));
  assert.ok(existsSync(join(destination, 'runtime.lock')));
  assert.equal(execFileSync('git', ['-C', join(destination, 'pi'), 'config', '--get', 'core.longpaths'], { encoding: 'utf8', env }).trim(), 'true');
});
