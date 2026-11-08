import assert from "node:assert/strict";
import test from "node:test";
import { smoothScrollToLatest } from "../src/services/smoothConversationScroll.ts";
import { isNestedScrollGesture, syncOverscrollContainment } from "../src/services/transcriptScroll.ts";
import {
  CONVERSATION_BOTTOM_THRESHOLD,
  calculateExpandedCardScrollDelta,
  captureViewScrollState,
  distanceFromBottom,
  resolveViewScroll,
  calculateWorkspaceDetailsScrollDelta,
  type ScrollMetrics,
} from "../src/services/conversationScroll.ts";

const metrics = (scrollTop: number, scrollHeight: number, clientHeight: number): ScrollMetrics =>
  ({ scrollTop, scrollHeight, clientHeight });

test("nested cards chain vertically and only contain real horizontal overflow", () => {
  // `overscroll-behavior: contain` on a box with no scroll range makes Chromium
  // swallow the wheel instead of chaining it to the conversation.
  const box = (height: number, width: number) => ({
    clientHeight: 50, scrollHeight: height, clientWidth: 100, scrollWidth: width,
    style: {} as CSSStyleDeclaration,
  }) as unknown as HTMLElement;
  const short = box(50, 100);
  syncOverscrollContainment(short);
  assert.equal(short.style.overscrollBehaviorY, "auto");
  assert.equal(short.style.overscrollBehaviorX, "auto");
  const tall = box(80, 100);
  syncOverscrollContainment(tall);
  assert.equal(tall.style.overscrollBehaviorY, "auto");
  assert.equal(tall.style.overscrollBehaviorX, "auto");
  const wide = box(50, 160);
  syncOverscrollContainment(wide);
  assert.equal(wide.style.overscrollBehaviorY, "auto");
  assert.equal(wide.style.overscrollBehaviorX, "contain");
  syncOverscrollContainment(null);
});

test("nested gestures chain only at the boundary in their scroll direction", () => {
  const original = globalThis.getComputedStyle;
  const outer = { closest() {}, parentElement: null };
  const middle = { closest() {}, parentElement: outer, scrollTop: 0, scrollHeight: 200, clientHeight: 100,
    overflowY: "auto", overscrollBehaviorY: "auto" };
  const inner = { closest() {}, parentElement: middle, scrollTop: 50, scrollHeight: 200, clientHeight: 100,
    overflowY: "auto", overscrollBehaviorY: "auto" };
  globalThis.getComputedStyle = ((node: typeof inner) => node) as unknown as typeof getComputedStyle;
  const scroller = outer as unknown as HTMLElement;
  const gesture = (type: string, details: object = {}) => ({ type, target: inner, ...details }) as unknown as Event;
  try {
    assert.equal(isNestedScrollGesture(gesture("wheel", { deltaY: -20 }), scroller), true);
    inner.scrollTop = 0;
    assert.equal(isNestedScrollGesture(gesture("wheel", { deltaY: -20 }), scroller), false);
    assert.equal(isNestedScrollGesture(gesture("wheel", { deltaY: 20 }), scroller), true);
    middle.scrollTop = 40;
    assert.equal(isNestedScrollGesture(gesture("wheel", { deltaY: -20 }), scroller), true, "another nested scroller can consume it");
    middle.scrollTop = 0;
    assert.equal(isNestedScrollGesture(gesture("keydown", { key: "Home" }), scroller), false);
    assert.equal(isNestedScrollGesture(gesture("touchmove"), scroller, -10), false);
    assert.equal(isNestedScrollGesture(gesture("touchmove"), scroller, 10), true);
    assert.equal(isNestedScrollGesture(gesture("touchstart"), scroller), true, "direction is not known on touchstart");
    inner.scrollTop = 99;
    middle.scrollTop = 100;
    assert.equal(isNestedScrollGesture(gesture("wheel", { deltaY: 20 }), scroller), false, "rounded dimensions tolerate a 1px discrepancy");
    assert.equal(isNestedScrollGesture(gesture("keydown", { key: "ArrowUp" }), scroller), true);
    inner.scrollTop = 0;
    inner.overscrollBehaviorY = "contain";
    assert.equal(isNestedScrollGesture(gesture("wheel", { deltaY: -20 }), scroller), true, "other contained scrollers still own their edges");
  } finally { globalThis.getComputedStyle = original; }
});

test("distanceFromBottom measures the remaining scroll range", () => {
  assert.equal(distanceFromBottom(metrics(0, 1000, 200)), 800);
  assert.equal(distanceFromBottom(metrics(800, 1000, 200)), 0);
  assert.equal(distanceFromBottom(metrics(850, 1000, 200)), -50);
});

test("a view at the bottom is remembered as following the output", () => {
  const state = captureViewScrollState(metrics(800, 1000, 200), false);
  assert.deepEqual(state, { scrollTop: 800, isAtBottom: true, isUserScrolledUp: false });
});

test("position within the bottom threshold still counts as following", () => {
  // 20px from the bottom: measurement drift from the overlaid composer.
  const state = captureViewScrollState(metrics(780, 1000, 200), true);
  assert.equal(state.isAtBottom, true);
  // The stale scrolled-up flag is dropped because we are effectively at the bottom.
  assert.equal(state.isUserScrolledUp, false);
});

test("a deliberately scrolled-up view keeps its offset", () => {
  const state = captureViewScrollState(metrics(120, 1000, 200), true);
  assert.deepEqual(state, { scrollTop: 120, isAtBottom: false, isUserScrolledUp: true });
});

test("returning to a scrolled-up view restores the exact offset", () => {
  const saved = captureViewScrollState(metrics(120, 1000, 200), true);
  const resolved = resolveViewScroll(saved, 2000);
  assert.deepEqual(resolved, { restoreSaved: true, scrollTop: 120, isUserScrolledUp: true });
});

test("first visits and bottom-anchored views land on the newest output", () => {
  const firstVisit = resolveViewScroll(undefined, 1234);
  assert.deepEqual(firstVisit, { restoreSaved: false, scrollTop: 1234, isUserScrolledUp: false });

  const atBottom = resolveViewScroll(captureViewScrollState(metrics(800, 1000, 200), false), 2000);
  assert.deepEqual(atBottom, { restoreSaved: false, scrollTop: 2000, isUserScrolledUp: false });
});

test("a view nudged off the bottom by content growth still follows new output", () => {
  // Not scrolled up, but no longer within the threshold after rows were measured.
  const saved = captureViewScrollState(metrics(400, 2000, 200), false);
  assert.equal(saved.isAtBottom, false);
  assert.equal(saved.isUserScrolledUp, false);
  // Because the user never chose to stop following, we resume at the bottom.
  assert.deepEqual(resolveViewScroll(saved, 3000),
    { restoreSaved: false, scrollTop: 3000, isUserScrolledUp: false });
});

test("switching away and back at the bottom re-anchors instead of keeping a stale offset", () => {
  // Capture while pinned to the newest output, then reselect the same conversation.
  const saved = captureViewScrollState(metrics(5000, 6000, 200), false);
  const resolved = resolveViewScroll(saved, 6000);
  assert.equal(resolved.restoreSaved, false);
  assert.equal(resolved.isUserScrolledUp, false);
  assert.ok(CONVERSATION_BOTTOM_THRESHOLD >= 1);
});

function fakeAnimation() {
  const originalRaf = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame;
  const pending = new Map<number, FrameRequestCallback>();
  let next = 0;
  globalThis.requestAnimationFrame = callback => { pending.set(++next, callback); return next; };
  globalThis.cancelAnimationFrame = id => { pending.delete(id); };
  return { pending, step(now: number) {
    const entry = pending.entries().next().value;
    if (entry) { pending.delete(entry[0]); entry[1](now); }
  }, restore() { globalThis.requestAnimationFrame = originalRaf; globalThis.cancelAnimationFrame = originalCancel; } };
}

function fakeScroller() {
  return Object.assign(new EventTarget(), { scrollTop: 100, scrollHeight: 20_000, clientHeight: 600,
    dataset: {} as Record<string, string>, style: { scrollBehavior: "smooth" } }) as unknown as HTMLElement;
}

test("Latest animates the full distance and chases a growing bottom instead of pre-jumping", () => {
  const frames = fakeAnimation(), element = fakeScroller();
  let complete = 0;
  try {
    smoothScrollToLatest(element, () => { complete++; }, false);
    assert.equal(element.scrollTop, 100, "clicking must not pre-jump near the bottom");
    const samples: number[] = [];
    for (let now = 0; now <= 3000 && frames.pending.size; now += 16) {
      if (now === 320) element.scrollHeight += 5000;
      frames.step(now); samples.push(element.scrollTop);
    }
    assert.ok(samples[1] < 1000, "the first visible movement is only a small fraction of a long conversation");
    assert.ok(samples.filter(value => value > 100 && value < 19_000).length >= 10);
    assert.ok(samples.every((value, index) => !index || value >= samples[index - 1]));
    assert.ok(Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight)) <= 1);
    assert.equal(complete, 1);
    assert.equal(element.dataset.transcriptScrollMode, undefined);
    assert.equal(element.style.scrollBehavior, "smooth");
  } finally { frames.restore(); }
});

test("Latest cancellation stops frames and reduced-motion reaches the bottom without animation", () => {
  const frames = fakeAnimation(), element = fakeScroller();
  let complete = 0;
  try {
    const stop = smoothScrollToLatest(element, () => { complete++; }, false);
    frames.step(0); frames.step(100);
    const before = element.scrollTop; stop(); frames.step(200);
    assert.equal(element.scrollTop, before);
    assert.equal(complete, 0);
    assert.equal(frames.pending.size, 0);
    assert.equal(element.dataset.transcriptScrollMode, undefined);
    smoothScrollToLatest(element, () => { complete++; }, true);
    for (let now = 0; now < 100 && frames.pending.size; now += 16) frames.step(now);
    assert.equal(element.scrollTop, element.scrollHeight - element.clientHeight);
    assert.equal(complete, 1);
  } finally { frames.restore(); }
});

test("expanding a tall card keeps an already-visible header in place", () => {
  // A short conversation pane cannot show the whole card. Pulling its header
  // to the top would drag the reader away from where they clicked.
  const delta = calculateExpandedCardScrollDelta(
    true,
    { top: 320, bottom: 356 },
    { top: 320, bottom: 950 },
    100,
    500,
  );
  assert.equal(delta, 0);
});

test("expanding a card reveals a header that opened below the visible area", () => {
  const delta = calculateExpandedCardScrollDelta(
    true,
    { top: 510, bottom: 546 },
    { top: 510, bottom: 990 },
    100,
    500,
  );
  // The header moves just above the composer; the tall body stays scrollable.
  assert.equal(delta, 58);
});

test("a partially visible header is not pulled into view", () => {
  const delta = calculateExpandedCardScrollDelta(
    true,
    { top: 480, bottom: 516 },
    { top: 480, bottom: 960 },
    100,
    500,
  );
  assert.equal(delta, 0);
});

test("expanding a card never pulls an offscreen header back down", () => {
  const delta = calculateExpandedCardScrollDelta(
    true,
    { top: 70, bottom: 106 },
    { top: 70, bottom: 720 },
    100,
    500,
  );
  assert.equal(delta, 0);
});

test("a card that fits still reveals its body from the bottom", () => {
  const delta = calculateExpandedCardScrollDelta(
    true,
    { top: 420, bottom: 456 },
    { top: 420, bottom: 600 },
    100,
    500,
  );
  assert.equal(delta, 112);
  // Revealing the body moves the header up but keeps it inside the viewport.
  assert.ok(420 - delta >= 100 + 12);
});

test("a card that already fits fully does not scroll", () => {
  const delta = calculateExpandedCardScrollDelta(
    true,
    { top: 200, bottom: 236 },
    { top: 200, bottom: 380 },
    100,
    500,
  );
  assert.equal(delta, 0);
});

test("no card reveal is attempted without room for the header", () => {
  const noViewport = calculateExpandedCardScrollDelta(
    true,
    { top: 480, bottom: 516 },
    { top: 480, bottom: 960 },
    500,
    460,
  );
  assert.equal(noViewport, 0);

  const noHeaderRoom = calculateExpandedCardScrollDelta(
    true,
    { top: 0, bottom: 36 },
    { top: 0, bottom: 400 },
    0,
    30,
  );
  assert.equal(noHeaderRoom, 0);
});

test("collapsing a card never scrolls the conversation", () => {
  assert.equal(calculateExpandedCardScrollDelta(
    false,
    { top: 320, bottom: 356 },
    { top: 320, bottom: 950 },
    100,
    500,
  ), 0);
});

test("workspace details panel toggle does not scroll on collapse", () => {
  // Collapsing must never scroll the viewport up or down
  const delta = calculateWorkspaceDetailsScrollDelta(
    false, // nextOpen = false
    180,   // current animator height
    0,     // target height
    200,   // anchor top
    600,   // panel bottom
    0,     // visible top
    500,   // visible bottom
  );
  assert.equal(delta, 0);
});

test("workspace details panel toggle scrolls only overflow on expand", () => {
  // When panel bottom + growth exceeds visible bottom, scroll by the difference
  const delta = calculateWorkspaceDetailsScrollDelta(
    true, // nextOpen = true
    0,    // current animator height
    180,  // target height
    200,  // anchor top
    400,  // panel bottom (before expand)
    0,    // visible top
    500,  // visible bottom
  );
  // futurePanelBottom = 400 + 180 = 580. visibleBottom = 500. Overflow = 80.
  assert.equal(delta, 80);

  // If panel already fits completely inside visible viewport, delta is 0
  const noOverflowDelta = calculateWorkspaceDetailsScrollDelta(
    true,
    0,
    180,
    100, // anchor top
    250, // panel bottom
    0,   // visible top
    500, // visible bottom
  );
  assert.equal(noOverflowDelta, 0);
});

test("a disclosure taller than the viewport stops at its anchor", () => {
  // The bottom cannot be revealed without pushing the trigger offscreen, so
  // scroll no further than the anchor row. The list then opens at its first row
  // instead of jumping into the middle of thousands of changes.
  const delta = calculateWorkspaceDetailsScrollDelta(
    true,   // nextOpen = true
    0,      // current animator height
    1200,   // target height, taller than the 600px viewport
    300,    // anchor top
    340,    // panel bottom before expand
    100,    // visible top
    700,    // visible bottom
  );
  assert.equal(delta, 200);

  // An anchor already at the viewport top must not scroll itself away.
  const anchored = calculateWorkspaceDetailsScrollDelta(true, 0, 1200, 100, 140, 100, 700);
  assert.equal(anchored, 0);
});

test("a reveal never exceeds one viewport when the anchor measurement is stale", () => {
  // A stale anchor or collapsed composer must not turn a short disclosure into
  // a scroll across the middle of a long conversation.
  const delta = calculateWorkspaceDetailsScrollDelta(
    true, // nextOpen = true
    0,    // current animator height
    5000, // target height
    10000, // stale anchor far below the viewport
    10050, // panel bottom before expand
    0,    // visible top
    800,  // visible bottom
  );
  assert.equal(delta, 800);
});

test("workspace details panel re-expand mid-animation does not double-count height", () => {
  // Suppose animator is partially open at height 100 with target height 180.
  // panelBottom already includes the current 100px (e.g. 500px).
  // Remaining growth is only 80px, so futurePanelBottom should be 500 + 80 = 580px, NOT 500 + 180 = 680px.
  const delta = calculateWorkspaceDetailsScrollDelta(
    true, // nextOpen = true
    100,  // current animator height
    180,  // target height
    320,  // anchor top
    500,  // panel bottom (which already includes the 100px)
    0,    // visible top
    500,  // visible bottom
  );
  assert.equal(delta, 80);
});

test("repeated rapid expand and collapse cycles remain scroll-stable without ratcheting", () => {
  let scrollTop = 500;
  const panelDocumentTop = 1100;
  const triggerHeight = 24;
  const fullContentHeight = 180;
  const visibleBottom = 700;

  // Cycle 1: Expand from fully closed near the bottom of viewport
  let animatorHeight = 0;
  let anchorTopViewport = (panelDocumentTop - scrollTop); // 600
  let panelBottomViewport = (panelDocumentTop + triggerHeight + animatorHeight) - scrollTop; // 624
  let scrollDelta = calculateWorkspaceDetailsScrollDelta(
    true,
    animatorHeight,
    fullContentHeight,
    anchorTopViewport,
    panelBottomViewport,
    0,
    visibleBottom,
  );
  // futurePanelBottom = 624 + 180 = 804. visibleBottom = 700. Overflow = 104.
  assert.equal(scrollDelta, 104);
  scrollTop += scrollDelta; // 604
  animatorHeight = fullContentHeight;

  // Cycle 2: Collapse
  anchorTopViewport = (panelDocumentTop - scrollTop);
  panelBottomViewport = (panelDocumentTop + triggerHeight + animatorHeight) - scrollTop;
  scrollDelta = calculateWorkspaceDetailsScrollDelta(
    false,
    animatorHeight,
    0,
    anchorTopViewport,
    panelBottomViewport,
    0,
    visibleBottom,
  );
  assert.equal(scrollDelta, 0); // No scroll on collapse
  animatorHeight = 0;

  // Cycle 3: Expand again after collapse settles
  anchorTopViewport = (panelDocumentTop - scrollTop);
  panelBottomViewport = (panelDocumentTop + triggerHeight + animatorHeight) - scrollTop; // 1124 - 604 = 520
  scrollDelta = calculateWorkspaceDetailsScrollDelta(
    true,
    animatorHeight,
    fullContentHeight,
    anchorTopViewport,
    panelBottomViewport,
    0,
    visibleBottom,
  );
  // futurePanelBottom = 520 + 180 = 700 <= visibleBottom (700). Overflow = 0.
  assert.equal(scrollDelta, 0); // Doesn't over-scroll or ratchet!
});

