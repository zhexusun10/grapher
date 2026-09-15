import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cases, repositoryFiles } from './planning-cases.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const root = path.resolve(process.argv[2] || `benchmark-results/planning-trace-${Date.now()}`);
if (fs.existsSync(root) && fs.existsSync(path.join(root, 'metadata.json'))) throw Error(`Refusing to overwrite existing evidence: ${root}`);
const selected = (process.env.TRACE_CASES || 'P001,P005,P006').split(',');
const plannerOnly = process.env.TRACE_PLANNER_ONLY === '1';
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const env = { ...process.env, PARTITIONER_MODEL: process.env.PARTITIONER_MODEL || 'dashscope/qwen3.8-flash', PLANNER_MODEL: process.env.PLANNER_MODEL || 'dashscope/qwen3.8-flash', PARTITIONER_THINKING: process.env.PARTITIONER_THINKING || 'medium', PLANNER_THINKING: process.env.PLANNER_THINKING || 'medium' };
const sources = ['backend/resources/prompts/partitioner.md', 'backend/resources/prompts/planner.md', 'backend/resources/planner.ts', 'backend/src/compiler.rs', 'backend/src/engine.rs', 'benchmark/planning-host.rs'];
write(path.join(root, 'metadata.json'), { startedAt: new Date().toISOString(), selected, plannerOnly, partitionerModel: env.PARTITIONER_MODEL, plannerModel: env.PLANNER_MODEL, partitionerThinking: env.PARTITIONER_THINKING, plannerThinking: env.PLANNER_THINKING, nodeExecutionCount: 0, sources: Object.fromEntries(sources.map(file => { const data = fs.readFileSync(path.join(repo, file)); const target = path.join(root, 'sources', file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); return [file, createHash('sha256').update(data).digest('hex')]; })) });
const results = [];
for (const id of selected) {
  const task = cases.find(c => c.id === id);
  if (!task) throw Error(`Unknown task ${id}`);
  const directory = path.join(root, id), repository = path.join(directory, 'repository');
  for (const [file, content] of Object.entries(repositoryFiles)) { const target = path.join(repository, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
  const result = { id, expectedRoute: task.expectedRoute };
  const stages = plannerOnly ? ['planner'] : process.env.TRACE_PARTITION_ONLY === '1' || task.expectedRoute !== 'graph' ? ['partition'] : ['partition', 'planner'];
  for (const stage of stages) {
    const output = path.join(directory, stage), input = path.join(directory, `${stage}-input.json`);
    write(input, { output, repository, goal: task.goal, stage });
    console.log(id, stage, 'started', new Date().toISOString());
    const log = fs.openSync(path.join(directory, `${stage}-host.log`), 'w');
    const status = await new Promise((resolve, reject) => {
      const child = spawn(path.join(repo, 'backend/target/debug/examples/benchmark'), [], { cwd: repo, env: { ...env, BENCHMARK_PLANNING_INPUT: input }, stdio: ['ignore', log, log] });
      child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    fs.closeSync(log);
    const read = file => JSON.parse(fs.readFileSync(path.join(output, file), 'utf8'));
    const events = fs.existsSync(path.join(output, 'events.jsonl')) ? fs.readFileSync(path.join(output, 'events.jsonl'), 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
    const start = events.find(e => e.type === 'grapher_process_started');
    const first = events.find(e => e.type === 'message_update' || e.type === 'message_end');
    const tools = events.filter(e => e.type === 'tool_execution_start');
    result[stage] = { ...status, ...(fs.existsSync(path.join(output, 'result.json')) ? read('result.json') : {}), firstAssistantMs: first && start ? first.grapherReceivedAt - start.timestamp : null, tools: tools.map(e => ({ tool: e.toolName, args: e.args })), toolErrors: events.filter(e => e.type === 'tool_execution_end' && (e.isError || e.result?.isError)), assistant: events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').map(e => e.message) };
    if (stage === 'partition' && result[stage].status === 'PASS') result.route = read('route.json').planType;
    console.log(id, stage, result[stage].status, result[stage].durationMs, result.route || '');
    write(path.join(directory, 'result.json'), result);
  }
  results.push(result);
  write(path.join(root, 'results.json'), results);
}
console.log('Finished', root);
