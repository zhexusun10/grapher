import { t } from "../i18n";
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from "react";
import { rowOffsets, rowAt, visibleRows, visibleTranscriptRows } from "../services/transcriptLayout";
import { type ChatMessage, type FileAttachment, type ImageAttachment, TranscriptItem } from "../types";
import { plannerUserTurnKey } from "../services/plannerUserTurns";
import type { TranscriptRestoreAnchor } from "../services/conversationScroll";
import { closeThinkingItems } from "../services/thinkingTranscript";
import { isNestedScrollGesture, notifyTranscriptFinalOutput } from "../services/transcriptScroll";
import { parseTranscriptChunkLines, type ParseTranscriptChunkState, type TranscriptParseOptions } from "../services/transcriptParser";
import { finishTranscriptParseCacheLease, invalidateTranscriptParseCache, leaseTranscriptParseCache, readTranscriptParse, writeTranscriptParse } from "../services/transcriptParseCache";
import { settleInterruptedItems } from "../services/transcriptSettle";
import { Terminal } from "lucide-react";
import { shareJson } from "../services/structuralSharing";
import { VirtualizedList } from "./VirtualizedList";
import { TranscriptRow } from "./TranscriptRow";
import type { CardsTransitionPhase } from "./ActivitySummaryRow";
import { TRANSCRIPT_VIEWPORT_BUFFER } from "../services/transcriptPaging";
import { observeElementResize } from "../services/sharedResizeObserver";
import type { InlineSteerAttachment, LiveSteerMarker } from "../lib/pendingSteers";
import {
  applyHydratedCardPatches,
  collectHydrationRanges,
  EAGER_SUMMARY_HYDRATION_MAX_BYTES,
  itemHydrationRanges,
  totalHydrationRangeBytes,
  type HydratedCardPatch,
} from "../services/cardHydration";

const hot = (import.meta as ImportMeta & { hot?: { dispose(callback: () => void): void } }).hot;
hot?.dispose(() => invalidateTranscriptParseCache());

interface VirtualizedTranscriptProps {
  output: string;
  /** Run-prefixed owner of validated log bytes; never used as authority for content. */
  parseCacheKey?: string;
  /** Absolute cursor of the first loaded byte (it can start inside a JSONL record). */
  startOffset?: number;
  className?: string;
  emptyText?: string;
  onUserResize?: (expanded?: boolean, card?: HTMLElement) => void;
  // Historical conversations stay in document flow, windowed against the shared
  // workbench viewport (including the transcript's offset below other content).
  inline?: boolean;
  // Execution transcripts grow with their parent conversation instead of reserving a viewport.
  compact?: boolean;
  showUserTurns?: boolean;
  skipFirstUser?: boolean;
  skipLeadingUserTurn?: boolean;
  /** When set, only these normalized user texts render as transcript rows.
   * Execution transcripts use it for steers without duplicating owned turns. */
  userTurnTexts?: readonly string[];
  /** Authoritative request IDs for steers rendered inline even if rewritten. */
  userTurnRequestIds?: readonly string[];
  /** The source execution is terminal: unterminated live markers display as interrupted, not running. */
  settled?: boolean;
  /** In a composed Planning transcript only this revision is still live. Older
   * revisions' unterminated rows stay interrupted even while a new turn runs. */
  liveSource?: string;
  /** Conversation order, including revisions whose first page is not loaded yet. */
  sourceOrder?: readonly string[];
  /** Composed sources that start a new section, such as a post-task Planner
   * review. A divider row precedes such a source once it has earlier content. */
  dividerSources?: ReadonlySet<string>;
  /** Cached prompts assigned to their durable planning revision. */
  sourceUserFallbacks?: ReadonlyMap<string, readonly ChatMessage[]>;
  /** Measurements retained while the Planner view is temporarily unmounted. */
  rowHeights?: Map<string, number>;
  restoreAnchor?: TranscriptRestoreAnchor;
  onRestoreScroll?: (scrollTop: number | null) => void;
  onEditUser?: (text: string, replacement: string, userTurnOffset?: number, images?: ImageAttachment[]) => boolean | void | Promise<unknown>;
  /** Called when the user reaches the top of a shared history scroller. */
  onReachTop?: () => void;
  /** Reports whether the parsed stream sits inside a compaction (a
   * compaction_start seen without its matching compaction_end), so
   * conversation chrome can swap its working label for a compacting one. */
  onCompactingChange?: (compacting: boolean) => void;
  /** Reports the user turns actually present in the transcript, and whether the
   * loaded window starts at the transcript's first byte. Steer bubbles outside
   * the transcript stay visible until their inline copy is parsed. */
  onInlineUserTurnsChange?: (
    texts: string[],
    complete: boolean,
    turns: { text: string; offset?: number; requestId?: string }[],
    end?: number,
    start?: number,
    steerOffsets?: Readonly<Record<string, number>>,
    steerOffsetsAuthoritative?: boolean,
  ) => void;
  outputEndOffset?: number;
  steerOffsets?: Readonly<Record<string, number>>;
  steerOffsetsAuthoritative?: boolean;
  liveSteers?: readonly LiveSteerMarker[];
  inlineSteerAttachments?: readonly InlineSteerAttachment[];
  /** Collapse thinking/tool/error cards into inline Codex-style summary rows. */
  cardsCollapsed?: boolean;
  cardsTransition?: CardsTransitionPhase;
  /** Called when a user expands an individual summary row so compact mode can
   * upgrade on demand to load full tool results and thinking bodies when the
   * backend does not provide per-record raw byte ranges. */
  onExpandSummary?: () => void;
  /** Hydrated card payloads keyed by `hydrationKeyForItem(item)`. */
  hydratedCards?: ReadonlyMap<string, HydratedCardPatch>;
  /** Keys currently awaiting targeted range hydration. */
  hydratingKeys?: ReadonlySet<string>;
  /** Targeted on-demand hydration for one or more omitted cards. */
  onHydrateItems?: (items: readonly TranscriptItem[]) => void;
  /** Skip entrance animations for already-running cards in the initial loaded
   * window when entering an ongoing execution; later live chunks still animate. */
  suppressInitialAppear?: boolean;
}

function MeasuredRow({ id, measure, children }: { id: string; measure: (id: string, height: number) => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    const update = () => measure(id, element.getBoundingClientRect().height);
    update();
    return observeElementResize(element, update);
  }, [id, measure]);
  return <div ref={ref} data-transcript-id={id} style={{ display: "flow-root" }}>{children}</div>;
}

function getScrollParent(node: HTMLElement | null): HTMLElement | null {
  if (!node || node === document.body || node === document.documentElement) return null;
  const style = window.getComputedStyle(node);
  const overflowY = style.overflowY;
  if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
    return node;
  }
  return getScrollParent(node.parentElement);
}

const PLANNING_MARKER_PREFIX = '{"type":"grapher_planning_source"';

interface PlanningSegment { source: string; startOffset: number; text: string; }

/** Per-revision parse state for composed planning transcripts. Row ids derive
 * from the revision id plus absolute file byte offsets (the marker carries the
 * window start), so cached items stay valid while older pages are prepended. */
interface SegmentParseState extends ParseTranscriptChunkState {
  startOffset: number;
  text: string;
  parsedChars: number;
  items: TranscriptItem[];
  pendingTools: Map<string, TranscriptItem>;
}

function freshSegmentState(segment: PlanningSegment): SegmentParseState {
  return {
    source: segment.source,
    byteOffset: segment.startOffset,
    leadingFragment: segment.startOffset > 0,
    inTagThinking: false,
    inFinalResponse: false,
    finalResponseSuppressed: false,
    seenFirstUser: false,
    pendingUserStart: false,
    assistantStartIndex: 0,
    userMessageStarts: new Set(),
    compacting: false,
    startOffset: segment.startOffset,
    text: segment.text,
    parsedChars: 0,
    items: [],
    pendingTools: new Map(),
  };
}

/** Split a composed planning transcript into per-revision segments. The
 * composition always opens with a grapher_planning_source marker line and
 * every further marker starts its own line; content lines between markers
 * belong to the preceding revision. Returns null for non-composed output. */
function splitPlanningSegments(output: string): PlanningSegment[] | null {
    if (!output.startsWith(PLANNING_MARKER_PREFIX)) return null;
  const segments: PlanningSegment[] = [];
  let cursor = 0;
  let contentStart = -1;
  while (cursor < output.length) {
    if (output.startsWith(PLANNING_MARKER_PREFIX, cursor)) {
      if (contentStart >= 0) {
        segments[segments.length - 1].text = output.slice(contentStart, cursor);
        contentStart = -1;
      }
      const lineEnd = output.indexOf("\n", cursor);
      const line = lineEnd === -1 ? output.slice(cursor) : output.slice(cursor, lineEnd);
      let source = "planner";
      let startOffset = 0;
      try {
        const marker = JSON.parse(line);
        if (marker?.type === "grapher_planning_source") {
          if (typeof marker.planningId === "string" && marker.planningId) source = marker.planningId;
          if (typeof marker.startOffset === "number") startOffset = marker.startOffset;
        }
      } catch { /* keep defaults; row ids still derive from the marker offset */ }
      segments.push({ source, startOffset, text: "" });
      cursor = lineEnd === -1 ? output.length : lineEnd + 1;
    } else {
      if (contentStart < 0) {
        if (segments.length === 0) return null;
        contentStart = cursor;
      }
      const lineEnd = output.indexOf("\n", cursor);
      cursor = lineEnd === -1 ? output.length : lineEnd + 1;
    }
  }
  if (contentStart >= 0) segments[segments.length - 1].text = output.slice(contentStart, output.length);
  return segments;
}

/** Annotate parsed items with appear/expand state. `live` appends register
 * streaming liveness; prepend/fresh parses only consult it (history stays
 * collapsed across full and prepended parses). */
function annotateSegmentItems(
  items: TranscriptItem[], previousItems: TranscriptItem[],
  mode: "live" | "prepend" | "fresh", settled: boolean, inline: boolean,
  liveThinkingIds: Set<string>, liveThinkingKeys: Set<string>,
  suppressInitialAppear = false,
): TranscriptItem[] {
  const previousIds = mode === "live" ? new Set(previousItems.map(item => item.id)) : null;
  return items.map(item => {
    const isNewInLiveChunk = previousIds !== null && !previousIds.has(item.id);
    if ((item.type === "thinking" || item.type === "tool_call") && item.animateAppear === undefined) {
      const shouldAnimate = !settled && (inline || suppressInitialAppear ? isNewInLiveChunk : (item.status === "running" || isNewInLiveChunk));
      item = { ...item, animateAppear: shouldAnimate };
    }
    if (item.role === "user" && item.animateAppear === undefined) {
      item = { ...item, animateAppear: !settled && previousItems.length > 0 && isNewInLiveChunk };
    }
    if (item.type !== "thinking") return item;
    const key = `${item.thinkingContentIndex ?? 0}_${item.content?.trim() || ""}`;
    const isLive = item.status === "running" ||
      (mode !== "fresh" && liveThinkingIds.has(item.id)) ||
      (mode !== "fresh" && key.length > 2 && liveThinkingKeys.has(key)) ||
      isNewInLiveChunk;
    if (mode === "live" && isLive) {
      liveThinkingIds.add(item.id);
      if (item.content?.trim()) liveThinkingKeys.add(key);
    }
    if (item.defaultExpanded === isLive) return item;
    return { ...item, defaultExpanded: isLive };
  });
}

function cloneSegmentTail(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item, index) => index === items.length - 1 ||
    (item.type === "tool_call" && item.status === "running") ? { ...item } : item);
}

/** Detect output arriving in a forward read, including a delta and message_end
 * in the same chunk. Historical mounts and prepends must not reclaim follow. */
function hasNewAssistantText(previous: TranscriptItem[], current: TranscriptItem[]): boolean {
  const before = new Map(previous.map(item => [item.id, item.content]));
  return current.some(item => item.type === "text" && item.role === "assistant" && !item.rawOutput &&
    Boolean(item.content) && item.content !== before.get(item.id));
}

export const VirtualizedTranscript: React.FC<VirtualizedTranscriptProps> = React.memo(({
  output,
  parseCacheKey,
  startOffset = 0,
  className = "",
  emptyText = t("工作区就绪，等待节点指令输出…"),
  onUserResize,
  inline = false,
  compact = false,
  showUserTurns = false,
  skipFirstUser = false,
  skipLeadingUserTurn = false,
  userTurnTexts,
  userTurnRequestIds,
  settled = false,
  liveSource,
  sourceOrder,
  dividerSources,
  sourceUserFallbacks,
  rowHeights,
  restoreAnchor,
  onRestoreScroll,
  onEditUser,
  onReachTop,
  onCompactingChange,
  onInlineUserTurnsChange,
  outputEndOffset,
  steerOffsets,
  steerOffsetsAuthoritative,
  liveSteers,
  inlineSteerAttachments,
  cardsCollapsed = false,
  cardsTransition = "idle",
  onExpandSummary,
  hydratedCards,
  hydratingKeys,
  onHydrateItems,
  suppressInitialAppear = false,
}) => {
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [userDraft, setUserDraft] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const expandedRows = useRef(new Map<string, boolean>());
  const expandedSummaryMetaRef = useRef(new Map<string, { toolCallIds: string[]; ordinalFromEnd: number }>());
  const itemsSnapshotRef = useRef<TranscriptItem[]>([]);
  const isUserScrolledUpRef = useRef(false);
  const suppressAutoFollowRef = useRef(false);
  const resumeAutoFollowFrameRef = useRef<number | null>(null);
  const collapseFollowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Incremental parse state
  const lastProcessedPosRef = useRef<number>(0);
  const itemsRef = useRef<TranscriptItem[]>([]);
  const pendingToolsRef = useRef<Map<string, TranscriptItem>>(new Map());
  const sourceRef = useRef("output");
  const byteOffsetRef = useRef(startOffset);
  const leadingFragmentRef = useRef(startOffset > 0);
  const inputStartRef = useRef(startOffset);
  const userTurnTextsKey = JSON.stringify(userTurnTexts ?? null);
  const userTurnRequestIdsKey = JSON.stringify(userTurnRequestIds ?? null);
  // Divider placement is part of the parse identity: a newly known review turn
  // must rebuild the composed rows even when every loaded segment is unchanged.
  const dividerKey = dividerSources?.size ? `:${[...dividerSources].sort().join("\u0000")}` : "";
  const parseOptionsRef = useRef(`${showUserTurns}:${skipFirstUser}:${skipLeadingUserTurn}:${userTurnTextsKey}:${userTurnRequestIdsKey}${dividerKey}`);
  const settledRef = useRef(settled);
  const liveSourceRef = useRef(liveSource);
  const sharedViewport = inline || compact;
  const inTagThinkingRef = useRef<boolean>(false);
  const seenFirstUserRef = useRef(false);
  const userMessageStartsRef = useRef(new Set<string>());
  const pendingUserStartRef = useRef(false);
  const assistantStartIndexRef = useRef(0);
  const inFinalResponseRef = useRef<boolean>(false);
  const finalResponseSuppressedRef = useRef<boolean>(false);
  const lastRawOutputRef = useRef("");
  const itemsVersionRef = useRef(0);
  const liveTextVersionRef = useRef(0);
  const liveThinkingIdsRef = useRef<Set<string>>(new Set());
  const liveThinkingKeysRef = useRef<Set<string>>(new Set());
  // Per-revision parse cache for composed planning transcripts: paging re-parses
  // only the revision whose window changed instead of the whole composition.
  const segmentStatesRef = useRef(new Map<string, SegmentParseState>());
  const segmentStartsRef = useRef(new Map<string, number>());
  const segmentedRef = useRef(false);
  // Auto-compaction visibility: parse state survives incremental chunks and
  // re-parses; reporting is deferred to an effect so a parent never setState
  // during this component's render.
  const compactingRef = useRef(false);
  const lastSegmentSourceRef = useRef("");
  const reportedCompactingRef = useRef<boolean | null>(null);
  const onCompactingChangeRef = useRef(onCompactingChange);
  const onInlineUserTurnsChangeRef = useRef(onInlineUserTurnsChange);

  // Height cache for virtualization
  const itemHeightsRef = useRef<Map<string, number>>(new Map());
  const [, setScrollTop] = useState(0);
  const [heightVersion, setHeightVersion] = useState(0);
  const [, setExpansionVersion] = useState(0);
  const prevOffsetsRef = useRef<number[]>([0]);

  // Schedule a single heightVersion bump per microtask batch.
  // Microtasks fire before the browser paints (unlike RAF which fires
  // after paint), so the re-render with corrected offsets happens in
  // the same frame as the DOM measurements, eliminating flicker.
  const heightFlushScheduledRef = useRef(false);

  const measure = useCallback((id: string, height: number) => {
    if (sharedViewport || height <= 0 || itemHeightsRef.current.get(id) === height) return;
    itemHeightsRef.current.set(id, height);
    if (!heightFlushScheduledRef.current) {
      heightFlushScheduledRef.current = true;
      queueMicrotask(() => {
        heightFlushScheduledRef.current = false;
        setHeightVersion(value => value + 1);
      });
    }
  }, [sharedViewport]);
  const [containerHeight, setContainerHeight] = useState(600);

  const parseAvailableOutput = useCallback((rawOutput: string): boolean => {
    if (!rawOutput) {
      if (lastProcessedPosRef.current > 0 || itemsRef.current.length > 0 || segmentStatesRef.current.size > 0) {
        lastProcessedPosRef.current = 0;
        itemsRef.current = [];
        pendingToolsRef.current.clear();
        liveThinkingIdsRef.current.clear();
        liveThinkingKeysRef.current.clear();
        inTagThinkingRef.current = false;
        seenFirstUserRef.current = false;
        userMessageStartsRef.current.clear();
        pendingUserStartRef.current = false;
        assistantStartIndexRef.current = 0;
        inFinalResponseRef.current = false;
        finalResponseSuppressedRef.current = false;
        lastRawOutputRef.current = "";
        segmentStatesRef.current.clear();
        segmentStartsRef.current.clear();
        segmentedRef.current = false;
        compactingRef.current = false;
        lastSegmentSourceRef.current = "";
        return true;
      }
      return false;
    }

    const parseOptions = `${showUserTurns}:${skipFirstUser}:${skipLeadingUserTurn}:${userTurnTextsKey}:${userTurnRequestIdsKey}${dividerKey}`;
    // Steady-state renders hand back the identical string; skip all scanning.
    // A changed live revision still rebuilds the composed rows from cached
    // segment states so older turns can settle without re-reading their JSONL.
    if (rawOutput === lastRawOutputRef.current && parseOptions === parseOptionsRef.current &&
      startOffset === inputStartRef.current && settled === settledRef.current &&
      liveSource === liveSourceRef.current) return false;
    const previousLiveSource = liveSourceRef.current;
    settledRef.current = settled;
    liveSourceRef.current = liveSource;

    const segments = splitPlanningSegments(rawOutput);
    if (segments) {
      segmentedRef.current = true;
      const states = segmentStatesRef.current;
      // A parse-option change (for example the header turn becoming skippable
      // once the first window reaches byte zero) must re-parse even when a
      // segment's text is unchanged; otherwise its cached rows keep the user
      // turn the new options would have dropped.
      if (parseOptions !== parseOptionsRef.current) states.clear();
      const live = new Set(segments.map(segment => segment.source));
      for (const source of states.keys()) if (!live.has(source)) states.delete(source);
      let changed = false;
      const combined: TranscriptItem[] = [];
      const starts = new Map<string, number>();
      let hasContent = false;
      // A review turn is its own section of the conversation. The divider is
      // emitted between segments rather than parsed into the review's rows, so
      // paging inside that turn can never duplicate or misplace it.
      const pushSegment = (segment: PlanningSegment, rows: TranscriptItem[]) => {
        if (rows.length && hasContent && dividerSources?.has(segment.source)) {
          combined.push({ id: `divider_${segment.source}`, type: "divider", role: "assistant", timestamp: 0 });
        }
        starts.set(segment.source, combined.length);
        combined.push(...rows);
        if (rows.length) hasContent = true;
      };
      // A composed transcript is durable history. Once the caller is live, a
      // segment that is not named by the live revision has already ended; an
      // as-yet-unknown live revision (undefined) leaves every segment settled
      // because the live transcript is rendered separately.
      const segmentItems = (state: SegmentParseState) =>
        settled || liveSource === undefined || state.source !== liveSource
          ? settleInterruptedItems(state.items) : state.items;
      const parseFresh = (segment: PlanningSegment, segmentOptions: TranscriptParseOptions) => {
        const cached = readTranscriptParse(parseCacheKey, segment.source, segment.text, segment.startOffset, segmentOptions);
        const state = freshSegmentState(segment);
        states.set(segment.source, state);
        if (cached) {
          Object.assign(state, cached.state);
          state.parsedChars = cached.parsedChars;
          state.items = annotateSegmentItems(cached.items, [], "fresh", settled, inline,
            liveThinkingIdsRef.current, liveThinkingKeysRef.current, suppressInitialAppear);
          state.pendingTools = new Map(state.items.filter(item => item.type === "tool_call" && item.status === "running" && item.toolCallId)
            .map(item => [item.toolCallId!, item]));
          changed = true;
          return state;
        }
        const lastNewline = segment.text.lastIndexOf("\n");
        if (lastNewline !== -1) {
          const lines = segment.text.slice(0, lastNewline).split("\n");
          const parsed = parseTranscriptChunkLines(lines, [], state.pendingTools, state, segmentOptions);
          state.byteOffset = parsed.endByteOffset;
          state.parsedChars = lastNewline + 1;
          state.items = annotateSegmentItems(parsed.currentItems, [], "fresh", settled, inline,
            liveThinkingIdsRef.current, liveThinkingKeysRef.current, suppressInitialAppear);
        }
        changed = true;
        return state;
      };
      segments.forEach((segment, index) => {
        const segmentOptions: TranscriptParseOptions = {
          showUserTurns,
          // Only the first revision can hold the goal turn the conversation
          // already renders, and only when its window reaches byte zero.
          skipFirstUser: showUserTurns && skipFirstUser && index === 0 && segment.startOffset === 0,
          userTurnTexts,
        };
        const state = states.get(segment.source);
        const unchanged = !!state && segment.startOffset === state.startOffset && segment.text === state.text;
        const prependable = !!state && state.text.length > 0 && segment.text.length > state.text.length &&
          segment.text.endsWith(state.text);
        const appendable = !!state && state.text.length > 0 && segment.text.length > state.text.length &&
          segment.startOffset === state.startOffset && segment.text.startsWith(state.text);
        if (!state || (!unchanged && !prependable && !appendable)) {
          // Fresh revision, or a window we cannot relate to the cache: re-parse.
          const fresh = parseFresh(segment, segmentOptions);
          const forward = lastRawOutputRef.current.length > 0 && rawOutput.startsWith(lastRawOutputRef.current);
          if (forward && (segment.source === liveSource || segment.source === previousLiveSource) &&
              hasNewAssistantText(state?.items ?? [], fresh.items)) liveTextVersionRef.current += 1;
          pushSegment(segment, segmentItems(fresh));
          return;
        }
        if (unchanged) {
          // Unchanged revision: reuse the cached items verbatim.
        } else if (prependable) {
          // Older bytes were prepended to this revision. Parse only the new
          // front, extending through the junction line so chunks hold whole
          // lines; absolute byte offsets keep every row id stable.
          const prependedLength = segment.text.length - state.text.length;
          const prependedRaw = segment.text.slice(0, prependedLength);
          let chunkToProcess = prependedRaw;
          if (!prependedRaw.endsWith("\n")) {
            const firstNewline = state.text.indexOf("\n");
            if (firstNewline !== -1) chunkToProcess += state.text.slice(0, firstNewline + 1);
          }
          const lastNewline = chunkToProcess.lastIndexOf("\n");
          if (lastNewline === -1) {
            const fresh = parseFresh(segment, segmentOptions);
            pushSegment(segment, segmentItems(fresh));
            return;
          }
          const previousItems = state.items;
          const tailItems = cloneSegmentTail(previousItems);
          const prependedItems: TranscriptItem[] = [];
          const prependState: ParseTranscriptChunkState = {
            source: state.source,
            byteOffset: segment.startOffset,
            leadingFragment: segment.startOffset > 0,
            inTagThinking: false,
            inFinalResponse: false,
            finalResponseSuppressed: false,
            seenFirstUser: false,
            pendingUserStart: false,
            assistantStartIndex: 0,
            userMessageStarts: new Set(),
            compacting: false,
          };
          const lines = chunkToProcess.slice(0, lastNewline).split("\n");
          const parsed = parseTranscriptChunkLines(lines, prependedItems, state.pendingTools, prependState, segmentOptions, tailItems);
          const closedPrependedItems = closeThinkingItems(parsed.currentItems);
          const merged = annotateSegmentItems([...closedPrependedItems, ...tailItems], previousItems,
            "prepend", settled, inline, liveThinkingIdsRef.current, liveThinkingKeysRef.current, suppressInitialAppear);
          state.byteOffset = parsed.endByteOffset;
          state.assistantStartIndex += closedPrependedItems.length;
          state.items = shareJson(previousItems, merged);
          // The prepended bytes end exactly where the old window began, so the
          // old parse cursor stays valid after shifting by the prepend length.
          state.parsedChars = prependedLength + state.parsedChars;
          state.startOffset = segment.startOffset;
          state.text = segment.text;
          changed = true;
        } else {
          // Live growth at the tail: continue the revision's own parse state.
          const chunkText = segment.text.slice(state.parsedChars);
          const lastNewline = chunkText.lastIndexOf("\n");
          if (lastNewline !== -1) {
            const chunk = chunkText.slice(0, lastNewline + 1);
            const lines = chunk.slice(0, -1).split("\n");
            const previousItems = state.items;
            const parsed = parseTranscriptChunkLines(lines, cloneSegmentTail(previousItems),
              state.pendingTools, state, segmentOptions);
            state.byteOffset = parsed.endByteOffset;
            state.parsedChars += chunk.length;
            state.items = annotateSegmentItems(parsed.currentItems, previousItems, "live", settled, inline,
              liveThinkingIdsRef.current, liveThinkingKeysRef.current, suppressInitialAppear);
            if ((state.source === liveSource || state.source === previousLiveSource) &&
                hasNewAssistantText(previousItems, state.items)) liveTextVersionRef.current += 1;
            changed = true;
          }
          state.startOffset = segment.startOffset;
          state.text = segment.text;
        }
        pushSegment(segment, segmentItems(state));
      });
      const shared = shareJson(itemsRef.current, combined);
      segmentStartsRef.current = starts;
      itemsRef.current = shared;
      lastRawOutputRef.current = rawOutput;
      parseOptionsRef.current = parseOptions;
      inputStartRef.current = startOffset;
      // Compaction is per-session and each planning revision owns a session, so
      // only the newest revision can be compacting right now.
      lastSegmentSourceRef.current = segments.at(-1)?.source ?? "";
      return changed || shared !== itemsRef.current;
    }
    if (segmentedRef.current) {
      // A non-composed output cannot reuse per-revision state.
      segmentStatesRef.current.clear();
      segmentStartsRef.current.clear();
      segmentedRef.current = false;
      compactingRef.current = false;
      lastSegmentSourceRef.current = "";
    }

    const isPrepend = parseOptions === parseOptionsRef.current &&
      itemsRef.current.length > 0 &&
      lastRawOutputRef.current.length > 0 &&
      startOffset < inputStartRef.current &&
      rawOutput.length > lastRawOutputRef.current.length &&
      rawOutput.endsWith(lastRawOutputRef.current);

    if (isPrepend) {
      const prependedLength = rawOutput.length - lastRawOutputRef.current.length;
      const prependedRaw = rawOutput.slice(0, prependedLength);
      let chunkToProcess = prependedRaw;
      if (!prependedRaw.endsWith("\n")) {
        const firstNewlineInPrevious = rawOutput.indexOf("\n", prependedLength);
        if (firstNewlineInPrevious !== -1) {
          chunkToProcess = rawOutput.slice(0, firstNewlineInPrevious + 1);
        } else {
          chunkToProcess = rawOutput;
        }
      }

      const lines = chunkToProcess.slice(0, -1).split("\n");
      const previousItems = itemsRef.current;
      const currentTailItems = previousItems.map((item, index) => index === previousItems.length - 1 ||
        (item.type === "tool_call" && item.status === "running") ? { ...item } : item);
      const prependedItems: TranscriptItem[] = [];

      const prependState: ParseTranscriptChunkState = {
        source: "output",
        byteOffset: startOffset,
        leadingFragment: startOffset > 0,
        inTagThinking: false,
        inFinalResponse: false,
        finalResponseSuppressed: false,
        seenFirstUser: false,
        pendingUserStart: false,
        assistantStartIndex: 0,
        userMessageStarts: new Set<string>(),
        compacting: false,
      };

      const result = parseTranscriptChunkLines(
        lines,
        prependedItems,
        pendingToolsRef.current,
        prependState,
        { showUserTurns, skipFirstUser: skipFirstUser && startOffset === 0, skipLeadingUserTurn: skipLeadingUserTurn && startOffset === 0, userTurnTexts, userTurnRequestIds },
        currentTailItems,
      );

      const closedPrependedItems = closeThinkingItems(result.currentItems);
      let currentItems = [...closedPrependedItems, ...currentTailItems];

      currentItems = currentItems.map(item => {
        if ((item.type === "thinking" || item.type === "tool_call") && item.animateAppear === undefined) {
          item = { ...item, animateAppear: false };
        }
        if (item.type !== "thinking") return item;
        const key = `${item.thinkingContentIndex ?? 0}_${item.content?.trim() || ""}`;
        const isLive = item.status === "running" ||
          liveThinkingIdsRef.current.has(item.id) ||
          (key.length > 2 && liveThinkingKeysRef.current.has(key));
        const defaultExpanded = isLive;
        if (item.defaultExpanded === defaultExpanded) return item;
        return { ...item, defaultExpanded };
      });

      itemsRef.current = shareJson(previousItems, currentItems);
      inputStartRef.current = startOffset;
      lastRawOutputRef.current = rawOutput;
      lastProcessedPosRef.current = prependedLength + lastProcessedPosRef.current;
      assistantStartIndexRef.current += closedPrependedItems.length;
      return itemsRef.current !== previousItems;
    }

    if (parseOptions !== parseOptionsRef.current || startOffset !== inputStartRef.current || rawOutput.length < lastProcessedPosRef.current ||
      (lastRawOutputRef.current.length > 0 && !rawOutput.startsWith(lastRawOutputRef.current))) {
      const isStartOffsetPrepend = startOffset !== inputStartRef.current;
      lastProcessedPosRef.current = 0;
      itemsRef.current = [];
      pendingToolsRef.current.clear();
      if (!isStartOffsetPrepend) {
        liveThinkingIdsRef.current.clear();
        liveThinkingKeysRef.current.clear();
      }
      inTagThinkingRef.current = false;
      seenFirstUserRef.current = false;
      userMessageStartsRef.current.clear();
      pendingUserStartRef.current = false;
      assistantStartIndexRef.current = 0;
      inFinalResponseRef.current = false;
      finalResponseSuppressedRef.current = false;
      lastRawOutputRef.current = "";
      compactingRef.current = false;
    }

    if (lastProcessedPosRef.current === 0) {
      inputStartRef.current = startOffset;
      parseOptionsRef.current = parseOptions;
      byteOffsetRef.current = startOffset;
      sourceRef.current = "output";
      leadingFragmentRef.current = startOffset > 0;
      const cached = readTranscriptParse(parseCacheKey, "output", rawOutput, startOffset, { showUserTurns, skipFirstUser, skipLeadingUserTurn, userTurnTexts, userTurnRequestIds });
      if (cached) {
        const state = cached.state;
        lastProcessedPosRef.current = cached.parsedChars;
        sourceRef.current = state.source;
        byteOffsetRef.current = state.byteOffset;
        leadingFragmentRef.current = state.leadingFragment;
        inTagThinkingRef.current = state.inTagThinking;
        inFinalResponseRef.current = state.inFinalResponse;
        finalResponseSuppressedRef.current = state.finalResponseSuppressed;
        seenFirstUserRef.current = state.seenFirstUser;
        pendingUserStartRef.current = state.pendingUserStart;
        assistantStartIndexRef.current = state.assistantStartIndex;
        userMessageStartsRef.current = state.userMessageStarts;
        compactingRef.current = state.compacting;
        itemsRef.current = annotateSegmentItems(cached.items, [], "fresh", settled, inline,
          liveThinkingIdsRef.current, liveThinkingKeysRef.current, suppressInitialAppear);
        for (const item of itemsRef.current) if (item.type === "thinking" && item.status === "running") {
          liveThinkingIdsRef.current.add(item.id);
          if (item.content?.trim()) liveThinkingKeysRef.current.add(`${item.thinkingContentIndex ?? 0}_${item.content.trim()}`);
        }
        lastRawOutputRef.current = rawOutput;
        return true;
      }
    }
    const unparsed = rawOutput.slice(lastProcessedPosRef.current);
    if (!unparsed) return false;

    const lastNewlineIdx = unparsed.lastIndexOf("\n");
    if (lastNewlineIdx === -1) return false;

    const isIncrementalLive = lastProcessedPosRef.current > 0;
    const chunkToProcess = unparsed.slice(0, lastNewlineIdx + 1);
    lastProcessedPosRef.current += chunkToProcess.length;

    const lines = chunkToProcess.slice(0, -1).split("\n");
    // Only the tail and unfinished tools are mutated by the parser. Completed
    // history must keep its identity so memoized rows can skip live updates.
    const previousItems = itemsRef.current;
    let currentItems = previousItems.map((item, index) => index === previousItems.length - 1 ||
      (item.type === "tool_call" && item.status === "running") ? { ...item } : item);
    const pendingTools = new Map(currentItems
      .filter(item => item.type === "tool_call" && item.status === "running" && item.toolCallId)
      .map(item => [item.toolCallId!, item]));
    pendingToolsRef.current = pendingTools;

    const forwardState: ParseTranscriptChunkState = {
      source: sourceRef.current,
      byteOffset: byteOffsetRef.current,
      leadingFragment: leadingFragmentRef.current,
      inTagThinking: inTagThinkingRef.current,
      inFinalResponse: inFinalResponseRef.current,
      finalResponseSuppressed: finalResponseSuppressedRef.current,
      seenFirstUser: seenFirstUserRef.current,
      pendingUserStart: pendingUserStartRef.current,
      assistantStartIndex: assistantStartIndexRef.current,
      userMessageStarts: userMessageStartsRef.current,
      compacting: compactingRef.current,
    };

    const result = parseTranscriptChunkLines(
      lines,
      currentItems,
      pendingTools,
      forwardState,
      { showUserTurns, skipFirstUser, skipLeadingUserTurn: skipLeadingUserTurn && startOffset === 0, userTurnTexts, userTurnRequestIds },
    );

    sourceRef.current = result.endSource;
    byteOffsetRef.current = result.endByteOffset;
    leadingFragmentRef.current = forwardState.leadingFragment;
    inTagThinkingRef.current = forwardState.inTagThinking;
    inFinalResponseRef.current = forwardState.inFinalResponse;
    finalResponseSuppressedRef.current = forwardState.finalResponseSuppressed;
    seenFirstUserRef.current = forwardState.seenFirstUser;
    pendingUserStartRef.current = forwardState.pendingUserStart;
    assistantStartIndexRef.current = forwardState.assistantStartIndex;
    compactingRef.current = forwardState.compacting;

    currentItems = result.currentItems;
    const previousIds = isIncrementalLive ? new Set(previousItems.map(item => item.id)) : null;
    currentItems = currentItems.map((item, index) => {
      // Unchanged historical rows keep their exact object identity in O(1),
      // avoiding per-chunk metadata scans and deep structural-sharing walks.
      if (isIncrementalLive && previousItems[index] === item) return item;
      const isNewInLiveChunk = isIncrementalLive && !previousIds!.has(item.id);
      if ((item.type === "thinking" || item.type === "tool_call") && item.animateAppear === undefined) {
        const shouldAnimate = !settled && (inline || suppressInitialAppear ? isNewInLiveChunk : (item.status === "running" || isNewInLiveChunk));
        item = { ...item, animateAppear: shouldAnimate };
      }
      if (item.role === "user" && item.animateAppear === undefined) {
        item = { ...item, animateAppear: !settled && previousItems.length > 0 && isNewInLiveChunk };
      }
      if (item.type !== "thinking") return item;
      const key = `${item.thinkingContentIndex ?? 0}_${item.content?.trim() || ""}`;
      const isLive = item.status === "running" ||
        liveThinkingIdsRef.current.has(item.id) ||
        (key.length > 2 && liveThinkingKeysRef.current.has(key)) ||
        isNewInLiveChunk;
      if (isLive) {
        liveThinkingIdsRef.current.add(item.id);
        if (item.content?.trim()) {
          liveThinkingKeysRef.current.add(key);
        }
      }
      const defaultExpanded = isLive;
      if (item.defaultExpanded === defaultExpanded) return item;
      return { ...item, defaultExpanded };
    });

    if (isIncrementalLive && hasNewAssistantText(previousItems, currentItems)) liveTextVersionRef.current += 1;
    if (isIncrementalLive) {
      let changed = currentItems.length !== previousItems.length;
      const shared = currentItems.map((item, index) => {
        const prev = previousItems[index];
        if (prev === item) return prev;
        const next = prev ? shareJson(prev, item) : item;
        if (next !== prev) changed = true;
        return next;
      });
      itemsRef.current = changed ? shared : previousItems;
    } else {
      itemsRef.current = shareJson(previousItems, currentItems);
    }
    lastRawOutputRef.current = rawOutput;
    return itemsRef.current !== previousItems;
  }, [showUserTurns, skipFirstUser, skipLeadingUserTurn, userTurnTextsKey, userTurnRequestIdsKey, dividerKey, startOffset, settled, liveSource, inline, suppressInitialAppear, parseCacheKey]);

  const computeCompacting = (): boolean => {
    if (segmentedRef.current) {
      const state = lastSegmentSourceRef.current
        ? segmentStatesRef.current.get(lastSegmentSourceRef.current)
        : undefined;
      return !!state?.compacting;
    }
    return compactingRef.current;
  };

  useEffect(() => {
    onCompactingChangeRef.current = onCompactingChange;
    onInlineUserTurnsChangeRef.current = onInlineUserTurnsChange;
  });

  // Report after the parse commit, never during render: parents own state that
  // this callback feeds.
  useEffect(() => {
    const value = computeCompacting();
    if (reportedCompactingRef.current === value) return;
    reportedCompactingRef.current = value;
    onCompactingChangeRef.current?.(value);
  });

  // A stream this parser last reported as compacting must not outlive it.
  useEffect(() => () => {
    if (reportedCompactingRef.current === true) {
      reportedCompactingRef.current = false;
      onCompactingChangeRef.current?.(false);
    }
  }, []);

  // Parse before deriving rows. A prepend used to measure the old DOM first,
  // then replace it in a nested layout update, breaking the scroll anchor.
  if (parseAvailableOutput(output)) itemsVersionRef.current += 1;
  // Save only when leaving a mounted view, not on every append/prepend. Readers
  // own live state; only terminal executions/revisions enter this shared cache.
  const cacheOwnerRef = useRef(parseCacheKey);
  cacheOwnerRef.current = parseCacheKey;
  const saveParseRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    saveParseRef.current = () => {
      if (!parseCacheKey || lastRawOutputRef.current !== output || inputStartRef.current !== startOffset ||
        parseOptionsRef.current !== `${showUserTurns}:${skipFirstUser}:${skipLeadingUserTurn}:${userTurnTextsKey}:${userTurnRequestIdsKey}${dividerKey}`) return;
      if (segmentedRef.current) {
        const first = segmentStartsRef.current.keys().next().value;
        // Chronological writes keep the newest revisions most recent in LRU.
        for (const source of segmentStartsRef.current.keys()) {
          const state = segmentStatesRef.current.get(source);
          if (!state || (!settled && (!liveSource || source === liveSource))) continue;
          writeTranscriptParse(parseCacheKey, source, { text: state.text, startOffset: state.startOffset,
            parsedChars: state.parsedChars, items: state.items, state }, {
            showUserTurns, skipFirstUser: showUserTurns && skipFirstUser && source === first && state.startOffset === 0, userTurnTexts,
          });
        }
      } else if (settled) {
        writeTranscriptParse(parseCacheKey, "output", { text: output, startOffset, parsedChars: lastProcessedPosRef.current,
          items: itemsRef.current, state: {
            source: sourceRef.current, byteOffset: byteOffsetRef.current, leadingFragment: leadingFragmentRef.current,
            inTagThinking: inTagThinkingRef.current, inFinalResponse: inFinalResponseRef.current,
            finalResponseSuppressed: finalResponseSuppressedRef.current, seenFirstUser: seenFirstUserRef.current,
            pendingUserStart: pendingUserStartRef.current, assistantStartIndex: assistantStartIndexRef.current,
            userMessageStarts: userMessageStartsRef.current, compacting: compactingRef.current,
          } }, { showUserTurns, skipFirstUser, skipLeadingUserTurn, userTurnTexts, userTurnRequestIds });
      }
    };
  });
  useLayoutEffect(() => {
    if (!parseCacheKey) return;
    const lease = leaseTranscriptParseCache(parseCacheKey);
    return () => {
      if (cacheOwnerRef.current !== parseCacheKey) { lease.release(); return; }
      finishTranscriptParseCacheLease(lease, saveParseRef.current);
    };
  }, [parseCacheKey]);
  const itemsVersion = itemsVersionRef.current;
  const liveTextVersion = liveTextVersionRef.current;
  useLayoutEffect(() => {
    if (liveTextVersion > 0) notifyTranscriptFinalOutput(containerRef.current);
  }, [liveTextVersion]);

  const parsedItems = itemsRef.current;
  // A local prompt whose durable revision has not loaded must not appear at
  // the end of the conversation. If that revision starts at byte zero but its
  // log omitted the user row, insert the fallback at the revision boundary,
  // without changing the byte offsets or the parser's cached items.
  const projected = useMemo(() => {
    let rows = settled ? settleInterruptedItems(parsedItems) : parsedItems;
    const starts = new Map(segmentStartsRef.current);
    const insertions: Array<{ index: number; rows: TranscriptItem[] }> = [];
    let added = 0;
    if (segmentedRef.current && sourceUserFallbacks?.size) {
      for (const [source, index] of segmentStartsRef.current) {
        const segment = segmentStatesRef.current.get(source);
        const fallbacks = sourceUserFallbacks.get(source);
        starts.set(source, index + added);
        if (!segment || segment.startOffset !== 0 || !fallbacks?.length) continue;
        const recorded = segment.items.filter(item => item.role === "user" && !/^msg-[0-9a-f-]{36}$/i.test(item.id));
        const missing = fallbacks.filter(message => {
          const match = recorded.findIndex(item => plannerUserTurnKey(item.content || "") === plannerUserTurnKey(message.text));
          if (match < 0) return true;
          recorded.splice(match, 1);
          return false;
        }).map((message): TranscriptItem => ({
          id: `planner-local-${message.id}`, type: "text", role: "user", content: message.text,
          images: message.images, files: message.files, timestamp: message.timestamp ?? 0, animateAppear: false,
        }));
        if (missing.length) { insertions.push({ index, rows: missing }); added += missing.length; }
      }
    }
    if (insertions.length) {
      rows = [...rows];
      for (const insertion of insertions.reverse()) rows.splice(insertion.index, 0, ...insertion.rows);
    }
    rows = applyHydratedCardPatches(rows, hydratedCards, hydratingKeys);
    return visibleTranscriptRows(rows, starts, { collapseCards: cardsCollapsed });
  }, [parsedItems, settled, sourceUserFallbacks, output, cardsCollapsed, hydratedCards, hydratingKeys]);
  const hasRangeSupportRef = useRef(false);
  hasRangeSupportRef.current = parsedItems.some(
    item => Boolean(item.rawRange || item.rawArgsRange || item.rawResultRange),
  );
  const items = projected.rows;
  // Missing revisions keep a boundary before the next loaded revision, even
  // when their rows have not loaded or have been virtualized out of the DOM.
  const sourceStarts: Array<{ source: string; index: number }> = [];
  if (segmentedRef.current) {
    let next = items.length;
    for (const source of [...(sourceOrder ?? projected.starts.keys())].reverse()) {
      next = projected.starts.get(source) ?? next;
      sourceStarts.push({ source, index: next });
    }
    sourceStarts.reverse();
  }
  const steerRowAttachments = useMemo(() => {
    const rows = new Map<string, { text?: string; images?: ImageAttachment[]; files?: FileAttachment[] }>();
    const hasLive = Boolean(liveSteers?.length);
    const hasInline = Boolean(inlineSteerAttachments?.length);
    if (!hasLive && !hasInline) return rows;
    const byRequestId = new Map<string, { text?: string; images?: ImageAttachment[]; files?: FileAttachment[] }>();
    for (const steer of inlineSteerAttachments ?? []) {
      if (steer.requestId) byRequestId.set(steer.requestId, steer);
    }
    for (const steer of liveSteers ?? []) {
      if (steer.requestId) byRequestId.set(steer.requestId, { ...byRequestId.get(steer.requestId), ...steer });
    }
    const matchedRequestIds = new Set<string>();
    const unmarkedUserItems: TranscriptItem[] = [];
    for (const item of items) {
      if (item.role !== "user") continue;
      if (item.steerRequestId) {
        matchedRequestIds.add(item.steerRequestId);
        const meta = byRequestId.get(item.steerRequestId);
        if (meta) rows.set(item.id, meta);
      } else {
        unmarkedUserItems.push(item);
      }
    }
    if (unmarkedUserItems.length > 0) {
      for (const steer of liveSteers ?? []) {
        if (steer.requestId && matchedRequestIds.has(steer.requestId)) continue;
        const matches = unmarkedUserItems.filter(item => item.content === steer.text &&
          item.userTurnOffset !== undefined && item.userTurnOffset >= steer.afterOffset);
        const item = matches[steer.occurrence - 1];
        if (item && !rows.has(item.id)) rows.set(item.id, steer);
      }
      for (const steer of inlineSteerAttachments ?? []) {
        if (!steer.images?.length && !steer.files?.length) continue;
        if (steer.requestId && matchedRequestIds.has(steer.requestId)) continue;
        const matches = unmarkedUserItems.filter(item => item.content === steer.text);
        const item = startOffset === 0
          ? matches[steer.inlineSteerOrdinal]
          : (matches.find(candidate => !rows.has(candidate.id) && (steer.images?.length ? !!candidate.images?.length : true))
              ?? matches.find(candidate => !rows.has(candidate.id)));
        if (item && !rows.has(item.id)) rows.set(item.id, steer);
      }
    }
    return rows;
  }, [items, liveSteers, inlineSteerAttachments, startOffset]);
  // Pause recovery counts text-only turns; an attachment with the same text
  // must not make a later unread text steer look consumed.
  const inlineUserTurns = useMemo(() => items
    .filter(item => {
      const attachment = steerRowAttachments.get(item.id);
      return item.role === "user" && !item.images?.length && !item.files?.length &&
        !attachment?.images?.length && !attachment?.files?.length;
    })
    .map(item => (item.steerRequestId && steerRowAttachments.get(item.id)?.text) || item.content || ""), [items, steerRowAttachments]);
  const inlineUserTurnsKey = inlineUserTurns.join("\u0000");
  // A window that starts at byte 0 is a complete view of the conversation; a
  // tail page cannot prove which repeated turns Pi already consumed.
  const inlineUserTurnsComplete = startOffset === 0;
  const inlineTurnsWithOffsets = useMemo(() => items.filter(item => item.role === "user")
    .map(item => ({ text: item.content || "", offset: item.userTurnOffset, requestId: item.steerRequestId })), [items]);
  const inlineOffsetsKey = inlineTurnsWithOffsets.map(turn => `${turn.offset ?? ""}:${turn.requestId ?? ""}:${turn.text}`).join("\u0000");
  const steerOffsetsKey = steerOffsets ? JSON.stringify(steerOffsets) : "";
  useLayoutEffect(() => {
    onInlineUserTurnsChangeRef.current?.(
      inlineUserTurns, inlineUserTurnsComplete, inlineTurnsWithOffsets, outputEndOffset,
      startOffset, steerOffsets, steerOffsetsAuthoritative,
    );
  }, [inlineUserTurnsKey, inlineOffsetsKey, showUserTurns, inlineUserTurnsComplete, outputEndOffset, startOffset, steerOffsetsKey, steerOffsetsAuthoritative]);

  const lastScrollTopRef = useRef(0);
  const prevItemsVersionRef = useRef(itemsVersion);

  const getTranscriptRelativeScroll = useCallback((): number => {
    const el = containerRef.current;
    if (!el) return 0;
    const scrollParent = getScrollParent(el) || el;
    if (el === scrollParent) return scrollParent.scrollTop;
    const elRect = el.getBoundingClientRect();
    const parentRect = scrollParent.getBoundingClientRect();
    const topInParent = elRect.top - parentRect.top + scrollParent.scrollTop;
    return scrollParent.scrollTop - topInParent;
  }, []);

  const requestOlderNearTop = useCallback((scrollParent: HTMLElement, nextScrollTop = scrollParent.scrollTop) => {
    if (!onReachTop || scrollParent.dataset.transcriptScrollMode === "latest") return;
    // Replacing estimated row heights with measured ones clamps scrollTop
    // upwards during the initial fill. That is layout motion, not the reader
    // asking for earlier bytes: reading history while the view still follows
    // the newest output would lock the conversation out of following a
    // streaming turn. A reader's own wheel/touch/key gesture clears these
    // before the resulting scroll event reaches this listener.
    if (scrollParent.dataset.transcriptFollowing === "true" ||
        scrollParent.dataset.transcriptPreparing === "true") return;
    const relativeTop = getTranscriptRelativeScroll() + nextScrollTop - scrollParent.scrollTop;
    const threshold = Math.max(480, scrollParent.clientHeight * TRANSCRIPT_VIEWPORT_BUFFER);
    const nearTranscriptTop = relativeTop >= -threshold && relativeTop <= threshold;
    const owner = containerRef.current?.closest("[data-execution-id]");
    const firstExecution = scrollParent.querySelector("[data-execution-id]");
    const nearPaneTop = !inline && owner && owner === firstExecution && nextScrollTop <= 160;
    if (nearTranscriptTop || nearPaneTop) onReachTop();
  }, [getTranscriptRelativeScroll, inline, onReachTop]);

  const syncScrollState = useCallback(() => {
    const scrollParent = getScrollParent(containerRef.current) || containerRef.current;
    if (!scrollParent) return;

    const currentScrollTop = scrollParent.scrollTop;
    const distanceFromBottom = scrollParent.scrollHeight - currentScrollTop - scrollParent.clientHeight;
    const prevScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = currentScrollTop;

    const isScrollingUp = currentScrollTop < prevScrollTop - 1;
    if (isScrollingUp) requestOlderNearTop(scrollParent);
    if (!sharedViewport) {
      setScrollTop(currentScrollTop);
    }

    // If near bottom, definitely lock to bottom state (prevent elastic bounce from locking scrolled-up)
    if (distanceFromBottom <= 20) {
      isUserScrolledUpRef.current = false;
      return;
    }

    // If user scrolled upwards, immediately lock scrolled-up state
    if (currentScrollTop < prevScrollTop - 1) {
      isUserScrolledUpRef.current = true;
      return;
    }

  }, [requestOlderNearTop]);

  const handleExpandedChange = useCallback((id: string, expanded: boolean, card?: HTMLElement) => {
    expandedRows.current.set(id, expanded);
    if (id.startsWith("summary_")) {
      if (expanded) {
        const summaries = itemsSnapshotRef.current.filter(row => row.type === "activity_summary");
        const summaryIndex = summaries.findIndex(row => row.id === id);
        let target: TranscriptItem | undefined;
        if (summaryIndex >= 0) {
          target = summaries[summaryIndex];
          const toolCallIds = (target.summaryItems ?? [])
            .map(child => child.toolCallId)
            .filter((callId): callId is string => Boolean(callId));
          expandedSummaryMetaRef.current.set(id, {
            toolCallIds,
            ordinalFromEnd: summaries.length - 1 - summaryIndex,
          });
        }
        const children = target?.summaryItems ?? [];
        const omittedChildren = children.filter(child => child.bodyOmitted);
        const ranges = collectHydrationRanges(omittedChildren);
        if (onHydrateItems && ranges.length > 0) {
          // Eagerly hydrate reasonably-sized groups in parallel with the 260ms
          // open animation; huge groups defer hydration to individual child clicks.
          if (totalHydrationRangeBytes(ranges) <= EAGER_SUMMARY_HYDRATION_MAX_BYTES) {
            onHydrateItems(omittedChildren);
          }
        } else if (!hasRangeSupportRef.current) {
          // Older backend or mock summary without per-record raw ranges: fall
          // back to upgrading the window so expanding still exposes full bodies.
          onExpandSummary?.();
        }
      } else {
        expandedSummaryMetaRef.current.delete(id);
      }
    } else if (expanded) {
      const target = itemsSnapshotRef.current.find(row => row.id === id);
      if (target?.bodyOmitted) {
        if (onHydrateItems && itemHydrationRanges(target).length > 0) {
          onHydrateItems([target]);
        } else {
          onExpandSummary?.();
        }
      }
    }
    suppressAutoFollowRef.current = true;
    isUserScrolledUpRef.current = true;
    setExpansionVersion(value => value + 1);
    onUserResize?.(expanded, card);

    if (resumeAutoFollowFrameRef.current !== null) {
      cancelAnimationFrame(resumeAutoFollowFrameRef.current);
      resumeAutoFollowFrameRef.current = null;
    }
    if (collapseFollowTimerRef.current !== null) {
      clearTimeout(collapseFollowTimerRef.current);
      collapseFollowTimerRef.current = null;
    }

    // Keep auto-follow suppressed across the full 220ms collapse/expand animation
    // so intermediate height frames do not fight the reveal or trigger premature scroll snapping.
    collapseFollowTimerRef.current = setTimeout(() => {
      collapseFollowTimerRef.current = null;
      suppressAutoFollowRef.current = false;
      syncScrollState();
    }, 260);
  }, [onExpandSummary, onHydrateItems, onUserResize, syncScrollState]);

  const handleChildExpandedChange = useCallback((child: TranscriptItem, expanded: boolean) => {
    if (!expanded || !child.bodyOmitted) return;
    if (onHydrateItems && itemHydrationRanges(child).length > 0) {
      onHydrateItems([child]);
    } else {
      onExpandSummary?.();
    }
  }, [onExpandSummary, onHydrateItems]);

  useEffect(() => {
    if (cardsCollapsed) return;
    let removed = false;
    expandedSummaryMetaRef.current.clear();
    for (const id of [...expandedRows.current.keys()]) {
      if (id.startsWith("summary_")) {
        expandedRows.current.delete(id);
        removed = true;
      }
    }
    if (removed) setExpansionVersion(value => value + 1);
  }, [cardsCollapsed]);

  useEffect(() => () => {
    if (resumeAutoFollowFrameRef.current !== null) {
      cancelAnimationFrame(resumeAutoFollowFrameRef.current);
    }
    if (collapseFollowTimerRef.current !== null) {
      clearTimeout(collapseFollowTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (sharedViewport) return;
    if (containerRef.current) {
      const scrollParent = getScrollParent(containerRef.current) || containerRef.current;
      if (scrollParent) {
        if (scrollParent.clientHeight && scrollParent.clientHeight !== containerHeight) {
          setContainerHeight(scrollParent.clientHeight);
        }
        const hasNewItems = itemsVersion !== prevItemsVersionRef.current;
        prevItemsVersionRef.current = itemsVersion;
        // Only auto-scroll to bottom if new items were actually added, not on simple height recalculation
        if (hasNewItems && !isUserScrolledUpRef.current && !suppressAutoFollowRef.current) {
          scrollParent.scrollTop = scrollParent.scrollHeight;
        }
        setScrollTop(scrollParent.scrollTop);
      }
    }
  }, [itemsVersion, heightVersion, containerHeight, sharedViewport]);

  // Track container height & scroll position
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    
    const scrollParent = getScrollParent(el) || el;

    const updateDimensions = () => {
      if (!sharedViewport) setContainerHeight(scrollParent.clientHeight || 600);
    };
    updateDimensions();

    const resizeObserver = new ResizeObserver(updateDimensions);
    resizeObserver.observe(scrollParent);
    
    const onScroll = () => syncScrollState();
    const onWheel = (e: WheelEvent) => {
      if (isNestedScrollGesture(e, scrollParent)) return;
      const distanceFromBottom = scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight;
      if (e.deltaY < -0.5 && distanceFromBottom > 20) {
        isUserScrolledUpRef.current = true;
        requestOlderNearTop(scrollParent, Math.max(0, scrollParent.scrollTop + e.deltaY));
      }
    };
    let lastTouchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches[0]) lastTouchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) {
        const curY = e.touches[0].clientY;
        const delta = curY - lastTouchY;
        lastTouchY = curY;
        if (isNestedScrollGesture(e, scrollParent, -delta)) return;
        const distanceFromBottom = scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight;
        if (delta > 1 && distanceFromBottom > 20) {
          isUserScrolledUpRef.current = true;
          requestOlderNearTop(scrollParent);
        }
      }
    };

    scrollParent.addEventListener('wheel', onWheel, { passive: true });
    scrollParent.addEventListener('touchstart', onTouchStart, { passive: true });
    scrollParent.addEventListener('touchmove', onTouchMove, { passive: true });
    scrollParent.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      resizeObserver.disconnect();
      scrollParent.removeEventListener('wheel', onWheel);
      scrollParent.removeEventListener('touchstart', onTouchStart);
      scrollParent.removeEventListener('touchmove', onTouchMove);
      scrollParent.removeEventListener('scroll', onScroll);
    };
  }, [syncScrollState, sharedViewport, requestOlderNearTop]);

  // Virtualization calculations
  const totalCount = items.length;
  const isVirtual = !sharedViewport && totalCount > 35;

  // Inline rows have their own shared-viewport window; do not also build
  // private-viewport offsets or read geometry during their render.
  const offsets = useMemo(() => sharedViewport ? [0] : rowOffsets(items.map(item => item.id), itemHeightsRef.current), [items, heightVersion, sharedViewport]);
  const totalOffsetsHeight = offsets[offsets.length - 1] ?? 0;

  // Scroll correction: when height measurements cause offsets to change,
  // adjust scrollTop synchronously (before paint) so content above the
  // viewport doesn't visually shift. This runs in the same paint frame
  // as the paddingTop change, eliminating the two-frame jitter.
  // We do NOT call setScrollTop here to avoid a cascading re-render;
  // the passive scroll listener will pick up the change naturally.
  useLayoutEffect(() => {
    if (!isUserScrolledUpRef.current || suppressAutoFollowRef.current) {
      prevOffsetsRef.current = offsets;
      return;
    }
    const prev = prevOffsetsRef.current;
    const scrollParent = getScrollParent(containerRef.current) || containerRef.current;
    if (scrollParent && prev.length > 1 && offsets.length > 1) {
      // Find which row is at the current scroll position using the OLD offsets
      const relativeTop = getTranscriptRelativeScroll();
      const viewportTopRow = rowAt(prev, relativeTop);
      // Compute how much the offset of that row shifted
      if (viewportTopRow < offsets.length - 1 && viewportTopRow < prev.length - 1) {
        const delta = offsets[viewportTopRow] - prev[viewportTopRow];
        if (delta !== 0) {
          scrollParent.scrollTop += delta;
        }
      }
    }
    prevOffsetsRef.current = offsets;
  }, [offsets, getTranscriptRelativeScroll]);

  const relativeScrollTop = sharedViewport ? 0 : getTranscriptRelativeScroll();
  itemsSnapshotRef.current = items;
  if (cardsCollapsed && expandedSummaryMetaRef.current.size > 0) {
    const summaries = items.filter(row => row.type === "activity_summary");
    const summaryIds = new Set(summaries.map(row => row.id));
    for (const [savedId, meta] of [...expandedSummaryMetaRef.current.entries()]) {
      if (summaryIds.has(savedId)) continue;
      const byToolCall = meta.toolCallIds.length > 0
        ? summaries.find(row => (row.summaryItems ?? []).some(child => child.toolCallId && meta.toolCallIds.includes(child.toolCallId)))
        : undefined;
      const byOrdinal = summaries[summaries.length - 1 - meta.ordinalFromEnd];
      const matched = byToolCall ?? byOrdinal;
      if (matched) {
        expandedRows.current.delete(savedId);
        expandedRows.current.set(matched.id, true);
        expandedSummaryMetaRef.current.delete(savedId);
        const nextIndex = summaries.indexOf(matched);
        expandedSummaryMetaRef.current.set(matched.id, {
          toolCallIds: (matched.summaryItems ?? [])
            .map(child => child.toolCallId)
            .filter((callId): callId is string => Boolean(callId)),
          ordinalFromEnd: summaries.length - 1 - nextIndex,
        });
      }
    }
  }

  const maxScrollTop = Math.max(0, totalOffsetsHeight - containerHeight);
  const targetScrollTop = isUserScrolledUpRef.current
    ? Math.min(relativeScrollTop, maxScrollTop)
    : maxScrollTop;
  const { visibleItems, paddingTop, paddingBottom } = useMemo(() => {
    if (sharedViewport) return { visibleItems: [], paddingTop: 0, paddingBottom: 0 };
    const range = isVirtual ? visibleRows(offsets, targetScrollTop, containerHeight, 30)
      : { start: 0, end: totalCount, paddingTop: 0, paddingBottom: 0 };
    return { visibleItems: items.slice(range.start, range.end), ...range };
  }, [items, offsets, isVirtual, targetScrollTop, containerHeight, totalCount, sharedViewport]);

  const startEdit = useCallback((id: string, text: string) => { setEditingUser(id); setUserDraft(text); }, []);
  const cancelEdit = useCallback(() => setEditingUser(null), []);
  const renderRow = useCallback((item: TranscriptItem, _index?: number, allowTransition = true) => <TranscriptRow item={item}
    expanded={expandedRows.current.get(item.id)} cardsTransition={allowTransition ? cardsTransition : "idle"} onExpandedChange={handleExpandedChange} onChildResize={onUserResize}
    onChildExpandedChange={handleChildExpandedChange}
    editing={editingUser === item.id} draft={editingUser === item.id ? userDraft : ""}
    onDraftChange={setUserDraft} onStartEdit={startEdit} onCancelEdit={cancelEdit} onEditUser={onEditUser}
    steerAttachments={steerRowAttachments.get(item.id)} />,
    [cardsTransition, handleExpandedChange, handleChildExpandedChange, onUserResize, editingUser, userDraft, startEdit, cancelEdit, onEditUser, steerRowAttachments]);

  const isEmptyTranscript = settled && items.length === 0;

  return (
    <div
      className={`virtualized-transcript-container ${inline ? "transcript-inline" : ""} ${compact ? "transcript-compact" : ""} ${className}`}
      data-transcript-empty={isEmptyTranscript ? "true" : undefined}
    >
      <div
        ref={containerRef}
        className="transcript-scroll-area"
        style={{ overflowAnchor: "none", minHeight: inline || compact ? 0 : 200 }}
      >
        {!output && items.length === 0 && emptyText && <div className="transcript-empty-state"><Terminal size={22} /><p>{emptyText}</p></div>}
        {sharedViewport ? <VirtualizedList items={items} renderRow={renderRow} gap={10} overscan={cardsCollapsed ? 36 : 16} transitionPhase={cardsTransition} sourceStarts={sourceStarts} rowHeights={rowHeights}
          restoreAnchor={restoreAnchor} onRestoreScroll={onRestoreScroll} /> :
          <div style={{ flexShrink: 0, paddingTop: `${paddingTop}px`, paddingBottom: `${paddingBottom}px` }}>
            {visibleItems.map(item => <MeasuredRow key={item.id} id={item.id} measure={measure}>{renderRow(item)}</MeasuredRow>)}
          </div>}
      </div>
    </div>
  );
});

export default VirtualizedTranscript;
