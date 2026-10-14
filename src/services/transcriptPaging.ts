/** More useful initial context, fewer round trips during scrollback. These are
 * bounded byte requests, not full-history reads; layout separately fills two views. */
export const INITIAL_TRANSCRIPT_BYTES = 512 * 1024;
export const OLDER_TRANSCRIPT_BYTES = 1024 * 1024;
export const TRANSCRIPT_VIEWPORT_BUFFER = 2;
