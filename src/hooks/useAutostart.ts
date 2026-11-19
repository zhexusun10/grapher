import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AutostartController,
  type AutostartDriver,
  type AutostartSnapshot,
} from "../services/autostart";

export interface UseAutostartOptions {
  /** Optional pre-built controller (primarily for tests). */
  controller?: AutostartController;
  /** Optional custom driver used when creating an owned controller. */
  driver?: AutostartDriver;
  /** Whether the hosting UI (e.g. Settings modal) is currently open/active. */
  active?: boolean;
}

export interface UseAutostartResult {
  snapshot: AutostartSnapshot;
  refresh: () => Promise<AutostartSnapshot>;
  setEnabled: (enabled: boolean) => Promise<AutostartSnapshot>;
  enable: () => Promise<AutostartSnapshot>;
  disable: () => Promise<AutostartSnapshot>;
}

/**
 * Reads the real OS launch-at-login registration on mount (and whenever
 * `active` becomes true), exposes loading/updating/error state, and applies
 * idempotent enable/disable mutations without using localStorage.
 */
export function useAutostart(options: UseAutostartOptions = {}): UseAutostartResult {
  const { controller: externalController, driver, active = true } = options;
  const [ownedController] = useState<AutostartController | null>(() =>
    externalController ? null : new AutostartController(driver),
  );
  const controller = externalController ?? ownedController!;
  const activeRef = useRef(active);
  activeRef.current = active;

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    if (!active || !controller.getSnapshot().supported) {
      return;
    }
    void controller.refresh();
    return () => {
      controller.cancelPending();
    };
  }, [active, controller]);

  const refresh = useCallback(() => {
    if (!activeRef.current) {
      return Promise.resolve(controller.getSnapshot());
    }
    return controller.refresh();
  }, [controller]);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!activeRef.current) {
        return Promise.resolve(controller.getSnapshot());
      }
      return controller.setEnabled(enabled);
    },
    [controller],
  );

  const enable = useCallback(() => setEnabled(true), [setEnabled]);
  const disable = useCallback(() => setEnabled(false), [setEnabled]);

  return {
    snapshot,
    refresh,
    setEnabled,
    enable,
    disable,
  };
}
