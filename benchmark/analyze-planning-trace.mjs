import fs from 'node:fs';
import path from 'node:path';
import { repositoryFiles } from './planning-cases.mjs';
const root = path.resolve(process.argv[2]);
const summaries = [];
for (const name of fs.readdirSync(root).filter(name => /^P\d+$/.test(name)).sort()) {
  const repository = path.join(root, name, 'repository');
  const actualFiles = fs.readdirSync(repository, { recursive: true }).filter(file => fs.statSync(path.join(repository, file)).isFile()).sort();
  const expectedFiles = Object.keys(repositoryFiles).sort();
  const sample = { task: name, repositoryUnchanged: JSON.stringify(actualFiles) === JSON.stringify(expectedFiles) && expectedFiles.every(file => fs.readFileSync(path.join(repository, file), 'utf8') === repositoryFiles[file]), stages: {} };
  for (const role of ['partition', 'planner']) {
    const dir = path.join(root, name, role);
    if (!fs.existsSync(path.join(dir, 'result.json'))) continue;
    const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const begin = events.find(e => e.type === 'grapher_process_started');
    const end = events.findLast(e => e.type === 'grapher_process_exited');
    const tools = events.filter(e => e.type === 'tool_execution_start');
    const ends = events.filter(e => e.type === 'tool_execution_end');
    const messages = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant');
    const first = events.find(e => e.type === 'message_update' || e.type === 'message_end');
    const usage = messages.reduce((sum, e) => { for (const key of ['input', 'output', 'reasoning', 'cacheRead']) sum[key] = (sum[key] || 0) + (e.message.usage?.[key] || 0); return sum; }, {});
    sample.stages[role] = { status: result.status, durationMs: result.durationMs, firstAssistantMs: first && begin ? first.grapherReceivedAt - begin.timestamp : null, afterLastToolMs: ends.length && end ? end.timestamp - ends.at(-1).grapherReceivedAt : null, toolMs: ends.reduce((sum,e) => { const start = tools.find(t => t.toolCallId === e.toolCallId); return sum + (start ? e.grapherReceivedAt - start.grapherReceivedAt : 0); },0), tools: Object.fromEntries([...new Set(tools.map(e=>e.toolName))].map(name=>[name,tools.filter(e=>e.toolName===name).length])), errors: ends.filter(e=>e.isError || e.result?.isError).length, usage };
    if (role === 'partition' && result.status === 'PASS') sample.route = JSON.parse(fs.readFileSync(path.join(dir, 'route.json'), 'utf8')).planType;
    if (role === 'planner') {
      const graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
      const compiled = JSON.parse(fs.readFileSync(path.join(dir, 'compiler.json'), 'utf8'));
      sample.graph = { nodes: graph.nodes.map(n=>n.name), edges: graph.edges, taskWords: graph.nodes.reduce((n,node)=>n+node.task.split(/\s+/).length,0), compiled: !!compiled.plan && !compiled.diagnostics.length };
    }
  }
  summaries.push(sample);
}
fs.writeFileSync(path.join(root, 'trace-summary.json'), JSON.stringify(summaries, null, 2)+'\n');
console.log(JSON.stringify(summaries,null,2));
