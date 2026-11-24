import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
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
import { CollapsibleCardBody } from "./CollapsibleCardBody";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";
import { TranscriptErrorCard } from "./TranscriptErrorCard";

export type CardsTransitionPhase = "idle" | "collapsing" | "expanding";

interface ActivitySummaryRowProps {
  item: TranscriptItem;
  expanded?: boolean;
  transitionPhase?: CardsTransitionPhase;
  defaultThinkingExpanded?: boolean;
  getChildExpanded?: (id: string) => boolean | undefined;
  onExpandedChange?: (expanded: boolean, card?: HTMLElement) => void;
  onChildResize?: (expanded: boolean, card?: HTMLElement) => void;
  onChildExpandedChange?: (child: TranscriptItem, expanded: boolean, card?: HTMLElement) => void;
}

export const CARDS_TRANSITION_DURATION_MS = 260;

// Smooth ease-out cubic (matches AnimatedDisclosure and CollapsibleCardBody):
// responsive start without a harsh frame-1 jump and without a long 1px tail.
function easeCardsTransition(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

type PendingTransitionRow = {
  headerTrack: HTMLDivElement;
  headerInner: HTMLDivElement;
  bodyTrack: HTMLDivElement;
  bodyInner: HTMLDivElement;
  collapsing: boolean;
  keepBodyOpen: boolean;
  active: ActiveTransitionRow | null;
};

type ActiveTransitionRow = {
  headerTrack: HTMLDivElement;
  bodyTrack: HTMLDivElement;
  headerHeight: number;
  bodyHeight: number;
  collapsing: boolean;
  keepBodyOpen: boolean;
  lastHeaderHeight: number;
  lastBodyHeight: number;
};

const pendingTransitionRows = new Set<PendingTransitionRow>();
const activeTransitionRows = new Set<ActiveTransitionRow>();
let pendingFlushScheduled = false;
let transitionRafId: number | null = null;
let transitionCompleteRafId: number | null = null;
let transitionStartedAt = 0;
let awaitingFirstPaint = false;
let lastAppliedEased = 0;
let transitionGeneration = 0;
let transitionOnComplete: (() => void) | null = null;

type CardsTransitionAnchor = {
  scroller: HTMLElement;
  trigger: HTMLElement | null;
  pinToBottom: boolean;
  targetTop: number;
  cleanup: () => void;
};
let activeTransitionAnchor: CardsTransitionAnchor | null = null;

function applyRowAt(row: ActiveTransitionRow, eased: number): boolean {
  let heightChanged = false;
  const headerRatio = row.collapsing ? eased : 1 - eased;
  const nextHeaderH = Math.round(row.headerHeight * headerRatio);
  if (nextHeaderH !== row.lastHeaderHeight) {
    row.headerTrack.style.height = `${nextHeaderH}px`;
    row.lastHeaderHeight = nextHeaderH;
    heightChanged = true;
  }
  row.headerTrack.style.opacity = `${headerRatio}`;

  if (!row.keepBodyOpen) {
    const bodyRatio = row.collapsing ? 1 - eased : eased;
    const nextBodyH = Math.round(row.bodyHeight * bodyRatio);
    if (nextBodyH !== row.lastBodyHeight) {
      row.bodyTrack.style.height = `${nextBodyH}px`;
      row.lastBodyHeight = nextBodyH;
      heightChanged = true;
    }
    row.bodyTrack.style.opacity = `${bodyRatio}`;
  }
  return heightChanged;
}

function syncTransitionAnchorScroll(emitEvent = true) {
  const anchor = activeTransitionAnchor;
  if (!anchor || !anchor.scroller.isConnected) return;
  const { scroller, trigger, pinToBottom, targetTop } = anchor;
  if (pinToBottom) {
    scroller.scrollTop = scroller.scrollHeight;
    if (emitEvent) scroller.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
    return;
  }
  if (trigger && trigger.isConnected) {
    const delta = trigger.getBoundingClientRect().top - targetTop;
    if (Math.abs(delta) >= 0.5) {
      scroller.scrollTop += delta;
      if (emitEvent) scroller.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
    }
  }
}

function flushPendingTransitionRows(syncAnchor = true) {
  if (pendingTransitionRows.size === 0) return;
  const batch = [...pendingTransitionRows];
  pendingTransitionRows.clear();

  // Pass 1 (READ ONLY): measure all intrinsic track heights in a single layout pass
  // instead of alternating read/write/scrollTop per row (eliminates 2N forced reflows).
  const measured: Array<{ entry: PendingTransitionRow; headerHeight: number; bodyHeight: number }> = [];
  for (const entry of batch) {
    const headerHeight = Math.round(entry.headerInner.offsetHeight || entry.headerInner.getBoundingClientRect().height);
    const bodyHeight = Math.round(entry.bodyInner.offsetHeight || entry.bodyInner.getBoundingClientRect().height);
    measured.push({ entry, headerHeight, bodyHeight });
  }

  // Pass 2 (WRITE ONLY): apply initial frame heights/opacities for every row together.
  const initialEased = lastAppliedEased;
  for (const { entry, headerHeight, bodyHeight } of measured) {
    const active: ActiveTransitionRow = {
      headerTrack: entry.headerTrack,
      bodyTrack: entry.bodyTrack,
      headerHeight,
      bodyHeight,
      collapsing: entry.collapsing,
      keepBodyOpen: entry.keepBodyOpen,
      lastHeaderHeight: -1,
      lastBodyHeight: -1,
    };
    if (active.keepBodyOpen) {
      active.bodyTrack.style.height = "";
      active.bodyTrack.style.opacity = "1";
    }
    applyRowAt(active, initialEased);
    entry.active = active;
    activeTransitionRows.add(active);
  }

  if (syncAnchor) {
    syncTransitionAnchorScroll(false);
  }
  if (activeTransitionRows.size > 0 && transitionRafId === null) {
    transitionRafId = requestAnimationFrame(tickCardsTransition);
  }
}

export function hasActiveCardsTransitionAnchor() {
  return activeTransitionAnchor !== null;
}

function detachCardsTransitionAnchor() {
  if (!activeTransitionAnchor) return;
  activeTransitionAnchor.cleanup();
  activeTransitionAnchor = null;
}

export function cancelCardsTransitionAnchor() {
  if (transitionRafId !== null) {
    cancelAnimationFrame(transitionRafId);
    transitionRafId = null;
  }
  if (transitionCompleteRafId !== null) {
    cancelAnimationFrame(transitionCompleteRafId);
    transitionCompleteRafId = null;
  }
  transitionOnComplete = null;
  transitionGeneration += 1;
  transitionStartedAt = 0;
  awaitingFirstPaint = false;
  lastAppliedEased = 0;
  detachCardsTransitionAnchor();
}

export function syncCardsTransitionAnchorScroll() {
  flushPendingTransitionRows(false);
  syncTransitionAnchorScroll(false);
}

export function finishCardsTransitionAnchor() {
  const anchor = activeTransitionAnchor;
  if (!anchor) return;
  syncTransitionAnchorScroll(true);
  queueMicrotask(() => {
    if (activeTransitionAnchor !== anchor) return;
    syncTransitionAnchorScroll(true);
  });
  requestAnimationFrame(() => {
    if (activeTransitionAnchor !== anchor) return;
    syncTransitionAnchorScroll(true);
    requestAnimationFrame(() => {
      if (activeTransitionAnchor !== anchor) return;
      syncTransitionAnchorScroll(true);
      cancelCardsTransitionAnchor();
    });
  });
}

export function beginCardsTransitionAnchor(
  scroller: HTMLElement | null,
  trigger: HTMLElement | null,
  pinToBottom: boolean,
  onComplete?: () => void,
  onUserInterrupt?: () => void,
) {
  cancelCardsTransitionAnchor();
  transitionStartedAt = 0;
  awaitingFirstPaint = true;
  lastAppliedEased = 0;
  transitionOnComplete = onComplete ?? null;
  transitionGeneration += 1;
  if (scroller) {
    // User scroll/touch/pointer interrupts only the scroll anchor so the user
    // immediately regains scroll control while the 260ms row transition still
    // finishes cleanly instead of freezing half-open until the fallback timer.
    const cancel = () => {
      detachCardsTransitionAnchor();
      onUserInterrupt?.();
    };
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
  // Always schedule a tick so even transitions with zero visible summary rows
  // complete promptly instead of waiting for a fallback timeout.
  if (transitionRafId === null) {
    transitionRafId = requestAnimationFrame(tickCardsTransition);
  }
}

function tickCardsTransition(now: number) {
  transitionRafId = null;
  flushPendingTransitionRows(false);
  if (activeTransitionRows.size === 0) {
    if (transitionOnComplete) {
      const done = transitionOnComplete;
      transitionOnComplete = null;
      done();
    }
    return;
  }
  if (awaitingFirstPaint) {
    // Frame 0 (eased = 0) was applied in useLayoutEffect and has not painted yet.
    // Let the browser finish Frame 0's style/layout/paint before starting the
    // animation clock so newly mounted cards never skip the start of the curve.
    awaitingFirstPaint = false;
    transitionRafId = requestAnimationFrame(tickCardsTransition);
    return;
  }
  if (transitionStartedAt === 0) {
    transitionStartedAt = now - 16;
  }
  const elapsed = Math.max(0, now - transitionStartedAt);
  const progress = Math.min(1, elapsed / CARDS_TRANSITION_DURATION_MS);
  const eased = easeCardsTransition(progress);
  lastAppliedEased = eased;

  let anyHeightChanged = false;
  for (const row of activeTransitionRows) {
    if (applyRowAt(row, eased)) anyHeightChanged = true;
  }
  if (anyHeightChanged || progress === 0 || progress >= 1) {
    syncTransitionAnchorScroll(false);
  }

  if (progress < 1 && activeTransitionRows.size > 0) {
    transitionRafId = requestAnimationFrame(tickCardsTransition);
  } else if (progress >= 1 && transitionOnComplete) {
    const done = transitionOnComplete;
    const gen = transitionGeneration;
    transitionOnComplete = null;
    // Let the final `eased = 1` frame paint before switching to `"idle"`.
    transitionCompleteRafId = requestAnimationFrame(() => {
      transitionCompleteRafId = null;
      if (transitionGeneration === gen) done();
    });
  }
}

function registerCardsTransitionRow(entry: PendingTransitionRow): () => void {
  pendingTransitionRows.add(entry);
  if (!pendingFlushScheduled) {
    pendingFlushScheduled = true;
    queueMicrotask(() => {
      pendingFlushScheduled = false;
      flushPendingTransitionRows(true);
    });
  }
  if (transitionRafId === null) {
    transitionRafId = requestAnimationFrame(tickCardsTransition);
  }
  return () => {
    pendingTransitionRows.delete(entry);
    if (entry.active) {
      activeTransitionRows.delete(entry.active);
      entry.active = null;
    }
    if (activeTransitionRows.size === 0 && pendingTransitionRows.size === 0 && transitionRafId !== null && !transitionOnComplete) {
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
  defaultThinkingExpanded = false,
  onExpandedChange,
}: {
  item: TranscriptItem;
  expanded?: boolean;
  defaultThinkingExpanded?: boolean;
  onExpandedChange: (id: string, expanded: boolean, card?: HTMLElement) => void;
}) {
  const expand = useCallback(
    (value: boolean, card?: HTMLElement) => onExpandedChange(item.id, value, card),
    [item.id, onExpandedChange],
  );
  if (item.type === "tool_call") {
    return <ToolCallCard item={item} expanded={expanded} onExpandedChange={expand} animateAppear={false} />;
  }
  if (item.type === "thinking") {
    return (
      <ThinkingCard
        item={item}
        isStreaming={item.status === "running"}
        title="Chain of Thought"
        defaultExpanded={item.defaultExpanded ?? (defaultThinkingExpanded || item.status === "running")}
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
  defaultThinkingExpanded = false,
  getChildExpanded,
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

    const collapsing = transitionPhase === "collapsing";
    const keepBodyOpen = !collapsing && isExpanded;
    return registerCardsTransitionRow({
      headerTrack,
      headerInner,
      bodyTrack,
      bodyInner,
      collapsing,
      keepBodyOpen,
      active: null,
    });
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
          expanded={childExpanded.get(child.id) ?? getChildExpanded?.(child.id)}
          defaultThinkingExpanded={defaultThinkingExpanded}
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
            style={{ width: "100%", minWidth: 0, overflow: "hidden", contain: "layout style", pointerEvents: "none" }}
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
            style={{ width: "100%", minWidth: 0, overflow: "hidden", contain: "layout style" }}
          >
            <div ref={bodyInnerRef} style={{ width: "100%", minWidth: 0 }}>
              {cardsList}
            </div>
          </div>
        </>
      ) : (
        <>
          {headerButton}
          <CollapsibleCardBody expanded={isExpanded} durationMs={CARDS_TRANSITION_DURATION_MS}>
            {() => cardsList}
          </CollapsibleCardBody>
        </>
      )}
    </div>
  );
});

ActivitySummaryRow.displayName = "ActivitySummaryRow";
export default ActivitySummaryRow;
