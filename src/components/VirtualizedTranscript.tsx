import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { TranscriptItem } from "../types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ToolCallCard } from "./ToolCallCard";
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
      setItemsVersion((v) => v + 1);
      return;
    }

    // If output was cleared or replaced with a completely different shorter string
    if (output.length < lastProcessedPosRef.current) {
      lastProcessedPosRef.current = 0;
      itemsRef.current = [];
      pendingToolsRef.current.clear();
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

        // Assistant streaming text delta
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent?.type === "text_delta"
        ) {
          const delta = event.assistantMessageEvent.delta;
          const lastItem = currentItems[currentItems.length - 1];
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

          if (matched) {
            matched.result = resultText;
            matched.isError = event.isError || event.result?.isError || false;
            matched.status = matched.isError ? "error" : "success";
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
                currentItems[i].isError = event.isError || event.result?.isError || false;
                currentItems[i].status = currentItems[i].isError ? "error" : "success";
                break;
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
