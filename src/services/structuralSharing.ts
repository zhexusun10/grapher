/** Share equal JSON subtrees without dropping optional fields or backend metadata.
 * Equal subtrees allocate nothing; only changed containers are copied.
 */
export function shareJson<T>(previous: T, incoming: T): T {
  if (Object.is(previous, incoming)) return previous;
  if (!previous || !incoming || typeof previous !== "object" || typeof incoming !== "object") return incoming;
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    let shared = previous.length === incoming.length ? previous : incoming.slice();
    for (let index = 0; index < incoming.length; index++) {
      const value = shareJson(previous[index], incoming[index]);
      if (shared === previous && !Object.is(value, previous[index])) shared = previous.slice();
      if (shared !== previous) shared[index] = value;
    }
    return shared as T;
  }
  if (Array.isArray(previous) || Array.isArray(incoming)) return incoming;
  const before = previous as Record<string, unknown>;
  const next = incoming as Record<string, unknown>;
  const keys = Object.keys(next);
  let shared = Object.keys(before).length === keys.length ? before : { ...next };
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const present = Object.hasOwn(before, key);
    const value = present ? shareJson(before[key], next[key]) : next[key];
    if (shared === before && (!present || !Object.is(value, before[key]))) {
      shared = { ...next };
      // Earlier fields were equal, so reuse their already-validated references.
      for (let i = 0; i < index; i++) shared[keys[i]] = before[keys[i]];
    }
    if (shared !== before) shared[key] = value;
  }
  return shared as T;
}

/** Graph element IDs survive insertion/reordering; unchanged cards keep their data identity. */
export function shareById<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  const byId = new Map(previous.map(item => [item.id, item]));
  const shared = incoming.map(item => {
    const before = byId.get(item.id);
    return before ? shareJson(before, item) : item;
  });
  return shared.length === previous.length && shared.every((item, index) => item === previous[index]) ? previous : shared;
}
