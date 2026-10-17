import { useSyncExternalStore } from "react";

/** Display-only preference: never part of the Run snapshot or the backend config. */
export const AUTO_EXPAND_COT_KEY = "grapher_auto_expand_cot_v1";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem" | "removeItem">;

function readableStorage(storage?: ReadableStorage): ReadableStorage | null {
  if (storage) return storage;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch { }
  return null;
}

function writableStorage(storage?: WritableStorage): WritableStorage | null {
  if (storage) return storage;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch { }
  return null;
}

/** Watching an execution must not unfold every reasoning block. Opt-in, default off. */
export function readAutoExpandCot(storage?: ReadableStorage): boolean {
  try {
    return readableStorage(storage)?.getItem(AUTO_EXPAND_COT_KEY) === "1";
  } catch {
    return false;
  }
}

let autoExpandCot = readAutoExpandCot();
const listeners = new Set<() => void>();

export function autoExpandCotEnabled(): boolean {
  return autoExpandCot;
}

export function setAutoExpandCot(enabled: boolean, storage?: WritableStorage): void {
  autoExpandCot = enabled;
  try {
    const store = writableStorage(storage);
    if (enabled) store?.setItem(AUTO_EXPAND_COT_KEY, "1");
    else store?.removeItem(AUTO_EXPAND_COT_KEY);
  } catch {
    // Storage may be blocked; the in-memory preference still applies this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-renders the mounted cards when the Settings toggle changes. */
export function useAutoExpandCot(): boolean {
  return useSyncExternalStore(subscribe, autoExpandCotEnabled, autoExpandCotEnabled);
}
