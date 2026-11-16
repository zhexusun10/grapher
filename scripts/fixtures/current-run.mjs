// Controlled fixture admission to a current private batch. Create the Run via
// the current API, append its explicit selection before any worker starts, then
// reload the idle Runtime. This never imports a historical Run or omits scope.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function privateGraph(api, data, { graph, config }) {
  const created = await api('save_graph', { graph, config });
  assert.equal(created.phase, 'awaiting_approval');
  const db = new DatabaseSync(join(data, 'events.sqlite'));
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    db.exec('PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO events(run_id,timestamp,payload,kind) VALUES(?,?,?,?)');
    for (const event of [
      { type: 'workspace_isolation_selected', isolated: true },
      { type: 'private_batch_selected', nodes: graph.nodes.map(node => node.id) },
    ]) insert.run(created.runId, Date.now(), JSON.stringify(event), event.type);
    db.exec('COMMIT');
  } finally { db.close(); }
  const state = await api('load_run', { runId: created.runId });
  assert.equal(state.runId, created.runId);
  assert.equal(state.isolatedWorkspaces, true);
  assert.deepEqual([...state.privateBatch].sort(), graph.nodes.map(node => node.id).sort());
  return state;
}
