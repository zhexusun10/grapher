// Live topology preview for accepted Planner graph edits. Pi emits the raw
// tool arguments before the Planner extension normalizes them, so tolerate the
// same single-edit, batched and JSON-string shapes the backend accepts. Keep
// this in sync with `normalizeEdits` in `backend/resources/planner.ts`.

export interface PlannerNodeEdit {
  name: string;
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

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === 1 || value === 0) return value === 1;
  return undefined;
}

/** Apply the backend's tolerated-argument rules to one edit collection. */
function editItems(raw: unknown, key: "nodes" | "edges", required: readonly string[]): UnknownRecord[] {
  const parsed = parseJsonString(raw);
  // A model may send the whole arguments payload as a bare edit array.
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (!isRecord(parsed)) return [];
  const value = parseJsonString(parsed[key]);
  let items: unknown[] | undefined;
  if (Array.isArray(value)) items = value;
  else if (isRecord(value)) items = [value];
  // Models often omit the one-element batch wrapper, or send a bare edit next
  // to an empty batch. Treat the single edit as the intended payload.
  if (required.every(field => parsed[field] !== undefined && parsed[field] !== null) && (!items || items.length === 0)) {
    items = [parsed];
  }
  return (items ?? []).filter(isRecord);
}

export function plannerNodeEdits(raw: unknown): PlannerNodeEdit[] {
  const edits: PlannerNodeEdit[] = [];
  for (const item of editItems(raw, "nodes", ["name"])) {
    const name = asText(item.name);
    if (!name) continue;
    edits.push({ name, task: asText(item.task) ?? "", delete: asBoolean(item.delete) ?? false });
  }
  return edits;
}

export function plannerEdgeEdits(raw: unknown): PlannerEdgeEdit[] {
  const edits: PlannerEdgeEdit[] = [];
  for (const item of editItems(raw, "edges", ["from", "to"])) {
    const from = asText(item.from);
    const to = asText(item.to);
    if (!from || !to) continue;
    edits.push({ from, to, feedback: asBoolean(item.feedback) ?? false, delete: asBoolean(item.delete) ?? false });
  }
  return edits;
}
