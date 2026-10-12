# Execution model

> **Status:** active
> **Scope:** User-visible planning, file/session inheritance, recovery and publication.
> **Maintained with:** [server.rs](../../backend/src/server.rs), [workspace.rs](../../backend/src/workspace.rs), [graph_merge.rs](../../backend/src/graph_merge.rs) and [publication tests](../../backend/tests/publication.rs).

This document describes what happens to your project, sessions, and files. [Runtime](runtime.md) covers scheduling; [Filesystem isolation](filesystem-isolation.md) covers permissions and path adaptation.

Backend-admitted [Native workspace environments](native-environments.md) add E/L
evidence to the current workspace execution. The workspace is handed off or
replaced as Runtime schedules nodes; environment inheritance is best-effort and
never a parent compatibility gate. Projects needing no environment stay unbound;
ordinary parallel allocation remains available. Managed scopes/caches are excluded
from source publication; Graph publishes a launchable descriptor. Serial and
shadow projects retain their native contract.

## Serial and Graph

| | Serial | Graph |
| --- | --- | --- |
| Suitable work | One task or tightly coupled linear work | Independent workstreams with explicit dependencies |
| Planning | A single `task` node; automatically approved | Planner, compiler, and graph approval |
| Agent directory | The user's project | Private Run repositories with one writer per directory; ordinary dependencies and applied feedback can transfer ownership |
| Dependency inputs | One agent works directly on the project | Children inherit completed parents' workspace state |
| Completion | Task completion and snapshot | Valid results successfully published to the project |

The route is persisted separately from the graph's shape. A Planner-generated graph with one node called `task` is still Graph. Older events without a route retain a compatibility heuristic.

## Planning and approval

1. The Partitioner classifies the goal directly in the bound source cwd, with no tools and no separate project checkout. It selects a route unless the user explicitly selects Serial or Graph.
2. For Graph, the Planner runs directly in the bound source project directory, not a private copy.
3. The Planner uses `node`, `edge`, `read`, and native `bash`. Bash writes are not filtered, and files appear in the source immediately, even if planning fails or is cancelled.
4. Planning output, Pi session history and Graph IR are kept in runtime/session data directories, not copied project workspaces. Neither Partitioner nor Planner creates a Git worktree/project copy. There is no separate Planner publication or preview merge. A `planner-workspace` marker records the source path for session/legacy compatibility; it is not a directory allocation.
5. The graph is validated and presented for approval. Approval validates the binding and records a Git source snapshot for a standard Git repository; an ordinary folder records no snapshot until its first node is dispatched, when Grapher lazily materializes a temporary shadow snapshot with forced collection of project files. Managed environment scopes and Runtime data remain outside project Git.

**Graph approval is permission to execute the plan, not a promise that no project changes occurred earlier.** Planner commands change the source before approval. Reject, failure, and cancellation do not undo those changes, Git commits, or external command side effects. Existing user changes can also be staged and committed during source snapshots.

Planner can inspect and write any files in the source. Git snapshots force-collect project files regardless of `.gitignore`; managed environment scopes and Runtime/Git internal directories are excluded. New root slots use the recorded Git commit, with the physical copier reserved for files outside that commit or managed workspace preparation.

Source locks protect approval and snapshots taken after approved Planner revisions, not the Planner's Bash/model session. During a live revision, already-running nodes drain, while new nodes in that Run wait for its complete source snapshot. Failed/cancelled approved revisions keep the previous graph but record their surviving source writes for future jobs; a snapshot failure pauses the Run instead of scheduling stale inputs. Concurrent Planners still share the source and can overwrite one another's files; there is no private merge protecting those writes. Node model sessions and final Graph publication do not hold a project-wide execution lock.

## Node workspaces and inheritance

```text
<workspace-parent>/.grapher-worktrees/<run>/<node>-<execution>/
```

Graph executions use Run-owned private repositories, not `git worktree` checkouts. A directory is a reusable single-writer execution slot; its allocation name does not identify its current node owner.

1. Runtime selects the current workspace state from the latest recorded source
   snapshot and completed dependency results. A completed workspace is handed off
   when ownership permits; otherwise a new slot is materialized from the current
   code snapshot.
2. A child waits for ordinary dependencies and Git-composes their project state.
   Environment reuse is attempted at the selected current slot only; failure to
   reuse means an unbound execution, not a blocked dependency. Parent environment
   directories are never copied or merged.
3. The agent performs its task in that workspace with its own session. It does not receive parent conversations or exchange commits with other agents.
4. After execution, the backend snapshots the result for downstream inheritance and final publication.

Inheritance is Git history plus physical working-tree ownership. Ordinary dependencies and applied feedback can exclusively hand off completed directories; fan-out branches use independent Git working trees. All project outputs are committed before downstream composition and publication; managed environment scopes remain a separate environment contract. See [Workspace directories and Git publication](workspace-snapshots-and-feedback.md). Feedback control flow is defined in [Runtime](runtime.md#bounded-feedback).

### Backend Git storage

Git is the host's snapshot/composition mechanism, not an agent messaging protocol. Object borrowing, fetch fallbacks and ref namespaces are documented once in [Workspace Git storage](workspace-snapshots-and-feedback.md#backend-git-storage). This heading remains for existing links.

### Parent composition conflicts

All project files participate in Git composition. A Git conflict while combining parents invokes the Merger in the child's workspace before the task starts. This includes `.gitignore` and paths that `.gitignore` would normally hide from a user `git add`. The selected physical directory supplies the working tree; the committed Git result supplies the project history.

Runtime also carries non-owning ambient hints from a completed Node to the
next Node. A hint is rendered inside the managed process environment as
`previous agent used: <manager> <selector> (<executable>)`; it is advisory text,
not a Runtime activation or authorization. At fan-in, Runtime unions and
sorts/deduplicates all parent hints; it never chooses one and never blocks on
conflicting hints. The downstream Node may ignore, verify, activate or replace
the hinted environment through Bash.


A node-composition Merger is a first-class conversation while it runs: the execution graph shows its card while it prepares the node, and its live session accepts steering like a node execution. Once the Merger settles, its card becomes read-only history and the node's own execution is the conversation that continues the work. A publication Merger has no planner node; the graph shows it as a `publication merger` card below the terminal layer, receiving the terminal edges. It is steerable while it runs and, unlike a node-composition Merger, keeps accepting follow-ups after it settles: each follow-up is a new Merger execution continuing the same Pi session in the source directory, and it does not re-enter the publication state machine. Publication status and retry remain the publication panel's concern, not the Merger conversation's.

If a Git Merger fails or leaves an unresolved conflict, the affected node is blocked and its workspace/logs are preserved. Resolve and commit the merge there, then use **Use resolved workspace**; the original task still needs an execution. An environment mismatch alone does not block the node. Retrying final publication does not repair a node's preparation conflict.

## Sessions, follow-ups, and history edits

- A new node starts with a fresh Pi session and its own task. It does not inherit Planner or parent-node conversations.
- Follow-ups continue the node's own history. A follow-up edits the current terminal workspace and produces a new Git snapshot containing all project files; completed descendants remain valid only under the existing shared-workspace invalidation rules.
- Applied feedback continues the target's own history in the sender's completed workspace through an explicit Pi session fork. Other continuations fork when cwd changes. A previous writer may reuse the current shared terminal tree when eligible; needing an earlier independent state does not permit rewinding another active writer's directory.
- While a node runs, steering sends a message to its live session without first ending the execution. A running Merger (node-composition or publication) is steerable the same way; a settled node-composition card becomes read-only, while a settled publication merger accepts appended follow-ups.
- Accepted node/Merger steering and continuation turns persist their attachment-bearing text and image payloads in Run events, not just optimistic UI state. Their attachment cards/thumbnails survive Run selection and reload. Legacy steering events without image payloads remain readable but cannot reconstruct an image from those events.
- Outside shared-terminal follow-ups, changing a completed node's Git result—including a file that was previously ignored—invalidates affected ordinary dependency descendants. Applied feedback and explicit history edits still trigger their Git/session invalidation rules.
- A Graph follow-up without a selected node asks the Planner to revise the graph, including after successful publication.

Editing a historical user turn creates a branch in the node's Pi JSONL session and retains the old branch. Serial branches rewind conversation context, **not project files**. Graph branches keep the existing Git rollback behavior; all project files are restored through Git history, and no `before-*` file snapshots are required. Changed Git results invalidate affected descendants. Planner history edits likewise branch the Planner session.

An execution record is not identical to a new model conversation. This distinction matters when inspecting retries and feedback.

## Ordinary folders

A directory without `.git` uses temporary shadow Git metadata under the runtime data directory. Grapher does not create `.git` in that user's folder. The snapshot is created lazily by the first dispatched node worker and fully reclaimed after a successful publication (or Run deletion / offline GC); it is not a cross-conversation history. A directory without a materialized snapshot reports an empty `HEAD`, and `""` means "no Git snapshot". After publication, completed-node conversations edit the source directory directly. Snapshots, node composition, and publication still use Git semantics.

## Final publication

```text
running -> publishing -> completed
               |
               +-> merging -> publishing
               '--> publication_failed
```

`PublicationStarted` is durable before final source changes. The host merges valid terminal heads; already-integrated commits are skipped. Failed or invalidated attempts are not delivered as current results.

Only a real Git conflict invokes a dedicated Merger in the source directory. A missing/inaccessible repository or permission error is a publication failure, not a request for the model to improvise a workaround. The user's source directory is authoritative: node preparation never inspects the live working tree, and publication commits pending user edits as its base before node results merge on top, so user work neither blocks handoff nor gets discarded. A real Git conflict between user work and node results is resolved by the Merger.

`retry_publication` reuses the retained Git heads and current merge state. It does not rerun the graph. Completion requires the heads to be ancestors of the final source HEAD and Git state to be clean. Publication applies additions, modifications, and deletions for all project files, including files previously matched by `.gitignore`.

After an earlier successful publication or Planner revision, new and revised nodes build on the latest recorded source snapshot rather than overlaying a stale approval baseline.

## Storage and cleanup

Runtime data defaults to `.grapher/`, configurable with `GRAPHER_DATA_DIR`:

```text
.grapher/
  events.sqlite          # Events, log chunks, ownership and durable cleanup tasks
  runtime.lock           # One backend writer per data directory
  planning/              # Planning attempts and JSONL output
  sessions/              # Node Pi sessions
  planner-sessions/      # Planner history for manually created Runs
  partition-workers/     # Temporary idle Partitioner sessions
  mergers/               # Merger sessions/output (including composition attempts)
  shadow_repos/          # Temporary Git metadata for ordinary folders (lazy, reclaimed after publication)
```

Graph workspaces default to the OS cache: `%LOCALAPPDATA%\Grapher\workspaces\.grapher-worktrees` on Windows, `~/Library/Caches/Grapher/workspaces/.grapher-worktrees` on macOS, and `${XDG_CACHE_HOME:-~/.cache}/grapher/workspaces/.grapher-worktrees` on Linux. `GRAPHER_CACHE_DIR` changes the cache root; `GRAPHER_WORKSPACE_PARENT` overrides the node-workspace parent. Cache placement is independent of `GRAPHER_DATA_DIR`. Existing execution paths are retained, not moved. Successful publication/reset cleans owned workspaces but keeps Pi histories for follow-ups; Git history keeps project files recoverable after a workspace is reclaimed. Conversation deletion/clearing history also cleans owned Node/Planner/Merger histories, attachments and all historical planning attempts, preserving shared resources and source projects.

All projects/backends with the same verified engine inputs share one content-keyed Pi runtime cache under the OS cache's `workspaces/.grapher-workspaces/` (override with `GRAPHER_NATIVE_RUNTIME_PARENT`). The key covers engine/adapters, Pi source/builds, dependency locks, bundled extensions and platform/Node ABI—not workspace/session paths. An exclusive cache lock serializes preparation; shared process-lifetime file leases protect active readers. Cached engine inputs are rechecked before reuse; damaged idle copies are rebuilt, never overwritten under live readers. Successful caches survive shutdown/restart. Failed preparations, abandoned per-backend copies and unused obsolete versions are reclaimed before preparation; live versions are never removed. Marked copies at the old project-adjacent default are also recovered. Unknown unmarked legacy directories require explicit offline cleanup rather than guessed deletion.

Managed environment snapshots do not install missing dependencies or guarantee environment relocation; see the [managed environment boundary](workspace-snapshots-and-feedback.md#managed-environment-boundary). [Shared external state](filesystem-isolation.md#shared-runtime-and-external-state) is outside workspace version isolation.

Before using important code, read [Filesystem isolation](filesystem-isolation.md). For log maintenance, see [Conversation logs](../testing/conversation-logs.md).
