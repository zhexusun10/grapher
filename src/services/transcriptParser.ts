import type { ImageAttachment, TranscriptItem } from "../types";
import { utf8Bytes } from "../lib/BoundedLruCache";
import { plannerContentSteerId, plannerContentText, stripPlannerContext } from "./plannerText";
import { closeThinkingItems, finalizeThinkingItems, updateThinkingItems } from "./thinkingTranscript";
import { toolOutputPreview, truncateToolArgs } from "./toolOutput";
import { findToolCallIndex, laterToolPhase, toolNameUpdate, type ToolCallPhase } from "./toolCallUpdates";

function imageContent(content: unknown): ImageAttachment[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const images = content.filter((part: any) => part?.type === "image" && typeof part.mimeType === "string" && typeof part.data === "string");
  return images.length ? images : undefined;
}

/** Parse state shared by the incremental parser and its callers. */
export interface ParseTranscriptChunkState {
  source: string;
  byteOffset: number;
  leadingFragment: boolean;
  inTagThinking: boolean;
  inFinalResponse: boolean;
  finalResponseSuppressed: boolean;
  seenFirstUser: boolean;
  pendingUserStart: boolean;
  assistantStartIndex: number;
  userMessageStarts: Set<string>;
  compacting: boolean;
}

// The runtime adds a trailing newline around its plain-text fallback. Ignore
// that framing, but preserve Markdown's meaningful internal whitespace.
function finalResponseText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Shared by incremental replay and transcript regression tests. */
export interface TranscriptParseOptions {
  showUserTurns: boolean;
  skipFirstUser: boolean;
  /** When set, only these normalized user texts become transcript rows. Node
   * transcripts use it to render steers inline without replaying the task and
   * continuation turns that the conversation chrome already owns. */
  userTurnTexts?: readonly string[];
}

/** Shared by incremental replay and transcript regression tests. */
export function parseTranscriptChunkLines(
  lines: string[],
  currentItems: TranscriptItem[],
  pendingTools: Map<string, TranscriptItem>,
  state: ParseTranscriptChunkState,
  options: TranscriptParseOptions,
  tailItems?: TranscriptItem[],
): { currentItems: TranscriptItem[]; endByteOffset: number; endSource: string } {
  let lineOffset = state.byteOffset;
  let localId = 0;
  const rowId = (type: string) => `${type}_${state.source}_${lineOffset}_${localId++}`;

  const appendFinalResponseLine = (line: string) => {
    if (state.finalResponseSuppressed) return;
    const lastItem = currentItems[currentItems.length - 1];
    if (lastItem?.finalResponseCopy?.source === state.source) {
      lastItem.content = (lastItem.content || "") + "\n" + line;
    } else {
      currentItems.push({
        id: rowId("text"), type: "text", role: "assistant", content: line,
        finalResponseCopy: { source: state.source, offset: lineOffset }, timestamp: Date.now(),
      });
    }
  };

  const retireFinalResponseCopy = (text: string) => {
    if (!tailItems || !text.trim()) return;
    let normalized: string | undefined;
    for (let index = tailItems.length - 1; index >= 0; index--) {
      const item = tailItems[index];
      const copy = item.finalResponseCopy;
      if (!copy || copy.source !== state.source || copy.offset <= lineOffset) continue;
      normalized ??= finalResponseText(text);
      if (finalResponseText(item.content || "") === normalized) tailItems.splice(index, 1);
    }
  };

  const addToolCall = (
    toolCallId: string | undefined,
    toolName: string,
    args: Record<string, any>,
    status: "running" | "success" = "running",
    flaggedTruncated = false,
    contentIndex?: number,
    phase?: ToolCallPhase,
  ) => {
    const boundedArgs = truncateToolArgs(args);
    args = boundedArgs.args;
    const argsTruncated = flaggedTruncated || boundedArgs.truncated;
    if (toolCallId && tailItems) {
      const existingInTail = tailItems.find(item => item.type === "tool_call" && item.toolCallId === toolCallId);
      if (existingInTail) {
        const updated = {
          ...existingInTail,
          toolName: toolNameUpdate(existingInTail.toolName, toolName),
          args: Object.keys(args).length ? args : existingInTail.args,
          argsTruncated: existingInTail.argsTruncated || argsTruncated || undefined,
          toolPhase: laterToolPhase(existingInTail.toolPhase, phase),
          status: existingInTail.result !== undefined ? existingInTail.status : status,
        };
        tailItems[tailItems.indexOf(existingInTail)] = updated;
        if (updated.status === "running") pendingTools.set(toolCallId, updated);
        else pendingTools.delete(toolCallId);
        return updated;
      }
    }
    const existingIndex = findToolCallIndex(currentItems, toolCallId || undefined, contentIndex, state.assistantStartIndex);
    const existing = existingIndex >= 0 ? currentItems[existingIndex] : undefined;
    const nextPhase = laterToolPhase(existing?.toolPhase, phase);
    const item = existing
      ? { ...existing, toolName: toolNameUpdate(existing.toolName, toolName),
          toolCallId: toolCallId || existing.toolCallId, toolContentIndex: contentIndex ?? existing.toolContentIndex,
          toolPhase: nextPhase, args: Object.keys(args).length ? args : existing.args,
          argsTruncated: existing.argsTruncated || argsTruncated || undefined,
          status: existing.result !== undefined ? existing.status : status }
      : {
          id: toolCallId || rowId("tool"),
          type: "tool_call" as const, toolName, toolCallId: toolCallId || undefined, toolContentIndex: contentIndex,
          toolPhase: phase, args, status, timestamp: Date.now(), argsTruncated: argsTruncated || undefined,
        };
    if (existing) currentItems[currentItems.indexOf(existing)] = item;
    else currentItems.push(item);
    if (toolCallId && item.status === "running") pendingTools.set(toolCallId, item);
    else if (toolCallId) pendingTools.delete(toolCallId);
    return item;
  };

  const settleToolCall = (
    toolCallId: string | undefined,
    toolName: string,
    result: any,
    isError: boolean,
    durationMs?: number,
  ) => {
    let matched: TranscriptItem | undefined;
    let inTail = false;
    if (toolCallId) {
      matched = currentItems.find(item => item.type === "tool_call" && item.toolCallId === toolCallId);
      if (!matched && tailItems) {
        matched = tailItems.find(item => item.type === "tool_call" && item.toolCallId === toolCallId);
        if (matched) inTail = true;
      }
    } else {
      matched = [...currentItems].reverse().find(item => item.type === "tool_call" && item.toolName === toolName && item.status === "running");
      if (!matched && tailItems) {
        matched = [...tailItems].reverse().find(item => item.type === "tool_call" && item.toolName === toolName && item.status === "running");
        if (matched) inTail = true;
      }
    }
    if (!matched) {
      matched = addToolCall(toolCallId, toolName, {});
    }

    const preview = toolOutputPreview(result?.content);
    const resultText = preview.text;
    const rawExitCode = result?.details?.exitCode;
    const exitCode = typeof rawExitCode === "number" ? rawExitCode : null;
    const failed = isError || result?.isError || (exitCode !== null && exitCode !== 0);
    const updated = {
      ...matched,
      result: resultText,
      exitCode,
      // Only the tool's own truncation (or its visible truncation notice)
      // belongs here. A bounded UI/log preview and the projection's
      // `details.truncated` marker must not imply the tool result itself was
      // truncated.
      truncated: !!(result?.details?.truncation?.truncated ||
        resultText.includes("[Showing lines") || resultText.includes("Full output:")),
      isError: !!failed,
      status: failed ? "error" as const : "success" as const,
      durationMs: typeof durationMs === "number" ? durationMs : matched.durationMs,
    };
    if (inTail && tailItems) {
      tailItems[tailItems.indexOf(matched)] = updated;
    } else {
      currentItems[currentItems.indexOf(matched)] = updated;
    }
    if (toolCallId) pendingTools.delete(toolCallId);
  };

  const pushSessionMessage = (message: any, entryId?: string) => {
    if (!message || typeof message !== "object") return;
    if (message.role === "user") {
      if (!options.showUserTurns) return;
      const steerId = plannerContentSteerId(message.content);
      const text = stripPlannerContext(plannerContentText(message.content)).trim();
      if (!text || (entryId && currentItems.some(item => item.id === `session_user_${entryId}`))) return;
      if (options.userTurnTexts && !options.userTurnTexts.includes(text)) return;
      const first = !state.seenFirstUser;
      state.seenFirstUser = true;
      if (first && options.skipFirstUser) return;
      currentItems.push({ id: steerId ? `msg-${steerId}` : `session_user_${entryId || rowId("user")}`, type: "text", role: "user", content: text, userTurnOffset: lineOffset, images: imageContent(message.content), timestamp: Date.now() });
      return;
    }
    if (message.role === "toolResult") {
      const result = { content: message.content, details: message.details, isError: message.isError };
      settleToolCall(message.toolCallId, message.toolName || "tool", result, !!message.isError, message.durationMs);
      return;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    currentItems = closeThinkingItems(currentItems);
    state.assistantStartIndex = currentItems.length;
    for (const part of message.content) {
      if (part?.type === "toolCall") {
        addToolCall(part.id, part.name || "tool", part.arguments || {}, "running", !!part.argsTruncated);
      } else if (part?.type === "thinking") {
        // Keep blocks whose text was private or encrypted: their card explains
        // that this reasoning produced no visible content.
        currentItems.push({ id: rowId("think"), type: "thinking", role: "assistant",
          content: typeof part.thinking === "string" ? part.thinking : "", status: "success", timestamp: Date.now() });
      } else if (part?.type === "text" && typeof part.text === "string" && part.text) {
        currentItems.push({ id: rowId("text"), type: "text", role: "assistant", content: part.text, timestamp: Date.now() });
      }
    }
    retireFinalResponseCopy(message.content.filter((part: any) => part?.type === "text")
      .map((part: any) => part.text || "").join(""));
  };

  for (const rawLine of lines) {
    lineOffset = state.byteOffset;
    state.byteOffset += utf8Bytes(rawLine) + 1;
    localId = 0;
    const line = rawLine.trim();
    if (!line && !state.inFinalResponse) continue;
    const leadingFragment = state.leadingFragment;
    state.leadingFragment = false;
    let parsedJson = false;
    try {
      const event = JSON.parse(line);
      // Final response is the terminal plain-text suffix of an execution, not
      // JSONL. Even valid JSON (including event-shaped examples) is Markdown
      // content here; only an explicit source boundary can resume event parsing.
      if (state.inFinalResponse && event?.type !== "grapher_planning_source") {
        appendFinalResponseLine(rawLine);
        continue;
      }
      parsedJson = true;
      if (!event || typeof event !== "object") continue;
      if (event.type === "grapher_planning_source") {
        state.source = event.planningId || "planner";
        state.byteOffset = event.startOffset ?? 0;
        state.leadingFragment = state.byteOffset > 0;
        state.inFinalResponse = false;
        state.finalResponseSuppressed = false;
        currentItems = closeThinkingItems(currentItems);
        state.assistantStartIndex = currentItems.length;
        continue;
      }
      state.inFinalResponse = false;
      state.finalResponseSuppressed = false;

      if (options.showUserTurns && (event.type === "message_start" || event.type === "message_end") && event.message?.role === "user") {
        const content = event.message.content;
        const steerId = plannerContentSteerId(content);
        const display = stripPlannerContext(plannerContentText(content)).trim();
        if (options.userTurnTexts && !options.userTurnTexts.includes(display)) continue;
        const messageId = event.message.id;
        if (event.type === "message_end") {
          if (state.pendingUserStart || (messageId && state.userMessageStarts.has(messageId))) {
            state.pendingUserStart = false;
            continue;
          }
        } else {
          state.pendingUserStart = true;
          if (messageId) state.userMessageStarts.add(messageId);
        }
        const first = !state.seenFirstUser;
        state.seenFirstUser = true;
        if (first && options.skipFirstUser) continue;
        if (display.trim()) currentItems.push({
          id: steerId ? `msg-${steerId}` : messageId ? `user_${messageId}` : rowId("user"),
          type: "text", role: "user", content: display, userTurnOffset: lineOffset, images: imageContent(content), timestamp: Date.now(),
        });
        continue;
      }

      if (event.type === "message") {
        pushSessionMessage(event.message, event.id);
        continue;
      }

      if (event.type === "message_start" && event.message?.role === "assistant") {
        currentItems = closeThinkingItems(currentItems);
        state.assistantStartIndex = currentItems.length;
        continue;
      }

      const thinkingEvent = event.assistantMessageEvent;
      if (event.type === "message_update" && thinkingEvent?.type === "toolcall_start") {
        const tool = thinkingEvent.partial?.content?.[thinkingEvent.contentIndex];
        addToolCall(thinkingEvent.id || tool?.id, thinkingEvent.toolName || tool?.name || "tool", thinkingEvent.arguments || tool?.arguments || {},
          "running", !!(thinkingEvent.argsTruncated || tool?.argsTruncated), thinkingEvent.contentIndex, "generating");
        continue;
      }

      if (event.type === "message_update" && thinkingEvent?.type === "toolcall_end" && thinkingEvent.toolCall) {
        const tool = thinkingEvent.toolCall;
        addToolCall(tool.id, tool.name || "tool", tool.arguments || {}, "running", !!tool.argsTruncated, thinkingEvent.contentIndex, "pending");
        continue;
      }

      if (event.type === "message_update" &&
        ["thinking_start", "thinking_delta", "thinking_end"].includes(thinkingEvent?.type)) {
        const thinkId = rowId("think");
        currentItems = updateThinkingItems(currentItems, thinkingEvent, state.assistantStartIndex, thinkId);
        continue;
      }

      // Assistant streaming text delta (or inline tag thinking fallback)
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      ) {
        const delta = event.assistantMessageEvent.delta || "";

        // Check for inline <think> or </think> or <thought> tags
        if (state.inTagThinking || delta.includes("<think>") || delta.includes("<thought>")) {
          let remaining = delta;
          while (remaining.length > 0) {
            if (state.inTagThinking) {
              const endTag = remaining.match(/<\/(?:think|thought)>/)?.[0] ?? null;
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
                state.inTagThinking = false;
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
              // Coalesced deltas can contain both spellings. Match the first
              // tag in the stream, rather than prioritizing one spelling.
              const startTag = remaining.match(/<(?:think|thought)>/)?.[0] ?? null;
              if (startTag) {
                const startIdx = remaining.indexOf(startTag);
                const textBefore = remaining.slice(0, startIdx);
                if (textBefore) {
                  const lastItem = currentItems[currentItems.length - 1];
                  if (currentItems.length > state.assistantStartIndex && lastItem && lastItem.type === "text" && lastItem.role === "assistant" && !lastItem.rawOutput) {
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
                state.inTagThinking = true;
                remaining = remaining.slice(startIdx + startTag.length);
              } else {
                const lastItem = currentItems[currentItems.length - 1];
                if (currentItems.length > state.assistantStartIndex && lastItem && lastItem.type === "text" && lastItem.role === "assistant" && !lastItem.rawOutput) {
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

        if (currentItems.length > state.assistantStartIndex && lastItem && lastItem.type === "text" && lastItem.role === "assistant" && !lastItem.rawOutput) {
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

      // A bounded tail can open in the middle of a long-running tool. Progress
      // still identifies its card even when the start is many megabytes earlier.
      // Do not accumulate cumulative partialResult snapshots as transcript rows.
      if (event.type === "tool_execution_update") {
        addToolCall(event.toolCallId, event.toolName || "tool", event.args || {}, "running", !!event.argsTruncated, undefined, "executing");
        continue;
      }

      // Tool execution start
      if (event.type === "tool_execution_start") {
        currentItems = closeThinkingItems(currentItems);
        state.inTagThinking = false;
        const toolItem = addToolCall(event.toolCallId, event.toolName || "tool", event.args || {}, "running", !!event.argsTruncated, undefined, "executing");
        if (event.toolCallId) pendingTools.set(event.toolCallId, toolItem);
        continue;
      }

      if (event.type === "tool_execution_end") {
        settleToolCall(event.toolCallId, event.toolName || "tool", event.result, !!event.isError, event.durationMs);
        continue;
      }

      // Message end
      if (event.type === "message_end") {
        const lastItem = currentItems[currentItems.length - 1];
        if (lastItem && lastItem.type === "thinking" && lastItem.status === "running") {
          lastItem.status = "success";
        }
        state.inTagThinking = false;

        const message = event.message;
        if (message?.role === "assistant" &&
            (message.stopReason === "error" || message.stopReason === "aborted") && message.errorMessage) {
          currentItems.push({
            id: rowId("system"),
            type: "system", role: "assistant", content: message.errorMessage, isError: true,
            status: "error", timestamp: Date.now(),
          });
        }
        if (message?.role === "assistant" && Array.isArray(message.content)) {
          currentItems = finalizeThinkingItems(currentItems, message.content, state.assistantStartIndex);
          message.content.forEach((part: any, contentIndex: number) => {
            if (part?.type === "toolCall") addToolCall(part.id, part.name || "tool", part.arguments || {}, "running", !!part.argsTruncated, contentIndex, "pending");
          });
          const fullText = message.content.filter((c: { type: string }) => c.type === "text")
            .map((c: { text?: string }) => c.text || "").join("");
          // A cold tail can show only the runtime fallback when a large
          // agent_end separates it from this message. Prepending must retire
          // that tagged copy in the retained tail, without reparsing it or
          // deduplicating actual assistant messages with identical text.
          retireFinalResponseCopy(fullText);
          const captured = currentItems.slice(state.assistantStartIndex)
            .filter(item => item.type === "text" && item.role === "assistant" && !item.rawOutput)
            .map(item => item.content || "").join("");
          const missing = fullText.startsWith(captured) ? fullText.slice(captured.length) : "";
          if (missing) currentItems.push({
            id: rowId("text"),
            type: "text", role: "assistant", content: missing, timestamp: Date.now(),
          });
        }
        if (message?.role === "assistant") state.assistantStartIndex = currentItems.length;
        continue;
      }

      // Auto-compaction is surfaced through the working indicator, not as chat rows.
      if (event.type === "compaction_start") {
        state.compacting = true;
        continue;
      }
      if (event.type === "compaction_end") {
        state.compacting = false;
        continue;
      }

      // Session start or system info - kept in workspace details, not in chat transcript
      if (event.type === "session") {
        continue;
      }

      // Grapher process lifecycle - kept in workspace details, not in chat transcript
      if (event.type === "grapher_process_started" || event.type === "grapher_process_exited") {
        if (event.type === "grapher_process_exited") {
          // A dead process cannot still be compacting.
          state.compacting = false;
          currentItems = closeThinkingItems(currentItems);
          for (const toolCallId of pendingTools.keys()) {
            const index = currentItems.findIndex(item => item.type === "tool_call" && item.toolCallId === toolCallId);
            // A clean process exit is not a tool result. A generated or
            // executing call with no result was interrupted, not completed.
            if (index >= 0) currentItems[index] = { ...currentItems[index], status: "interrupted" };
          }
          pendingTools.clear();
        }
        continue;
      }
    } catch {
      if (parsedJson || leadingFragment) continue;
      if (state.inFinalResponse) {
        appendFinalResponseLine(rawLine);
        continue;
      }
      const cleanLine = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
      if (cleanLine === "── Final response ──") {
        const lastUserIndex = currentItems.map(item => item.role).lastIndexOf("user");
        const currentTurnItems = lastUserIndex >= 0 ? currentItems.slice(lastUserIndex + 1) : currentItems;
        const hasStreamedAssistant = currentTurnItems.some(
          item => item.type === "text" && item.role === "assistant" && !item.rawOutput && !item.finalResponseCopy && Boolean(item.content?.trim())
        );
        state.finalResponseSuppressed = hasStreamedAssistant;
        state.inFinalResponse = true;
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

  return { currentItems, endByteOffset: state.byteOffset, endSource: state.source };
}
