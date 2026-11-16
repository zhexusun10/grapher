// Live topology preview for accepted edit_graph batches. Match Pi's argument
// preparation and primitive coercions without accepting retired tool shapes.

export interface PlannerNodeEdit {
  id: string;
  task: string;
  delete: boolean;
}

export interface PlannerEdgeEdit {
  from: string;
  to: string;
  feedback: boolean;
  delete: boolean;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

// Pi coerces required null string fields to the literal "null"; optional
// null task fields are omitted instead. This is display projection, not validation.
function asId(value: unknown): string | undefined {
  return value === null ? "null" : asText(value);
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true" || value === "1") return true;
    if (lower === "false" || value === "0") return false;
  }
  if (value === 1 || value === 0) return value === 1;
  return undefined;
}

export interface PlannerGraphResult {
  toolName: string;
  args: unknown;
  isError: boolean;
}

/**
 * Graph writes share Pi's mutation queue, but result hooks may finish out of
 * order. Buffer only graph previews; transcript cards can still update as soon
 * as each result arrives. One instance belongs to one foreground SSE request.
 */
export class PlannerGraphEditQueue {
  private pending = new Map<string, PlannerGraphResult | undefined>();
  private completed = new Set<string>();

  start(id?: string): void {
    if (id && !this.pending.has(id) && !this.completed.has(id)) this.pending.set(id, undefined);
  }

  finish(id: string | undefined, result: PlannerGraphResult): PlannerGraphResult[] {
    // Historical/tail events may not have a start or a reliable call identity.
    if (!id) return [result];
    if (this.completed.has(id)) return [];
    this.pending.set(id, result);
    const ready: PlannerGraphResult[] = [];
    for (const [key, next] of this.pending) {
      if (next === undefined) break;
      this.pending.delete(key);
      this.completed.add(key);
      ready.push(next);
    }
    return ready;
  }

  clear(): void {
    this.pending.clear();
    this.completed.clear();
  }
}

/** Read an edit_graph collection using the tool's argument preparation. */
function editItems(raw: unknown, key: "nodes" | "edges"): UnknownRecord[] {
  const parsed = parseJsonString(raw);
  if (!isRecord(parsed)) return [];
  const value = parseJsonString(parsed[key]);
  return (Array.isArray(value) ? value : isRecord(value) ? [value] : []).filter(isRecord);
}

export function plannerNodeEdits(raw: unknown): PlannerNodeEdit[] {
  const edits: PlannerNodeEdit[] = [];
  for (const item of editItems(raw, "nodes")) {
    if (!Object.hasOwn(item, "id")) continue;
    const id = asId(item.id);
    if (!id) continue;
    edits.push({ id, task: asText(item.task) ?? "", delete: asBoolean(item.delete) ?? false });
  }
  return edits;
}

export function plannerEdgeEdits(raw: unknown): PlannerEdgeEdit[] {
  const edits: PlannerEdgeEdit[] = [];
  for (const item of editItems(raw, "edges")) {
    const from = asId(item.from);
    const to = asId(item.to);
    if (!from || !to) continue;
    edits.push({ from, to, feedback: asBoolean(item.feedback) ?? false, delete: asBoolean(item.delete) ?? false });
  }
  return edits;
}
