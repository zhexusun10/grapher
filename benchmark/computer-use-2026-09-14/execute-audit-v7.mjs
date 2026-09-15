// Execute an independently planned audit graph already saved by validate-v7.
// Preserve its original task definitions; no intervention or source patching.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
const repo = path.resolve(import.meta.dirname, '../..');
const parent = path.join(import.meta.dirname, 'v7-validation');
const metadata = JSON.parse(fs.readFileSync(path.join(parent, 'metadata.json')));
const directory = path.join(metadata.root, 'P006-3'), project = path.join(directory, 'project'), data = path.join(directory, 'data');
const out = path.join(parent, 'audit-second-execution'); fs.mkdirSync(out, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
const binary = path.join(directory, 'execution-host');
fs.copyFileSync(path.join(repo, 'backend/target/release/grapher'), binary); fs.chmodSync(binary, 0o755);
const model = 'dashscope/qwen3.8-flash';
const fd = fs.openSync(path.join(directory, 'execution-server.log'), 'w');
const server = spawn(binary, [], { cwd: project, env: { ...process.env, GRAPHER_PORT: '1553', GRAPHER_DATA_DIR: data, NODE_AGENT_MODEL: model, NODE_AGENT_THINKING: 'medium', NODE_AGENT_TIMEOUT_SECONDS: '900', MERGER_MODEL: model, MERGER_THINKING: 'medium' }, stdio: ['ignore', fd, fd] });
const api = async (command, body = {}) => {
  const response = await fetch('http://127.0.0.1:1553/api/' + command, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ detail: 'metadata', ...body }) });
  const value = await response.json(); if (value.error) throw Error(value.error); return value.result;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
const result = { startedAt: new Date().toISOString(), model, thinking: 'medium', nodeTimeoutSeconds: 900,
  planningSample: '../P006-3', project, data, baseline: git('rev-parse', 'HEAD'), status: 'RUNNING',
  sourceManifest: Object.fromEntries(['backend/src/engine.rs', 'backend/src/runtime.rs', 'backend/src/server.rs', 'engine/system-prompt.mjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')])) };
write('result.json', result);
try {
  for (let i = 0; i < 100; i++) { try { await api('snapshot'); break; } catch { await delay(100); } }
  let snapshot = await api('snapshot');
  if (snapshot.phase !== 'awaiting_approval' || snapshot.executions.length) throw Error('Expected a fresh unexecuted graph');
  write('graph.json', snapshot.graph);
  await api('control', { action: 'approve' });
  const start = Date.now(); let last;
  while (Date.now() - start < 2400000) {
    snapshot = await api('snapshot');
    const status = `${snapshot.phase}:${snapshot.executions.map(e => `${e.node}/${e.attempt}/${e.status}`).join(',')}`;
    if (status !== last) { console.log(status); last = status; }
    if (['completed', 'needs_attention', 'publication_failed'].includes(snapshot.phase)) break;
    await delay(1500);
  }
  result.executionWallMs = Date.now() - start; result.phase = snapshot.phase;
  write('snapshot.json', snapshot);
  result.executions = [];
  for (const execution of snapshot.executions) {
    let text = '', offset = 0;
    while (true) { const page = await api('get_execution_output', { runId: snapshot.runId, executionId: execution.id, offset }); text += page.content; offset = page.nextOffset; if (page.complete) break; }
    fs.writeFileSync(path.join(out, `${execution.node}-${execution.attempt}.jsonl.gz`), gzipSync(text));
    const events = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const exited = events.findLast(e => e.type === 'grapher_process_exited');
    const tools = events.filter(e => e.type === 'tool_execution_start');
    result.executions.push({ node: execution.node, status: execution.status, attempt: execution.attempt,
      runtimeMs: execution.completedAt - execution.startedAt, processMs: exited?.elapsedMs,
      tools: tools.length, toolErrors: events.filter(e => e.type === 'tool_execution_end' && (e.isError || e.result?.isError)).length,
      commands: tools.filter(e => e.toolName === 'bash').map(e => e.args?.command) });
  }
  result.changed = git('diff', '--name-only', result.baseline, 'HEAD').split('\n').filter(Boolean);
  result.clean = git('status', '--porcelain') === '';
  if (snapshot.phase !== 'completed' || !result.clean) throw Error('Did not complete and publish cleanly without intervention');
  if (!result.changed.every(file => file.startsWith('reports/'))) throw Error('Application source changed');
  for (const name of ['auth', 'storage', 'release']) if (fs.statSync(path.join(project, 'reports', name + '.md')).size < 100) throw Error('Missing report');
  fs.cpSync(path.join(project, 'reports'), path.join(out, 'reports'), { recursive: true });
  result.sourceUnchanged = true; result.status = 'PASS';
} catch (error) { result.status = 'FAIL'; result.error = String(error); console.error(error); process.exitCode = 1; }
finally { result.endedAt = new Date().toISOString(); write('result.json', result); server.kill('SIGINT'); fs.closeSync(fd); }
