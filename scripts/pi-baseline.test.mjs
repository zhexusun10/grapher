import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { root as realRoot, verifyBaseline, verifyRootPiPins, verifyRuntimeBaseline } from './pi-baseline.mjs';
import { corePackages, dependencyManifest, dependencyProfileHashes } from './pi-dependencies.mjs';

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

test('verifyRuntimeBaseline deduplicates Git/dependency scans per backend context and invalidates on context or input drift', t => {
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
