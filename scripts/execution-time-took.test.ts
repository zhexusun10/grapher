import assert from "node:assert/strict";
import test from "node:test";
import { calculateExecutionDurationMs } from "../src/components/ExecutionTimeTook.tsx";
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
