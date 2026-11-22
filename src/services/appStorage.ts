import type { Config, PlanMode, ProjectItem, RoleModelConfig, ThinkingLevel } from "../types";
import { normalizeWorkspacePath } from "./workspaceConversations";

export const STORAGE_KEYS = {
  projects: "grapher_projects",
  lastWorkspace: "grapher_last_workspace",
  workspaceRuns: "grapher_workspace_runs",
  archivedRuns: "grapher_archived_runs",
  runLabels: "grapher_run_labels",
  runModes: "grapher_run_modes",
  config: "grapher_config",
  dataPath: "grapher_data_path",
  planMode: "grapher_plan_mode",
} as const;

type StoredJson = {
  grapher_projects: ProjectItem[];
  grapher_workspace_runs: Record<string, string[]>;
  grapher_archived_runs: string[];
  grapher_run_labels: Record<string, string>;
  grapher_run_modes: Record<string, PlanMode>;
  grapher_config: Partial<Config>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const isThinkingLevel = (value: unknown): value is ThinkingLevel => typeof value === "string" && thinkingLevels.has(value);

function projects(value: unknown): ProjectItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.flatMap(item => {
    if (!record(item) || typeof item.path !== "string" || !item.path.trim()) return [];
    const path = normalizeWorkspacePath(item.path);
    return [{
      id: typeof item.id === "string" && item.id ? normalizeWorkspacePath(item.id) : path, path,
      name: typeof item.name === "string" && item.name ? item.name : path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path,
      branch: typeof item.branch === "string" ? item.branch : "",
      clean: item.clean === true,
      ...(typeof item.isShadow === "boolean" ? { isShadow: item.isShadow } : {}),
      ...(item.archived === true ? { archived: true } : {}),
      lastOpened: typeof item.lastOpened === "number" && Number.isFinite(item.lastOpened) ? item.lastOpened : 0,
    }];
  });
  // An explicitly empty list means the user removed all workspaces; a corrupt
  // nonempty list must still allow bootstrap to recover the backend binding.
  return value.length && !items.length ? null : items;
}

function config(value: unknown): Partial<Config> | null {
  if (!record(value)) return null;
  const result: Partial<Config> = {};
  for (const key of ["repository", "model"] as const) if (typeof value[key] === "string") result[key] = value[key];
  if (isThinkingLevel(value.thinkingLevel)) result.thinkingLevel = value.thinkingLevel;
  for (const key of ["maxParallel", "maxFeedback"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = value[key];
  }
  for (const key of ["autoApprove", "postTaskReview", "plannerWriteTools", "isolateParallelNodes", "feedbackEnabled"] as const) {
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  if (record(value.roleModels)) {
    const roles: NonNullable<Config["roleModels"]> = {};
    for (const role of ["partitioner", "planner", "nodeAgent"] as const) {
      const model = value.roleModels[role];
      if (!record(model) || typeof model.model !== "string") continue;
      const settings: RoleModelConfig = { model: model.model };
      if (isThinkingLevel(model.thinkingLevel)) settings.thinkingLevel = model.thinkingLevel;
      roles[role] = settings;
    }
    result.roleModels = roles;
  }
  return result;
}

const decoders: { [K in keyof StoredJson]: (value: unknown) => StoredJson[K] | null } = {
  grapher_projects: projects,
  grapher_config: config,
  grapher_workspace_runs: value => record(value) ? Object.fromEntries(Object.entries(value)
    .filter(([, ids]) => Array.isArray(ids))
    .map(([path, ids]) => [path, (ids as unknown[]).filter((id): id is string => typeof id === "string")])) : null,
  grapher_archived_runs: value => Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && !id.startsWith("pending-")))]
    : null,
  grapher_run_labels: value => record(value) ? Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")) : null,
  grapher_run_modes: value => record(value) ? Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, PlanMode] => ["auto", "serial", "graph"].includes(entry[1] as string))) : null,
};

export function readStorageString(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function storageJsonKey(key: string): string {
  if ([STORAGE_KEYS.workspaceRuns, STORAGE_KEYS.archivedRuns, STORAGE_KEYS.runLabels, STORAGE_KEYS.runModes, STORAGE_KEYS.config].includes(key as any)) {
    return `grapher-format-1:${readStorageString(STORAGE_KEYS.dataPath) ?? ""}:${key}`;
  }
  return key;
}

/** Persisted browser hints can outlive schemas or be partially corrupt. Never
 * treat a successful JSON parse as proof that a value is safe for rendering. */
export function readStorageJson<K extends keyof StoredJson>(key: K): StoredJson[K] | null {
  const raw = readStorageString(storageJsonKey(key));
  if (raw === null) return null;
  try { return decoders[key](JSON.parse(raw)); } catch { return null; }
}

export function writeStorageString(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch {}
}

export function writeStorageJson(key: string, value: unknown): void {
  try { localStorage.setItem(storageJsonKey(key), JSON.stringify(value)); } catch {}
}
