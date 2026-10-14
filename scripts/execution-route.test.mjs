import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deduceRouteType, shouldShowRouteBadge } from '../src/services/executionRoute.ts';

test('persisted graph route cannot auto-approve a single task node as serial', () => {
  const graph = { nodes: [{ name: 'task', task: 'test' }], edges: [], originalGoal: 'test' };
  assert.equal(deduceRouteType({ graph, planType: 'graph' }), 'graph');
  assert.equal(deduceRouteType({ graph, planType: 'serial' }), 'serial');
  assert.equal(deduceRouteType({ graph }), 'serial', 'legacy stores keep their existing interpretation');
  assert.equal(deduceRouteType({ graph: { ...graph, nodes: [{ name: 'worker' }] } }), 'graph');
  assert.equal(deduceRouteType({ graph: { ...graph, nodes: [] } }), 'undecided');
});

test('shouldShowRouteBadge suppresses badges when user explicitly selects serial or graph mode', () => {
  // When user explicitly selects serial mode in the frontend, the badge is not shown upon entering conversation
  assert.equal(
    shouldShowRouteBadge({ initialPlanMode: 'serial', routeType: 'serial' }),
    false,
    'serial badge must not be shown when user selects serial mode'
  );

  // When user explicitly selects graph mode in the frontend, the badge is not shown upon entering conversation
  assert.equal(
    shouldShowRouteBadge({ initialPlanMode: 'graph', routeType: 'graph' }),
    false,
    'graph badge must not be shown when user selects graph mode'
  );

  // When user explicitly selects auto mode in the frontend, the badge is shown
  assert.equal(
    shouldShowRouteBadge({ initialPlanMode: 'auto', routeType: 'undecided' }),
    true,
    'evaluating badge must be shown in auto mode'
  );
  assert.equal(
    shouldShowRouteBadge({ initialPlanMode: 'auto', routeType: 'serial' }),
    true,
    'serial decision badge must be shown when decided in auto mode'
  );
  assert.equal(
    shouldShowRouteBadge({ initialPlanMode: 'auto', routeType: 'graph' }),
    true,
    'graph decision badge must be shown when decided in auto mode'
  );
});

test('shouldShowRouteBadge respects plannerStream mode and partitioner indicators', () => {
  // Planner stream with explicit initialPlanMode
  assert.equal(
    shouldShowRouteBadge({ plannerStream: { initialPlanMode: 'serial' }, routeType: 'serial' }),
    false
  );
  assert.equal(
    shouldShowRouteBadge({ plannerStream: { initialPlanMode: 'graph' }, routeType: 'graph' }),
    false
  );
  assert.equal(
    shouldShowRouteBadge({ plannerStream: { initialPlanMode: 'auto' }, routeType: 'serial' }),
    true
  );

  // Streaming partitioner content indicates auto route
  assert.equal(
    shouldShowRouteBadge({ plannerStream: { stage: 'partitioning' }, routeType: 'undecided' }),
    true
  );
  assert.equal(
    shouldShowRouteBadge({ plannerStream: { partitionerText: 'Evaluating...' }, routeType: 'undecided' }),
    true
  );
});

test('shouldShowRouteBadge deduces mode from snapshot events and partition metrics for historical runs', () => {
  // Snapshot with planning_started event specifying plan_type was manually launched
  const manualSerialEvents = [{ type: 'planning_started', plan_type: 'serial' }];
  assert.equal(
    shouldShowRouteBadge({ state: { events: manualSerialEvents, planType: 'serial' }, routeType: 'serial' }),
    false,
    'historical manual serial run must not show badge'
  );

  const manualGraphEvents = [{ type: 'planning_started', plan_type: 'graph' }];
  assert.equal(
    shouldShowRouteBadge({ state: { events: manualGraphEvents, planType: 'graph' }, routeType: 'graph' }),
    false,
    'historical manual graph run must not show badge'
  );

  // Snapshot with planning_started having no plan_type was auto mode
  const autoEvents = [{ type: 'planning_started' }, { type: 'routed', plan_type: 'graph' }];
  assert.equal(
    shouldShowRouteBadge({ state: { events: autoEvents, planType: 'graph' }, routeType: 'graph' }),
    true,
    'historical auto run with routed event must show badge'
  );

  // Snapshot with partition role metrics indicating partitioner ran
  const partitionRole = { durationSeconds: 2.5, usage: { input: 100, output: 20 } };
  assert.equal(
    shouldShowRouteBadge({ state: { planning: { roles: { partition: partitionRole } }, planType: 'serial' }, routeType: 'serial' }),
    true,
    'historical run with partitioner metrics must show badge'
  );
});

