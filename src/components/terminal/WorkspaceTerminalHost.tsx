import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { RotateCw, TerminalSquare } from "lucide-react";
import { Terminal } from "../ui/terminal";
import { t } from "../../i18n";
import type { WorkspaceTerminalEntry } from "../../hooks/useWorkspaceTerminals";
import "./workspace-terminal.css";

const LazyXtermSurface = lazy(() => import("./XtermSurface"));

const TERMINAL_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const OPEN_DURATION_MS = 240;
const CLOSE_DOCKED_DURATION_MS = 240;
const CLOSE_MAXIMIZED_DURATION_MS = 200;
const RESIZE_MODE_DURATION_MS = 240;

interface WorkspaceTerminalHostProps {
  entries: WorkspaceTerminalEntry[];
  activeWorkspaceKey: string;
  onMinimize: (key: string) => void;
  onToggleMaximize: (key: string) => void;
  onClose: (key: string) => void;
  onFinishClose: (key: string, instanceId: number) => void;
  onRestart: (key: string) => void;
  onSetHeight: (key: string, height: number) => void;
  onWriteInput: (key: string, data: string) => void;
  onResize: (key: string, cols: number, rows: number) => void;
  attachOutputListener: (instanceId: number, listener: (chunk: Uint8Array) => void) => () => void;
}

interface WorkspaceTerminalItemProps {
  entry: WorkspaceTerminalEntry;
  isActiveWorkspace: boolean;
  isResizing: boolean;
  onStartVerticalResize: (key: string, initialHeight: number, event: React.PointerEvent<HTMLDivElement>) => void;
  onMinimize: (key: string) => void;
  onToggleMaximize: (key: string) => void;
  onClose: (key: string) => void;
  onFinishClose: (key: string, instanceId: number) => void;
  onRestart: (key: string) => void;
  onWriteInput: (key: string, data: string) => void;
  onResize: (key: string, cols: number, rows: number) => void;
  attachOutputListener: (instanceId: number, listener: (chunk: Uint8Array) => void) => () => void;
}

function workspaceDisplayName(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/, "");
  if (!normalized) return t("终端");
  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] || normalized;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const WorkspaceTerminalItem: React.FC<WorkspaceTerminalItemProps> = React.memo(
  ({
    entry,
    isActiveWorkspace,
    isResizing,
    onStartVerticalResize,
    onMinimize,
    onToggleMaximize,
    onClose,
    onFinishClose,
    onRestart,
    onWriteInput,
    onResize,
    attachOutputListener,
  }) => {
    const dockRef = useRef<HTMLElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    const dockAnimRef = useRef<Animation | null>(null);
    const cardAnimRef = useRef<Animation | null>(null);
    const lastCardHeightRef = useRef<number>(Math.max(150, entry.height - 10));
    const lastDockHeightRef = useRef<number>(entry.height);
    const prevStateRef = useRef<{
      isActiveWorkspace: boolean;
      mode: WorkspaceTerminalEntry["mode"];
      closing: boolean;
    } | null>(null);

    const lastVisibleModeRef = useRef<"open" | "maximized">("open");
    const [minimizeComplete, setMinimizeComplete] = useState(entry.mode === "minimized");
    const [animating, setAnimating] = useState(false);
    const [focusNonce, setFocusNonce] = useState(0);

    const cancelActiveAnimations = useCallback(() => {
      const animations = [dockAnimRef.current, cardAnimRef.current];
      dockAnimRef.current = null;
      cardAnimRef.current = null;
      for (const animation of animations) {
        if (!animation) continue;
        // A queued cancellation event must not clean up a newer transition.
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
      }
      if (dockRef.current) {
        dockRef.current.classList.remove("is-restoring-from-max");
        dockRef.current.style.overflow = "";
      }
      if (cardRef.current) cardRef.current.style.flex = "";
    }, []);

    const captureCurrentDimensions = useCallback(() => {
      const cardRect = cardRef.current?.getBoundingClientRect();
      if (cardRect && cardRect.height > 20) lastCardHeightRef.current = cardRect.height;
      const dockRect = dockRef.current?.getBoundingClientRect();
      if (dockRect && dockRect.height > 20) lastDockHeightRef.current = dockRect.height;
    }, []);

    useEffect(() => {
      const cardEl = cardRef.current;
      if (!cardEl || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => {
        if (!dockAnimRef.current && !cardAnimRef.current) captureCurrentDimensions();
      });
      observer.observe(cardEl);
      return () => observer.disconnect();
    }, [captureCurrentDimensions]);

    useLayoutEffect(() => {
      if (!isResizing) return;
      cancelActiveAnimations();
      setAnimating(false);
    }, [isResizing, cancelActiveAnimations]);

    useEffect(() => cancelActiveAnimations, [cancelActiveAnimations]);

    useLayoutEffect(() => {
      const prev = prevStateRef.current;
      prevStateRef.current = { isActiveWorkspace, mode: entry.mode, closing: entry.closing };
      if (entry.mode !== "minimized") lastVisibleModeRef.current = entry.mode;
      const dockEl = dockRef.current;
      const cardEl = cardRef.current;
      // Read the in-flight presentation before cancelling it. Reversing a
      // transition must start where the window is now, not at its old endpoint.
      const fromCardHeight = cardAnimRef.current && cardEl
        ? cardEl.getBoundingClientRect().height : lastCardHeightRef.current;
      const fromDockHeight = dockAnimRef.current && dockEl
        ? dockEl.getBoundingClientRect().height : lastDockHeightRef.current;
      const fromOpacity = dockAnimRef.current && dockEl
        ? Number(getComputedStyle(dockEl).opacity) : 1;
      const fromCardOpacity = cardEl ? Number(getComputedStyle(cardEl).opacity) : 1;
      const fromCardTransform = cardEl ? getComputedStyle(cardEl).transform : "none";
      const wasFadingCard = prev?.mode === "minimized" && Boolean(cardAnimRef.current);
      const wasCollapsing = prev?.mode === "minimized" && Boolean(dockAnimRef.current);
      cancelActiveAnimations();
      setAnimating(false);

      if (!isActiveWorkspace || (prev && !prev.isActiveWorkspace) || prefersReducedMotion() ||
          !dockEl || !cardEl || typeof dockEl.animate !== "function") {
        setMinimizeComplete(entry.mode === "minimized");
        if (entry.closing) onFinishClose(entry.key, entry.instanceId);
        else if (isActiveWorkspace && entry.mode !== "minimized") setFocusNonce(n => n + 1);
        return;
      }

      if (entry.closing || entry.mode === "minimized") {
        if (prev?.mode === "minimized" && !wasCollapsing) {
          setMinimizeComplete(true);
          if (entry.closing) onFinishClose(entry.key, entry.instanceId);
          return;
        }
        setAnimating(true);
        const maximized = entry.mode === "maximized" ||
          (entry.mode === "minimized" && lastVisibleModeRef.current === "maximized");
        let animation: Animation;
        if (maximized) {
          cardEl.style.flex = "0 0 auto";
          animation = cardEl.animate(
            [{ height: `${fromCardHeight}px`, opacity: fromCardOpacity, transform: fromCardTransform },
             { height: `${fromCardHeight}px`, opacity: 0, transform: "translateY(12px)" }],
            { duration: CLOSE_MAXIMIZED_DURATION_MS, easing: TERMINAL_EASE, fill: "both" },
          );
          cardAnimRef.current = animation;
        } else {
          // A restore can still protrude above the dock when minimized. Keep
          // that visible frame instead of clipping it to the settled dock size.
          if (fromCardHeight > cardEl.getBoundingClientRect().height + 1) {
            dockEl.classList.add("is-restoring-from-max");
            cardEl.style.flex = "0 0 auto";
            cardAnimRef.current = cardEl.animate(
              [{ height: `${fromCardHeight}px` }, { height: `${fromCardHeight}px` }],
              { duration: CLOSE_DOCKED_DURATION_MS, fill: "both" },
            );
          }
          dockEl.style.overflow = "hidden";
          animation = dockEl.animate(
            [{ height: `${fromDockHeight}px`, marginBottom: "12px", opacity: fromOpacity },
             { height: "0px", marginBottom: "0px", opacity: 0 }],
            { duration: CLOSE_DOCKED_DURATION_MS, easing: TERMINAL_EASE, fill: "both" },
          );
          dockAnimRef.current = animation;
        }
        animation.onfinish = () => {
          // Retain the final (hidden) frame until React commits display:none or
          // unmounts the card. Cancelling first briefly restores its full size.
          if (entry.closing) onFinishClose(entry.key, entry.instanceId);
          else setMinimizeComplete(true);
        };
        return;
      }

      setMinimizeComplete(false);
      const finish = () => {
        cancelActiveAnimations();
        setAnimating(false);
        captureCurrentDimensions();
        setFocusNonce(n => n + 1);
      };

      if (entry.mode === "open" && (!prev || prev.mode === "minimized")) {
        if (wasFadingCard) {
          const targetHeight = cardEl.getBoundingClientRect().height;
          dockEl.classList.add("is-restoring-from-max");
          cardEl.style.flex = "0 0 auto";
          setAnimating(true);
          dockAnimRef.current = dockEl.animate(
            [{ height: `${wasCollapsing ? fromDockHeight : 0}px`, opacity: fromOpacity },
             { height: `${entry.height}px`, opacity: 1 }],
            { duration: OPEN_DURATION_MS, easing: TERMINAL_EASE, fill: "both" },
          );
          const animation = cardEl.animate(
            [{ height: `${fromCardHeight}px`, opacity: fromCardOpacity, transform: fromCardTransform },
             { height: `${targetHeight}px`, opacity: 1, transform: "none" }],
            { duration: OPEN_DURATION_MS, easing: TERMINAL_EASE, fill: "both" },
          );
          cardAnimRef.current = animation;
          animation.onfinish = finish;
          return;
        }
        const startHeight = wasCollapsing ? fromDockHeight : 0;
        dockEl.style.overflow = "hidden";
        setAnimating(true);
        const animation = dockEl.animate(
          [{ height: `${startHeight}px`, marginBottom: wasCollapsing ? "12px" : "0px", opacity: wasCollapsing ? fromOpacity : 0 },
           { height: `${entry.height}px`, marginBottom: "12px", opacity: 1 }],
          { duration: OPEN_DURATION_MS, easing: TERMINAL_EASE, fill: "both" },
        );
        dockAnimRef.current = animation;
        animation.onfinish = finish;
        return;
      }

      if (prev && entry.mode !== prev.mode) {
        const toHeight = cardEl.getBoundingClientRect().height;
        if (Math.abs(toHeight - fromCardHeight) > 1) {
          if (entry.mode === "open") dockEl.classList.add("is-restoring-from-max");
          cardEl.style.flex = "0 0 auto";
          setAnimating(true);
          const animation = cardEl.animate(
            [{ height: `${fromCardHeight}px` }, { height: `${toHeight}px` }],
            { duration: RESIZE_MODE_DURATION_MS, easing: TERMINAL_EASE, fill: "both" },
          );
          cardAnimRef.current = animation;
          animation.onfinish = finish;
          return;
        }
      }
      setFocusNonce(n => n + 1);
      // These transitions are driven by mode changes, not output/status updates.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActiveWorkspace, entry.mode, entry.closing, entry.instanceId]);

    // Only release a collapse animation after the hidden presentation commits.
    useLayoutEffect(() => {
      if (entry.mode === "minimized" && minimizeComplete) {
        cancelActiveAnimations();
        setAnimating(false);
      }
    }, [entry.mode, minimizeComplete, cancelActiveAnimations]);

    const isVisible = isActiveWorkspace && (entry.mode !== "minimized" || !minimizeComplete);
    const isMaximized = isActiveWorkspace && (entry.mode === "maximized" ||
      (entry.mode === "minimized" && lastVisibleModeRef.current === "maximized"));
    const isDocked = isActiveWorkspace && !isMaximized;
    const isInteractive = isActiveWorkspace && entry.mode !== "minimized" && !entry.closing;
    const folderName = workspaceDisplayName(entry.workspacePath);

    const handleCloseClick = useCallback(() => {
      captureCurrentDimensions();
      onClose(entry.key);
    }, [captureCurrentDimensions, onClose, entry.key]);

    const handleMinimizeClick = useCallback(() => {
      captureCurrentDimensions();
      onMinimize(entry.key);
    }, [captureCurrentDimensions, onMinimize, entry.key]);

    const handleMaximizeClick = useCallback(() => {
      captureCurrentDimensions();
      onToggleMaximize(entry.key);
    }, [captureCurrentDimensions, onToggleMaximize, entry.key]);

    return (
      <section
        ref={dockRef}
        aria-label={t("工作区终端")}
        aria-hidden={!isInteractive || undefined}
        inert={!isInteractive ? true : undefined}
        data-testid={isActiveWorkspace ? "workspace-terminal-dock" : undefined}
        data-workspace-key={entry.key}
        data-terminal-mode={entry.mode}
        data-terminal-status={entry.status}
        data-terminal-closing={entry.closing ? "true" : undefined}
        className={`workspace-terminal-dock${isMaximized ? " is-maximized" : ""}${isDocked ? " is-docked" : ""}${!isVisible ? " is-hidden" : ""}${isResizing ? " is-resizing" : ""}${entry.closing || entry.mode === "minimized" ? " is-exiting" : ""}`}
        style={isDocked ? { height: `${entry.height}px` } : undefined}
      >
        {isDocked && (
          <div
            className="workspace-terminal-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("调整终端高度")}
            onPointerDown={(event) => onStartVerticalResize(entry.key, entry.height, event)}
          >
            <span className="workspace-terminal-resizer-pill" aria-hidden="true" />
          </div>
        )}

        <Terminal
          cardRef={cardRef}
          sequence={false}
          rawBody
          data-testid={isActiveWorkspace ? "workspace-terminal-card" : undefined}
          className="workspace-terminal-card"
          headerClassName="workspace-terminal-header"
          bodyClassName="workspace-terminal-body"
          onClose={handleCloseClick}
          onMinimize={handleMinimizeClick}
          onMaximize={handleMaximizeClick}
          isMaximized={entry.mode === "maximized"}
          closeLabel={t("关闭终端")}
          minimizeLabel={t("最小化终端")}
          maximizeLabel={entry.mode === "maximized" ? t("还原终端大小") : t("放大终端")}
          headerContent={
            <div
              className="workspace-terminal-header-meta"
              onDoubleClick={handleMaximizeClick}
            >
              <div className="workspace-terminal-title-group" title={entry.workspacePath}>
                <TerminalSquare size={13} className="workspace-terminal-title-icon" aria-hidden="true" />
                <span className="workspace-terminal-title-name">{folderName}</span>
                {entry.shell && (
                  <>
                    <span className="workspace-terminal-title-sep" aria-hidden="true">·</span>
                    <span className="workspace-terminal-title-shell">{entry.shell}</span>
                  </>
                )}
              </div>
              <div className="workspace-terminal-header-right">
                {entry.status === "exited" && (
                  <span className="workspace-terminal-status-pill is-exited">
                    {entry.exitCode !== null
                      ? t("已退出 ({0})", entry.exitCode)
                      : t("已退出")}
                  </span>
                )}
                {(entry.status === "exited" || entry.status === "error") && (
                  <button
                    type="button"
                    className="workspace-terminal-restart-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRestart(entry.key);
                    }}
                    aria-label={t("重启终端")}
                  >
                    <RotateCw size={12} />
                    <span>{t("重启")}</span>
                  </button>
                )}
              </div>
            </div>
          }
        >
          {entry.status !== "error" && entry.error && (
            <div className="workspace-terminal-input-error" role="alert">{entry.error}</div>
          )}
          {entry.status === "error" ? (
            <div className="workspace-terminal-error" role="alert">
              <p className="workspace-terminal-error-title">{t("无法启动终端")}</p>
              <p className="workspace-terminal-error-detail">{entry.error}</p>
              <button
                type="button"
                className="secondary"
                onClick={() => onRestart(entry.key)}
              >
                {t("重试")}
              </button>
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="workspace-terminal-loading">{t("正在启动终端…")}</div>
              }
            >
              <LazyXtermSurface
                key={entry.instanceId}
                instanceId={entry.instanceId}
                ptyBackend={entry.ptyBackend}
                visible={isInteractive}
                animating={animating}
                focusNonce={focusNonce}
                onData={(data) => onWriteInput(entry.key, data)}
                onResize={(cols, rows) => onResize(entry.key, cols, rows)}
                attachOutputListener={attachOutputListener}
              />
            </Suspense>
          )}
        </Terminal>
      </section>
    );
  },
);

WorkspaceTerminalItem.displayName = "WorkspaceTerminalItem";

export const WorkspaceTerminalHost: React.FC<WorkspaceTerminalHostProps> = React.memo(
  ({
    entries,
    activeWorkspaceKey,
    onMinimize,
    onToggleMaximize,
    onClose,
    onFinishClose,
    onRestart,
    onSetHeight,
    onWriteInput,
    onResize,
    attachOutputListener,
  }) => {
    const [resizingKey, setResizingKey] = useState<string | null>(null);
    const dragCleanupRef = useRef<(() => void) | null>(null);

    const startVerticalResize = useCallback(
      (key: string, initialHeight: number, event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragCleanupRef.current?.();

        const startY = event.clientY;
        const mainEl = event.currentTarget.closest(".main");
        const maxAllowed = mainEl
          ? Math.max(220, Math.floor(mainEl.getBoundingClientRect().height * 0.68))
          : 560;

        setResizingKey(key);

        const handlePointerMove = (moveEvent: PointerEvent) => {
          const delta = startY - moveEvent.clientY;
          const nextHeight = Math.max(160, Math.min(maxAllowed, initialHeight + delta));
          onSetHeight(key, nextHeight);
        };

        const cleanup = () => {
          window.removeEventListener("pointermove", handlePointerMove);
          window.removeEventListener("pointerup", cleanup);
          window.removeEventListener("pointercancel", cleanup);
          dragCleanupRef.current = null;
          setResizingKey(null);
        };

        dragCleanupRef.current = cleanup;
        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", cleanup);
        window.addEventListener("pointercancel", cleanup);
      },
      [onSetHeight],
    );

    if (entries.length === 0) return null;

    return (
      <>
        {entries.map((entry) => (
          <WorkspaceTerminalItem
            key={entry.key}
            entry={entry}
            isActiveWorkspace={entry.key === activeWorkspaceKey}
            isResizing={resizingKey === entry.key}
            onStartVerticalResize={startVerticalResize}
            onMinimize={onMinimize}
            onToggleMaximize={onToggleMaximize}
            onClose={onClose}
            onFinishClose={onFinishClose}
            onRestart={onRestart}
            onWriteInput={onWriteInput}
            onResize={onResize}
            attachOutputListener={attachOutputListener}
          />
        ))}
      </>
    );
  },
);

WorkspaceTerminalHost.displayName = "WorkspaceTerminalHost";
