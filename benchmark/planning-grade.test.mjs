import test from 'node:test';
import assert from 'node:assert/strict';
import { cases, dimensionRubric } from './planning-cases.mjs';
import { scoreGraph, parseReview, scoreRouting } from './planning-grade.mjs';
const task = cases.find(c => c.id === 'P004');
const graph = () => ({ nodes: [
  { name: 'api_work', task: 'Implement server/users.ts with filtering, cursor pagination and error handling. Add API unit tests.' },
  { name: 'browser_work', task: 'Implement web/users.ts with debouncing, pagination, states and stale response protection. Add browser unit tests.' },
  { name: 'acceptance', task: 'Verify both implementations in tests/users-flow.test.ts including invalid cursors and out-of-order responses.' },
], edges: [
  { from: 'api_work', to: 'acceptance', feedback: false },
  { from: 'browser_work', to: 'acceptance', feedback: false },
] });
const compiled = { plan: {}, diagnostics: [] };
const review = g => ({ unitOwners: { backend: ['api_work'], frontend: ['browser_work'], integration: ['acceptance'] }, dimensions: Object.keys(dimensionRubric).map(id => ({ id, score: 2, reason: 'Synthetic positive judge used to test deterministic constraints, not real model evidence.', evidence: [{ node: g.nodes[0].name, quote: g.nodes[0].task }] })) });
const score = (g, r = review(g), c = compiled) => scoreGraph(task, g, c, r);

test('accepts coherent graph regardless of node names, order or transitive dependency representation', () => {
  const g = graph();
  assert.equal(score(g).status, 'PASS');
  g.nodes.reverse(); g.edges.reverse();
  assert.equal(score(g).status, 'PASS');
  g.nodes.push({ name: 'api_check', task: 'Complete and verify server/users.ts behavior and retain its workspace state.' });
  g.edges = g.edges.filter(e => e.from !== 'api_work');
  g.edges.push({ from: 'api_work', to: 'api_check', feedback: false }, { from: 'api_check', to: 'acceptance', feedback: false });
  const transitiveReview = review(g);
  transitiveReview.unitOwners.backend = ['api_work', 'api_check'];
  assert.equal(score(g, transitiveReview).status, 'PASS');
});
test('a positive judge cannot hide missing dependencies or artificial serialization', () => {
  const missing = graph(); missing.edges.pop();
  assert.ok(score(missing).checks.some(c => c.id === 'dependency:frontend->integration' && !c.pass));
  const serial = graph(); serial.edges.push({ from: 'api_work', to: 'browser_work', feedback: false });
  assert.ok(score(serial).checks.some(c => c.id === 'parallel:backend|frontend' && !c.pass));
});
test('keyword stuffing in a monolithic node cannot masquerade as independent workstreams', () => {
  const g = { nodes: [{ name: 'everything', task: graph().nodes.map(n => n.task).join(' ') }], edges: [] };
  const r = review(g); r.unitOwners = { backend: ['everything'], frontend: ['everything'], integration: ['everything'] };
  assert.equal(score(g, r).status, 'FAIL');
});
test('rejects omitted deliverables and compiler-invalid graphs even with positive semantic scores', () => {
  const g = graph(); const r = review(g); r.unitOwners.backend = [];
  assert.equal(score(g, r).status, 'FAIL');
  assert.equal(score(graph(), review(graph()), { diagnostics: [{ code: 'E101' }] }).status, 'FAIL');
});
test('fails partial semantics and rejects fabricated evidence rather than repairing judgments', () => {
  const g = graph(); const r = review(g); r.dimensions[0].score = 0;
  assert.equal(score(g, r).status, 'FAIL');
  r.dimensions[0].evidence[0].quote = 'Invented instruction that never appeared';
  assert.throws(() => score(g, r), /Ungrounded/);
  assert.throws(() => score(g, { ...review(g), dimensions: [] }), /dimension set/);
  assert.throws(() => score(g, { ...review(g), unitOwners: { backend: ['imaginary'] } }), /work units/);
});
test('required feedback is checked against reviewer and implementation ownership', () => {
  const c = cases.find(c => c.id === 'P005');
  const g = { nodes: Object.entries(c.units).map(([name, u]) => ({ name, task: `Implement ${u.paths.join(', ')}. ${u.requirement}` })), edges: c.dependencies.map(([from, to]) => ({ from, to, feedback: false })) };
  const r = review(g); r.unitOwners = Object.fromEntries(Object.keys(c.units).map(id => [id, [id]]));
  assert.equal(scoreGraph(c, g, compiled, r).status, 'FAIL');
  g.edges.push(...c.feedback.map(([from, to]) => ({ from, to, feedback: true })));
  assert.equal(scoreGraph(c, g, compiled, r).status, 'PASS');
});
test('line-based evidence is extracted from task text and out-of-range references fail', () => {
  const g = graph(); const r = review(g);
  for (const d of r.dimensions) d.evidence = [{ node: g.nodes[0].name, line: 1 }];
  const graded = score(g, r);
  assert.equal(graded.dimensions[0].evidence[0].quote, g.nodes[0].task);
  g.nodes[0].task = 'A\nImplement server/users.ts with filtering, cursor pagination and error handling. Add API unit tests.';
  for (const d of r.dimensions) d.evidence = [{ node: g.nodes[0].name, line: 1 }];
  assert.equal(score(g, r).dimensions[0].evidence[0].quote, 'A');
  r.dimensions[0].evidence = [{ node: g.nodes[0].name, line: 900 }];
  assert.throws(() => score(g, r), /evidence line/);
});
test('a compiler-valid graph cannot bind fresh workers to the original repository', () => {
  const g = graph(); g.nodes[0].task = '/tmp/source-repository: ' + g.nodes[0].task;
  const graded = scoreGraph(task, g, compiled, review(g), '/tmp/source-repository');
  assert.equal(graded.status, 'FAIL');
  assert.equal(graded.maxScore, 14);
  assert.ok(graded.checks.some(c => c.id === 'workspace-portability' && !c.pass));
});

test('rejects unrequested feedback and nodes that own no requested work unit', () => {
  const g = graph();
  g.nodes.push({ name: 'extra_review', task: 'Review all work again without producing a requested deliverable.' });
  g.edges.push(
    { from: 'acceptance', to: 'extra_review', feedback: false },
    { from: 'extra_review', to: 'api_work', feedback: true },
  );
  const r = review(g);
  assert.equal(score(g, r).status, 'FAIL');
  const checks = score(g, r).checks;
  assert.ok(checks.some(c => c.id === 'economy:owned-nodes' && !c.pass));
  assert.ok(checks.some(c => c.id === 'feedback:no-unrequested-routes' && !c.pass));
});

test('rejects case-specific repository references that are not authoritative', () => {
  const c = cases.find(c => c.id === 'P005');
  const g = { nodes: Object.entries(c.units).map(([name, u]) => ({ name, task: `Implement ${u.paths.join(', ')}. ${u.requirement}` })), edges: c.dependencies.map(([from, to]) => ({ from, to, feedback: false })) };
  const r = review(g); r.unitOwners = Object.fromEntries(Object.keys(c.units).map(id => [id, [id]]));
  g.edges.push(...c.feedback.map(([from, to]) => ({ from, to, feedback: true })));
  g.nodes[0].task += ' Inherit the default from src/settings.ts.';
  const graded = scoreGraph(c, g, compiled, r);
  assert.ok(graded.checks.some(check => check.id === 'fidelity:irrelevant-reference:src/settings.ts' && !check.pass));
});

test('semantic quality requires at least 12/14 with no zero dimension', () => {
  const g = graph();
  const partial = review(g);
  partial.dimensions.find(d => d.id === 'fidelity').score = 1;
  partial.dimensions.find(d => d.id === 'economy').score = 1;
  assert.equal(score(g, partial).status, 'PASS');
  partial.dimensions.find(d => d.id === 'economy').score = 0;
  assert.equal(score(g, partial).status, 'FAIL');
});

test('route accuracy remains separate from repeated routing-tool calls', () => {
  assert.deepEqual(scoreRouting('serial', 'serial', { status: 'PASS', toolCalls: { route_task: 4 } }), { routeStatus: 'PASS', protocolStatus: 'FAIL' });
  assert.deepEqual(scoreRouting('graph', 'serial', { status: 'PASS', toolCalls: { route_task: 1 } }), { routeStatus: 'FAIL', protocolStatus: 'PASS' });
});

test('only accepts a JSON object or one JSON fence, never arbitrary prose extraction', () => {
  assert.deepEqual(parseReview('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => parseReview('Trust me: {"ok":true}'));
});
