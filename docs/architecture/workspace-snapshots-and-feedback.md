# Workspace snapshots and feedback

> **Status:** active
> **Scope:** Recorded file channels, workspace ownership, feedback handoff and environment portability limits.
> **Maintained with:** [workspace_files.rs](../../backend/src/workspace_files.rs), [runtime.rs](../../backend/src/runtime.rs), [resource tests](../../backend/src/workspace_files_tests.rs) and [feedback tests](../../backend/src/feedback_workspace_tests.rs).

This page describes compatibility filesystem channels. Backend-admitted
[Native workspace environments](native-environments.md) keep frozen scopes/caches
out of both channels, add E/L evidence, refuse unsafe path changes and retain
managed layouts until explicit deletion. New standard Git Graph projects start
with an empty business binding; supported private environments created by
business tools are verified and scoped through versioned L, without environment
settings. Legacy Runs keep their recorded filesystem contract. The
allocator and conversation/feedback contracts below are unchanged; ordinary
ignored-resource merging and copying are **not** environment-merge rules.

## Two filesystem channels

Ordinary inputs combine the latest recorded source and successful parents:

- **Git** records tracked and non-ignored untracked files, ancestry and merge results. `.gitignore` remains effective; the backend does not force-add environments or weights.
- **Ignored files** use Run-owned content-addressed blobs and manifests. Approval/revisions capture source inputs; executions capture `before-<execution>` and `after-<execution>` versions. Manifests record Git head, parent versions, files, directories, links and Unix file permission bits.

```text
<workspace-parent>/.grapher-worktrees/<run>/
  <node>-<execution>/           # reusable private repositories, one active writer each
  .files/
    versions/<version>.json    # ignored-file manifests
    blobs/<content-hash>       # immutable stored bytes
```

Ignored files are discovered through Git's ignore rules, including nested ignored directories. Git/Grapher internals and the configured runtime-data directory are excluded. Source capture and normal A → B inheritance therefore include project-local environments, caches, data and weights even when Git ignores them.

Materialization uses private native clones where supported, otherwise independent byte copies; it never makes writable hard links to source, blobs or siblings. Ordinary fan-out children can modify their copies independently. Content-addressed storage deduplicates snapshot bytes, not every working copy; hashing and materialization still cost I/O proportional to the resource size. This is not a shared writable cache or an arbitrary binary merge facility.

Internal links are rebased to the destination. External directory links are rejected; external file links retain their host target and remain subject to sandbox permissions. Unsupported/non-UTF-8 paths fail explicitly.

## Backend Git storage

Git is the host's snapshot/composition mechanism, not an agent messaging protocol. The backend stages non-ignored changes and creates snapshot commits when needed; agents are not required to commit or exchange commits.

Node repositories normally borrow the source Git object database through `.git/objects/info/alternates` and pin required baseline/parent refs locally. They are not self-contained history copies. Sources with chained alternates or promisor packs use a `file://` fetch fallback; completed snapshots are imported through `file://` fetches for inheritance/publication. See the [object-store confidentiality limit](filesystem-isolation.md#platform-boundaries).

Host pins use `refs/grapher/heads/<sha>`; node results use Run-scoped `refs/grapher/runs/<run>/nodes/<node-id>`. The unscoped `refs/grapher/nodes/<node-id>` namespace remains for legacy/public helper calls. Inside a node, `refs/grapher/base` and `refs/grapher/parents/<parent-id>` pin inputs. Fetches use `--no-write-fetch-head`; human-readable node names map to safe directory/ref identifiers. [Ordinary folders](execution-model.md#ordinary-folders) use external shadow Git metadata.

## Shared inheritance and workspace ownership

Ordinary dependencies and applied feedback inherit the same recorded project state through both filesystem channels. They can both hand off a completed physical repository exclusively; the difference is control flow, not whether files or ignored resources are inherited. Physical directories are reusable Run execution slots, not permanent node identities.

| Transition | Physical workspace behavior | Conversation behavior |
| --- | --- | --- |
| Linear ordinary A → B → C | Normally passes one completed directory between writers; validates inputs and composes newer source state when needed | Each new node starts its own fresh session |
| Ordinary fan-out | One branch may take the parent's directory; other concurrent branches materialize independent state from recorded inputs in separate slots | No parent or sibling history is imported |
| Ordinary fan-in | Combines all recorded parents in an available parent/idle directory, or allocates one if needed; retired extra directories are reclaimed | The child keeps its own session |
| Applied feedback B → A | After verdict, budget/generation checks and drain, transfers B's completion directory to A and invalidates A/ordinary descendants | A continues A's history through an explicit session fork, never B's history |

The runtime assigns at most one active execution to a physical directory; this is scheduling ownership, not a new filesystem sandbox. Safe reuse retains its cwd and project-local environment. Ordinary allocation can reconstruct missing directories or use another slot from recorded snapshots; feedback delivery requires its pinned completion directory and fails closed if it is missing or modified. Snapshots still record and verify inputs/results. Current heads and ignored-file versions advance together for nodes represented by a completed workspace's lineage, while individual execution `before`/`after` records remain historical. Retired paths are not permanent artifact locations. Live writers, queued feedback, and repair inputs retain the directories they require; other retired directories may be reclaimed without discarding Run-owned refs/manifests.

## Composition and recovery

Ignored versions form an ancestry graph. Redundant ancestor inputs are removed; independent inputs are merged against their recorded common base. Independent changes and deletions compose. Different changes to the same ignored path, file/directory collisions or missing/damaged blobs block instead of silently selecting a parent.

Ignored conflicts are validated before destination materialization. An explicitly resolved workspace becomes a new input version descending from source/parents, not a completed task. User recovery steps and the distinct Git Merger path are defined in [Parent composition conflicts](execution-model.md#parent-composition-conflicts).

A normal continuation records current ignored bytes to retain partial work. An explicit history edit restores the selected execution's `before` version. Ignored-only result changes can invalidate descendants even when the Git head is unchanged; shared-terminal continuations and history edits follow the [session/lineage rules](execution-model.md#sessions-follow-ups-and-history-edits).

Publication selects current terminal resource versions, not every execution sharing the same Git head. It validates ignored composition before Git publication and materializes it afterward. Independent current-source ignored changes compose; conflicts fail explicitly before the Git merge. Reconcile conflicting resource outputs in their owner nodes before retry; the Git Merger is not an ignored binary-data conflict resolver. Concurrent direct source writes during publication still have the existing [source-lock limitations](runtime.md#scheduling-and-concurrency).

Run workspace cleanup also removes `.files`; delivered source files and Pi histories remain. Full historical ignored replay is available only while those snapshots are retained. A history edit requiring a missing snapshot fails before branching the conversation; use a fresh follow-up from the current source instead. This is not permanent artifact archival.

## Feedback is an exclusive workspace handoff

For ordinary A → B and feedback B → A:

1. A legal, durably queued request passes the [runtime's budget, generation and drain rules](runtime.md#bounded-feedback). Skipped/rejected feedback never transfers ownership.
2. B's pinned completion head/workspace becomes A's repair input, including B's other completed parent inputs. Before the first repair, the backend validates the head, tracked cleanliness, ancestry of A's reviewed result and ignored-file snapshot. Missing/modified completion state fails closed.
3. A continues **A's own** conversation in B's physical workspace. Applied feedback explicitly forks A's JSONL history into a new Pi session ID even when the path is unchanged, changing only the session header and preserving the source/transcript bytes. Missing/mismatched real history fails execution; B's conversation is never imported.
4. A fixes files in place; descendants inherit its repaired state through the ownership table above. Later continuations follow the [session rules](execution-model.md#sessions-follow-ups-and-history-edits), never rewinding another active writer's workspace.

The forwarded message contains only a source label and the sender's final feedback body, with its final control marker removed. Workspace ownership, session forks and ignored-file inheritance are handled by the runtime; no handoff or environment instructions are appended to Planner/NodeAgent prompts. This does not turn feedback edges into ordinary dependency edges or change DAG cycle detection.

A stored pending request can resume after backend restart. Interrupted writers still require the existing explicit recovery/lease checks; a restart does not bypass ownership or silently resume old processes.

## Environment portability boundary

Inheritance avoids reinstalling project-local packages merely because execution moved to a new node. The regression test builds a real Python venv, adds an installed local module, copies it via this channel and runs the inherited interpreter without reinstalling.

That does **not** make every environment relocatable. Activation scripts, pip/console launchers, embedded absolute paths, native-library lookup and application-generated paths may still refer to an earlier location. Use the current workspace's `.venv/bin/python` or `.venv/Scripts/python.exe` directly and `python -m pip`; prefer project-relative data paths. Existing tool path mapping does not rewrite program internals. Both an ordinary in-place handoff and applied feedback can retain the completed directory's physical path, avoiding another move for its environment. Fan-out copies and reconstructed/reallocated slots can still change cwd; neither route guarantees one fixed path for every execution.

The implementation deliberately does not grant source/sibling write access or use writable junctions as copy-on-write storage. Fixed-path external resource volumes would need a separate explicit permissions/lifecycle design.

## Implementation and tests

- [runtime.rs](../../backend/src/runtime.rs), [model.rs](../../backend/src/model.rs), [store.rs](../../backend/src/store.rs): durable queue, generation guards, drain and ownership.
- [session_branch.rs](../../backend/src/session_branch.rs): header-only session forks and history edits.
- [workspace_files.rs](../../backend/src/workspace_files.rs): ignored snapshots, composition, verification and materialization.
- [runtime_tests.rs](../../backend/src/runtime_tests.rs), [feedback_workspace_tests.rs](../../backend/src/feedback_workspace_tests.rs), [workspace_files_tests.rs](../../backend/src/workspace_files_tests.rs): ordinary chain handoff, fan-out/fan-in allocation and reclamation, shared-terminal follow-ups, feedback handoff, restart, transaction failure, budgets, competing reviews, resource isolation, conflicts, links and environment execution.

These offline/fixture tests are not a real-provider acceptance test or proof of Linux/macOS sandbox behavior on Windows.
