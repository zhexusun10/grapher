import React, { useEffect, useLayoutEffect, useRef } from "react";
import { calculateWorkspaceDetailsScrollDelta } from "../services/conversationScroll";

/** The composer overlays the scroller instead of taking space in its layout.
 * Reveal content against its actual top edge, including multiline drafts,
 * attachments and queued-message banners, not the scroller's covered bottom.
 */
export function getConversationViewport(scroll: HTMLElement) {
  const bounds = scroll.getBoundingClientRect();
  const top = bounds.top + scroll.clientTop;
  const scrollBottom = top + scroll.clientHeight;
  const composer = scroll.parentElement?.querySelector<HTMLElement>(".pane-bottom-chat");
  const overlay = composer?.getBoundingClientRect();
  // A composer laid out above the scroller (or retained mid-transition) must
  // not collapse the visible viewport to zero and turn any expansion into a
  // scroll across the whole conversation.
  const bottom = overlay && overlay.height > 0 && overlay.top > top && overlay.top < scrollBottom
    ? overlay.top : scrollBottom;
  return { top, bottom, height: bottom - top };
}

// Session details and file changes share a scroller. A newer disclosure owns
// its positioning so overlapping animations cannot fight over the same anchor.
const disclosureScrollOwners = new WeakMap<HTMLElement, object>();

interface AnimatedDisclosureProps {
  open: boolean;
  /** Wrapper whose bottom edge is revealed while the height grows. */
  panelRef: React.RefObject<HTMLElement | null>;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
  children: React.ReactNode;
}

/** One shared height/opacity disclosure used by the session details and the
 * file-change list, so both expand and collapse identically. */
export const AnimatedDisclosure: React.FC<AnimatedDisclosureProps> = ({
  open, panelRef, scrollContainerRef, onBeforeToggle, onAfterToggle, children,
}) => {
  const animatorRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rafIdRef = useRef<number | null>(null);
  const interruptedRef = useRef(false);
  const cleanupListenersRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    cleanupListenersRef.current?.();
  }, []);

  useLayoutEffect(() => {
    const animator = animatorRef.current;
    const content = contentRef.current;
    const panel = panelRef.current;
    // Mounting starts collapsed (height 0 in the initial style), so a run with
    // null refs or an already-closed panel is a harmless no-op.
    if (!animator || !content || !panel) return;

    const container = scrollContainerRef?.current
      ?? (panel.closest(".initial-query-scroll") as HTMLElement | null);
    const startHeight = animator.offsetHeight;
    const measuredHeight = Math.max(content.offsetHeight, content.scrollHeight);
    const targetHeight = open ? (measuredHeight > 0 ? measuredHeight : 120) : 0;
    // Anchor to the clicked footer, not an absolute scrollTop: older transcript
    // pages can be prepended while this animation is running.
    const anchor = panel.closest<HTMLElement>(".workspace-details") ?? panel;
    const startAnchorTop = anchor.getBoundingClientRect().top;
    let scrollDelta = 0;
    let revealProgress = 0;
    const scrollOwner = {};
    const followAnchor = () => {
      if (!container || !open || interruptedRef.current || container.dataset.transcriptScrollMode === "latest"
        || disclosureScrollOwners.get(container) !== scrollOwner) return;
      const targetAnchorTop = startAnchorTop - scrollDelta * revealProgress;
      const correction = anchor.getBoundingClientRect().top - targetAnchorTop;
      if (Math.abs(correction) >= 0.5) container.scrollTop += correction;
    };
    interruptedRef.current = false;

    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = null;
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    onBeforeToggle?.();

    if (container && open) {
      const viewport = getConversationViewport(container);
      // The changes list is a disclosure nested beside the session-details
      // trigger; keep that enclosing trigger row visible, not just the list's
      // own top edge.
      scrollDelta = calculateWorkspaceDetailsScrollDelta(
        open, startHeight, targetHeight,
        anchor.getBoundingClientRect().top, panel.getBoundingClientRect().bottom,
        viewport.top + 12, viewport.bottom - 12,
      );
      // History can commit between animation frames. Correct its height change
      // before paint as well, rather than showing one frame of old scrollTop.
      disclosureScrollOwners.set(container, scrollOwner);
      const observer = new ResizeObserver(followAnchor);
      observer.observe(container);
      if (container.firstElementChild) observer.observe(container.firstElementChild);
      const onUserScroll = () => { interruptedRef.current = true; };
      container.addEventListener("wheel", onUserScroll, { passive: true });
      container.addEventListener("touchmove", onUserScroll, { passive: true });
      cleanupListenersRef.current = () => {
        observer.disconnect();
        if (disclosureScrollOwners.get(container) === scrollOwner) disclosureScrollOwners.delete(container);
        container.removeEventListener("wheel", onUserScroll);
        container.removeEventListener("touchmove", onUserScroll);
      };
    }

    const duration = 280;
    const startTime = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startTime) / duration);
      // ease-out cubic
      const ease = 1 - Math.pow(1 - progress, 3);
      animator.style.height = `${startHeight + (targetHeight - startHeight) * ease}px`;
      animator.style.opacity = `${open ? ease : 1 - ease}`;
      revealProgress = ease;
      followAnchor();
      if (progress < 1) {
        rafIdRef.current = requestAnimationFrame(tick);
        return;
      }
      rafIdRef.current = null;
      cleanupListenersRef.current?.();
      cleanupListenersRef.current = null;
      animator.style.height = open ? "auto" : "0px";
      animator.style.opacity = open ? "1" : "0";
      onAfterToggle?.();
    };
    rafIdRef.current = requestAnimationFrame(tick);
  }, [open, onAfterToggle, onBeforeToggle, panelRef, scrollContainerRef]);

  return <div
    ref={animatorRef}
    className="workspace-details-animator"
    style={{ overflow: "hidden", height: 0, opacity: 0 }}
    aria-hidden={!open}
    inert={!open}
  >
    <div ref={contentRef}>{children}</div>
  </div>;
};
