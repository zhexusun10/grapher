import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/** Animate intrinsic content without measuring an auto -> 0 height transition.
 * Motion's height measurement temporarily collapses the DOM and clamps a nested
 * conversation scroller to its final bottom before the exit animation starts.
 * Lazy children avoid formatting large folded outputs; presence retains their
 * last rendered tree only until the closing animation completes.
 */
export function CollapsibleCardBody({ expanded, children }: { expanded: boolean; children: () => ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {expanded && (
        <motion.div
          key="card-body"
          initial={{ gridTemplateRows: "0fr", opacity: 0 }}
          animate={{ gridTemplateRows: "1fr", opacity: 1 }}
          exit={{ gridTemplateRows: "0fr", opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.25, 1, 0.5, 1] }}
          style={{ display: "grid", overflow: "hidden" }}
        >
          <div style={{ minHeight: 0, overflow: "hidden" }}>{children()}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
