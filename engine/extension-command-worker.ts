// A short-lived, model-free command context with normal Pi extension loading.
import { configureAgentDir } from './agent-dir.mjs';
import { executionResources } from './global-extensions.ts';
import { runPiCommandCli } from './pi-compat.ts';
import { root, verifyBaseline } from '../scripts/pi-baseline.mjs';
import { verifyPiDependencies } from '../scripts/pi-dependencies.mjs';

const directory = configureAgentDir();
verifyBaseline();
verifyPiDependencies(root);
const args = ['--mode', 'rpc', '--no-session', '--no-context-files', '--no-skills', '--offline'];
if (process.env.GRAPHER_COMMAND_PROJECT === '1') args.push('--approve');
const resources = await executionResources(args, directory, 'node');
await runPiCommandCli(resources.args, { extensionFactories: resources.extensionFactories });
