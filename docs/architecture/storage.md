# Storage and cleanup

> **Scope:** Runtime/cache layout, resource lifetime and cleanup ownership. Event/log format belongs to [Runtime](runtime.md#event-and-output-storage); Git/shadow retention belongs to [Workspaces and Git](workspace-snapshots-and-feedback.md#shadow-repository-lifecycle); environment evidence retention belongs to [Native environments](native-environments.md#current-state-historical-evidence-and-ownership).
> **Maintained with:** [cleanup.rs](../../backend/src/cleanup.rs), [workspace_cleanup.rs](../../backend/src/workspace_cleanup.rs), [native_runtime_storage.rs](../../backend/src/native_runtime_storage.rs), [cleanup tests](../../backend/src/cleanup_tests.rs) and [runtime-cache tests](../../scripts/native-runtime-storage.test.mjs).

## Runtime data

Runtime data defaults to `.grapher/`, configurable with `GRAPHER_DATA_DIR`:

```text
.grapher/
  events.sqlite          # Events, log chunks, ownership and durable cleanup tasks
  runtime.lock           # One backend writer per data directory
  planning/              # Planning attempts and JSONL output
  sessions/              # Node Pi sessions
  planner-sessions/      # Planner history for Runs without a prior planning attempt
  partition-workers/     # Legacy Partitioner sessions retained for cleanup/recovery
  mergers/               # Merger sessions/output (including composition attempts)
  environments/          # Managed native-environment snapshots and launch records
  shadow_repos/          # Temporary external Git metadata for ordinary folders
```

Data-directory writer exclusion and startup recovery are specified in [Recovery and ownership](runtime.md#recovery-and-ownership).

## Workspace placement and lifetime

Graph workspaces default to:

| Platform | Workspace parent |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Grapher\workspaces` |
| macOS | `~/Library/Caches/Grapher/workspaces` |
| Linux | `${XDG_CACHE_HOME:-~/.cache}/grapher/workspaces` |

Run slots live beneath the parent's `.grapher-worktrees/` directory. `GRAPHER_CACHE_DIR` changes the cache root; `GRAPHER_WORKSPACE_PARENT` overrides the node-workspace parent. Cache placement is independent of `GRAPHER_DATA_DIR`. Existing execution paths are retained, not moved.

Successful publication/reset cleans owned workspaces but keeps Pi histories for follow-ups. Git reconstruction and ownership constraints follow [Cleanup and reproducibility](workspace-snapshots-and-feedback.md#cleanup-and-reproducibility); do not infer a node's current workspace from its allocation name.

Conversation deletion/clearing history cleans owned Node/Planner/Merger histories, attachments and all historical planning attempts, preserving shared resources and source projects.

## Workspace removal transaction

Removing a workspace in the UI invokes backend `delete_workspace`, including conversations absent from that browser's index. Repository bindings match exactly or by verified path aliases, never by path prefix.

The backend:

1. Rejects active conversations, including planning, publication and managed result execution.
2. Validates every cleanup manifest.
3. Deletes events, checkpoints and execution logs together with durable cleanup ownership in one transaction.
4. Retains filesystem cleanup failures for retry and small deletion tombstones to reject stale writers.

The browser removes its workspace/conversation indexes only after the commit. It must not recreate an explicitly empty workspace list from a stale default repository. Source project files and shared engine caches are never workspace-removal targets.

## Shared Pi runtime cache

All projects/backends with the same engine inputs share one content-keyed Pi runtime cache under the OS cache's `workspaces/.grapher-workspaces/`. `GRAPHER_NATIVE_RUNTIME_PARENT` overrides this location.

The key covers engine/adapters, Pi source/builds, dependency locks, bundled extensions and platform/Node ABI—not workspace/session paths. An exclusive cache lock serializes preparation; shared process-lifetime file leases protect active readers. Cached engine inputs are rechecked before reuse. Damaged idle copies are rebuilt, never overwritten under live readers.

Successful caches survive shutdown/restart. Failed preparations, abandoned per-backend copies and unused obsolete versions are reclaimed before preparation; live versions are never removed. Marked copies at the old project-adjacent default are also recovered. Unknown unmarked legacy directories require explicit offline cleanup rather than guessed deletion.

The cache contains engine/dependencies, not project state or conversations. Role/process preparation belongs to [Pi prewarming](../development/pi-integration.md#prewarming-and-prepared-runtime); external shared-state limits belong to [Filesystem isolation](filesystem-isolation.md#shared-runtime-and-external-state).
