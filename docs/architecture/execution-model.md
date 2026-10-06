# Execution model

This document describes what happens to your project, sessions, and files. [Runtime](runtime.md) covers scheduling; [Filesystem isolation](filesystem-isolation.md) covers permissions and path adaptation.

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
5. The graph is validated and presented for approval. Approval records non-ignored source changes in Git and ignored project files in a separate versioned snapshot channel; node workspaces are then allocated.

**Graph approval is permission to execute the plan, not a promise that no project changes occurred earlier.** Planner commands change the source before approval. Reject, failure, and cancellation do not undo those changes, Git commits, or external command side effects. Existing user changes can also be staged and committed during source snapshots.

Planner can inspect and write ignored files in the source. They do not become Git commits, but approval and approved revisions record them for filesystem inheritance. Runtime/Git internal directories are excluded.

Source locks protect approval and snapshots taken after approved Planner revisions, not the Planner's Bash/model session. During a live revision, already-running nodes drain, while new nodes in that Run wait for its complete source snapshot. Failed/cancelled approved revisions keep the previous graph but record their surviving source writes for future jobs; a snapshot failure pauses the Run instead of scheduling stale inputs. Concurrent Planners still share the source and can overwrite one another's files; there is no private merge protecting those writes. Node model sessions and final Graph publication do not hold a project-wide execution lock.

## Node workspaces and inheritance

```text
<workspace-parent>/.grapher-worktrees/<run>/<node>-<execution>/
```

Graph executions use Run-owned private repositories; these are not `git worktree` checkouts. Physical directories are reusable execution slots, not permanent per-node workspaces. Both ordinary dependencies and applied feedback can hand off a completed directory, with one writer at a time. A directory's allocation name does not identify its current node owner.

1. A root starts from the latest recorded source snapshot: approval, a subsequent approved Planner revision, or successful publication. Approval history remains immutable.
2. A child waits for its ordinary dependencies to finish successfully. The backend combines the latest recorded source with those parents' filesystem states before the task runs. Retained node results likewise receive subsequent Planner source changes through composition; already-running workspaces are not overwritten.
3. The agent performs its task in that workspace with its own session. It does not receive parent conversations or exchange commits with other agents.
4. After execution, the backend snapshots the result for downstream inheritance and final publication.

Both ordinary dependencies and applied feedback inherit **recorded project state**: non-ignored files use Git snapshots; ignored project files use content-addressed blobs and version manifests. A linear A → B → C chain normally passes the same completed physical directory between writers. Fan-out can pass that directory to one branch while other concurrent branches get independently writable state from the recorded inputs; copies are not writable hard links. Fan-in combines all parents in an available parent or idle directory. Safe in-place reuse does not require a new checkout, but missing directories or additional inputs may require reconstruction/composition. The runtime never assigns one physical directory to two active executions; this scheduling rule is not an additional filesystem security boundary.

Feedback uses the same filesystem-state channels and exclusive handoff model, but adds a verdict, budget/generation checks, drain, and target/descendant invalidation. The target receives the sender's completion state plus instruction and continues its own conversation. Completed execution snapshots remain historical records; current heads and ignored-file versions can advance together for nodes represented by the live workspace lineage. Retired directories can be reclaimed and reconstructed from retained snapshots. See [Workspace snapshots and feedback](workspace-snapshots-and-feedback.md).

### Backend Git storage

Git is the host's snapshot/composition mechanism, not an agent messaging protocol. The backend stages non-ignored changes and creates snapshot commits when needed; agents are not required to commit their work or send commits to one another.

Node repositories normally borrow the source Git object database through `.git/objects/info/alternates` and pin the required baseline and parent refs locally. They are not fully self-contained copies of history. Sources with chained alternates or promisor packs use a `file://` fetch fallback instead. The host imports completed snapshots through `file://` fetches for later inheritance and publication.

Host pins use `refs/grapher/heads/<sha>`; node results use Run-scoped `refs/grapher/runs/<run>/nodes/<node-id>`. The unscoped `refs/grapher/nodes/<node-id>` namespace remains for legacy/public helper calls. Inside a node, `refs/grapher/base` and `refs/grapher/parents/<parent-id>` pin its inputs. Fetches use `--no-write-fetch-head`; human-readable node names map to safe directory/ref identifiers.

### Parent composition conflicts

Ignored files use an ancestry-aware three-way merge. Independent changes and deletions compose; competing changes to the same path block before materialization rather than silently picking a parent. For an ignored conflict, create the desired ignored state in the blocked workspace and use **Use resolved workspace**; it is recorded as a versioned input descending from the parents. Git's Merger does not decide cache/data conflicts.

A real Git conflict while combining parents invokes the Merger in the child's workspace before the task starts. The Merger uses that workspace's platform access policy and must finish a clean merge preserving the incoming parent's history. Successful repair resumes composition and task execution; it does not enter final publication or wake the Planner.

If the Merger fails or leaves an unresolved conflict, the affected node is blocked and its workspace/logs are preserved. Resolve and commit the merge there, then use **Use resolved workspace**; the original task still needs an execution. Retrying final publication does not repair a node's preparation conflict.

## Sessions, follow-ups, and history edits

- A new node starts with a fresh Pi session and its own task. It does not inherit Planner or parent-node conversations.
- Follow-ups continue the node's own history. If its result is represented in a unique terminal workspace, the follow-up edits that combined tree, retaining downstream files; successful completion advances current heads and ignored-file versions for the represented nodes without rerunning completed descendants. This remains possible after workspace cleanup by reconstructing the current state, not rewinding to an earlier node's result.
- Applied feedback continues the target's own history in the sender's completed workspace through an explicit Pi session fork. Other continuations fork when cwd changes. A previous writer may reuse the current shared terminal tree when eligible; needing an earlier independent state does not permit rewinding another active writer's directory.
- While a node runs, steering sends a message to its live session without first ending the execution.
- Outside shared-terminal follow-ups, changing a completed node's code or ignored-file result invalidates affected ordinary dependency descendants; unrelated branches stay valid. Applied feedback and explicit history edits still trigger their recorded invalidation/recomputation rules.
- A Graph follow-up without a selected node asks the Planner to revise the graph, including after successful publication.

Editing a historical user turn creates a branch in the node's Pi JSONL session and retains the old branch. Serial branches rewind conversation context, **not project files**. Graph branches resume the selected node from the relevant pre-execution Git and retained ignored-file snapshots; changed results invalidate affected descendants. After workspace cleanup, historical ignored snapshots are no longer retained; edits requiring them fail explicitly rather than pretending to rewind current files. Use a new follow-up from the current source instead. Planner history edits likewise branch the Planner session.

An execution record is not identical to a new model conversation. This distinction matters when inspecting retries and feedback.

## Ordinary folders

A directory without `.git` uses shadow Git metadata under the runtime data directory. Grapher does not create `.git` in that user's folder. Snapshots, node composition, and publication still use Git semantics.

## Final publication

```text
running -> publishing -> completed
               |
               +-> merging -> publishing
               '--> publication_failed
```

`PublicationStarted` is durable before final source changes. The host merges valid terminal heads; already-integrated commits are skipped. Failed or invalidated attempts are not delivered as current results.

Only a real Git conflict invokes a dedicated Merger in the source directory. A missing/inaccessible repository, dirty directory, or permission error is a publication failure, not a request for the model to improvise a workaround.

`retry_publication` reuses the retained heads and current merge state. It does not rerun the graph. Completion requires the heads to be ancestors of the final source HEAD, Git state to be clean, and the composed ignored-file state to be materialized in the source. Ignored conflicts also fail publication explicitly.

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
  shadow_repos/          # Git metadata for ordinary folders
```

Graph workspaces default to the OS cache: `%LOCALAPPDATA%\Grapher\workspaces\.grapher-worktrees` on Windows, `~/Library/Caches/Grapher/workspaces/.grapher-worktrees` on macOS, and `${XDG_CACHE_HOME:-~/.cache}/grapher/workspaces/.grapher-worktrees` on Linux. `GRAPHER_CACHE_DIR` changes the cache root; `GRAPHER_WORKSPACE_PARENT` overrides the node-workspace parent. Cache placement is independent of `GRAPHER_DATA_DIR`. Existing execution paths are retained, not moved. Successful publication/reset cleans owned workspaces but keeps Pi histories for follow-ups; failed Runs retain checkouts for recovery. Conversation deletion/clearing history also cleans owned Node/Planner/Merger histories, attachments and all historical planning attempts, preserving shared resources and source projects. Physical parents are recorded before allocation; legacy cleanup falls back to the saved absolute project's parent when the source is missing. A moved/deleted source therefore does not block cleanup of its exact Run workspace roots. Deletion and its cleanup manifest commit atomically; failed filesystem operations remain queued for startup/periodic retries. Workspace-only retries are event-generation guarded against follow-ups.

All projects/backends with the same verified engine inputs share one content-keyed Pi runtime cache under the OS cache's `workspaces/.grapher-workspaces/` (override with `GRAPHER_NATIVE_RUNTIME_PARENT`). The key covers engine/adapters, Pi source/builds, dependency locks, bundled extensions and platform/Node ABI—not workspace/session paths. An exclusive cache lock serializes preparation; shared process-lifetime file leases protect active readers. Cached engine inputs are rechecked before reuse; damaged idle copies are rebuilt, never overwritten under live readers. Successful caches survive shutdown/restart. Failed preparations, abandoned per-backend copies and unused obsolete versions are reclaimed before preparation; live versions are never removed. Marked copies at the old project-adjacent default are also recovered. Unknown unmarked legacy directories require explicit offline cleanup rather than guessed deletion.

Ignored project dependencies, caches, data and weights are inherited without installing them again. This does not guarantee arbitrary copied environments are relocatable: use the current workspace's `.venv/bin/python` or `.venv/Scripts/python.exe` directly and `python -m pip`; activation scripts, launcher shebangs and program-internal absolute paths are not rewritten. New dependencies are not automatically installed. Shared HOME, temporary files, external services, and global environment state are outside workspace version isolation.

Run-owned ignored manifests/blobs live under `<workspace-parent>/.grapher-worktrees/<run>/.files/` and follow the same durable workspace cleanup ownership. Publication preserves their delivered source files, not the historical ignored snapshots. Pi histories survive workspace cleanup.

Before using important code, read [Filesystem isolation](filesystem-isolation.md). For log maintenance, see [Conversation logs](../testing/conversation-logs.md).
