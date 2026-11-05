import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/** Animate intrinsic content without measuring an auto -> 0 height transition.
 * Motion's height measurement temporarily collapses the DOM and clamps a nested
 * conversation scroller to its final bottom before the exit animation starts.
 * Lazy children avoid formatting large folded outputs; presence retains their
 * last rendered tree only until the closing animation completes.
 *
 * `collapseGap` is the parent flex `gap` in px. A closed body still owns that gap
 * while presence keeps it mounted, so a section placed after it jumped by the gap
 * at the very end of the exit. Cancelling the gap with the shrinking rows keeps
 * both the body and everything below it moving continuously.
 */
export function CollapsibleCardBody({ expanded, children, collapseGap = 0 }: {
  expanded: boolean;
  children: () => ReactNode;
  collapseGap?: number;
}) {
  const reduceMotion = useReducedMotion();
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);

  const closed = collapseGap > 0
    ? { gridTemplateRows: "0fr", opacity: 0, marginTop: -collapseGap }
    : { gridTemplateRows: "0fr", opacity: 0 };
  const open = collapseGap > 0
    ? { gridTemplateRows: "1fr", opacity: 1, marginTop: 0 }
    : { gridTemplateRows: "1fr", opacity: 1 };

  return (
    <AnimatePresence initial={false}>
      {expanded && (
        <motion.div
          key="card-body"
          initial={mountedRef.current && !reduceMotion ? closed : false}
          animate={open}
          exit={closed}
          transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.25, 1, 0.5, 1] }}
          style={{ display: "grid", overflow: "hidden" }}
        >
          <div style={{ minHeight: 0, overflow: "hidden" }}>{children()}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
