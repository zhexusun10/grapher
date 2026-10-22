# Proposal: every agent workspace matches the source

> **Status:** implementation in progress; full cross-platform acceptance remains open.
> **The target is fixed; the implementation is open.** Source-bound project/Git
> views and external state are implemented for the supported native path; explicit
> capability refusals are not acceptance success. Only the new workspace contract
> is supported; legacy data compatibility/migration is out of scope. Existing
> data is not deleted or migrated.
> Durable behavior is maintained in
> [Filesystem isolation](../architecture/filesystem-isolation.md),
> [Workspaces & Git](../architecture/workspace-snapshots-and-feedback.md) and
> [Native environments](../architecture/native-environments.md).

## 1. Non-negotiable goal

**Every agent must see the source project's workspace, not a Grapher-shaped
approximation of it.** Implementation cost, platform differences, legacy data and
runtime convenience cannot weaken that requirement.

This applies to Planner, Serial agents, every Graph node and Merger, including
follow-ups and post-task review. The Partitioner has no filesystem tools, but its
project context must not introduce a different workspace convention. Source-native
roles already use the source directory; they must not inject runtime files into
it. Private roles must receive an equivalent project view.

### 1.1 What “matches” means

For each execution, bind a consistent source baseline and its authorized task
inputs before preparing the workspace. At the first tool call:

```text
visible project = bound source baseline + recorded task changes (inherited or retained)
```

During execution, only actual task activity may change that project view. Retry,
continuation and handoff use their recorded current inputs, not a fresh copy of
an independently changing live source. Different branches may contain different
task results; they may not contain different Grapher pollution.

Equality is recursive, not just a top-level entry count or clean `git status`:

1. Preserve all project entries and file bytes, including dotfiles, empty
   directories, ignored/untracked files and native configuration such as `.env`.
   Preserve entry types, link semantics and source project metadata, including
   executable/read-only flags, ACLs, xattrs and Windows ADS where present. A copy
   backend that cannot preserve these properties must report the incompatibility,
   not omit or silently transform the entry.
2. Add no Grapher-owned project entry at any depth: HOME, caches, temporary
   files, managed environments, receipts, hooks, graph state and bookkeeping all
   live outside the project view. Ignore rules, hidden attributes, symlinks to
   external state and filtered tool output do not make an extra entry acceptable.
3. Preserve the source's Git view: discoverable `.git` when the source has it,
   current branch or detached/unborn HEAD, project history, user refs, and the
   staged/unstaged/untracked/ignored distinctions of the bound baseline. Task
   changes then appear normally. No Grapher snapshot commits, synthetic working
   branch or graph refs may enter that view.
4. Do not remove genuine project entries merely because their names resemble
   runtime paths. Source-owned `.agent-home`, `.grapher*`, `.venv` or
   `.environments` remain project entries; ownership must be established by
   provenance, not a filename blacklist.
5. The same view must be observable through file tools, native Bash, direct
   filesystem APIs, Git, extensions and subprocesses. Prompt instructions or
   output normalization are not substitutes for the underlying filesystem.

“Matches” describes repository-relative project contents and Git behavior, not
shared inode identity or byte-identical Git storage/lock files. Physical roots
may differ; that does not permit differences inside the project view. A source
`.git` file must resolve to the private repository's metadata, never back to the
source's writable metadata. An ordinary folder without `.git` must not gain a
visible `.git` just because Grapher needs internal snapshots.

### 1.2 No partial success

All requirements hold together for every role and lifecycle transition on
Windows, macOS and Linux. A missing capability must produce a specific preparation
failure before exposing a nonconforming workspace. It is a compatibility gap,
not acceptance success. Never silently skip source files, fall back to in-tree
state, execute against the live source instead of a private workspace, or drop a
platform from the target.

## 2. Problem inventory

Observed in a real run (`run 219780ea…`, node `extract_module_b`, merger
`95014a73`); sizes below are observations, not newly measured acceptance evidence.

| Artifact | Current origin / behavior | Required change |
| --- | --- | --- |
| `.agent-home/` | `environment_automatic.rs` redirects HOME/USERPROFILE into the workspace; observed npm cache was ~598 MB | External process state; no staging coupling |
| `.runtime-cache/` | `environment.rs` eagerly creates cache paths during prepare | External cache paths; no project entry, even empty |
| Git view | `workspace.rs::hide_private_git` hides `.git`; internal repo uses `grapher-node`, graph refs and snapshot commits | Source-equivalent visible Git, separate internal graph Git |
| `.venv/`, `.environments/` | Automatic scopes and discovery can place managed environments in the workspace | Grapher-provisioned environments outside the project |
| Agent scratch, e.g. `.navigation-check/` | Agent-created business output, not runtime injection | Remains a task change; staging policy is separate |
| `.env` | Native project file, observed byte-identical to the source | Preserve unchanged; do not treat it as runtime pollution |

The `.agent-home` staging bug in `finish_merge(repository, &incoming, &[])`
was fixed (`02637b8`, `806ae4a`). Exclusions still do not solve physical pollution.
The current hidden-Git and forced-snapshot contracts also mean that merely
exposing the existing internal repository would not meet §1.

## 3. Required architecture, flexible layout

### 3.1 Separate project, process state and control state

The separation is mandatory; these particular paths are illustrative:

```text
<owned-runtime-root>/<run>/<slot>/
├── process/                       # {state}, outside the project tree
│   ├── home/
│   ├── cache/
│   ├── tmp/
│   ├── venv/
│   └── envs/
└── control/                       # backend bookkeeping, not process HOME
    └── graph/<name>.git

<workspaces-parent>/.grapher-worktrees/<run>/<slot>/
└── (the source project view, including source-equivalent Git)
```

An external state root, an outer slot containing sibling `project/` and `state/`
directories, or a platform-specific mechanism may implement this. The agent's
cwd and project-root tools must select the project, never the outer managed
container. No layout is accepted merely because it is easier to implement.

Allocate roots using backend-persisted physical-slot ownership and writer
generation. A slot may pass from A to B; identity must follow the allocator, not
assume one permanent directory per node. Record bindings before launch, preserve
them across retries/recovery, and allocate independent writable state for forks.
Frontend state is not an ownership registry.

The project, process state and control state must not overlap by canonical path,
symlink/junction alias or an in-project mount. A cache-root location is acceptable
only with the ownership, retention and recovery guarantees required for live
state; disposable cache semantics must not silently reset an environment.

### 3.2 Full project preservation

Materialize the complete bound project, not just `git ls-files`, `git archive`,
or paths that pass current runtime-name exclusions. Source-owned ignored files,
empty directories, nested repositories and submodules need explicit preservation
and private Git bindings. Unsupported links, metadata or nested layouts are
preparation failures, not reasons to produce an incomplete tree. Checkout filters,
line-ending conversion and link rebasing must not silently change source file
bytes or project behavior.

For a dirty source, an internal snapshot may record all inputs, but it must not
turn the visible workspace into a clean checkout of a synthetic snapshot commit.
The source's initial Git status remains meaningful. Composition applies actual
recorded task deltas on that baseline without exposing capture bookkeeping.

Detect source mutation while binding/copying and retry or fail rather than
mixing different baselines. Keep project-file bytes in the existing Git channel.
Bind reconstruction evidence for empty directories, source metadata and visible
index state to the same backend-owned input/generation: Git trees alone do not
preserve all of these. Such evidence supplements reconstruction, not an
independently editable project-file authority or frontend source of truth.

### 3.3 External environment and temporary paths

Introduce an explicit process-state binding (`{state}` or an equivalent typed
root), separate from `{workspace}`:

| Resource / variable | Required destination |
| --- | --- |
| `HOME`, `USERPROFILE` | External `home/` |
| XDG directories; Windows `APPDATA`, `LOCALAPPDATA` | Appropriate external home/cache paths |
| `TMPDIR`, `TMP`, `TEMP`, `XDG_RUNTIME_DIR` | External execution-owned temporary paths |
| npm and other Grapher-configured caches | External `cache/` subpaths |
| Grapher-provisioned `VIRTUAL_ENV`, PATH entries | External verified environment prefix |
| Grapher-provisioned Conda env/package directories | External `envs/` and cache paths |
| Git discovery | Native project `.git`, without a hidden-repo environment override |

Audit every launcher, launch binding, hook, discovery adapter, prewarmed host and
child-process boundary. No Grapher-selected state variable may point inside the
project or alias back into it. `{workspace}` remains valid for real project paths.
Keep Runtime's existing `PYTHONDONTWRITEBYTECODE=1` policy; externalization is not
a reason to re-enable project bytecode writes.

Create external leaves only when required. Removing eager in-tree cache creation
is necessary; avoiding empty *external* directories is an optimization, not the
definition of cleanliness.

Source/agent-created environments stay business files. Do not move, delete or
adopt them solely by name. Grapher may not inject `./.venv`, including a symlink,
to accommodate a script that expects it. If a task explicitly creates that path,
it is a task change; if managed launch requires it, choose a conforming mechanism
or report incompatibility instead of relaxing the target.

### 3.4 Environment capture, inheritance and ownership

`Files::environment`, capture/materialize, discovery ownership checks, launch
validation and token expansion must distinguish project roots from process-state
roots. Managed HOME/environment scopes are process-state-relative; rebuilding
caches are excluded from immutable environment snapshots by policy.

- Validate scopes under the bound process-state root, with traversal, overlap and
  redirected-child checks. Exclude backend control/Git state from those scopes.
- Replace workspace-relative tracked-file assumptions with explicit root-aware
  validation. Do not simply disable safety checks because state moved outside Git.
- Preserve retry, linear handoff, fork, fan-in, feedback and result-launch
  behavior. Do not introduce shared writable HOME/environment trees between
  concurrent branches.
- External paths do not make Python/Conda environments relocatable. Reuse at a
  proven fixed path, or use a verified rebuild/relocation mechanism. Never
  silently copy embedded absolute prefixes and claim successful inheritance.
- Environment staging exclusions may shrink only after every capture,
  composition, Merger and publication path is externalized and old-contract
  slots are refused rather than reinterpreted. Genuine project files must not be
  lost through stale name filters.

### 3.5 Source-equivalent Git, independent graph Git

The visible repository is a real project repository, not a wrapper around the
internal graph repository:

- Preserve the source's **current** branch, not its default branch. Preserve
  detached/unborn HEAD, source history, user branches/tags/refs and initial index
  semantics. Do not force `master`, `main` or `grapher-node`.
- Preserve effective project Git behavior from configuration, ignore/attributes
  files and filters, including relevant global settings otherwise lost when HOME
  moves. Any private config/path rebinding must preserve behavior and avoid source
  writes; do not silently lose ignore rules, commit identity or EOL settings.
- Keep explicit agent commits as ordinary project history. Source capture,
  completion snapshots, feedback pins and publication bridges remain in backend
  graph history; they must not become visible ancestors, refs or reflogs.
- Inherited file changes and genuine task merges may be presented as ordinary
  project work. Internal snapshot/composition commits cannot be relabeled as
  “normal project history” to bypass the target.
- `git log --all`, `git branch -a`, `git show-ref`, `git reflog` and direct Git
  discovery must expose no Grapher-added bookkeeping. A same-named ref already
  present in the source remains a user ref; compare provenance, not substrings.
- Do not modify source Git config, HEAD, refs, index or object database during
  private preparation/execution. Bind copied worktree/submodule gitfiles and
  local configuration to the private view without opening a source-write path.

The backend composes and pins results in external graph Git, materializes project
trees/index state separately, and imports actual agent commits/results when
collecting work. The visible HEAD must never be set to an internal snapshot just
to simplify handoff. This separation is the largest implementation workstream,
not a cosmetic rename or removal of `hide_private_git`.

Object sharing is optional. Explicit project-commit/object transfer is a valid
portable baseline. A visible repository must not borrow a mixed graph-object
store: even without refs, Git object inspection could expose internal snapshots.
Alternates require a project-only store, narrow read-only access and retention
leases. Never share writable indexes/refs or rely on a removable object store.
Moving refs alone does not remove bookkeeping from ancestry or object discovery.

Preserve [files-only publication](../architecture/workspace-snapshots-and-feedback.md#publication):
internal results deliver file changes, not internal commits, to the source.
The user's branch, HEAD, real index and object database retain their existing
publication guarantees. Visible workspace Git is not permission to change that
contract.

### 3.6 Lifecycle and reclaim

Record process/control roots as narrowly validated owned cleanup targets, either
through a dedicated target or the enclosing managed slot. Use durable cleanup
manifests and interrupted-task recovery; never rediscover ownership by directory
name alone.

Reclaim only after writer drain and all workspace, feedback, retry, publication
recovery, result-launch and object-store dependencies release the roots. Successful
publication does **not** automatically authorize deletion of environments or Git
objects still required by a retained result. Conversation deletion and recovery
must respect shared dependencies and other runs' ownership.

### 3.7 Task-created files

Actual agent/task output is the only permitted addition to the bound project.
A runtime adapter must not attribute its own files to the agent merely because
the write occurred during a tool call. Classify by responsibility: Grapher-chosen
HOME, caches, receipts and provisioned environments are runtime state; an explicit
business command's build output or requested `./.venv` is task activity.

Whether to collect agent scratch into a result is a separate Git policy. Neither
excluding scratch nor changing `.gitignore` demonstrates workspace equality.

## 4. Cross-platform compatibility

Use the same observable contract on native Windows, macOS and Linux. The default
layout must not require a VM, WSL, container, administrator privileges, symbolic
links or a filesystem-specific clone feature. Platform-specific optimizations
remain optional and must pass the same acceptance gates.

| Platform | Required implementation and evidence |
| --- | --- |
| Windows | Native Node, Git for Windows Bash and Win32 tools resolve the same project/state bindings. Exercise drive, UNC, extended-length and case aliases; spaces, non-ASCII names, path-length limits, readonly files, junctions/reparse points and locked-file recovery. Do not depend on Unix symlink privileges or same-volume rename. |
| macOS | Seatbelt permits the project and required process-state paths while preserving source/sibling denials and backend-control protection. Exercise case-sensitive and case-insensitive filesystems, symlinks and source metadata. |
| Linux | bubblewrap exposes the project and required process-state paths without mounting the whole cache/run parent. Preserve source/sibling/control masking and namespace preflight. Exercise permissions, links and cross-filesystem byte-copy fallback. |

Canonicalize identities and validate descendants with platform-aware utilities,
not string-prefix checks or unconditional lowercasing. Detect case/normalization
collisions, unsupported entries and insufficient path/copy capabilities before
launch. Portable independent copies are a valid fallback for unsupported cloning;
flattening links, dropping files/metadata or sharing writable hardlinks is not.
Cross-volume migration requires verified copy-and-switch, not an assumed atomic
rename across filesystems.

### 4.1 Do not confuse layout with an access boundary

On macOS/Linux, allow only the required process-state and visible Git paths, not
all of `<cache_root>`, the run parent or sibling state. Keep backend control state
out of agent write allowances; object-store reads, if used, need narrow read-only
access. Test denials as well as successful HOME/cache/environment access.

Windows currently has **no per-node filesystem sandbox**. Moving state outside
the workspace prevents project-tree pollution; it does not make state, siblings,
source files or credentials inaccessible to a host-user process. Job Objects are
process-lifecycle controls, not filesystem isolation. This proposal must neither
claim a Windows security boundary nor weaken the common workspace-equality goal.

What each platform can actually see, for one slot:

| Platform | own process state (HOME/cache) | source / sibling slots / control Git |
| --- | --- | --- |
| Windows | reachable | reachable (no boundary) |
| macOS | reachable | denied (Seatbelt) |
| Linux | reachable | denied (bubblewrap mask) |

The agent's own HOME is necessarily reachable on every platform — tools write
there and `$HOME` is readable. "Clean" means **not inside the project tree**, not
"invisible to the agent". A visibility claim that contradicts this table is not
evidence of equality.

### 4.2 Paths and model-visible adaptation

A private root may differ from the source root. Keep project-root-relative tool
semantics and recognized source-path adaptation consistent across all roles and
workspace switches; the selected project root is never the managed container.
Do not rewrite project file bytes to hide relocation, or filter directory/Git
output to simulate equality. `cd` and `..` retain native semantics.

`engine/workspace-paths.mjs` adapts recognized tool inputs/results; it cannot
remap arbitrary scripts or programs assembling absolute paths at runtime. Native
filesystem/Git probes are therefore mandatory acceptance evidence. If a project
requires source-address identity, provide and verify a suitable path mechanism
or report that capability gap; do not grant source writes or call text adaptation
transparent remapping. Different physical paths cannot excuse project-view drift.

## 5. Migration and compatibility

Legacy workspace compatibility is explicitly **out of scope**: the production
launch gate accepts only the current workspace contract. Older slots are not
relocated, rewritten or exposed to an agent; start a new Run instead. This is not
authorization to modify live runs, stop services, delete workspace data or
migrate SQLite—the old data is retained untouched.

- Version the environment/layout contract and policy fingerprint. Persist
  project/process/control bindings and their ownership for recovery; old records
  must not be silently reinterpreted under new root semantics.
- A legacy or unrecognized workspace must fail preparation before exposure, with
  a recoverable diagnostic. “Leave the old directories in place”, mixed
  contract views, hidden-Git fallbacks and in-tree runtime state are not
  compatible options.
- Distinguish runtime-owned paths from source/task-owned same-named paths using
  recorded ownership/evidence. Unknown provenance is not permission to delete,
  unstage, overwrite or force-checkout project work.
- New graph refs/commits remain separate from visible project history. Preserve
  explicit agent commits, partial task work, environment evidence and pinned
  feedback/publication recovery inputs in the new contract.
- Coordinate policy, launch binding, discovery, snapshot, layout/path mapping and
  cleanup changes. A new launcher must not consume a partially prepared slot.
- Perform switching only at a drained writer-generation boundary, with durable
  recovery evidence and rollback. Fixed-path environment reuse requires proof
  of continued usability; retain the old state until dependencies release it.

## 6. Acceptance criteria (all required)

Acceptance compares the complete bound baseline plus recorded task deltas, not
an arbitrary later live source. Checks must distinguish project-owned entries
from runtime state and verify real files, not normalized model output.

1. Recursive entry/type/byte/metadata comparison matches §1, including dotfiles,
   ignored/untracked files, empty directories and nested Git layouts. No
   runtime-created entry exists anywhere inside the project tree.
2. Genuine source `.env`, `.agent-home`, `.runtime-cache`, `.grapher*`, `.venv`
   and `.environments` fixtures survive unchanged. All Grapher-owned process and
   control state resolves outside the project, with no in-tree link or placeholder.
3. Source-equivalent Git works from native Bash, direct Git and file tools. HEAD,
   branch/detached/unborn state, refs/history and initial status/index distinctions
   match; subsequent differences are actual task work. An ordinary folder remains
   without visible Git. No Grapher-added bookkeeping ref, commit, reflog, object
   or index entry leaks through visible Git, including alternates/object inspection.
4. All Grapher-selected HOME/cache/temp/environment paths resolve outside the
   project, including aliases and descendant processes. A no-op agent and a
   runtime-only HOME/cache/temp/environment probe leave the project view intact.
5. Environment capture/materialization and retry/fork/handoff/fan-in retain
   required non-cache state, exclude configured caches, and never capture control
   Git. Independent branches share no mutable runtime tree.
6. Planner, Serial, Graph nodes, Mergers, review, continuation, workspace switching,
   recovery and result preparation all satisfy the same checks. No legacy or
   conflict-repair exception exposes a polluted workspace.
7. Private work does not mutate the source. Files-only publication still leaves
   source HEAD, branch, index and object database unchanged while delivering the
   intended project changes, with no runtime state copied back.
8. Cleanup releases only proven unreferenced ownership, preserves retained result
   and recovery dependencies, and recovers after interruption/locked-file failure.
9. Native macOS/Linux access allows required process state and denies source,
   siblings and backend control writes. Windows evidence makes no sandbox claim.
10. All supported native platforms pass the common equality checks and their
    platform-specific cases. An unsupported case is reported as a compatibility
    gap, never counted as passing via a skip, fixture engine or weaker fallback.

## 7. Targeted verification plan

Follow [Testing](../development/testing.md); run only the specific checks relevant
to the implementation being changed. This proposal itself requires link/diff
review, not launching services or executing the implementation plan.

- **Project equality fixtures:** compare recursive entries/bytes/types/metadata,
  including dirty/ignored source files, empty directories, runtime-like project
  names, links, nested Git/submodules and incompatible-copy failure cases.
  `backend/src/workspace_cleanliness_tests.rs` holds the slot-level oracle
  (source-tree equality, source-equivalent Git, external process state, reclaim).
- **Environment fixtures:** external-root validation/token expansion, lazy
  creation, cache exclusions, native variable precedence and process-state
  capture/materialize; retry/fork/chain inheritance and fixed-prefix reuse.
  Extend the relevant `environment_*` Rust tests and `environment-launch.test.mjs`,
  `environment-native.test.ts` / `environment-chain.test.ts` cases.
- **Git/lifecycle fixtures:** `workspace_tests.rs`, feedback tests and targeted
  Merger/publication targets for non-default branches, detached/unborn HEAD,
  staged/unstaged source changes, effective Git configuration, explicit agent
  commits, internal-history/object separation, conflicts, slot handoff and
  cleanup recovery.
- **Tool/native probes:** `workspace-paths.test.mjs`, `workspace-tools.test.ts`,
  targeted native/prewarm tests and each platform's native launcher checks. Check
  the same view through Node filesystem APIs, Bash and Git, not tool text alone.
- **Platform boundaries:** targeted Seatbelt/bubblewrap tests with precise state
  grants and denial assertions; native Windows alias, copy, lock and path cases.
  Native acceptance on each OS is required; configured CI is not proof of a pass.
- **End-to-end:** update `scripts/accept-files-only-publication.mjs` to expect
  source-equivalent visible Git instead of hidden history, retaining its source
  HEAD/index/object-database and publication-recovery assertions. Add equality
  probes before the first agent tool and after lifecycle transitions.

## 8. Implementation workstreams (all required)

1. **Define the equality oracle and capability matrix** across every role,
   source type, platform and lifecycle transition; separate project/task/runtime
   provenance before removing any exclusions.
2. **Choose and persist root bindings** for project, process and control state;
   wire allocation, cwd/session/tool roots, slot handoff and durable ownership.
3. **Preserve the full project baseline** and initial Git semantics, including
   non-Git files/metadata and nested layouts; add pre-launch compatibility checks.
4. **Externalize runtime state** in all launchers, bindings, hooks, discovery,
   environment snapshots and temporary/cache paths, without changing task files.
5. **Separate visible Git from graph Git**, including dirty source capture,
   ancestry/index presentation, explicit agent commits, composition, feedback,
   Merger and files-only publication.
6. **Implement platform paths and permissions** without broadening Unix grants or
   inventing a Windows isolation guarantee; retain portable copy fallbacks.
7. **Wire lifecycle and reclaim** with fixed-prefix environment evidence, writer
   drain, retained dependencies and crash recovery. Legacy slots are reported as
   unsupported (create a new Run); they are not migrated in place.
8. **Pass the common and native platform acceptance gates** before calling any
   layout complete. Workstreams may land incrementally; a partial rollout is not
   completion of the goal.

## 9. Open implementation choices, not open target requirements

| Choice | Constraint on the answer |
| --- | --- |
| External state versus nested slot | Both must expose only the complete project at cwd and through every tool; update allocator/path/cleanup assumptions as needed |
| Slot key and root location | Stable persisted ownership across retry/handoff, independent writable forks, recoverable lifetime |
| Git transfer versus alternates | No internal history/objects exposed through visible Git, no source writes, correct object-store leases |
| Environment fixed-path reuse versus rebuild | Verified usability; no in-tree managed fallback or unproven relocation |
| Cache reuse/retention | May trade disk or download cost, never project equality or required environment evidence |
| Legacy records | Out of scope: fail launch and create a new Run; never expose a mixed/polluted workspace or migrate in place |
| Unsupported platform/filesystem features | Implement an equivalent mechanism or explicitly block the unsupported case; never silently weaken acceptance |

## 10. Alternatives and selection rule

| Approach | Can meet the full target by itself? | Reason / required companion work |
| --- | --- | --- |
| `.gitignore`, `.git/info/exclude`, hidden files or output filtering | No | Hides symptoms; physical/API view still differs |
| Mark npm/HOME directories as caches | No | Reduces snapshot size, not workspace pollution or Git divergence |
| External HOME and lazy caches only | No | Leaves other state, project-copy gaps and internal Git semantics unresolved |
| External process/control roots plus independent project Git | Candidate | Must also preserve full project inputs, all roles/lifecycles and platform guarantees |
| Outer managed slot with sibling project/state roots | Candidate | Requires explicit managed-root versus project-root bindings throughout allocation, tools, Git, sessions and cleanup |
| Platform namespace/mount or another mechanism | Candidate | Must establish equivalent behavior on every supported native platform; no single-platform shortcut |

Choose by correctness, cross-platform evidence and then implementation/operational
cost. External state is a plausible starting point, not a mandated solution. A
nested layout is not rejected because its refactor touches more invariants; if it
best satisfies the target, make those changes. No candidate is accepted until all
criteria in §6 hold.
