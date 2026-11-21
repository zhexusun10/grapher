// Install Grapher's process-local policy before upstream constructs a session.
import { configureExecutionRetries } from './retry-policy.ts';
import { runPiCli, preparePiCli } from './pi-compat.ts';
import { flushRuntimeCompileCache } from '../scripts/pi-baseline.mjs';
import { executionResources } from './global-extensions.ts';
import { applyLaunchBinding, managedLaunch, managedBusinessEnvironment } from './launch-binding.mjs';
import { execFileSync, spawn } from 'node:child_process';

configureExecutionRetries();
process.env.PYTHONDONTWRITEBYTECODE = '1';
let args = process.argv.slice(2);
// Host-only cache priming after the shared runtime has been verified. Import
// ordinary CLI code without resources, factories, sessions or model requests.
if (args.length === 1 && args[0] === '--grapher-prepare-runtime-cache') {
  await preparePiCli();
  flushRuntimeCompileCache();
  process.exit(0);
}
if (args[0] === '--grapher-prewarm') {
  if (args.length !== 2) throw new Error('Invalid prepared-host arguments');
  const { bindPreparedHost } = await import('./prepared-host.ts');
  const binding = await bindPreparedHost(args[1]);
  if (binding === null) process.exit(0);
  args = binding;
}
if (args[0] === '--grapher-run-result') {
  applyLaunchBinding();
  const launch = managedLaunch();
  if (!launch) throw new Error('Result execution requires a Runtime launch binding');
  const child = spawn(launch.entry, args.slice(1), { cwd: process.cwd(), env: managedBusinessEnvironment(), stdio: 'inherit', windowsHide: true });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      if (process.platform === 'win32' && child.pid) {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else {
        child.kill(signal);
      }
    });
  }
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : signal ? 143 : 1)));
  });
  process.exit(code);
}
const standalone = args.some(arg => ['--version', '-v', '--help', '-h'].includes(arg)) ||
  ['install', 'remove', 'update', 'list', 'config', 'mcp', 'auth'].includes(args[0]);
if (!standalone) applyLaunchBinding();
const resources = standalone ? { args } : await executionResources(args, process.env.PI_CODING_AGENT_DIR!, process.env.GRAPHER_MODE || 'node');
await runPiCli(resources.args, { extensionFactories: 'extensionFactories' in resources ? resources.extensionFactories : [] });
