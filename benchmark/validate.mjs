import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '..');
process.chdir(repo);
const outputRoot = path.join(repo, 'benchmark-results');
fs.mkdirSync(outputRoot, { recursive: true });
const startedAt = new Date().toISOString();
const suites = [];
let failure = null;
try {
  for (const [label, options] of [
    ['repeat-1', ['--deterministic']],
    ['repeat-2', ['--deterministic']],
    ['repeat-3', ['--deterministic']],
    ['final', ['--agent-repeats', '3', '--planning']],
  ]) {
    const previous = new Set(fs.readdirSync(outputRoot));
    const result = spawnSync(process.execPath, ['benchmark/run.mjs', '--label', label, ...options], { cwd: repo, stdio: 'inherit', timeout: 900000 });
    const created = fs.readdirSync(outputRoot).filter(name => !previous.has(name) && name.startsWith(label + '-'));
    if (created.length !== 1) throw Error(`Expected one artifact directory for ${label}`);
    const summaryPath = path.join(outputRoot, created[0], 'summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath));
    suites.push({ label, summaryPath: path.relative(repo, summaryPath), summary });
    if (result.status !== 0 || result.error) throw Error(`${label} failed; inspect ${summaryPath}`);
  }
  const signature = summary => JSON.stringify(summary.results.filter(r => r.layer === 'deterministic').map(r => [r.benchmarkCaseId, r.status, r.nodeExecutionCount, r.retryCount, r.processFailures]));
  if (!suites.every(s => signature(s.summary) === signature(suites[0].summary))) throw Error('Deterministic results/metrics differ');
  if (!suites.every(s => s.summary.sourceSha256 === suites[0].summary.sourceSha256)) throw Error('Sources changed during repeated validation');
} catch (error) { failure = String(error); }
const report = { schemaVersion: 1, startedAt, endedAt: new Date().toISOString(), status: failure ? 'FAIL' : 'PASS', error: failure, consecutiveDeterministicRuns: suites.filter(s => s.label.startsWith('repeat-') && s.summary.deterministic.passRate === 1).length, nativeUiAutomation: 'GAP', suites: suites.map(({ label, summaryPath, summary }) => ({ label, summaryPath, benchmarkRunId: summary.benchmarkRunId, counts: summary.counts, durationMs: summary.durationMs, sourceSha256: summary.sourceSha256 })) };
const file = path.join(outputRoot, `acceptance-${startedAt.replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log(`Validation ${report.status}: ${path.relative(repo, file)}`);
process.exitCode = failure ? 1 : 0;
