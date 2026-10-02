# Architecture

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
- **Planner:** inspects a private project copy and defines self-contained tasks and edges. It stops after planning and can be called again for an explicit graph revision.
- **Compiler:** validates graph structure and produces roots, terminals, and dependency batches.
- **Runtime:** dispatches ready tasks, tracks executions, handles bounded feedback, invalidation, pause, and publication.
- **Pi:** the pinned production coding-agent engine, responsible for model calls, tools, and provider authentication.
- **UI:** a projection of backend state, with approval and intervention controls.

See [Execution model](execution-model.md) for workspace and user-visible semantics.

## Graph compilation

The graph contains named tasks, ordinary dependency edges, and explicit feedback edges. Removing feedback edges must leave a DAG. A feedback target must be an ordinary dependency ancestor of its source; each feedback source can have only one target.

Planner tool mutations compile atomically: invalid changes leave the saved candidate graph unchanged. Graph execution requires final validation and approval. Independent roots do not need artificial connecting edges.

The [Planner contract](../../backend/resources/planning-inspection.md) describes the mutation schema. The production [Planner prompt](../../backend/resources/prompts/planner.md) and [Partitioner prompt](../../backend/resources/prompts/partitioner.md) stay beside the implementation.

## Runtime

A node is a stable task definition; an execution is one recorded attempt. The first attempt starts a fresh Pi session. Feedback and node follow-ups continue that node's existing session and workspace; other agents' conversations are not copied.

Ready nodes dispatch when dependencies and concurrency slots permit. Failure blocks dependent branches, not unrelated work. Feedback explicitly invalidates affected results rather than asking a coordinator to reinterpret the conversation.

The same backend can drive multiple Runs. Concurrency and pause are Run-scoped; a runtime data directory has one backend writer. See [Runtime](runtime.md) for limits, feedback, events, and recovery.

## Workspace inheritance

Ordinary dependency edges define one-way workspace inheritance. Roots start from the source baseline; a child waits for its parents to complete and starts from their resulting filesystem state. Multiple parents' states are combined before the child runs. Agents do not exchange workspaces, commits, or conversation histories with one another.

Each node has its own workspace and private `.git` directory, despite the `.grapher-worktrees` directory name. The backend uses Git snapshots and merges to implement inheritance and publication; committing or sending a result is not an agent-to-agent protocol. These repositories normally borrow the source Git object store rather than copy all history. Ordinary project folders use external shadow Git metadata rather than receiving a new `.git` directory. See [Execution model](execution-model.md#node-workspaces-and-inheritance) for the storage mechanism and conflict-recovery limits.

## Feedback

A node with an outgoing feedback edge returns `<ACCEPT>` or `<FEEDBACK>` as its final line. The graph chooses the target, the model chooses whether to send an additional instruction, and the runtime applies the bounded state transition.

For two parallel implementations, one integration owner can receive review feedback:

```text
frontend --\
            integration -> review
backend ---/     ^            |
                 '--feedback--'
```

Alternatively, give each implementation its own reviewer. One reviewer cannot dynamically choose between two feedback targets.

## Publication

Node completion is not Graph completion. Valid terminal heads must be published to the user's project. At final publication, only actual Git conflicts invoke a dedicated Merger; it does not wake the Planner. Other publication errors remain explicit failures.

Failed publication preserves the working state and heads. Retrying publication does not rerun completed nodes. A successful publication emits `PublicationCompleted`; interrupted work does not silently restart.

Planner changes are a separate earlier merge: after the planning session succeeds, the backend merges its private changes into the source **before graph approval**. Rejecting a graph is not a rollback. See [Execution model](execution-model.md#planning-and-approval).

## Invariants

1. Planner plans; Compiler validates; Runtime executes; Pi works.
2. Scheduling does not depend on a persistent LLM coordinator.
3. Ordinary dependencies form a DAG; cycles require explicit bounded feedback.
4. A new node starts a fresh session; continuation never imports another agent's chat history.
5. Ordinary dependencies pass workspace state from completed parents to children, not conversations or agent-to-agent messages.
6. Backend state and append-only events are authoritative; the UI is a projection.
7. Graph completion requires successful publication, not merely finished model calls.
8. Independent Git repositories are not, by themselves, security sandboxes.

## Implementation map

| Source | Responsibility |
| --- | --- |
| [compiler.rs](../../backend/src/compiler.rs) | Graph validation and execution plan |
| [runtime.rs](../../backend/src/runtime.rs) | Scheduling, feedback, revisions, and events |
| [workspace.rs](../../backend/src/workspace.rs) | Private repositories, snapshots, Planner copy/merge, and refs |
| [graph_merge.rs](../../backend/src/graph_merge.rs) | Workspace conflict Merger and final publication |
| [engine.rs](../../backend/src/engine.rs) | Role configuration and Pi process protocol |
| [native.rs](../../backend/src/native.rs) | Native launchers and platform preflight |
| [store.rs](../../backend/src/store.rs) | SQLite events and execution logs |
| [server.rs](../../backend/src/server.rs) | Local API, planning, and runtime drivers |
| [src/](../../src/) | React UI and state projections |

Next: [Execution model](execution-model.md) · [Filesystem isolation](filesystem-isolation.md) · [Development guide](../development/contributing.md)
