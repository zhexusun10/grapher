// Replay the preserved v6 event corpus in a disposable runtime and measure the
// shipping metadata API. No model, source writes or edits to original evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const repo = path.resolve(import.meta.dirname, '../..');
const out = path.join(import.meta.dirname, 'v7-validation');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grapher-v7-projection-'));
const source = path.join(import.meta.dirname, 'v6-e2e-recovery/snapshot.json');
execFileSync('python3', ['-c', `import json,sqlite3,sys
s=json.load(open(sys.argv[1])); db=sqlite3.connect(sys.argv[2]);db.execute('CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL)')
for e in s['events']:
 p={k:v for k,v in e.items() if k not in ('timestamp','sequence')}
 db.execute('INSERT INTO events VALUES (?,?,?,?)',(e['sequence'],s['runId'],e['timestamp'],json.dumps(p)))
db.commit()
`, source, path.join(root, 'events.sqlite')]);
const fd = fs.openSync(path.join(root, 'server.log'), 'w');
const server = spawn(path.join(repo, 'backend/target/release/grapher'), [], { cwd: repo, env: { ...process.env, GRAPHER_PORT: '1551', GRAPHER_DATA_DIR: root }, stdio: ['ignore', fd, fd] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = { root, startedAt: new Date().toISOString() };
const api = async (command, body = {}) => {
  const start = performance.now();
  const response = await fetch(`http://127.0.0.1:1551/api/${command}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const bytes = await response.text(); const elapsedMs = performance.now() - start;
  const value = JSON.parse(bytes); if (value.error) throw Error(value.error);
  return { value: value.result, bytes: Buffer.byteLength(bytes), elapsedMs };
};
try {
  for (let i = 0; i < 100; i++) { try { await api('snapshot', { detail: 'metadata' }); break; } catch { await delay(100); } }
  const full = await api('snapshot'), compact = await api('snapshot', { compact: true }), metadata = await api('snapshot', { detail: 'metadata' });
  result.responses = Object.fromEntries(Object.entries({ full, compact, metadata }).map(([key, { bytes, elapsedMs }]) => [key, { bytes, elapsedMs }]));
  assert.equal(metadata.value.phase, 'completed');
  assert.ok(metadata.bytes < 100000);
  assert.ok(metadata.value.events.every(e => e.type !== 'output' && !e.output));
  assert.equal(metadata.value.executions.length, full.value.executions.length);
  for (const execution of full.value.executions) {
    let text = '', offset = 0, pages = 0;
    while (true) {
      const { value: page } = await api('get_execution_output', { runId: full.value.runId, executionId: execution.id, offset });
      assert.ok(Buffer.byteLength(page.content) <= 256 * 1024); text += page.content; offset = page.nextOffset; pages++;
      if (page.complete) break;
    }
    assert.equal(text, execution.output);
    (result.executions ||= []).push({ id: execution.id, bytes: Buffer.byteLength(text), pages });
  }
  result.metadataPollMs = [];
  for (let n = 0; n < 30; n++) result.metadataPollMs.push((await api('snapshot', { detail: 'metadata' })).elapsedMs);
  assert.deepEqual((await api('snapshot')).value, full.value, 'Read projection must not mutate/rewrite history');
  result.status = 'PASS';
} catch (error) { result.status = 'FAIL'; result.error = String(error); console.error(error); process.exitCode = 1; }
finally { fs.writeFileSync(path.join(out, 'projection.json'), JSON.stringify(result, null, 2) + '\n'); server.kill('SIGINT'); fs.closeSync(fd); }
