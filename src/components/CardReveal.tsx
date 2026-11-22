import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observeElementResize } from "../services/sharedResizeObserver";

/** Give a just-presented card its height progressively instead of in one frame.
 *
 * The entrance of a card that arrives with real content (a reasoning block from
 * a live chunk, a tool call whose result is already known) used to reserve its
 * whole height before its first paint. In a bottom-following transcript that
 * snapped every older row up by the card's full height in a single frame.
 *
 * Quantizing the animated grid track to integer pixels via CSS `round()` keeps
 * the same smooth upward glide for older rows without fractional-pixel
 * `scrollHeight` rounding bouncing the bottom-pinned footer on every frame.
 */
export function CardReveal({ animate, children }: { animate: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(!animate);
  const entering = animate && !settled;

  useLayoutEffect(() => {
    const reveal = ref.current;
    if (!reveal || !entering) return;
    if (reveal.closest(".conversation-preparing")) {
      setSettled(true);
      return;
    }
    const child = reveal.firstElementChild as HTMLElement | null;
    if (!child) return;

    const measure = () => {
      // `scrollHeight` excludes borders while `offsetHeight - clientHeight`
      // recovers the exact vertical border thickness even while squashed to 0fr.
      const height = Math.round(child.scrollHeight + (child.offsetHeight - child.clientHeight));
      if (height > 0) {
        reveal.style.setProperty("--card-reveal-height", `${height}px`);
        reveal.dataset.revealMeasured = "true";
      }
    };
    measure();

    const unsubscribers: Array<() => void> = [];
    for (const part of child.children) unsubscribers.push(observeElementResize(part, measure));
    return () => {
      for (const unobserve of unsubscribers) unobserve();
      reveal.style.removeProperty("--card-reveal-height");
      delete reveal.dataset.revealMeasured;
    };
  }, [entering]);

  return (
    <div
      ref={ref}
      className={`card-reveal${entering ? " entering" : ""}`}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && event.animationName === "transcript-card-reveal") {
          setSettled(true);
        }
      }}
    >
      {children}
    </div>
  );
}
