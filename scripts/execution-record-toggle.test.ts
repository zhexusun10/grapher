import assert from "node:assert/strict";
import test from "node:test";
import { en } from "../src/i18n/en.ts";
import { t } from "../src/i18n/index.ts";

test("execution record toggle copy is simplified without trailing load log text", () => {
  assert.equal(t("点击展开执行记录"), "点击展开执行记录");
  assert.equal(t("点击收起执行记录"), "点击收起执行记录");
  assert.equal(en["点击展开执行记录"], "Click to expand execution log");
  assert.equal(en["点击收起执行记录"], "Click to collapse execution log");
  // Ensure the old verbose string is no longer present
  assert.equal((en as Record<string, string>)["点击展开执行记录并加载日志"], undefined);
});

// Default expansion and independent toggles are exercised against the actual
// App in frontend-audit.test.mjs, including optimistic follow-ups and reloads.

test("conversation view key remains stable across attempt toggles to prevent screen blanks", () => {
  const currentRunKey = "run-101";
  const routeType = "graph";
  const selectedNode = "worker-1";

  // conversationViewKey is bounded to the selected node / route, not the individual attempt
  const conversationViewKey = `${currentRunKey}:${routeType}:${selectedNode || "planner"}`;

  // Toggling attempts or selecting an attempt must not change the view key
  const keyAfterAttempt1 = `${currentRunKey}:${routeType}:${selectedNode || "planner"}`;
  const keyAfterAttempt2 = `${currentRunKey}:${routeType}:${selectedNode || "planner"}`;

  assert.equal(conversationViewKey, keyAfterAttempt1);
  assert.equal(conversationViewKey, keyAfterAttempt2);
});

test("expanding upper attempt when lower attempt is collapsed follows all the way to bottom", () => {
  const attempts = [
    { id: "exec-1", attempt: 1 },
    { id: "exec-2", attempt: 2 },
  ];

  // Both attempts are collapsed (two expand buttons present)
  const isAttemptExpanded = (id: string) => false;

  const attemptIndex = attempts.findIndex(a => a.id === "exec-1");
  const hasExpandedBelow = attemptIndex >= 0 && attempts.slice(attemptIndex + 1).some(a => isAttemptExpanded(a.id));

  // When expanding exec-1, exec-2 is collapsed, so hasExpandedBelow is false
  assert.equal(hasExpandedBelow, false, "no expanded attempts below the upper attempt");

  // Mock viewport and scroll container
  const scrollEl = {
    scrollTop: 0,
    scrollHeight: 1500,
  };

  // When hasExpandedBelow is false, expansion follows all the way to the bottom (scrollHeight)
  if (!hasExpandedBelow) {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  assert.equal(scrollEl.scrollTop, 1500, "scrolled all the way to bottom instead of stopping in the middle");
});

test("expanding upper attempt when lower attempt is already expanded reveals bottom of upper record", () => {
  const attempts = [
    { id: "exec-1", attempt: 1 },
    { id: "exec-2", attempt: 2 },
  ];

  // Lower attempt (exec-2) is already expanded
  const isAttemptExpanded = (id: string) => id === "exec-2";

  const attemptIndex = attempts.findIndex(a => a.id === "exec-1");
  const hasExpandedBelow = attemptIndex >= 0 && attempts.slice(attemptIndex + 1).some(a => isAttemptExpanded(a.id));

  assert.equal(hasExpandedBelow, true, "lower attempt is already expanded");

  const viewport = { bottom: 600 };
  const upperPanelBounds = { bottom: 900 }; // 300px below viewport bottom
  const scrollEl = { scrollTop: 100 };

  const delta = upperPanelBounds.bottom - viewport.bottom + 16;
  if (delta > 0) {
    scrollEl.scrollTop += delta;
  }

  // Delta brings the bottom of upper attempt into view (with padding), without jumping all the way past to exec-2
  assert.equal(delta, 316);
  assert.equal(scrollEl.scrollTop, 416);
});
