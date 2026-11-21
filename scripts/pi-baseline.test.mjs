import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  buildBundledPiManifest,
  BUNDLED_PI_MANIFEST_FILE,
  root as realRoot,
  verifyBaseline,
  verifyRootPiPins,
  verifyRuntimeBaseline,
} from './pi-baseline.mjs';
import {
  computeRuntimeDependencyKeys,
  corePackages,
  dependencyManifest,
  dependencyProfileHashes,
  PI_DEPENDENCIES_MODE_RUNTIME_ONLY,
  verifyPiDependencies,
} from './pi-dependencies.mjs';

const digest = content => createHash('sha256').update(content).digest('hex');
const peers = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grapher-pi-verify-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const pi = join(root, 'pi');
  mkdirSync(pi);
  const git = (...args) => execFileSync('git', ['-C', pi, ...args], {
    encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  }).trim();
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  write('pi/.gitignore', 'dist/\n');
  write('pi/package-lock.json', '{}\n');
  write('pi/packages/coding-agent/package.json', '{"version":"1.5.0"}\n');
  write('pi/source.js', 'export {};\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline');
  const baseline = { forkCommit: git('rev-parse', 'HEAD'), packageVersion: '1.5.0',
    packageLockSha256: digest('{}\n'), modelData: { '.manifest.json': digest('{}\n') } };
  write('engine/model-data/.manifest.json', '{}\n');
  const dependencies = Object.fromEntries(peers.map(name => [name, '1.5.0']));
  const npmLock = { packages: { '': { dependencies }, ...Object.fromEntries(peers.map(name => [`node_modules/${name}`, { version: '1.5.0' }])) } };
  write('package.json', JSON.stringify({ dependencies }));
  write('package-lock.json', JSON.stringify(npmLock));
  return { root, pi, git, write, baseline, npmLock, verify: () => verifyBaseline({ installationRoot: root, baseline }) };
}

test('Pi verification accepts the pinned clean checkout and ignored artifacts', t => {
  const f = fixture(t);
  f.write('pi/dist/output.js', 'built');
  f.verify();
  verifyRootPiPins({ installationRoot: f.root, baseline: f.baseline });
});

test('Pi verification rejects another commit and tracked, staged or untracked changes', t => {
  const f = fixture(t);
  f.write('pi/source.js', 'changed\n');
  assert.throws(f.verify, /tracked or untracked changes/);
  f.git('add', 'source.js');
  assert.throws(f.verify, /tracked or untracked changes/);
  f.git('reset', '--hard', '-q', 'HEAD');
  f.write('pi/extra.js', 'untracked');
  assert.throws(f.verify, /tracked or untracked changes/);
  rmSync(join(f.pi, 'extra.js'));
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'other');
  assert.throws(f.verify, /expected .*restore the pinned submodule/);
});

test('Pi verification detects invalid metadata and reviewed model-data drift', t => {
  const f = fixture(t);
  f.baseline.packageVersion = '1.4.0';
  assert.throws(f.verify, /coding-agent version/);
  f.baseline.packageVersion = '1.5.0';
  f.baseline.packageLockSha256 = '0'.repeat(64);
  assert.throws(f.verify, /package-lock.json/);
  f.baseline.packageLockSha256 = digest('{}\n');
  f.write('engine/model-data/.manifest.json', 'modified');
  assert.throws(f.verify, /model data differs/);
  f.write('engine/model-data/.manifest.json', '{}\n');
  f.write('engine/model-data/extra.json', '{}');
  assert.throws(f.verify, /model-data files/);
});

test('root Pi pins and lock entries must match the recorded release', t => {
  const f = fixture(t);
  const verify = () => verifyRootPiPins({ installationRoot: f.root, baseline: f.baseline });
  f.write('package.json', JSON.stringify({ dependencies: { [peers[0]]: '^1.5.0', [peers[1]]: '1.5.0' } }));
  assert.throws(verify, /must be pinned/);
  f.write('package.json', JSON.stringify({ dependencies: Object.fromEntries(peers.map(name => [name, '1.5.0'])) }));
  f.npmLock.packages[`node_modules/${peers[1]}`].version = '1.4.0';
  f.write('package-lock.json', JSON.stringify(f.npmLock));
  assert.throws(verify, /must be pinned/);
});

test('Pi verification rejects an uninitialized checkout', t => {
  const f = fixture(t);
  rmSync(join(f.pi, '.git'), { recursive: true, force: true });
  assert.throws(f.verify, /Cannot inspect Pi checkout/);
});

function runtimeFixture(t) {
  const f = fixture(t);
  const version = '1.5.0';
  f.write('pi/.gitignore', 'dist/\nnode_modules/\npackages/ai/src/providers/data/\n');
  f.write('pi/package.json', JSON.stringify({ devDependencies: { typescript: version, '@types/node': version } }));
  for (const name of corePackages) {
    f.write(`pi/packages/${name}/package.json`, JSON.stringify({ name: `@fixture/${name}`, version }));
  }
  f.git('add', '.');
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'workspace-packages');
  f.baseline.forkCommit = f.git('rev-parse', 'HEAD');
  f.write('engine/pi-lock.json', JSON.stringify(f.baseline));
  for (const name of corePackages) {
    const metadata = JSON.stringify({ name: `@fixture/${name}`, version });
    f.write(`pi/node_modules/@fixture/${name}/package.json`, metadata);
  }
  const manifest = dependencyManifest(f.root);
  f.write('engine/pi-dependencies/package.json', JSON.stringify(manifest));
  const packages = { '': { dependencies: manifest.dependencies } };
  for (const [name, depVersion] of Object.entries(manifest.dependencies)) {
    packages[`node_modules/${name}`] = { version: depVersion, resolved: `https://registry.npmjs.org/${name}`, integrity: 'sha512-AAAA' };
    f.write(`pi/node_modules/${name}/package.json`, JSON.stringify({ name, version: depVersion }));
  }
  f.write('engine/pi-dependencies/package-lock.json', JSON.stringify({ name: manifest.name, version, lockfileVersion: 3, packages }));
  f.write('pi/node_modules/.grapher-pi-dependencies.json', JSON.stringify(dependencyProfileHashes(f.root)));

  return f;
}

test('verifyRuntimeBaseline deduplicates Git/dependency scans per backend context and invalidates on context or input drift', t => {
  const f = runtimeFixture(t);

  const prevContext = process.env.GRAPHER_BASELINE_CONTEXT;
  const prevVerified = process.env.GRAPHER_VERIFIED_BASELINE;
  const prevGit = process.env.GRAPHER_TRUSTED_GIT;
  t.after(() => {
    if (prevContext === undefined) delete process.env.GRAPHER_BASELINE_CONTEXT;
    else process.env.GRAPHER_BASELINE_CONTEXT = prevContext;
    if (prevVerified === undefined) delete process.env.GRAPHER_VERIFIED_BASELINE;
    else process.env.GRAPHER_VERIFIED_BASELINE = prevVerified;
    if (prevGit === undefined) delete process.env.GRAPHER_TRUSTED_GIT;
    else process.env.GRAPHER_TRUSTED_GIT = prevGit;
    verifyRuntimeBaseline({ installationRoot: realRoot });
  });

  process.env.GRAPHER_BASELINE_CONTEXT = `test-ctx-1:${Date.now()}`;
  delete process.env.GRAPHER_VERIFIED_BASELINE;

  const first = verifyRuntimeBaseline({ installationRoot: f.root, baseline: f.baseline });
  assert.deepEqual(first, { verified: true, cached: false });

  // Subsequent prewarm workers in the same backend lifecycle reuse the verified stamp without spawning Git.
  delete process.env.GRAPHER_VERIFIED_BASELINE;
  process.env.GRAPHER_TRUSTED_GIT = join(f.root, 'missing-git-binary');
  const second = verifyRuntimeBaseline({ installationRoot: f.root, baseline: f.baseline });
  assert.deepEqual(second, { verified: true, cached: true });

  // A new backend lifecycle context must re-run full verification (and therefore observe the missing Git binary).
  process.env.GRAPHER_BASELINE_CONTEXT = `test-ctx-2:${Date.now()}`;
  delete process.env.GRAPHER_VERIFIED_BASELINE;
  assert.throws(() => verifyRuntimeBaseline({ installationRoot: f.root, baseline: f.baseline }), /Cannot inspect Pi checkout/);

  // Without an explicit backend context, standalone runs never reuse a shared stamp.
  delete process.env.GRAPHER_BASELINE_CONTEXT;
  delete process.env.GRAPHER_VERIFIED_BASELINE;
  assert.throws(() => verifyRuntimeBaseline({ installationRoot: f.root, baseline: f.baseline }), /Cannot inspect Pi checkout/);
});

test('host-primed baseline stamps survive private temp changes and still reject fingerprint drift', t => {
  const f = runtimeFixture(t);
  const cache = join(f.root, 'runtime-cache');
  const context = `private-cache:${f.root}`;
  const probe = (session, cached, backendContext = context) => {
    const temp = join(f.root, session);
    mkdirSync(temp);
    const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp,
      GRAPHER_RUNTIME_CACHE_DIR: cache, GRAPHER_BASELINE_CONTEXT: backendContext };
    delete env.GRAPHER_VERIFIED_BASELINE;
    if (cached) env.GRAPHER_TRUSTED_GIT = join(f.root, 'missing-git');
    const code = `import { verifyRuntimeBaseline } from ${JSON.stringify(pathToFileURL(join(realRoot, 'scripts/pi-baseline.mjs')).href)};
      console.log(JSON.stringify(verifyRuntimeBaseline({ installationRoot: ${JSON.stringify(f.root)}, baseline: ${JSON.stringify(f.baseline)} })));`;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  };
  assert.deepEqual(probe('session-a', false), { verified: true, cached: false });
  const old = new Date(Date.now() - 3600000);
  for (const name of readdirSync(join(cache, 'baseline'))) utimesSync(join(cache, 'baseline', name), old, old);
  assert.deepEqual(probe('new-backend', false, `${context}:next`), { verified: true, cached: false });
  assert.deepEqual(probe('session-b', true), { verified: true, cached: true });
  f.write('pi/package-lock.json', '{"drift":true}\n');
  assert.throws(() => probe('session-c', true), /Command failed/);
});

test('bundled desktop manifest verification replaces .git and rejects drift, missing, or extra files', t => {
  const f = fixture(t);
  rmSync(join(f.pi, '.git'), { recursive: true, force: true });
  const manifest = buildBundledPiManifest(f.pi, f.baseline);
  f.write(`pi/${BUNDLED_PI_MANIFEST_FILE}`, `${JSON.stringify(manifest, null, 2)}\n`);

  // Clean bundled runtime passes without Git.
  f.verify();

  // Modified file fails integrity check.
  f.write('pi/source.js', 'tampered\n');
  assert.throws(f.verify, /integrity mismatch/);
  f.write('pi/source.js', 'export {};\n');

  // Extra untracked file fails file list check.
  f.write('pi/extra.js', 'untracked\n');
  assert.throws(f.verify, /file list mismatch/);
  rmSync(join(f.pi, 'extra.js'));

  // Missing file fails file list check.
  rmSync(join(f.pi, 'source.js'));
  assert.throws(f.verify, /file list mismatch/);
  f.write('pi/source.js', 'export {};\n');

  // Mismatched forkCommit fails manifest check.
  f.write(`pi/${BUNDLED_PI_MANIFEST_FILE}`, `${JSON.stringify({ ...manifest, forkCommit: '0'.repeat(40) })}\n`);
  assert.throws(f.verify, /does not match engine\/pi-lock\.json/);
});

test('runtime-only dependency verification is restricted to trusted bundled installations and rejects dev/extra packages', t => {
  const f = fixture(t);
  const version = '1.5.0';
  f.write('pi/package.json', JSON.stringify({ devDependencies: { typescript: version, '@types/node': version } }));
  for (const name of corePackages) {
    const deps = name === 'coding-agent' ? { 'runtime-pkg': '1.0.0' } : {};
    const devDeps = name === 'coding-agent' ? { vitest: '4.0.0' } : {};
    f.write(
      `pi/packages/${name}/package.json`,
      JSON.stringify({ name: `@fixture/${name}`, version, dependencies: deps, devDependencies: devDeps }),
    );
  }
  const manifest = dependencyManifest(f.root);
  f.write('engine/pi-dependencies/package.json', JSON.stringify(manifest));
  const packages = { '': { dependencies: manifest.dependencies } };
  for (const [name, depVersion] of Object.entries(manifest.dependencies)) {
    packages[`node_modules/${name}`] = {
      version: depVersion,
      resolved: `https://registry.npmjs.org/${name}`,
      integrity: 'sha512-AAAA',
    };
  }
  const depLock = { name: manifest.name, version, lockfileVersion: 3, packages };
  f.write('engine/pi-dependencies/package-lock.json', JSON.stringify(depLock));

  const runtimeKeys = computeRuntimeDependencyKeys(f.root, depLock);
  assert.equal(runtimeKeys.has('node_modules/runtime-pkg'), true);
  assert.equal(runtimeKeys.has('node_modules/typescript'), false);
  assert.equal(runtimeKeys.has('node_modules/vitest'), false);
  assert.equal(runtimeKeys.has('node_modules/@types/node'), false);

  // Convert fixture into a sealed bundled-desktop runtime without .git.
  rmSync(join(f.pi, '.git'), { recursive: true, force: true });
  for (const name of corePackages) {
    f.write(
      `pi/node_modules/@fixture/${name}/package.json`,
      JSON.stringify({
        name: `@fixture/${name}`,
        version,
        dependencies: name === 'coding-agent' ? { 'runtime-pkg': '1.0.0' } : {},
        devDependencies: name === 'coding-agent' ? { vitest: '4.0.0' } : {},
      }),
    );
  }
  f.write('pi/node_modules/runtime-pkg/package.json', JSON.stringify({ name: 'runtime-pkg', version: '1.0.0' }));
  f.write(
    'pi/node_modules/.grapher-pi-dependencies.json',
    JSON.stringify({ ...dependencyProfileHashes(f.root), mode: PI_DEPENDENCIES_MODE_RUNTIME_ONLY }),
  );
  f.write(`pi/${BUNDLED_PI_MANIFEST_FILE}`, `${JSON.stringify(buildBundledPiManifest(f.pi, f.baseline), null, 2)}\n`);

  assert.equal(verifyPiDependencies(f.root), version);

  // Pruned dev-only packages must be rejected as extraneous in runtime-only bundles.
  f.write('pi/node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version }));
  assert.throws(() => verifyPiDependencies(f.root), /Extraneous Pi dependency: node_modules\/typescript/);
  rmSync(join(f.pi, 'node_modules/typescript'), { recursive: true, force: true });

  // Missing required runtime dependency must still fail.
  rmSync(join(f.pi, 'node_modules/runtime-pkg'), { recursive: true, force: true });
  assert.throws(() => verifyPiDependencies(f.root), /Installed Pi dependency mismatch: node_modules\/runtime-pkg/);
  f.write('pi/node_modules/runtime-pkg/package.json', JSON.stringify({ name: 'runtime-pkg', version: '1.0.0' }));

  // verifyRuntimeBaseline deduplicates scans on a .git-less bundled runtime and invalidates on manifest drift.
  const prevContext = process.env.GRAPHER_BASELINE_CONTEXT;
  const prevVerified = process.env.GRAPHER_VERIFIED_BASELINE;
  const prevGit = process.env.GRAPHER_TRUSTED_GIT;
  t.after(() => {
    if (prevContext === undefined) delete process.env.GRAPHER_BASELINE_CONTEXT;
    else process.env.GRAPHER_BASELINE_CONTEXT = prevContext;
    if (prevVerified === undefined) delete process.env.GRAPHER_VERIFIED_BASELINE;
    else process.env.GRAPHER_VERIFIED_BASELINE = prevVerified;
    if (prevGit === undefined) delete process.env.GRAPHER_TRUSTED_GIT;
    else process.env.GRAPHER_TRUSTED_GIT = prevGit;
  });

  process.env.GRAPHER_BASELINE_CONTEXT = `bundled-ctx-${Date.now()}`;
  delete process.env.GRAPHER_VERIFIED_BASELINE;
  process.env.GRAPHER_TRUSTED_GIT = join(f.root, 'missing-git-binary');

  const first = verifyRuntimeBaseline({ installationRoot: f.root, baseline: f.baseline });
  assert.deepEqual(first, { verified: true, cached: false });

  delete process.env.GRAPHER_VERIFIED_BASELINE;
  const second = verifyRuntimeBaseline({ installationRoot: f.root, baseline: f.baseline });
  assert.deepEqual(second, { verified: true, cached: true });

  // Manifest schema/hash drift must invalidate the cached fingerprint and fail closed.
  const manifestPath = join(f.pi, BUNDLED_PI_MANIFEST_FILE);
  const currentManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, `${JSON.stringify({ ...currentManifest, packageLockSha256: '0'.repeat(64) })}\n`);
  delete process.env.GRAPHER_VERIFIED_BASELINE;
  assert.throws(
    () => verifyRuntimeBaseline({ installationRoot: f.root, baseline: f.baseline }),
    /does not match engine\/pi-lock\.json/,
  );
});
