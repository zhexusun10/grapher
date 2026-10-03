// Grapher's source-runtime dependency profile. Keep the upstream Git tree and
// lockfile intact; install only core dependencies plus reviewed build/test tools.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const corePackages = ['chord', 'tui', 'telemetry', 'codemode', 'mcp', 'ai', 'durable', 'agent', 'protocol', 'client', 'server', 'coding-agent'];
const excludedPackages = new Set(['shx', 'shelljs', 'fast-glob', 'micromatch', 'braces', 'node-forge', '@earendil-works/gondolin']);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export const profileDirectory = root => join(root, 'engine/pi-dependencies');

export function dependencyManifest(root) {
  const source = join(root, 'pi');
  const upstream = json(join(source, 'package.json'));
  const packages = corePackages.map(directory => json(join(source, 'packages', directory, 'package.json')));
  const version = packages.at(-1).version;
  const internal = new Set(packages.map(pkg => pkg.name));
  const dependencies = {};
  const add = (name, spec) => {
    if (internal.has(name)) {
      if (spec !== version && spec !== `^${version}`) throw new Error(`Review Pi internal dependency ${name}@${spec}`);
      return;
    }
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(spec)) throw new Error(`Pi profile requires an exact dependency: ${name}@${spec}`);
    if (dependencies[name] && dependencies[name] !== spec) throw new Error(`Conflicting Pi dependency versions: ${name}`);
    if (excludedPackages.has(name)) throw new Error(`Excluded Pi dependency: ${name}`);
    dependencies[name] = spec;
  };
  for (const pkg of packages) {
    if (pkg.version !== version) throw new Error(`Pi workspace version mismatch: ${pkg.name}`);
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) add(name, spec);
    for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
      if (name.startsWith('@types/') || name === 'vitest' || name === '@xterm/headless') add(name, spec);
    }
  }
  add('typescript', upstream.devDependencies.typescript);
  add('@types/node', upstream.devDependencies['@types/node']);
  return {
    name: 'grapher-pi-dependencies', version, private: true, type: 'module',
    description: 'Pinned dependencies for the unmodified Pi source runtime; no example workspaces or shelljs build chain.',
    engines: upstream.engines,
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
    overrides: upstream.overrides,
  };
}

export function dependencyProfileHashes(root) {
  const profile = profileDirectory(root);
  return { packageJsonSha256: hash(join(profile, 'package.json')), packageLockSha256: hash(join(profile, 'package-lock.json')) };
}

export function verifyDependencyProfile(root) {
  const profile = profileDirectory(root);
  const manifest = json(join(profile, 'package.json'));
  if (JSON.stringify(manifest) !== JSON.stringify(dependencyManifest(root))) throw new Error('Pi dependency profile differs from the reviewed upstream dependencies; regenerate and review it');
  const lock = json(join(profile, 'package-lock.json'));
  if (lock.lockfileVersion !== 3 || lock.name !== manifest.name || lock.version !== manifest.version ||
      JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(manifest.dependencies)) {
    throw new Error('Pi dependency profile lock does not match its manifest');
  }
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (lock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`Pi profile direct dependency mismatch: ${name}`);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!path.startsWith('node_modules/') || path.split('/').includes('..') || entry.link || excludedPackages.has(name)) {
      throw new Error(`Unexpected or excluded Pi dependency: ${path}`);
    }
    if (!entry.resolved?.startsWith('https://registry.npmjs.org/') || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '')) {
      throw new Error(`Pi dependency lacks registry integrity: ${path}`);
    }
  }
  return { manifest, lock };
}

export function verifyPiDependencies(root) {
  const { manifest, lock } = verifyDependencyProfile(root);
  const source = join(root, 'pi');
  const modules = join(source, 'node_modules');
  const markerPath = join(modules, '.grapher-pi-dependencies.json');
  if (!existsSync(markerPath) || JSON.stringify(json(markerPath)) !== JSON.stringify(dependencyProfileHashes(root))) {
    throw new Error('Pi dependencies are missing or use an unreviewed install; run npm run pi:setup');
  }
  const internal = new Map(corePackages.map(directory => {
    const pkg = json(join(source, 'packages', directory, 'package.json'));
    return [`node_modules/${pkg.name}`, directory];
  }));
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    const metadata = join(source, path, 'package.json');
    if (!existsSync(metadata) && entry.optional) continue; // Non-host platform binaries.
    if (!existsSync(metadata) || json(metadata).version !== entry.version) throw new Error(`Installed Pi dependency mismatch: ${path}; run npm run pi:setup`);
  }
  // Reject extraneous packages too: an old monorepo install must not leave the
  // vulnerable example/build graph in an otherwise valid runtime copy.
  const inspect = directory => {
    if (!existsSync(directory)) return;
    const paths = readdirSync(directory).filter(name => !name.startsWith('.')).flatMap(name => {
      const path = join(directory, name);
      return name.startsWith('@') ? readdirSync(path).map(child => join(path, child)) : [path];
    });
    for (const path of paths) {
      const key = relative(source, path).replaceAll('\\', '/');
      const metadata = join(path, 'package.json');
      if (internal.has(key)) {
        if (hash(metadata) !== hash(join(source, 'packages', internal.get(key), 'package.json'))) throw new Error(`Pi workspace binding mismatch: ${key}`);
      } else if (!lock.packages[key]) {
        throw new Error(`Extraneous Pi dependency: ${key}; run npm run pi:setup`);
      }
      inspect(join(path, 'node_modules'));
    }
  };
  inspect(modules);
  for (const name of internal.keys()) {
    if (!existsSync(join(source, name, 'package.json'))) throw new Error(`Missing Pi workspace binding: ${name}`);
  }
  return manifest.version;
}

export function installPiDependencies(root, runNpm) {
  verifyDependencyProfile(root);
  const profile = profileDirectory(root);
  runNpm(profile, 'ci', '--ignore-scripts');
  // Audit the actual profile (including build/test tools), not an omit=dev or
  // advisory allowlist view. Fail before replacing the existing installation.
  runNpm(profile, 'audit', '--audit-level=moderate');
  const source = join(root, 'pi');
  const modules = join(source, 'node_modules');
  rmSync(modules, { recursive: true, force: true });
  cpSync(join(profile, 'node_modules'), modules, {
    recursive: true, dereference: process.platform === 'win32',
    verbatimSymlinks: process.platform !== 'win32',
    filter: process.platform === 'win32' ? () => true : undefined,
  });
  for (const directory of corePackages) {
    const workspace = join(source, 'packages', directory);
    rmSync(join(workspace, 'node_modules'), { recursive: true, force: true });
    const target = join(modules, json(join(workspace, 'package.json')).name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(process.platform === 'win32' ? workspace : relative(dirname(target), workspace), target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  writeFileSync(join(modules, '.grapher-pi-dependencies.json'), `${JSON.stringify(dependencyProfileHashes(root))}\n`);
  verifyPiDependencies(root);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (process.argv[2] !== 'generate') throw new Error('Usage: node scripts/pi-dependencies.mjs generate');
  const profile = profileDirectory(root);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify(dependencyManifest(root), null, 2)}\n`);
  console.log('Review engine/pi-dependencies/package.json, then generate its lock with npm install --package-lock-only --ignore-scripts --prefix engine/pi-dependencies.');
}
