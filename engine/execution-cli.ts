// Install Grapher's process-local policy before upstream constructs a session.
import { configureExecutionRetries } from './retry-policy.ts';
import { runPiCli } from './pi-compat.ts';
import { executionResources } from './global-extensions.ts';

configureExecutionRetries();
let args = process.argv.slice(2);
if (args[0] === '--grapher-prewarm') {
  if (args.length !== 2) throw new Error('Invalid prepared-host arguments');
  const { bindPreparedHost } = await import('./prepared-host.ts');
  const binding = await bindPreparedHost(args[1]);
  if (binding === null) process.exit(0);
  args = binding;
}
const standalone = args.some(arg => ['--version', '-v', '--help', '-h'].includes(arg)) ||
  ['install', 'remove', 'update', 'list', 'config', 'mcp', 'auth'].includes(args[0]);
const resources = standalone ? { args } : await executionResources(args, process.env.PI_CODING_AGENT_DIR!, process.env.GRAPHER_MODE || 'node');
await runPiCli(resources.args, { extensionFactories: 'extensionFactories' in resources ? resources.extensionFactories : [] });
