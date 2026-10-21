import assert from "node:assert/strict";
import test from "node:test";
import { calculateExecutionDurationMs, calculatePlannerDurationMs, formatSessionStartTime, formatTimeTookDuration } from "../src/components/ExecutionTimeTook.tsx";
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

test("time took displays completed whole seconds without changing tool duration precision", () => {
  for (const [ms, expected] of [
    [-100, "0s"], [0, "0s"], [800, "0s"], [999, "0s"], [1000, "1s"],
    [1800, "1s"], [3500, "3s"], [9999, "9s"], [10000, "10s"],
    [59999.9, "59s"], [60000, "1m 00s"], [75999, "1m 15s"], [3665999, "1h 1m 5s"],
  ] as const) {
    assert.equal(formatTimeTookDuration(ms), expected);
  }
  assert.equal(formatToolDuration(800), "0.8s");
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


test("session time accumulates across a resumed execution session", async () => {
  const { executionSessionTiming } = await import("../src/services/sessionMetrics.ts");
  const first = createMockExecution({ id: "first", sessionId: "session-a", startedAt: 1_000, completedAt: 5_000,
    metrics: { durationSeconds: 3.5, assistantMessages: 1, tools: 0, toolErrors: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } });
  const followUp = createMockExecution({ id: "follow-up", sessionId: "session-a", startedAt: 10_000, completedAt: null,
    status: "running", metrics: null });
  const forked = createMockExecution({ id: "forked", sessionId: "session-b", startedAt: 20_000, completedAt: 25_000 });
  const timing = executionSessionTiming([first, followUp, forked], followUp);
  // The follow-up resumes the first attempt's session, not a fresh clock.
  assert.equal(timing.startedAt, 1_000);
  assert.equal(timing.priorDurationSeconds, 3.5);
  // A forked session only carries its own attempts.
  const forkTiming = executionSessionTiming([first, followUp, forked], forked);
  assert.equal(forkTiming.startedAt, 20_000);
  assert.equal(forkTiming.priorDurationSeconds, 0);
});

test("Planner time took adds earlier turns of the same Planner session", async () => {
  const { plannerSessionTiming, plannerTurnSummaries, mergePlannerTurns } = await import("../src/services/sessionMetrics.ts");
  const role = (sessionId: string | undefined, sessionStart: number | undefined, durationSeconds: number) => ({
    model: "planner/model", sessionId, sessionStart: sessionStart === undefined ? undefined : String(sessionStart),
    durationSeconds, assistantMessages: 1, tools: 0, toolErrors: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  });
  const turn = (planningId: string, planner: ReturnType<typeof role>, createdAt: number) => ({
    planningId, roles: { planner }, totalPlanningDuration: planner.durationSeconds, modelDuration: planner.durationSeconds, createdAt,
  });
  const first = turn("turn-1", role("planner-session", 1_000, 60), 1_000);
  const second = turn("turn-2", role("planner-session", 90_000, 30), 90_000);
  const abandoned = turn("turn-old", role("old-session", 500, 5), 500);
  const timing = plannerSessionTiming([abandoned, first, second]);
  assert.equal(timing.startedAt, 1_000);
  // The latest turn's own 30s is displayed separately; the earlier 60s is prior.
  assert.equal(timing.priorDurationSeconds, 60);
  // A different Pi session (an edited branch) does not inherit the old start.
  const branchTiming = plannerSessionTiming([first, abandoned, turn("turn-3", role("new-session", 200_000, 10), 200_000)]);
  assert.equal(branchTiming.startedAt, 200_000);
  assert.equal(branchTiming.priorDurationSeconds, 0);
  // Legacy turns without session IDs stay in the same conversation.
  const legacyTiming = plannerSessionTiming([turn("legacy", role(undefined, 5_000, 20), 5_000), second]);
  assert.equal(legacyTiming.startedAt, 5_000);
  assert.equal(legacyTiming.priorDurationSeconds, 20);
  // A recovered attempt can be recorded after later turns; the displayed turn
  // still owns its own duration while every other session turn is prior.
  const recovered = turn("recovered", role("planner-session", 150_000, 10), 10_000);
  const recoveredTiming = plannerSessionTiming([first, second, recovered], { latestId: "recovered" });
  assert.equal(recoveredTiming.startedAt, 1_000);
  assert.equal(recoveredTiming.priorDurationSeconds, 90);
  // A new live turn is not recorded yet: its clock is separate and every
  // completed turn of the session remains prior.
  const liveTiming = plannerSessionTiming([first, second], { latestId: null, fallbackStartedAt: 200_000 });
  assert.equal(liveTiming.startedAt, 1_000);
  assert.equal(liveTiming.priorDurationSeconds, 90);

  const summaries = plannerTurnSummaries([
    { type: "planner_workspace_selected", planning: { ...first, roles: { planner: role("planner-session", undefined, 0) } } },
    { type: "created", planning: first },
    { type: "graph_revised", planning: second },
  ] as any);
  assert.deepEqual(summaries.map(item => item.planningId), ["turn-1", "turn-2"]);
  assert.equal(summaries[0].roles.planner.durationSeconds, 60, "the committed summary replaces its running placeholder");
  // A stale running copy must not erase a settled turn's session timing.
  const merged = mergePlannerTurns(summaries, [{ ...first, roles: {} }]);
  assert.equal(merged[0].roles.planner.durationSeconds, 60);
  // A recovered older attempt appended after later turns must not become the
  // "newest" element that usage prefixes treat as the displayed turn.
  const recoveredMerge = mergePlannerTurns([second], [abandoned]);
  assert.deepEqual(recoveredMerge.map(item => item.planningId), ["turn-old", "turn-2"]);
});

test("Planner session levels keep prior turns while the next turn streams live", () => {
  // Earlier turns contribute their completed 60s; the live turn adds its elapsed.
  const live = calculatePlannerDurationMs({ isPlanning: true, startedAt: 100_000, priorDurationSeconds: 60, now: 103_500 });
  assert.equal(live, 63_500);
  // A settled total adds the displayed turn's own duration.
  const settled = calculatePlannerDurationMs({ isPlanning: false, durationSeconds: 30, priorDurationSeconds: 60 });
  assert.equal(settled, 90_000);
  // Prior-only data still shows the accumulated session after a restart.
  const priorOnly = calculatePlannerDurationMs({ isPlanning: false, durationSeconds: null, priorDurationSeconds: 60 });
  assert.equal(priorOnly, 60_000);
});
