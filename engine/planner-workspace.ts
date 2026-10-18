import { readFileSync, realpathSync } from 'node:fs';
import { createWorkspacePaths } from './workspace-paths.mjs';

type WorkspaceTarget = {
  requestedNode: string;
  actualNode: string;
  executionId: string;
  workspace: string;
  redirected?: boolean;
};

type WorkspaceState = {
  workspace: string;
  project: string;
  alias: string;
  paths: ReturnType<typeof createWorkspacePaths>;
};

let state: WorkspaceState | undefined;
let targetFile: string | undefined;
let targets = new Map<string, WorkspaceTarget>();
const listeners = new Set<(state: WorkspaceState, target: WorkspaceTarget) => void>();

function workspaceRoots(current: Map<string, WorkspaceTarget>): string[] {
  return [...new Set([...current.values()].map(target => target.workspace).filter(Boolean))];
}

export function configurePlannerWorkspace(
  workspace: string,
  project: string,
  alias: string,
  rawTargets = process.env.GRAPHER_PLANNER_WORKSPACES || '{}',
) {
  const parsed = JSON.parse(rawTargets) as Record<string, WorkspaceTarget>;
  targetFile = process.env.GRAPHER_PLANNER_WORKSPACES_FILE;
  targets = new Map(Object.entries(parsed));
  const initial = realpathSync.native(workspace);
  state = { workspace: initial, project, alias, paths: createWorkspacePaths(initial, project, alias, workspaceRoots(targets)) };
}

export function onPlannerWorkspaceChanged(listener: (state: WorkspaceState, target: WorkspaceTarget) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function plannerWorkspaceState(): WorkspaceState {
  if (!state) throw new Error('Planner workspace switching is unavailable');
  return state;
}

export function switchPlannerWorkspace(requestedNode: string): WorkspaceTarget {
  if (!state) throw new Error('Planner workspace switching is unavailable');
  const currentTargets = targetFile
    ? JSON.parse(readFileSync(targetFile, 'utf8')) as Record<string, WorkspaceTarget>
    : Object.fromEntries(targets);
  const target = currentTargets[requestedNode];
  if (!target) throw new Error(`No current workspace is available for node '${requestedNode}'`);
  const workspace = realpathSync.native(target.workspace);
  targets = new Map(Object.entries(currentTargets));
  state = { ...state, workspace, paths: createWorkspacePaths(workspace, state.project, state.alias, workspaceRoots(targets)) };
  for (const listener of listeners) listener(state, target);
  return { ...target, workspace };
}
