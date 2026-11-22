import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { TRANSCRIPT_SCROLL_ADJUSTED_EVENT } from "../services/transcriptScroll";
import {
  AlertCircle,
  ChevronRight,
  FileEdit,
  FileText,
  Folder,
  Globe,
  Loader2,
  Network,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import type { TranscriptItem } from "../types";
import { summarizeActivityGroup, type ActivitySummaryIcon } from "../services/activitySummary";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";
import { TranscriptErrorCard } from "./TranscriptErrorCard";

export type CardsTransitionPhase = "idle" | "collapsing" | "expanding";

interface ActivitySummaryRowProps {
  item: TranscriptItem;
  expanded?: boolean;
  transitionPhase?: CardsTransitionPhase;
  onExpandedChange?: (expanded: boolean, card?: HTMLElement) => void;
  onChildResize?: (expanded: boolean, card?: HTMLElement) => void;
  onChildExpandedChange?: (child: TranscriptItem, expanded: boolean, card?: HTMLElement) => void;
}

export const CARDS_TRANSITION_DURATION_MS = 260;

const CARDS_MOTION = { duration: CARDS_TRANSITION_DURATION_MS / 1000, ease: [0.25, 1, 0.5, 1] as const };

// Exact cubic-bezier(0.25, 1, 0.5, 1) evaluator used by the synchronized
// integer-pixel height driver so global collapse/expand transitions never
// introduce subpixel scrollHeight sawtooth jitter on the bottom footer bar.
function easeOutQuartBezier(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // Solve x(u) = t for P1=(0.25,1), P2=(0.5,1) via bisection (12 iterations < 0.0003 err).
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const u = (lo + hi) * 0.5;
    const inv = 1 - u;
    const x = 3 * inv * inv * u * 0.25 + 3 * inv * u * u * 0.5 + u * u * u;
    if (x < t) lo = u;
    else hi = u;
  }
  const u = (lo + hi) * 0.5;
  const inv = 1 - u;
  return 3 * inv * inv * u + 3 * inv * u * u + u * u * u;
}

type TransitionRowStep = (eased: number) => void;
const activeTransitionRows = new Set<TransitionRowStep>();
let transitionRafId: number | null = null;
let transitionStartedAt = 0;

type CardsTransitionAnchor = {
  scroller: HTMLElement;
  trigger: HTMLElement | null;
  pinToBottom: boolean;
  targetTop: number;
  cleanup: () => void;
};
let activeTransitionAnchor: CardsTransitionAnchor | null = null;

function syncTransitionAnchorScroll() {
  const anchor = activeTransitionAnchor;
  if (!anchor || !anchor.scroller.isConnected) return;
  const { scroller, trigger, pinToBottom, targetTop } = anchor;
  if (pinToBottom) {
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
    return;
  }
  if (trigger && trigger.isConnected) {
    const delta = trigger.getBoundingClientRect().top - targetTop;
    if (Math.abs(delta) >= 0.5) {
      scroller.scrollTop += delta;
      scroller.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
    }
  }
}

export function hasActiveCardsTransitionAnchor() {
  return activeTransitionAnchor !== null;
}

export function cancelCardsTransitionAnchor() {
  if (!activeTransitionAnchor) return;
  activeTransitionAnchor.cleanup();
  activeTransitionAnchor = null;
}

export function syncCardsTransitionAnchorScroll() {
  syncTransitionAnchorScroll();
}

export function finishCardsTransitionAnchor() {
  const anchor = activeTransitionAnchor;
  if (!anchor) return;
  syncTransitionAnchorScroll();
  queueMicrotask(() => {
    if (activeTransitionAnchor !== anchor) return;
    syncTransitionAnchorScroll();
  });
  requestAnimationFrame(() => {
    if (activeTransitionAnchor !== anchor) return;
    syncTransitionAnchorScroll();
    requestAnimationFrame(() => {
      if (activeTransitionAnchor !== anchor) return;
      syncTransitionAnchorScroll();
      cancelCardsTransitionAnchor();
    });
  });
}

export function beginCardsTransitionAnchor(
  scroller: HTMLElement | null,
  trigger: HTMLElement | null,
  pinToBottom: boolean,
) {
  cancelCardsTransitionAnchor();
  transitionStartedAt = performance.now();
  if (!scroller) return;
  const cancel = () => cancelCardsTransitionAnchor();
  scroller.addEventListener("wheel", cancel, { passive: true, once: true });
  scroller.addEventListener("touchstart", cancel, { passive: true, once: true });
  scroller.addEventListener("pointerdown", cancel, { passive: true, once: true });
  activeTransitionAnchor = {
    scroller,
    trigger,
    pinToBottom,
    targetTop: trigger?.getBoundingClientRect().top ?? 0,
    cleanup: () => {
      scroller.removeEventListener("wheel", cancel);
      scroller.removeEventListener("touchstart", cancel);
      scroller.removeEventListener("pointerdown", cancel);
    },
  };
}

function tickCardsTransition(now: number) {
  transitionRafId = null;
  if (activeTransitionRows.size === 0) return;
  const elapsed = Math.max(0, now - transitionStartedAt);
  const progress = Math.min(1, elapsed / CARDS_TRANSITION_DURATION_MS);
  const eased = easeOutQuartBezier(progress);
  for (const step of activeTransitionRows) step(eased);
  syncTransitionAnchorScroll();
  if (progress < 1 && activeTransitionRows.size > 0) {
    transitionRafId = requestAnimationFrame(tickCardsTransition);
  }
}

function registerCardsTransitionRow(step: TransitionRowStep): () => void {
  if (activeTransitionRows.size === 0 && transitionStartedAt === 0) {
    transitionStartedAt = performance.now();
  }
  activeTransitionRows.add(step);
  if (transitionRafId === null) {
    transitionRafId = requestAnimationFrame(tickCardsTransition);
  }
  return () => {
    activeTransitionRows.delete(step);
    if (activeTransitionRows.size === 0 && transitionRafId !== null) {
      cancelAnimationFrame(transitionRafId);
      transitionRafId = null;
    }
  };
}

function renderSummaryIcon(icon: ActivitySummaryIcon, isRunning: boolean) {
  if (isRunning) return <Loader2 size={14} strokeWidth={1.9} className="activity-summary-icon spin" />;
  switch (icon) {
    case "folder":
      return <Folder size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "search":
      return <Search size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "read":
      return <FileText size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "edit":
      return <FileEdit size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "terminal":
      return <SquareTerminal size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "web":
      return <Globe size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "graph":
      return <Network size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "error":
      return <AlertCircle size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "thinking":
      return <Sparkles size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    default:
      return <Wrench size={14} strokeWidth={1.85} className="activity-summary-icon" />;
  }
}

const SummaryChildCard = memo(function SummaryChildCard({
  item,
  expanded,
  onExpandedChange,
}: {
  item: TranscriptItem;
  expanded?: boolean;
  onExpandedChange: (id: string, expanded: boolean, card?: HTMLElement) => void;
}) {
  const expand = useCallback(
    (value: boolean, card?: HTMLElement) => onExpandedChange(item.id, value, card),
    [item.id, onExpandedChange],
  );
  if (item.type === "tool_call") {
    return <ToolCallCard item={item} expanded={expanded} onExpandedChange={expand} />;
  }
  if (item.type === "thinking") {
    return (
      <ThinkingCard
        item={item}
        isStreaming={item.status === "running"}
        title="Chain of Thought"
        defaultExpanded={item.defaultExpanded ?? (item.status === "running")}
        autoExpandWhileStreaming={true}
        expanded={expanded}
        onExpandedChange={expand}
        animateAppear={false}
      />
    );
  }
  if (item.errorItems || ((item.type === "text" || item.type === "system") && (item.isError || item.status === "error"))) {
    return <TranscriptErrorCard item={item} expanded={expanded} onExpandedChange={expand} />;
  }
  return null;
});

export const ActivitySummaryRow: React.FC<ActivitySummaryRowProps> = memo(({
  item,
  expanded,
  transitionPhase = "idle",
  onExpandedChange,
  onChildResize,
  onChildExpandedChange,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const headerTrackRef = useRef<HTMLDivElement>(null);
  const headerInnerRef = useRef<HTMLDivElement>(null);
  const bodyTrackRef = useRef<HTMLDivElement>(null);
  const bodyInnerRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [localExpanded, setLocalExpanded] = useState(false);
  const [childExpanded, setChildExpanded] = useState<Map<string, boolean>>(() => new Map());
  const isExpanded = expanded ?? localExpanded;

  const items = item.summaryItems ?? [];
  const summary = useMemo(
    () => summarizeActivityGroup(items, undefined, { isOpen: item.summaryOpen }),
    [items, item.summaryOpen],
  );
  const isGlobalTransition = !reduceMotion && (transitionPhase === "collapsing" || transitionPhase === "expanding");
  const keepBodyExpanded = !reduceMotion && transitionPhase === "expanding" && isExpanded;

  useEffect(() => {
    if (transitionPhase === "collapsing") setLocalExpanded(false);
  }, [transitionPhase]);

  useLayoutEffect(() => {
    if (!isGlobalTransition) return;
    const headerTrack = headerTrackRef.current;
    const headerInner = headerInnerRef.current;
    const bodyTrack = bodyTrackRef.current;
    const bodyInner = bodyInnerRef.current;
    if (!headerTrack || !headerInner || !bodyTrack || !bodyInner) return;

    const headerHeight = Math.round(headerInner.offsetHeight || headerInner.getBoundingClientRect().height);
    const bodyHeight = Math.round(bodyInner.offsetHeight || bodyInner.getBoundingClientRect().height);
    const collapsing = transitionPhase === "collapsing";
    const keepBodyOpen = !collapsing && isExpanded;

    if (keepBodyOpen) {
      bodyTrack.style.height = "";
      bodyTrack.style.opacity = "1";
    }

    const apply = (eased: number) => {
      const headerRatio = collapsing ? eased : 1 - eased;
      headerTrack.style.height = `${Math.round(headerHeight * headerRatio)}px`;
      headerTrack.style.opacity = `${headerRatio}`;
      if (!keepBodyOpen) {
        const bodyRatio = collapsing ? 1 - eased : eased;
        bodyTrack.style.height = `${Math.round(bodyHeight * bodyRatio)}px`;
        bodyTrack.style.opacity = `${bodyRatio}`;
      }
    };

    apply(0);
    syncTransitionAnchorScroll();
    return registerCardsTransitionRow(apply);
  }, [isGlobalTransition, transitionPhase, isExpanded]);

  const toggleExpanded = useCallback(() => {
    if (isGlobalTransition) return;
    const next = !isExpanded;
    setLocalExpanded(next);
    onExpandedChange?.(next, rowRef.current ?? undefined);
  }, [isExpanded, isGlobalTransition, onExpandedChange]);

  const handleChildExpanded = useCallback((id: string, next: boolean, card?: HTMLElement) => {
    setChildExpanded(previous => {
      const updated = new Map(previous);
      updated.set(id, next);
      return updated;
    });
    const child = items.find(entry => entry.id === id);
    if (child) onChildExpandedChange?.(child, next, card);
    onChildResize?.(next, card);
  }, [items, onChildExpandedChange, onChildResize]);

  const motionTransition = reduceMotion ? { duration: 0 } : CARDS_MOTION;
  const bodyInitial = reduceMotion ? false : { gridTemplateRows: "0fr", opacity: 0 };
  const bodyAnimate = { gridTemplateRows: "1fr", opacity: 1 };

  const headerButton = (
    <button
      type="button"
      className="activity-summary-trigger"
      data-testid="activity-summary-trigger"
      onClick={toggleExpanded}
      onMouseDown={(event) => {
        // Match ThinkingCard / ToolCallCard: clicking a summary toggle must not steal composer focus.
        event.preventDefault();
      }}
      aria-expanded={isExpanded}
    >
      <span className="activity-summary-icon-wrap" aria-hidden="true">
        {renderSummaryIcon(summary.icon, summary.isRunning)}
      </span>
      <span className="activity-summary-text">{summary.text}</span>
      <ChevronRight
        size={13}
        className={`activity-summary-chevron${isExpanded ? " open" : ""}`}
        aria-hidden="true"
      />
    </button>
  );

  const cardsList = (
    <div className="activity-summary-cards" data-testid="activity-summary-cards">
      {items.map((child) => (
        <SummaryChildCard
          key={child.id}
          item={child}
          expanded={childExpanded.get(child.id)}
          onExpandedChange={handleChildExpanded}
        />
      ))}
    </div>
  );

  return (
    <div
      ref={rowRef}
      className={`activity-summary-row${isExpanded ? " expanded" : ""}${summary.isRunning ? " running" : ""}${summary.icon === "error" ? " has-error" : ""}${transitionPhase !== "idle" ? ` ${transitionPhase}` : ""}`}
      data-testid="activity-summary-row"
      data-transition={transitionPhase !== "idle" ? transitionPhase : undefined}
    >
      {isGlobalTransition ? (
        <>
          <div
            ref={headerTrackRef}
            className="activity-summary-header-track"
            style={{ width: "100%", minWidth: 0, overflow: "hidden", pointerEvents: "none" }}
          >
            <div
              ref={headerInnerRef}
              style={{
                width: "100%",
                minWidth: 0,
                display: "flex",
                ...(keepBodyExpanded ? { paddingBottom: 8 } : {}),
              }}
            >
              {headerButton}
            </div>
          </div>
          <div
            ref={bodyTrackRef}
            className="activity-summary-body-track"
            style={{ width: "100%", minWidth: 0, overflow: "hidden" }}
          >
            <div ref={bodyInnerRef} style={{ width: "100%", minWidth: 0 }}>
              {cardsList}
            </div>
          </div>
        </>
      ) : (
        <>
          {headerButton}
          <AnimatePresence initial={false}>
            {isExpanded && (
              <motion.div
                key="summary-body"
                initial={bodyInitial}
                animate={bodyAnimate}
                exit={{ gridTemplateRows: "0fr", opacity: 0 }}
                transition={motionTransition}
                style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", width: "100%", minWidth: 0, overflow: "hidden" }}
              >
                <div style={{ minHeight: 0, minWidth: 0, width: "100%", overflow: "hidden" }}>
                  {cardsList}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
});

ActivitySummaryRow.displayName = "ActivitySummaryRow";
export default ActivitySummaryRow;
