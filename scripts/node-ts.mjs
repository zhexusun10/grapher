#!/usr/bin/env node
// Wrapper to run Node.js with TypeScript source resolver
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// Use enhanced resolver that handles both pi packages and local directory imports
const resolverPath = join(root, 'scripts/ts-resolver-enhanced.ts');
const resolverUrl = pathToFileURL(resolverPath).href;

// Pass through all arguments to node with the resolver imported
const args = ['--import', resolverUrl, ...process.argv.slice(2)];

try {
  execFileSync(process.execPath, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
} catch (error) {
  process.exit(error.status || 1);
}
