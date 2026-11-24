import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

/** Animate intrinsic content with integer-pixel height without ever collapsing
 * the DOM to 0 before an exit animation starts (which would clamp a nested
 * conversation scroller to its final bottom).
 * Lazy children avoid formatting large folded outputs; the last rendered tree
 * is retained only until the closing animation completes.
 *
 * `collapseGap` is the parent flex `gap` in px. A closed body still owns that gap
 * while retained during exit, so a section placed after it jumped by the gap at
 * the very end of the exit. Cancelling the gap alongside the shrinking height
 * keeps both the body and everything below it moving continuously.
 */
export function CollapsibleCardBody({ expanded, children, collapseGap = 0, durationMs = 240 }: {
  expanded: boolean;
  children: () => ReactNode;
  collapseGap?: number;
  durationMs?: number;
}) {
  const reduceMotion = useReducedMotion();
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const rafIdRef = useRef<number | null>(null);
  const prevExpandedRef = useRef(expanded);
  const lastChildrenRef = useRef<ReactNode>(null);
  const [rendered, setRendered] = useState(expanded);

  if (expanded && !rendered) {
    setRendered(true);
  }
  if (expanded) {
    lastChildrenRef.current = children();
  } else if (!rendered) {
    lastChildrenRef.current = null;
  }

  useEffect(() => () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    if (expanded === prevExpandedRef.current) return;
    const outer = outerRef.current;
    const inner = innerRef.current;
    const wasAnimating = rafIdRef.current !== null;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    prevExpandedRef.current = expanded;

    if (reduceMotion || durationMs <= 0) {
      if (outer) {
        outer.style.height = "";
        outer.style.opacity = "";
        outer.style.overflow = "";
        outer.style.contain = "";
        outer.style.marginTop = "";
      }
      if (!expanded) setRendered(false);
      return;
    }

    if (!outer || !inner) {
      if (!expanded) setRendered(false);
      return;
    }

    const startHeight = expanded
      ? (wasAnimating ? Math.round(outer.offsetHeight || outer.getBoundingClientRect().height) : 0)
      : Math.round(outer.offsetHeight || outer.getBoundingClientRect().height);
    const parsedOpacity = parseFloat(outer.style.opacity);
    const startOpacity = expanded
      ? (wasAnimating && Number.isFinite(parsedOpacity) ? parsedOpacity : 0)
      : (wasAnimating && Number.isFinite(parsedOpacity) ? parsedOpacity : 1);
    const parsedMarginTop = parseFloat(outer.style.marginTop);
    const startMarginTop = collapseGap > 0
      ? (wasAnimating && Number.isFinite(parsedMarginTop) ? parsedMarginTop : (expanded ? -collapseGap : 0))
      : 0;
    const targetMarginTop = collapseGap > 0 ? (expanded ? 0 : -collapseGap) : 0;

    if (!expanded && startHeight <= 0) {
      setRendered(false);
      return;
    }

    outer.style.overflow = "hidden";
    outer.style.contain = "layout style";
    outer.style.height = `${startHeight}px`;
    outer.style.opacity = `${startOpacity}`;
    if (collapseGap > 0) {
      outer.style.marginTop = `${startMarginTop}px`;
    }

    let lastHeight = startHeight;
    let awaitingFirstPaint = !wasAnimating;
    let startTime = 0;

    const tick = (now: number) => {
      rafIdRef.current = null;
      if (awaitingFirstPaint) {
        // Wait for Frame 0 (which mounts and styles newly revealed children)
        // to paint before starting the animation clock so heavy card bodies
        // never skip the beginning of the curve.
        awaitingFirstPaint = false;
        rafIdRef.current = requestAnimationFrame(tick);
        return;
      }
      if (startTime === 0) {
        startTime = now - 16;
      }
      const progress = Math.min(1, Math.max(0, (now - startTime) / durationMs));
      const eased = easeOutCubic(progress);

      const targetHeight = expanded
        ? Math.round(inner.offsetHeight || inner.getBoundingClientRect().height)
        : 0;
      const nextHeight = Math.round(startHeight + (targetHeight - startHeight) * eased);
      if (nextHeight !== lastHeight) {
        outer.style.height = `${nextHeight}px`;
        lastHeight = nextHeight;
      }
      const nextOpacity = expanded
        ? Math.min(1, startOpacity + (1 - startOpacity) * Math.min(1, eased * 1.25))
        : Math.max(0, startOpacity * (1 - eased));
      outer.style.opacity = `${nextOpacity}`;
      if (collapseGap > 0) {
        outer.style.marginTop = `${Math.round(startMarginTop + (targetMarginTop - startMarginTop) * eased)}px`;
      }

      if (progress < 1) {
        rafIdRef.current = requestAnimationFrame(tick);
        return;
      }

      if (expanded) {
        outer.style.height = "";
        outer.style.opacity = "";
        outer.style.overflow = "";
        outer.style.contain = "";
        outer.style.marginTop = "";
      } else {
        outer.style.height = "0px";
        outer.style.opacity = "0";
        if (collapseGap > 0) outer.style.marginTop = `${-collapseGap}px`;
        setRendered(false);
      }
    };

    rafIdRef.current = requestAnimationFrame(tick);
  }, [expanded, reduceMotion, collapseGap, durationMs]);

  if (!rendered) return null;

  return (
    <div ref={outerRef} style={{ width: "100%", minWidth: 0 }}>
      <div ref={innerRef} style={{ width: "100%", minWidth: 0, display: "flow-root" }}>
        {lastChildrenRef.current}
      </div>
    </div>
  );
}
