import assert from 'node:assert/strict';
import test from 'node:test';
import { activePlannerOutput, plannerConversationEdits, plannerHistoryIds, plannerTurnIds } from '../src/lib/plannerOutput.ts';
import { recoveredPlanningForDisplay } from '../src/services/planningRecovery.ts';

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

test('an edit keeps the failed replacement turn it started', () => {
  const events = [
    { type: 'created', planning_id: 'initial', planning: { planningId: 'initial', createdAt: 100 } },
    { type: 'graph_revised', planning_id: 'followup', planning: { planningId: 'followup', createdAt: 200 } },
    { type: 'planner_conversation_edited', old_instruction: 'followup' },
    { type: 'planner_workspace_selected', planning: { planningId: 'replacement', createdAt: 300 } },
    { type: 'planner_turn_aborted', planning: { planningId: 'replacement', createdAt: 300, status: 'failed' } },
  ];
  const edits = plannerConversationEdits(events);
  assert.deepEqual(edits, [{ old_instruction: 'followup', nextPlanningId: 'replacement' }]);
  const log = [source('initial'), user('first'), 'initial reply',
    source('followup'), user('followup'), 'followup reply',
    source('replacement'), user('replacement'), 'failed reply'].join('\n') + '\n';
  const visible = activePlannerOutput(log, edits);
  assert.match(visible, /initial reply/);
  assert.match(visible, /failed reply/);
  assert.doesNotMatch(visible, /followup reply/);
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

test('a newer live Planner turn retires the recovered snapshot instead of keeping it marked running', () => {
  const running = {
    planningId: 'review', roles: {}, totalPlanningDuration: 0, modelDuration: 0, status: 'running',
  };
  assert.equal(recoveredPlanningForDisplay(running, null, false, false)?.planningId, 'review');
  // A poll can discover a turn before its Run snapshot has a planning summary;
  // an absent snapshot summary must not erase that discovery.
  assert.equal(recoveredPlanningForDisplay(null, running, false, false), undefined);
  // A run switch can pair the previous run's terminal summary with the newly
  // discovered running turn; the older snapshot must not erase it.
  const previousRun = { ...running, planningId: 'old-run', status: 'failed', createdAt: 1 };
  const discovered = { ...running, planningId: 'new-run', status: 'running', createdAt: 2 };
  assert.equal(recoveredPlanningForDisplay(previousRun, discovered, false, false), undefined, 'keep the poll-discovered turn');
  // The browser owns a new stream: its live transcript is authoritative.
  assert.equal(recoveredPlanningForDisplay(running, running, true, false), null);
  // A request is in flight: an existing recovery stays (no unmount flash),
  // and a not-yet-adopted turn is not adopted mid-request.
  assert.equal(recoveredPlanningForDisplay(running, running, false, true)?.planningId, 'review');
  assert.equal(recoveredPlanningForDisplay(running, null, false, true), undefined);
  // Terminal snapshots never remain a recovered live turn.
  assert.equal(recoveredPlanningForDisplay({ ...running, status: 'failed' }, running, false, false), null);
  // A newer snapshot supersedes the recovered ID (the stale-display bug).
  const staleReview = { ...running, planningId: 'review', createdAt: 1 };
  const continuation = { ...running, planningId: 'continue', createdAt: 2 };
  assert.equal(recoveredPlanningForDisplay(continuation, staleReview, false, false)?.planningId, 'continue');
  assert.equal(recoveredPlanningForDisplay(continuation, staleReview, true, false), null);
});
