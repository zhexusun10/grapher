# Storage and cleanup

> **Scope:** Runtime/cache layout, resource lifetime and cleanup ownership. Event/log format belongs to [Runtime](runtime.md#event-and-output-storage); Git/shadow retention belongs to [Workspaces and Git](workspace-snapshots-and-feedback.md#shadow-repository-lifecycle); environment evidence retention belongs to [Native environments](native-environments.md#current-state-historical-evidence-and-ownership).
> **Maintained with:** [cleanup.rs](../../backend/src/cleanup.rs), [workspace_cleanup.rs](../../backend/src/workspace_cleanup.rs), [native_runtime_storage.rs](../../backend/src/native_runtime_storage.rs), [cleanup tests](../../backend/src/cleanup_tests.rs) and [runtime-cache tests](../../scripts/native-runtime-storage.test.mjs).

## Runtime data

Runtime data defaults to `.grapher/`, configurable with `GRAPHER_DATA_DIR`.
On a known database-format mismatch, startup preserves that directory's existing
data and selects a separate current-format `format-1/` child (or the next available
numbered slot). Subsequent starts reuse it; all paths below are relative to the
effective data root reported in startup logs and bootstrap `dataPath`:

```text
.grapher/
  events.sqlite          # Events, log chunks, ownership and durable cleanup tasks
  runtime.lock           # One backend writer per data directory
  config.json            # Saved defaults shared by Run services
  file-changes/          # Versioned per-Run derived changes.json sidecars
  attachment-inputs/     # Immutable Run/node-scoped inputs awaiting delivery
  planning/              # Planning attempts and JSONL output
  sessions/              # Node Pi sessions
  planner-sessions/      # One deterministic Planner conversation per Run
  partition-workers/     # Unsupported historical directories are not adopted
  mergers/               # Merger sessions/output (including composition attempts)
  environments/          # Managed native-environment snapshots and launch records
  shadow_repos/          # Host-only graph Git databases for Git projects and ordinary folders
```

Data-directory writer exclusion, the persisted-format boundary and startup recovery are specified in [Runtime](runtime.md#persisted-format-boundary).

### Derived file-change summaries

`file-changes/` sidecars are versioned caches, not history. Saves replace each cached execution's complete summary (including an authoritative empty result), while retaining executions not loaded in the current process. Repeated saves do not accumulate the same edits again. In-flight tool overlays remain live UI state; only confirmed tool changes are persisted. Terminal cache settlement follows the successful event commit, for both single and batched writes. Incompatible cache versions are rebuilt from retained evidence without rewriting events or transcripts.

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

## Detached workspace cleanup

Online publication/completion and workspace-cleanup retries retire disposable
workspace roots under the owning Run mutex instead of recursively deleting them
there. The same generation, writer/recovery, sharing, path and source-protection
checks still apply, including on startup/retry: active Mergers and result
processes block cleanup, and managed layouts, pending recovery/feedback and
undelivered private results remain owned until their retention requirements end.
A retained generation is acknowledged without discarding its ownership records;
explicit conversation deletion still handles those resources. Each eligible root
gets an independent SQLite
`detached_workspaces` receipt before a same-parent rename to a unique
`.grapher-cleanup-<UUID>` directory. A committed detached marker precedes any
recursive deletion. The original allocation path can then be reused without an
old cleanup touching new work; `workspace_cleanup_done` records that the cleanup
generation was handled (retired or retained by policy), not that all physical
bytes have already been freed.

The existing maintenance worker is woken to delete detached paths outside Run
locks, using a separate database connection. Failures retain receipts for retry,
including after restart or conversation deletion. A crash before rename leaves
the original generation-scoped task responsible for the old path; recovery never
renames or deletes that path from a detached receipt. A crash after rename is
recognized by its unique destination. Per-receipt leases serialize rename/retry
without holding a Run lock over deletion. Linked/redirected destinations and
protected source projects are refused; recursive removal still does not follow
child links. A receipt deletes only its unique detached directory, never even an
empty parent that a source project or new allocation may now own. Pi histories
and user source folders are not retirement targets.

Explicit synchronous reset/offline cleanup and slot reclamation
retain their existing execution paths. This change removes deletion from online
completion's critical section; it does not promise faster disk deletion or change
node dependencies, publication ordering, or source-edit permissions. Evidence:
[receipt/recovery tests](../../backend/src/cleanup/detached_tests.rs),
[maintenance integration](../../backend/src/detached_cleanup_service_tests.rs),
and the opt-in [lock probe](../development/testing.md#workspace-cleanup-lock-probe-opt-in).

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

Pi's installed dependency trees are omitted from the digest, so admission also
checks the copy's install marker, required package versions, workspace bindings
and extraneous packages against the trusted installation's profile/manifests.
This uses the installed [dependency verifier](../../scripts/pi-dependencies.mjs),
never verifier code from the cache. It is metadata validation, not byte-integrity
verification of every dependency file. The [readiness regression](../../scripts/ensure-deps.test.mjs)
covers damaged copies without loading the engine or extension factories.

Windows preparation dereferences runtime-input links, so its key likewise hashes
resolved bytes and directory shape rather than a link spelling absent from the
copy. Changing a linked adapter/extension invalidates the source key; the copied
code remains independent. Recursive directory links in hashed input scopes fail
during key calculation, before copying, while nonrecursive aliases remain valid.
Unix retains its existing link-preserving copy/key behavior. These rules concern
engine inputs, not project workspace inheritance or additional filesystem isolation.

Successful caches survive shutdown/restart. Failed preparations, abandoned per-backend copies and unused obsolete versions in the current runtime cache are reclaimed before preparation; live versions are never removed. Old project-adjacent caches and unmarked engine directories are left untouched. Offline cleanup also requires the current marker/lease protocol.

The cache contains engine/dependencies, not project state or conversations. Role/process preparation belongs to [Pi prewarming](../development/pi-integration.md#prewarming-and-prepared-runtime); external shared-state limits belong to [Filesystem isolation](filesystem-isolation.md#shared-runtime-and-external-state).
