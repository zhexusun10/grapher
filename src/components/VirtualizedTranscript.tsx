import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { TranscriptItem } from "../types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";
import { ArrowDown, Terminal } from "lucide-react";

interface VirtualizedTranscriptProps {
  output: string;
  className?: string;
  emptyText?: string;
}

const ESTIMATED_ITEM_HEIGHT = 72;
const OVERSCAN = 6;

export const VirtualizedTranscript: React.FC<VirtualizedTranscriptProps> = ({
  output,
  className = "",
  emptyText = "工作区就绪，等待节点指令输出…",
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // Incremental parse state
  const lastProcessedPosRef = useRef<number>(0);
  const itemsRef = useRef<TranscriptItem[]>([]);
  const pendingToolsRef = useRef<Map<string, TranscriptItem>>(new Map());
  const inTagThinkingRef = useRef<boolean>(false);
  const [itemsVersion, setItemsVersion] = useState(0);

  // Height cache for virtualization
  const itemHeightsRef = useRef<Map<string, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  // Incrementally parse output as it arrives
  useEffect(() => {
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

    // Find the last newline to ensure we only process complete lines
    const lastNewlineIdx = unparsed.lastIndexOf("\n");
    if (lastNewlineIdx === -1) return; // Wait for complete line

    const chunkToProcess = unparsed.slice(0, lastNewlineIdx + 1);
    lastProcessedPosRef.current += chunkToProcess.length;

    const lines = chunkToProcess.split("\n");
    const currentItems = itemsRef.current;
    const pendingTools = pendingToolsRef.current;

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

  // Handle auto-scrolling
  const items = itemsRef.current;
  useEffect(() => {
    if (!isUserScrolledUpRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [itemsVersion]);

  // Track container height & scroll position
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateDimensions = () => {
      setContainerHeight(el.clientHeight || 600);
    };
    updateDimensions();

    const resizeObserver = new ResizeObserver(updateDimensions);
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const currentScrollTop = el.scrollTop;
    setScrollTop(currentScrollTop);

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isUp = distanceFromBottom > 64;
    isUserScrolledUpRef.current = isUp;
    setShowScrollBottom(isUp);
  }, []);

  const scrollToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
      isUserScrolledUpRef.current = false;
      setShowScrollBottom(false);
    }
  };

  // Virtualization calculations
  const totalCount = items.length;
  const isVirtual = totalCount > 35;

  const { visibleItems, paddingTop, paddingBottom } = useMemo(() => {
    if (!isVirtual) {
      return {
        visibleItems: items.map((item, idx) => ({ item, index: idx })),
        paddingTop: 0,
        paddingBottom: 0,
      };
    }

    const startIndex = Math.max(0, Math.floor(scrollTop / ESTIMATED_ITEM_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(containerHeight / ESTIMATED_ITEM_HEIGHT) + OVERSCAN * 2;
    const endIndex = Math.min(totalCount, startIndex + visibleCount);

    const topPad = startIndex * ESTIMATED_ITEM_HEIGHT;
    const bottomPad = Math.max(0, (totalCount - endIndex) * ESTIMATED_ITEM_HEIGHT);

    const slice = items.slice(startIndex, endIndex).map((item, idx) => ({
      item,
      index: startIndex + idx,
    }));

    return {
      visibleItems: slice,
      paddingTop: topPad,
      paddingBottom: bottomPad,
    };
  }, [items, isVirtual, scrollTop, containerHeight, totalCount]);

  if (!output && items.length === 0) {
    return (
      <div className="transcript-empty-state">
        <Terminal size={22} />
        <p>{emptyText}</p>
      </div>
    );
  }

  return (
    <div className={`virtualized-transcript-container ${className}`}>
      <div
        ref={containerRef}
        className="transcript-scroll-area"
        onScroll={handleScroll}
      >
        <div style={{ paddingTop: `${paddingTop}px`, paddingBottom: `${paddingBottom}px` }}>
          {visibleItems.map(({ item }) => {
            if (item.type === "tool_call") {
              return (
                <div key={item.id} className="transcript-row tool-row">
                  <ToolCallCard item={item} />
                </div>
              );
            }

            if (item.type === "thinking") {
              return (
                <div key={item.id} className="transcript-row thinking-row">
                  <ThinkingCard item={item} isStreaming={item.status === "running"} />
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
          })}
        </div>
      </div>

      {showScrollBottom && (
        <button
          className="scroll-to-bottom-btn"
          onClick={scrollToBottom}
          title="回到底部最新输出"
        >
          <ArrowDown size={14} />
          <span>最新</span>
        </button>
      )}
    </div>
  );
};

export default VirtualizedTranscript;
