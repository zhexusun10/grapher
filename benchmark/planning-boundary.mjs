import fs from 'node:fs';
import path from 'node:path';

export const PLANNER_TOOL_POLICY = 'planner-graph-tools-v1';

// Verify the candidate used only graph mutation tools. Historical runs with
// repository inspection remain replayable for diagnosis but are not current evidence.
export function checkPlanningBoundary(directory) {
  const issues = [];
  let stage, events;
  try {
    stage = JSON.parse(fs.readFileSync(path.join(directory, 'stage.json'), 'utf8'));
    events = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch (error) {
    return { status: 'FAIL', policy: PLANNER_TOOL_POLICY, issues: [`Missing or invalid planner tool evidence: ${error}`] };
  }
  if (stage.toolPolicy !== PLANNER_TOOL_POLICY || stage.tools !== 'node,edge') {
    issues.push('Candidate did not attest the current graph-only Planner tool policy; historical inspection evidence is unverified');
  }
  const pending = new Map();
  let completed = 0;
  for (const event of events) {
    if (event.type === 'tool_execution_start') {
      if (pending.has(event.toolCallId)) issues.push('Duplicate tool execution ID');
      pending.set(event.toolCallId, event);
    }
    if (event.type !== 'tool_execution_end') continue;
    const start = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (!start || start.toolName !== event.toolName) {
      issues.push('Tool result has no matching execution start');
      continue;
    }
    completed++;
    const failed = event.isError || event.result?.isError;
    if (!['node', 'edge'].includes(event.toolName) && !failed) {
      issues.push(`Unexpected successful Planner tool: ${event.toolName}`);
    }
  }
  if (pending.size || !completed) issues.push('Incomplete or absent candidate tool execution evidence');
  return { status: issues.length ? 'FAIL' : 'PASS', policy: PLANNER_TOOL_POLICY, issues: [...new Set(issues)] };
}
