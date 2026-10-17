import { t } from "../i18n";
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from "react";
import { rowOffsets, rowAt, visibleRows } from "../services/transcriptLayout";
import { TranscriptItem } from "../types";
import { closeThinkingItems } from "../services/thinkingTranscript";
import { parseTranscriptChunkLines, type ParseTranscriptChunkState } from "../services/transcriptParser";
import { settleInterruptedItems } from "../services/transcriptSettle";
import { Terminal } from "lucide-react";
import { shareJson } from "../services/structuralSharing";
import { VirtualizedList } from "./VirtualizedList";
import { TranscriptRow } from "./TranscriptRow";
import { TRANSCRIPT_VIEWPORT_BUFFER } from "../services/transcriptPaging";

interface VirtualizedTranscriptProps {
  output: string;
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
  /** The source execution is terminal: unterminated live markers display as interrupted, not running. */
  settled?: boolean;
  onEditUser?: (text: string, replacement: string) => boolean | void | Promise<unknown>;
  /** Called when the user reaches the top of a shared history scroller. */
  onReachTop?: () => void;
  /** Reports whether the parsed stream sits inside a compaction (a
   * compaction_start seen without its matching compaction_end), so
   * conversation chrome can swap its working label for a compacting one. */
  onCompactingChange?: (compacting: boolean) => void;
}

function MeasuredRow({ id, measure, children }: { id: string; measure: (id: string, height: number) => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    const update = () => measure(id, element.getBoundingClientRect().height);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
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
 * collapsed exactly like the legacy full-reparse path). */
function annotateSegmentItems(
  items: TranscriptItem[], previousItems: TranscriptItem[],
  mode: "live" | "prepend" | "fresh", settled: boolean, inline: boolean,
  liveThinkingIds: Set<string>, liveThinkingKeys: Set<string>,
): TranscriptItem[] {
  const previousIds = mode === "live" ? new Set(previousItems.map(item => item.id)) : null;
  return items.map(item => {
    const isNewInLiveChunk = previousIds !== null && !previousIds.has(item.id);
    if ((item.type === "thinking" || item.type === "tool_call") && item.animateAppear === undefined) {
      const shouldAnimate = !settled && (inline ? isNewInLiveChunk : (item.status === "running" || isNewInLiveChunk));
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

export const VirtualizedTranscript: React.FC<VirtualizedTranscriptProps> = React.memo(({
  output,
  startOffset = 0,
  className = "",
  emptyText = t("工作区就绪，等待节点指令输出…"),
  onUserResize,
  inline = false,
  compact = false,
  showUserTurns = false,
  skipFirstUser = false,
  settled = false,
  onEditUser,
  onReachTop,
  onCompactingChange,
}) => {
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [userDraft, setUserDraft] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const expandedRows = useRef(new Map<string, boolean>());
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
  const parseOptionsRef = useRef(`${showUserTurns}:${skipFirstUser}`);
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
  const liveThinkingIdsRef = useRef<Set<string>>(new Set());
  const liveThinkingKeysRef = useRef<Set<string>>(new Set());
  // Per-revision parse cache for composed planning transcripts: paging re-parses
  // only the revision whose window changed instead of the whole composition.
  const segmentStatesRef = useRef(new Map<string, SegmentParseState>());
  const segmentedRef = useRef(false);
  // Auto-compaction visibility: parse state survives incremental chunks and
  // re-parses; reporting is deferred to an effect so a parent never setState
  // during this component's render.
  const compactingRef = useRef(false);
  const lastSegmentSourceRef = useRef("");
  const reportedCompactingRef = useRef<boolean | null>(null);
  const onCompactingChangeRef = useRef(onCompactingChange);

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
        segmentedRef.current = false;
        compactingRef.current = false;
        lastSegmentSourceRef.current = "";
        return true;
      }
      return false;
    }

    const parseOptions = `${showUserTurns}:${skipFirstUser}`;
    // Steady-state renders hand back the identical string; skip all scanning.
    if (rawOutput === lastRawOutputRef.current && parseOptions === parseOptionsRef.current &&
      startOffset === inputStartRef.current) return false;

    const segments = splitPlanningSegments(rawOutput);
    if (segments) {
      segmentedRef.current = true;
      const states = segmentStatesRef.current;
      const live = new Set(segments.map(segment => segment.source));
      for (const source of states.keys()) if (!live.has(source)) states.delete(source);
      let changed = false;
      const combined: TranscriptItem[] = [];
      const parseFresh = (segment: PlanningSegment, segmentOptions: { showUserTurns: boolean; skipFirstUser: boolean }) => {
        const state = freshSegmentState(segment);
        states.set(segment.source, state);
        const lastNewline = segment.text.lastIndexOf("\n");
        if (lastNewline !== -1) {
          const lines = segment.text.slice(0, lastNewline).split("\n");
          const parsed = parseTranscriptChunkLines(lines, [], state.pendingTools, state, segmentOptions);
          state.byteOffset = parsed.endByteOffset;
          state.parsedChars = lastNewline + 1;
          state.items = annotateSegmentItems(parsed.currentItems, [], "fresh", settled, inline,
            liveThinkingIdsRef.current, liveThinkingKeysRef.current);
        }
        changed = true;
        return state;
      };
      segments.forEach((segment, index) => {
        const segmentOptions = {
          showUserTurns,
          // Only the first revision can hold the goal turn the conversation
          // already renders, and only when its window reaches byte zero.
          skipFirstUser: showUserTurns && skipFirstUser && index === 0 && segment.startOffset === 0,
        };
        const state = states.get(segment.source);
        const unchanged = !!state && segment.startOffset === state.startOffset && segment.text === state.text;
        const prependable = !!state && state.text.length > 0 && segment.text.length > state.text.length &&
          segment.text.endsWith(state.text);
        const appendable = !!state && state.text.length > 0 && segment.text.length > state.text.length &&
          segment.startOffset === state.startOffset && segment.text.startsWith(state.text);
        if (!state || (!unchanged && !prependable && !appendable)) {
          // Fresh revision, or a window we cannot relate to the cache: re-parse.
          combined.push(...parseFresh(segment, segmentOptions).items);
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
            combined.push(...parseFresh(segment, segmentOptions).items);
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
            "prepend", settled, inline, liveThinkingIdsRef.current, liveThinkingKeysRef.current);
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
              liveThinkingIdsRef.current, liveThinkingKeysRef.current);
            changed = true;
          }
          state.startOffset = segment.startOffset;
          state.text = segment.text;
        }
        for (const item of state.items) combined.push(item);
      });
      const shared = shareJson(itemsRef.current, combined);
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
        { showUserTurns, skipFirstUser: skipFirstUser && startOffset === 0 },
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
      { showUserTurns, skipFirstUser },
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
    const previousIds = new Set(previousItems.map(item => item.id));
    currentItems = currentItems.map(item => {
      const isNewInLiveChunk = isIncrementalLive && !previousIds.has(item.id);
      if ((item.type === "thinking" || item.type === "tool_call") && item.animateAppear === undefined) {
        const shouldAnimate = !settled && (inline ? isNewInLiveChunk : (item.status === "running" || isNewInLiveChunk));
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

    itemsRef.current = shareJson(previousItems, currentItems);
    lastRawOutputRef.current = rawOutput;
    return itemsRef.current !== previousItems;
  }, [showUserTurns, skipFirstUser, startOffset, settled, inline]);

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
  const itemsVersion = itemsVersionRef.current;

  const parsedItems = itemsRef.current;
  // Retain empty blocks in the parser for later backfill, but exclude them from
  // layout so virtualized history does not reserve space for invisible cards.
  const items = useMemo(() => {
    const visible = settled ? settleInterruptedItems(parsedItems) : parsedItems;
    return visible.filter(item => item.type !== "thinking" ||
      item.status === "running" || item.content?.trim());
  }, [parsedItems, settled]);

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
  }, [onUserResize, syncScrollState]);

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

  // Inline rows have their own shared-viewport window; do not also build the
  // legacy private-viewport offsets or read geometry during their render.
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
  const renderRow = useCallback((item: TranscriptItem) => <TranscriptRow item={item}
    expanded={expandedRows.current.get(item.id)} onExpandedChange={handleExpandedChange}
    editing={editingUser === item.id} draft={editingUser === item.id ? userDraft : ""}
    onDraftChange={setUserDraft} onStartEdit={startEdit} onCancelEdit={cancelEdit} onEditUser={onEditUser} />,
    [handleExpandedChange, editingUser, userDraft, startEdit, cancelEdit, onEditUser]);

  return (
    <div className={`virtualized-transcript-container ${inline ? "transcript-inline" : ""} ${compact ? "transcript-compact" : ""} ${className}`}>
      <div
        ref={containerRef}
        className="transcript-scroll-area"
        style={{ overflowAnchor: "none", minHeight: inline || compact ? 0 : 200 }}
      >
        {!output && items.length === 0 && emptyText && <div className="transcript-empty-state"><Terminal size={22} /><p>{emptyText}</p></div>}
        {sharedViewport ? <VirtualizedList items={items} renderRow={renderRow} /> :
          <div style={{ flexShrink: 0, paddingTop: `${paddingTop}px`, paddingBottom: `${paddingBottom}px` }}>
            {visibleItems.map(item => <MeasuredRow key={item.id} id={item.id} measure={measure}>{renderRow(item)}</MeasuredRow>)}
          </div>}
      </div>
    </div>
  );
});

export default VirtualizedTranscript;
