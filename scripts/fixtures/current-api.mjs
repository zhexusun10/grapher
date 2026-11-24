// Current wire data for synthetic browser fixtures. The fixture owns these
// snapshots; no persisted Run or backend fallback is imported here.
export function fixtureSummaries(snapshots) {
  return snapshots.filter(snapshot => snapshot?.runId).map(snapshot => ({
    runId: snapshot.runId,
    repository: snapshot.config.repository,
    title: snapshot.title || snapshot.graph.originalGoal,
    planType: snapshot.planType,
    phase: snapshot.phase,
    hasActiveExecutions: snapshot.planning?.status === 'running' || snapshot.planningProcess?.running === true ||
      [...(snapshot.executions ?? []), ...(snapshot.mergers ?? [])]
        .some(execution => execution.status === 'running'),
  }));
}

export function fixtureExecutionPage(body, snapshots) {
  const snapshot = snapshots.find(value => value.runId === body.runId);
  const execution = [...(snapshot?.executions ?? []), ...(snapshot?.mergers ?? [])]
    .find(value => value.id === body.executionId);
  if (!execution) throw new Error(`Unknown fixture execution: ${body.executionId}`);
  const bytes = Buffer.from(execution.output ?? '');
  const limit = body.limit ?? 256 * 1024;
  const upper = Math.min(bytes.length, body.before ?? bytes.length);
  let start = Math.min(upper, Math.max(0, body.before !== undefined || body.tail ? upper - limit : body.offset ?? 0));
  let end = Math.min(upper, start + limit);
  while (start < end && (bytes[start] & 0xc0) === 0x80) start++;
  while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
  return { runId: body.runId, executionId: execution.id, content: bytes.subarray(start, end).toString(),
    startOffset: start, nextOffset: end, totalBytes: bytes.length, complete: end === bytes.length,
    status: execution.status };
}

export function fixtureFileChanges(body, summary) {
  return { runId: body?.runId, executionId: body?.executionId ?? null, executionIds: body?.executionIds ?? null,
    summary: summary ?? fixtureFileChangeSummary([]) };
}

// Synthetic complete row sets only. Production counters and scoped aggregates
// come from the backend; fixtures must not resurrect browser-side merging.
export function fixtureFileChangeSummary(files, isRunning = false, activeFilePath) {
  return {
    files, totalFiles: files.length,
    addedCount: files.filter(file => file.status === 'added').length,
    modifiedCount: files.filter(file => file.status === 'modified').length,
    deletedCount: files.filter(file => file.status === 'deleted').length,
    renamedCount: files.filter(file => file.status === 'renamed').length,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
    isRunning, ...(activeFilePath ? { activeFilePath } : {}),
  };
}
