import assert from "node:assert/strict";
import test from "node:test";
import { calculateExecutionDurationMs, calculatePlannerDurationMs, formatSessionStartTime } from "../src/components/ExecutionTimeTook.tsx";
import { formatToolDuration } from "../src/utils/toolTiming.ts";
import type { Execution } from "../src/types.ts";

function createMockExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: "exec-1",
    node: "agent-a",
    revision: 1,
    attempt: 1,
    sessionId: "session-1",
    worktree: "/tmp/worktree",
    before: "abc",
    after: "def",
    status: "completed",
    output: "test output",
    startedAt: 1000,
    completedAt: 5000,
    ...overrides,
  };
}

test("formatSessionStartTime renders a stable English timestamp for session details", () => {
  const local = new Date(2026, 9, 17, 16, 1, 16);
  assert.equal(formatSessionStartTime(local.getTime()), "2026-10-17 16:01:16");
  // Planning summaries persist the Planner's session start as epoch milliseconds in a string.
  assert.equal(formatSessionStartTime(String(local.getTime())), "2026-10-17 16:01:16");
  assert.equal(formatSessionStartTime(undefined), "-");
  assert.equal(formatSessionStartTime(null), "-");
  assert.equal(formatSessionStartTime(0), "-");
  assert.equal(formatSessionStartTime("not-a-time"), "-");
});

test("returns null when execution is missing or has no startedAt", () => {
  assert.equal(calculateExecutionDurationMs(null), null);
  assert.equal(calculateExecutionDurationMs(undefined), null);
  assert.equal(calculateExecutionDurationMs(createMockExecution({ startedAt: 0 })), null);
});

test("prefers metrics.durationSeconds when available", () => {
  const exec = createMockExecution({
    startedAt: 1000,
    completedAt: 5000, // 4s difference
    metrics: {
      durationSeconds: 3.5, // 3.5s precise metric
      assistantMessages: 1,
      tools: 2,
      toolErrors: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    },
  });
  const ms = calculateExecutionDurationMs(exec);
  assert.equal(ms, 3500);
  assert.equal(formatToolDuration(ms!), "3.5s");
});

test("falls back to completedAt - startedAt when metrics is absent", () => {
  const exec = createMockExecution({
    startedAt: 10000,
    completedAt: 25000,
    metrics: null,
  });
  const ms = calculateExecutionDurationMs(exec);
  assert.equal(ms, 15000);
  assert.equal(formatToolDuration(ms!), "15s");
});

test("uses now - startedAt when execution is running without completedAt", () => {
  const exec = createMockExecution({
    startedAt: 1000,
    completedAt: null,
    status: "running",
    metrics: null,
  });
  const now = 3500;
  const ms = calculateExecutionDurationMs(exec, now);
  assert.equal(ms, 2500);
  assert.equal(formatToolDuration(ms!), "2.5s");
});

test("pre-launch model metrics do not freeze a running execution clock at zero", () => {
  const exec = createMockExecution({
    startedAt: 1000,
    completedAt: null,
    status: "running",
    metrics: {
      durationSeconds: 0,
      assistantMessages: 0,
      tools: 0,
      toolErrors: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 },
      model: "actual/model",
      thinkingLevel: "high",
    },
  });
  assert.equal(calculateExecutionDurationMs(exec, 3500), 2500);
});

test("calculatePlannerDurationMs returns null when planner is idle and has no duration", () => {
  assert.equal(calculatePlannerDurationMs({ isPlanning: false, durationSeconds: null }), null);
  assert.equal(calculatePlannerDurationMs({ isPlanning: false, durationSeconds: undefined }), null);
  assert.equal(calculatePlannerDurationMs({ isPlanning: false, durationSeconds: Number.NaN }), null);
});

test("calculatePlannerDurationMs formats settled duration in English aligned with formatToolDuration", () => {
  // sub-10-second duration keeps one decimal
  const msSub10 = calculatePlannerDurationMs({ isPlanning: false, durationSeconds: 3.5 });
  assert.equal(msSub10, 3500);
  assert.equal(formatToolDuration(msSub10!), "3.5s");

  // 10s to 60s
  const ms15 = calculatePlannerDurationMs({ isPlanning: false, durationSeconds: 15 });
  assert.equal(ms15, 15000);
  assert.equal(formatToolDuration(ms15!), "15s");

  // >= 60s formats in English ("1m 15s", not Chinese "1分15秒")
  const ms75 = calculatePlannerDurationMs({ isPlanning: false, durationSeconds: 75 });
  assert.equal(ms75, 75000);
  assert.equal(formatToolDuration(ms75!), "1m 15s");

  // >= 1h formats in English ("1h 1m 5s")
  const msHour = calculatePlannerDurationMs({ isPlanning: false, durationSeconds: 3665 });
  assert.equal(msHour, 3665000);
  assert.equal(formatToolDuration(msHour!), "1h 1m 5s");
});

test("calculatePlannerDurationMs calculates live duration when isPlanning is true, ignoring old durationSeconds from previous planning turns", () => {
  // Scenario: turn 1 took 18.5s. Now user appends planning info, isPlanning becomes true.
  // The live duration must compute from now - startedAt and NOT stay frozen at 18.5s.
  const oldDurationSeconds = 18.5;
  const startedAt = 10000;
  const now = 13500; // 3.5s into the new turn
  const liveMs = calculatePlannerDurationMs({
    isPlanning: true,
    startedAt,
    durationSeconds: oldDurationSeconds,
    now,
  });
  assert.equal(liveMs, 3500);
  assert.equal(formatToolDuration(liveMs!), "3.5s");

  // At 25s into the new turn
  const now25 = 35000;
  const liveMs25 = calculatePlannerDurationMs({
    isPlanning: true,
    startedAt,
    durationSeconds: oldDurationSeconds,
    now: now25,
  });
  assert.equal(liveMs25, 25000);
  assert.equal(formatToolDuration(liveMs25!), "25s");
});

test("calculatePlannerDurationMs returns 0 when isPlanning is true without startedAt", () => {
  const ms = calculatePlannerDurationMs({
    isPlanning: true,
    startedAt: null,
    durationSeconds: 12.3,
  });
  assert.equal(ms, 0);
  assert.equal(formatToolDuration(ms!), "0.0s");
});

