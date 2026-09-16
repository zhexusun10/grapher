import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkPlanningBoundary, PLANNER_TOOL_POLICY } from './planning-boundary.mjs';
import { INSPECTION_POLICY } from '../backend/resources/planning-inspection.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = { tools: 'node,edge,read,bash', toolPolicy: PLANNER_TOOL_POLICY };
  const events = [
    { type: 'tool_execution_start', toolCallId: '1', toolName: 'node', args: { name: 'work', task: 'Do the work.' } },
    { type: 'tool_execution_end', toolCallId: '1', toolName: 'node', result: { content: [] }, isError: false },
  ];
  const check = () => {
    fs.writeFileSync(path.join(root, 'stage.json'), JSON.stringify(stage));
    fs.writeFileSync(path.join(root, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n'));
    return checkPlanningBoundary(root, root);
  };
  return { stage, events, check };
}

test('restricted Planner evidence passes; unverified historical surfaces do not', t => {
  const { stage, check } = fixture(t);
  assert.equal(check().status, 'PASS');
  stage.tools = 'node,edge,inspect';
  delete stage.toolPolicy;
  assert.equal(check().status, 'FAIL');
  assert.match(check().issues.join(' '), /historical inspection/);
});

test('inspection requires policy evidence and repository-scoped regular files', t => {
  const { events, check } = fixture(t);
  events[0].toolName = events[1].toolName = 'bash';
  assert.match(check().issues.join(' '), /without restricted/);
  events[1].result.details = { inspectionPolicy: 'repository-inspection-v3' };
  assert.match(check().issues.join(' '), /without restricted/);
  events[1].result.details = { inspectionPolicy: INSPECTION_POLICY };
  assert.equal(check().status, 'PASS');
  events[0].toolName = events[1].toolName = 'read';
  events[0].args = { path: 'stage.json' };
  assert.equal(check().status, 'PASS');
  events[0].args.path = '/workspace/stage.json';
  assert.equal(check().status, 'PASS');
  for (const target of ['../hidden.json', '/workspace/../hidden.json', '.git/config', '.']) {
    events[0].args.path = target;
    assert.match(check().issues.join(' '), /repository input boundary/);
  }
});

test('successful unknown tools and incomplete evidence fail while rejected attempts pass', t => {
  const { events, check } = fixture(t);
  events[0].toolName = events[1].toolName = 'inspect';
  assert.match(check().issues.join(' '), /Unexpected successful Planner tool/);
  events[1].isError = true;
  assert.equal(check().status, 'PASS');
  events[1].isError = false;
  events[0].toolName = events[1].toolName = 'write';
  assert.match(check().issues.join(' '), /Unexpected/);
  events.pop();
  assert.match(check().issues.join(' '), /Incomplete/);
});
