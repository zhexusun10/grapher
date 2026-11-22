import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { RotateCw, TerminalSquare } from "lucide-react";
import { Terminal } from "../ui/terminal";
import { t } from "../../i18n";
import type { WorkspaceTerminalEntry } from "../../hooks/useWorkspaceTerminals";
import "./workspace-terminal.css";

const LazyXtermSurface = lazy(() => import("./XtermSurface"));

const TERMINAL_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const OPEN_DURATION_MS = 260;
const CLOSE_DOCKED_DURATION_MS = 220;
const CLOSE_MAXIMIZED_DURATION_MS = 200;
const RESIZE_MODE_DURATION_MS = 280;

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

    const [exitingMinimizeFrom, setExitingMinimizeFrom] = useState<"docked" | "maximized" | null>(null);
    const [focusNonce, setFocusNonce] = useState(0);

    const cancelActiveAnimations = useCallback(() => {
      dockAnimRef.current?.cancel();
      dockAnimRef.current = null;
      cardAnimRef.current?.cancel();
      cardAnimRef.current = null;
      const dockEl = dockRef.current;
      const cardEl = cardRef.current;
      if (dockEl) {
        dockEl.classList.remove("is-restoring-from-max");
        dockEl.style.overflow = "";
      }
      if (cardEl) {
        cardEl.style.flex = "";
      }
    }, []);

    const captureCurrentDimensions = useCallback(() => {
      const cardRect = cardRef.current?.getBoundingClientRect();
      if (cardRect && cardRect.height > 20) {
        lastCardHeightRef.current = cardRect.height;
      }
      const dockRect = dockRef.current?.getBoundingClientRect();
      if (dockRect && dockRect.height > 20) {
        lastDockHeightRef.current = dockRect.height;
      }
    }, []);

    // Keep measured height fresh during normal visible states (window resize,
    // vertical drag resize, etc.) so composer-triggered minimize or maximize
    // transitions always animate from the true rendered height.
    useEffect(() => {
      const cardEl = cardRef.current;
      if (!cardEl || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => {
        if (dockAnimRef.current || cardAnimRef.current) return;
        captureCurrentDimensions();
      });
      observer.observe(cardEl);
      return () => observer.disconnect();
    }, [captureCurrentDimensions]);

    // Cancel any running animation immediately if the user grabs the drag resizer.
    useEffect(() => {
      if (isResizing) {
        cancelActiveAnimations();
      }
    }, [isResizing, cancelActiveAnimations]);

    // Clean up animations on unmount.
    useEffect(() => cancelActiveAnimations, [cancelActiveAnimations]);

    // Orchestrate Open / Minimize / Close / Maximize / Restore transitions.
    useLayoutEffect(() => {
      const prev = prevStateRef.current;
      prevStateRef.current = {
        isActiveWorkspace,
        mode: entry.mode,
        closing: entry.closing,
      };

      const dockEl = dockRef.current;
      const cardEl = cardRef.current;
      const reduced = prefersReducedMotion();

      // Workspace switched away: cancel animations and settle immediately.
      if (!isActiveWorkspace) {
        cancelActiveAnimations();
        setExitingMinimizeFrom(null);
        if (entry.closing) {
          onFinishClose(entry.key, entry.instanceId);
        }
        return;
      }

      // Switched back to this workspace: snap immediately without open/close animation.
      if (prev && !prev.isActiveWorkspace && isActiveWorkspace) {
        cancelActiveAnimations();
        setExitingMinimizeFrom(null);
        if (entry.closing) {
          onFinishClose(entry.key, entry.instanceId);
        } else if (entry.mode !== "minimized") {
          setFocusNonce((n) => n + 1);
        }
        return;
      }

      // Red close button: PTY is already killed; animate out, then remove entry.
      if (entry.closing) {
        if (reduced || !dockEl || !cardEl || typeof dockEl.animate !== "function") {
          cancelActiveAnimations();
          onFinishClose(entry.key, entry.instanceId);
          return;
        }
        cancelActiveAnimations();
        if (entry.mode === "maximized") {
          const anim = cardEl.animate(
            [
              { opacity: 1, transform: "scale(1) translateY(0px)" },
              { opacity: 0, transform: "scale(0.985) translateY(14px)" },
            ],
            { duration: CLOSE_MAXIMIZED_DURATION_MS, easing: TERMINAL_EASE, fill: "forwards" },
          );
          cardAnimRef.current = anim;
          anim.onfinish = () => {
            if (cardAnimRef.current === anim) cardAnimRef.current = null;
            onFinishClose(entry.key, entry.instanceId);
          };
          return;
        }

        const fromH = dockEl.getBoundingClientRect().height || lastDockHeightRef.current || entry.height;
        dockEl.style.overflow = "hidden";
        const dockAnim = dockEl.animate(
          [
            { height: `${fromH}px`, marginBottom: "12px", opacity: 1 },
            { height: "0px", marginBottom: "0px", opacity: 0 },
          ],
          { duration: CLOSE_DOCKED_DURATION_MS, easing: TERMINAL_EASE, fill: "forwards" },
        );
        const cardAnim = cardEl.animate(
          [{ transform: "translateY(0px)" }, { transform: "translateY(10px)" }],
          { duration: CLOSE_DOCKED_DURATION_MS, easing: TERMINAL_EASE, fill: "forwards" },
        );
        dockAnimRef.current = dockAnim;
        cardAnimRef.current = cardAnim;
        dockAnim.onfinish = () => {
          if (dockAnimRef.current === dockAnim) dockAnimRef.current = null;
          if (cardAnimRef.current === cardAnim) cardAnimRef.current = null;
          onFinishClose(entry.key, entry.instanceId);
        };
        return;
      }

      // Yellow minimize button or composer toggle -> minimized.
      if (entry.mode === "minimized") {
        if (prev && prev.mode !== "minimized" && !reduced && typeof dockEl?.animate === "function") {
          setExitingMinimizeFrom(prev.mode === "maximized" ? "maximized" : "docked");
        } else {
          cancelActiveAnimations();
          setExitingMinimizeFrom(null);
        }
        return;
      }

      // Becoming visible again cancels any in-flight minimize collapse.
      if (exitingMinimizeFrom !== null) {
        setExitingMinimizeFrom(null);
      }

      // Open (fresh mount) or Restore from minimized -> docked.
      if (entry.mode === "open" && (!prev || prev.mode === "minimized")) {
        const startH =
          exitingMinimizeFrom === "docked" && dockEl
            ? dockEl.getBoundingClientRect().height
            : 0;
        cancelActiveAnimations();
        if (!reduced && dockEl && cardEl && typeof dockEl.animate === "function") {
          dockEl.style.overflow = "hidden";
          const dockAnim = dockEl.animate(
            [
              { height: `${startH}px`, marginBottom: startH > 0 ? "6px" : "0px", opacity: startH > 0 ? 0.6 : 0 },
              { height: `${entry.height}px`, marginBottom: "12px", opacity: 1 },
            ],
            { duration: OPEN_DURATION_MS, easing: TERMINAL_EASE },
          );
          const cardAnim = cardEl.animate(
            [{ transform: startH > 0 ? "translateY(4px)" : "translateY(10px)" }, { transform: "translateY(0px)" }],
            { duration: OPEN_DURATION_MS, easing: TERMINAL_EASE },
          );
          dockAnimRef.current = dockAnim;
          cardAnimRef.current = cardAnim;
          const finishOpen = () => {
            if (dockAnimRef.current === dockAnim) dockAnimRef.current = null;
            if (cardAnimRef.current === cardAnim) cardAnimRef.current = null;
            if (dockRef.current) dockRef.current.style.overflow = "";
            captureCurrentDimensions();
            setFocusNonce((n) => n + 1);
          };
          dockAnim.onfinish = finishOpen;
          dockAnim.oncancel = () => {
            if (dockAnimRef.current === dockAnim) dockAnimRef.current = null;
            if (dockRef.current) dockRef.current.style.overflow = "";
          };
        } else {
          setFocusNonce((n) => n + 1);
        }
        return;
      }

      // Maximize: docked -> full workbench size (grows smoothly upward from bottom edge).
      if (entry.mode === "maximized" && prev && prev.mode === "open") {
        cancelActiveAnimations();
        if (!reduced && cardEl && typeof cardEl.animate === "function") {
          const toHeight = cardEl.getBoundingClientRect().height;
          const fromHeight = Math.max(120, lastCardHeightRef.current || entry.height - 10);
          if (toHeight > fromHeight + 2) {
            cardEl.style.flex = "0 0 auto";
            const anim = cardEl.animate(
              [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
              { duration: RESIZE_MODE_DURATION_MS, easing: TERMINAL_EASE },
            );
            cardAnimRef.current = anim;
            const cleanup = () => {
              if (cardAnimRef.current === anim) cardAnimRef.current = null;
              if (cardRef.current) cardRef.current.style.flex = "";
            };
            anim.onfinish = () => {
              cleanup();
              captureCurrentDimensions();
              setFocusNonce((n) => n + 1);
            };
            anim.oncancel = cleanup;
            return;
          }
        }
        setFocusNonce((n) => n + 1);
        return;
      }

      // Restore: maximized -> docked (shrinks smoothly downward back to bottom dock).
      if (entry.mode === "open" && prev && prev.mode === "maximized") {
        cancelActiveAnimations();
        if (!reduced && dockEl && cardEl && typeof cardEl.animate === "function") {
          const toHeight = cardEl.getBoundingClientRect().height || Math.max(150, entry.height - 10);
          const fromHeight = Math.max(toHeight, lastCardHeightRef.current || toHeight);
          if (fromHeight > toHeight + 2) {
            dockEl.classList.add("is-restoring-from-max");
            cardEl.style.flex = "0 0 auto";
            const anim = cardEl.animate(
              [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
              { duration: RESIZE_MODE_DURATION_MS, easing: TERMINAL_EASE },
            );
            cardAnimRef.current = anim;
            const cleanup = () => {
              if (cardAnimRef.current === anim) cardAnimRef.current = null;
              if (dockRef.current) dockRef.current.classList.remove("is-restoring-from-max");
              if (cardRef.current) cardRef.current.style.flex = "";
            };
            anim.onfinish = () => {
              cleanup();
              captureCurrentDimensions();
              setFocusNonce((n) => n + 1);
            };
            anim.oncancel = cleanup;
            return;
          }
        }
        setFocusNonce((n) => n + 1);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActiveWorkspace, entry.mode, entry.closing, entry.instanceId]);

    // Run the minimize exit animation once the exit presentation class is committed.
    useLayoutEffect(() => {
      if (!exitingMinimizeFrom || !isActiveWorkspace || entry.mode !== "minimized" || entry.closing) {
        return;
      }
      const dockEl = dockRef.current;
      const cardEl = cardRef.current;
      if (!dockEl || !cardEl || typeof dockEl.animate !== "function") {
        setExitingMinimizeFrom(null);
        return;
      }

      cancelActiveAnimations();

      if (exitingMinimizeFrom === "maximized") {
        const anim = cardEl.animate(
          [
            { opacity: 1, transform: "scale(1) translateY(0px)" },
            { opacity: 0, transform: "scale(0.985) translateY(14px)" },
          ],
          { duration: CLOSE_MAXIMIZED_DURATION_MS, easing: TERMINAL_EASE, fill: "forwards" },
        );
        cardAnimRef.current = anim;
        anim.onfinish = () => {
          if (cardAnimRef.current === anim) cardAnimRef.current = null;
          anim.cancel();
          setExitingMinimizeFrom(null);
        };
        return;
      }

      const fromH = lastDockHeightRef.current || entry.height;
      dockEl.style.overflow = "hidden";
      const dockAnim = dockEl.animate(
        [
          { height: `${fromH}px`, marginBottom: "12px", opacity: 1 },
          { height: "0px", marginBottom: "0px", opacity: 0 },
        ],
        { duration: CLOSE_DOCKED_DURATION_MS, easing: TERMINAL_EASE, fill: "forwards" },
      );
      const cardAnim = cardEl.animate(
        [{ transform: "translateY(0px)" }, { transform: "translateY(10px)" }],
        { duration: CLOSE_DOCKED_DURATION_MS, easing: TERMINAL_EASE, fill: "forwards" },
      );
      dockAnimRef.current = dockAnim;
      cardAnimRef.current = cardAnim;
      dockAnim.onfinish = () => {
        if (dockAnimRef.current === dockAnim) dockAnimRef.current = null;
        if (cardAnimRef.current === cardAnim) cardAnimRef.current = null;
        dockAnim.cancel();
        cardAnim.cancel();
        if (dockRef.current) dockRef.current.style.overflow = "";
        setExitingMinimizeFrom(null);
      };
    }, [exitingMinimizeFrom, isActiveWorkspace, entry.mode, entry.closing, entry.height, cancelActiveAnimations]);

    const isMinimizingOut = isActiveWorkspace && entry.mode === "minimized" && exitingMinimizeFrom !== null;
    const isVisible = isActiveWorkspace && (entry.mode !== "minimized" || isMinimizingOut);
    const isMaximized =
      isActiveWorkspace && (entry.mode === "maximized" || exitingMinimizeFrom === "maximized");
    const isDocked =
      isActiveWorkspace &&
      ((entry.mode === "open" && !isMaximized) || exitingMinimizeFrom === "docked");
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
        className={`workspace-terminal-dock${isMaximized ? " is-maximized" : ""}${isDocked ? " is-docked" : ""}${!isVisible ? " is-hidden" : ""}${isResizing ? " is-resizing" : ""}${entry.closing || isMinimizingOut ? " is-exiting" : ""}`}
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
                visible={isInteractive}
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
