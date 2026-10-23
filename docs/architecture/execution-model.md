# Execution lifecycle

> **Scope:** Routing, Planner turns, approval, conversation continuity, Merger interaction and publication transitions.
> **Maintained with:** [server.rs](../../backend/src/server.rs), [workspace.rs](../../backend/src/workspace.rs), [graph_merge.rs](../../backend/src/graph_merge.rs) and [publication tests](../../backend/tests/publication.rs).

This page defines lifecycle operations, not their underlying storage algorithms. [Runtime](runtime.md) owns scheduling and recovery; [Workspaces and Git](workspace-snapshots-and-feedback.md) owns file inheritance and composition; [Native environments](native-environments.md) owns environment bindings; [Filesystem isolation](filesystem-isolation.md) owns permissions and path adaptation.

## Serial and Graph

| | Serial | Graph |
| --- | --- | --- |
| Planning | A single `task` node; automatically approved | Planner, compiler, and graph approval |
| Agent directory | The user's project | Private Run repositories with one writer per directory; ordinary dependencies and applied feedback can transfer ownership |
| Dependency inputs | One agent works directly on the project | Children inherit completed parents' workspace state |
| Completion | Task completion and snapshot | Valid results successfully published to the project |

The Partitioner is a tool-free classifier; its `parallel` response maps to the internal `graph` route. Provider failure is an error, not an auto-approved Serial fallback. The route is persisted separately from graph shape: a Planner-generated graph with one node called `task` is still Graph. Older events without a route retain a compatibility heuristic.

## Planning and approval

1. The Partitioner classifies the goal directly in the bound source cwd, with no tools and no separate project checkout. It selects a route unless the user explicitly selects Serial or Graph.
2. For Graph's initial planning, the Planner runs directly in the bound source project directory, not a private copy. Later turns select their cwd afresh as described below.
3. Tools follow the [Pi role-loading policy](../development/pi-integration.md#role-loading-policy). Native Bash has no write-command filter, including when dedicated `write`/`edit` tools are disabled. Writes affect the selected directory immediately, even on failure/cancellation.
4. Planning output, Pi session history and Graph IR are kept in runtime/session data directories, not copied project workspaces. Neither Partitioner nor Planner creates a Git worktree/project copy. There is no separate Planner publication or preview merge. A `planner-workspace` marker records that turn's actual cwd for session/legacy compatibility; it is not a directory allocation.
5. The graph is validated and presented for approval. Approval validates the binding. Standard Git Graphs record a source snapshot; ordinary folders defer it to [first-node shadow materialization](workspace-snapshots-and-feedback.md#shadow-repository-lifecycle). Serial records no approval snapshot. With **Auto Approve** enabled, a Graph is approved and starts executing without a manual click; enabling it while a Graph is already waiting for approval, or while its Planner turn is still running, takes effect immediately.

**Graph approval is permission to execute the plan, not a promise that no project changes occurred earlier.** Planner commands change the source before approval. Reject, failure, and cancellation do not undo those changes, Git commits, or external command side effects. Host source snapshots use a private index and internal commits: they do not stage into the user's index or advance the user's branch. Existing source changes are included in the final files-only delivery.

Snapshot contents and exclusions follow [Git collection](workspace-snapshots-and-feedback.md#git-collection); root materialization follows [physical workspace ownership](workspace-snapshots-and-feedback.md#physical-workspaces-and-ownership).

Source-lock scope and cross-Run races belong to [Runtime concurrency](runtime.md#scheduling-and-concurrency).

### Planner follow-up workspaces

Every Graph Planner follow-up reselects cwd immediately before launch. Selection and the turn block new node dispatches and defer publication for that Run; unrelated active writers continue.

| Run/workspace state | Selection |
| --- | --- |
| No node workspace yet, published, all nodes completed, or awaiting approval | Source project |
| Unfinished node work | Most recently started eligible execution's surviving workspace; the linear frontier is the single-branch case |
| Prior explicit move, with no newer node workspace update | Keep the explicit selection |
| Requested slot inherited downstream | Resolve to its latest recorded execution owner, not its allocation name |
| Missing unpublished prepared workspace | Refuse; do not silently select stale inputs |
| Pinned feedback input directory | Reserved immutable evidence, never a writable Planner slot |

The newest eligible workspace is selected even while its node/Merger writer is active: no wait, older-slot fallback or retreat to source. The writer snapshots the shared directory when it drains; if Planner outlives it, Planner captures the combined tree. Selection neither allocates a Planner checkout nor combines parallel branches.

For approved Graphs with unfinished work, each context-bearing follow-up receives a regenerated transport block naming the selected node and every node's status. A rework explanation is added only while its one-shot marker is pending. A source turn with all nodes completed or a new draft awaiting approval receives only the user's instruction, no workspace/status context or switch tool; it still consumes a pending rework marker without injecting the explanation. Transport context is stored in Pi history but stripped from the browser conversation projection.

A context-bearing follow-up exposes `switch_workspace` and its move instruction only when another valid workspace exists. The tool updates the same Planner session's cwd and returns the actual selected node/workspace in that turn. Downstream-owner redirects are explained in the result. Later follow-ups preserve the move until a newer node workspace update takes precedence.

The same Pi conversation/ID survives cwd changes, reload, and reclamation of the
old workspace; only its validated session-header cwd is rebound, recorded as
the literal cwd the resumed process reports (Pi matches it without realpath
normalization, and that spelling differs by platform). Planner path normalization follows [Graph tool adaptation](filesystem-isolation.md#graph-tool-adaptation).
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
it). Unlike Auto Approve, it is captured in a new Run's configuration. It applies
to Graph Runs, which already have a Planner conversation, not Serial Runs.

After every successful publication, when all nodes are completed, an enabled Run
appends a brief neutral completion notification to its existing Planner session.
The notification is not a user bubble and is omitted from the browser transcript,
including after reload; the shared Planner system prompt is unchanged. The rework
explanation shares the same durable one-shot marker as ordinary follow-ups: a
review appends it only while that marker is pending and consumes the marker.
Later reviews or follow-ups do not repeat it, including after reload or a failed
review.

The review uses the normal Planner tool policy and may inspect, verify, revise the graph, report or make administrative source edits. It does not receive node conversation histories.

Its output streams through durable planning logs and SSE wake-ups. Successful
node/edge edits immediately project a live candidate graph without dispatching
work before the turn finishes.

A completed turn validates and commits its graph and snapshots any Planner source
writes. Existing unaffected results stay completed. If more work is needed, Auto
Approve dispatches it immediately; otherwise the new graph waits for **Approve**,
without rerunning completed nodes. New workspaces use the newly published source
plus any source writes made during review, never the previous approval baseline.
Each later successful execution/publication can trigger another review; a final
reply without further work does not trigger itself again. Auto Approve can therefore produce repeated execution/publication/review cycles and additional model calls.

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

## Parent composition conflicts

A Git conflict during [parent composition](workspace-snapshots-and-feedback.md#composition-and-conflicts) invokes the Merger in the child's workspace before its task starts. Environment differences follow [local reuse/unbound selection](native-environments.md#branches-metadata-and-storage), not the Merger flow.

A node-composition Merger is a first-class conversation while it runs: the execution graph shows its card while it prepares the node, and its live session accepts steering like a node execution. Once the Merger settles, its card becomes read-only history and the node's own execution is the conversation that continues the work. A publication Merger has no planner node; the graph shows it as a `publication merger` card below the terminal layer, receiving the terminal edges. It is steerable while it runs and, unlike a node-composition Merger, keeps accepting follow-ups after it settles: each follow-up is a new Merger execution continuing the same Pi session, and it does not re-enter the publication state machine. A failed publication keeps that conversation in its private repair workspace. After successful publication it returns to source for direct edits, rebinding the existing session cwd without discarding history. Publication status and retry remain the publication panel's concern, not the Merger conversation's.

If a Git Merger fails or leaves an unresolved conflict, the affected node is blocked and its workspace/logs are preserved for inspection; retrying the node re-attempts preparation. Starting any upstream execution returns that node's blocked dependency descendants to `waiting`, so a retried upstream branch re-enters normal scheduling instead of staying blocked. The original task still needs an execution. An environment mismatch alone does not block the node. Retrying final publication does not repair a node's preparation conflict.

## Sessions, follow-ups, and history edits

- A new node starts with a fresh Pi session and its own task. It does not inherit Planner or parent-node conversations.
- Follow-ups continue the node's own history. Sending from a completed node's composer starts a new execution with the appended instruction, not a record-only note or a resend of the original task. Before publication, a follow-up edits the current terminal workspace and produces a new Git snapshot containing all project files; completed descendants remain valid only under the existing shared-workspace invalidation rules. After successful publication, node follow-ups edit the source directory directly without creating another Git snapshot.
- Applied feedback continues the target's own history through an explicit Pi session fork; input composition and sender eligibility follow [feedback handoff](workspace-snapshots-and-feedback.md#feedback-and-history-edits). Other continuations fork when cwd changes. A previous writer may reuse the current shared terminal tree when eligible; needing an earlier independent state does not permit rewinding another active writer's directory.
- While a node runs, steering sends a message to its live session without ending the execution. Merger steering/continuation eligibility follows [Merger lifecycle](#parent-composition-conflicts).
- Accepted node/Merger steering and continuation turns persist their attachment-bearing text and image payloads in Run events, not just optimistic UI state. Their attachment cards/thumbnails survive Run selection and reload. Legacy steering events without image payloads remain readable but cannot reconstruct an image from those events.
- Outside shared-terminal follow-ups, changing a completed node's Git result—including a file that was previously ignored—invalidates affected ordinary dependency descendants. Applied feedback and explicit history edits still trigger their Git/session invalidation rules.
- A Graph follow-up without a selected node asks the Planner to revise the graph, including after successful publication.
- A revision that changes a node which already ran (its task or its inputs) discards that node's previous session entirely: its executions become superseded, its revision increments, and the rework starts a fresh Pi session instead of continuing the old conversation. Nodes whose task and inputs are unchanged, and whose upstream is unaffected, keep their results, revisions, sessions and workspaces.
- Unsent composer text is retained in browser memory for each Run and conversation target (Planner/Serial, node, or Merger). Switching conversations or returning from home restores that target's draft, without sending it or sharing it with another target. An accepted send clears only its originating draft; a rejected send keeps it. Draft text is not Pi history or persisted browser storage: reload/closing the page clears it, and unsent file attachments are not retained.

Editing a historical user turn creates a branch in the node's Pi JSONL session and retains the old branch. Serial branches rewind conversation context, **not project files**. Graph branches keep the existing Git rollback behavior; all project files are restored through Git history, and no `before-*` file snapshots are required. Changed Git results invalidate affected descendants. Planner history edits likewise branch the Planner session.

An execution record is not identical to a new model conversation. This distinction matters when inspecting retries and feedback.

## Final publication

```text
running -> publishing -> completed
               |
               +-> merging -> publishing
               '--> publication_failed
```

`PublicationStarted` is durable before final source changes. Publication selects valid terminal heads; already-integrated commits are skipped. Failed or invalidated attempts are not delivered as current results. The publication merge algorithm belongs to [Git publication](workspace-snapshots-and-feedback.md#publication).

Only a real Git conflict invokes a dedicated Merger in the private publication workspace. A missing/inaccessible repository or permission error is a publication failure, not a request for the model to improvise a workaround. Node preparation never inspects the live source working tree; source changes are incorporated at publication.

`retry_publication` reuses retained Git heads, private merge state and durable delivery evidence without rerunning the graph. Internal composition must preserve input ancestry, but delivery never creates a commit or advances the user's branch/index. Recovery and concurrent-source handling follow [Git publication](workspace-snapshots-and-feedback.md#publication). Only `PublicationCompleted` establishes Graph completion.

After an earlier successful publication or Planner revision, new and revised nodes build on the latest recorded source snapshot rather than overlaying a stale approval baseline.
