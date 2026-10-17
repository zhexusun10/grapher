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

/**
 * Fold one progressive validation batch into the warm cached index without
 * replacing cards whose histories are still unresolved. `validated` must be the
 * batch built for this publish: reading live validation state here would let a
 * later batch remove cards that this batch never inspected, and re-appending
 * them would replay their entrance animation in a different order.
 */
export function mergeValidatedWorkspaceRuns(
  current: WorkspaceRuns,
  validated: WorkspaceRuns,
): WorkspaceRuns {
  const merged: WorkspaceRuns = {};
  for (const [owner, ids] of Object.entries(current)) merged[owner] = [...ids];
  const validatedIds = new Set(Object.values(validated).flat());
  // Validation is authoritative for ownership, so a cached card proven to
  // belong to another workspace must leave its old list right away.
  for (const id of validatedIds) {
    for (const [owner, ids] of Object.entries(merged)) {
      if (validated[owner]?.includes(id)) continue;
      const index = ids.indexOf(id);
      if (index !== -1) ids.splice(index, 1);
    }
  }
  for (const [owner, ids] of Object.entries(validated)) {
    const list = merged[owner] || (merged[owner] = []);
    for (const id of ids) if (!list.includes(id)) list.push(id);
  }
  return merged;
}

export function snapshotBelongsToWorkspace(snapshot: Snapshot, repository: string): boolean {
  const owner = workspaceKey(snapshot.config?.repository ?? "");
  return !!owner && owner === workspaceKey(repository);
}

/**
 * Repair previously polluted indexes as well as discover unindexed Runs.
 * Cached cards keep their relative order; newly discovered Runs are inserted
 * ahead of them in snapshot order. Prepending one snapshot at a time would
 * reverse a cold cache and replay every card's entrance animation.
 */
export function reconcileWorkspaceRuns(index: WorkspaceRuns, snapshots: Array<Snapshot | null>): WorkspaceRuns {
  const cached = normalizeWorkspaceRuns(index);
  for (const key of Object.keys(cached)) {
    // Provisional IDs only exist in the originating browser session.
    cached[key] = cached[key].filter(id => !id.startsWith("pending-"));
  }

  // The last snapshot wins if one ID is reported more than once.
  const ownerByRun = new Map<string, string | null>();
  const discovered: string[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot?.runId) continue;
    if (!ownerByRun.has(snapshot.runId)) discovered.push(snapshot.runId);
    const repository = snapshot.config?.repository;
    ownerByRun.set(snapshot.runId, repository ? workspaceKey(repository) : null);
  }

  const result: WorkspaceRuns = {};
  for (const [owner, ids] of Object.entries(cached)) {
    for (const id of ids) {
      // An unbound Run must not inherit whichever workspace bootstrapped it.
      if (ownerByRun.has(id) && ownerByRun.get(id) !== owner) continue;
      (result[owner] ??= []).push(id);
    }
  }

  const discoveredByOwner = new Map<string, string[]>();
  for (const id of discovered) {
    const owner = ownerByRun.get(id);
    if (!owner) continue;
    const ids = discoveredByOwner.get(owner) ?? [];
    if (!discoveredByOwner.has(owner)) discoveredByOwner.set(owner, ids);
    ids.push(id);
  }
  for (const [owner, ids] of discoveredByOwner) {
    const existing = new Set(result[owner] ?? []);
    const prefix = ids.filter(id => !existing.has(id));
    if (prefix.length > 0) result[owner] = [...prefix, ...(result[owner] ?? [])];
  }
  return result;
}
