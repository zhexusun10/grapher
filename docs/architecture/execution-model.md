# Execution model

This document describes what happens to your project, sessions, and files. [Runtime](runtime.md) covers scheduling; [Filesystem isolation](filesystem-isolation.md) covers permissions and path adaptation.

## Serial and Graph

| | Serial | Graph |
| --- | --- | --- |
| Suitable work | One task or tightly coupled linear work | Independent workstreams with explicit dependencies |
| Planning | A single `task` node; automatically approved | Planner, compiler, and graph approval |
| Agent directory | The user's project | An independent Git repository per node |
| Dependency inputs | One agent works directly on the project | Children inherit completed parents' workspace state |
| Completion | Task completion and snapshot | Valid results successfully published to the project |

The route is persisted separately from the graph's shape. A Planner-generated graph with one node called `task` is still Graph. Older events without a route retain a compatibility heuristic.

## Planning and approval

1. The Partitioner classifies the goal directly in the bound source cwd, with no tools and no separate project checkout. It selects a route unless the user explicitly selects Serial or Graph.
2. For Graph, the Planner runs directly in the bound source project directory, not a private copy.
3. The Planner uses `node`, `edge`, `read`, and native `bash`. Bash writes are not filtered, and files appear in the source immediately, even if planning fails or is cancelled.
4. Planning output, Pi session history and Graph IR are kept in runtime/session data directories, not copied project workspaces. Neither Partitioner nor Planner creates a Git worktree/project copy. There is no separate Planner publication or preview merge. A `planner-workspace` marker records the source path for session/legacy compatibility; it is not a directory allocation.
5. The graph is validated and presented for approval. Approval snapshots the source's current non-ignored changes as the execution baseline; node workspaces are then allocated.

**Graph approval is permission to execute the plan, not a promise that no project changes occurred earlier.** Planner commands change the source before approval. Reject, failure, and cancellation do not undo those changes, Git commits, or external command side effects. Existing user changes can also be staged and committed during source snapshots.

Planner can inspect and write ignored files in the source, but ignored, untracked dependencies do not automatically become node Git snapshots.

Source locks protect approval and snapshots taken after approved Planner revisions, not the Planner's Bash/model session. During a live revision, already-running nodes drain, while new nodes in that Run wait for its complete source snapshot. Failed/cancelled approved revisions keep the previous graph but record their surviving source writes for future jobs; a snapshot failure pauses the Run instead of scheduling stale inputs. Concurrent Planners still share the source and can overwrite one another's files; there is no private merge protecting those writes. Node model sessions and final Graph publication do not hold a project-wide execution lock.

## Node workspaces and inheritance

```text
<project-parent>/.grapher-worktrees/<run>/<node>-<execution>/
```

Each node has its own working directory and private Git metadata; these are not `git worktree` checkouts.

1. A root starts from the latest recorded source snapshot: approval, a subsequent approved Planner revision, or successful publication. Approval history remains immutable.
2. A child waits for its ordinary dependencies to finish successfully. The backend combines the latest recorded source with those parents' filesystem states before the task runs. Retained node results likewise receive subsequent Planner source changes through composition; already-running workspaces are not overwritten.
3. The agent performs its task in that workspace with its own session. It does not receive parent conversations or exchange commits with other agents.
4. After execution, the backend snapshots the result for downstream inheritance and final publication.

Inheritance uses **recorded workspace state**, not live access to a parent's directory. Ignored, untracked files are not included automatically. Feedback edges carry an additional instruction, not a workspace input.

### Backend Git storage

Git is the host's snapshot/composition mechanism, not an agent messaging protocol. The backend stages non-ignored changes and creates snapshot commits when needed; agents are not required to commit their work or send commits to one another.

Node repositories normally borrow the source Git object database through `.git/objects/info/alternates` and pin the required baseline and parent refs locally. They are not fully self-contained copies of history. Sources with chained alternates or promisor packs use a `file://` fetch fallback instead. The host imports completed snapshots through `file://` fetches for later inheritance and publication.

Host pins use `refs/grapher/heads/<sha>`; node results use Run-scoped `refs/grapher/runs/<run>/nodes/<node-id>`. The unscoped `refs/grapher/nodes/<node-id>` namespace remains for legacy/public helper calls. Inside a node, `refs/grapher/base` and `refs/grapher/parents/<parent-id>` pin its inputs. Fetches use `--no-write-fetch-head`; human-readable node names map to safe directory/ref identifiers.

### Parent composition conflicts

A real Git conflict while combining parents invokes the Merger in the child's workspace before the task starts. The Merger uses that workspace's platform access policy and must finish a clean merge preserving the incoming parent's history. Successful repair resumes composition and task execution; it does not enter final publication or wake the Planner.

If the Merger fails or leaves an unresolved conflict, the affected node is blocked and its workspace/logs are preserved. Resolve and commit the merge there, then use **Use resolved workspace**; the original task still needs an execution. Retrying final publication does not repair a node's preparation conflict.

## Sessions, follow-ups, and history edits

- A new node starts with a fresh Pi session and its own task. It does not inherit Planner or parent-node conversations.
- Feedback and follow-up messages continue the node's existing session and workspace.
- While a node runs, steering sends a message to its live session without first ending the execution.
- When a completed node's result changes, affected ordinary dependency descendants are recomputed; unrelated branches stay valid.
- A Graph follow-up without a selected node asks the Planner to revise the graph, including after successful publication.

Editing a historical user turn creates a branch in the node's Pi JSONL session and retains the old branch. Serial branches rewind conversation context, **not project files**. Graph branches resume the selected node from the relevant pre-execution workspace snapshot; changed results invalidate affected descendants. Planner history edits likewise branch the Planner session.

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

`retry_publication` reuses the retained heads and current merge state. It does not rerun the graph. Completion requires the heads to be ancestors of the final source HEAD and the directory to be clean.

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

Graph workspaces live beside the project. Successful publication/reset cleans owned workspaces but keeps Pi histories for follow-ups; failed Runs retain checkouts for recovery. Conversation deletion/clearing history also cleans owned Node/Planner/Merger histories, attachments and all historical planning attempts, preserving shared resources and source projects. Physical parents are recorded before allocation; legacy cleanup falls back to the saved absolute project's parent when the source is missing. A moved/deleted source therefore does not block cleanup of its exact Run workspace roots. Deletion and its cleanup manifest commit atomically; failed filesystem operations remain queued for startup/periodic retries. Workspace-only retries are event-generation guarded against follow-ups.

Backend-created Pi runtime copies hold process-lifetime file leases. Failed preparations and graceful shutdown remove the copy after its process trees stop. Unused marked copies are reclaimed before the next preparation, including crash leftovers. Unknown legacy directories with lost ownership are retained rather than guessed away.

Project dependencies are not automatically installed for node tasks. Shared HOME, temporary files, external services, and global environment state are outside Git version isolation.

Before using important code, read [Filesystem isolation](filesystem-isolation.md). For log maintenance, see [Conversation logs](../testing/conversation-logs.md).
