# Runtime and persistence

> **Scope:** Scheduling, durable events, feedback and interruption recovery.
> **Maintained with:** [runtime.rs](../../backend/src/runtime.rs), [model.rs](../../backend/src/model.rs), [store.rs](../../backend/src/store.rs) and [runtime tests](../../backend/src/runtime_tests.rs).

The Rust backend owns Run state. SQLite stores append-only business events; a reducer produces the current Snapshot. React displays that projection and submits commands—it does not simulate execution or invent authoritative status.

Graph shape and validation belong to [Graph compilation](overview.md#graph-compilation). Managed environment transitions and model-free execution belong to [Native environments](native-environments.md).

## Planning graph projection

During foreground planning, the graph pane opens on an accepted (successful)
`node`/`edge` tool result, not on a pending or failed call.
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
to resume a nonexistent session; the unstarted attempt remains in history. A
user follow-up after an attempt died before Pi persisted its conversation (for
example while loading an extension) recovers the same way: the retained
workspace and session slot receive the node task and the follow-up turn instead
of failing with `Cannot resume node session`. Retrying or editing a message from
such an attempt also skips the missing JSONL branch: an edited opening turn
replaces the node task, and an edited follow-up is appended to it.
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
unapproved drafts, nodes waiting for dependencies or blocked before their first
attempt, and nodes the Planner adds later. Their first dispatch uses those
settings. Saving does not dispatch work, approve a draft, unpause a Run, or
rewrite its original configuration. Nodes that have already executed retain
their settings, except for the explicit failed-node recovery below; a
waiting/dirty status alone does not make a node never-started.
Overrides survive replay and repeated saves update the previous override. A
pre-dispatch override does not opt a later provider failure into Continue recovery.
Model selections are conversation-scoped: a save made inside a Run records
that conversation's override, including nodes the Planner adds later. Other
conversations keep their own creation or saved selection, so their running and
never-started nodes are not retargeted. Conversations that never changed models
continue with the settings composition used when they were created, while new
conversations use the saved global defaults. `config.json` remains the defaults
document for new Runs; the Run projection carries `modelConfig` for its own
conversation.

Dispatch must honor [physical workspace ownership](workspace-snapshots-and-feedback.md#physical-workspaces-and-ownership) and the [Planner follow-up dispatch/publication barrier](execution-model.md#planner-follow-up-workspaces).

Source locks cover approval and recorded Git snapshots after approved Planner revisions, not the Planner's live Bash/model session. They do not serialize node model sessions or final Graph publication across Runs. Concurrent source-native Planners can overwrite one another's files; they have no private merge. Concurrent direct edits or publications can produce Git conflicts, surfaced by each execution/publication result.

## Bounded feedback

A node with an outgoing feedback edge must end its response with `<ACCEPT>` or `<FEEDBACK>`:

- `<ACCEPT>` leaves the result accepted without sending an additional instruction.
- `<FEEDBACK>` queues a versioned request for the graph's one explicit target. Current requests reviewing the same target execution/revision are applied together as one repair once affected running work has been stopped and its failures settled. Only senders of applicable `<FEEDBACK>` contribute project-file results and instructions; `<ACCEPT>`, exhausted and superseded requests contribute neither. The batch invalidates the target and its ordinary dependency descendants once; other branches remain valid. The target continues its own history with the combined project results and individually attributed instructions, never the senders' conversations. Feedback budgets are still consumed once per applied source/target edge, not once per batch. Recomputed descendants start from zero: when an invalidated descendant re-dispatches without a session continuation, its launch supersedes the node's prior attempts, so its conversation renders only the live lineage instead of history recorded against the old workspace.
- A malformed verdict is a protocol error, not a node failure: the worker synchronously pushes a bounded repair turn into the node's own session (at most two, before completion commits) asking it to restate the verdict without repeating work. The pushed turn streams into the same execution transcript, and the first readable verdict is the one committed. If the verdict is still malformed after the repair budget, the execution fails with the protocol error; a provider or execution error inside a repair turn fails normally.
- Once `maxFeedback` is exhausted, another `<FEEDBACK>` records `FeedbackExhausted` rather than acceptance or failure. The source remains completed; no instruction is sent to the feedback target, no result is invalidated, and the counter does not increase. Downstream nodes continue with their original tasks and inherited workspace state; the skipped feedback text is not injected into their prompts. Graph cards show the exhausted budget and explain that feedback was not applied. An `<ACCEPT>` at the limit remains ordinary acceptance, without an exhaustion warning.
- The runtime caps the configured limit at 3. A limit of 0 records the first `<FEEDBACK>` as exhausted. Execution errors still fail normally.

While feedback budget remains, a pending verdict that will apply makes every running execution in its scope doomed: the runtime stops them immediately instead of letting them finish into a discarded result, and their recorded failures settle before the batch invalidates the scope and dispatches the repair. Consumers cannot use a result whose pending feedback may supersede it; unrelated branches remain schedulable. Once a review's verdict is resolved, its feedback edge no longer blocks ready descendants just because an accepted sibling is still running. Scheduling that review again reactivates the barrier; queued unresolved verdicts retain their drain-before-handoff checks.

`Finished` and `FeedbackQueued` commit atomically. Requests pin source execution/head, the reviewed target execution/revision, and the final response's log-byte range before invalidation clears heads. The reviewed execution is taken from dispatch order, not the target's movable head after directory handoff. Legacy requests without that execution identity retain exact-head validation and are not grouped with other requests. Batch resolutions, per-edge counters and the single invalidation commit atomically; restart cannot partially consume a batch. Duplicate deliveries are idempotent, and a superseded review cannot overwrite a newer target result. Acceptance, exhausted budgets and superseded requests never transfer workspace ownership. Batching waits for already-running affected work, not for feedback nodes that have not been dispatched.

Cleanliness and physical transfer checks belong to [Feedback workspace handoff](workspace-snapshots-and-feedback.md#feedback-and-history-edits); conversation forks belong to [Session continuity](execution-model.md#sessions-follow-ups-and-history-edits).

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

Running nodes continue to accept ordered Pi RPC Steers without a new Execution
or queue-capacity rejection. If a stale browser sends `intervene` after dispatch
has already started, the API routes it to that live writer as a Steer. Control
records delivery once the live RPC input accepts the command and does not block
the HTTP request on a long tool turn's acknowledgement; a closed RPC input still
surfaces as a failure, not false success or an automatic resend.

Focused evidence: [queue/replay regressions](../../backend/src/node_message_queue_tests.rs),
[live delivery regressions](../../backend/src/node_message_delivery_tests.rs) and
[Graph/Serial browser interactions](../../scripts/frontend-audit.test.mjs).

## Event and output storage

Business events include graph creation/revision, approval, execution transitions,
feedback, human intervention, pause, and publication. Execution output is stored
separately in UTF-8 byte-indexed `execution_logs` chunks; terminal events carry
structured metadata rather than full transcripts. New output fills the final
partial chunk up to 32 KiB instead of one row per stdout packet. Extending a chunk
never changes its committed prefix or existing byte cursors; log writes and
cursor/projection updates remain commit-ordered.

The engine coalesces adjacent text/thinking deltas within a bounded byte/time
window before persistence; message/block changes, other events, stderr, EOF and
timeouts flush pending text in order. Incremental records omit repeated usage
and cumulative message snapshots. Unused `toolcall_delta` JSON fragments are
omitted; tool identity and complete arguments remain in start/end records.
`message_end` retains final usage, model, errors and full assistant content.
This changes only new display-log bytes, never existing cursors or Pi sessions.

Grapher's tool-output display log is a projection, not a raw Pi-session dump. The
[engine projection](../../backend/src/engine/tool_output.rs) retains at most
100 KiB of UTF-8 text per tool-result body and per tool-call argument value
(`write`/`edit` carry whole file bodies), marks the owner with
`truncated`/`argsTruncated`, and suppresses redundant cumulative
`tool_execution_update.partialResult` bodies. Pi's own session, model context and
actual tool result are untouched; `full=true` exports the retained display log
and does not bypass producer-side truncation.

The sidebar uses backend-owned conversation summaries, prewarmed without
transcripts or runtime locks. Settled cards do not require snapshots; live work
remains watched. Browser caches are rendering hints, and failed reads must not
imply deletion or block settings saves. Repository discovery is asynchronous and
respects explicitly empty saved workspace lists. See the
[summary projection](../../backend/src/store/conversations.rs) and
[polling](../../src/hooks/useSnapshotPolling.ts) implementations.

Snapshot/history/list requests are metadata-oriented. Node logs load on demand by
`(runId, executionId, byteOffset)`; planning revisions have their own cursor.
Execution-log pages default to 256 KiB and are capped at 1 MiB; planning forward
pages are capped at 256 KiB, and planning tails accept a `limit` capped at 1 MiB.
`tail=true` with an optional exclusive `before` cursor returns `startOffset` and
`nextOffset`. Browser transcript fill, cache and folding behavior lives in
[transcriptCache.ts](../../src/services/transcriptCache.ts) and is covered by
[conversation history browser tests](../../scripts/conversation-history-ui.test.mjs)
and [byte-window tests](../../scripts/transcript-window.test.ts); those UI budgets
are not a storage cap.

Approval and Planner revisions collect their source Git snapshot under the Run
mutex. First-node source materialization uses the per-repository source lock and
only short Run-mutex reads; node workspace preparation/copy and final publication
run outside the Run mutex. The Run state is revalidated before completion events
commit. Activity reporting uses a non-blocking Run-mutex attempt, so status polls
return progress instead of queueing behind I/O. Activity is display-only and
never changes durable event state. Metadata, history,
settings, and provider-catalog waits have a 15-second browser deadline; planning
streams, approvals and native result execution do not. A settings timeout asks the
user to refresh and verify; it never rolls back or automatically retries a save.
See [request deadlines](../../src/services/requestTimeout.ts).

`/api/events` SSE notifications (`snapshot_changed`, `output_available`,
`planning_output_available`) are a latency accelerator, never the authority. The
browser keeps a bounded re-check of durable state while the stream is connected,
resumes timer polling when it errors or closes, and recreates a stream the
`EventSource` gave up on. A missed push therefore costs latency, not a frozen
transcript or status. See
[runtimeEvents.ts](../../src/services/runtimeEvents.ts) and
[ExecutionTranscript.tsx](../../src/components/ExecutionTranscript.tsx).

Planning attempts retain requests, graph candidates, summaries, and Pi JSONL
streams. The planning SSE `complete` event is terminal even if the HTTP transport
remains open: the client releases the reader and supersedes in-flight draft polls
with the committed snapshot. This applies to appended Planner revisions as well
as first plans. Tests and legacy-log migration are described in
[Conversation logs](../testing/conversation-logs.md).

## Recovery and ownership

One backend process exclusively owns a runtime data directory through `runtime.lock`. Its selected Run pointer is a UI selection, not a single-active-Run restriction.

After interruption:

- Old model sessions are not automatically resumed.
- Interrupted executions retain terminal failure evidence internally and project
  as `paused` when the interruption is recognized; the Run remains paused or
  recoverable rather than claiming completion.
- If the failed execution is identified as an application/process interruption,
  the saved projection exposes a recoverable Continue action. Continue queues
  those interrupted nodes and their failed/blocked dependency descendants, then
  starts new Execution Instances. For an interrupted node, the new instance keeps the
  same Pi session/workspace and uses the bundled `pi-continuity` public session
  boundary to continue the unfinished turn; it does not resend the original
  task or inject a synthetic “continue” user message. It does not mark a
  provider failure as successful or silently retry an ordinary failed node.
  Ordinary failures require an explicit node intervention, or a changed Node
  Agent model/thinking selection saved for the current conversation followed
  by Continue. A Provider credential failure (OAuth refresh/`invalid_grant`,
  credential-store, API-key or not-authenticated errors) is the one exception:
  it leaves the task and session untouched, so after re-authenticating in
  Settings the same Continue control resumes that session through the same
  continuity turn instead of demanding an intervention message. Alongside
  never-started nodes, saving with that Run ID records
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

Process termination guarantees belong to [Process lifecycle](filesystem-isolation.md#process-lifecycle); publication transitions and delivery evidence belong to [Final publication](execution-model.md#final-publication).

Source references: [runtime.rs](../../backend/src/runtime.rs), [store.rs](../../backend/src/store.rs), [server.rs](../../backend/src/server.rs), and [process_control.rs](../../backend/src/process_control.rs).
