# Runtime and persistence

The Rust backend owns Run state. SQLite stores append-only business events; a reducer produces the current Snapshot. React displays that projection and submits commands—it does not simulate execution or invent authoritative status.

## Graph representation

```ts
interface Graph {
  originalGoal: string;
  nodes: Array<{ name: string; task: string }>;
  edges: Array<{
    from: string;
    to: string;
    relation: string;
    feedback: boolean;
  }>;
}
```

Names are semantic identifiers, not literal directory names. Edges are unique by ordered `(from, to)` pair. The compiler checks nonempty/unique nodes, valid endpoints, no self-edges, graph limits, and an acyclic ordinary dependency graph. A feedback source has at most one target, and that target must be its dependency ancestor.

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

Nodes remain stable across recorded execution attempts. Historical output and backend-recorded Git snapshots remain inspectable even when a later revision supersedes their result.

## Scheduling and concurrency

Only ready nodes dispatch, subject to the **per-Graph-Run** limit. `maxParallel=0` defaults to 8; positive values can lower that limit, with a hard maximum of 8.

There is no global pool limiting nodes across Runs, and no shared cap for Planner/Serial sessions. Choose concurrency with provider quotas and machine resources in mind. Creating or switching conversations does not stop background Runs.

Failure blocks dependent branches; unrelated work continues. Pause stops new dispatches without forcibly terminating active model calls. Stop/cancel is a separate process-lifecycle action.

Source locks cover Planner preparation/publication and approval, including conflict repair during Planner publication. They do not serialize node model sessions or final Graph publication across Runs. Concurrent direct edits or publications can produce conflicts, surfaced by each execution/publication result.

## Bounded feedback

A node with an outgoing feedback edge must end its response with `<ACCEPT>` or `<FEEDBACK>`:

- `<ACCEPT>` leaves the result accepted without sending an additional instruction.
- `<FEEDBACK>` sends an additional instruction to the graph's one explicit target. That node continues its session/workspace; the target and its dependency descendants are invalidated, and completed results in that set are recomputed. Other branches remain valid.
- A malformed verdict fails the execution.
- Once `maxFeedback` is exhausted, another `<FEEDBACK>` records `FeedbackExhausted` rather than acceptance or failure. The source remains done; no instruction is sent to the feedback target, no result is invalidated, and the counter does not increase. Downstream nodes continue with their original tasks and inherited workspace state; the skipped feedback text is not injected into their prompts. Graph cards show the exhausted budget and explain that feedback was not applied. An `<ACCEPT>` at the limit remains ordinary acceptance, without an exhaustion warning.
- The runtime caps the configured limit at 3. A limit of 0 skips the first feedback request. Execution errors and malformed verdicts still fail normally.

While feedback budget remains, the runtime waits for running nodes that a pending verdict could invalidate. Consumers cannot use a result whose pending feedback may supersede it; unrelated branches remain schedulable.

Live steering does not itself mark a running node dirty. Completed-node follow-ups are new messages, not a rewrite of the original task text. See [Execution model](execution-model.md#sessions-follow-ups-and-history-edits).

## Event and output storage

Business events include graph creation/revision, approval, execution transitions, feedback, human intervention, pause, and publication. Execution output is stored separately in UTF-8 byte-indexed `execution_logs` chunks; terminal events carry structured metadata rather than full transcripts.

Snapshot/history/list requests are metadata-oriented. Node logs load on demand using `(runId, executionId, byteOffset)`; planning output has its own cursor. Execution-log pages default to 256 KiB, with a configurable limit capped at 1 MiB. For settled executions, `full=true` bypasses that page limit; the current UI uses this to load the selected historical transcript in full. Planning-output pages are capped at 256 KiB. The two browser transcript caches each have a 20-entry / 30 MiB limit; those cache limits are not a cap on a selected transcript's size.

Planning attempts retain requests, graph candidates, summaries, and Pi JSONL streams. UI switching must not confuse one Run's transcripts with another's. Tests and legacy-log migration are described in [Conversation logs](../testing/conversation-logs.md).

## Recovery and ownership

One backend process exclusively owns a runtime data directory through `runtime.lock`. Its selected Run pointer is a UI selection, not a single-active-Run restriction.

After interruption:

- Old model sessions are not automatically resumed.
- Interrupted executions become failed and the Run is paused.
- Interrupted planning becomes failed, preserving available output.
- Interrupted publication or its Merger becomes `publication_failed` for explicit retry.
- An interrupted node-composition Merger is recorded as failed without entering the publication phase; inspect the node workspace and rerun or resolve it.

Old executor leases block startup until the old execution is confirmed stopped; the native backend does not silently discard them or take over background writers.

Unix process groups and Windows kill-on-close Job Objects provide different lifecycle controls. They are not filesystem sandboxes and do not guarantee control of every detached process or external service. See [Filesystem isolation](filesystem-isolation.md#process-lifecycle).

## Delivery boundary

A Graph is complete only after `PublicationCompleted`. A finished model response, successful node test, or rendered green graph is not sufficient without successful publication. Retrying delivery uses the retained heads rather than rerunning valid tasks.

Source references: [runtime.rs](../../backend/src/runtime.rs), [store.rs](../../backend/src/store.rs), [server.rs](../../backend/src/server.rs), and [process_control.rs](../../backend/src/process_control.rs).
