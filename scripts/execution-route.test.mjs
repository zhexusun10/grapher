import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deduceRouteType } from '../src/services/executionRoute.ts';

test('persisted graph route cannot auto-approve a single task node as serial', () => {
  const graph = { nodes: [{ name: 'task', task: 'test' }], edges: [], originalGoal: 'test' };
  assert.equal(deduceRouteType({ graph, planType: 'graph' }), 'graph');
  assert.equal(deduceRouteType({ graph, planType: 'serial' }), 'serial');
  assert.equal(deduceRouteType({ graph }), 'serial', 'legacy stores keep their existing interpretation');
  assert.equal(deduceRouteType({ graph: { ...graph, nodes: [{ name: 'worker' }] } }), 'graph');
  assert.equal(deduceRouteType({ graph: { ...graph, nodes: [] } }), 'undecided');
});
