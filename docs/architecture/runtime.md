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

## Node states

```text
waiting -> running -> done
             |         |
             v         v
           failed    dirty -> running

waiting / dirty -> blocked
```

- `waiting`: task has not run or is waiting for dependencies.
- `running`: an execution is in progress.
- `done`: current task result is valid.
- `dirty`: a change invalidated the current result.
- `failed`: the execution or protocol failed.
- `blocked`: dependencies failed or workspace composition could not proceed.

Nodes remain stable across recorded execution attempts. Historical output and backend-recorded Git snapshots remain inspectable even when a later revision supersedes their result; ordinary files remain tied to their physical directory.

## Scheduling and concurrency

Only ready nodes dispatch, subject to the **per-Graph-Run** limit. `maxParallel=0` defaults to 8; positive values can lower that limit, with a hard maximum of 8.

There is no global pool limiting nodes across Runs, and no shared cap for Planner/Serial sessions. Choose concurrency with provider quotas and machine resources in mind. Creating or switching conversations does not stop background Runs.

Failure blocks dependent branches; unrelated work continues. Pause stops new dispatches without forcibly terminating active model calls. Stop/cancel is a separate process-lifecycle action.

Scheduling enforces one writer per physical Run directory and retains directories required by pending feedback/repair. Allocation, reuse and reclamation follow the [workspace directory contract](workspace-snapshots-and-feedback.md#allocation-and-ownership).

Source locks cover approval and recorded Git snapshots after approved Planner revisions, not the Planner's live Bash/model session. They do not serialize node model sessions or final Graph publication across Runs. Concurrent direct edits or publications can produce Git conflicts, surfaced by each execution/publication result.

## Bounded feedback

A node with an outgoing feedback edge must end its response with `<ACCEPT>` or `<FEEDBACK>`:

- `<ACCEPT>` leaves the result accepted without sending an additional instruction.
- `<FEEDBACK>` queues a versioned request for the graph's one explicit target. After affected running work drains, applying it invalidates the target and its ordinary dependency descendants; other branches remain valid. The target receives the sender's completed physical workspace plus instruction, never the sender's conversation.
- A malformed verdict fails the execution.
- Once `maxFeedback` is exhausted, another `<FEEDBACK>` records `FeedbackExhausted` rather than acceptance or failure. The source remains done; no instruction is sent to the feedback target, no result is invalidated, and the counter does not increase. Downstream nodes continue with their original tasks and inherited workspace state; the skipped feedback text is not injected into their prompts. Graph cards show the exhausted budget and explain that feedback was not applied. An `<ACCEPT>` at the limit remains ordinary acceptance, without an exhaustion warning.
- The runtime caps the configured limit at 3. A limit of 0 skips the first feedback request. Execution errors and malformed verdicts still fail normally.

While feedback budget remains, the runtime waits for running nodes that a pending verdict could invalidate; it does not forcibly suspend their processes. Consumers cannot use a result whose pending feedback may supersede it; unrelated branches remain schedulable.

`Finished` and `FeedbackQueued` commit atomically. Requests pin source execution/head, target execution/head/revision, and the final response's log-byte range before invalidation clears heads. Restart replays that exact request. Duplicate deliveries are idempotent; a superseded review cannot overwrite a newer target result. Acceptance, exhausted budgets and superseded requests never transfer workspace ownership.

Completion-state verification, forwarded-message shape and session forks are specified in [Feedback workspace handoff](workspace-snapshots-and-feedback.md#feedback-is-an-exclusive-workspace-handoff).

Live steering does not itself mark a running node dirty. Completed-node follow-ups are new messages, not original-task rewrites; shared-terminal continuations, other changed results and history edits follow the distinct [session/invalidation rules](execution-model.md#sessions-follow-ups-and-history-edits).

## Event and output storage

Business events include graph creation/revision, approval, execution transitions, feedback, human intervention, pause, and publication. Execution output is stored separately in UTF-8 byte-indexed `execution_logs` chunks; terminal events carry structured metadata rather than full transcripts.

Snapshot/history/list requests are metadata-oriented. Node logs load on demand using `(runId, executionId, byteOffset)`; planning output has its own cursor. Execution-log pages default to 256 KiB, with a configurable limit capped at 1 MiB. For settled executions, `full=true` bypasses that page limit; the current UI uses this to load the selected historical transcript in full. Planning-output pages are capped at 256 KiB. The two browser transcript caches each have a 20-entry / 30 MiB limit; those cache limits are not a cap on a selected transcript's size.

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

Planning attempts retain requests, graph candidates, summaries, and Pi JSONL streams. UI switching must not confuse one Run's transcripts with another's. Tests and legacy-log migration are described in [Conversation logs](../testing/conversation-logs.md).

## Recovery and ownership

One backend process exclusively owns a runtime data directory through `runtime.lock`. Its selected Run pointer is a UI selection, not a single-active-Run restriction.

After interruption:

- Old model sessions are not automatically resumed.
- Interrupted executions become failed and the Run is paused.
- Interrupted planning becomes failed, preserving available output.
- Interrupted publication or its Merger becomes `publication_failed` for explicit retry.
- An interrupted node-composition Merger is recorded as failed without entering the publication phase; inspect the node workspace and rerun or resolve it.
- Committed pending feedback remains queued. Resume drains and validates it before related dispatch; an uncommitted finish cannot leave a half-persisted handoff.

Old executor leases block startup until the old execution is confirmed stopped; the native backend does not silently discard them or take over background writers.

Unix process groups and Windows kill-on-close Job Objects provide different lifecycle controls. They are not filesystem sandboxes and do not guarantee control of every detached process or external service. See [Filesystem isolation](filesystem-isolation.md#process-lifecycle).

## Delivery boundary

Only `PublicationCompleted` establishes Graph completion—not a finished model response or green UI. Retry/failure behavior is defined in [Final publication](execution-model.md#final-publication).

Source references: [runtime.rs](../../backend/src/runtime.rs), [store.rs](../../backend/src/store.rs), [server.rs](../../backend/src/server.rs), and [process_control.rs](../../backend/src/process_control.rs).
