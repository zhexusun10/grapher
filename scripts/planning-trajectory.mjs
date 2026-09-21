#!/usr/bin/env node
// Summarize retained Pi events without treating exploratory tool failures as quality failures.
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node scripts/planning-trajectory.mjs <events.jsonl> [...]');
const reports = files.map(file => {
  const events = fs.readFileSync(file, 'utf8').split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const start = events.find(e => e.type === 'grapher_process_started');
  const end = events.findLast(e => e.type === 'grapher_process_exited');
  const origin = start?.timestamp;
  const pending = new Map();
  const calls = [];
  const intervals = [];
  let firstSuccessfulGraphMutationMs = null;
  let lastGraphFailure = null;
  let graphRejectionStreak = 0;
  let longestGraphRejectionStreak = 0;
  const graphDiagnostics = {};
  let firstAssistantAt = null;
  const usage = {};
  for (const e of events) {
    const at = e.grapherReceivedAt ?? e.timestamp;
    if (firstAssistantAt === null && ['message_update', 'message_end'].includes(e.type) && e.message?.role !== 'user') firstAssistantAt = at;
    if (e.type === 'tool_execution_start') {
      const call = { id: e.toolCallId, name: e.toolName, startMs: at - origin, endMs: null, durationMs: null, isError: null, args: e.args };
      calls.push(call); pending.set(e.toolCallId, call);
    }
    if (e.type === 'tool_execution_end') {
      const call = pending.get(e.toolCallId);
      if (!call) continue;
      call.endMs = at - origin;
      call.durationMs = call.endMs - call.startMs;
      call.isError = Boolean(e.isError || e.result?.isError);
      if (call.isError) call.result = e.result;
      if (['node', 'edge'].includes(call.name)) {
        const text = e.result?.content?.find(c => c.type === 'text')?.text;
        let mutation;
        try { mutation = JSON.parse(text); } catch {}
        if (mutation?.mutationApplied === true && !call.isError) {
          firstSuccessfulGraphMutationMs ??= call.endMs;
          graphRejectionStreak = 0;
        } else if (mutation?.mutationApplied === false) {
          lastGraphFailure = mutation.diagnostics ?? [];
          graphRejectionStreak++;
          longestGraphRejectionStreak = Math.max(longestGraphRejectionStreak, graphRejectionStreak);
          for (const diagnostic of lastGraphFailure) {
            graphDiagnostics[diagnostic.code] = (graphDiagnostics[diagnostic.code] ?? 0) + 1;
          }
        }
      }
      if (Number.isFinite(call.startMs) && Number.isFinite(call.endMs)) intervals.push([call.startMs, call.endMs]);
      pending.delete(e.toolCallId);
    }
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      for (const [key, value] of Object.entries(e.message.usage ?? {})) if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
    }
  }
  // Union intervals: concurrent tools must not double-count wall time.
  let toolWallMs = 0, right = -Infinity;
  for (const [left, end] of intervals.sort((a, b) => a[0] - b[0])) {
    toolWallMs += Math.max(0, end - Math.max(left, right));
    right = Math.max(right, end);
  }
  const elapsedMs = end?.elapsedMs ?? null;
  return {
    file: path.resolve(file), complete: Boolean(end), success: end?.success ?? null,
    timedOut: end?.timedOut ?? false,
    providerRetries: events.filter(e => e.type === 'auto_retry_start').length, elapsedMs,
    firstAssistantMs: firstAssistantAt == null ? null : firstAssistantAt - origin,
    firstGraphMutationMs: calls.find(c => ['node', 'edge'].includes(c.name))?.startMs ?? null,
    firstSuccessfulGraphMutationMs, longestGraphRejectionStreak, graphDiagnostics, lastGraphFailure,
    processSuccess: end?.success ?? null,
    outcomeNote: 'Process exit success is not graph compilation or task success. firstGraphMutationMs measures the first attempt; firstSuccessfulGraphMutationMs requires mutationApplied=true.',
    toolWallMs, nonToolWallMs: elapsedMs == null ? null : Math.max(0, elapsedMs - toolWallMs),
    timingNote: 'Receipt timestamps measure host-observed activity. Non-tool time includes model generation, network, startup and orchestration; it is not pure reasoning time.',
    tools: calls.length, toolErrors: calls.filter(c => c.isError).length, incompleteCalls: pending.size, usage, calls,
  };
});
console.log(JSON.stringify(reports, null, 2));
