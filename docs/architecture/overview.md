# Architecture: boundaries and contracts

> **Audience:** Developers changing Grapher. For product capabilities and setup, use the [README](../../README.md); for operation and safety, use the [user guide](../user-guide.md).
> **Scope:** Component ownership, graph compilation and contract navigation.
> **Maintained with:** [compiler.rs](../../backend/src/compiler.rs), [core tests](../../backend/tests/core.rs) and the owning modules below.

## Component boundaries

```text
Goal -> Partitioner --serial--> Pi agent in source
             |
             '--graph--> Planner -> Graph IR -> Compiler -> Approval
                                                             |
                                                        Rust runtime
                                                             |
                                                   Pi task executions
                                                             |
                                                     Git publication
```

| Component | Owns | Does not own |
| --- | --- | --- |
| Partitioner | Tool-free route classification | Planning or execution recovery |
| Planner | Candidate task/edge mutations and explicit revisions | Dependency scheduling or completion authority |
| Compiler | Graph validation and topology | Model calls or workspace allocation |
| Runtime | Dispatch, execution transitions, feedback and recovery | Coding decisions inside a task |
| Workspace layer | Git snapshots, physical slots, composition and refs | Agent conversations or access permissions |
| Native environment layer | Admission, managed evidence and launch bindings | A second project-file version channel |
| Pi | Model calls, tools and provider authentication | Run state transitions |
| React UI | Backend projections and user commands | Persisted execution truth |

Ordinary scheduling has no persistent LLM coordinator. Planner turns are explicit lifecycle operations, not scheduler ticks. Prompts beside the implementation are production inputs: [Planner](../../backend/resources/prompts/planner.md), [Partitioner](../../backend/resources/prompts/partitioner.md).

## Graph compilation

```ts
interface Graph {
  originalGoal: string;
  nodes: Array<{ name: string; task: string }>;
  edges: Array<{ from: string; to: string; feedback: boolean }>;
}
```

The persisted Graph IR uses `name` as its stable node identifier, not as a directory name. The Planner-facing `node` tool calls the same identifier `id`; edges reference these identifiers through `from` and `to`. Older Planner node calls using `name` remain accepted for session compatibility. Unsigned historical Planner tool calls are projected as `id` in model context without rewriting stored sessions; signature-bearing assistant turns and their tool results retain their original fields for provider replay. Persisted graphs, APIs and historical transcripts retain their existing `name` fields. Edges are unique by ordered `(from, to)` pair. Historical `relation` fields are ignored on read and never serialized back.

Compiler validation requires:

- Nonempty, unique node names and nonempty tasks; valid edge endpoints; no self-edges or duplicate edges.
- Ordinary edges form a DAG. Independent roots need no artificial connecting edges; new mutations reject redundant dependency edges.
- Each feedback source has at most one target, which must be an ordinary dependency ancestor of that source.

The compiler returns `executionBatches`, `rootNodes`, `terminals` and warnings. Batches describe topology, not scheduler-wide barriers; dispatch readiness belongs to [Runtime](runtime.md#scheduling-and-concurrency). Older checkpoints may contain `roots`; the backend reads that spelling and emits only `rootNodes`. The frontend also normalizes older backend responses, including Planner streams and direct compilation. API clients that consume `plan.roots` must migrate to `plan.rootNodes`.

Planner tool mutations compile atomically: invalid edits leave the saved candidate unchanged. Each `node`/`edge` result describes the current saved candidate, not a rejected edit: `topology["from: [to]"]` maps every source node id to an array of its immediate ordinary target node ids, matching the `edge` tool's `from` → `to` direction. A source can list multiple targets; `[]` means no outgoing ordinary edges, not no prerequisites. `topology.feedbackTo` separately maps feedback senders to their conditional targets. Applied edits also report `topology.rootNodes`, the compiler's sorted `plan.rootNodes` list of node names that currently inherit nothing, except when a node batch first populates an empty graph. In that initial batch no edges exist yet, so listing every node as a root would be redundant and could be mistaken for the final topology; omission does not mean there are no roots. Later edits retain the short list because an unintended extra root is otherwise hidden among many map entries. A rejected edit never reports roots and describes only the unchanged saved topology. If an invalid pre-existing candidate contains edges those maps cannot represent, `unrepresentedEdges` retains them explicitly. Historical tool results may still use `topology.directDependencies` (node → immediate ordinary predecessors) or `topology.roots`; their stored contents are not rewritten. This is a model-facing draft projection only; Graph IR and compilation semantics remain unchanged. A root starts from the recorded source, not automatically from the Planner's private workspace; inheritance and snapshot timing belong to [Workspaces and Git](workspace-snapshots-and-feedback.md). Once a Run has published, delivered nodes cannot be removed. Tools receive the unremovable node names and reject removal with `E210`; the Planner must rework the node or add follow-up work. Execution requires final validation and approval.

Planner tool results include feedback-scope warnings (`W303`) only for feedback edges newly added by that successful mutation, compared with the saved candidate before the call. Reapplying an existing route, editing nodes or ordinary dependencies, and deleting routes do not repeat existing feedback-scope warnings. These warnings describe only the conditional rerun scope. Other warnings, including cumulative revision impact, remain unchanged; empty warning lists are omitted. Full compiler plans still contain one `W303` per feedback edge in graph order, which the tool projection uses to associate warnings with routes without parsing node ids from prose.

## Contract ownership

Each row is the canonical home of its detailed rules. Cross-cutting pages link to that home rather than restating the contract.

| Contract | Canonical page | Boundary |
| --- | --- | --- |
| Routing, planning, approval, sessions, Merger conversations, publication lifecycle | [Execution lifecycle](execution-model.md) | Which operation runs, where its conversation continues, and when delivery succeeds |
| Scheduling, node states, feedback, events, output delivery, recovery | [Runtime and persistence](runtime.md) | Durable state transitions and concurrency |
| Git collection, shadow repositories, physical ownership, composition, feedback handoff | [Workspaces and Git](workspace-snapshots-and-feedback.md) | Project-file state and directory transfer |
| Environment admission, E/L evidence, resources, result descriptors and execution | [Native environments](native-environments.md) | Non-Git managed environment state |
| Role/platform access, path adaptation, external state and process lifecycle | [Filesystem isolation](filesystem-isolation.md) | Permissions and the limits of path/process controls |
| Data/cache layout, deletion and reclamation | [Storage and cleanup](storage.md) | Resource lifetime; log format remains in Runtime |
| Role tools, extensions, auth and Pi preparation | [Pi integration](../development/pi-integration.md) | Agent-host integration, not Run semantics |

## Implementation map

| Entry point | Responsibility |
| --- | --- |
| [compiler.rs](../../backend/src/compiler.rs) | Validation and topology |
| [runtime.rs](../../backend/src/runtime.rs), [model.rs](../../backend/src/model.rs) | Scheduling, feedback, revisions and event reduction |
| [workspace.rs](../../backend/src/workspace.rs), [native_copy.rs](../../backend/src/native_copy.rs) | Git state and physical copy primitive |
| [graph_merge.rs](../../backend/src/graph_merge.rs) | Conflict Mergers and publication |
| [environment.rs](../../backend/src/environment.rs), [workspace_files.rs](../../backend/src/workspace_files.rs) | Managed environment evidence and scoped snapshots |
| [engine.rs](../../backend/src/engine.rs), [native.rs](../../backend/src/native.rs) | Pi protocol and native launchers |
| [store.rs](../../backend/src/store.rs) | SQLite events and execution logs |
| [server.rs](../../backend/src/server.rs) | Local API, planning and runtime drivers |
| [src/](../../src/) | React UI and projections |

For task-specific source/tests, use the [task index](../index.md#task-routes). Check commands and prerequisites belong to [Testing](../development/testing.md).
