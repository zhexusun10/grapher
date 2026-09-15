// Real Pi validation in disposable repositories. No changes to application fixtures
// outside these copies; scripts and provider output remain in the recorded temp root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cases, repositoryFiles } from '../planning-cases.mjs';
const repo = path.resolve(import.meta.dirname, '../..');
const out = path.join(import.meta.dirname, process.env.V7_OUTPUT || 'v7-validation');
fs.mkdirSync(out, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grapher-v7-real-')));
const binary = path.join(root, 'grapher');
fs.copyFileSync(process.env.V7_BINARY || path.join(repo, 'backend/target/debug/grapher'), binary);
fs.chmodSync(binary, 0o755);
const catalogCase = {
  id: 'CATALOG', expectedRoute: 'graph',
  goal: 'Implement the two independent modules defined in README.md: the CSV catalog parser and the catalog search/filter module. Each needs thorough Node built-in unit tests in separate test files. Then add tests/integration.test.mjs that verifies their interoperability, and write reports/verification.md with commands, results and remaining limitations. Preserve the existing public contract and package.json, use no dependencies or network services. Verify malformed CSV, quoted commas and escaped quotes, CRLF, empty input, price validation, case-insensitive query, inclusive bounds, stable ordering and no mutation. Deliver working source files, tests and the final verification report.',
  files: { 'README.md': fs.readFileSync(path.join(import.meta.dirname, 'contract.md'), 'utf8'), 'package.json': '{"name":"catalog-acceptance","type":"module","scripts":{"test":"node --test"}}\n', 'src/csv.mjs': '// Implement parseCatalog according to README.md\n', 'src/search.mjs': '// Implement searchCatalog according to README.md\n' },
};
const model = process.env.V7_MODEL || 'dashscope/qwen3.8-flash';
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourceManifest = Object.fromEntries(['backend/resources/prompts/planner.md', 'backend/resources/prompts/partitioner.md', 'backend/src/engine.rs', 'backend/src/runtime.rs', 'backend/src/server.rs', 'engine/system-prompt.mjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
write(path.join(out, 'metadata.json'), { root, model, thinking: 'medium', sourceManifest, startedAt: new Date().toISOString(), nodeTimeoutSeconds: 900, plannerTimeoutSeconds: 300 });
function init(project, files) {
  fs.mkdirSync(project, { recursive: true });
  for (const [file, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true }); fs.writeFileSync(path.join(project, file), content); }
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Validation', '-c', 'user.email=validation@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline']]) execFileSync('git', args, { cwd: project });
}
function traceMetrics(text) {
  const events = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const tools = events.filter(e => e.type === 'tool_execution_start');
  const results = events.filter(e => e.type === 'tool_execution_end');
  const start = events.find(e => e.type === 'grapher_process_started')?.timestamp;
  const end = events.findLast(e => e.type === 'grapher_process_exited');
  const first = events.find(e => e.type === 'message_update' || e.type === 'message_end')?.grapherReceivedAt;
  const lastTool = results.at(-1)?.grapherReceivedAt;
  return { elapsedMs: end?.elapsedMs, firstAssistantObservedMs: first && start ? first - start : null,
    afterLastToolMs: lastTool && end ? end.timestamp - lastTool : null,
    // Observation intervals include provider/network/model/CLI work, not pure inference.
    toolsByName: Object.fromEntries([...new Set(tools.map(e => e.toolName))].map(name => [name, tools.filter(e => e.toolName === name).length])),
    errors: results.filter(e => e.isError || e.result?.isError).length,
    commands: tools.filter(e => e.toolName === 'bash').map(e => e.args?.command),
    toolDurationsMs: results.map(e => { const begin = tools.find(t => t.toolCallId === e.toolCallId); return { tool: e.toolName, ms: begin?.grapherReceivedAt ? e.grapherReceivedAt - begin.grapherReceivedAt : null }; }),
    usage: events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').reduce((sum, e) => { for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens']) sum[key] = (sum[key] || 0) + (e.message.usage?.[key] || 0); return sum; }, {}),
  };
}
async function sample(name, index, testCase, feedback = false) {
  const directory = path.join(root, name), project = path.join(directory, 'project'), data = path.join(directory, 'data');
  init(project, feedback ? { 'package.json': '{"type":"module"}\n', 'calculator.js': 'export function add(a, b) { return a - b; }\n' } : (testCase.files || repositoryFiles));
  const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
  const port = Number(process.env.V7_PORT_BASE || 1530) + index;
  const env = { ...process.env, GRAPHER_DATA_DIR: data, GRAPHER_PORT: String(port) };
  for (const role of ['PARTITIONER', 'PLANNER', 'NODE_AGENT', 'MERGER']) { env[`${role}_MODEL`] = model; env[`${role}_THINKING`] = 'medium'; env[`${role}_TIMEOUT_SECONDS`] = role === 'PARTITIONER' ? '60' : role === 'PLANNER' ? '300' : '900'; }
  const fd = fs.openSync(path.join(directory, 'server.log'), 'w');
  const server = spawn(binary, [], { cwd: project, env, stdio: ['ignore', fd, fd] });
  const api = async (command, body = {}) => {
    if (command === 'plan_goal') {
      const response = await fetch(`http://127.0.0.1:${port}/api/plan_goal_stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const blocks = (await response.text()).split('\n\n');
      let completed;
      for (const block of blocks) {
        const data = block.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        const value = JSON.parse(data.slice(6));
        if (block.startsWith('event: error')) throw Error(value.error);
        if (block.startsWith('event: complete')) completed = value.snapshot;
      }
      if (!completed) throw Error('Missing planning completion');
      return completed;
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detail: 'metadata', ...body }) });
    const json = await response.json(); if (json.error) throw Error(json.error); return json.result;
  };
  const result = { name, project, data, baseline, startedAt: new Date().toISOString(), status: 'RUNNING',
    validationScope: feedback ? 'real-feedback-and-independent-behavior' : testCase.id === 'P006' && !name.endsWith('-3') ? 'planning-and-publication-with-host-file-checks' : 'routing-and-compilation-only' };
  try {
    for (let i = 0; i < 100; i++) { try { await api('bootstrap'); break; } catch { await delay(100); } }
    const config = { repository: project, model, maxParallel: 2, maxFeedback: 2 };
    console.log(name, 'started');
    let snapshot;
    if (!feedback) {
      snapshot = await api('plan_goal', { goal: testCase.goal, config });
      result.route = snapshot.graph.nodes.length === 1 && snapshot.graph.nodes[0].name === 'task' ? 'serial' : 'graph';
      result.expectedRoute = testCase.expectedRoute;
      result.planning = snapshot.planning;
      write(path.join(out, name, 'graph.json'), snapshot.graph);
      for (const role of ['partition', 'planner']) {
        const file = path.join(data, 'planning', snapshot.planningId, `${role}.jsonl`);
        if (fs.existsSync(file)) result[role] = traceMetrics(fs.readFileSync(file, 'utf8'));
      }
      // Execute two independently planned audit samples without human intervention.
      if (!(testCase.id === 'P006' && !name.endsWith('-3'))) {
        result.status = result.route === result.expectedRoute ? 'PASS' : 'FAIL'; return;
      }
    } else {
      snapshot = await api('save_graph', { config, graph: {
        originalGoal: 'Controlled real feedback acceptance: verify add(a,b), correct a seeded defect after rejection, preserve the independent documentation branch.',
        nodes: [
          { name: 'calculator', task: 'This is an isolated feedback protocol fixture. On the initial attempt, leave calculator.js unchanged and write implementation.md recording the baseline function. On any retry with a correction instruction, fix calculator.js to export add(a,b) returning the numeric sum, verify it, and update implementation.md. Work only in these two files. Do not inspect Git metadata.' },
          { name: 'docs', task: 'Write independent.md describing numeric addition in one sentence. Do not change other files. This independent outcome must remain valid through calculator revisions.' },
          { name: 'review', task: 'Independently verify calculator.js exports add(a,b) with numeric addition for positive, negative and zero operands using Node assertions. Do not modify implementation source. Save the command and actual results in review.md. If behavior is wrong, describe the exact correction for calculator.js and finish with <REVISE>; otherwise finish with <ACCEPT>. A nonzero assertion run is expected evidence of a defect and must lead to a verdict, not an abandoned task.' },
        ], edges: [
          { from: 'calculator', to: 'review', feedback: false, relation: 'review tests calculator files' },
          { from: 'review', to: 'calculator', feedback: true, relation: 'calculator owns rejected behavior' },
        ],
      } });
    }
    if (snapshot.phase === 'awaiting_approval') await api('control', { action: 'approve' });
    const started = Date.now(); let last;
    while (Date.now() - started < 2400000) {
      snapshot = await api('snapshot');
      const status = `${snapshot.phase}:${snapshot.executions.map(e => `${e.node}/${e.attempt}/${e.status}`).join(',')}`;
      if (status !== last) { console.log(name, status); last = status; }
      if (['completed', 'needs_attention', 'publication_failed'].includes(snapshot.phase)) break;
      await delay(1500);
    }
    result.executionWallMs = Date.now() - started;
    write(path.join(out, name, 'snapshot.json'), snapshot);
    result.executions = [];
    for (const execution of snapshot.executions) {
      let text = '', offset = 0;
      while (true) { const page = await api('get_execution_output', { runId: snapshot.runId, executionId: execution.id, offset }); text += page.content; offset = page.nextOffset; if (page.complete) break; }
      result.executions.push({ node: execution.node, attempt: execution.attempt, status: execution.status, runtimeMs: execution.completedAt - execution.startedAt, ...traceMetrics(text) });
      fs.writeFileSync(path.join(directory, `${execution.node}-${execution.attempt}.jsonl`), text);
    }
    const changed = execFileSync('git', ['diff', '--name-only', baseline, 'HEAD'], { cwd: project, encoding: 'utf8' }).trim().split('\n');
    const clean = execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).trim() === '';
    result.acceptance = { phase: snapshot.phase, changed, clean, publication: snapshot.publication, feedback: snapshot.events.filter(e => e.type === 'feedback') };
    if (snapshot.phase !== 'completed' || !clean) throw Error('Graph did not complete and publish cleanly without intervention');
    if (feedback) {
      execFileSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {add} from './calculator.js'; assert.equal(add(2,3),5); assert.equal(add(-2,3),1); assert.equal(add(0,0),0);"], { cwd: project });
      if (!result.acceptance.feedback.some(e => !e.accepted) || !result.acceptance.feedback.some(e => e.accepted)) throw Error('Missing real REVISE/ACCEPT');
      if (snapshot.executions.filter(e => e.node === 'docs').length !== 1 || new Set(snapshot.executions.map(e => e.sessionId)).size !== snapshot.executions.length) throw Error('Feedback isolation/session failure');
    } else {
      if (!changed.every(file => file.startsWith('reports/'))) throw Error('Audit changed application source');
      for (const file of ['auth', 'storage', 'release']) if (fs.statSync(path.join(project, 'reports', `${file}.md`)).size < 100) throw Error('Missing report');
      fs.cpSync(path.join(project, 'reports'), path.join(out, name, 'reports'), { recursive: true });
    }
    result.status = 'PASS';
  } catch (error) { result.status = 'FAIL'; result.error = String(error); console.error(name, String(error)); }
  finally {
    result.endedAt = new Date().toISOString(); write(path.join(out, name, 'result.json'), result);
    server.kill('SIGINT'); fs.closeSync(fd); console.log(name, result.status);
  }
}
// Each family runs repeats sequentially so samples do not compete with their own
// replicas; families run concurrently. Record this load instead of claiming A/B.
await Promise.all([
  ...(process.env.V7_CASES || 'P004,P005,P006').split(',').filter(Boolean).map((id, index) => (async () => {
    for (let n = 1; n <= Number(process.env.V7_REPEATS || 3); n++) await sample(`${process.env.V7_PREFIX || ''}${id}-${n}`, index, cases.find(c => c.id === id) || (id === 'CATALOG' ? catalogCase : null));
  })()),
  ...(process.env.V7_NO_FEEDBACK ? [] : [sample('feedback', 3, null, true)]),
]);
console.log('Real validation finished:', out);
