# Workspace directories and Git publication

> **Scope:** Git-backed project inheritance, physical workspace ownership, feedback handoff, publication, and managed-environment boundaries.
> **Maintained with:** [workspace.rs](../../backend/src/workspace.rs), [native_copy.rs](../../backend/src/native_copy.rs), [runtime.rs](../../backend/src/runtime.rs), [graph_merge.rs](../../backend/src/graph_merge.rs), and the workspace/runtime tests.

Grapher has one project-file channel: **Git**. A node workspace is a physical
working tree, but successful node snapshots force-add all project files to the
node's Git commit. A file matching `.gitignore` is not a special Runtime state.
`.gitignore` remains a tracked Git file and can conflict normally; its patterns
do not prevent Runtime from collecting project files.

The only paths outside this project Git channel are Grapher internals, Runtime
data, and explicitly managed native-environment scopes/caches. Managed
environment scopes retain their own evidence/manifests because they are an
environment contract, not project output.

## Git collection

Every source/node Git snapshot uses a forced Git add equivalent to:

```text
git add -f -A
```

with pathspec exclusions for:

- `.git` and Git internals;
- `.grapher*` and Runtime data;
- managed environment/cache scopes;
- untracked macOS host metadata (`.DS_Store`, `._*`). Tracked metadata stays
  in the snapshot: exact index paths are staged again after the excluded add.
  Windows and Linux retain their previous collection strategy.

The collector does not ask Git whether a project path is ignored. Ignored
project files, newly created files, modifications, and deletions therefore all
enter the snapshot commit. This applies both to source snapshots and to node
result snapshots. No `before-*`/`after-*` project-file manifests, content
hashes, or Run blob stores are created. On macOS, untracked host metadata is
also ignored by cleanliness/status checks, so merely browsing a project in
Finder does not block publication; a tracked metadata edit remains a real
change because exact index paths are staged again.

This intentionally changes the meaning of `.gitignore` inside Grapher: it is
still part of the project's Git history and still participates in Git merges,
but it is not a Runtime collection boundary. A regular file that is created
under an ignored directory is still part of the node's Git result.

### Interpreter bytecode

Every process Runtime launches for the Agent — source Planner/Node/Serial,
private Graph nodes, Mergers, prewarmed hosts and managed launches — carries
`PYTHONDONTWRITEBYTECODE=1`, set after any caller or launch binding so neither
can re-enable it. Python then compiles modules in memory and writes no
`__pycache__`/`.pyc` into the project tree, so a test or import run cannot leave
bytecode churn that a later snapshot commit would collect. The automatic
environment policy does not declare a `PYTHONPYCACHEPREFIX` redirect: Runtime
owns bytecode policy uniformly instead of giving a managed cache scope its own
rules.

This changes what agents *create*, not what a project already tracks. A `.pyc`
that the user's own Git history committed stays an ordinary tracked project
file: it is collected, merged and published like any other project file, and
`git status` still reports it. Program/model behavior is unaffected — bytecode
is a cache, and CPU/NPU kernel caches such as Triton, TorchInductor and CUDA
JIT outputs are separate systems that this policy does not touch.

There is no automatic per-file size guard. A large project file is collected
by Git like any other project file. Git will read/hash it and may create a
large object; projects that need different storage must use an explicit Git
LFS/artifact policy. Grapher keeps a single project-file channel, so a large
file is treated like any other project file; this does not make Git large-file
I/O cheap.

The user's desktop folder is not an accepted binding: [detection and
binding validation](../../backend/src/workspace.rs) refuse it before a shadow
repository is created, so forced collection cannot walk unrelated personal
data. Bind an actual project directory instead. Workspaces exceeding 10GB are
also rejected by validation to prevent out-of-memory or system stalls from
unmanaged large datasets or build caches; large files must be kept outside the
workspace or a deeper subfolder selected.

## Shadow repository lifecycle

An ordinary folder (no `.git`) uses a temporary external Git metadata
repository under `<data>/shadow_repos/`. Detection, planning, approval and
pre-dispatch Planner revisions are pure filesystem operations and never create
it. The snapshot is materialized lazily by the first dispatched node worker,
which force-collects the current source files once and records a
`SourceSnapshotted` event plus durable cleanup ownership. Serial runs and
standard Git repositories never create a shadow repository.

Materialization runs without holding the Runtime lock, so the UI keeps
reporting a `source_materialize` activity while Git walks the project. A
successful publication reclaims the shadow repository as soon as no other
incomplete Run still needs the shared snapshot; failed, interrupted and paused
Runs keep it for `retry_publication` and evidence. Run deletion and the offline
`--cleanup-workspaces --apply` GC also reclaim it. `""` is the only encoding
of "no Git snapshot", and every consumer must handle it explicitly.

After a successful publication, a conversation with a completed node edits the
source directory directly: no shadow repository is rebuilt, no new worktree is
allocated, no commit is created, and downstream results are not invalidated or
republished. Only a Planner revision that dispatches new nodes materializes a
fresh snapshot from the current source files. The same applies to a
publication-merger follow-up once the successful publication has reclaimed an
ordinary folder's snapshot; a follow-up on a retained failed-publication
snapshot keeps its Git-backed merge behavior.

A revised graph that reuses already-completed nodes dispatches new nodes from
the fresh snapshot. Recorded parent commits that only existed in the reclaimed
snapshot are not resolved or merged: their published content is already part
of that snapshot.

## Physical workspaces and ownership

```text
<workspace-parent>/.grapher-worktrees/<run>/<node>-<execution>/
```

A physical directory is a reusable node/Merger single-writer slot, not a
permanent node identity or a security sandbox. A Planner follow-up may share the
newest slot with its active writer; the writer snapshots the combined directory
when it drains.

| Transition | Git behavior | Physical behavior |
| --- | --- | --- |
| Root/new slot | Checkout the recorded source commit | Prepare a private working tree; any source files outside the recorded commit are copied once from the selected source baseline |
| Linear A → B | B starts from A's committed result | Reuse/hand off A's directory when possible |
| Single-source feedback B → A | A receives B's committed result and normal Git ancestry | Reuse B's directory after ownership, generation, budget and drain checks |
| Concurrent feedback to A | Git merges only applicable feedback senders' pinned commits | Compose in a separate target-owned slot; retain the senders' directories as immutable evidence |
| Fan-out | Each branch has a distinct Git working tree and result history | One branch may take the parent slot; other branches get independent slots |
| Fan-in | Git merges all parent commits; conflicts include formerly ignored paths and `.gitignore` | The selected parent directory is used for the merge. Runtime reuses a verified environment at that current workspace when possible; otherwise the downstream execution is unbound. Parent environments need not agree and are never directory-merged |

The native copy primitive remains available for creating a new physical slot
and for files that are intentionally outside the project Git channel. It uses
CoW where available and byte copies otherwise, preserves permissions, keeps
symbolic links as links, does not follow them, and rejects unsupported special
files. It excludes Git/Grapher internals and managed environment scopes.

Each execution has a fresh conversation unless it is an explicit continuation
or feedback session fork. Conversations are never transferred through Git.

## Backend Git storage

A node repository borrows the source object database through
`.git/objects/info/alternates` when the source has no chained alternates or
promisor packs. Otherwise Runtime fetches the pinned source/result commits into
an independent object store.

Source snapshots and node results are pinned as Grapher-owned refs in the source
repository:

- `refs/grapher/heads/<commit>` pins snapshot heads;
- `refs/grapher/runs/<run>/nodes/<node-id>` pins node results (legacy unscoped
  refs use `refs/grapher/nodes/<node-id>`);
- inside a node repository, `refs/grapher/base` and
  `refs/grapher/parents/<node-id>` pin the prepared inputs.

These refs are host storage, not an agent messaging protocol. Runtime fetches a
node snapshot back into the source repository without touching the source
working tree.

## Composition and conflicts

Git is the composition authority. Before a task runs, parent commits are
merged using normal Git semantics. A conflict in any tracked path—including a
path that the source project's `.gitignore` would normally ignore—is a Git
conflict and follows the existing Merger flow.

Project files are committed before composition, so an ordinary-file conflict is
a Git conflict. If two parents create or modify the
same path differently, Git reports the conflict. A successful Merger must
stage the resolution and commit a clean result preserving the incoming
parents.

A completed workspace that is modified after completion fails the feedback
handoff cleanliness check. The result must first be represented by a new
execution/snapshot; Runtime does not silently absorb an unrecorded mutation.

The one exception is residue left by the target's own failed repair attempt. A
single-source handoff executes the target in the sender's directory, so a
failed attempt can leave an unrecorded after-snapshot commit or interrupted
writes there. The retry adopts that live head as its base — recording it
through the retry's Prepared input — provided the pinned input is still a Git
ancestor of the live tree and the previous attempt failed in that same
directory. External mutations, sender drift, discarded pinned history and
multi-source senders remain refused.

## Feedback and history edits

For feedback to A:

1. Runtime applies the [budget, generation and batching rules](runtime.md#bounded-feedback).
2. A single applicable sender B hands off its completed Git working tree and
   commit. For multiple senders, Runtime pins every contributing execution,
   directory and commit, then composes their Git results in a separate
   target-owned slot before A's agent starts. Only applicable `<FEEDBACK>`
   senders contribute; parallel `<ACCEPT>` workspaces are not merged into repair.
3. Every contributing directory must still be Run-owned, clean and at its
   recorded commit. Sources stay reserved against reuse/reclamation until the
   repair releases them. A real Git conflict invokes the existing Merger;
   failed composition preserves the partial slot and original source evidence
   without starting A's agent. Retry can recompose from those immutable inputs.
   Managed environment directories are never merged; normal environment reuse
   or best-effort unbound selection applies at the new slot.
4. A's own Pi history is forked; sender conversations are never imported.
   A failed multi-source repair with Prepared evidence retains its partial target workspace
   for continuation rather than replacing it with the senders' old files.
5. A's next execution produces another Git snapshot containing all project
   files, including files that match `.gitignore`. Cross-layer regressions are
   in [feedback batch tests](../../backend/src/feedback_batch_tests.rs).

History edits retain the existing Git rollback/branch behavior. There is no
separate project-file `before-*` snapshot to restore and no second file
version channel.

## Publication

Publication is Git-only:

1. Source-side user changes are staged into a Git base using the same forced
   collection rules.
2. Terminal node commits are merged into that source repository.
3. Git applies additions, modifications, and deletions, including paths that
   were previously ignored by the project.
4. A successful Git merge is the published project state.

Publication does not need a separate ordinary-file copy-back pass. It does not
read `.gitignore` to decide which node outputs to deliver. It preserves the
existing Merger/retry/recovery lifecycle and only completes after
`PublicationCompleted`.

## Managed environment boundary

Managed environment scopes/caches are not project output. They remain governed
by `environment.rs` and their scoped evidence store; they are not force-added
into project Git. They are never merged between parents and never copied back
into the source. Runtime may reuse a verified environment at the current physical
workspace; otherwise the execution starts unbound. Different terminal
environments can publish separate business entries over the same final code; see
[native environments](native-environments.md#publication-and-model-free-execution).

## Cleanup and reproducibility

Git commits and refs provide the project history needed for reconstruction.
Physical workspace slots may be reclaimed after their ownership/recovery
requirements end. Pi sessions and Git history remain separate from workspace
identity. Ordinary Runtime data and managed environment stores have their own
cleanup/evidence rules.

Project results are Git-reproducible after snapshotting, including paths that
`.gitignore` would hide from a normal user `git add`. This does not promise
provider/model reproducibility or filesystem-sandbox behavior; see
[Filesystem isolation](filesystem-isolation.md).

## Implementation and evidence

- [workspace.rs](../../backend/src/workspace.rs): forced Git staging,
  snapshots, refs, parent composition, and source publication preparation.
- [native_copy.rs](../../backend/src/native_copy.rs): physical directory copy
  primitive, CoW/byte fallback, permissions, links, and special-file rules.
- [runtime.rs](../../backend/src/runtime.rs): allocation, single-writer
  ownership, handoff, feedback, retries, and publication lifecycle.
- [model.rs](../../backend/src/model.rs): current Git-only projections plus
  read-only deserialization of legacy file-channel records.
- [environment.rs](../../backend/src/environment.rs) and
  [workspace_files.rs](../../backend/src/workspace_files.rs): managed native
  environment scopes only.
- [workspace_tests.rs](../../backend/src/workspace_tests.rs),
  [runtime_tests.rs](../../backend/src/runtime_tests.rs),
  [feedback_workspace_tests.rs](../../backend/src/feedback_workspace_tests.rs),
  and [environment_tests.rs](../../backend/src/environment_tests.rs): forced
  collection, Git conflicts, handoff, fan-out/fan-in, publication, links, and
  managed-environment behavior.
