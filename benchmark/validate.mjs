import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// A fixed number of complete planning-corpus samples, never retry-until-green.
// Runtime regressions are independently available through benchmark:runtime.
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('./run.mjs', import.meta.url)),
  '--label', 'planning-validation', '--repeats', '3', ...process.argv.slice(2),
], { stdio: 'inherit' });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
