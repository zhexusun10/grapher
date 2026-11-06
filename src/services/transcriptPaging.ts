/** More useful initial context, fewer round trips during scrollback. These are
 * bounded byte requests, not full-history reads; layout separately fills two views. */
export const INITIAL_TRANSCRIPT_BYTES = 512 * 1024;
export const OLDER_TRANSCRIPT_BYTES = 1024 * 1024;
export const TRANSCRIPT_VIEWPORT_BUFFER = 2;
/** Stop sparse initial/history auto-fill after this many loaded bytes per gesture.
 * A single in-flight page (including boundary look-behind) can cross the budget. */
export const MAX_AUTO_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
/** A settled conversation normally paints once its automatic viewport fill
 * settles, so a short tail cannot jump to the bottom of the filled history
 * mid-fade. A slow or stalled older read must not keep the pane hidden, so this
 * bounds that wait. */
export const TRANSCRIPT_REVEAL_FALLBACK_MS = 300;
