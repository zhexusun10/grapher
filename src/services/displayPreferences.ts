import { useSyncExternalStore } from "react";

/** Display-only preference: never part of the Run snapshot or the backend config. */
export const AUTO_EXPAND_COT_KEY = "grapher_auto_expand_cot_v1";
export const LANDING_BACKGROUND_KEY = "grapher_landing_background_v1";
export type LandingBackground = "paths" | "dots";

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

/** Watching an execution auto-expands reasoning blocks by default. Opt-out via stored preference. */
export function readAutoExpandCot(storage?: ReadableStorage): boolean {
  try {
    const store = readableStorage(storage);
    if (!store) return true;
    const value = store.getItem(AUTO_EXPAND_COT_KEY);
    if (value === null) return true;
    return value !== "0" && value !== "false";
  } catch {
    return true;
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
    else store?.setItem(AUTO_EXPAND_COT_KEY, "0");
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

/** The static dot pattern is the default for new or invalid preferences. */
export function readLandingBackground(storage?: ReadableStorage): LandingBackground {
  try {
    return readableStorage(storage)?.getItem(LANDING_BACKGROUND_KEY) === "paths" ? "paths" : "dots";
  } catch {
    return "dots";
  }
}

let landingBackground = readLandingBackground();
const backgroundListeners = new Set<() => void>();

export function currentLandingBackground(): LandingBackground {
  return landingBackground;
}

export function setLandingBackground(background: LandingBackground, storage?: WritableStorage): void {
  landingBackground = background;
  try {
    writableStorage(storage)?.setItem(LANDING_BACKGROUND_KEY, background);
  } catch {
    // Keep the choice for this session even if browser storage is blocked.
  }
  for (const listener of backgroundListeners) listener();
}

function subscribeToBackground(listener: () => void): () => void {
  backgroundListeners.add(listener);
  return () => { backgroundListeners.delete(listener); };
}

export function useLandingBackground(): LandingBackground {
  return useSyncExternalStore(subscribeToBackground, currentLandingBackground, currentLandingBackground);
}
