// Explicitly adopt an already checked-out Pi commit after upstream model-data
// hydration. This only stages the Grapher baseline; it never fetches or pulls.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, source } from './pi-baseline.mjs';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const git = (...args) => execFileSync('git', ['-C', source, ...args], {
  encoding: 'utf8',
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
}).trim();

export function candidateLock(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha) || git('rev-parse', 'HEAD') !== sha) {
    throw new Error('Specify the full SHA of the checked-out Pi commit');
  }
  if (git('status', '--porcelain', '--untracked-files=normal')) {
    throw new Error('Pi has local changes; adopt only a clean upstream commit');
  }
  const dataDir = join(source, 'packages/ai/src/providers/data');
  // Include the upstream manifest: fresh clones have no ignored model data and
  // the offline build needs this file to validate the restored catalog.
  const names = readdirSync(dataDir).sort();
  if (!names.length || names.some(name => name !== '.manifest.json' && !/^[a-z0-9-]+\.json$/.test(name))) {
    throw new Error('Pi model data is missing or has unexpected files; hydrate it first');
  }
  const pkg = JSON.parse(readFileSync(join(source, 'packages/coding-agent/package.json'), 'utf8'));
  const modelData = Object.fromEntries(names.map(name => [name, hash(join(dataDir, name))]));
  return {
    schemaVersion: 1,
    upstream: 'https://github.com/earendil-works/pi.git',
    upstreamCommit: sha,
    forkCommit: sha,
    packageVersion: pkg.version,
    packageLockSha256: hash(join(source, 'package-lock.json')),
    modelData,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: npm run pi:adopt -- <full Pi commit SHA>');
    const sha = process.argv[2];
    // Upstream validates that hydrated model data belongs to this version.
    const npmCli = process.env.npm_execpath;
    if (process.platform === 'win32' && !npmCli) throw new Error('Run via npm run pi:adopt on Windows');
    const command = npmCli ? process.execPath : 'npm';
    const prefix = npmCli ? [npmCli] : [];
    const lock = candidateLock(sha);
    execFileSync(command, [...prefix, '--prefix', source, 'run', 'check:model-data'], { stdio: 'inherit' });
    const target = join(root, 'engine/model-data');
    // A partially copied catalog can never pass baseline verification.
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(target)) {
      if (!(name in lock.modelData)) rmSync(join(target, name));
    }
    for (const name of Object.keys(lock.modelData)) {
      copyFileSync(join(source, 'packages/ai/src/providers/data', name), join(target, name));
    }
    writeFileSync(join(root, 'engine/pi-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    execFileSync(process.execPath, [join(root, 'scripts/pi-baseline.mjs'), 'verify'], { stdio: 'inherit' });
    console.log('Baseline staged. Review the Pi diff, run compatibility tests, then git add pi engine/pi-lock.json engine/model-data.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
