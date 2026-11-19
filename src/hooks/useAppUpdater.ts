import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  getAppUpdater,
  type AppUpdaterController,
  type UpdaterSnapshot,
} from "../services/updater";

export interface UseAppUpdaterOptions {
  controller?: AppUpdaterController;
  /** When true, schedules a single non-blocking silent startup check after mount. */
  scheduleStartupCheck?: boolean;
  startupDelayMs?: number;
}

export interface UseAppUpdaterResult {
  snapshot: UpdaterSnapshot;
  checkForUpdates: (options?: { silent?: boolean }) => Promise<UpdaterSnapshot>;
  installAndRestart: () => Promise<UpdaterSnapshot>;
  cancelDownload: () => void;
  retry: () => Promise<UpdaterSnapshot>;
  restartApp: () => Promise<UpdaterSnapshot>;
  dismissBanner: () => void;
}

export function useAppUpdater(options: UseAppUpdaterOptions = {}): UseAppUpdaterResult {
  const controller = options.controller ?? getAppUpdater();
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const shouldScheduleStartup = Boolean(options.scheduleStartupCheck);
  const startupDelayMs = options.startupDelayMs ?? 1500;

  useEffect(() => {
    if (!controller.getSnapshot().supported) return;
    void controller.hydrateCurrentVersion();
    if (!shouldScheduleStartup) return;
    return controller.scheduleStartupCheck(startupDelayMs);
  }, [controller, shouldScheduleStartup, startupDelayMs]);

  const checkForUpdates = useCallback(
    (checkOptions?: { silent?: boolean }) => controller.checkForUpdates(checkOptions),
    [controller],
  );
  const installAndRestart = useCallback(
    () => controller.installAndRestart(),
    [controller],
  );
  const cancelDownload = useCallback(() => {
    controller.cancelDownload();
  }, [controller]);
  const retry = useCallback(() => controller.retry(), [controller]);
  const restartApp = useCallback(() => controller.restartApp(), [controller]);
  const dismissBanner = useCallback(() => {
    controller.dismissBanner();
  }, [controller]);

  return {
    snapshot,
    checkForUpdates,
    installAndRestart,
    cancelDownload,
    retry,
    restartApp,
    dismissBanner,
  };
}
