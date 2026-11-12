// Historical private-workspace Runs remain supported after adaptive batching.
// Seed only a fresh Run's original events in a disposable acceptance database;
// never rewrite/delete an event or change a Run already cached by the backend.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function seedLegacyRun(data, { graph, config }) {
  const path = join(data, 'events.sqlite');
  assert.ok(existsSync(path), 'start the disposable backend before seeding a legacy Run');
  const runId = randomUUID();
  const events = [{ type: 'created', graph, config }];
  if (!config.environment) events.push({ type: 'environment_policy_requested' });
  events.push({ type: 'routed', plan_type: 'graph' });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO events(run_id, timestamp, payload, kind) VALUES (?, ?, ?, ?)');
    for (const event of events) insert.run(runId, Date.now(), JSON.stringify(event), event.type);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  return runId;
}

export async function legacyGraph(api, data, options) {
  const runId = seedLegacyRun(data, options);
  const state = await api('snapshot', { runId });
  assert.equal(state.runId, runId);
  assert.equal(state.phase, 'awaiting_approval');
  assert.equal(state.isolatedWorkspaces ?? null, null, 'legacy replay must retain the private contract');
  return state;
}
