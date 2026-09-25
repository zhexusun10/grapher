import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateApprovalWaitingTime } from "../src/components/PlanningSummaryCard";
import { emptySnapshot, type PlanningSummary, type Snapshot } from "../src/types";

const planning: PlanningSummary = { planningId: "p", roles: {}, totalPlanningDuration: 0, modelDuration: 0 };
const createdAt = 1_700_000_000_000;
const base: Snapshot = {
  ...emptySnapshot,
  phase: "awaiting_approval",
  events: [{ sequence: 1, type: "created", timestamp: createdAt }],
};

test("approval wait stops at reject and remains fixed after reload", () => {
  assert.deepEqual(calculateApprovalWaitingTime(planning, base, createdAt + 5000), { durationSeconds: 5, isWaiting: true });
  const rejected: Snapshot = {
    ...base, phase: "rejected",
    events: [...base.events, { sequence: 2, type: "rejected", timestamp: createdAt + 7000 }],
  };
  assert.deepEqual(calculateApprovalWaitingTime(planning, rejected, createdAt + 999000), { durationSeconds: 7, isWaiting: false });
  assert.deepEqual(calculateApprovalWaitingTime(planning, JSON.parse(JSON.stringify(rejected)), createdAt + 2000000), { durationSeconds: 7, isWaiting: false });
});

test("approval wait also stops at approve and does not run outside pending phase", () => {
  const approved: Snapshot = {
    ...base, phase: "running", approved: true,
    events: [...base.events, { sequence: 2, type: "approved", timestamp: createdAt + 3000 }],
  };
  assert.deepEqual(calculateApprovalWaitingTime(planning, approved, createdAt + 999000), { durationSeconds: 3, isWaiting: false });
  assert.deepEqual(calculateApprovalWaitingTime(planning, { ...base, phase: "rejected" }, createdAt + 999000), { durationSeconds: 0, isWaiting: false });
});
