# Resumed validation — 2026-09-13

The user resumed after additional repository work. The earlier acceptance applies to source hash 8384bbd04e1d63a0f6c3a72e23d8e9cfdbcf3a80a4faf504a6d7fabec69be5bb, not automatically to this checkout. Those original artifacts remain immutable.

## Boundary changes discovered before repair

* App actions now call `src/services/runtime.ts` → desktop `@tauri-apps/api/core.invoke` → existing Rust handlers. The harness now runs that actual service; only the native IPC transport is supplied by the test host. `isDesktop=true` is asserted, so browser simulation cannot accidentally make these cases pass.
* Browser preview now has an independent in-memory/localStorage simulator and TypeScript compiler, visibly labeled Web Interactive Sandbox. It performs no Git work or Pi execution. It remains outside the real desktop execution boundary. Static inspection finds its claim of 100% compiler equivalence inaccurate: dependency cycle E207 vs Rust E101, feedback ancestry E209 vs Rust E207, different warnings and execution semantics. This is an explicit architecture/parity gap, not a passing equivalent runtime and not NOT_IMPLEMENTED. Replacing/redesigning that new subsystem is outside this hardening scope.
* Desktop added `delete_run`; UI added workspace/run menus and local history indexes. Native folder picking changed to rfd and desktop scripts now supply the Cargo PATH. Existing new changes are retained.
* Node revision badges were intentionally removed from the view. Revisions remain part of the actual backend/IPC contract. B008 verifies those values plus visible attempt counts, not the former visual placement.

## New baseline and failures

`resumed-baseline-2026-09-12T19-18-51-989Z`: 9/10 PASS, B008 FAIL because the harness referenced obsolete direct-invoke bindings (BENCHMARK_BUG). Real Pi and all Rust deterministic execution cases passed.

After adapting only the harness, `resumed-contract-2026-09-12T19-21-20-744Z` reproduced two IMPLEMENTATION_BUG cases:

1. A backend-rejected active-run deletion still removes the frontend run index.
2. “Clear current workspace” calls global clear_history, deleting unrelated runs.

Repairs are confined to existing App.tsx handlers: propagate deletion rejection; scope deletion using actual persisted Config.repository; remove only successfully deleted IDs; avoid resetting another workspace's backend state. A deliberately stale sidebar entry cannot authorize deletion. All deletion operations occur exclusively in isolated benchmark fixtures, and pre-deletion product snapshots are exported.

`resumed-repair-history-2026-09-12T19-23-09-190Z`: B008 PASS, including both new contracts and every prior invariant. Repeated full validation follows these targeted checks.

The legacy report/numbers remain auditable; the latest final report must reference the new acceptance run and source hash. No browser-only simulation results count toward real desktop/Pi acceptance.
