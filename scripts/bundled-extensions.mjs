// These packages are installed at the Grapher root, not by pi:setup.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const bundledExtensionNames = ['pi-trim', 'pi-continuity'];

export function missingBundledExtensions(root) {
  const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return bundledExtensionNames.filter(name => {
    const directory = join(root, 'node_modules', name);
    try {
      const installed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      return installed.name !== name || installed.version !== project.dependencies[name] ||
        !existsSync(join(directory, 'extensions/index.ts'));
    } catch {
      return true;
    }
  });
}

export function verifyBundledExtensions(root) {
  const missing = missingBundledExtensions(root);
  if (missing.length) {
    throw new Error(`Bundled Pi extensions are missing or outdated (${missing.join(', ')}); run npm ci --ignore-scripts in ${root}, then restart Grapher`);
  }
}
