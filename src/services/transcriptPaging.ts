/** More useful initial context, fewer round trips during scrollback. These are
 * bounded byte requests, not full-history reads; layout separately fills two views. */
export const INITIAL_TRANSCRIPT_BYTES = 512 * 1024;
export const OLDER_TRANSCRIPT_BYTES = 1024 * 1024;
export const TRANSCRIPT_VIEWPORT_BUFFER = 2;
/** Stop sparse initial/history auto-fill after this many loaded bytes per gesture.
 * A single in-flight page (including boundary look-behind) can cross the budget. */
export const MAX_AUTO_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
