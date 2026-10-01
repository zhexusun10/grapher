import type { Snapshot } from "../types";

export type WorkspaceRuns = Record<string, string[]>;

export function normalizeWorkspacePath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

/** Windows aliases share an index; POSIX paths remain case-sensitive. */
export function workspaceKey(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (/^[a-z]:[/\\]/i.test(normalized) || normalized.startsWith("\\\\")) {
    return normalized.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export function normalizeWorkspaceRuns(index: WorkspaceRuns): WorkspaceRuns {
  const result: WorkspaceRuns = {};
  for (const [repository, ids] of Object.entries(index)) {
    const key = workspaceKey(repository);
    if (!key || key === "default" || !Array.isArray(ids)) continue;
    result[key] = [...new Set([...(result[key] ?? []), ...ids.filter(id => typeof id === "string")])];
  }
  return result;
}

/** Ownership comes from the Run, never from the workspace currently on screen. */
export function bindRunToWorkspace(index: WorkspaceRuns, runId: string, repository: string, replacedId?: string): WorkspaceRuns {
  const owner = workspaceKey(repository);
  if (!runId || !owner) return index;
  if (index[owner]?.includes(runId) &&
    !Object.entries(index).some(([key, ids]) =>
      (key !== owner && ids.includes(runId)) || (!!replacedId && ids.includes(replacedId)))) return index;

  const next: WorkspaceRuns = {};
  for (const [key, ids] of Object.entries(index)) {
    next[key] = ids.filter(id => id !== runId && id !== replacedId);
  }
  const existing = index[owner] ?? [];
  // A provisional card keeps its position when its durable ID arrives.
  next[owner] = replacedId && existing.includes(replacedId)
    ? [...new Set(existing.map(id => id === replacedId ? runId : id))]
    : [runId, ...(next[owner] ?? [])];
  return next;
}

export function snapshotBelongsToWorkspace(snapshot: Snapshot, repository: string): boolean {
  const owner = workspaceKey(snapshot.config?.repository ?? "");
  return !!owner && owner === workspaceKey(repository);
}

/** Repair previously polluted indexes as well as discover unindexed Runs. */
export function reconcileWorkspaceRuns(index: WorkspaceRuns, snapshots: Array<Snapshot | null>): WorkspaceRuns {
  let result = normalizeWorkspaceRuns(index);
  for (const key of Object.keys(result)) {
    // Provisional IDs only exist in the originating browser session.
    result[key] = result[key].filter(id => !id.startsWith("pending-"));
  }
  for (const snapshot of snapshots) {
    if (!snapshot?.runId) continue;
    const repository = snapshot.config?.repository;
    if (repository) {
      result = bindRunToWorkspace(result, snapshot.runId, repository);
    } else {
      // An unbound Run must not inherit whichever workspace bootstrapped it.
      for (const key of Object.keys(result)) result[key] = result[key].filter(id => id !== snapshot.runId);
    }
  }
  return result;
}
