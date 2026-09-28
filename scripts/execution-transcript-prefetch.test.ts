import assert from "node:assert/strict";
import test from "node:test";
import { runtimeService } from "../src/services/runtime.ts";
import { executionTranscriptCache, prefetchExecutionTranscript, prefetchRunExecutionTranscripts } from "../src/components/ExecutionTranscript.tsx";
import type { Execution } from "../src/types.ts";

test("settled execution prefetch shares requests and publishes only complete history", async () => {
  const original = runtimeService.getExecutionOutput;
  const runId = "prefetch-test-run";
  const execution = { id: "prefetch-test-exec", node: "node", status: "done", outputBytes: 12 } as Execution;
  const offsets: number[] = [];
  let releaseSecond!: () => void;
  const secondPage = new Promise<void>(resolve => { releaseSecond = resolve; });
  runtimeService.getExecutionOutput = async (_runId, _execId, offset, _signal, full) => {
    assert.equal(full, true);
    offsets.push(offset);
    if (offset) await secondPage;
    return {
      runId, executionId: execution.id,
      content: offset ? "second\n" : "first\n",
      nextOffset: offset ? 13 : 6,
      totalBytes: 13, complete: Boolean(offset), status: "done",
    };
  };
  try {
    const first = prefetchExecutionTranscript(runId, execution);
    assert.equal(prefetchExecutionTranscript(runId, execution), first);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executionTranscriptCache.has(`${runId}:${execution.id}`), false);
    releaseSecond();
    assert.equal(await first, "first\nsecond\n");
    assert.deepEqual(offsets, [0, 6]);
    assert.equal(executionTranscriptCache.get(`${runId}:${execution.id}`)?.complete, true);
  } finally {
    releaseSecond();
    runtimeService.getExecutionOutput = original;
    executionTranscriptCache.delete(`${runId}:${execution.id}`);
  }
});

test("conversation prefetch fills all settled node histories atomically in one request", async () => {
  const original = runtimeService.getRunExecutionOutputs;
  const runId = "batch-test-run";
  const executions = ["a", "b"].map(id => ({ id, node: id, status: "done", outputBytes: 10 } as Execution));
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  runtimeService.getRunExecutionOutputs = async () => {
    requests++;
    await response;
    return { runId, outputs: executions.map(exec => ({ executionId: exec.id, content: `log-${exec.id}`, totalBytes: 5, status: "done" })) };
  };
  try {
    const pending = prefetchRunExecutionTranscripts(runId, executions);
    assert.equal(requests, 1);
    assert.equal(executionTranscriptCache.has(`${runId}:a`), false);
    release();
    await pending;
    for (const exec of executions) {
      assert.deepEqual(executionTranscriptCache.get(`${runId}:${exec.id}`), {
        text: `log-${exec.id}\n`, offset: 5, complete: true, status: "done",
      });
    }
    await prefetchRunExecutionTranscripts(runId, executions);
    assert.equal(requests, 1);
  } finally {
    release();
    runtimeService.getRunExecutionOutputs = original;
    for (const exec of executions) executionTranscriptCache.delete(`${runId}:${exec.id}`);
  }
});
