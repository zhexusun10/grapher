# Conversation logs and acceptance

> **Scope:** Current-format log verification and offline workspace cleanup. Runtime owns the storage/API contract.
> **Maintained with:** [store/logs.rs](../../backend/src/store/logs.rs), [maintenance.rs](../../backend/src/maintenance.rs), [transcriptCache.ts](../../src/services/transcriptCache.ts) and [acceptance harness](../../scripts/conversation-acceptance.mjs).

## Storage contract

The canonical [event/output contract](../architecture/runtime.md#event-and-output-storage) defines append-only events, UTF-8 byte cursors, metadata loading and page sizes. The current release rejects unsupported databases and sessions before recovery or mutation. Reading a transcript does not import inline output, migrate logs or repair historical events.

The browser first loads the newest execution's bounded tail. Earlier executions acquire readers when reached in the viewport or explicitly opened; a slow history does not hide newer replies. Each page carries explicit `startOffset`, `nextOffset` and `totalBytes`, and must describe a contiguous UTF-8 byte range. `full=true` remains available to explicit full-output callers. See [Runtime](../architecture/runtime.md) and [transcriptWindow.ts](../../src/services/transcriptWindow.ts).

Recent execution and Planner windows use bounded LRUs. Cached windows never replace authoritative Run metadata; deletion/reset invalidates them. Older bytes page upward, with a shared viewport budget for automatic filling and separate explicit scrollback/retry behavior. [UI components](ui-components.md#transcript-cards-and-composer) owns those display rules.

## Offline maintenance

Back up the runtime data directory and stop its backend before explicit maintenance. Confirm `GRAPHER_DATA_DIR` selects the intended current-format database.

```sh
npm run cleanup:workspaces
npm run cleanup:workspaces -- --apply
npm run cleanup:workspaces -- --stale-days 7 --apply
```

Preview and apply acquire the backend's exclusive runtime lease. Cleanup uses recorded ownership, source protection and generation checks. Pass `--stale-days DAYS` to preview or reclaim abandoned incomplete Run workspace directories (leaving SQLite conversation history and source projects intact); `--apply` also drains pending detached cleanup receipts. It does not adopt old project-adjacent workspace layouts, unmarked engine copies or retired Partitioner directories. Missing ownership is not permission to delete a directory.

The old `migrate`/`compact`, paused-batch restoration and partial-publication-file repair commands are retired. Use a new data directory for a persisted-format change; keep the previous installation with its own data if access to old Runs is needed. Do not delete or rewrite old data to make the new version accept it.

## Diagnosing database size

Inspect the database read-only before treating it as a disposable cache. Retained conversations own their `execution_logs`; completed publication removes private project worktrees rather than conversation history. Compare log byte totals and row counts with `PRAGMA page_count`, `page_size` and `freelist_count`. Free space inside live B-tree pages differs from whole pages on the freelist.

Conversation and workspace deletion remove their event, checkpoint and log records transactionally. Tombstones and source-protection records survive to prevent stale writers and unsafe filesystem deletion. Online deletion performs bounded incremental reclamation; logical deletion does not promise immediate removal of every freed page from the physical file. Normal reads and startup do not repack retained transcripts.

## Acceptance prerequisites

The [harness](../../scripts/conversation-acceptance.mjs) needs a prepared checkout with Node/npm, pinned Pi dependencies, Rust and Git; Python 3.11+ (`PYTHON` may select the executable); and Playwright Chromium or Microsoft Edge on Windows (`GRAPHER_BROWSER_CHANNEL` may override the channel).

Run from the repository root:

```sh
npm run test:conversation-acceptance
```

`GRAPHER_ACCEPTANCE_DIR` may select a new, empty evidence directory. The default is a timestamped `.grapher/acceptance/` directory. The harness creates a disposable Git project and every Run through the current backend API. It never reads a user database, migrates old data or makes model calls. `GRAPHER_ACCEPTANCE_SOURCE` and the old legacy stress-fixture initializer are no longer used.

Builds share one invocation-owned temporary Cargo target, reclaimed after backend shutdown; an explicit `CARGO_TARGET_DIR` is reused and never deleted. Evidence databases, process logs, screenshots, browser traces and `report.json` remain in the evidence directory.

## Coverage

| Boundary | Verification |
| --- | --- |
| Large current logs and metadata allocation | [store_optimization.rs](../../backend/tests/store_optimization.rs), [load_allocation.rs](../../backend/tests/load_allocation.rs) |
| Atomic completion | SQL guards verify log-byte totals, stdout tail and final-response bytes before inserting `Finished` |
| UTF-8 and chunk integrity | Exact hashes for Chinese/emoji/ANSI worker output; contiguous, bounded SQLite chunks |
| Failure and restart | Natural worker failure, killed worker and stopped backend preserve committed log prefixes |
| Read concurrency | Concurrent HTTP readers agree and leave append-only business events unchanged |
| Browser histories | Current graph, failed execution history and repeated conversation switching retain execution/Run ownership |
| Deletion | Logs are reclaimed and stale history requests fail |

[Focused transcript checks](testing.md#focused-checks), frontend paging tests and Pi boundary tests cover pagination gaps, invalid cursors, repeated messages, unsupported formats and refusal before migration. These remain independent of the opt-in acceptance harness.

## Evidence and limitations

Only a completed report with `status: passed` represents a successful harness run. A failed or interrupted report must not be relabeled as a pass. Traces may contain source code, prompts, paths and output; review them before sharing. This is log/runtime/UI verification, not provider-quality or platform-sandbox acceptance.
