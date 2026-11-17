import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPicomatchPatch, patchedAdvisoryUrl } from './patch-picomatch.mjs';

const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const patchAffectedPackages = new Set(['picomatch', 'fdir', 'tinyglobby', 'vite', 'vitest']);
const allowedDependencyPaths = {
  fdir: ['picomatch'],
  tinyglobby: ['fdir', 'picomatch'],
  vite: ['fdir', 'picomatch', 'tinyglobby'],
  vitest: ['picomatch', 'tinyglobby'],
};

export function isPatchedPicomatchAuditException(report, level = 'high') {
  const threshold = severityRank[level];
  const vulnerabilities = report?.vulnerabilities;
  if (threshold === undefined || !vulnerabilities || !Object.hasOwn(vulnerabilities, 'picomatch')) return false;
  const affected = Object.entries(vulnerabilities).filter(([, vulnerability]) =>
    (severityRank[vulnerability.severity] ?? -1) >= threshold);
  if (!affected.length || affected.some(([name]) => !patchAffectedPackages.has(name))) return false;

  const picomatch = vulnerabilities.picomatch;
  if ((severityRank[picomatch.severity] ?? -1) < threshold || !Array.isArray(picomatch.via) ||
      picomatch.via.length !== 1 || picomatch.via[0]?.url !== patchedAdvisoryUrl) return false;

  return affected.every(([name, vulnerability]) => {
    if (name === 'picomatch') return true;
    const expectedPaths = allowedDependencyPaths[name];
    return expectedPaths && Array.isArray(vulnerability.via) && vulnerability.via.length > 0 &&
      vulnerability.via.every(entry => typeof entry === 'string' && expectedPaths.includes(entry));
  });
}

export async function auditNpmDependencies({ prefix, level = 'high', omit } = {}) {
  if (!Object.hasOwn(severityRank, level)) throw new Error(`Unsupported npm audit level: ${level}`);
  const npmArgs = ['audit', '--audit-level', level, '--json'];
  if (prefix) npmArgs.push('--prefix', prefix);
  if (omit) npmArgs.push('--omit', omit);
  const npmCli = process.env.npm_execpath;
  const executable = npmCli && existsSync(npmCli)
    ? process.execPath
    : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = npmCli && existsSync(npmCli) ? [npmCli, ...npmArgs] : npmArgs;
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const stdout = result.stdout ?? '';
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    process.stdout.write(stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`npm audit did not return a JSON report${result.error ? `: ${result.error.message}` : ''}`);
  }

  if (result.status === 0) return report;
  if (result.error) throw new Error(`npm audit could not run: ${result.error.message}`);
  if (isPatchedPicomatchAuditException(report, level) &&
      await verifyPicomatchPatch(resolve(prefix ?? '.'))) {
    process.stderr.write(`Accepted ${patchedAdvisoryUrl}: the exact patched picomatch 4.0.7 source is installed; all other ${level}+ advisories still fail.\n`);
    return report;
  }
  const error = new Error(`npm audit failed with exit code ${result.status}`);
  error.auditReport = report;
  throw error;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index++) {
      const argument = process.argv[index];
      if (argument === '--prefix') options.prefix = process.argv[++index];
      else if (argument === '--audit-level') options.level = process.argv[++index];
      else if (argument === '--omit' || argument.startsWith('--omit=')) {
        options.omit = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : process.argv[++index];
      } else throw new Error(`Unknown npm audit option: ${argument}`);
    }
    const report = await auditNpmDependencies(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    if (error.auditReport) process.stdout.write(`${JSON.stringify(error.auditReport)}\n`);
    console.error(error.message);
    process.exitCode = 1;
  }
}
