import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkPlanningBoundary } from './planning-boundary.mjs';
import { INSPECTION_POLICY } from '../backend/resources/planning-inspection.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository'); fs.mkdirSync(repository);
  const stage = { tools: 'node,edge,read,bash', inspectionPolicy: INSPECTION_POLICY };
  const events = [
    { type: 'tool_execution_start', toolCallId: '1', toolName: 'bash', args: { command: 'ls' } },
    { type: 'tool_execution_end', toolCallId: '1', toolName: 'bash', result: { details: { inspectionPolicy: INSPECTION_POLICY } }, isError: false },
  ];
  const check = () => {
    fs.writeFileSync(path.join(root, 'stage.json'), JSON.stringify(stage));
    fs.writeFileSync(path.join(root, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
    return checkPlanningBoundary(root, repository);
  };
  return { stage, events, check };
}
test('current boundary evidence passes; unrestricted historical evidence does not', t => {
  const { stage, events, check } = fixture(t);
  assert.equal(check().status, 'PASS');
  delete events[1].result.details.inspectionPolicy;
  events[0].args.command = 'cd .. && cat rubric.json';
  assert.equal(check().status, 'FAIL');
  delete stage.inspectionPolicy;
  assert.match(check().issues.join(' '), /historical unrestricted/);
});
test('successful outside reads, unknown tools and incomplete evidence fail even if Git is clean', t => {
  const { events, check } = fixture(t);
  events[0].toolName = events[1].toolName = 'read';
  events[0].args = { path: '../rubric.json' };
  assert.match(check().issues.join(' '), /escaped/);
  events[1].isError = true; // A correctly denied attempt is not a boundary breach.
  assert.equal(check().status, 'PASS');
  events[1].isError = false;
  events[0].toolName = events[1].toolName = 'write';
  assert.match(check().issues.join(' '), /Unexpected/);
  events.pop();
  assert.match(check().issues.join(' '), /Incomplete/);
});
