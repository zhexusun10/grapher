// A successful offline build belongs to the reviewed inputs plus the local
// model-data overlay, not just a dist folder.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { corePackages } from './pi-dependencies.mjs';

const marker = root => join(root, 'pi/node_modules/.grapher-pi-build.json');
export const piBuildArtifacts = [
  ...corePackages.map(name => `packages/${name}/dist/index.js`),
  'packages/coding-agent/dist/cli.js',
  'packages/coding-agent/dist/rpc-entry.js',
  'packages/coding-agent/dist/bundle/cli.js',
];

export function modelDataOverlay(root) {
  const directory = join(root, 'engine/model-data-local');
  try {
    return Object.fromEntries(readdirSync(directory)
      .filter(name => name.endsWith('.json'))
      .map(name => [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')]));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export function piBuildFingerprint(root) {
  const hash = createHash('sha256');
  for (const path of ['engine/pi-lock.json', 'engine/pi-dependencies/package.json', 'engine/pi-dependencies/package-lock.json']) {
    hash.update(readFileSync(join(root, path)));
  }
  for (const [name, digest] of Object.entries(modelDataOverlay(root)).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${name}\0${digest}\0`);
  }
  return { schemaVersion: 1, inputs: hash.digest('hex'), platform: process.platform, arch: process.arch };
}

export function recordPiBuild(root) {
  writeFileSync(marker(root), `${JSON.stringify(piBuildFingerprint(root))}\n`);
}

export function piBuildReady(root) {
  try {
    if (JSON.stringify(JSON.parse(readFileSync(marker(root), 'utf8'))) !== JSON.stringify(piBuildFingerprint(root))) return false;
    if (!piBuildArtifacts.every(path => existsSync(join(root, 'pi', path)))) return false;
    const { modelData } = JSON.parse(readFileSync(join(root, 'engine/pi-lock.json'), 'utf8'));
    const overlay = modelDataOverlay(root);
    const expected = { ...modelData, ...overlay };
    const readData = directory => {
      const dataDir = join(root, 'pi/packages/ai', directory, 'providers/data');
      const names = readdirSync(dataDir).filter(name => name.endsWith('.json')).sort();
      return {
        names,
        hashes: Object.fromEntries(names.map(name =>
          [name, createHash('sha256').update(readFileSync(join(dataDir, name))).digest('hex')])),
      };
    };
    const src = readData('src');
    const dist = readData('dist');
    // With a local overlay the manifest is regenerated locally, so it is only
    // required to be identical between src and dist; the build's upstream
    // check-model-data step validated it.
    const hasOverlay = Object.keys(overlay).length > 0;
    const compared = (hasOverlay
      ? Object.keys(expected).filter(name => name !== '.manifest.json')
      : Object.keys(expected)).sort();
    if (hasOverlay && src.hashes['.manifest.json'] !== dist.hashes['.manifest.json']) return false;
    const present = names => JSON.stringify(hasOverlay ? names.filter(name => name !== '.manifest.json') : names);
    if (present(src.names) !== JSON.stringify(compared) || present(dist.names) !== JSON.stringify(compared)) return false;
    for (const name of compared) {
      if (src.hashes[name] !== expected[name] || dist.hashes[name] !== expected[name]) return false;
    }
    return true;
  } catch {
    return false;
  }
}
