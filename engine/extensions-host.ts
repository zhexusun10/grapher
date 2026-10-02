// One-shot local Settings transport. Discovery never executes extension factories.
import { readFileSync } from 'node:fs';
import { configureAgentDir } from './agent-dir.mjs';
import { extensionCatalog, setExtensionEnabled } from './global-extensions.ts';
import { verifyBaseline } from '../scripts/pi-baseline.mjs';

try {
  verifyBaseline();
  const directory = configureAgentDir();
  const request = JSON.parse(readFileSync(0, 'utf8'));
  if (request.version !== 1) throw new Error('Invalid extension request');
  let result;
  if (request.operation === 'catalog') result = await extensionCatalog(directory);
  else if (request.operation === 'set_enabled' && typeof request.id === 'string' && typeof request.enabled === 'boolean') {
    result = await setExtensionEnabled(directory, request.id, request.enabled);
  } else throw new Error('Invalid extension operation');
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Pi extension operation failed' }));
  process.exitCode = 1;
}
