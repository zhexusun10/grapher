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

### Optional feedback capability

Settings **Enable Feedback** (`feedbackEnabled`) defaults to `false`, including when absent from older settings. Each subsequent Planner launch binds `GRAPHER_FEEDBACK_ENABLED` from its configuration, including prepared-process launches. When off, the `edge` tool accepts only `from`, `to` and optional `delete`: its schema and description contain no feedback protocol. Argument normalization rejects the omitted field rather than silently enabling it. Tool projections omit `feedbackTo`, feedback routes and feedback-specific warnings/notes. Rejected edits preserve their diagnostic codes and validation failure, but `E207`/`E208` are described as retained graph constraints without injecting the unavailable protocol. The Planner can add replacement dependency paths before removing old ones or request a user graph repair; constraints are never silently discarded. When on, the optional `feedback` field and its protocol description return; `maxFeedback` remains an independent budget.

The frontend always renders the session's actual graph, including existing feedback edges, ports, hints and reviewer/budget indicators after Settings is switched off. The entire edge-type legend is omitted for sessions with feedback disabled and no retained routes; historical routes remain visible even when an older config lacks the setting. Uncommitted planning falls back to the current default for its legend.

All graph commit entrypoints (new Graph JSON, draft edits, Planner revisions and manual node additions) reject **new or retargeted** feedback routes when disabled, including requests carrying stale enabled configs. Existing routes may be retained or removed within that same Run; they are not authorization to add routes to another Run. Settings are published by same-directory atomic replacement. Only an absent settings file uses the caller's initial configuration; unreadable or malformed settings fail explicitly instead of restoring an old opt-in. This is a capability for subsequent planning/edits, not cancellation of already committed work: Graph IR, transcripts, queued verdicts and existing execution/replay semantics remain intact. Custom prompts and user-authored history are not rewritten.

Coverage: [Planner tool/schema checks](../../scripts/check-pi-extension.ts), [prepared binding](../../scripts/prepared-host.test.mjs), [graph projection](../../scripts/graph-elements.test.ts), [settings persistence](../../scripts/bootstrap-settings-ui.test.mjs) [graph ingress/concurrent settings](../../backend/src/feedback_settings_tests.rs) and [manual node validation](../../backend/src/manual_node_tests.rs).

### Validation and tool projections

Compiler validation requires:

- Nonempty, unique node names and nonempty tasks; valid edge endpoints; no self-edges or duplicate edges.
- Ordinary edges form a DAG. Independent roots need no artificial connecting edges; new mutations reject redundant dependency edges.
- Each feedback source has at most one target, which must be an ordinary dependency ancestor of that source.

The compiler returns `executionBatches`, `rootNodes`, `terminals` and warnings. Batches describe topology, not scheduler-wide barriers; dispatch readiness belongs to [Runtime](runtime.md#scheduling-and-concurrency). Older checkpoints may contain `roots`; the backend reads that spelling and emits only `rootNodes`. The frontend also normalizes older backend responses, including Planner streams and direct compilation. API clients that consume `plan.roots` must migrate to `plan.rootNodes`.

Planner tool mutations compile atomically: invalid edits leave the saved candidate unchanged. Each `node`/`edge` result describes the current saved candidate, not a rejected edit: `topology["from: [to]"]` maps every source node id to an array of its immediate ordinary target node ids, matching the `edge` tool's `from` → `to` direction. A source can list multiple targets; `[]` means no outgoing ordinary edges, not no prerequisites. When the capability is enabled, `topology.feedbackTo` separately maps feedback senders to their conditional targets. Applied edits also report `topology.rootNodes`, the compiler's sorted `plan.rootNodes` list of node names that currently inherit nothing, except when a node batch first populates an empty graph. In that initial batch no edges exist yet, so listing every node as a root would be redundant and could be mistaken for the final topology; omission does not mean there are no roots. Later edits retain the short list because an unintended extra root is otherwise hidden among many map entries. A rejected edit never reports roots and describes only the unchanged saved topology. If an invalid pre-existing candidate contains edges those maps cannot represent, `unrepresentedEdges` retains them explicitly. Historical tool results may still use `topology.directDependencies` (node → immediate ordinary predecessors) or `topology.roots`; their stored contents are not rewritten. This is a model-facing draft projection only; Graph IR and compilation semantics remain unchanged. A root starts from the recorded source, not automatically from the Planner's private workspace; inheritance and snapshot timing belong to [Workspaces and Git](workspace-snapshots-and-feedback.md). Once a Run has published, delivered nodes cannot be removed. Tools receive the unremovable node names and reject removal with `E210`; the Planner must rework the node or add follow-up work. Execution requires final validation and approval.

Planner tool results surface informational mutation `notes` alongside `warnings`, omitting either field when empty. `notes` includes redundant transitive ordinary edges automatically pruned on acyclic `edge` edits (along with surviving indirect paths), incident edges cascade-removed by node deletions, and no-op deletions of non-existent edges. Conditional feedback rerun-scope descriptions (`W303`) are omitted from both `node` and `edge` results, including newly added, retargeted and re-added feedback routes. The `edge` description instead explains that previously run affected nodes retain their own context and recheck tasks against updated workspace state; execution details belong to [feedback continuation](runtime.md#feedback-continuation-notices). Advisory compiler warnings (`W301`, `W302`, cumulative revision impact `W304`) remain in `warnings`. Full compiler plans still contain one `W303` per feedback edge in graph order for other consumers; hiding these descriptions from Planner tool results does not change validation, invalidation or scheduling.

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
