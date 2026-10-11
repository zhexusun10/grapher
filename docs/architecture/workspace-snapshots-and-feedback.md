# Workspace directories and Git publication

> **Status:** active
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
- managed environment/cache scopes.

The collector does not ask Git whether a project path is ignored. Ignored
project files, newly created files, modifications, and deletions therefore all
enter the snapshot commit. This applies both to source snapshots and to node
result snapshots. No `before-*`/`after-*` project-file manifests, content
hashes, or Run blob stores are created.

This intentionally changes the meaning of `.gitignore` inside Grapher: it is
still part of the project's Git history and still participates in Git merges,
but it is not a Runtime collection boundary. A regular file that is created
under an ignored directory is still part of the node's Git result.

There is no automatic large-file rejection. A 35GB project file is collected
by Git like any other project file. Git will read/hash it and may create a
large object; projects that need different storage must use an explicit Git
LFS/artifact policy. Removing the guard avoids silently treating a large file
differently from other project files, but it does not make Git large-file I/O
cheap.

## Physical workspaces and ownership

```text
<workspace-parent>/.grapher-worktrees/<run>/<node>-<execution>/
```

A physical directory is a reusable single-writer slot, not a permanent node
identity or a security sandbox.

| Transition | Git behavior | Physical behavior |
| --- | --- | --- |
| Root/new slot | Checkout the recorded source commit | Prepare a private working tree; any source files outside the recorded commit are copied once from the selected source baseline |
| Linear A → B | B starts from A's committed result | Reuse/hand off A's directory when possible |
| Feedback B → A | A receives B's committed result and normal Git ancestry | Reuse B's directory after ownership, generation, budget and drain checks |
| Fan-out | Each branch has a distinct Git working tree and result history | One branch may take the parent slot; other branches get independent slots |
| Fan-in | Git merges all parent commits; conflicts include formerly ignored paths and `.gitignore` | The selected parent directory is used for the merge; other slots are retired |

The native copy primitive remains available for creating a new physical slot
and for files that are intentionally outside the project Git channel. It uses
CoW where available and byte copies otherwise, preserves permissions, keeps
symbolic links as links, does not follow them, and rejects unsupported special
files. It excludes Git/Grapher internals and managed environment scopes.

Each execution has a fresh conversation unless it is an explicit continuation
or feedback session fork. Conversations are never transferred through Git.

## Composition and conflicts

Git is the composition authority. Before a task runs, parent commits are
merged using normal Git semantics. A conflict in any tracked path—including a
path that the source project's `.gitignore` would normally ignore—is a Git
conflict and follows the existing Merger flow.

A physical ordinary-file conflict is no longer a separate concept: project
files are committed before composition. If two parents create or modify the
same path differently, Git reports the conflict. A successful Merger must
stage the resolution and commit a clean result preserving the incoming
parents.

A completed workspace that is modified after completion fails the feedback
handoff cleanliness check. The result must first be represented by a new
execution/snapshot; Runtime does not silently absorb an unrecorded mutation.

## Feedback and history edits

For B → A feedback:

1. Runtime applies budget, generation and drain rules.
2. B's completed Git working tree and commit become A's repair input.
3. A's own Pi history is forked; B's conversation is never imported.
4. A's next execution produces another Git snapshot containing all project
   files, including files that match `.gitignore`.

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

Managed environment scopes/caches are not project output. They remain governed
by `environment.rs` and their scoped evidence store; they are not force-added
into project Git.

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
