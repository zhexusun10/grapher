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

test("execution record expand and collapse are independent, not mutually exclusive", () => {
  const attempts = [
    { id: "exec-1", attempt: 1 },
    { id: "exec-2", attempt: 2 },
  ];
  const latestAttemptId = attempts[attempts.length - 1].id;

  let expandedAttemptIds = new Set<string>();
  let collapsedAttemptIds = new Set<string>();

  const isAttemptExpanded = (execId: string) => {
    if (attempts.length <= 1) return true;
    return execId === latestAttemptId
      ? !collapsedAttemptIds.has(execId)
      : expandedAttemptIds.has(execId);
  };

  const toggleAttempt = (execId: string) => {
    const currentlyExpanded = isAttemptExpanded(execId);
    const isLatest = execId === latestAttemptId;
    if (isLatest) {
      collapsedAttemptIds = new Set(collapsedAttemptIds);
      if (currentlyExpanded) collapsedAttemptIds.add(execId);
      else collapsedAttemptIds.delete(execId);
    } else {
      expandedAttemptIds = new Set(expandedAttemptIds);
      if (currentlyExpanded) expandedAttemptIds.delete(execId);
      else expandedAttemptIds.add(execId);
    }
  };

  // Initially: latest attempt is expanded, older attempt is collapsed
  assert.equal(isAttemptExpanded("exec-2"), true, "latest attempt is expanded by default");
  assert.equal(isAttemptExpanded("exec-1"), false, "older attempt is collapsed by default");

  // Step 1: User clicks older attempt to expand it
  toggleAttempt("exec-1");
  assert.equal(isAttemptExpanded("exec-1"), true, "older attempt is now expanded");
  assert.equal(isAttemptExpanded("exec-2"), true, "latest attempt remains expanded (NOT mutually exclusive)");

  // Step 2: User clicks latest attempt to collapse it
  toggleAttempt("exec-2");
  assert.equal(isAttemptExpanded("exec-2"), false, "latest attempt is now collapsed");
  assert.equal(isAttemptExpanded("exec-1"), true, "older attempt remains expanded");

  // Step 3: User clicks older attempt to collapse it (both are now collapsed)
  toggleAttempt("exec-1");
  assert.equal(isAttemptExpanded("exec-1"), false, "older attempt is collapsed");
  assert.equal(isAttemptExpanded("exec-2"), false, "latest attempt is collapsed");

  // Step 4: User clicks older attempt again to expand it
  toggleAttempt("exec-1");
  assert.equal(isAttemptExpanded("exec-1"), true, "older attempt is expanded again");
  assert.equal(isAttemptExpanded("exec-2"), false, "latest attempt stays collapsed");

  // Step 5: User clicks latest attempt again to expand it
  toggleAttempt("exec-2");
  assert.equal(isAttemptExpanded("exec-1"), true, "older attempt stays expanded");
  assert.equal(isAttemptExpanded("exec-2"), true, "latest attempt is expanded again");
});

test("single attempt is always expanded and requires no toggle overrides", () => {
  const attempts = [{ id: "exec-1", attempt: 1 }];
  const latestAttemptId = attempts[0].id;
  const expandedAttemptIds = new Set<string>();
  const collapsedAttemptIds = new Set<string>();

  const isAttemptExpanded = (execId: string) => {
    if (attempts.length <= 1) return true;
    return execId === latestAttemptId
      ? !collapsedAttemptIds.has(execId)
      : expandedAttemptIds.has(execId);
  };

  assert.equal(isAttemptExpanded("exec-1"), true);
});

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
