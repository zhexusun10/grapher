import fs from 'node:fs';
import path from 'node:path';

import { createWorkspacePaths } from '../backend/resources/workspace-paths.mjs';
import { INSPECTION_POLICY, repositoryPath } from '../backend/resources/planning-inspection.mjs';

export const PLANNER_TOOL_POLICY = 'planner-workspace-tools-v6';

// Verify paired tool evidence and the restricted inspection boundary.
export function checkPlanningBoundary(directory, repository) {
  const issues = [];
  let stage, events;
  try {
    stage = JSON.parse(fs.readFileSync(path.join(directory, 'stage.json'), 'utf8'));
    events = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  } catch (error) {
    return { status: 'FAIL', policy: PLANNER_TOOL_POLICY, issues: [`Missing or invalid planner tool evidence: ${error}`] };
  }
  if (stage.toolPolicy !== PLANNER_TOOL_POLICY || stage.tools !== 'node,edge,read,bash') {
    issues.push('Candidate did not attest the current restricted Planner tool policy; historical inspection evidence is unverified');
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
    if (event.toolName === 'bash' && !failed && event.result?.details?.inspectionPolicy !== INSPECTION_POLICY) {
      issues.push('Bash executed without restricted read-only policy evidence');
    }
    if (event.toolName === 'read' && !failed) {
      try {
        if (!repository || typeof start.args?.path !== 'string') throw new Error('Missing repository or read path');
        repositoryPath(repository, createWorkspacePaths(repository).physical(start.args.path), true);
      } catch {
        issues.push('Successful read escaped or could not verify the repository input boundary');
      }
    }
    if (!['node', 'edge', 'read', 'bash'].includes(event.toolName) && !failed) {
      issues.push(`Unexpected successful Planner tool: ${event.toolName}`);
    }
  }
  if (pending.size || !completed) issues.push('Incomplete or absent candidate tool execution evidence');
  return { status: issues.length ? 'FAIL' : 'PASS', policy: PLANNER_TOOL_POLICY, issues: [...new Set(issues)] };
}
