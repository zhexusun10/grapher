import type { Snapshot } from '../types';
import type { SnapshotDelta } from './apiContract.generated';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const statuses = new Set(['waiting', 'running', 'completed', 'failed', 'blocked', 'dirty', 'paused']);

/** Validate the fields that drive identity, graph rendering and ordering before publishing state. */
export function validateSnapshot(value: unknown): Snapshot {
  if (!record(value) || typeof value.runId !== 'string' || !record(value.graph) ||
      !Array.isArray(value.graph.nodes) || !Array.isArray(value.graph.edges) ||
      !record(value.nodes) || !Array.isArray(value.executions) || !Array.isArray(value.events) ||
      typeof value.phase !== 'string') throw new Error('Invalid browser snapshot');
  if (value.graph.nodes.some(node => !record(node) || typeof node.id !== 'string' || typeof node.task !== 'string') ||
      value.graph.edges.some(edge => !record(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string')) {
    throw new Error('Invalid snapshot graph');
  }
  for (const node of Object.values(value.nodes)) {
    if (!record(node) || !statuses.has(String(node.status))) throw new Error('Unsupported node status');
  }
  let sequence = 0;
  for (const event of value.events) {
    if (!record(event) || typeof event.type !== 'string' || !Number.isSafeInteger(event.sequence) || Number(event.sequence) <= sequence) {
      throw new Error('Invalid snapshot event sequence');
    }
    sequence = Number(event.sequence);
  }
  return value as unknown as Snapshot;
}

export function applySnapshotDelta(base: Snapshot, baseVersion: string, version: string, delta: SnapshotDelta): Snapshot {
  if (!record(delta) || delta.baseVersion !== baseVersion || delta.version !== version ||
      !record(delta.set) || !Array.isArray(delta.removed) || delta.removed.some(key => typeof key !== 'string') ||
      !Array.isArray(delta.events) || !Number.isSafeInteger(delta.afterSequence) ||
      delta.afterSequence !== (base.events.at(-1)?.sequence ?? 0) ||
      Object.hasOwn(delta.set, 'events') || Object.hasOwn(delta.set, 'runId') ||
      delta.removed.includes('events') || delta.removed.includes('runId')) {
    throw new Error('Invalid snapshot delta base or payload');
  }
  // Object spread defines own data properties, including a literal __proto__ key.
  const next = { ...base, ...delta.set } as unknown as Record<string, unknown>;
  for (const key of delta.removed) delete next[key];
  next.events = [...base.events, ...delta.events];
  return validateSnapshot(next);
}
