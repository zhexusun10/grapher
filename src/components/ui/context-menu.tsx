import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStableCallback } from "../../hooks/useStableCallback";

export interface ContextMenuAnchor {
  x: number;
  y: number;
  trigger: HTMLElement;
}

/** Mouse and keyboard invocations share the same positioning and focus owner. */
export function contextMenuAnchor(event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>): ContextMenuAnchor | null {
  const keyboard = "key" in event;
  if (keyboard && event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return null;
  event.preventDefault();
  event.stopPropagation();
  const trigger = event.currentTarget;
  const bounds = trigger.getBoundingClientRect();
  const useTrigger = keyboard || (event.clientX === 0 && event.clientY === 0);
  return {
    x: useTrigger ? bounds.left + 8 : event.clientX,
    y: useTrigger ? bounds.bottom : event.clientY,
    trigger,
  };
}

interface ContextMenuProps {
  anchor: ContextMenuAnchor;
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}

export function ContextMenu({ anchor, label, onClose, children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  const close = useStableCallback((restoreFocus: boolean) => {
    if (restoreFocus && anchor.trigger.isConnected) anchor.trigger.focus({ preventScroll: true });
    onClose();
  });

  useLayoutEffect(() => {
    const menu = menuRef.current!;
    const place = () => {
      // Measure the layout box, not the scaled entrance animation. Labels and
      // font sizes can make the menu wider than its minimum width.
      setPosition({
        left: Math.max(8, Math.min(anchor.x, window.innerWidth - menu.offsetWidth - 8)),
        top: Math.max(8, Math.min(anchor.y, window.innerHeight - menu.offsetHeight - 8)),
      });
    };
    place();
    menu.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [anchor]);

  useLayoutEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) close(true);
    };
    const replaced = (event: Event) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) close(false);
    };
    const resized = () => close(true);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", outside, true);
    // Capture before another menu stops propagation, so only one stays open.
    window.addEventListener("contextmenu", replaced, true);
    window.addEventListener("resize", resized);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("contextmenu", replaced, true);
      window.removeEventListener("resize", resized);
    };
  }, [close]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      // Tab resumes normal navigation from the invoking card, not the portal
      // at the end of the document. Escape stays on the card.
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = Array.from(menuRef.current!.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className="context-menu keyboard-context-menu"
      style={position}
      onKeyDown={onKeyDown}
      onContextMenu={event => {
        // The Menu key can emit a native contextmenu on keyup after focus has
        // already moved here. Keep it from replacing this menu.
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={event => {
        event.stopPropagation();
        if (event.target instanceof Element && event.target.closest("[role=menuitem]:not(:disabled)")) close(true);
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
