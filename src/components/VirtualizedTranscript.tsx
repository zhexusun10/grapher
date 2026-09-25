import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from "react";
import { rowOffsets, rowAt, visibleRows } from "../services/transcriptLayout";
import { TranscriptItem } from "../types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";
import { Terminal } from "lucide-react";

interface VirtualizedTranscriptProps {
  output: string;
  className?: string;
  emptyText?: string;
  onUserResize?: (expanded?: boolean, card?: HTMLElement) => void;
  // Historical conversations share the workbench scroll area with the summary.
  // They must render in document flow rather than virtualizing against that
  // scroll area's unrelated coordinates.
  inline?: boolean;
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


export const VirtualizedTranscript: React.FC<VirtualizedTranscriptProps> = ({
  output,
  className = "",
  emptyText = "工作区就绪，等待节点指令输出…",
  onUserResize,
  inline = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const expandedRows = useRef(new Map<string, boolean>());
  const isUserScrolledUpRef = useRef(false);
  const suppressAutoFollowRef = useRef(false);
  const resumeAutoFollowFrameRef = useRef<number | null>(null);

  // Incremental parse state
  const lastProcessedPosRef = useRef<number>(0);
  const itemsRef = useRef<TranscriptItem[]>([]);
  const pendingToolsRef = useRef<Map<string, TranscriptItem>>(new Map());
  const inTagThinkingRef = useRef<boolean>(false);
  const [itemsVersion, setItemsVersion] = useState(0);

  // Height cache for virtualization
  const itemHeightsRef = useRef<Map<string, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [heightVersion, setHeightVersion] = useState(0);
  const [, setExpansionVersion] = useState(0);
  const layoutRef = useRef({ ids: [] as string[], offsets: [0] });
  const prevOffsetsRef = useRef<number[]>([0]);

  // Schedule a single heightVersion bump per microtask batch.
  // Microtasks fire before the browser paints (unlike RAF which fires
  // after paint), so the re-render with corrected offsets happens in
  // the same frame as the DOM measurements, eliminating flicker.
  const heightFlushScheduledRef = useRef(false);

  const measure = useCallback((id: string, height: number) => {
    if (height <= 0 || itemHeightsRef.current.get(id) === height) return;
    itemHeightsRef.current.set(id, height);
    if (!heightFlushScheduledRef.current) {
      heightFlushScheduledRef.current = true;
      queueMicrotask(() => {
        heightFlushScheduledRef.current = false;
        setHeightVersion(value => value + 1);
      });
    }
  }, []);
  const [containerHeight, setContainerHeight] = useState(600);

  // Incrementally parse output as it arrives synchronously before paint
  useLayoutEffect(() => {
    if (!output) {
      lastProcessedPosRef.current = 0;
      itemsRef.current = [];
      pendingToolsRef.current.clear();
      inTagThinkingRef.current = false;
      setItemsVersion((v) => v + 1);
      return;
    }

    // If output was cleared or replaced with a completely different shorter string
    if (output.length < lastProcessedPosRef.current) {
      lastProcessedPosRef.current = 0;
      itemsRef.current = [];
      pendingToolsRef.current.clear();
      inTagThinkingRef.current = false;
    }

    const unparsed = output.slice(lastProcessedPosRef.current);
    if (!unparsed) return;

    // Process all complete lines, plus keep any trailing incomplete line in lastProcessedPos
    const lastNewlineIdx = unparsed.lastIndexOf("\n");
    if (lastNewlineIdx === -1) return; // Wait for at least one complete line

    const chunkToProcess = unparsed.slice(0, lastNewlineIdx + 1);
    lastProcessedPosRef.current += chunkToProcess.length;

    const lines = chunkToProcess.split("\n");
    // Each parsed chunk publishes new item identities. Memoized tool/thinking
    // cards must see streamed content and status changes, not mutated old props.
    const currentItems = itemsRef.current.map(item => ({ ...item }));
    itemsRef.current = currentItems;
    const pendingTools = new Map(currentItems
      .filter(item => item.type === "tool_call" && item.status === "running" && item.toolCallId)
      .map(item => [item.toolCallId!, item]));
    pendingToolsRef.current = pendingTools;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      try {
        const event = JSON.parse(line);

        // Assistant streaming thinking delta (native protocol)
        if (
          event.type === "message_update" &&
          (event.assistantMessageEvent?.type === "thinking_start" ||
            event.assistantMessageEvent?.type === "thinking_delta")
        ) {
          const delta = event.assistantMessageEvent.delta || "";
          const lastItem = currentItems[currentItems.length - 1];
          if (lastItem && lastItem.type === "thinking" && lastItem.status === "running") {
            lastItem.content = (lastItem.content || "") + delta;
          } else {
            currentItems.push({
              id: `think_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              type: "thinking",
              role: "assistant",
              content: delta,
              status: "running",
              timestamp: Date.now(),
            });
          }
          continue;
        }

        if (
          event.type === "message_update" &&
          event.assistantMessageEvent?.type === "thinking_end"
        ) {
          const lastItem = currentItems[currentItems.length - 1];
          if (lastItem && lastItem.type === "thinking") {
            lastItem.status = "success";
          }
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
                      id: `think_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
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
                      id: `think_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
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
                    if (lastItem && lastItem.type === "text" && lastItem.role === "assistant") {
                      lastItem.content = (lastItem.content || "") + textBefore;
                    } else {
                      currentItems.push({
                        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
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
                  if (lastItem && lastItem.type === "text" && lastItem.role === "assistant") {
                    lastItem.content = (lastItem.content || "") + remaining;
                  } else {
                    currentItems.push({
                      id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
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

          if (lastItem && lastItem.type === "text" && lastItem.role === "assistant") {
            lastItem.content = (lastItem.content || "") + delta;
          } else {
            currentItems.push({
              id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
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
          const lastItem = currentItems[currentItems.length - 1];
          if (lastItem && lastItem.type === "thinking" && lastItem.status === "running") {
            lastItem.status = "success";
          }
          inTagThinkingRef.current = false;

          const toolItem: TranscriptItem = {
            id: event.toolCallId || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            type: "tool_call",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args || {},
            status: "running",
            timestamp: Date.now(),
          };
          currentItems.push(toolItem);
          if (event.toolCallId) {
            pendingTools.set(event.toolCallId, toolItem);
          }
          continue;
        }

        // Tool execution end
        if (event.type === "tool_execution_end") {
          const matched = event.toolCallId ? pendingTools.get(event.toolCallId) : null;
          const resultText = (event.result?.content ?? [])
            .filter((item: { type: string }) => item.type === "text")
            .map((item: { text: string }) => item.text)
            .join("\n");

          const rawExitCode = event.result?.details?.exitCode;
          const exitCode = typeof rawExitCode === "number" ? rawExitCode : null;
          const isError = !!(event.isError || event.result?.isError || (exitCode !== null && exitCode !== 0));
          const truncated = !!(
            event.result?.details?.truncation?.truncated ||
            event.result?.details?.truncated ||
            resultText.includes("[Showing lines") ||
            resultText.includes("Full output:")
          );

          if (matched) {
            matched.result = resultText;
            matched.exitCode = exitCode;
            matched.truncated = truncated;
            matched.isError = isError;
            matched.status = isError ? "error" : "success";
            if (event.toolCallId) pendingTools.delete(event.toolCallId);
          } else {
            // Find in currentItems from end
            for (let i = currentItems.length - 1; i >= 0; i--) {
              if (
                currentItems[i].type === "tool_call" &&
                currentItems[i].toolName === event.toolName &&
                currentItems[i].status === "running"
              ) {
                currentItems[i].result = resultText;
                currentItems[i].exitCode = exitCode;
                currentItems[i].truncated = truncated;
                currentItems[i].isError = isError;
                currentItems[i].status = isError ? "error" : "success";
                break;
              }
            }
          }
          continue;
        }

        // Message end
        if (event.type === "message_end") {
          const lastItem = currentItems[currentItems.length - 1];
          if (lastItem && lastItem.type === "thinking" && lastItem.status === "running") {
            lastItem.status = "success";
          }
          inTagThinkingRef.current = false;

          // Backfill thinking if message has thinking content and it wasn't captured from stream deltas
          const message = event.message;
          if (message && Array.isArray(message.content)) {
            for (const c of message.content) {
              if (c.type === "thinking" && c.thinking) {
                const hasThinking = currentItems.some((i) => i.type === "thinking" && i.content === c.thinking);
                if (!hasThinking) {
                  currentItems.push({
                    id: `think_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    type: "thinking",
                    role: "assistant",
                    content: c.thinking,
                    status: "success",
                    timestamp: Date.now(),
                  });
                }
              }
            }
          }
          continue;
        }

        // Session start or system info - kept in workspace details, not in chat transcript
        if (event.type === "session") {
          continue;
        }

        // Grapher process lifecycle - kept in workspace details, not in chat transcript
        if (event.type === "grapher_process_started" || event.type === "grapher_process_exited") {
          continue;
        }

        // Fallback for unrecognized json event
      } catch {
        // Plain text line (e.g. stderr or stdout raw logs)
        if (line.startsWith("[stderr]")) {
          if (
            line.includes("No project session found with id") &&
            line.includes("creating a new session with that id")
          ) {
            continue;
          }
          currentItems.push({
            id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            type: "system",
            content: line,
            isError: true,
            timestamp: Date.now(),
          });
        } else {
          const lastItem = currentItems[currentItems.length - 1];
          if (lastItem && lastItem.type === "text" && lastItem.role === "assistant") {
            lastItem.content = (lastItem.content || "") + "\n" + line;
          } else {
            currentItems.push({
              id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              type: "text",
              role: "assistant",
              content: line,
              timestamp: Date.now(),
            });
          }
        }
      }
    }

    setItemsVersion((v) => v + 1);
  }, [output]);

  const items = itemsRef.current;

  const touchStartYRef = useRef(0);

  const syncScrollState = useCallback(() => {
    const scrollParent = getScrollParent(containerRef.current) || containerRef.current;
    if (!scrollParent) return;

    const currentScrollTop = scrollParent.scrollTop;
    const distanceFromBottom = scrollParent.scrollHeight - currentScrollTop - scrollParent.clientHeight;
    const isUserAwayFromBottom = distanceFromBottom > 24;
    setScrollTop(currentScrollTop);
    if (!isUserAwayFromBottom) {
      isUserScrolledUpRef.current = false;
    } else {
      isUserScrolledUpRef.current = true;
    }
  }, []);

  const handleExpandedChange = useCallback((id: string, expanded: boolean, card?: HTMLElement) => {
    expandedRows.current.set(id, expanded);
    suppressAutoFollowRef.current = true;
    isUserScrolledUpRef.current = true;
    setExpansionVersion(value => value + 1);
    onUserResize?.(expanded, card);

    if (resumeAutoFollowFrameRef.current !== null) {
      cancelAnimationFrame(resumeAutoFollowFrameRef.current);
    }
    resumeAutoFollowFrameRef.current = requestAnimationFrame(() => {
      resumeAutoFollowFrameRef.current = requestAnimationFrame(() => {
        resumeAutoFollowFrameRef.current = null;
        suppressAutoFollowRef.current = false;
        syncScrollState();
      });
    });
  }, [onUserResize, syncScrollState]);

  useEffect(() => () => {
    if (resumeAutoFollowFrameRef.current !== null) {
      cancelAnimationFrame(resumeAutoFollowFrameRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (inline) return;
    if (containerRef.current) {
      const scrollParent = getScrollParent(containerRef.current) || containerRef.current;
      if (scrollParent) {
        if (scrollParent.clientHeight && scrollParent.clientHeight !== containerHeight) {
          setContainerHeight(scrollParent.clientHeight);
        }
        if (!isUserScrolledUpRef.current && !suppressAutoFollowRef.current) {
          scrollParent.scrollTop = scrollParent.scrollHeight;
          requestAnimationFrame(() => {
            if (!isUserScrolledUpRef.current && !suppressAutoFollowRef.current && containerRef.current) {
              const sp = getScrollParent(containerRef.current) || containerRef.current;
              if (sp) {
                sp.scrollTop = sp.scrollHeight;
                setScrollTop(sp.scrollTop);
              }
            }
          });
        }
        setScrollTop(scrollParent.scrollTop);
      }
    }
  }, [itemsVersion, heightVersion, containerHeight, inline]);

  // Track container height & scroll position
  useEffect(() => {
    const el = containerRef.current;
    if (!el || inline) return;
    
    const scrollParent = getScrollParent(el) || el;

    const updateDimensions = () => {
      setContainerHeight(scrollParent.clientHeight || 600);
    };
    updateDimensions();

    const resizeObserver = new ResizeObserver(updateDimensions);
    resizeObserver.observe(scrollParent);
    
    const onScroll = () => syncScrollState();
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -1) {
        isUserScrolledUpRef.current = true;
      } else if (e.deltaY > 1) {
        const dist = scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight;
        if (dist <= 24) {
          isUserScrolledUpRef.current = false;
        }
      }
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches[0]) touchStartYRef.current = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0] && e.touches[0].clientY - touchStartYRef.current > 2) {
        isUserScrolledUpRef.current = true;
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
  }, [syncScrollState, inline]);

  // Virtualization calculations
  const totalCount = items.length;
  const isVirtual = !inline && totalCount > 35;

  const offsets = useMemo(() => rowOffsets(items.map(item => item.id), itemHeightsRef.current), [items, heightVersion]);
  layoutRef.current = { ids: items.map(item => item.id), offsets };
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
      const viewportTopRow = rowAt(prev, scrollParent.scrollTop);
      // Compute how much the offset of that row shifted
      if (viewportTopRow < offsets.length - 1 && viewportTopRow < prev.length - 1) {
        const delta = offsets[viewportTopRow] - prev[viewportTopRow];
        if (delta !== 0) {
          scrollParent.scrollTop += delta;
        }
      }
    }
    prevOffsetsRef.current = offsets;
  }, [offsets]);

  const targetScrollTop = isUserScrolledUpRef.current
    ? scrollTop
    : Math.max(0, totalOffsetsHeight - containerHeight);
  const { visibleItems, paddingTop, paddingBottom } = useMemo(() => {
    const range = isVirtual ? visibleRows(offsets, targetScrollTop, containerHeight, 30)
      : { start: 0, end: totalCount, paddingTop: 0, paddingBottom: 0 };
    return { visibleItems: items.slice(range.start, range.end), ...range };
  }, [items, offsets, isVirtual, targetScrollTop, containerHeight, totalCount]);

  return (
    <div className={`virtualized-transcript-container ${inline ? "transcript-inline" : ""} ${className}`}>
      <div
        ref={containerRef}
        className="transcript-scroll-area"
        style={{ overflowAnchor: "none", minHeight: 200 }}
      >
        {!output && items.length === 0 && emptyText && <div className="transcript-empty-state"><Terminal size={22} /><p>{emptyText}</p></div>}
        <div style={{ flexShrink: 0, paddingTop: `${paddingTop}px`, paddingBottom: `${paddingBottom}px` }}>
          {visibleItems.map(item => <MeasuredRow key={item.id} id={item.id} measure={measure}>{(() => {
            if (item.type === "tool_call") {
              return (
                <div key={item.id} className="transcript-row tool-row">
                  <ToolCallCard item={item} expanded={expandedRows.current.get(item.id)}
                    onExpandedChange={(expanded, card) => handleExpandedChange(item.id, expanded, card)} />
                </div>
              );
            }

            if (item.type === "thinking") {
              return (
                <div key={item.id} className="transcript-row thinking-row">
                  <ThinkingCard item={item} isStreaming={item.status === "running"}
                    expanded={expandedRows.current.get(item.id)}
                    onExpandedChange={expanded => handleExpandedChange(item.id, expanded)} />
                </div>
              );
            }

            if (item.type === "system") {
              return (
                <div
                  key={item.id}
                  className={`transcript-row system-row ${item.isError ? "error" : ""}`}
                >
                  <span className="system-pill">{item.content}</span>
                </div>
              );
            }

            return (
              <div key={item.id} className={`transcript-row text-row ${item.role || "assistant"}`}>
                <div className="transcript-message-bubble">
                  <MarkdownRenderer content={item.content || ""} isStreaming={true} />
                </div>
              </div>
            );
          })()}</MeasuredRow>)}
        </div>
      </div>
    </div>
  );
};

export default VirtualizedTranscript;
