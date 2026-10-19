import type { FileChangeItem, FileChangeStatus, FileChangeSummary } from "../types";

/**
 * File changes are projected by the backend, which compares real Git snapshots
 * (`before..after`, `base..publication.head`) and parses tool events only for
 * line counts. The browser never computes diffs or line counts itself.
 */
export const emptyFileChangeSummary: FileChangeSummary = {
  files: [],
  totalFiles: 0,
  addedCount: 0,
  modifiedCount: 0,
  deletedCount: 0,
  renamedCount: 0,
  totalAdditions: 0,
  totalDeletions: 0,
  isRunning: false,
};

export function buildSummaryFromFiles(
  files: FileChangeItem[],
  isRunning = false,
  activeFilePath?: string,
): FileChangeSummary {
  if (files.length === 0 && !isRunning && !activeFilePath) {
    return emptyFileChangeSummary;
  }
  let addedCount = 0;
  let modifiedCount = 0;
  let deletedCount = 0;
  let renamedCount = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const item of files) {
    if (item.status === "added") addedCount++;
    else if (item.status === "deleted") deletedCount++;
    else if (item.status === "renamed") renamedCount++;
    else modifiedCount++;
    totalAdditions += item.additions || 0;
    totalDeletions += item.deletions || 0;
  }
  return {
    files,
    totalFiles: files.length,
    addedCount,
    modifiedCount,
    deletedCount,
    renamedCount,
    totalAdditions,
    totalDeletions,
    isRunning,
    activeFilePath,
  };
}

function mergeFileItemInto(map: Map<string, FileChangeItem>, incoming: FileChangeItem): void {
  if (incoming.oldPath && incoming.status === "renamed") {
    map.delete(incoming.oldPath);
  }
  const existing = map.get(incoming.path);
  if (!existing) {
    map.set(incoming.path, {
      ...incoming,
      nodes: incoming.nodes ? [...incoming.nodes] : undefined,
      executionIds: incoming.executionIds ? [...incoming.executionIds] : undefined,
    });
    return;
  }

  let nextStatus: FileChangeStatus = existing.status;
  if (existing.status === "added" && incoming.status === "modified") {
    nextStatus = "added";
  } else if (existing.status === "added" && incoming.status === "deleted") {
    nextStatus = "deleted";
  } else if (existing.status === "deleted" && (incoming.status === "added" || incoming.status === "modified")) {
    nextStatus = "modified";
  } else if (incoming.status === "deleted") {
    nextStatus = "deleted";
  } else if (incoming.status === "renamed") {
    nextStatus = "renamed";
  }

  // Git summaries are authoritative: they replace tool-derived counts.
  let additions = existing.additions;
  let deletions = existing.deletions;
  let source = existing.source;
  if (incoming.source === "git") {
    additions = incoming.additions;
    deletions = incoming.deletions;
    source = "git";
  } else if (existing.source !== "git") {
    if (incoming.source === "write") {
      additions = incoming.additions;
      deletions = incoming.deletions;
    } else {
      additions += incoming.additions;
      deletions += incoming.deletions;
    }
    if (incoming.source) source = incoming.source;
  }

  const nodes = existing.nodes ? [...existing.nodes] : [];
  for (const node of incoming.nodes ?? []) {
    if (node && !nodes.includes(node)) nodes.push(node);
  }
  const executionIds = existing.executionIds ? [...existing.executionIds] : [];
  for (const id of incoming.executionIds ?? []) {
    if (id && !executionIds.includes(id)) executionIds.push(id);
  }

  map.set(incoming.path, {
    ...existing,
    status: nextStatus,
    oldPath: incoming.oldPath || existing.oldPath,
    additions,
    deletions,
    isRunning: Boolean(existing.isRunning || incoming.isRunning),
    nodes: nodes.length > 0 ? nodes : undefined,
    executionIds: executionIds.length > 0 ? executionIds : undefined,
    source,
  });
}

/** Merge backend summaries (per execution, then the run aggregate). */
export function mergeFileChangeSummaries(
  summaries: Array<FileChangeSummary | null | undefined>,
  isWorking = false,
): FileChangeSummary {
  const map = new Map<string, FileChangeItem>();
  let activeFilePath: string | undefined;
  let anyRunning = false;

  for (const summary of summaries) {
    if (!summary) continue;
    if (summary.isRunning) anyRunning = true;
    if (summary.activeFilePath) activeFilePath = summary.activeFilePath;
    for (const item of summary.files) {
      mergeFileItemInto(map, item);
    }
  }

  const files = Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
  if (!isWorking && !anyRunning) {
    for (const file of files) file.isRunning = false;
  }
  return buildSummaryFromFiles(
    files,
    Boolean(anyRunning || (isWorking && activeFilePath)),
    isWorking || anyRunning ? activeFilePath : undefined,
  );
}

/** Split a normalized path into `{ fileName, dirPath }` for compact UI display. */
export function splitFilePath(path: string): { fileName: string; dirPath: string } {
  const index = path.lastIndexOf("/");
  if (index < 0) return { fileName: path, dirPath: "" };
  return { fileName: path.slice(index + 1), dirPath: path.slice(0, index) };
}

/** Filter backend-reported files by status, path query and owning node. */
export function filterFileChanges(
  files: FileChangeItem[],
  statusFilter: "all" | FileChangeStatus,
  searchQuery = "",
  nodeFilter = "",
): FileChangeItem[] {
  const query = searchQuery.trim().toLowerCase();
  return files.filter((item) => {
    if (statusFilter !== "all" && item.status !== statusFilter) return false;
    if (nodeFilter && (!item.nodes || !item.nodes.includes(nodeFilter))) return false;
    if (query && !item.path.toLowerCase().includes(query) && !item.oldPath?.toLowerCase().includes(query)) {
      return false;
    }
    return true;
  });
}
