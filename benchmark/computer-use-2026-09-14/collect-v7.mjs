// Idempotently package completed evidence and keep routing, API completion and
// execution outcomes separate. Failed/incomplete model calls stay in the corpus.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
const base = import.meta.dirname;
const read = file => JSON.parse(fs.readFileSync(file));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const observations = [];
for (const family of ['v7-validation', 'v7-recheck', 'v7-catalog']) {
  const target = path.join(base, family), meta = read(path.join(target, 'metadata.json'));
  for (const name of fs.readdirSync(meta.root)) {
    const source = path.join(meta.root, name), destination = path.join(target, name);
    if (!fs.statSync(source).isDirectory()) continue;
    const resultFile = path.join(destination, 'result.json');
    if (!fs.existsSync(resultFile)) continue;
    const result = read(resultFile);
    const sample = { family, name, outcome: result.status, error: result.error, route: null, planningStatus: null,
      planningSeconds: null, roleMetrics: {}, executions: result.executions, executionWallMs: result.executionWallMs };
    const plans = path.join(source, 'data/planning');
    if (fs.existsSync(plans)) for (const id of fs.readdirSync(plans)) {
      const folder = path.join(plans, id);
      for (const file of ['route.json', 'graph.json', 'summary.json', 'request.json']) {
        if (!fs.existsSync(path.join(folder, file))) continue;
        const value = read(path.join(folder, file)); write(path.join(destination, 'planning', file), value);
        if (file === 'route.json') sample.route = value.plan_type ?? value.planType;
        if (file === 'summary.json') { sample.planningStatus = value.status; sample.planningSeconds = value.totalPlanningDuration; sample.roleMetrics = value.roles; }
      }
      for (const role of ['partition', 'planner']) {
        const file = path.join(folder, `${role}.jsonl`);
        if (fs.existsSync(file)) fs.writeFileSync(path.join(destination, 'planning', `${role}.jsonl.gz`), gzipSync(fs.readFileSync(file)));
      }
    }
    for (const file of fs.readdirSync(source).filter(file => file.endsWith('.jsonl'))) {
      fs.writeFileSync(path.join(destination, `${file}.gz`), gzipSync(fs.readFileSync(path.join(source, file))));
    }
    observations.push(sample);
  }
}
write(path.join(base, 'v7-validation/observations.json'), observations);
console.log(observations.map(sample => `${sample.family}/${sample.name}: route=${sample.route ?? 'unavailable'}, planning=${sample.planningStatus ?? '-'}, outcome=${sample.outcome}`).join('\n'));
