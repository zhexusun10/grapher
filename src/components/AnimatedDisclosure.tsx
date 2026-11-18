import React, { useEffect, useLayoutEffect, useRef } from "react";
import { calculateWorkspaceDetailsScrollDelta } from "../services/conversationScroll";

/** The composer overlays the scroller instead of taking space in its layout.
 * Reveal content against its actual top edge, including multiline drafts,
 * attachments and queued-message banners, not the scroller's covered bottom.
 */
export function getConversationViewport(scroll: HTMLElement) {
  const bounds = scroll.getBoundingClientRect();
  const rawTop = bounds.top + scroll.clientTop;
  // The conversation can extend outside the browser viewport when the page or
  // an embedded layout scrolls. Reveal against the part the user can actually
  // see, not an offscreen scroller edge.
  const top = Math.max(0, rawTop);
  const scrollBottom = Math.min(window.innerHeight, rawTop + scroll.clientHeight);
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
  const prevOpenRef = useRef(false);
  const onBeforeToggleRef = useRef(onBeforeToggle);
  const onAfterToggleRef = useRef(onAfterToggle);
  onBeforeToggleRef.current = onBeforeToggle;
  onAfterToggleRef.current = onAfterToggle;

  useEffect(() => () => {
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    cleanupListenersRef.current?.();
  }, []);

  useLayoutEffect(() => {
    if (open === prevOpenRef.current) return;
    const animator = animatorRef.current;
    const content = contentRef.current;
    const panel = panelRef.current;
    // Mounting starts collapsed (height 0 in the initial style). Keep the
    // previous state unrecorded while our own nodes are missing so a later
    // commit can still apply the change.
    if (!animator || !content) return;
    prevOpenRef.current = open;
    if (!panel) {
      // An ancestor ref is attached after child layout effects on mount, so a
      // panel remounted already open (view switch, conversation key change)
      // has no anchor yet. Show its settled state instead of leaving it
      // collapsed while `open` stays unchanged.
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      cleanupListenersRef.current?.();
      cleanupListenersRef.current = null;
      animator.style.height = open ? "auto" : "0px";
      animator.style.opacity = open ? "1" : "0";
      return;
    }

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
    onBeforeToggleRef.current?.();

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
      onAfterToggleRef.current?.();
    };
    rafIdRef.current = requestAnimationFrame(tick);
  }, [open, panelRef, scrollContainerRef]);

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
