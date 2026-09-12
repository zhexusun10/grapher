# Benchmark harness contract (schema v1)

Entry: `npm run benchmark`. Runner: Node standard library, existing TypeScript/esbuild/React, Cargo feature `benchmark`. No added third-party packages. The test-only adapter is included in desktop.rs so it can call private generated command wrappers. It is excluded from shipping builds. Each case runs in a fresh OS process with its own Tauri MockRuntime host; the real desktop drive owns scheduling and worker threads.

Fixtures are small deterministic Graph values in desktop.rs, not model-generated graphs. The deterministic actuator is `src-tauri/src/fixture.rs`, compiled only under the Cargo `fixture` feature that `benchmark` enables; engine id `fixture`, isolated repository `fixture-repository`, output prefix `[fixture]`. Shipping builds contain no such engine and accept only `pi`, so only the node-execution step is substituted while compiler, scheduler, worktrees, event store and feedback stay on the shipping path. B006 deliberately configures `/usr/bin/false` as the executable to exercise a controlled real process failure. It does not fake a Runtime.finish result. B010 uses the actual local Pi installation. `--planning` changes only B010's initiation variant from hand-authored Graph IR to real plan_goal; variant must be reported when comparing results.

| ID | Layer | Acceptance |
|---|---|---|
| B001 | deterministic | command save → approval → real fixture worktree write → completed + replay |
| B002 | deterministic | A→B→C, upstream Finished precedes downstream Started |
| B003 | deterministic | A→B/C; actual engine output intervals overlap |
| B004 | deterministic | A→B/C→D; D contains all upstream files |
| B005 | deterministic | normal cycle E101, failed save leaves no executions/worktrees |
| B006 | deterministic | real child nonzero exit → failed A, blocked B, persisted cause, needs_attention |
| B007 | deterministic | REVISE → invalidation → fresh sessions → ACCEPT; independent node not rerun |
| B008 | deterministic | live IPC replay, revision history, structural TS contract, actual TaskNode SSR, original frontend action closures over live IPC, node/intervention filters and failure visibility |
| B009 | deterministic | feedback limit zero: no extra attempts, reviewer failed, independent node done; fork-inherited lock release and interrupted-run recovery |
| B010 | agent-dependent | real Pi writes exact hello.txt and runtime completes; optional real partition/plan initiation |

B008 extracts the existing action/filter AST from App.tsx for a contract test. State setters observe frontend state; invoke goes to a persistent real Tauri handler host via JSON stdin/stdout. Neither a fake backend nor a replacement scheduler is used. TaskNode and readableLog are exposed only in a test bundle, without changing their production exports. This covers action/serialization/render integration but does not prove native window clicks, effects or macOS window lifecycle.

## Artifacts

`benchmark-results/<label>-<UTC>/`: metadata.json, source.diff, source manifest, summary.json, cases.jsonl, events.jsonl, benchmark.log, build.log, `<case>-<sample>/`. Case directories retain compiler result, requests.jsonl, responses.jsonl, snapshot.json, result.json, SQLite WAL/event store, worktrees and Pi session directories. Frontend contract has before/after/failure JSON, emitted HTML, action results and another isolated host's event store. Original baseline is immutable; later classification corrections live in findings.md, not by rewriting baseline records.

Result identity: schemaVersion, benchmarkRunId, benchmarkCaseId, sample, variant, grapherRunId(s), gitCommit, dirtyWorkingTree, source digest, start/end/duration. Status is PASS/FAIL/NOT_IMPLEMENTED/NOT_APPLICABLE. Failure classification is BENCHMARK_BUG/IMPLEMENTATION_BUG/ENVIRONMENT_FAILURE/AGENT_FAILURE/FLAKY/NOT_IMPLEMENTED, with raw error and artifacts. Expected process failure is a passing negative scenario only when failure state, persisted cause and dependency blocking all hold.

Durations are wall clock in milliseconds. Runtime duration excludes frontend contract/build; case duration includes frontend checks; suite duration includes build/setup. retryCount counts fresh node attempts beyond first; providerRetryCount counts Pi auto_retry_start separately. Token usage is summed from message_end when present, otherwise null. Process failures count observed non-success OS exits; a model error may have OS exit 0. Do not compare fixture latency with model latency.

Historical records are immutable: `baseline.json`, `final*.json`, `resumed-baseline.json`, `report*.md`, `findings.md` and everything under `benchmark-results/` still carry the pre-removal `"engine":"demo"` value and `[demo]` log prefixes. They document runs of the engine that has since been deleted from the product; they are not rewritten to match the current `fixture` id.

## Reproduction and comparison

```sh
npm run benchmark:validate # three repeated deterministic suites + final 3 planned Pi samples
npm run benchmark -- --label baseline
npm run benchmark -- --deterministic --label repeat-1
npm run benchmark -- --case B008 --label targeted
npm run benchmark -- --label final --agent-repeats 3 --planning
```

Real Pi needs network and the already-configured Pi authentication. Optional overrides: BENCHMARK_PI_COMMAND, BENCHMARK_PI_ARGS (JSON array), BENCHMARK_PI_MODEL. They change engine configuration, never assert results. Model failures fail the scenario while the runtime invariants remain separately inspectable. No secrets are read by the harness. Keep artifacts local: tool/model output may contain source content.

Acceptance requires three consecutive deterministic full suites with identical statuses and stable logical metrics, plus actual Pi evidence where available. Native UI automation and unimplemented future capabilities stay explicit gaps. Run selection is for diagnosis; selected runs never count as full-suite acceptance.

## Resumed harness adjustment

B008 now imports the shipping runtimeService and the Tauri JS invoke implementation; a native IPC transport shim connects it to the real test host. It also verifies rejected deletion preserves UI indexes and current-workspace history clearing preserves unrelated event-store snapshots, even with a stale sidebar entry. The host saves original store snapshots before fixture-only deletion so execution metrics/history are not lost. Revision values are asserted on wire state while visible attempt counts are asserted in TaskNode, matching the current UI design. Cargo.lock is retained in source manifests. See resumed-scope.md.
