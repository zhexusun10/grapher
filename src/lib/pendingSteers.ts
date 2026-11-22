import type { ChatMessage, FileAttachment, ImageAttachment, Snapshot, GraphEvent } from "../types";

/** Remove only runtime-confirmed withdrawals, including their optimistic twins.
 * Submission ordinals count all accepted events; transcript ordinals count only
 * retained turns. Renumber after matching so a withdrawn duplicate can be resent. */
export function projectWithdrawnSteers(source: Snapshot, messages: readonly ChatMessage[]) {
  const removed = new Set(source.events.filter(event => event.type === "steers_withdrawn")
    .flatMap(event => event.message_sequences ?? []));
  if (!removed.size) return { state: source, messages };
  const removedIds = new Set<string>();
  const byId = new Map<string, { ordinal: number; textOrdinal?: number }>();
  const byText = new Map<string, { ordinal: number; textOrdinal?: number }[]>();
  const counts = new Map<string, number>();
  const textCounts = new Map<string, number>();
  for (const event of source.events) {
    if (event.type !== "steered" || !event.execution_id) continue;
    const key = `${event.execution_id}\u0000${nodeInstructionText(event.instruction ?? "")}`;
    const ordinal = counts.get(key) ?? 0;
    counts.set(key, ordinal + 1);
    const textOrdinal = event.images?.length ? undefined : textCounts.get(key) ?? 0;
    if (textOrdinal !== undefined) textCounts.set(key, textOrdinal + 1);
    if (event.request_id) {
      const identity = `${event.execution_id}\u0000${event.request_id}`;
      byId.set(identity, { ordinal, textOrdinal });
      if (removed.has(event.sequence)) removedIds.add(identity);
    }
    if (removed.has(event.sequence)) {
      const list = byText.get(key) ?? [];
      list.push({ ordinal, textOrdinal });
      byText.set(key, list);
    }
  }
  const retained = numberSteers(messages).flatMap(message => {
    if (message.delivery !== "steered" || !message.executionId) return [message];
    const withdrawn = byText.get(`${message.executionId}\u0000${nodeInstructionText(message.text)}`) ?? [];
    const identity = message.steerRequestId ? `${message.executionId}\u0000${message.steerRequestId}` : undefined;
    if (identity ? removedIds.has(identity) : message.id.startsWith("event-") && removed.has(Number(message.id.slice(6)))) return [];
    // Text/ordinal counts remain display positions, never withdrawal identity.
    // An unacknowledged local card is retained rather than guessed.
    const recorded = identity ? byId.get(identity) : undefined;
    const ordinal = recorded?.ordinal ?? message.inlineSteerOrdinal!;
    const textOrdinal = recorded?.textOrdinal ?? message.steerOrdinal;
    return [{ ...message, inlineSteerOrdinal: ordinal - withdrawn.filter(item => item.ordinal < ordinal).length,
      steerOrdinal: textOrdinal === undefined ? undefined : textOrdinal - withdrawn.filter(item =>
        item.textOrdinal !== undefined && item.textOrdinal < textOrdinal).length }];
  });
  return { state: { ...source, events: source.events.filter(event => !removed.has(event.sequence)) }, messages: retained };
}

/** Keep live transcript cursors for consumed turns and unrelated nodes. Only
 * newly recalled occurrences disappear; later keys shift with the projection. */
export function projectLiveSteerWithdrawals(markers: LiveSteerMarker[], events: readonly GraphEvent[], previousRemoved: ReadonlySet<number>) {
  const removed = new Set(events.filter(event => event.type === "steers_withdrawn").flatMap(event => event.message_sequences ?? []));
  const removedIds = new Set(events.filter(event => removed.has(event.sequence) && event.request_id)
    .map(event => `${event.execution_id}\u0000${event.request_id}`));
  const counts = new Map<string, number>();
  const ordinals = new Map<string, number[]>();
  for (const event of events) {
    if (event.type !== "steered" || !event.execution_id || previousRemoved.has(event.sequence)) continue;
    const key = `${event.execution_id}\u0000${nodeInstructionText(event.instruction ?? "")}`;
    const ordinal = counts.get(key) ?? 0;
    counts.set(key, ordinal + 1);
    if (removed.has(event.sequence)) ordinals.set(key, [...(ordinals.get(key) ?? []), ordinal]);
  }
  return markers.flatMap(marker => {
    if (marker.requestId) return removedIds.has(`${marker.executionId}\u0000${marker.requestId}`) ? [] : [marker];
    const key = `${marker.executionId}\u0000${marker.text}`;
    const recalled = ordinals.get(key) ?? [];
    const ordinal = Number(marker.key.slice(marker.key.lastIndexOf("\u0000") + 1));
    if (recalled.includes(ordinal)) return [];
    const shift = recalled.filter(value => value < ordinal).length;
    return [shift ? { ...marker, key: `${key}\u0000${ordinal - shift}`, occurrence: Math.max(1, marker.occurrence - shift) } : marker];
  });
}

/** A node instruction without the `[@node]` addressing prefix the bubble adds. */
export function nodeInstructionText(text: string): string {
  return text.replace(/^\[@[^\]]+\]\s*/, "").trim();
}

/** Distinguish repeated accepted/optimistic texts without depending on their
 * temporary card ids. Ordinals are presentation identities, not runtime state. */
export function numberSteers(messages: readonly ChatMessage[]): ChatMessage[] {
  const counts = new Map<string, number>();
  const inlineCounts = new Map<string, number>();
  return messages.map(message => {
    if (message.delivery !== "steered" || !message.executionId) return message;
    const key = `${message.executionId}\u0000${nodeInstructionText(message.text)}`;
    const inlineSteerOrdinal = message.inlineSteerOrdinal ?? inlineCounts.get(key) ?? 0;
    inlineCounts.set(key, Math.max(inlineCounts.get(key) ?? 0, inlineSteerOrdinal + 1));
    if (message.images?.length || message.files?.length) return message.inlineSteerOrdinal === inlineSteerOrdinal
      ? message : { ...message, inlineSteerOrdinal };
    const ordinal = message.steerOrdinal ?? counts.get(key) ?? 0;
    counts.set(key, Math.max(counts.get(key) ?? 0, ordinal + 1));
    return message.steerOrdinal === ordinal && message.inlineSteerOrdinal === inlineSteerOrdinal
      ? message : { ...message, steerOrdinal: ordinal, inlineSteerOrdinal };
  });
}

/**
 * The user turns one execution's loaded transcript window parsed, plus whether
 * that window starts at the transcript's first byte. A tail page can omit an
 * earlier occurrence of a repeated instruction, so its turn list is not a
 * complete view of what Pi consumed.
 */
export interface InlineUserTurnWindow {
  texts: readonly string[];
  complete: boolean;
  /** Byte cursors of the loaded transcript, and user rows in that window. */
  start?: number;
  end?: number;
  turns?: readonly { text: string; offset?: number; requestId?: string }[];
  /** Full-log byte offset index of grapherRequestId-tagged user turns. */
  steerOffsets?: Readonly<Record<string, number>>;
  /** True when absence from steerOffsets proves the steer is unread across 0..totalBytes. */
  steerOffsetsAuthoritative?: boolean;
}

/** Presentation-only marker captured when a steer is sent in this view. */
export interface LiveSteerMarker {
  key: string;
  requestId?: string;
  executionId: string;
  text: string;
  afterOffset: number;
  occurrence: number;
  images?: ImageAttachment[];
  files?: FileAttachment[];
}

/** Durable metadata for steers rendered inline after reload or view switch. */
export interface InlineSteerAttachment {
  requestId?: string;
  text: string;
  inlineSteerOrdinal: number;
  images?: ImageAttachment[];
  files?: FileAttachment[];
}

export function liveSteerConsumed(marker: LiveSteerMarker, window?: InlineUserTurnWindow): boolean {
  if (!window?.turns) return false;
  if (marker.requestId && window.turns.some(turn => turn.requestId === marker.requestId)) return true;
  return window.turns.filter(turn => !turn.requestId && turn.text === marker.text && turn.offset !== undefined &&
    turn.offset >= marker.afterOffset).length >= marker.occurrence;
}

function steerText(message: ChatMessage): string {
  return nodeInstructionText(message.text);
}

function loadedOccurrences(message: ChatMessage, window: InlineUserTurnWindow): number {
  return window.texts.filter(text => text === steerText(message)).length;
}

function inlineTurnOccurrences(message: ChatMessage, window: InlineUserTurnWindow): number {
  const text = steerText(message);
  if (window.turns) return window.turns.filter(turn => turn.text === text).length;
  return window.texts.filter(item => item === text).length;
}

/**
 * A steer Pi has not committed to its session transcript yet.
 *
 * A running node accepts steers through its Pi RPC input, but Pi only consumes
 * them at its next safe boundary. Until the matching user turn appears in the
 * transcript, the message exists only as a durable `Steered` event or an
 * optimistic card. Editing such a turn branches the Pi session and fails with
 * "Cannot locate that user turn in the Pi conversation tree".
 *
 * A known-partial window cannot prove consumption, so it never reports the turn
 * as unread; that would resend an instruction Pi already consumed. An unknown
 * window (transcript not mounted) keeps the durable-event-only view. The
 * transcript only reports the steer texts it was asked to render inline, so
 * attachment-bearing steers cannot be verified here and are treated as
 * committed rather than rolled back by mistake.
 */
export function isUncommittedSteer(
  message: ChatMessage,
  windows: Record<string, InlineUserTurnWindow>,
): boolean {
  if (message.delivery !== "steered" || !message.executionId) return false;
  if (message.images?.length || message.files?.length) return false;
  const window = windows[message.executionId];
  if (message.steerRequestId && window) {
    if (window.steerOffsets && Object.prototype.hasOwnProperty.call(window.steerOffsets, message.steerRequestId)) {
      return false;
    }
    if (window.turns?.some(turn => turn.requestId === message.steerRequestId)) return false;
    if (window.steerOffsetsAuthoritative) return true;
  }
  if (window && !window.complete) return false;
  return (window?.texts ?? []).filter(text => text === steerText(message)).length <= (message.steerOrdinal ?? 0);
}

/**
 * Whether an accepted steer still needs its outer card because its consumed
 * turn is not rendered inline yet. Display only: unlike {@link isUncommittedSteer},
 * a partial window keeps the card instead of silently dropping a turn the
 * transcript has not loaded.
 */
export function isPendingSteer(
  message: ChatMessage,
  windows: Record<string, InlineUserTurnWindow>,
): boolean {
  if (message.delivery !== "steered" || !message.executionId) return false;
  const window = windows[message.executionId];
  if (message.steerRequestId && window?.turns?.some(turn => turn.requestId === message.steerRequestId)) {
    return false;
  }
  if (message.images?.length || message.files?.length) {
    if (!window?.turns) return true;
    if (!window.complete) return !window.turns.some(turn => turn.text === steerText(message));
    return inlineTurnOccurrences(message, window) <= (message.inlineSteerOrdinal ?? 0);
  }
  if (!window) return true;
  if (!window.complete) return !window.texts.includes(steerText(message));
  return loadedOccurrences(message, window) <= (message.steerOrdinal ?? 0);
}

/** Place a pending steer after the output already visible. A complete window
 * that lacks the turn still proves it unread, so the card stays at the tail
 * even after settlement. A partial window, or an unloaded settled transcript,
 * cannot place the turn and falls back before the transcript. */
export function steerFallbackPosition(
  message: ChatMessage,
  windows: Record<string, InlineUserTurnWindow>,
  running: boolean,
  expanded = true,
  live?: LiveSteerMarker,
): "before" | "after" | null {
  if (!expanded) return "before";
  const window = message.executionId ? windows[message.executionId] : undefined;
  if (message.steerRequestId && window) {
    if (window.turns?.some(turn => turn.requestId === message.steerRequestId)) return null;
    const consumedOffset = window.steerOffsets && Object.prototype.hasOwnProperty.call(window.steerOffsets, message.steerRequestId)
      ? window.steerOffsets[message.steerRequestId]
      : undefined;
    if (consumedOffset !== undefined) {
      const start = window.start ?? 0;
      if (consumedOffset < start) return "before";
      if (window.end !== undefined && consumedOffset >= window.end) return "after";
      return null;
    }
    if (window.steerOffsetsAuthoritative) return "after";
  }
  if (live) return liveSteerConsumed(live, window) ? null : "after";
  if (!isPendingSteer(message, windows)) return null;
  const complete = !!window?.complete;
  if (message.images?.length || message.files?.length) {
    return complete && window?.turns ? "after" : "before";
  }
  // A complete window proves this turn is still absent even if the execution
  // has just settled. Keep it at the tail while the final page catches up.
  return (running || complete) && isUncommittedSteer(message, windows) ? "after" : "before";
}

/** Presentation identity also counts attachment steers, without changing the
 * text-only ordinal used for safe pause recovery. */
export function inlineSteerKey(message: ChatMessage): string | null {
  if (message.delivery !== "steered" || !message.executionId) return null;
  if (message.steerRequestId) return `${message.executionId}\u0000id:${message.steerRequestId}`;
  if (message.inlineSteerOrdinal === undefined) return null;
  return `${message.executionId}\u0000${nodeInstructionText(message.text)}\u0000${message.inlineSteerOrdinal}`;
}

/**
 * Stable identity for a steer across its optimistic card and its later durable
 * `Steered` event. Rolling back one form must also suppress the other.
 */
export function steerRollbackKey(message: ChatMessage): string | null {
  if (message.delivery !== "steered" || !message.executionId) return null;
  if (message.steerRequestId) return `${message.executionId}\u0000id:${message.steerRequestId}`;
  return `${message.executionId}\u0000${nodeInstructionText(message.text)}${message.steerOrdinal === undefined ? "" : `\u0000${message.steerOrdinal}`}`;
}
