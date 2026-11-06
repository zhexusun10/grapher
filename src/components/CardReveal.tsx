import type { ReactNode } from "react";

/** Give a just-presented card its height progressively instead of in one frame.
 *
 * The entrance of a card that arrives with real content (a reasoning block from
 * a live chunk, a tool call whose result is already known) used to reserve its
 * whole height before its first paint. In a bottom-following transcript that
 * snapped every older row up by the card's full height in a single frame. A grid
 * track that grows from `0fr` to `1fr` moves the same layout box over the
 * entrance window, so the rows above glide away from the new card while the
 * card's own clipped content is revealed from its header down.
 *
 * The tracker is a wrapper rather than the card itself: the card must stay a
 * single grid item so its width, wrapping and measured row height match the
 * settled geometry exactly. `min-height: 0` on that item lets the track squash
 * it during the animation; the card's existing `overflow: hidden` does the
 * clipping, so box-shadows and glows keep painting outside it.
 */
export function CardReveal({ animate, children }: { animate: boolean; children: ReactNode }) {
  return <div className={`card-reveal${animate ? " entering" : ""}`}>{children}</div>;
}
