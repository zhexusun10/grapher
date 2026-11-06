import type { TargetAndTransition } from "motion/react";

/**
 * Motion for the large dialogs (Settings, the Graph IR editor). They share one
 * shell, so the entrance and the closing effect must stay identical: a dialog
 * that lifted slightly on open but snapped away on close read as a different
 * layer from Settings. Keep the values here instead of copying them per dialog.
 */
export type DialogMotion = {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
};

/** The dialog itself: a short lift into place, and a slightly smaller fade out. */
export function largeDialogMotion(reduceMotion: boolean | null): DialogMotion {
  return {
    initial: { opacity: 0, scale: 0.985, y: reduceMotion ? 0 : 8 },
    animate: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: { duration: reduceMotion ? 0 : 0.32, ease: [0.22, 1, 0.36, 1] },
    },
    exit: {
      opacity: 0,
      scale: 0.99,
      y: reduceMotion ? 0 : 6,
      transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.4, 0, 1, 1] },
    },
  };
}

/** The inert veil behind the dialog; only its compositor opacity animates. */
export function dialogVeilMotion(reduceMotion: boolean | null): DialogMotion & { transition: { duration: number; ease: "easeOut" } } {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: reduceMotion ? 0 : 0.2, ease: "easeOut" },
  };
}
