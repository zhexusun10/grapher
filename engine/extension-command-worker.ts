// A short-lived, model-free command context with normal Pi extension loading.
import { configureAgentDir } from './agent-dir.mjs';
import { root, verifyRuntimeBaseline } from '../scripts/pi-baseline.mjs';

const directory = configureAgentDir();
verifyRuntimeBaseline({ installationRoot: root });
const [{ executionResources }, { runPiCommandCli }] = await Promise.all([
  import('./global-extensions.ts'),
  import('./pi-compat.ts'),
]);
const args = ['--mode', 'rpc', '--no-session', '--no-context-files', '--no-skills', '--offline'];
if (process.env.GRAPHER_COMMAND_PROJECT === '1') args.push('--approve');
const resources = await executionResources(args, directory, 'node');
await runPiCommandCli(resources.args, { extensionFactories: resources.extensionFactories });
