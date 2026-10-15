import { t } from "../i18n";
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from "react";
import { rowOffsets, rowAt, visibleRows } from "../services/transcriptLayout";
import { TranscriptItem } from "../types";
import { closeThinkingItems, finalizeThinkingItems, updateThinkingItems } from "../services/thinkingTranscript";
import { settleInterruptedItems } from "../services/transcriptSettle";
import { Terminal } from "lucide-react";
import { shareJson } from "../services/structuralSharing";
import { stripPlannerContext } from "../services/plannerText";
import { VirtualizedList } from "./VirtualizedList";
import { TranscriptRow } from "./TranscriptRow";
import { utf8Bytes } from "../lib/BoundedLruCache";
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

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "text")
    .map((part: any) => typeof part.text === "string" ? part.text : "").join("\n");
}

function outputText(result: any): string {
  return textContent(result?.content);
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
      if (lastProcessedPosRef.current > 0 || itemsRef.current.length > 0) {
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
        return true;
      }
      return false;
    }

    const parseOptions = `${showUserTurns}:${skipFirstUser}`;
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

    let lineOffset = byteOffsetRef.current;
    let localId = 0;
    const rowId = (type: string) => `${type}_${sourceRef.current}_${lineOffset}_${localId++}`;
    const addToolCall = (toolCallId: string | undefined, toolName: string, args: Record<string, any>, status: "running" | "success" = "running") => {
      const existing = toolCallId
        ? currentItems.find(item => item.type === "tool_call" && item.toolCallId === toolCallId)
        : undefined;
      const item = existing
        ? { ...existing, toolName, args: Object.keys(args).length ? args : existing.args, status: existing.result !== undefined ? existing.status : status }
        : {
            id: toolCallId || rowId("tool"),
            type: "tool_call" as const, toolName, toolCallId, args, status, timestamp: Date.now(),
          };
      if (existing) currentItems[currentItems.indexOf(existing)] = item;
      else currentItems.push(item);
      if (toolCallId && item.status === "running") pendingTools.set(toolCallId, item);
      else if (toolCallId) pendingTools.delete(toolCallId);
      return item;
    };

    const settleToolCall = (toolCallId: string | undefined, toolName: string, result: any, isError: boolean) => {
      const matched = (toolCallId ? currentItems.find(item => item.type === "tool_call" && item.toolCallId === toolCallId)
        : [...currentItems].reverse().find(item => item.type === "tool_call" && item.toolName === toolName && item.status === "running")) ??
        addToolCall(toolCallId, toolName, {});
      // A tail page can contain the result without the earlier start event.
      // It still owns a tool card; older pages will backfill its arguments.
      const resultText = outputText(result);
      const rawExitCode = result?.details?.exitCode;
      const exitCode = typeof rawExitCode === "number" ? rawExitCode : null;
      const failed = isError || result?.isError || (exitCode !== null && exitCode !== 0);
      const updated = {
        ...matched,
        result: resultText,
        exitCode,
        truncated: !!(result?.details?.truncation?.truncated || result?.details?.truncated ||
          resultText.includes("[Showing lines") || resultText.includes("Full output:")),
        isError: !!failed,
        status: failed ? "error" as const : "success" as const,
      };
      currentItems[currentItems.indexOf(matched)] = updated;
      if (toolCallId) pendingTools.delete(toolCallId);
    };

    const pushSessionMessage = (message: any, entryId?: string) => {
      if (!message || typeof message !== "object") return;
      if (message.role === "user") {
        if (!showUserTurns) return;
        const text = stripPlannerContext(textContent(message.content)).trim();
        if (!text || (entryId && currentItems.some(item => item.id === `session_user_${entryId}`))) return;
        const first = !seenFirstUserRef.current;
        seenFirstUserRef.current = true;
        if (first && skipFirstUser) return;
        currentItems.push({ id: `session_user_${entryId || rowId("user")}`, type: "text", role: "user", content: text, timestamp: Date.now() });
        return;
      }
      if (message.role === "toolResult") {
        const result = { content: message.content, details: message.details, isError: message.isError };
        settleToolCall(message.toolCallId, message.toolName || "tool", result, !!message.isError);
        return;
      }
      if (message.role !== "assistant" || !Array.isArray(message.content)) return;
      currentItems = closeThinkingItems(currentItems);
      assistantStartIndexRef.current = currentItems.length;
      for (const part of message.content) {
        if (part?.type === "toolCall") {
          addToolCall(part.id, part.name || "tool", part.arguments || {});
        } else if (part?.type === "thinking" && part.thinking?.trim()) {
          currentItems.push({ id: rowId("think"), type: "thinking", role: "assistant", content: part.thinking, status: "success", timestamp: Date.now() });
        } else if (part?.type === "text" && typeof part.text === "string" && part.text) {
          currentItems.push({ id: rowId("text"), type: "text", role: "assistant", content: part.text, timestamp: Date.now() });
        }
      }
    };

    for (const rawLine of lines) {
      lineOffset = byteOffsetRef.current;
      byteOffsetRef.current += utf8Bytes(rawLine) + 1;
      localId = 0;
      const line = rawLine.trim();
      if (!line) continue;
      const leadingFragment = leadingFragmentRef.current;
      leadingFragmentRef.current = false;
      let parsedJson = false;
      try {
        const event = JSON.parse(line);
        parsedJson = true;
        if (!event || typeof event !== "object") continue;
        if (event.type === "grapher_planning_source") {
          sourceRef.current = event.planningId || "planner";
          byteOffsetRef.current = event.startOffset ?? 0;
          leadingFragmentRef.current = byteOffsetRef.current > 0;
          currentItems = closeThinkingItems(currentItems);
          assistantStartIndexRef.current = currentItems.length;
          continue;
        }
        inFinalResponseRef.current = false;
        finalResponseSuppressedRef.current = false;

        // Planner follow-ups live in its durable JSONL, not in the Run's
        // transient browser messages. The first user turn is already shown as
        // the original goal (except for manually created graphs).
        if (showUserTurns && (event.type === "message_start" || event.type === "message_end") && event.message?.role === "user") {
          const messageId = event.message.id;
          if (event.type === "message_end") {
            if (pendingUserStartRef.current || (messageId && userMessageStartsRef.current.has(messageId))) {
              pendingUserStartRef.current = false;
              continue;
            }
          } else {
            pendingUserStartRef.current = true;
            if (messageId) userMessageStartsRef.current.add(messageId);
          }
          const first = !seenFirstUserRef.current;
          seenFirstUserRef.current = true;
          if (first && skipFirstUser) continue;
          const content = event.message.content;
          const text = textContent(content);
          const display = stripPlannerContext(text).trim();
          if (display.trim()) currentItems.push({
            id: messageId ? `user_${messageId}` : rowId("user"),
            type: "text", role: "user", content: display, timestamp: Date.now(),
          });
          continue;
        }

        if (event.type === "message") {
          pushSessionMessage(event.message, event.id);
          continue;
        }

        if (event.type === "message_start" && event.message?.role === "assistant") {
          currentItems = closeThinkingItems(currentItems);
          assistantStartIndexRef.current = currentItems.length;
          continue;
        }

        const thinkingEvent = event.assistantMessageEvent;
        if (event.type === "message_update" && thinkingEvent?.type === "toolcall_start") {
          const tool = thinkingEvent.partial?.content?.[thinkingEvent.contentIndex];
          addToolCall(thinkingEvent.id || tool?.id, thinkingEvent.toolName || tool?.name || "tool", thinkingEvent.arguments || tool?.arguments || {});
          continue;
        }

        if (event.type === "message_update" && thinkingEvent?.type === "toolcall_end" && thinkingEvent.toolCall) {
          const tool = thinkingEvent.toolCall;
          addToolCall(tool.id, tool.name || "tool", tool.arguments || {});
          continue;
        }

        if (event.type === "message_update" &&
          ["thinking_start", "thinking_delta", "thinking_end"].includes(thinkingEvent?.type)) {
          const thinkId = rowId("think");
          currentItems = updateThinkingItems(currentItems, thinkingEvent, assistantStartIndexRef.current, thinkId);
          continue;
        }

        // Assistant streaming text delta (or inline tag thinking fallback)
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent?.type === "text_delta"
        ) {
          const delta = event.assistantMessageEvent.delta || "";

          // Check for inline <think> or </think> or <thought> tags
          if (inTagThinkingRef.current || delta.includes("<think>") || delta.includes("<thought>")) {
            let remaining = delta;
            while (remaining.length > 0) {
              if (inTagThinkingRef.current) {
                const endTag = remaining.includes("</think>") ? "</think>" : remaining.includes("</thought>") ? "</thought>" : null;
                if (endTag) {
                  const endIdx = remaining.indexOf(endTag);
                  const thinkText = remaining.slice(0, endIdx);
                  const lastItem = currentItems[currentItems.length - 1];
                  if (lastItem && lastItem.type === "thinking") {
                    lastItem.content = (lastItem.content || "") + thinkText;
                    lastItem.status = "success";
                  } else if (thinkText) {
                    currentItems.push({
                      id: rowId("think"),
                      type: "thinking",
                      role: "assistant",
                      content: thinkText,
                      status: "success",
                      timestamp: Date.now(),
                    });
                  }
                  inTagThinkingRef.current = false;
                  remaining = remaining.slice(endIdx + endTag.length);
                } else {
                  const lastItem = currentItems[currentItems.length - 1];
                  if (lastItem && lastItem.type === "thinking" && lastItem.status === "running") {
                    lastItem.content = (lastItem.content || "") + remaining;
                  } else {
                    currentItems.push({
                      id: rowId("think"),
                      type: "thinking",
                      role: "assistant",
                      content: remaining,
                      status: "running",
                      timestamp: Date.now(),
                    });
                  }
                  remaining = "";
                }
              } else {
                const startTag = remaining.includes("<think>") ? "<think>" : remaining.includes("<thought>") ? "<thought>" : null;
                if (startTag) {
                  const startIdx = remaining.indexOf(startTag);
                  const textBefore = remaining.slice(0, startIdx);
                  if (textBefore) {
                    const lastItem = currentItems[currentItems.length - 1];
                    if (lastItem && lastItem.type === "text" && lastItem.role === "assistant" && !lastItem.rawOutput) {
                      lastItem.content = (lastItem.content || "") + textBefore;
                    } else {
                      currentItems.push({
                        id: rowId("text"),
                        type: "text",
                        role: "assistant",
                        content: textBefore,
                        timestamp: Date.now(),
                      });
                    }
                  }
                  inTagThinkingRef.current = true;
                  remaining = remaining.slice(startIdx + startTag.length);
                } else {
                  const lastItem = currentItems[currentItems.length - 1];
                  if (lastItem && lastItem.type === "text" && lastItem.role === "assistant" && !lastItem.rawOutput) {
                    lastItem.content = (lastItem.content || "") + remaining;
                  } else {
                    currentItems.push({
                      id: rowId("text"),
                      type: "text",
                      role: "assistant",
                      content: remaining,
                      timestamp: Date.now(),
                    });
                  }
                  remaining = "";
                }
              }
            }
            continue;
          }

          // If last item was thinking with running status, close it
          const lastItem = currentItems[currentItems.length - 1];
          if (lastItem && lastItem.type === "thinking" && lastItem.status === "running") {
            lastItem.status = "success";
          }

          if (lastItem && lastItem.type === "text" && lastItem.role === "assistant" && !lastItem.rawOutput) {
            lastItem.content = (lastItem.content || "") + delta;
          } else {
            currentItems.push({
              id: rowId("text"),
              type: "text",
              role: "assistant",
              content: delta,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        // Tool execution start
        if (event.type === "tool_execution_start") {
          currentItems = closeThinkingItems(currentItems);
          inTagThinkingRef.current = false;
          const toolItem = addToolCall(event.toolCallId, event.toolName || "tool", event.args || {});
          if (event.toolCallId) pendingTools.set(event.toolCallId, toolItem);
          continue;
        }

        if (event.type === "tool_execution_end") {
          settleToolCall(event.toolCallId, event.toolName || "tool", event.result, !!event.isError);
          continue;
        }

        // Message end
        if (event.type === "message_end") {
          const lastItem = currentItems[currentItems.length - 1];
          if (lastItem && lastItem.type === "thinking" && lastItem.status === "running") {
            lastItem.status = "success";
          }
          inTagThinkingRef.current = false;

          const message = event.message;
          // A failed model call must stay visible in the durable replay, not
          // only in the live SSE stream (e.g. after a reload).
          if (message?.role === "assistant" &&
              (message.stopReason === "error" || message.stopReason === "aborted") && message.errorMessage) {
            currentItems.push({
              id: rowId("system"),
              type: "system", role: "assistant", content: message.errorMessage, isError: true,
              status: "error", timestamp: Date.now(),
            });
          }
          if (message?.role === "assistant" && Array.isArray(message.content)) {
            currentItems = finalizeThinkingItems(currentItems, message.content, assistantStartIndexRef.current);
            for (const part of message.content) {
              if (part?.type === "toolCall") addToolCall(part.id, part.name || "tool", part.arguments || {});
            }
            // Some saved sessions have only message_end (no text_delta), or
            // were interrupted mid-stream. Recover the final assistant text.
            const fullText = message.content.filter((c: { type: string }) => c.type === "text")
              .map((c: { text?: string }) => c.text || "").join("");
            const captured = currentItems.slice(assistantStartIndexRef.current)
              .filter(item => item.type === "text" && item.role === "assistant" && !item.rawOutput)
              .map(item => item.content || "").join("");
            const missing = fullText.startsWith(captured) ? fullText.slice(captured.length) : "";
            if (missing) currentItems.push({
              id: rowId("text"),
              type: "text", role: "assistant", content: missing, timestamp: Date.now(),
            });
          }
          if (message?.role === "assistant") assistantStartIndexRef.current = currentItems.length;
          continue;
        }

        // Session start or system info - kept in workspace details, not in chat transcript
        if (event.type === "session") {
          continue;
        }

        // Grapher process lifecycle - kept in workspace details, not in chat transcript
        if (event.type === "grapher_process_started" || event.type === "grapher_process_exited") {
          if (event.type === "grapher_process_exited") {
            currentItems = closeThinkingItems(currentItems);
            for (const toolCallId of pendingTools.keys()) {
              const index = currentItems.findIndex(item => item.type === "tool_call" && item.toolCallId === toolCallId);
              if (index >= 0) currentItems[index] = { ...currentItems[index], status: event.success ? "success" : "error", isError: !event.success };
            }
            pendingTools.clear();
          }
          continue;
        }

        // Fallback for unrecognized json event
      } catch {
        // Never turn a valid protocol record (or the first truncated JSONL
        // fragment of a tail) into an assistant plaintext bubble.
        if (parsedJson || leadingFragment) continue;
        const cleanLine = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
        if (cleanLine === "── Final response ──") {
          const lastUserIndex = currentItems.map(item => item.role).lastIndexOf("user");
          const currentTurnItems = lastUserIndex >= 0 ? currentItems.slice(lastUserIndex + 1) : currentItems;
          const hasStreamedAssistant = currentTurnItems.some(
            item => item.type === "text" && item.role === "assistant" && !item.rawOutput && Boolean(item.content?.trim())
          );
          finalResponseSuppressedRef.current = hasStreamedAssistant;
          inFinalResponseRef.current = true;
          continue;
        }

        if (inFinalResponseRef.current) {
          if (finalResponseSuppressedRef.current) {
            continue;
          }
          const lastItem = currentItems[currentItems.length - 1];
          if (lastItem && lastItem.type === "text" && lastItem.role === "assistant") {
            lastItem.content = (lastItem.content || "") + "\n" + line;
          } else {
            currentItems.push({
              id: rowId("text"),
              type: "text",
              role: "assistant",
              content: line,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        // Plain text line (e.g. stderr or stdout raw logs)
        if (line.startsWith("[stderr]")) {
          if (
            line.includes("No project session found with id") &&
            line.includes("creating a new session with that id")
          ) {
            continue;
          }
          currentItems.push({
            id: rowId("err"),
            type: "system",
            content: line,
            isError: true,
            timestamp: Date.now(),
          });
        } else {
          const lastItem = currentItems[currentItems.length - 1];
          if (lastItem && lastItem.type === "text" && lastItem.role === "assistant" && lastItem.rawOutput) {
            lastItem.content = (lastItem.content || "") + "\n" + line;
          } else {
            currentItems.push({
              id: rowId("text"),
              type: "text",
              role: "assistant",
              content: line,
              rawOutput: true,
              timestamp: Date.now(),
            });
          }
        }
      }
    }

    const previousIds = new Set(previousItems.map(item => item.id));
    currentItems = currentItems.map(item => {
      const isNewInLiveChunk = isIncrementalLive && !previousIds.has(item.id);
      if ((item.type === "thinking" || item.type === "tool_call") && item.animateAppear === undefined) {
        const shouldAnimate = !settled && (inline ? isNewInLiveChunk : (item.status === "running" || isNewInLiveChunk));
        item = { ...item, animateAppear: shouldAnimate };
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
  }, [showUserTurns, skipFirstUser, startOffset, settled]);

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
