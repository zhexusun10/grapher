import fs from 'node:fs';
import path from 'node:path';
import { INSPECTION_POLICY } from '../backend/resources/planning-inspection.mjs';

// Verify actual candidate tool evidence, not just the final Git status. Old
// unrestricted runs remain replayable for diagnosis, but are not trusted passes.
export function checkPlanningBoundary(directory, repository) {
  const issues = [];
  let stage, events;
  try {
    stage = JSON.parse(fs.readFileSync(path.join(directory, 'stage.json'), 'utf8'));
    events = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch (error) {
    return { status: 'FAIL', policy: INSPECTION_POLICY, issues: [`Missing or invalid inspection evidence: ${error}`] };
  }
  if (stage.inspectionPolicy !== INSPECTION_POLICY || stage.tools !== 'node,edge,read,bash') {
    issues.push('Candidate did not attest the current read-only inspection policy; historical unrestricted evidence is unverified');
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
    if (!start || start.toolName !== event.toolName) { issues.push('Tool result has no matching execution start'); continue; }
    completed++;
    const failed = event.isError || event.result?.isError;
    if (!['node', 'edge', 'read', 'bash'].includes(event.toolName) && !failed) issues.push(`Unexpected successful tool: ${event.toolName}`);
    if (event.toolName === 'bash' && !failed && event.result?.details?.inspectionPolicy !== INSPECTION_POLICY) {
      issues.push('Bash executed without read-only policy evidence (possible hidden-rubric access or code execution)');
    }
    if (event.toolName === 'read' && !failed) {
      const target = path.resolve(repository, String(start.args?.path ?? ''));
      const relative = path.relative(repository, target);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep).includes('.git')) {
        issues.push('Successful read escaped the repository input boundary');
      }
    }
  }
  if (pending.size || !completed) issues.push('Incomplete or absent candidate tool execution evidence');
  return { status: issues.length ? 'FAIL' : 'PASS', policy: INSPECTION_POLICY, issues: [...new Set(issues)] };
}
