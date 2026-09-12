import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = path.resolve(import.meta.dirname, '..');
process.chdir(repo);
const args = process.argv.slice(2);
const opt = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const label = opt('--label', 'run');
const selected = opt('--case', null);
const deterministic = args.includes('--deterministic');
const planning = args.includes('--planning');
const repeats = Number(opt('--agent-repeats', '1'));
const names = ['Minimal fixture execution', 'Dependency chain', 'Actual parallel fan-out', 'Fan-in composition', 'Compiler rejects dependency cycle', 'Pi process failure propagation', 'REVISE then ACCEPT', 'Frontend contract and intervention', 'Feedback limit and independent branch', 'Real Pi file task'];
const ids = names.map((_, i) => `B${String(i + 1).padStart(3, '0')}`);
const runId = `${/^[a-zA-Z0-9_-]+$/.test(label) ? label : 'invalid'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const root = path.join(repo, 'benchmark-results', runId);
fs.mkdirSync(root, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n');
const append = (name, value) => fs.appendFileSync(path.join(root, name), JSON.stringify(value) + '\n');
const log = s => { console.log(s); fs.appendFileSync(path.join(root, 'benchmark.log'), s + '\n'); };
const env = { ...process.env, PATH: `${os.homedir()}/.cargo/bin:${process.env.PATH}` };
const command = (cmd, argv, timeout = 240000, extra = {}) => spawnSync(cmd, argv, { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
const git = argv => command('git', argv).stdout?.trim() ?? '';
const startedAt = new Date().toISOString();
const metadata = { toolchain: {node:process.version, platform:process.platform, arch:process.arch, cargo:command('cargo',['--version']).stdout?.trim(), git:git(['--version']), piCommit:git(['-C','pi','rev-parse','HEAD'])}, schemaVersion: 1, benchmarkRunId: runId, label, selection: selected, deterministicOnly: deterministic, agentVariant: planning ? 'planned' : 'graph-ir', gitCommit: git(['rev-parse', 'HEAD']), dirtyWorkingTree: git(['status', '--porcelain']), startedAt };
const results = [];
fs.writeFileSync(path.join(root, 'cases.jsonl'), '');
fs.writeFileSync(path.join(root, 'events.jsonl'), '');

function saveSummary() {
  const counts = Object.fromEntries(['PASS', 'FAIL', 'NOT_IMPLEMENTED', 'NOT_APPLICABLE'].map(s => [s, results.filter(r => r.status === s).length]));
  const layer = l => {
    const r = results.filter(r => r.layer === l);
    const durations = r.map(v => v.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
    return { total: r.length, pass: r.filter(r => r.status === 'PASS').length, fail: r.filter(r => r.status === 'FAIL').length, passRate: r.length ? r.filter(r => r.status === 'PASS').length / r.length : null, durationMs: { min: durations[0] ?? null, median: durations.length ? durations[Math.floor(durations.length / 2)] : null, max: durations.at(-1) ?? null } };
  };
  const sum = key => results.reduce((s, r) => s + (r[key] ?? 0), 0);
  write('summary.json', { ...metadata, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), totalCases: results.length, counts, deterministic: layer('deterministic'), agentDependent: layer('agent-dependent'), nodeExecutionCount: sum('nodeExecutionCount'), retryCount: sum('retryCount'), providerRetryCount: sum('providerRetryCount'), processFailures: sum('processFailures'), piExecutionCount: sum('piExecutionCount'), plannerInvocationCount: sum('plannerInvocationCount'), partitionerInvocationCount: sum('partitionerInvocationCount'), invariantViolations: results.filter(r => r.classification === 'IMPLEMENTATION_BUG').length, harnessFailures: results.filter(r => r.benchmarkCaseId === 'HARNESS').length, uiAutomation: 'GAP: native WebView clicks/effects not automated; real IPC, frontend action/type/render contract covered', notImplemented: ['Multi-engine execution', 'Remote execution', 'Automatic conflict resolution', 'Automatic worktree cleanup/result integration', 'Interactive terminal', 'Drag-edge authoring', 'Durable multi-project runtime', 'Semantic goal-contribution analysis'], results });
}

function snapshotsIn(caseDir) {
  const snapshots = [];
  if (fs.existsSync(path.join(caseDir, 'snapshot.json'))) snapshots.push(JSON.parse(fs.readFileSync(path.join(caseDir, 'snapshot.json'))));
  const recovery = path.join(caseDir, 'recovery/snapshot.json');
  if (fs.existsSync(recovery)) snapshots.push(JSON.parse(fs.readFileSync(recovery)));
  const history = path.join(caseDir, 'frontend-live/histories.json');
  if (fs.existsSync(history)) snapshots.push(...JSON.parse(fs.readFileSync(history)));
  return snapshots;
}
function metrics(value, caseDir) {
  const snapshots = snapshotsIn(caseDir);
  Object.assign(value, { grapherRunIds: snapshots.map(s => s.runId).filter(Boolean), nodeExecutionCount: 0, retryCount: 0, providerRetryCount: 0, processFailures: 0, piExecutionCount: 0, model: null, tokenUsage: null, plannerInvocationCount: 0, partitionerInvocationCount: 0 });
  function stream(text) {
    for (const line of text.split('\n')) {
      let p; try { p = JSON.parse(line); } catch { continue; } // Plain-text output is valid, not a failed assertion.
      if (p.type === 'grapher_process_started') value.piExecutionCount++;
      if (p.type === 'grapher_process_exited' && !p.success) value.processFailures++;
      if (p.type === 'auto_retry_start') value.providerRetryCount++;
      if (p.type === 'message_end' && p.message?.role === 'assistant') {
        value.model = p.message.model ?? value.model;
        if (p.message.usage) {
          value.tokenUsage ??= {};
          for (const [key, amount] of Object.entries(p.message.usage)) if (typeof amount === 'number') value.tokenUsage[key] = (value.tokenUsage[key] ?? 0) + amount;
        }
      }
    }
  }
  for (const s of snapshots) {
    value.nodeExecutionCount += s.executions.length;
    value.retryCount += s.executions.filter(e => e.attempt > 1).length;
    for (const event of s.events) {
      append('events.jsonl', { schemaVersion: 1, benchmarkRunId: runId, benchmarkCaseId: value.benchmarkCaseId, sample: value.sample, grapherRunId: s.runId, source: 'product-event-store', event });
      if (event.type === 'output') stream(event.text);
    }
  }
  const planningRoot = path.join(caseDir, 'planning');
  if (fs.existsSync(planningRoot)) for (const planningId of fs.readdirSync(planningRoot)) {
    for (const [file, metric] of [['partition.jsonl', 'partitionerInvocationCount'], ['planner.jsonl', 'plannerInvocationCount']]) {
      const filePath = path.join(planningRoot, planningId, file);
      if (!fs.existsSync(filePath)) continue;
      value[metric]++;
      const text = fs.readFileSync(filePath, 'utf8'); stream(text);
      append('events.jsonl', { schemaVersion: 1, benchmarkRunId: runId, benchmarkCaseId: value.benchmarkCaseId, sample: value.sample, source: 'product-planning-log', planningId, file, text });
    }
  }
}

try {
  if (!/^[a-zA-Z0-9_-]+$/.test(label) || (selected && !ids.includes(selected)) || !Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw Error('Invalid label, case or agent-repeats (1–10)');
  // Hash and retain all text sources, including untracked harness files. Never include .env or Pi credentials.
  const sources = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n'))].filter(f => /\.(rs|tsx?|mjs|json|toml|lock|md|css|html)$/.test(f) && fs.existsSync(f));
  const manifest = {};
  for (const file of sources) {
    const data = fs.readFileSync(file); manifest[file] = createHash('sha256').update(data).digest('hex');
    const dest = path.join(root, 'sources', file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data);
  }
  metadata.sourceSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  write('source-manifest.json', manifest); write('metadata.json', metadata);
  fs.writeFileSync(path.join(root, 'source.diff'), git(['diff', 'HEAD']));
  log(`Benchmark ${runId}; building actual desktop command host`);
  const build = command('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'benchmark', '--example', 'benchmark', '--bin', 'grapher']);
  fs.writeFileSync(path.join(root, 'build.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`);
  if (build.status !== 0) throw Error(`Build failed: ${build.error ?? build.stderr}`);
  for (const id of ids.filter(id => (!selected || id === selected) && (!deterministic || id !== 'B010'))) {
    for (let sample = 1; sample <= (id === 'B010' ? repeats : 1); sample++) {
      const caseDir = path.join(root, `${id}-${sample}`); fs.mkdirSync(caseDir);
      const t = Date.now();
      const r = command(path.join(repo, 'src-tauri/target/debug/examples/benchmark'), [], 210000, { BENCHMARK_CASE: id, BENCHMARK_CASE_DIR: caseDir, ...(planning && id === 'B010' ? { BENCHMARK_PLAN: '1' } : {}) });
      fs.writeFileSync(path.join(caseDir, 'host.log'), `${r.stdout ?? ''}${r.stderr ?? ''}`);
      let value = fs.existsSync(path.join(caseDir, 'result.json')) ? JSON.parse(fs.readFileSync(path.join(caseDir, 'result.json'))) : { status: 'FAIL', error: `Host failed: status=${r.status}, signal=${r.signal}, ${r.error ?? r.stderr}` };
      value = { ...value, schemaVersion: 1, benchmarkRunId: runId, benchmarkCaseId: id, name: names[ids.indexOf(id)], sample, variant: id === 'B010' ? metadata.agentVariant : 'canonical', layer: id === 'B010' ? 'agent-dependent' : 'deterministic', artifacts: path.relative(repo, caseDir), runtimeDurationMs: value.durationMs, classification: null, gitCommit: metadata.gitCommit, sourceSha256: metadata.sourceSha256 };
      if (value.status === 'FAIL') value.classification = id === 'B010' ? (/timed out|Authentication|Cannot start Pi|Host failed/i.test(value.error) ? 'ENVIRONMENT_FAILURE' : 'AGENT_FAILURE') : 'IMPLEMENTATION_BUG';
      if (r.error || r.signal || r.status !== 0) { value.status = 'FAIL'; value.classification = 'ENVIRONMENT_FAILURE'; }
      if (id === 'B008' && value.status === 'PASS') {
        const actions = command(process.execPath, ['benchmark/frontend-actions.mjs', caseDir], 30000);
        fs.writeFileSync(path.join(caseDir, 'frontend-actions.log'), `${actions.stdout ?? ''}${actions.stderr ?? ''}`);
        const contract = command(process.execPath, ['benchmark/frontend.mjs', caseDir]);
        fs.writeFileSync(path.join(caseDir, 'frontend.log'), `${contract.stdout ?? ''}${contract.stderr ?? ''}`);
        if (contract.status !== 0 || actions.status !== 0) { value.status = 'FAIL'; value.classification = 'IMPLEMENTATION_BUG'; value.error = 'Frontend contract failed; see frontend-actions.log and frontend.log'; }
      }
      metrics(value, caseDir);
      value.startedAt = new Date(t).toISOString(); value.endedAt = new Date().toISOString(); value.durationMs = Date.now() - t;
      value.runtimeInvariants = snapshotsIn(caseDir).every(s => s.executions.every(e => e.completedAt != null) && !Object.values(s.nodes).some(n => n.status === 'running')) ? 'PASS' : 'FAIL';
      results.push(value); append('cases.jsonl', value); saveSummary();
      log(`${id} sample ${sample}: ${value.status} (${value.durationMs}ms)${value.error ? ` — ${value.error}` : ''}`);
    }
  }
} catch (error) {
  results.push({ schemaVersion: 1, benchmarkRunId: runId, benchmarkCaseId: 'HARNESS', status: 'FAIL', classification: 'ENVIRONMENT_FAILURE', layer: 'deterministic', error: String(error) });
  append('cases.jsonl', results.at(-1)); log(String(error));
} finally { saveSummary(); log(`Artifacts: ${path.relative(repo, root)}`); }
process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
