import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { checkPlanningBoundary } from './planning-boundary.mjs';
import { cases, corpusVersion, dimensionRubric, repositoryFiles } from './planning-cases.mjs';
import { judgeRequest, judgeSystem, parseReview, scoreGraph, scoreRouting, staticGraphChecks } from './planning-grade.mjs';

const repo = path.resolve(import.meta.dirname, '..');
process.chdir(repo);
const { values: options } = parseArgs({ options: {
  label: { type: 'string', default: 'planning' }, case: { type: 'string', default: 'B010' },
  task: { type: 'string' }, repeats: { type: 'string', default: '1' },
  'planner-only': { type: 'boolean', default: false }, replay: { type: 'string' }, rejudge: { type: 'boolean', default: false },
} });
const repeats = Number(options.repeats);
if (!/^[\w-]+$/.test(options.label) || options.case !== 'B010' || !Number.isInteger(repeats) || repeats < 1 || repeats > 5 || (options.task && !cases.some(c => c.id === options.task))) throw Error('Use --case B010, --task P001..P006, --repeats 1..5 and a simple --label. Runtime regressions moved to npm run benchmark:runtime.');
const selected = cases.filter(c => (!options.task || c.id === options.task) && (!options['planner-only'] || c.expectedRoute === 'graph'));
if (!selected.length) throw Error('Selection contains no Planner graph task');
if (options.rejudge && !options.replay) throw Error('--rejudge requires --replay; it reuses candidate graphs and only reruns their evaluator');
const evidenceRoot = options.replay ? path.resolve(options.replay) : null;
const evidenceMetadata = evidenceRoot ? JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'metadata.json'), 'utf8')) : null;
if (evidenceMetadata && evidenceMetadata.corpusVersion !== corpusVersion) throw Error('Replay requires the same corpus version');
const runId = `${options.label}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const root = path.join(repo, 'benchmark-results', runId);
fs.mkdirSync(root, { recursive: true });
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const log = text => { console.log(text); fs.appendFileSync(path.join(root, 'benchmark.log'), text + '\n'); };
const env = { ...process.env, PATH: `${os.homedir()}/.cargo/bin:${process.env.PATH}` };
const command = (program, args, extra = {}) => spawnSync(program, args, { cwd: repo, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000, ...extra });
function git(args, cwd = repo) {
  const r = command('git', args, { cwd });
  if (r.status !== 0) throw Error(`Git failed: ${r.stderr || r.error}`);
  return r.stdout.trim();
}
const startedAt = new Date().toISOString();
const metadata = { schemaVersion: 2, benchmarkCaseId: 'B010', variant: 'planning-quality-v1', corpusVersion, benchmarkRunId: runId, startedAt, selection: selected.map(c => c.id), repeats, plannerOnly: options['planner-only'], stageTimeoutMs: 930000, gradingVersion: 'graph-quality-rubric-v4-fidelity-economy', judgeEvidenceSchema: evidenceRoot && !options.rejudge ? (evidenceMetadata.judgeEvidenceSchema ?? 1) : 2, rejudge: options.rejudge, evidenceRun: evidenceMetadata ? { path: evidenceRoot, benchmarkRunId: evidenceMetadata.benchmarkRunId, sourceSha256: evidenceMetadata.sourceSha256 } : null, gitCommit: git(['rev-parse', 'HEAD']), dirtyWorkingTree: git(['status', '--porcelain']), nodeVersion: process.version };
const results = [];
let fatal = null;

function stageMetrics(directory) {
  const metrics = { model: null, tokenUsage: null, providerRetryCount: 0, processCount: 0, toolCalls: {}, compilerRejections: 0, inspectionRejections: 0 };
  const file = path.join(directory, 'events.jsonl');
  if (!fs.existsSync(file)) return metrics;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'grapher_process_started') metrics.processCount++;
    if (e.type === 'auto_retry_start') metrics.providerRetryCount++;
    if (e.type === 'tool_execution_start') metrics.toolCalls[e.toolName] = (metrics.toolCalls[e.toolName] ?? 0) + 1;
    if (e.type === 'tool_execution_end' && (e.isError || e.result?.isError)) {
      if (['node', 'edge'].includes(e.toolName)) metrics.compilerRejections++;
      if (e.toolName === 'inspect') metrics.inspectionRejections++;
    }
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      metrics.model = e.message.model ?? metrics.model;
      if (e.message.usage) {
        metrics.tokenUsage ??= {};
        for (const [key, value] of Object.entries(e.message.usage)) if (typeof value === 'number') metrics.tokenUsage[key] = (metrics.tokenUsage[key] ?? 0) + value;
      }
    }
  }
  return metrics;
}
function stage(name, sampleDir, repository, goal, system) {
  const output = path.join(sampleDir, name);
  const input = path.join(sampleDir, `${name}-input.json`);
  if (evidenceRoot && !(name === 'judge' && options.rejudge)) {
    const original = readJson(path.join(sampleDir, 'result.json'));
    const result = original[name === 'partition' ? 'partitioner' : name]
      ?? { status: 'FAIL', error: 'Original stage did not run; replay does not call a model' };
    return { ...result, ...stageMetrics(output), replayed: true, artifacts: path.relative(repo, output) };
  }
  write(input, { output, repository, goal, stage: name, ...(system ? { system } : {}) });
  const start = Date.now();
  const r = command(path.join(repo, 'backend/target/debug/examples/benchmark'), [], { env: { ...env, BENCHMARK_PLANNING_INPUT: input }, timeout: metadata.stageTimeoutMs });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'host.log'), `${r.stdout ?? ''}${r.stderr ?? ''}`);
  const file = path.join(output, 'result.json');
  const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { status: 'FAIL', error: `Host failed: ${r.error ?? r.stderr ?? r.signal}` };
  if (r.status !== 0) { result.status = 'FAIL'; result.error ??= String(r.error ?? r.stderr); }
  return { ...result, durationMs: Date.now() - start, ...stageMetrics(output), artifacts: path.relative(repo, output) };
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function saveSummary() {
  const routed = results.filter(r => r.routeStatus !== 'NOT_RUN');
  const generated = results.filter(r => r.expectedRoute === 'graph');
  const confusion = { serial: { serial: 0, graph: 0, error: 0 }, graph: { serial: 0, graph: 0, error: 0 } };
  for (const r of routed) confusion[r.expectedRoute][['serial', 'graph'].includes(r.actualRoute) ? r.actualRoute : 'error']++;
  const quality = generated.filter(r => r.quality && r.planningBoundary?.status === 'PASS');
  const summary = { ...metadata, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), status: fatal || results.length !== selected.length * repeats || results.some(r => r.status !== 'PASS') ? 'FAIL' : 'PASS', fatalError: fatal, total: results.length,
    counts: { PASS: results.filter(r => r.status === 'PASS').length, FAIL: results.filter(r => r.status === 'FAIL').length },
    routing: { total: routed.length, correct: routed.filter(r => r.routeStatus === 'PASS').length, protocolCorrect: routed.filter(r => r.routingProtocolStatus === 'PASS').length, accuracy: routed.length ? routed.filter(r => r.routeStatus === 'PASS').length / routed.length : null, confusion },
    planner: { expected: generated.length, compiled: generated.filter(r => r.compilerStatus === 'PASS').length, staticPass: generated.filter(r => r.staticChecks?.every(c => c.pass)).length, assessed: quality.length, qualityPass: quality.filter(r => r.quality.status === 'PASS').length, averageScore: quality.length ? quality.reduce((sum, r) => sum + r.quality.score, 0) / quality.length : null, maxScore: Object.keys(dimensionRubric).length * 2, missingJudgments: generated.length - quality.length },
    nodeExecutionCount: 0, executionBoundary: 'No Runtime construction, approval, drive, node execution or worktree creation; planning processes and separate judge only.',
    limitations: ['Six authored tasks, not general routing accuracy.', 'Semantic scores are model judgments with validated quotations, not independent human gold labels.', 'Graph quality is evaluated before execution; no claim of implementation success.', 'Planner runs on gold graph tasks even if routing is wrong; route accuracy and isolated Planner quality are separate.'], results };
  write(path.join(root, 'summary.json'), summary);
  fs.writeFileSync(path.join(root, 'cases.jsonl'), results.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'report.md'), `# B010 Partitioner and Planner evaluation\n\nStatus: ${summary.status}. Routing: ${summary.routing.correct}/${summary.routing.total}. Graph quality: ${summary.planner.qualityPass}/${summary.planner.expected}; assessed ${summary.planner.assessed}, mean score ${summary.planner.averageScore ?? 'N/A'}/${summary.planner.maxScore}. Node executions: 0.\n\n| Task | Sample | Expected | Actual | Route | Protocol | Compile | Quality | Status |\n|---|---:|---|---|---|---|---|---|---|\n${results.map(r => `| ${r.taskId} | ${r.sample} | ${r.expectedRoute} | ${r.actualRoute ?? '—'} | ${r.routeStatus} | ${r.routingProtocolStatus} | ${r.compilerStatus} | ${r.quality ? `${r.quality.score}/${r.quality.maxScore} (${r.quality.status})` : '—'} | ${r.status} |`).join('\n')}\n\nGraph tasks are assessed independently even after a routing error. See each task's graph, compiler output, judge response, exact evidence and quality checks in result.json. Semantic judgment is fallible; do not treat this score as proof of execution success.\n`);
  return summary;
}

try {
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(f => /\.(rs|tsx?|mjs|json|toml|lock|md|css|html)$/.test(f) && fs.existsSync(f));
  const manifest = {};
  for (const file of [...new Set(files)].sort()) {
    const data = fs.readFileSync(file); manifest[file] = createHash('sha256').update(data).digest('hex');
    const target = path.join(root, 'sources', file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
  }
  metadata.sourceSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  write(path.join(root, 'metadata.json'), metadata); write(path.join(root, 'source-manifest.json'), manifest);
  fs.writeFileSync(path.join(root, 'source.diff'), git(['diff', 'HEAD']));
  log(`B010 planning-only benchmark ${runId}; ${selected.length} tasks × ${repeats} sample(s)`);
  if (!evidenceRoot) {
    const build = command('cargo', ['build', '--manifest-path', 'backend/Cargo.toml', '--features', 'benchmark', '--example', 'benchmark', '--bin', 'grapher']);
    fs.writeFileSync(path.join(root, 'build.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`);
    if (build.status !== 0) throw Error(`Build failed: ${build.error ?? build.stderr}`);
  }
  for (const testCase of selected) for (let sample = 1; sample <= repeats; sample++) {
    const sampleDir = path.join(root, `${testCase.id}-${sample}`);
    const repository = path.join(sampleDir, 'repository');
    if (evidenceRoot) {
      const original = path.join(evidenceRoot, `${testCase.id}-${sample}`);
      if (readJson(path.join(original, 'rubric.json')).goal !== testCase.goal) throw Error('Cannot replay evidence for a different goal');
      fs.cpSync(original, sampleDir, { recursive: true });
    } else {
      fs.mkdirSync(repository, { recursive: true });
      for (const [file, content] of Object.entries(repositoryFiles)) {
        const target = path.join(repository, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
      }
      git(['init', '-q'], repository); git(['add', '.'], repository);
      git(['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Planning fixture'], repository);
    }
    const evidenceResult = evidenceRoot ? readJson(path.join(sampleDir, 'result.json')) : null;
    const head = git(['rev-parse', 'HEAD'], repository);
    const result = { benchmarkCaseId: 'B010', taskId: testCase.id, sample, title: testCase.title, expectedRoute: testCase.expectedRoute, actualRoute: null, routeStatus: 'NOT_RUN', routingProtocolStatus: 'NOT_RUN', compilerStatus: 'NOT_APPLICABLE', status: 'FAIL', failures: [], nodeExecutionCount: 0, artifacts: path.relative(repo, sampleDir) };
    if (!options['planner-only']) {
      log(`${testCase.id}/${sample}: evaluating Partitioner`);
      result.partitioner = stage('partition', sampleDir, repository, testCase.goal);
      if (result.partitioner.status === 'PASS') {
        try { result.actualRoute = readJson(path.join(sampleDir, 'partition/route.json')).planType; } catch (error) { result.failures.push({ classification: 'PARTITIONER_ERROR', error: String(error) }); }
      }
      const routing = scoreRouting(testCase.expectedRoute, result.actualRoute, result.partitioner);
      result.routeStatus = routing.routeStatus;
      result.routingProtocolStatus = routing.protocolStatus;
      if (result.routeStatus === 'FAIL') result.failures.push({ classification: result.partitioner.status === 'FAIL' ? 'PARTITIONER_ERROR' : 'ROUTING_ERROR', error: result.partitioner.error ?? `Expected ${testCase.expectedRoute}, got ${result.actualRoute}` });
      if (result.routingProtocolStatus === 'FAIL') result.failures.push({ classification: 'PARTITIONER_PROTOCOL', error: `route_task called ${result.partitioner.toolCalls.route_task ?? 0} times; expected exactly once` });
    }
    if (testCase.expectedRoute === 'graph') {
      log(`${testCase.id}/${sample}: evaluating Planner independently (observed route: ${result.actualRoute ?? 'not run'})`);
      result.planner = stage('planner', sampleDir, repository, testCase.goal);
      const planningRepository = readJson(path.join(sampleDir, 'planner-input.json')).repository;
      result.planningBoundary = checkPlanningBoundary(path.join(sampleDir, 'planner'), planningRepository);
      if (result.planningBoundary.status !== 'PASS') result.failures.push({ classification: 'PLANNING_BOUNDARY', error: result.planningBoundary.issues.join('; ') });
      let graph, compiled;
      try {
        graph = readJson(path.join(sampleDir, 'planner/graph.json'));
        compiled = readJson(path.join(sampleDir, 'planner/compiler.json'));
        result.compilerStatus = !!compiled.plan && compiled.diagnostics.length === 0 ? 'PASS' : 'FAIL';
      } catch { result.compilerStatus = 'NOT_RUN'; }
      if (result.planner.status !== 'PASS' || result.compilerStatus !== 'PASS') result.failures.push({ classification: 'PLANNER_ERROR', error: result.planner.error ?? 'Graph failed shipping compiler', diagnostics: compiled?.diagnostics });
      else if (result.planningBoundary.status === 'PASS') {
        result.staticChecks = staticGraphChecks(testCase, graph, compiled, planningRepository);
        if (result.staticChecks.some(c => !c.pass)) result.failures.push({ classification: 'GRAPH_QUALITY', error: 'Graph failed static quality checks', checks: result.staticChecks.filter(c => !c.pass) });
        log(`${testCase.id}/${sample}: reviewing graph quality (${graph.nodes.length} nodes)`);
        result.judge = stage('judge', sampleDir, repository, judgeRequest(testCase, graph, repositoryFiles), judgeSystem);
        try {
          if (result.judge.status !== 'PASS') throw Error(result.judge.error);
          const review = parseReview(result.judge.response);
          write(path.join(sampleDir, 'judge/review.json'), review);
          result.quality = scoreGraph(testCase, graph, compiled, review, planningRepository);
          // Once the full grade exists, replace provisional static failures with one complete list.
          result.failures = result.failures.filter(f => f.classification !== 'GRAPH_QUALITY');
          if (result.quality.status !== 'PASS') result.failures.push({ classification: 'GRAPH_QUALITY', error: 'Generated graph missed rubric requirements', checks: result.quality.checks.filter(c => !c.pass) });
        } catch (error) { result.failures.push({ classification: 'JUDGE_FAILURE', error: String(error) }); }
      }
    }
    result.repositoryUnchanged = (!evidenceRoot || evidenceResult.repositoryUnchanged === true) && git(['status', '--porcelain'], repository) === '' && git(['rev-parse', 'HEAD'], repository) === head;
    result.noExecutionArtifacts = (!evidenceRoot || evidenceResult.noExecutionArtifacts === true) && ['worktrees', 'events.sqlite', '.grapher'].every(name => !fs.existsSync(path.join(sampleDir, name)) && !fs.existsSync(path.join(repository, name)));
    if (!result.repositoryUnchanged || !result.noExecutionArtifacts) result.failures.push({ classification: 'PLANNING_BOUNDARY', error: 'Planning modified the repository or created execution artifacts' });
    // Rubrics are evaluator artifacts, never inputs made available before candidate generation.
    write(path.join(sampleDir, 'rubric.json'), testCase);
    for (const failure of result.failures) if (failure.classification !== 'PLANNING_BOUNDARY' && /\b(?:429|50[0234])\b|timed out|ETIMEDOUT|Authentication|Cannot start Pi|ENOTFOUND|ECONN/i.test(failure.error)) failure.classification = 'ENVIRONMENT_FAILURE';
    result.status = result.failures.length === 0 ? 'PASS' : 'FAIL';
    write(path.join(sampleDir, 'result.json'), result); results.push(result); saveSummary();
    log(`${testCase.id}/${sample}: ${result.status}; route=${result.routeStatus}; compile=${result.compilerStatus}; quality=${result.quality?.status ?? 'NOT_SCORED'}`);
  }
} catch (error) { fatal = String(error); log(fatal); }
const summary = saveSummary();
log(`Result ${summary.status}; routing ${summary.routing.correct}/${summary.routing.total}; graph quality ${summary.planner.qualityPass}/${summary.planner.expected}; node executions 0`);
log(`Artifacts: ${path.relative(repo, root)}`);
process.exitCode = summary.status === 'PASS' ? 0 : 1;
