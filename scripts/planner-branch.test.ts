import assert from 'node:assert/strict';
import test from 'node:test';
import { activePlannerOutput } from '../src/components/PlanningActivity.tsx';

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
  const log = [source('a'), user('first'), user('Current graph node status:\n- task: done\n\nlater'), 'old reply'].join('\n') + '\n';
  assert.doesNotMatch(activePlannerOutput(log, [{ old_instruction: 'later' }]), /old reply/);
});
