# Execution model

This document describes what happens to your project, sessions, and files. [Runtime](runtime.md) covers scheduling; [Filesystem isolation](filesystem-isolation.md) covers permissions and path adaptation.

## Serial and Graph

| | Serial | Graph |
| --- | --- | --- |
| Suitable work | One task or tightly coupled linear work | Independent workstreams with explicit dependencies |
| Planning | A single `task` node; automatically approved | Planner, compiler, and graph approval |
| Agent directory | The user's project | An independent Git repository per node |
| Collaboration | One agent works directly on the project | Git commits propagate through dependencies |
| Completion | Task completion and snapshot | Valid results successfully published to the project |

The route is persisted separately from the graph's shape. A Planner-generated graph with one node called `task` is still Graph. Older events without a route retain a compatibility heuristic.

## Planning and approval

1. The Partitioner selects a route, unless the user explicitly selects Serial or Graph.
2. For Graph, the backend copies the project into a private Planner repository under `<project-parent>/.grapher-workspaces/<owner>/<planning-id>/`.
3. The Planner uses `node`, `edge`, `read`, and native `bash`. It can change files in that copy; it is not a read-only inspector.
4. After a successful planning session, the host snapshots and merges Planner changes into the source. A preview merge detects ordinary conflicts; failure retains the private workspace.
5. The graph is validated and presented for approval. Approval snapshots the source's current non-ignored changes as the execution baseline; node workspaces are then allocated.

**Graph approval is permission to execute the plan, not a promise that no project changes occurred earlier.** Successful planning can merge changes before approval. Reject does not undo those changes, Git commits, or external command side effects. Existing user changes can also be staged and committed during source snapshots.

The Planner copy includes project files needed for inspection, including ignored dependencies where supported, but excludes Git internals and Grapher runtime data. That is distinct from node baseline propagation: ignored, untracked dependencies do not automatically become node Git snapshots.

Short source locks protect Planner copy/merge and approval operations. Model sessions and final Graph publication do not hold a project-wide execution lock; concurrent Runs can still conflict.

## Node workspaces and Git propagation

```text
<project-parent>/.grapher-worktrees/<run>/<node>-<execution>/
```

These are **independent Git repositories**, not `git worktree` checkouts. Each has private Git metadata and the history needed for its task.

1. The approved source baseline is exposed through Grapher-owned refs.
2. The node fetches the baseline and completed dependency refs via `file://`.
3. Multiple parent commits are merged before the task runs.
4. Completed file changes are committed in the node repository.
5. The host fetches the result into its own refs for downstream use and publication.

Transfer uses advertised refs such as `refs/grapher/base`, `refs/grapher/nodes/<node>`, and `refs/grapher/heads/<sha>`, not an assumption that arbitrary unadvertised SHAs are fetchable. Fetches use `--no-write-fetch-head` to avoid parallel writes to `FETCH_HEAD`. Human-readable node names map to safe directory/ref identifiers.

A parent composition conflict blocks the affected node. Resolve and commit the preserved workspace, then use **Use resolved workspace**; the original task still needs an execution. The final-publication Merger is not a general resolver for preparation conflicts.

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

After an earlier successful publication, new and revised nodes build on the currently published HEAD rather than overlaying a stale approval baseline.

## Storage and cleanup

Runtime data defaults to `.grapher/`, configurable with `GRAPHER_DATA_DIR`:

```text
.grapher/
  events.sqlite          # Events, execution-log chunks, and metadata
  runtime.lock           # One backend writer per data directory
  planning/              # Planning attempts and JSONL output
  sessions/              # Node Pi sessions
  mergers/               # Publication Merger sessions/output
  shadow_repos/          # Git metadata for ordinary folders
```

Graph workspaces and Planner copies live beside the project, not inside this data tree. Successful final publication attempts to clean that Run's workspaces; failed Runs retain their checkouts for inspection. Explicit reset/deletion also cleans owned Run directories. Session history and the shared prepared Pi runtime have separate lifecycles; do not assume deleting a workspace removes all history or secrets.

Project dependencies are not automatically installed for node tasks. Shared HOME, temporary files, external services, and global environment state are outside Git version isolation.

Before using important code, read [Filesystem isolation](filesystem-isolation.md). For log maintenance, see [Conversation logs](../testing/conversation-logs.md).
