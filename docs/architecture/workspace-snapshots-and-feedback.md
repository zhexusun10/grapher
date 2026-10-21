# Workspace directories and Git publication

> **Scope:** Git-backed project inheritance, physical ownership, shadow repositories, feedback handoff and private publication composition/files-only delivery.
> **Maintained with:** [workspace.rs](../../backend/src/workspace.rs), [native_copy.rs](../../backend/src/native_copy.rs), [runtime.rs](../../backend/src/runtime.rs), [graph_merge.rs](../../backend/src/graph_merge.rs), and the workspace/runtime tests.

Grapher has one project-file version channel: **Git**. The host prepares snapshots and transfers commits; agents do not exchange commits or use Git as a conversation protocol. Collection rules below define which paths enter this channel; [managed environment evidence](native-environments.md) is separate.

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

The collector does not query ignore status: additions, modifications and deletions enter source/node snapshot commits even under ignored directories. `.gitignore` is an ordinary tracked project file, not a collection boundary. No `before-*`/`after-*` project-file manifests, content hashes or Run blob stores are created.

On macOS, cleanliness/status checks also ignore untracked host metadata; browsing in Finder cannot alone block publication. Tracked metadata edits remain real changes.

Host Git runs outside the backend console (Windows `CREATE_NO_WINDOW`, Unix
separate process group), so service-level Ctrl+C/Ctrl+Break cannot abort a
snapshot. Git success is decided by its exit status; failures retain the
command, status, and captured output.

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

### Binding and size checks

There is no automatic per-file size guard: Git reads/hashes large project files and may create large objects. Use an explicit Git LFS/artifact policy when needed; the single-channel design does not make large-file I/O cheap.

The user's desktop folder is not an accepted binding: [detection and
binding validation](../../backend/src/workspace.rs) refuse it before a shadow
repository is created, so forced collection cannot walk unrelated personal
data. Bind an actual project directory instead. Workspaces exceeding 10GB are
also rejected by validation to prevent out-of-memory or system stalls from
unmanaged large datasets or build caches; large files must be kept outside the
workspace or a deeper subfolder selected.

## Shadow repository lifecycle

Graph source snapshots and node results use a host-only Git database under
`<data>/shadow_repos/`, including when the source has its own `.git`. Standard
Git source capture imports the user's HEAD read-only, stages into a private
index, and pins an internal snapshot without changing the source HEAD, refs or
index. Identical source trees with the same parents reuse an immutable snapshot.

For an ordinary folder (no `.git`), detection, initial planning, approval and
pre-dispatch Planner revisions remain pure filesystem operations. Its database
is materialized lazily by the first dispatched node worker, which force-collects
the current source files and records `SourceSnapshotted` plus cleanup ownership.
Serial does not create this database. Standard Git databases retain internal
history for continuation and conversation-owned cleanup; the ordinary-folder
reclamation rules below do not remove them.

Materialization runs without holding the Runtime lock, so the UI keeps
reporting a `source_materialize` activity while Git walks the project. A
completed Run releases the shadow repository as soon as no other incomplete Run
still needs the shared snapshot, so a snapshot is reclaimed at completion and
not only at publication. The release is re-checked when the Run's driver drains
and after a successful publication, and Run deletion applies the same "no
incomplete Run still needs it" predicate instead of pinning the snapshot to
every Run that still records the target. A completed Graph Run that never
published keeps the snapshot, because publication is the only copy of its merged
result; failed, interrupted and paused Runs keep it for `retry_publication` and
evidence. The offline `--cleanup-workspaces --apply` GC reclaims it under the
same predicate. `""` is the only encoding of "no Git snapshot", and every
consumer must handle it explicitly.

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

Graph slots are Run-owned private repositories, not `git worktree` checkouts. A physical directory is a reusable node/Merger single-writer slot, not a permanent node identity or security sandbox. Inputs come from the latest recorded source snapshot and completed dependency results, never the live source working tree.

Scheduling retains slots required by pending feedback/repair. The Planner is an exception to node/Merger writer exclusivity; its sharing and snapshot rules belong to [Planner follow-up workspaces](execution-model.md#planner-follow-up-workspaces).

| Transition | Git behavior | Physical behavior |
| --- | --- | --- |
| Root/new slot | Checkout the recorded source commit | Prepare a private working tree; any source files outside the recorded commit are copied once from the selected source baseline |
| Linear A → B | B starts from A's committed result | Reuse/hand off A's directory when possible |
| Single-source feedback B → A | A receives B's committed result and normal Git ancestry | Reuse B's directory after ownership, generation, budget and drain checks |
| Concurrent feedback to A | Git merges only applicable feedback senders' pinned commits | Compose in a separate target-owned slot; retain the senders' directories as immutable evidence |
| Fan-out | Each branch has a distinct Git working tree and result history | One branch may take the parent slot; other branches get independent slots |
| Fan-in | Git merges all parent commits | The selected parent directory is used for the merge; environment handling follows [local reuse/unbound selection](native-environments.md#branches-metadata-and-storage) |

Conversation creation, continuation and forks belong to [Session continuity](execution-model.md#sessions-follow-ups-and-history-edits).

### Physical copy primitive

[Native copy](../../backend/src/native_copy.rs) prepares new slots and files outside the Git channel. Ordinary slot preparation excludes Git/Grapher internals and managed environment scopes. It preserves permissions, keeps symbolic links as links without following them, and rejects unsupported special files; link access/rebasing follows [Inherited project resources](filesystem-isolation.md#inherited-project-resources).

It tries Linux FICLONE, macOS `clonefile` or Windows block cloning, then independent byte copies for unsupported storage operations. Other I/O errors fail. No writable hardlinks or shared mutable inodes are used. Clone support is filesystem-specific; it optimizes copying without promising stable logical paths, shared working layers, sandboxing or system snapshots. Managed snapshots impose additional [metadata restrictions](native-environments.md#branches-metadata-and-storage).

## Backend Git storage

A node repository borrows the host-only source database through Git alternates
when that database has no chained alternates or promisor packs; otherwise it
fetches the pinned inputs. The host database imports user history independently,
so node storage never writes objects or refs into the user's Git database.

Within a Run root, slot metadata lives in `.grapher-git/<slot>.git`, outside the
model's cwd, without a `.git` entry in ordinary node workspaces. Host Git resolves
it explicitly. Preparation and Merger repair temporarily expose Git only for
that operation; short reentrant relocation leases serialize host discovery and
moves, not model calls or Runtime events. Native file tools/Bash otherwise see
project files, not discoverable internal history. This is not an additional
security boundary on Windows.

Source snapshots and node results are pinned in the host-only database:

- `refs/grapher/heads/<commit>` pins snapshot heads;
- `refs/grapher/runs/<run>/nodes/<node-id>` pins node results (legacy unscoped
  refs use `refs/grapher/nodes/<node-id>`);
- inside a node repository, `refs/grapher/base` and
  `refs/grapher/parents/<node-id>` pin the prepared inputs.

These refs are host storage, not an agent messaging protocol. Runtime imports
node snapshots only into that database, without touching the user's working
tree, index, branch, refs or commit objects.

## Composition and conflicts

Git is the composition authority. Before a task runs, parent commits are
merged using normal Git semantics. A conflict in any tracked path—including a
path that the source project's `.gitignore` would normally ignore—is a Git
conflict and follows the existing Merger flow.

A successful Merger must stage the resolution and commit a clean result preserving incoming parents. Composition and publication pass the managed environment/cache scopes as staging exclusions, and merge completion removes any accidentally staged scope from the index, so a Merger cannot commit `.agent-home`, `.venv` or `.environments` into the branch; the live files stay in the workspace for the environment. Conversation controls, blocked-node retry and publication-Merger distinctions belong to [Merger lifecycle](execution-model.md#parent-composition-conflicts).

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
4. A failed multi-source repair with Prepared evidence retains its partial target workspace for continuation rather than replacing it with the senders' old files.
5. A's next execution uses the normal collection rules. Cross-layer regressions are in [feedback batch tests](../../backend/src/feedback_batch_tests.rs).

Session forks and history-edit rollback behavior belong to [Session continuity](execution-model.md#sessions-follow-ups-and-history-edits).

## Publication

Publication is Git-only, with internal composition separated from delivery:

1. Capture the source branch identity (or detached HEAD), HEAD commit, real
   index bytes and current project tree. Source changes use the same forced
   collection rules, but their snapshot is internal. Staged changes under an
   excluded scope remain staged and unpublished; they are not silently
   unstaged or removed.
2. Compose valid terminal heads and that source snapshot in a private,
   Run-owned publication workspace. Normal merge ancestry and Merger repair stay
   internal. Failed composition does not dirty the source or advance its branch.
3. Deliver the composed project tree as ordinary file changes. Do **not**
   fetch internal commits, create a `Grapher Work` commit, move the user's
   branch, or replace the user's index. The source's real index bytes and
   staged entries remain exactly as captured.
4. The source must still match its captured branch, HEAD, index and project
   tree before checkout. Apply the final tree under the source `index.lock`
   lease, but use only a private checkout index; the user's index is never
   rewritten. There is no ordinary-file copy-back pass or ignore-based delivery
   filter.

Immutable attempt journals beside the publication workspace retain inputs,
branch identity, original index and the composed result across restarts. All
earlier source inputs remain owned recovery heads when rebasing the same
publication. Crashes after a partial checkout finish the original delivery
rather than refreshing against the old input tree. The installed marker records
the exact internal result; completed retries do not reapply files onto a newly
selected branch. Foreign Git locks and unrelated source merges are not adopted
or removed. Changed source files/index/HEAD fail closed; before checkout begins,
a retry can merge a fresh source baseline into the retained composition without
rerunning nodes. A partially applied checkout requires recovery rather than
blindly absorbing source changes.

Completion verifies internal input ancestry and delivery evidence, not node
ancestry in the user's branch. Private bridge snapshots retain delivered node
ancestry for later revisions without exposing it in user history. Every later
publication (including additional post-task-review work) updates files only;
neither earlier node results nor delivered files are committed to the user's
repository. Ordinary folders retain the same private composition/retry
behavior without adding `.git`.

Phase transitions, completion checks, retained-head retries and failure handling belong to [Final publication](execution-model.md#final-publication).

## Managed environment boundary

Managed environment scopes/caches are excluded from project Git collection and source publication. They have a separate evidence store, not a second project-file channel. Scope ownership, reuse, fan-in and business entries belong to [Native environments](native-environments.md).

## Cleanup and reproducibility

Git commits and refs provide project-file reconstruction after snapshotting, independent of physical slot identity. Deleting a Graph conversation removes its run-scoped refs and orphaned internal heads, then prunes unreachable objects while retaining refs and protected heads of other live Runs; the shared source database is removed with its last conversation. This does not reproduce model output, requirement interpretation or code quality, and is not a [filesystem access boundary](filesystem-isolation.md).

Slots may be reclaimed only after ownership/recovery requirements end. Data/cache deletion belongs to [Storage and cleanup](storage.md); managed evidence retention belongs to [Native environments](native-environments.md#current-state-historical-evidence-and-ownership).

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
