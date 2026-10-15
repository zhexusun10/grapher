import { workspaceKey } from "./workspaceConversations";

export const LANDING_GOAL_STORAGE_KEY = "grapher_landing_goal_drafts";
export const LEGACY_LANDING_GOAL_STORAGE_KEY = "grapher_landing_goal_draft";

export function landingDraftKey(repository?: string): string {
  return repository ? workspaceKey(repository) : "__unbound__";
}

function getStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch { }
  return null;
}

export function loadLandingDraft(repository?: string, storage?: Storage): string {
  const store = getStorage(storage);
  if (!store) return "";
  try {
    const raw = store.getItem(LANDING_GOAL_STORAGE_KEY);
    if (raw) {
      const drafts = JSON.parse(raw) as Record<string, string>;
      const key = landingDraftKey(repository);
      if (typeof drafts[key] === "string" && drafts[key].trim()) {
        return drafts[key];
      }
      // If the active workspace has no draft yet, but an unbound draft was saved
      // (e.g. typed on the landing page before selecting/opening a project), inherit it.
      if (repository && typeof drafts["__unbound__"] === "string" && drafts["__unbound__"].trim()) {
        return drafts["__unbound__"];
      }
      return "";
    }
    const legacy = store.getItem(LEGACY_LANDING_GOAL_STORAGE_KEY);
    if (legacy && legacy.trim()) return legacy;
  } catch { }
  return "";
}

export function saveLandingDraft(repository: string | undefined, text: string, storage?: Storage): void {
  const store = getStorage(storage);
  if (!store) return;
  try {
    const raw = store.getItem(LANDING_GOAL_STORAGE_KEY);
    const drafts = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    const key = landingDraftKey(repository);
    if (text.trim()) {
      drafts[key] = text;
      // If saving for a concrete repository, clear inherited unbound draft so it doesn't leak.
      if (repository && drafts["__unbound__"] === text) {
        delete drafts["__unbound__"];
      }
      store.setItem(LANDING_GOAL_STORAGE_KEY, JSON.stringify(drafts));
      store.setItem(LEGACY_LANDING_GOAL_STORAGE_KEY, text);
    } else {
      delete drafts[key];
      if (!repository) delete drafts["__unbound__"];
      const remainingKeys = Object.keys(drafts);
      if (remainingKeys.length === 0) {
        store.removeItem(LANDING_GOAL_STORAGE_KEY);
        store.removeItem(LEGACY_LANDING_GOAL_STORAGE_KEY);
      } else {
        store.setItem(LANDING_GOAL_STORAGE_KEY, JSON.stringify(drafts));
        const firstRemaining = drafts[remainingKeys[0]];
        if (firstRemaining) {
          store.setItem(LEGACY_LANDING_GOAL_STORAGE_KEY, firstRemaining);
        } else {
          store.removeItem(LEGACY_LANDING_GOAL_STORAGE_KEY);
        }
      }
    }
  } catch { }
}

export function clearLandingDraft(repository?: string, storage?: Storage): void {
  const store = getStorage(storage);
  if (!store) return;
  try {
    const raw = store.getItem(LANDING_GOAL_STORAGE_KEY);
    const drafts = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    const key = landingDraftKey(repository);
    delete drafts[key];
    delete drafts["__unbound__"];
    const remainingKeys = Object.keys(drafts);
    if (remainingKeys.length === 0) {
      store.removeItem(LANDING_GOAL_STORAGE_KEY);
      store.removeItem(LEGACY_LANDING_GOAL_STORAGE_KEY);
    } else {
      store.setItem(LANDING_GOAL_STORAGE_KEY, JSON.stringify(drafts));
      const firstRemaining = drafts[remainingKeys[0]];
      if (firstRemaining) {
        store.setItem(LEGACY_LANDING_GOAL_STORAGE_KEY, firstRemaining);
      } else {
        store.removeItem(LEGACY_LANDING_GOAL_STORAGE_KEY);
      }
    }
  } catch { }
}
