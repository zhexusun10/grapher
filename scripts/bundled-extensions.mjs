// These packages are installed at the Grapher root, not by pi:setup.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const bundledExtensions = [
  { name: 'pi-trim', entry: 'extensions/index.ts' },
  { name: 'pi-continuity', entry: 'extensions/index.ts' },
  { name: 'pi-better-web-search', entry: 'extensions/index.ts' },
];
export const bundledExtensionNames = bundledExtensions.map(extension => extension.name);

export function missingBundledExtensions(root) {
  const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return bundledExtensions.filter(({ name, entry }) => {
    const directory = join(root, 'node_modules', name);
    try {
      const installed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      return installed.name !== name || installed.version !== project.dependencies[name] ||
        !existsSync(join(directory, entry));
    } catch {
      return true;
    }
  }).map(({ name }) => name);
}

export function verifyBundledExtensions(root) {
  const missing = missingBundledExtensions(root);
  if (missing.length) {
    throw new Error(`Bundled Pi extensions are missing or outdated (${missing.join(', ')}); run npm ci --ignore-scripts in ${root}, then restart Grapher`);
  }
}
