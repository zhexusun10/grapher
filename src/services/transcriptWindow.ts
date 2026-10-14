import { utf8Bytes } from "../lib/BoundedLruCache";

/** A contiguous byte range. Older reads move start; live reads move end.
 * The two cursors must never be interchanged, even when requests overlap. */
export interface TranscriptWindow {
  text: string;
  start: number;
  end: number;
  total: number;
  settled: boolean;
}

export interface TranscriptPage {
  content: string;
  startOffset?: number;
  nextOffset: number;
  totalBytes: number;
}

export function windowFromPage(page: TranscriptPage, settled: boolean): TranscriptWindow {
  const start = page.startOffset ?? page.nextOffset - utf8Bytes(page.content);
  if (start < 0 || page.nextOffset < start || page.nextOffset > page.totalBytes ||
      utf8Bytes(page.content) !== page.nextOffset - start) throw new Error("Invalid transcript byte range");
  return { text: page.content, start, end: page.nextOffset, total: page.totalBytes, settled };
}

export function appendTranscriptPage(window: TranscriptWindow, page: TranscriptPage, settled: boolean): TranscriptWindow {
  const next = windowFromPage(page, settled);
  if (next.start !== window.end) throw new Error("Non-contiguous transcript append");
  return { ...window, text: window.text + next.text, end: next.end, total: next.total, settled };
}

export function prependTranscriptPage(window: TranscriptWindow, page: TranscriptPage): TranscriptWindow {
  const older = windowFromPage(page, window.settled);
  if (older.end !== window.start || older.start >= window.start) throw new Error("Non-contiguous transcript history");
  return { ...window, text: older.text + window.text, start: older.start, total: Math.max(window.total, older.total) };
}

/** Only the rendered view receives a synthetic newline; never advance a byte
 * cursor or concatenate a future page to a synthetic byte. */
export function renderTranscriptWindow(window: TranscriptWindow): string {
  return window.settled && window.end === window.total && window.text && !window.text.endsWith("\n")
    ? window.text + "\n" : window.text;
}
