# Failure classification and repair ledger

## Baseline (immutable)

`baseline-2026-09-12T14-22-30-778Z`: first complete suite before behavior repairs. 8 PASS, 2 FAIL. Deterministic 8/9; agent 0/1. Raw result classification was provisional; this ledger is the reviewed classification authority.

* B008: **BENCHMARK_BUG**. Original expectation: wire snapshots satisfy TypeScript Snapshot. The test used fresh object literals, which additionally prohibited fields omitted from the deliberately partial GraphEvent UI interface (config, graph, execution_id etc.). JavaScript/Tauri permits those fields. Change: generic structural constraint `T extends Snapshot`, preserving required field and type validation without excess-property checks. No product contract change needed. Further entry/filter coverage is added before any behavior repair because a node render alone cannot detect command routing or timeline filtering failures.
* B010: **ENVIRONMENT_FAILURE**, agent-dependent layer. Real local Pi started, selected dashscope/qwen3.8-max, made initial request plus 3 provider retries, each timed out; exited successfully at OS level but emitted assistant error. Runtime correctly recorded failed attempt, error and needs_attention. No compiler/runtime repair justified. Network-restricted execution will be compared with an explicitly scoped network-enabled run; not rerun-until-green.
* Harness construction before baseline: Rust adapter missed `use super::*`; build failed before any suite execution, fixed import only. Not a product failure.

## Confirmed implementation issues to reproduce before repair

* Fresh desktop bootstrap returns demo but goal submission always invokes Pi-only plan_goal; no demo option/entry remains on landing page. This contradicts the implemented demo capability and README, blocking the default user flow.
* Timeline node filter expects node_started/node_completed/node_failed, while product events are started/finished/failed. Intervention filter expects intervene, while product emits invalidated with human=true. Filtered views silently hide real execution/intervention events.

`baseline-contract-2026-09-12T14-25-37-188Z`: corrected structural contract PASS; all three added production-action/filter assertions FAIL before repair. Confirms the two implementation root causes above (timeline has two affected filters). No assertion relaxed to accommodate product behavior.

* `diagnose-latest`: **BENCHMARK_BUG** in the new load-action fixture: projects state was uninitialized, unlike React's [] initializer. Initialized projects=[]; kept the expectation unchanged.
* `diagnose-latest-initialized-2026-09-12T14-28-47-924Z`: **IMPLEMENTATION_BUG**. Return-to-latest clears historical, then load() immediately sets it true for completed/needs_attention/rejected runs, leaving the latest run read-only and disabling intervention. Minimal repair: load of the active runtime always clears historical; explicit history selection remains read-only.
* Pi network comparison: fixed 3 graph-IR samples all PASS (36.832s, 16.763s, 10.093s runtime); initial timeout classified ENVIRONMENT_FAILURE, not FLAKY runtime. One planned serial-path probe PASS (23.163s). These are separately named populations, never erased failed attempts.

* `npm test` after UI repairs: existing `second_runtime_cannot_execute_the_same_event_store` and `sqlite_replay_restores_state_and_crash_marks_running_attempt_failed` failed while Git-spawning tests ran concurrently. **IMPLEMENTATION_BUG** with timing-sensitive manifestation. `baseline-lock-2026-09-12T14-34-22-133Z` reproduces deterministically in B009: a forked child holds an inherited open file description; dropping the Runtime closes only the parent's descriptor, leaving flock held until the child execs/exits. Reopening incorrectly reports another owner. Repair: explicitly LOCK_UN when the Runtime owner drops. This preserves the exclusive-owner contract and makes lock lifetime independent of unrelated child descriptors. No serial-test workaround and no core architecture change.

* Pi adapter inspection found a sticky transient-error flag. Supplemental protocol regression `successful_provider_retry_clears_the_previous_assistant_error` failed before repair (`benchmark-results/protocol-before.log`): Pi emits an error message, auto_retry_start, then successful final message, but run_pi returns the old error. **IMPLEMENTATION_BUG**; reset agent_error on a subsequent successful assistant message. Original error remains in the raw event stream. This uses a scripted CLI solely for adapter protocol regression, explicitly excluded from canonical real-Pi success rates. Real Pi continues to be benchmarked independently.

* Existing Pi extension smoke initially failed with tsx local IPC socket `listen EPERM` in the restricted tool environment: **ENVIRONMENT_FAILURE**. Normal-permission rerun is recorded separately; no product code change. Frontend build retains the existing >500 kB chunk advisory: known packaging/performance limitation, not an execution failure.

Final acceptance: `benchmark-results/acceptance-2026-09-12T14-38-59-248Z.json` PASS. Three consecutive deterministic suites and final deterministic subset share the same source hash and logical metrics. Full suite 12/12 PASS, with 3/3 fixed planned Pi samples; original failures remain preserved.

## Resumed repository validation (2026-09-13)

The repository changed during interruption (new runtimeService, web simulator, history deletion, UI updates, rfd picker). Prior 12/12 results apply only to their saved source, not to these new changes. `resumed-baseline-2026-09-12T19-18-51-989Z` preserves the first complete run of the changed checkout before new repairs. B008 is **BENCHMARK_BUG**: harness bound old direct invoke closures, while the app now imports runtimeService/recordRunToWorkspace. Adapter now imports the actual service and transports its real Tauri invoke to the host.

Original render assertion expected a literal revision badge. The current UI intentionally hides revision labels while keeping attempt counts and persistent revision data; expecting the former layout is a **BENCHMARK_BUG**, not a runtime contract. Replacement checks keep IPC node/execution revision 1→2 assertions and require the actual visible attempt count and status. No core assertion is weakened. Browser simulation remains excluded from actual Rust execution acceptance.

Added pre-repair history contracts: a backend-rejected active-run delete must retain its UI index; a command presented as current-workspace clear must preserve unrelated persisted runs. Only isolated fixture histories are touched.

`resumed-contract-2026-09-12T19-21-20-744Z` confirms two new **IMPLEMENTATION_BUG** failures through actual runtimeService → Tauri commands: (1) handleDeleteRun catches a backend refusal and still removes the UI index; (2) handleClearHistory promises current-workspace scope but invokes global clear_history, deleting unrelated persisted runs. Minimal repair removes error swallowing and uses existing delete_run only for runs whose persisted Config.repository matches the selected workspace. Each successful deletion updates the UI; no global workspace reset is issued. No user data is exercised; regression fixtures retain pre-deletion event-store exports.

Current resumed acceptance: `benchmark-results/acceptance-2026-09-12T19-25-26-109Z.json` PASS. Same source hash `062ac1f3d9c802940fba2ca874e7ad09e4d75cb3bc1540aceba0a2776d7e4b8f` for all 3 deterministic runs and full final. Final 12/12, 34 attempts, 5 retries, 2 expected nonzero process exits. This supersedes the prior acceptance as the statement about the current code; prior artifacts remain unchanged.
