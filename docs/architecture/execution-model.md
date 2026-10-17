# Execution model

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
2. For Graph's initial planning, the Planner runs directly in the bound source project directory, not a private copy. Later turns select their cwd afresh as described below.
3. The Planner uses `node`, `edge`, `read`, and native `bash`. `write` and `edit` are mounted only when the persistent `plannerWriteTools` setting is enabled (off by default). When mounted, writes are not filtered, and files appear in the selected directory immediately, even if planning fails or is cancelled. Bash remains available in either mode.
4. Planning output, Pi session history and Graph IR are kept in runtime/session data directories, not copied project workspaces. Neither Partitioner nor Planner creates a Git worktree/project copy. There is no separate Planner publication or preview merge. A `planner-workspace` marker records that turn's actual cwd for session/legacy compatibility; it is not a directory allocation.
5. The graph is validated and presented for approval. Approval validates the binding. A Graph on a standard Git repository records a Git source snapshot; an ordinary folder records no snapshot until its first node is dispatched, when Grapher lazily materializes a temporary shadow snapshot with forced collection of project files. Serial keeps source-native behavior and records no approval snapshot. Managed environment scopes and Runtime data remain outside project Git.

**Graph approval is permission to execute the plan, not a promise that no project changes occurred earlier.** Planner commands change the source before approval. Reject, failure, and cancellation do not undo those changes, Git commits, or external command side effects. Existing user changes can also be staged and committed during source snapshots.

Planner can inspect and write any files in the source. Git snapshots force-collect project files regardless of `.gitignore`; managed environment scopes and Runtime/Git internal directories are excluded. New root slots use the recorded Git commit, with the physical copier reserved for files outside that commit or managed workspace preparation.

Source locks protect approval and source snapshots, not a source-native Planner's Bash/model session. Concurrent source-native Planners can overwrite one another's files; there is no private merge protecting those writes. Node model sessions and final Graph publication do not hold a project-wide execution lock.

### Planner follow-up workspaces

Every Graph Planner follow-up selects its working directory again immediately
before launch; it does not blindly reuse a stale directory. During selection and
the turn, the Run dispatches no new nodes and defers publication. While node
work is unfinished, the newest recorded workspace is mandatory: Planner starts
in it immediately even when its node/Merger writer is still active, rather than
waiting, skipping to an older slot, or retreating to source. A follow-up therefore never freezes behind a
long-running frontier. The shared writer owns the later Git snapshot, so Planner
writes in that directory are captured when the writer drains; if Planner outlives
the writer, Planner captures the combined directory itself. Unrelated parallel
writers can continue.

On a linear graph, Planner uses the current execution frontier's workspace. For
parallel branches, any current branch is sufficient: Runtime deterministically
chooses the most recently started eligible execution's surviving workspace. It
uses recorded execution ownership, not the directory's allocation name, and
resolves redirected requests to the latest downstream owner instead of
re-entering a stale node workspace. Missing unpublished prepared workspaces
remain refused. Feedback input directories remain reserved immutable evidence,
not writable Planner slots. Before any node workspace exists, after successful
publication, and when every node is completed or the Graph awaits approval,
Planner uses the source project. This does not allocate another Planner
checkout or merge all parallel branches into one view.

The first user follow-up on an existing approved Graph that still has
unfinished node work receives a transport context block containing the current
workspace's node name and every node's status. The rework explanation is
injected only while its one-shot marker is pending on a context-bearing
follow-up, while the workspace name and node-status list are regenerated for
every context-bearing follow-up. When
every node is already completed, or the Graph is still a new draft awaiting
approval, Planner runs in the source project, receives only the user's
instruction with no workspace/status context, and is not offered the
workspace-move instruction or `switch_workspace` tool. Such a turn still
consumes the one-shot rework marker if it is pending, but the explanation is
not injected without the transport context. The workspace-move instruction is included only
when another valid workspace is currently available; a linear frontier with no
alternate workspace does not receive it. The transport context is recorded in Pi's session but removed from
the browser conversation projection. On a context-bearing follow-up the Planner
can request a move with the follow-up-only `switch_workspace` tool. The tool returns the actual selected node and workspace state in the
same turn. If its physical slot has already been inherited and modified by a
downstream node, Runtime resolves the request to that downstream execution
instead of binding the old node to a stale path, and the tool result explains
the redirect. Runtime records the new `PlanningSummary.worktree` and
`workspaceExecutionId`; the same Planner session and its `read`/Bash (plus
`write`/`edit` when mounted) operations then use the selected workspace. If no node workspace has been updated since that
explicit move, later follow-ups keep it; a newer node workspace takes
precedence.

The same Pi conversation/ID survives cwd changes, reload, and reclamation of the
old workspace; only its validated session-header cwd is rebound, recorded as
the literal cwd the resumed process reports (Pi matches it without realpath
normalization, and that spelling differs by platform). Planner uses
the same stable model-facing path namespace as Node Agent: existing prompt cwd,
read/bash/write/edit results and conversation context are normalized, while recognized
project-root paths resolve to the current physical workspace. The transport
context is regenerated for each context-bearing follow-up; only the rework
explanation is one-shot. The browser removes the transport context from the displayed
conversation.
`PlanningSummary.worktree` and
`workspaceExecutionId`, plus durable `planner_workspace_selected` events, record
the selection. **Planning session details** displays the actual workspace and
per-turn workspace history, including failed turns.

Planner Bash/write/edit writes affect the selected directory immediately. Writes in a node
worktree are Git-snapshotted/imported back into that execution's result before
scheduling resumes; they are not copied into the source prematurely. Children
inherit the updated result through normal graph dependencies. Source-native
writes keep their source-snapshot behavior. Failed/cancelled turns retain the
previous graph but capture surviving writes too. Interrupted private turns are
captured during recovery; a snapshot/recovery failure pauses the Run rather than
scheduling stale inputs. Node conversations are never imported into Planner.

Focused evidence: [Planner workspace regressions](../../backend/src/planner_workspace_tests.rs)
and the Planner details browser case in [conversation UI tests](../../scripts/conversation-history-ui.test.mjs).

### Post-task Planner review

**Post-task Planner review** is an independent Settings toggle directly below
Auto Approve, enabled by default (including saved configurations that predate
it). Like Auto Approve, it is captured in a new Run's configuration. It applies
to Graph Runs, which already have a Planner conversation, not Serial Runs.

After every successful publication, when all nodes are completed, an enabled Run
appends a brief neutral completion notification to its existing Planner session.
The notification is not a user bubble and is omitted from the browser transcript,
including after reload; the shared Planner system prompt is unchanged.

Grapher imposes no artificial restrictions on what the Planner decides to do
next:
- **Audit & verify**: inspect the published source and verify acceptance criteria;
- **Plan further work**: define new task nodes and edges for subsequent iterations;
- **Report & wait**: summarize completed work to the user and await further guidance;
- **Wrap up**: perform final administrative edits or conclude cleanly.

Crucially, this turn strictly obeys the fundamental system invariant: **no messages
or conversations are passed between nodes**. Execution instances receive completed
workspace state through Git, not other agents' conversation logs.

Its output streams through durable planning logs and SSE wake-ups. Successful
node/edge edits immediately project a live candidate graph without dispatching
work before the turn finishes.

A completed turn validates and commits its graph and snapshots any Planner source
writes. Existing unaffected results stay completed. If more work is needed, Auto
Approve dispatches it immediately; otherwise the new graph waits for **Approve**,
without rerunning completed nodes. New workspaces use the newly published source
plus any source writes made during review, never the previous approval baseline.
Each later successful execution/publication can trigger another review; a final
reply without further work does not trigger itself again. When combined with Auto
Approve, this establishes a robust, autonomous **loop engineering** cycle that
continues iteratively until the Planner concludes. This can incur extra model
calls, and users can disable it at any time in Settings.

Failed publication or failed/blocked execution does not trigger review. A failed
or stopped review retains its logs and source writes but discards its uncommitted
candidate. Restart never silently repeats an interrupted model turn; it records
failure and preserves the committed graph, requiring approval if committed work
remains. Every Planner turn on an existing Run that ends without committing a
graph — a failed or stopped review, an interrupted follow-up revision included —
is recorded once as a `planner_turn_aborted` history event, so the conversation
replay keeps its durable output without touching the graph, phase or approval
state. Publication completion remains distinct from review success.

Focused evidence: [runtime review regressions](../../backend/src/planner_review_tests.rs).

## Node workspaces and inheritance

```text
<workspace-parent>/.grapher-worktrees/<run>/<node>-<execution>/
```

Graph executions use Run-owned private repositories, not `git worktree` checkouts. A directory is a reusable node/Merger single-writer execution slot; its allocation name does not identify its current node owner. A Planner follow-up may share the latest slot with its active writer under the [follow-up workspace rule](#planner-follow-up-workspaces).

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

Git is the host's snapshot/composition mechanism, not an agent messaging protocol. Object borrowing, fetch fallbacks and ref namespaces are documented in [Workspace Git storage](workspace-snapshots-and-feedback.md#backend-git-storage).

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

If a Git Merger fails or leaves an unresolved conflict, the affected node is blocked and its workspace/logs are preserved for inspection; retrying the node re-attempts preparation. Starting any upstream execution returns that node's blocked dependency descendants to `waiting`, so a retried upstream branch re-enters normal scheduling instead of staying blocked. The original task still needs an execution. An environment mismatch alone does not block the node. Retrying final publication does not repair a node's preparation conflict.

## Sessions, follow-ups, and history edits

- A new node starts with a fresh Pi session and its own task. It does not inherit Planner or parent-node conversations.
- Follow-ups continue the node's own history. Sending from a completed node's composer starts a new execution with the appended instruction, not a record-only note or a resend of the original task. Before publication, a follow-up edits the current terminal workspace and produces a new Git snapshot containing all project files; completed descendants remain valid only under the existing shared-workspace invalidation rules. After successful publication, node follow-ups edit the source directory directly without creating another Git snapshot.
- Applied feedback continues the target's own history through an explicit Pi session fork. A single sender hands off its completed workspace; concurrent applicable senders' project results are Git-composed in a separate target workspace before repair. Only `<FEEDBACK>` senders contribute to that composition, not parallel `<ACCEPT>` nodes. Other continuations fork when cwd changes. A previous writer may reuse the current shared terminal tree when eligible; needing an earlier independent state does not permit rewinding another active writer's directory.
- While a node runs, steering sends a message to its live session without first ending the execution. A running Merger (node-composition or publication) is steerable the same way; a settled node-composition card becomes read-only, while a settled publication merger accepts appended follow-ups.
- Accepted node/Merger steering and continuation turns persist their attachment-bearing text and image payloads in Run events, not just optimistic UI state. Their attachment cards/thumbnails survive Run selection and reload. Legacy steering events without image payloads remain readable but cannot reconstruct an image from those events.
- Outside shared-terminal follow-ups, changing a completed node's Git result—including a file that was previously ignored—invalidates affected ordinary dependency descendants. Applied feedback and explicit history edits still trigger their Git/session invalidation rules.
- A Graph follow-up without a selected node asks the Planner to revise the graph, including after successful publication.
- A revision that changes a node which already ran (its task or its inputs) discards that node's previous session entirely: its executions become superseded, its revision increments, and the rework starts a fresh Pi session instead of continuing the old conversation. Nodes whose task and inputs are unchanged, and whose upstream is unaffected, keep their results, revisions, sessions and workspaces.
- Unsent composer text is retained in browser memory for each Run and conversation target (Planner/Serial, node, or Merger). Switching conversations or returning from home restores that target's draft, without sending it or sharing it with another target. An accepted send clears only its originating draft; a rejected send keeps it. Draft text is not Pi history or persisted browser storage: reload/closing the page clears it, and unsent file attachments are not retained.

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
  planner-sessions/      # Planner history for Runs without a prior planning attempt
  partition-workers/     # Legacy Partitioner sessions retained for cleanup/recovery
  mergers/               # Merger sessions/output (including composition attempts)
  environments/          # Managed native-environment snapshots and launch records
  shadow_repos/          # Temporary Git metadata for ordinary folders (lazy, reclaimed after publication)
```

Graph workspaces default to the OS cache: `%LOCALAPPDATA%\Grapher\workspaces\.grapher-worktrees` on Windows, `~/Library/Caches/Grapher/workspaces/.grapher-worktrees` on macOS, and `${XDG_CACHE_HOME:-~/.cache}/grapher/workspaces/.grapher-worktrees` on Linux. `GRAPHER_CACHE_DIR` changes the cache root; `GRAPHER_WORKSPACE_PARENT` overrides the node-workspace parent. Cache placement is independent of `GRAPHER_DATA_DIR`. Existing execution paths are retained, not moved. Successful publication/reset cleans owned workspaces but keeps Pi histories for follow-ups; Git history keeps project files recoverable after a workspace is reclaimed. Conversation deletion/clearing history also cleans owned Node/Planner/Merger histories, attachments and all historical planning attempts, preserving shared resources and source projects.

Removing a workspace in the UI deletes all of its conversations through the backend's `delete_workspace` command, including conversations absent from that browser's index. Repository bindings are matched exactly or by verified path aliases, not by path prefix. The backend rejects active conversations (including planning, publication and managed result execution), validates every cleanup manifest, and deletes events, checkpoints and execution logs together with durable cleanup ownership in one transaction. Filesystem cleanup failures remain queued for retry; small deletion tombstones remain to reject stale writers. The browser removes its workspace/conversation indexes only after this commit and does not recreate an explicitly empty workspace list from a stale default repository. Source project files and shared engine caches are never workspace-removal targets.

All projects/backends with the same engine inputs share one content-keyed Pi runtime cache under the OS cache's `workspaces/.grapher-workspaces/` (override with `GRAPHER_NATIVE_RUNTIME_PARENT`). The key covers engine/adapters, Pi source/builds, dependency locks, bundled extensions and platform/Node ABI—not workspace/session paths. An exclusive cache lock serializes preparation; shared process-lifetime file leases protect active readers. Cached engine inputs are rechecked before reuse; damaged idle copies are rebuilt, never overwritten under live readers. Successful caches survive shutdown/restart. Failed preparations, abandoned per-backend copies and unused obsolete versions are reclaimed before preparation; live versions are never removed. Marked copies at the old project-adjacent default are also recovered. Unknown unmarked legacy directories require explicit offline cleanup rather than guessed deletion.

Managed environment snapshots do not install missing dependencies or guarantee environment relocation; see the [managed environment boundary](workspace-snapshots-and-feedback.md#managed-environment-boundary). [Shared external state](filesystem-isolation.md#shared-runtime-and-external-state) is outside workspace version isolation.

Before using important code, read [Filesystem isolation](filesystem-isolation.md). For log maintenance, see [Conversation logs](../testing/conversation-logs.md).
