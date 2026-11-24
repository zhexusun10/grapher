import type React from "react";
import { cn } from "@/lib/utils";

export interface TerminalProps {
  children: React.ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  headerContent?: React.ReactNode;
  topSlot?: React.ReactNode;
  cardRef?: React.Ref<HTMLDivElement>;
  rawBody?: boolean;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  isMaximized?: boolean;
  closeLabel?: string;
  minimizeLabel?: string;
  maximizeLabel?: string;
  "data-testid"?: string;
}

export const Terminal = ({
  children,
  className,
  headerClassName,
  bodyClassName,
  headerContent,
  topSlot,
  cardRef,
  rawBody = false,
  onClose,
  onMinimize,
  onMaximize,
  isMaximized = false,
  closeLabel = "Close terminal",
  minimizeLabel = "Minimize terminal",
  maximizeLabel = "Toggle maximize terminal",
  "data-testid": dataTestId,
}: TerminalProps) => {
  const hasWindowControls = Boolean(onClose || onMinimize || onMaximize);

  return (
    <div
      ref={cardRef}
      data-testid={dataTestId}
      className={cn(
        "border-border bg-background z-0 h-full max-h-100 w-full max-w-lg rounded-xl border",
        className,
      )}
    >
      {topSlot}
      <div
        className={cn(
          "border-border flex flex-col gap-y-2 border-b p-4",
          headerClassName,
        )}
      >
        <div className="flex flex-row items-center justify-between gap-x-3">
          {hasWindowControls ? (
            <div className="terminal-traffic-lights" role="group">
              <button
                type="button"
                className="terminal-traffic-btn is-close"
                onClick={onClose}
                disabled={!onClose}
                aria-label={closeLabel}
                title={closeLabel}
                data-terminal-action="close"
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M3.5 3.5l5 5M8.5 3.5l-5 5"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="terminal-traffic-btn is-minimize"
                onClick={onMinimize}
                disabled={!onMinimize}
                aria-label={minimizeLabel}
                title={minimizeLabel}
                data-terminal-action="minimize"
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M3 6h6"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="terminal-traffic-btn is-maximize"
                onClick={onMaximize}
                disabled={!onMaximize}
                aria-label={maximizeLabel}
                aria-pressed={isMaximized}
                title={maximizeLabel}
                data-terminal-action="maximize"
              >
                {isMaximized ? (
                  <svg viewBox="0 0 12 12" aria-hidden="true" data-traffic-glyph="restore">
                    <path d="M6.4 5.6H9.7L6.4 2.3Z" fill="currentColor" />
                    <path d="M5.6 6.4H2.3L5.6 9.7Z" fill="currentColor" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 12 12" aria-hidden="true" data-traffic-glyph="expand">
                    <path d="M3 4V9H8Z" fill="currentColor" />
                    <path d="M9 8V3H4Z" fill="currentColor" />
                  </svg>
                )}
              </button>
            </div>
          ) : (
            <div className="flex flex-row gap-x-2">
              <div className="h-2 w-2 rounded-full bg-red-500"></div>
              <div className="h-2 w-2 rounded-full bg-yellow-500"></div>
              <div className="h-2 w-2 rounded-full bg-green-500"></div>
            </div>
          )}
          {headerContent}
        </div>
      </div>
      {rawBody ? (
        <div className={cn("min-h-0 flex-1 overflow-hidden", bodyClassName)}>
          {children}
        </div>
      ) : (
        <pre className={cn("p-4", bodyClassName)}>
          <code className="grid gap-y-1 overflow-auto">{children}</code>
        </pre>
      )}
    </div>
  );
};

export default Terminal;
