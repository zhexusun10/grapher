import { useLayoutEffect, useRef } from "react";
import { useIsPresent } from "motion/react";

interface DialogScope {
  element: HTMLElement;
  focus: () => void;
}

// A child confirmation owns the keyboard until it closes; its parent must not
// also consume the same Escape or pull focus back into the settings form.
const scopes: DialogScope[] = [];
const topScope = () => scopes[scopes.length - 1];
const focusableSelector = "button, input, select, textarea, a[href], summary, [tabindex], [contenteditable='true']";

function canFocus(element: HTMLElement): boolean {
  return element.isConnected && !element.matches(":disabled") &&
    !element.closest("[inert], [hidden]") && element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden";
}

/** Keyboard containment, safe initial focus and focus restoration for a modal. */
export function useDialogFocus<T extends HTMLElement>({
  open,
  onClose,
  initialFocus,
}: {
  open: boolean;
  onClose: (() => void) | null;
  initialFocus?: string;
}) {
  const dialogRef = useRef<T>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const isPresent = useIsPresent();
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !isPresent || !dialog) return;
    // StrictMode replays setup after we already focused the dialog. Keep the
    // real trigger instead of replacing it with that initial modal control.
    if (!dialog.contains(document.activeElement)) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const opener = openerRef.current;
    let lastFocused: HTMLElement | null = null;
    // Also clears the inert state left by an interrupted exit / StrictMode cleanup.
    dialog.inert = false;
    const tabStops = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      .filter(element => element.tabIndex >= 0 && canFocus(element));
    const focus = () => {
      const preferred = initialFocus ? dialog.querySelector<HTMLElement>(initialFocus) : null;
      const target = lastFocused && canFocus(lastFocused) ? lastFocused :
        preferred && canFocus(preferred) ? preferred : tabStops()[0] ?? dialog;
      target.focus({ preventScroll: true });
    };
    const scope = { element: dialog, focus };
    // Layout effects run child-first when both dialogs mount in the same commit.
    const childIndex = scopes.findIndex(entry => dialog.contains(entry.element));
    scopes.splice(childIndex < 0 ? scopes.length : childIndex, 0, scope);

    const onFocusIn = (event: FocusEvent) => {
      if (topScope() !== scope) return;
      if (event.target instanceof HTMLElement && dialog.contains(event.target)) lastFocused = event.target;
      else focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (topScope() !== scope || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current?.();
      } else if (event.key === "Tab") {
        const stops = tabStops();
        const current = document.activeElement;
        const index = stops.indexOf(current as HTMLElement);
        if (index < 0 || (event.shiftKey ? index === 0 : index === stops.length - 1)) {
          event.preventDefault();
          (event.shiftKey ? stops[stops.length - 1] ?? dialog : stops[0] ?? dialog).focus();
        }
      }
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    if (topScope() === scope) focus();

    return () => {
      const wasTop = topScope() === scope;
      scopes.splice(scopes.indexOf(scope), 1);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
      // AnimatePresence keeps exiting DOM mounted. It must no longer accept Tab
      // or clicks while focus has already returned to the underlying surface.
      dialog.inert = true;
      if (!wasTop) return;
      queueMicrotask(() => {
        const parent = topScope();
        if (opener && canFocus(opener) && (!parent || parent.element.contains(opener))) {
          opener.focus({ preventScroll: true });
        } else {
          parent?.focus();
        }
      });
    };
  }, [open, isPresent, initialFocus]);

  return dialogRef;
}
