# Runtime and persistence

> **Status:** active
> **Scope:** Scheduling, durable events, feedback and interruption recovery.
> **Maintained with:** [runtime.rs](../../backend/src/runtime.rs), [model.rs](../../backend/src/model.rs), [store.rs](../../backend/src/store.rs) and [runtime tests](../../backend/src/runtime_tests.rs).

The Rust backend owns Run state. SQLite stores append-only business events; a reducer produces the current Snapshot. React displays that projection and submits commands—it does not simulate execution or invent authoritative status.

[Native workspace environments](native-environments.md) use durable backend
admission for the current workspace, without frontend environment choices. They
fix code/E/L/resources for each execution and advance current workspace aliases
atomically with completion/feedback. Model-free result execution reserves a
generation, releases the Run mutex for native work, then guards the commit;
success requests republishing, not UI-invented completion. Environment mismatch
falls back to unbound execution; damaged or missing required evidence still fails.
Named business entries can retain independent terminal environments.

## Graph representation

```ts
interface Graph {
  originalGoal: string;
  nodes: Array<{ name: string; task: string }>;
  edges: Array<{
    from: string;
    to: string;
    feedback: boolean;
  }>;
}
```

Names are semantic identifiers, not literal directory names. Edges contain only `from`, `to`, and `feedback` and are unique by ordered `(from, to)` pair. The backend ignores the removed `relation` field when reading historical graphs, events, or checkpoints, and never serializes it back. The compiler checks nonempty/unique nodes, valid endpoints, no self-edges, graph limits, and an acyclic ordinary dependency graph. A feedback source has at most one target, and that target must be its dependency ancestor.

The compiler returns `executionBatches`, `roots`, `terminals`, and warnings. Batches describe topology; scheduling does not wait for every slow node in a batch before dispatching a ready descendant.

During foreground planning, the graph pane opens on a `node`/`edge` tool call.
Successful tool results update the unapproved draft preview before the Planner's
text stream ends. Cards appear centered as soon as they are measured; edge edits
animate the layout while the viewport follows its center. Draft edits invalidate
old displayed execution batches, and durable polling must not restore them over
the live preview. This visualization does not approve, dispatch, or complete any
work; approved revisions still commit atomically in Rust. Browser regressions:
[Planner streaming and auto-fit](../../scripts/graph-planning-fit.test.mjs).

## Node states

```text
waiting -> running -> completed
             |           |
             v           v
           failed      dirty -> running

waiting / dirty -> blocked
blocked -> waiting            (an upstream node runs again)
```

- `waiting`: task has not run or is waiting for dependencies.
- `running`: an execution is in progress.
- `completed`: current task result is valid.
- `dirty`: a change invalidated the current result.
- `failed`: the execution or protocol failed.
- `paused`: the backend's browser projection identifies an explicitly stopped or
  recoverably interrupted execution; it is not a provider/protocol failure.
- `blocked`: dependencies failed or workspace composition could not proceed. Starting an upstream execution returns the node to `waiting` so the new result is composed again.

Node and execution completion both use `completed` in API projections. Historical
checkpoints with the legacy node status `done` are normalized to `completed` on
read without rewriting stored events or transcripts. The browser also normalizes
legacy node statuses at the HTTP/SSE snapshot boundary, so a newly loaded UI can
still display completion correctly while an older backend is running. This is
only a spelling conversion; it never changes Run phase or publication evidence.

Nodes remain stable across recorded execution attempts. Historical output and backend-recorded Git snapshots remain inspectable even when a later revision supersedes their result; ordinary files remain tied to their physical directory.

## Scheduling and concurrency

Only ready nodes dispatch, subject to the **per-Graph-Run** limit. `maxParallel=0` defaults to 8; positive values can lower that limit, with a hard maximum of 8.

There is no global pool limiting nodes across Runs, and no shared cap for Planner/Serial sessions. Choose concurrency with provider quotas and machine resources in mind. Creating or switching conversations does not stop background Runs.

Failure blocks dependent branches; unrelated work continues. The topology's
Pause control stops new dispatches **and interrupts active node process trees**
for that Run, without stopping its Planner or another Run. The browser shows
`pausing` until those writers drain and disables Continue during that interval.
Continue requeues the interrupted nodes using their own Pi sessions and retained
workspaces. If an initial preparation was paused before Pi launched and no
conversation exists, Continue dispatches the initial task instead of attempting
to resume a nonexistent session; the unstarted attempt remains in history.
A node conversation's Stop interrupts only that node; global
Stop/cancel also cancels planning. Internal scheduling-only pauses used to drain
an affected branch for a Planner revision still let active calls finish.

`ExecutionStopRequested` records the affected execution IDs before termination,
including workers still preparing or not yet registered as native processes.
That intent wins a concurrent successful worker return and prevents publication
or feedback from the stopped attempt. Windows termination's exit code 1 alone
is **not** evidence of a user pause. The persisted failure/recovery schema stays
compatible: stopped attempts retain terminal `Failed` evidence, while API node
and execution projections expose `paused` for known interruptions. Checkpoints
retain the attempt-scoped stop requests; Continue does not silently retry an
unrelated ordinary failure.

Saving changed Node Agent model/thinking settings from a conversation records
per-node overrides for every node that has never had an execution, including
unapproved drafts and nodes waiting for dependencies or blocked before their first
attempt. Their first dispatch uses those settings. Saving does not dispatch work,
approve a draft, unpause a Run, or rewrite its original configuration. Nodes that
have already executed retain their settings, except for the explicit failed-node
recovery below; a waiting/dirty status alone does not make a node never-started.
Overrides survive replay and repeated saves update the previous override. A
pre-dispatch override does not opt a later provider failure into Continue recovery.

Scheduling enforces one writer per physical Run directory and retains directories required by pending feedback/repair. Allocation, reuse and reclamation follow the [workspace directory contract](workspace-snapshots-and-feedback.md#allocation-and-ownership).

Source locks cover approval and recorded Git snapshots after approved Planner revisions, not the Planner's live Bash/model session. They do not serialize node model sessions or final Graph publication across Runs. Concurrent direct edits or publications can produce Git conflicts, surfaced by each execution/publication result.

## Bounded feedback

A node with an outgoing feedback edge must end its response with `<ACCEPT>` or `<FEEDBACK>`:

- `<ACCEPT>` leaves the result accepted without sending an additional instruction.
- `<FEEDBACK>` queues a versioned request for the graph's one explicit target. Current requests reviewing the same target execution/revision are applied together as one repair once affected running work has been stopped and its failures settled. Only senders of applicable `<FEEDBACK>` contribute project-file results and instructions; `<ACCEPT>`, exhausted and superseded requests contribute neither. The batch invalidates the target and its ordinary dependency descendants once; other branches remain valid. The target continues its own history with the combined project results and individually attributed instructions, never the senders' conversations. Feedback budgets are still consumed once per applied source/target edge, not once per batch. Recomputed descendants start from zero: when an invalidated descendant re-dispatches without a session continuation, its launch supersedes the node's prior attempts, so its conversation renders only the live lineage instead of history recorded against the old workspace.
- A malformed verdict is a protocol error, not a node failure: the worker synchronously pushes a bounded repair turn into the node's own session (at most two, before completion commits) asking it to restate the verdict without repeating work. The pushed turn streams into the same execution transcript, and the first readable verdict is the one committed. If the verdict is still malformed after the repair budget, the execution fails with the protocol error; a provider or execution error inside a repair turn fails normally.
- Once `maxFeedback` is exhausted, another `<FEEDBACK>` records `FeedbackExhausted` rather than acceptance or failure. The source remains completed; no instruction is sent to the feedback target, no result is invalidated, and the counter does not increase. Downstream nodes continue with their original tasks and inherited workspace state; the skipped feedback text is not injected into their prompts. Graph cards show the exhausted budget and explain that feedback was not applied. An `<ACCEPT>` at the limit remains ordinary acceptance, without an exhaustion warning.
- The runtime caps the configured limit at 3. A limit of 0 skips the first feedback request. Execution errors still fail normally.

While feedback budget remains, a pending verdict that will apply makes every running execution in its scope doomed: the runtime stops them immediately instead of letting them finish into a discarded result, and their recorded failures settle before the batch invalidates the scope and dispatches the repair. Consumers cannot use a result whose pending feedback may supersede it; unrelated branches remain schedulable. Once a review's verdict is resolved, its feedback edge no longer blocks ready descendants just because an accepted sibling is still running. Scheduling that review again reactivates the barrier; queued unresolved verdicts retain their drain-before-handoff checks.

`Finished` and `FeedbackQueued` commit atomically. Requests pin source execution/head, the reviewed target execution/revision, and the final response's log-byte range before invalidation clears heads. The reviewed execution is taken from dispatch order, not the target's movable head after directory handoff. Legacy requests without that execution identity retain exact-head validation and are not grouped with other requests. Batch resolutions, per-edge counters and the single invalidation commit atomically; restart cannot partially consume a batch. Duplicate deliveries are idempotent, and a superseded review cannot overwrite a newer target result. Acceptance, exhausted budgets and superseded requests never transfer workspace ownership. Batching waits for already-running affected work, not for feedback nodes that have not been dispatched.

Completion-state verification, forwarded-message shape and session forks are specified in [Feedback workspace handoff](workspace-snapshots-and-feedback.md#feedback-is-an-exclusive-workspace-handoff).

Live steering does not itself mark a running node dirty. Completed-node follow-ups are new messages, not original-task rewrites; shared-terminal continuations, other changed results and history edits follow the distinct [session/invalidation rules](execution-model.md#sessions-follow-ups-and-history-edits).

### Durable node follow-up delivery

Accepted human follow-ups are a per-node FIFO in the event-sourced projection,
identified by event sequence rather than text. Equal messages are separate turns.
The legacy `instruction` field is not the queue and later sends cannot overwrite
an accepted pending turn. Existing approval, publication, dependency and writer
ownership checks still apply; queueing does not bypass them.

When a node can dispatch, Runtime batches its currently pending turns into one
Execution, preserving message boundaries, file-attachment text and image order.
A single turn retains its original prompt; a multi-turn prompt labels each turn
and its attached image range. The same durable `Started` event records the exact
`message_sequences` claim and removes those turns from the FIFO. A failed claim
write removes nothing. Later messages cannot be consumed by an earlier claim.
The browser uses this binding after reload and displays the shared response after
all user turns in that batch, not between them.

Pending turns survive checkpoints and restart; legacy checkpoints without queue
metadata rebuild from business events without rewriting stored data. Startup
still pauses unfinished Runs for explicit recovery rather than silently making
model calls. Dispatched messages remain bound to their execution, including its
failure/interruption evidence; a claim is not evidence of model completion.

Running nodes continue to accept acknowledged Pi RPC Steers in order, without a
new Execution or queue-capacity rejection. If a stale browser sends `intervene`
after dispatch has already started, the API routes it to that live writer as a
Steer. RPC transport/acknowledgement failures still surface as failures, not false
success or automatic resends.

Focused evidence: [queue/replay regressions](../../backend/src/node_message_queue_tests.rs),
[live delivery regressions](../../backend/src/node_message_delivery_tests.rs) and
[Graph/Serial browser interactions](../../scripts/frontend-audit.test.mjs).

## Event and output storage

Business events include graph creation/revision, approval, execution transitions, feedback, human intervention, pause, and publication. Execution output is stored separately in UTF-8 byte-indexed `execution_logs` chunks; terminal events carry structured metadata rather than full transcripts. New output fills the final partial chunk across writer batches, up to 32 KiB per UTF-8-aligned chunk, instead of retaining one row/index entry per small stdout packet. Extending a chunk never changes its committed text prefix or existing byte cursors; log writes and cursor/projection updates remain commit-ordered. This bounds future row overhead without rewriting retained transcripts during normal startup or history reads.

Grapher's tool-output display log is a projection, not a raw Pi-session dump. The [engine projection](../../backend/src/engine/tool_output.rs) retains at most 100 KiB of UTF-8 text per tool-result body, including a trailing `...` when truncated, and sets the truncation metadata. Tool cards, arguments, status, errors, exit codes and duration remain available. Cumulative `tool_execution_update.partialResult` bodies are not persisted: one identity/arguments update is retained per tool, and subsequent redundant progress records are suppressed. Tool-result copies in message/turn/agent aggregates receive the same body limit, so they cannot restore an unbounded result through another event. This only changes Grapher's outbound display log; Pi's own session, model context and actual tool result are untouched. The [browser preview limiter](../../src/services/toolOutput.ts) also caps legacy results and direct/live card callers before rendering or copying their output. Existing stored logs and byte cursors are never rewritten; reading an old oversized log can still require its original raw byte pages. `full=true` exports the retained display log and does not bypass producer-side truncation.

Snapshot/history/list requests are metadata-oriented. Node logs load on demand using `(runId, executionId, byteOffset)`; planning revisions each have their own cursor. Execution-log forward pages default to 256 KiB, with a configurable limit capped at 1 MiB. Planning forward pages are capped at 256 KiB; Planning tail requests accept a `limit` capped at 1 MiB. Both live and settled conversations open from a bounded 512 KiB tail, with 1 MiB targets for older reads (plus the bounded look-behind below). Upward scrolling prefetches within roughly two viewports of the loaded transcript's beginning, rather than waiting for the pane's exact top. Initial filling measures the rendered transcript, not the surrounding task, graph summary or composer, and reads older pages until there are about two viewports of actual history, the beginning is reached, or the automatic byte budget is exhausted. Automatic filling is limited to 4 MiB of loaded bytes on entry and per subsequent upward wheel/touch/keyboard gesture; one in-flight page including boundary look-behind can cross that budget. Sparse logs (for example, megabytes of cumulative progress for one long-running tool) must not force the browser to download the entire history before revealing it or keep an idle reader in a paging loop. Another upward gesture resumes loading; this budget is not a truncation of saved history. A tail beginning inside `tool_execution_update` records still identifies one tool card from its ID/name/arguments; cumulative partial-result snapshots are not appended as chat messages. On conversation entry, history is revealed after the bounded fill, virtualized row measurements and the initial scroll have settled; a first byte page or elapsed timer alone is not sufficient. All displayed execution turns participate in readiness, while empty logs and read errors still reveal a usable view with retry where appropriate. A gray loading label occupies a permanently reserved, separate line; it never overlays messages or changes the reading anchor. It represents a paging burst rather than each individual request: fast isolated reads do not flash the text, and short gaps between successive pages do not hide it. The label clears when the burst ends, including at the beginning of history or after an error; its display timers never initiate reads, advance cursors or gate conversation readiness. There is no load-earlier button. Prepending preserves a retained visible row's pixel position through virtualized height measurements, independently of concurrent live appends, and never enables follow-to-bottom while the user is reading older output. `tail=true` with an optional exclusive `before` cursor returns `startOffset` and `nextOffset`; older reads move only the start cursor, while live reads advance only the end cursor. Tail reads may include boundary look-behind (up to two stored execution chunks, or 256 KiB for Planner). A leading split JSONL record is retained for later reconstruction but is never displayed as raw assistant text. `full=true` remains available for explicit settled-output exports and compatibility callers.

Node and Merger execution records default to expanded, including older attempts.
Appending a message or waiting for its new execution does not collapse earlier
records. Explicitly collapsing a record affects only that execution and remains
in effect for later turns while viewing the same node conversation. This is
separate from the thinking/tool-card folding described below.

The two browser transcript caches each have a 20-entry / 30 MiB limit, charged against retained text rather than absolute byte cursors. Execution windows are owned by their mounted view and are released when leaving that Node/Serial/Merger view. Planner windows are cached independently by `(runId, planningId)` and, within the cache budget, survive Node-to-Planner navigation and new revisions within the same Conversation. Cold Planner history starts at the newest revision; older revisions load to fill the initial buffer or on upward scroll. The Latest action smoothly traverses the full distance without a pre-jump, tracks the bottom through live output and virtualized height changes, and temporarily disables reading-anchor restoration and automatic bottom snaps. User input or Conversation exit cancels the animation; reduced-motion preferences are respected. Cold, settled thinking history and tool cards start collapsed; their bodies are mounted only on explicit expansion. Active-conversation thinking (SSE or incremental JSONL) may auto-expand, while explicit user collapse remains respected. Folding reduces body-rendering work, not log-page transfer: the current JSONL byte pages still carry thinking and tool details, and expansion reads the already loaded page rather than issuing a per-card network request. Leaving the entire Conversation (another Run, workspace, new-conversation view, or unmount) releases both caches for that Run and cancels its in-flight readers so late responses cannot repopulate them. Deletion invalidates only the affected Run. A live Planner window must revalidate its end cursor through a terminal output page, even if that page has no new text; reaching the previous live byte total is not terminal completeness. These cache limits are not a cap on a selected transcript's size. Focused regressions cover cross-page tools, concurrent live/older reads, repeated switching and stop-with-draft behavior in [conversation history browser tests](../../scripts/conversation-history-ui.test.mjs) and [byte-window tests](../../scripts/transcript-window.test.ts).

Long Git snapshot, node-workspace preparation/copy and publication passes hold the Run mutex. `snapshot_if_changed` reads a transient per-Run activity projection and uses a non-blocking attempt on that mutex, so a poll during such a pass returns the unchanged version plus progress (for example that node workspaces are being copied) instead of queueing behind the I/O. Activity is display-only and never changes durable event state.

HTTP Run lookup serializes construction per `(data root, Run ID)`, not across
all Runs. It releases the primary/registry mutexes before replaying another Run;
legacy service-alias checks use non-blocking locks. An unverified busy alias
returns a retryable lookup error instead of waiting under global locks or opening
a second writer. Bootstrap repository discovery runs outside the Run mutex;
saving model defaults skips repository discovery and honors metadata projection.
See [service responsiveness regressions](../../backend/src/service_responsiveness_tests.rs).

The browser bounds metadata/history/settings and Provider catalog/poll waits to
15 seconds, including response-body reads. Planning streams, approvals and native
result execution do not inherit this UI deadline. Timeout does not roll back a
server write: a settings timeout asks the user to refresh and verify first, and
never automatically retries the save. Initialization/history failures provide a
sidebar retry; verified cards appear progressively with at most eight history
requests in flight. Planning waits for authoritative settings rather than
mistaking unloaded settings for a missing model. See
[request deadlines](../../src/services/requestTimeout.ts) and
[browser regressions](../../scripts/bootstrap-settings-ui.test.mjs).

Planning attempts retain requests, graph candidates, summaries, and Pi JSONL streams.
The planning SSE `complete` event is terminal even if the HTTP transport remains
open: the client releases the reader, clears foreground planning, and supersedes
in-flight draft polls with the committed snapshot. This applies to appended
Planner revisions as well as first plans. UI switching must not confuse one Run's
transcripts with another's. Tests and legacy-log migration are described in [Conversation logs](../testing/conversation-logs.md).

## Recovery and ownership

One backend process exclusively owns a runtime data directory through `runtime.lock`. Its selected Run pointer is a UI selection, not a single-active-Run restriction.

After interruption:

- Old model sessions are not automatically resumed.
- Interrupted executions retain terminal failure evidence internally and project
  as `paused` when the interruption is recognized; the Run remains paused or
  recoverable rather than claiming completion.
- If the failed execution is identified as an application/process interruption,
  the saved projection exposes a recoverable Continue action. Continue queues
  those interrupted nodes and their blocked dependency descendants, then starts
  new Execution Instances. For an interrupted node, the new instance keeps the
  same Pi session/workspace and uses the bundled `pi-continuity` public session
  boundary to continue the unfinished turn; it does not resend the original
  task or inject a synthetic “continue” user message. It does not mark a
  provider failure as successful or silently retry an ordinary failed node.
  Ordinary failures require an explicit node intervention, or a changed Node
  Agent model/thinking selection saved for the current conversation followed
  by Continue. Alongside never-started nodes, saving with that Run ID records
  per-node settings for its currently failed nodes; it keeps their failure/error
  evidence and does not dispatch work. Continue resumes those unfinished turns
  with the new settings and unblocks their dependency descendants without
  disturbing completed or unrelated branches. The override is replayable across restart and retained
  for that node's subsequent attempts; environment overrides still take
  precedence. Running/completed nodes, previously executed non-failed nodes,
  other Runs, and the Run's original configuration remain unchanged.
  See [model recovery regressions](../../backend/src/node_model_tests.rs) and
  [settings browser tests](../../scripts/bootstrap-settings-ui.test.mjs).
- A continued or retried execution reuses the last prepared attempt's physical
  working tree as-is: its committed HEAD (including agent commits made before
  the interruption) and all uncommitted work—including files matching
  `.gitignore`—are preserved and later force-collected into the result
  snapshot. Recovery never stashes, checks out or resets that directory. If the
  recorded inputs changed after preparation, the workspace is missing, or the
  prepared Git history was rewritten, the retry fails explicitly while
  retaining the partial work instead of silently rebuilding it.
- Interrupted planning becomes failed, preserving available output.
- Interrupted publication or its Merger becomes `publication_failed` for explicit retry.
- An interrupted node-composition Merger is recorded as failed without entering the publication phase; inspect the node workspace and rerun or resolve it.
- Committed pending feedback remains queued. Resume drains and validates it before related dispatch; an uncommitted finish cannot leave a half-persisted handoff.

Old executor leases block startup until the old execution is confirmed stopped; the native backend does not silently discard them or take over background writers.

Unix process groups and Windows kill-on-close Job Objects provide different lifecycle controls. They are not filesystem sandboxes and do not guarantee control of every detached process or external service. See [Filesystem isolation](filesystem-isolation.md#process-lifecycle).

## Delivery boundary

Only `PublicationCompleted` establishes Graph completion—not a finished model response or green UI. Retry/failure behavior is defined in [Final publication](execution-model.md#final-publication).

Source references: [runtime.rs](../../backend/src/runtime.rs), [store.rs](../../backend/src/store.rs), [server.rs](../../backend/src/server.rs), and [process_control.rs](../../backend/src/process_control.rs).
