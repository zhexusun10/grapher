import assert from 'node:assert/strict';
import test from 'node:test';
import { activePlannerOutput, plannerHistoryIds, plannerTurnIds } from '../src/lib/plannerOutput.ts';

const source = (id: string) => JSON.stringify({ type: 'grapher_planning_source', planningId: id });
const user = (text: string) => JSON.stringify({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } });

test('Planner branch hides only abandoned turns while retaining earlier context and the new revision', () => {
  const log = [source('a'), user('original'), 'before', user('old follow-up'), 'abandoned',
    source('b'), user('obsolete'), 'abandoned too', source('c'), user('edited'), 'new reply'].join('\n') + '\n';
  const visible = activePlannerOutput(log, [{ old_instruction: 'old follow-up', nextPlanningId: 'c' }]);
  assert.match(visible, /before/);
  assert.match(visible, /edited/);
  assert.doesNotMatch(visible, /abandoned|obsolete/);
});

test('Planner branch matches Pi follow-ups with a dynamic status prefix', () => {
  const log = [source('a'), user('first'), user('Current graph node status:\n- task: completed\n\nlater'), 'old reply'].join('\n') + '\n';
  assert.doesNotMatch(activePlannerOutput(log, [{ old_instruction: 'later' }]), /old reply/);
});

test('live Planner continuation does not replay the revision it is streaming', () => {
  const events = [
    { type: 'created', planning_id: 'initial', planning: { planningId: 'initial', createdAt: 100 } },
    { type: 'graph_revised', planning_id: 'revision', planning: { planningId: 'revision', createdAt: 200 } },
  ];
  const base = { events, planning: true, live: true, backgroundReview: false, routeType: 'graph', representedIds: ['revision'] };
  // The snapshot announces the new attempt before it commits a graph; its
  // durable JSONL must wait until the live transcript releases it.
  assert.deepEqual(plannerHistoryIds({ ...base, savedPlannerId: 'next', continuation: true }), ['initial', 'revision']);
  // `savedPlannerId` still names the last completed turn until the backend
  // announces the revision, so that turn stays visible during the handoff.
  assert.deepEqual(plannerHistoryIds({ ...base, savedPlannerId: 'revision', continuation: true }), ['initial', 'revision']);
  // Once the turn settles, the JSONL is authoritative and the newest attempt returns.
  assert.deepEqual(plannerHistoryIds({ ...base, savedPlannerId: 'next', continuation: true, planning: false }),
    ['initial', 'revision', 'next']);
  // Fresh planning renders only the live transcript, never durable history.
  assert.deepEqual(plannerHistoryIds({ ...base, savedPlannerId: 'next', continuation: false }), []);
});

test('aborted revision turns stay in the replayed Planner conversation', () => {
  const events = [
    { type: 'planning_started', planning: { planningId: 'start' } },
    { type: 'created', planning_id: 'initial', planning: { planningId: 'initial', createdAt: 100 } },
    { type: 'graph_revised', planning_id: 'rev1', planning: { planningId: 'rev1', createdAt: 200 } },
    { type: 'planner_review_started', planning: { planningId: 'review1', status: 'running', createdAt: 300 } },
    { type: 'planner_review_finished', planning: { planningId: 'review1', status: 'failed' } },
    { type: 'graph_revised', planning_id: 'rev2', planning: { planningId: 'rev2', createdAt: 400 } },
    // Recovery records the interrupted turn after later turns; createdAt restores order.
    { type: 'planner_turn_aborted', planning: { planningId: 'aborted', status: 'failed', createdAt: 350 } },
    { type: 'finished', execution_id: 'e1' },
  ];
  assert.deepEqual(plannerTurnIds(events), ['initial', 'rev1', 'review1', 'aborted', 'rev2']);
  assert.deepEqual(plannerTurnIds([]), []);
  assert.deepEqual(plannerTurnIds([{ type: 'planner_turn_aborted' }]), []);
  // Legacy events without createdAt keep their event order ahead of new turns.
  assert.deepEqual(plannerTurnIds([
    { type: 'created', planning_id: 'a' },
    { type: 'graph_revised', planning_id: 'b' },
    { type: 'planner_turn_aborted', planning: { planningId: 'c', createdAt: 5 } },
  ]), ['a', 'b', 'c']);
});
