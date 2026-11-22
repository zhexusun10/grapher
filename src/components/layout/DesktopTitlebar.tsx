import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { isMacosTauriDesktop, isWindowsTauriDesktop } from "../../services/apiBase";

export type DesktopTitlebarPlatform = "macos" | "windows" | null;

export const DESKTOP_TITLEBAR_HEIGHT_PX = 32;

export interface DesktopTitlebarState {
  platform: DesktopTitlebarPlatform;
  visible: boolean;
  isFullscreen: boolean;
  isMaximized: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export function useDesktopTitlebar(): DesktopTitlebarState {
  const platform: DesktopTitlebarPlatform = isMacosTauriDesktop()
    ? "macos"
    : isWindowsTauriDesktop()
      ? "windows"
      : null;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const syncSeqRef = useRef(0);

  const visible = platform !== null && !isFullscreen;

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.style.setProperty(
      "--desktop-titlebar-inset",
      visible ? `${DESKTOP_TITLEBAR_HEIGHT_PX}px` : "0px",
    );
    return () => {
      root.style.setProperty("--desktop-titlebar-inset", "0px");
    };
  }, [visible]);

  useEffect(() => {
    if (platform !== "windows") return;
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Windows starts hidden and borderless. Reveal only after React has
    // committed the shell and titlebar inset, independently of backend readiness.
    // Do not wait for animation frames: hidden WebView2 windows can throttle them.
    const reveal = async (attempt = 0) => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (active) await getCurrentWindow().show();
      } catch (error) {
        if (!active) return;
        if (attempt < 2) {
          retryTimer = setTimeout(() => { void reveal(attempt + 1); }, attempt === 0 ? 150 : 500);
        } else {
          // The native startup watchdog can still reveal a failed renderer.
          console.error("Failed to show the Grapher window", error);
        }
      }
    };
    void reveal();
    return () => {
      active = false;
      clearTimeout(retryTimer);
    };
  }, [platform]);

  const syncWindowState = useCallback(async () => {
    if (!platform) return;
    const seq = ++syncSeqRef.current;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const current = getCurrentWindow();
      const fullscreen = await current.isFullscreen().catch(() => false);
      if (seq !== syncSeqRef.current) return;
      setIsFullscreen(Boolean(fullscreen));
      if (platform === "windows") {
        const maximized = await current.isMaximized().catch(() => false);
        if (seq !== syncSeqRef.current) return;
        setIsMaximized(Boolean(maximized));
      }
    } catch {
      // Ignore in non-Tauri or partially mocked environments.
    }
  }, [platform]);

  useEffect(() => {
    if (!platform) return;
    let active = true;
    let unlistenResize: (() => void) | null = null;
    const followUpTimers = new Set<ReturnType<typeof setTimeout>>();

    const clearFollowUps = () => {
      for (const timer of followUpTimers) clearTimeout(timer);
      followUpTimers.clear();
    };

    const runSync = () => {
      if (!active) return;
      void syncWindowState();
    };

    // On macOS, `window.resize` fires during the native Space transition while
    // `NSWindowStyleMaskFullScreen` is still set; AppKit clears the flag only
    // after `windowDidExitFullScreen:` completes without always emitting
    // another resize. Re-check after the animation settles so the titlebar
    // never stays stuck hidden when leaving fullscreen.
    const scheduleSync = () => {
      if (!active) return;
      runSync();
      clearFollowUps();
      for (const delay of [150, 450, 950]) {
        const timer = setTimeout(() => {
          followUpTimers.delete(timer);
          runSync();
        }, delay);
        followUpTimers.add(timer);
      }
    };

    runSync();
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("focus", scheduleSync);
    document.addEventListener("fullscreenchange", scheduleSync);
    document.addEventListener("visibilitychange", scheduleSync);

    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const unlisten = await getCurrentWindow().onResized(scheduleSync);
        if (!active) unlisten();
        else unlistenResize = unlisten;
      } catch {
        // Native resize listener is optional; DOM resize/focus remain active.
      }
    })();

    return () => {
      active = false;
      clearFollowUps();
      unlistenResize?.();
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("focus", scheduleSync);
      document.removeEventListener("fullscreenchange", scheduleSync);
      document.removeEventListener("visibilitychange", scheduleSync);
    };
  }, [platform, syncWindowState]);

  const onMinimize = useCallback(() => {
    if (platform !== "windows") return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().minimize();
      } catch {
        // Ignore if window IPC is unavailable.
      }
    })();
  }, [platform]);

  const onToggleMaximize = useCallback(() => {
    if (platform !== "windows") return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const current = getCurrentWindow();
        await current.toggleMaximize();
        const maximized = await current.isMaximized().catch(() => !isMaximized);
        setIsMaximized(Boolean(maximized));
      } catch {
        // Ignore if window IPC is unavailable.
      }
    })();
  }, [platform, isMaximized]);

  const onClose = useCallback(() => {
    if (platform !== "windows") return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      } catch {
        // Ignore if window IPC is unavailable.
      }
    })();
  }, [platform]);

  return {
    platform,
    visible,
    isFullscreen,
    isMaximized,
    onMinimize,
    onToggleMaximize,
    onClose,
  };
}

interface DesktopTitlebarProps {
  platform: Exclude<DesktopTitlebarPlatform, null>;
  isMaximized: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export function DesktopTitlebar({
  platform,
  isMaximized,
  onMinimize,
  onToggleMaximize,
  onClose,
}: DesktopTitlebarProps) {
  return (
    <div
      className={`desktop-titlebar is-${platform}`}
      data-platform={platform}
    >
      <div
        className={`desktop-titlebar-drag-region${platform === "macos" ? " macos-titlebar-drag-region" : ""}`}
        data-tauri-drag-region
        aria-hidden="true"
      />
      {platform === "windows" && (
        <div className="desktop-window-controls" role="group">
          <button
            type="button"
            className="desktop-window-control"
            data-window-action="minimize"
            aria-label={t("最小化")}
            title={t("最小化")}
            onClick={onMinimize}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1 5h8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="desktop-window-control"
            data-window-action="toggle-maximize"
            aria-label={isMaximized ? t("还原") : t("最大化")}
            title={isMaximized ? t("还原") : t("最大化")}
            onClick={onToggleMaximize}
          >
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path d="M3 1.5h5.5V7" stroke="currentColor" strokeWidth="1" />
                <rect x="1.5" y="3" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="desktop-window-control is-close"
            data-window-action="close"
            aria-label={t("关闭窗口")}
            title={t("关闭窗口")}
            onClick={onClose}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
