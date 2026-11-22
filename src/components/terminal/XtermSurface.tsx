import React, { useEffect, useLayoutEffect, useRef } from "react";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { isWindowsTauriDesktop } from "../../services/apiBase";
import "@xterm/xterm/css/xterm.css";

interface XtermSurfaceProps {
  instanceId: number;
  ptyBackend?: "conpty" | "unix";
  visible: boolean;
  animating: boolean;
  focusNonce: number;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  attachOutputListener: (instanceId: number, listener: (chunk: Uint8Array) => void) => () => void;
}

const LIGHT_TERMINAL_THEME = {
  background: "#FFFFFF",
  foreground: "#0F172A",
  cursor: "#0F172A",
  cursorAccent: "#FFFFFF",
  selectionBackground: "rgba(37, 99, 235, 0.22)",
  selectionInactiveBackground: "rgba(100, 116, 139, 0.16)",
  black: "#0F172A",
  red: "#DC2626",
  green: "#059669",
  yellow: "#B45309",
  blue: "#2563EB",
  magenta: "#7C3AED",
  cyan: "#0891B2",
  white: "#475569",
  brightBlack: "#64748B",
  brightRed: "#EF4444",
  brightGreen: "#10B981",
  brightYellow: "#D97706",
  brightBlue: "#3B82F6",
  brightMagenta: "#8B5CF6",
  brightCyan: "#06B6D4",
  brightWhite: "#1E293B",
} as const;

export const XtermSurface: React.FC<XtermSurfaceProps> = ({
  instanceId,
  ptyBackend,
  visible,
  animating,
  focusNonce,
  onData,
  onResize,
  attachOutputListener,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitEnabledRef = useRef(visible && !animating);
  // Keep the screen/PTY grid stable while its enclosing card is clipped or
  // expanded. Fitting each animation frame clears/reflows xterm repeatedly and
  // makes interactive programs redraw on every intermediate SIGWINCH.
  fitEnabledRef.current = visible && !animating;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // Use the server's PTY, not the browser's OS. The native fallback also
  // configures startup output before terminal_create returns (older hosts
  // may omit ptyBackend).
  const conpty = ptyBackend === "conpty" || (ptyBackend === undefined && isWindowsTauriDesktop());
  const conptyRef = useRef(conpty);
  conptyRef.current = conpty;

  const fitAndNotify = useRef(() => {
    const host = hostRef.current;
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!host || !term || !fitAddon || !fitEnabledRef.current) return;
    const rect = host.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) return;
    try {
      fitAddon.fit();
      const cols = term.cols;
      const rows = term.rows;
      const prev = lastSizeRef.current;
      if (cols > 0 && rows > 0 && (!prev || prev.cols !== cols || prev.rows !== rows)) {
        lastSizeRef.current = { cols, rows };
        onResizeRef.current(cols, rows);
      }
    } catch {
      // Ignore transient fit errors while container is hidden or mid-transition.
    }
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XtermTerminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 12.5,
      lineHeight: 1.38,
      letterSpacing: 0,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: false,
      windowsPty: conptyRef.current ? { backend: "conpty" } : {},
      theme: LIGHT_TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    lastSizeRef.current = null;

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      // Cmd+K (macOS) clears scrollback cleanly.
      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === "k") {
        term.clear();
        return false;
      }
      // Copy selection with Cmd+C (macOS) or Ctrl+Shift+C (Windows/Linux),
      // or Ctrl+C when text is actively selected (otherwise send SIGINT).
      const isCopy =
        (event.metaKey && !event.ctrlKey && !event.altKey && key === "c") ||
        (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && key === "c") ||
        (event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey && key === "c" && term.hasSelection());
      if (isCopy && term.hasSelection()) {
        const selected = term.getSelection();
        if (selected && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(selected).catch(() => {});
        }
        return false;
      }
      return true;
    });

    const dataDisposable = term.onData((data) => {
      onDataRef.current(data);
    });

    const detachOutput = attachOutputListener(instanceId, (chunk) => {
      term.write(chunk);
    });

    let rafId: number | null = null;
    const scheduleFit = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        fitAndNotify.current();
      });
    };

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            scheduleFit();
          })
        : null;
    resizeObserver?.observe(host);
    scheduleFit();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      detachOutput();
      dataDisposable.dispose();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastSizeRef.current = null;
    };
  }, [instanceId, attachOutputListener]);

  useLayoutEffect(() => {
    if (terminalRef.current) {
      // ConPTY repaints its own viewport on resize; pulling old scrollback
      // into that viewport first produces blank/duplicated rows and lost text.
      terminalRef.current.options.windowsPty = conpty ? { backend: "conpty" } : {};
    }
  }, [conpty]);

  useEffect(() => {
    if (!visible || animating) return;
    const rafId = requestAnimationFrame(() => {
      fitAndNotify.current();
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(rafId);
  }, [visible, animating, focusNonce]);

  return (
    <div
      ref={hostRef}
      className="workspace-terminal-xterm"
      onMouseDown={() => {
        terminalRef.current?.focus();
      }}
    />
  );
};

export default XtermSurface;
