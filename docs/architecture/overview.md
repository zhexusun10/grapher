# Architecture

> **Status:** active
> **Scope:** System boundaries and invariants; detailed execution/runtime contracts are linked below.
> **Maintained with:** [compiler.rs](../../backend/src/compiler.rs), [runtime.rs](../../backend/src/runtime.rs) and [core tests](../../backend/tests/core.rs).

> Don't orchestrate agents. Compile work.

Grapher is a local multi-agent coding system. Models route, plan, and perform coding tasks; a Rust compiler and runtime own validation, scheduling, state transitions, and delivery. The planner is not a persistent execution coordinator.

## Motivation

Conversation-driven coordination can hide dependencies, retry policy, and completion inside an LLM's next response. Grapher makes that structure explicit before execution. This makes orchestration inspectable—not model output reproducible or code quality guaranteed.

A graph is useful when workstreams can advance independently. Single or tightly coupled tasks stay Serial; splitting work that repeatedly edits the same files can add conflicts without useful parallelism.

## Execution model

```text
Goal -> Partitioner --serial--> one Pi agent in the user's project
             |
             '--graph--> Planner -> Graph IR -> Compiler -> Approval
                                                             |
                                                             v
                                                        Rust runtime
                                                        /         \
                                                     Agent A     Agent B
                                                        \         /
                                                    Workspace inheritance
                                                             |
                                                             v
                                                          Agent C
                                                             |
                                                             v
                                                      Publish to project
```

- **Partitioner:** a tool-free classifier. Its `parallel` response maps to the internal `graph` route. A provider failure is a failure, not an auto-approved Serial fallback.
- **Planner:** runs in the source project, can write files directly with native Bash, and defines self-contained tasks and edges. It stops after planning and can be called again for an explicit graph revision.
- **Compiler:** validates graph structure and produces roots, terminals, and dependency batches.
- **Runtime:** dispatches ready tasks, tracks executions, handles bounded feedback, invalidation, pause, and publication.
- **Pi:** the pinned production coding-agent engine, responsible for model calls, tools, and provider authentication.
- **UI:** a projection of backend state, with approval and intervention controls.

See [Execution model](execution-model.md) for workspace and user-visible semantics.

## Graph compilation

The graph contains named tasks, ordinary dependency edges, and explicit feedback edges. Removing feedback edges must leave a DAG. A feedback target must be an ordinary dependency ancestor of its source; each feedback source can have only one target.

Planner tool mutations compile atomically: invalid changes leave the saved candidate graph unchanged. Graph execution requires final validation and approval. Independent roots do not need artificial connecting edges.

The production [Planner prompt](../../backend/resources/prompts/planner.md) and [Partitioner prompt](../../backend/resources/prompts/partitioner.md) stay beside the implementation.

## Runtime

A node is a stable task definition; an execution is a recorded attempt, not necessarily a new conversation. Ready nodes dispatch under Run-scoped limits; failure blocks dependent branches, not unrelated work.

[Runtime](runtime.md) owns scheduling, feedback, events and recovery. [Session semantics](execution-model.md#sessions-follow-ups-and-history-edits) own new conversations, continuation and history edits.

## Workspace inheritance

Ordinary dependencies and applied feedback inherit completed project state, including ignored resources—not other nodes' conversations. Private repositories are reusable single-writer execution slots, not permanent node identities or security sandboxes.

[Workspace snapshots and feedback](workspace-snapshots-and-feedback.md) owns the Git/ignored channels, handoff/fan-out/fan-in rules, storage details and portability limits. [Execution model](execution-model.md#parent-composition-conflicts) owns user-facing conflict recovery.

## Feedback

A node with an outgoing feedback edge returns `<ACCEPT>` or `<FEEDBACK>` as its final line. The graph chooses the target, the model chooses whether to send an additional instruction, and the runtime applies the bounded state transition.

For two parallel implementations, one integration owner can receive review feedback:

```text
frontend --\
            integration -> review
backend ---/     ^            |
                 '--feedback--'
```

Alternatively, give each implementation its own reviewer. One reviewer cannot dynamically choose between two feedback targets. See [bounded feedback](runtime.md#bounded-feedback) for verdicts, budgets and invalidation, and [workspace handoff](workspace-snapshots-and-feedback.md#feedback-is-an-exclusive-workspace-handoff) for file/session transfer.

## Publication

Node completion is not Graph completion: successful publication emits `PublicationCompleted`. The [publication contract](execution-model.md#final-publication) defines retained results, retries and conflict-only Merger use.

Planner writes reach the source **before graph approval**; rejection, failure and cancellation are not rollbacks. See [Planning and approval](execution-model.md#planning-and-approval).

## Invariants

1. Planner plans; Compiler validates; Runtime executes; Pi works.
2. Scheduling does not depend on a persistent LLM coordinator.
3. Ordinary dependencies form a DAG; cycles require explicit bounded feedback.
4. A new node starts a fresh session; continuation never imports another agent's chat history.
5. Ordinary dependencies and applied feedback inherit completed workspace state, not conversations; each physical directory has at most one active writer.
6. Backend state and append-only events are authoritative; the UI is a projection.
7. Graph completion requires successful publication, not merely finished model calls.
8. Independent Git repositories are not, by themselves, security sandboxes.

## Implementation map

| Source | Responsibility |
| --- | --- |
| [compiler.rs](../../backend/src/compiler.rs) | Graph validation and execution plan |
| [runtime.rs](../../backend/src/runtime.rs) | Scheduling, feedback, revisions, and events |
| [workspace.rs](../../backend/src/workspace.rs) | Private repositories, Git snapshots, composition, and refs |
| [workspace_files.rs](../../backend/src/workspace_files.rs) | Ignored-file snapshots, composition, verification, and materialization |
| [graph_merge.rs](../../backend/src/graph_merge.rs) | Workspace conflict Merger and final publication |
| [engine.rs](../../backend/src/engine.rs) | Role configuration and Pi process protocol |
| [native.rs](../../backend/src/native.rs) | Native launchers and platform preflight |
| [store.rs](../../backend/src/store.rs) | SQLite events and execution logs |
| [server.rs](../../backend/src/server.rs) | Local API, planning, and runtime drivers |
| [src/](../../src/) | React UI and state projections |

Next: [Execution model](execution-model.md) · [Filesystem isolation](filesystem-isolation.md) · [Development guide](../development/contributing.md)
