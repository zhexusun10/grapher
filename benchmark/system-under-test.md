# Grapher MVP system under test

Discovery completed before code changes on 2026-09-12. Repository initially clean.
Root architecture specification: `agent.md` (2,303 lines, read in full); no root AGENTS.md. `pi/AGENTS.md` applies only to the independent ignored Pi checkout, which is not modified.

## Actual paths

* Editable graph: React `App.save` → invoke `save_graph` → `Runtime.create` → Rust compiler → SQLite Created event → serialized Snapshot → React state. Approval: `control(approve)` → verify clean repository/base → Approved event → desktop `drive` → `Runtime.jobs` → worker threads → `perform` → Git worktree creation/composition → engine execute → snapshot commit → Finished/Failed → feedback/invalidation → next wave → Settled. React polls `snapshot` every 700ms except while busy/historical; node views use Snapshot.nodes/executions; failures use node.error and events.
* Goal: `plan_goal` → real Pi partition process + extension route_task → serial one-node graph OR Pi planner process + node/edge extension → `grapher --compile` subprocess on every mutation → Runtime.create → same approval/execution path. Planner is not alive during node execution.
* `pi` is the only engine in shipping builds. The deterministic actuator (`src-tauri/src/fixture.rs`, Cargo feature `fixture`) drives real compiler, runtime, event store and Git operations with deterministic Markdown writes, 650ms/node, first review REVISE then ACCEPT. It does **not** prove Pi/model success.
* Browser-only Vite preview runs the client-side `WebInteractiveRuntime` sandbox and invents display state. It is outside execution acceptance. `scripts/planner_client.py` is an independent Python experiment, not called by desktop.

## Implemented versus specification

| Capability | Actual MVP |
|---|---|
| Compiler | Implemented E001/002/101/201–207, ancestor feedback validation, batches, roots, terminals, W301 isolated-node warnings; no semantic goal-contribution analysis |
| Scheduler | Implemented bounded 1–8 concurrency, wave barrier (not continuous slot refill), failed dependency propagation |
| Approval | Implemented for both serial and graph routes |
| Workspaces | Real detached Git worktrees, parent merge before task, commit after task, conflict BLOCKED, human resolve |
| Feedback | Implemented exact final-line markers, fresh execution/session, descendant invalidation, bounded per-edge count |
| Persistence | SQLite append-only events + reducer, replay, interrupted-execution failure and paused recovery; one active graph |
| UI | React + React Flow, command invocation and polling, graph JSON editor, node output/error/history, local project list |
| Pi | CLI JSON stdout, tagged stderr, final message/error parsing, 15-minute timeout, process groups; model/auth external |
| Planner | Experimental prompts; mutation rollback via real compiler; partition route lacks spec reasoning field |
| Future/not implemented | Multiple engines, remote execution, semantic reachability analysis, automatic conflict resolution, automatic worktree cleanup/result integration, full interactive terminal, drag-edge graph authoring, durable multi-project runtime |

Pre-hardening mismatch: goal submission always called plan_goal, rejecting the then-default model-free engine. This was reproduced through the real frontend action/IPC contract and repaired by restoring a fixed-example save_graph entry. See findings.md for evidence. That engine has since been deleted from the product: goal submission again always calls plan_goal, hand-authored Graph IR remains the model-free desktop entry, and the browser sandbox carries the no-model UI path.

## Benchmark boundary

Canonical cases invoke **existing Tauri generated command handlers**, actual desktop drive, runtime, SQLite and workspaces through Tauri's official MockRuntime window host. Only the native WebView host is replaced; compiler/scheduling/engine/workspace/state are not mocked. Isolated case directories are retained under benchmark-results; never run tasks against the user's checkout or application data. Deterministic success cases use the `fixture`-feature actuator; every other layer is shipping code. Controlled process failure uses /usr/bin/false through the shipping Pi subprocess boundary, not fabricated runtime results. Real Pi case uses the local CLI with its existing authentication and an isolated trivial repository.

Frontend coverage: actual IPC serialized snapshots are checked against current TypeScript interfaces; actual TaskNode renders against runtime snapshot data. This does not automate native WebView clicks, approval dialog, browser polling or macOS lifecycle. Native UI automation is an explicit coverage gap, not a passing end-to-end claim.

## Tooling

`npm run dev`: browser sandbox preview, port 1420. `npm run desktop`: Tauri dev. `npm run build`: tsc + Vite. `npm test`: Rust non-desktop tests with `--features fixture` (many manually inject results). `cargo check --manifest-path src-tauri/Cargo.toml`: desktop check. `npm run desktop:build`: macOS bundle. Local cargo is ~/.cargo/bin/cargo and must be on PATH. Pi source and dependencies exist locally and are ignored. Existing extension smoke exercises actual Pi loader + compiler without a model.

## Observability

Product SQLite remains the runtime authority. Benchmark exports original events with benchmark IDs, plus initiating IPC requests/responses, compiler diagnostics, snapshots, timings and git state. Prepared/Started/Finished/Failed preserve node, attempt, session and revision attribution. Pi JSON carries model/usage when emitted; missing metrics are null, never zero guesses. Prior to baseline, additive process-start/exit metadata is emitted through the existing output channel. No behavior repair precedes the baseline.

## Resumed checkout, 2026-09-13

The frontend now calls runtimeService before Tauri invoke; browser preview has an independent simulator; desktop adds scoped single-run deletion. The updated harness exercises the actual desktop service and preserves the simulator as an explicit excluded boundary. Added history deletion contracts found and repaired two UI/backend consistency bugs. See [resumed scope](resumed-scope.md) for actual implementation changes, browser compiler parity mismatch, and the immutable resumed baseline. Native picker/titlebar changes are not exercised by the IPC host.
