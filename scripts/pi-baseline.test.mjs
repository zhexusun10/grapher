import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { verifyBaseline, verifyRootPiPins } from './pi-baseline.mjs';

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
