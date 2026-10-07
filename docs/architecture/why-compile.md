# Why compile agent work?

> **Status:** active
> **Scope:** Design rationale and trade-offs, not a duplicate runtime contract or performance guarantee.
> **Maintained with:** [Architecture](overview.md), [compiler.rs](../../backend/src/compiler.rs) and [runtime.rs](../../backend/src/runtime.rs).

## Two approaches to multi-agent orchestration

### Conversational orchestration

```text
Goal -> Supervisor LLM -> Worker A -> Supervisor LLM -> Worker B -> ...
```

The supervisor remains in the execution loop, deciding the next step from prior
results. This suits exploration with an initially unknown structure, but routing,
dependencies and retry decisions can be implicit in conversation. Inspectability
and recovery depend on what the surrounding system records; they are not
impossible, nor does every conversational system have the same limitations.

### Compiled orchestration (Grapher's approach)

```text
Goal -> Partitioner --serial--> one coding agent
             |
             '--graph--> Planner -> Compiler -> Approval -> Rust runtime
                                                          |          |
                                                        Agent A    Agent B
                                                          \          /
                                                            Agent C
                                                               |
                                                            Publish
```

The Planner produces explicit tasks and edges, then leaves the scheduler. Runtime
transitions no longer depend on a coordinator's next model response. Explicit
revisions can still change the graph; compilation is not an immutable lifetime
plan. See [Architecture](overview.md) for component boundaries.

## Key differences

| Concern | Conversation-driven coordination | Compiled coordination |
| --- | --- | --- |
| Next action | Coordinator interprets previous results | Runtime applies recorded dependencies/state |
| Inspection | Requires interpreting the coordination trace | Graph exposes dependencies before execution |
| Parallelism | Depends on coordinator/tool support | Ready independent tasks can dispatch concurrently |
| Recovery | Depends on stored conversation and host state | Explicit events, attempts and delivery state |
| Cost | Less upfront structure | Planning, validation, snapshots and composition |

**Deterministic orchestration is not deterministic model output or wall-clock
execution order.** Ready branches can finish in different orders; provider calls,
code quality and successful delivery still need separate verification.

## Why not always compile?

Small, linear or tightly coupled changes rarely justify graph-planning and
workspace-composition overhead. Independent modules or implementation/integration/
review stages may benefit from explicit dependencies. This is a structural choice,
not a promise that more agents are faster. The [Serial/Graph contract](execution-model.md#serial-and-graph)
owns the supported routing and approval behavior.

## Trade-offs

### Compiled orchestration advantages

Explicit dependencies, inspectable plans and recorded state make scheduling and
bounded rework easier to test without a persistent model coordinator.

### Compiled orchestration costs

Planning takes time. Parallel branches can conflict, inherited environments may
not relocate, and publication can fail. Private workspaces organize state; they
do not universally provide a security sandbox.

### Conversational orchestration advantages

A coordinator can adapt to emerging structure without first compiling a graph.
For linear tasks, one agent also avoids multi-workspace overhead.

### Conversational orchestration costs

Decisions encoded only in conversation are harder to inspect or validate as
explicit dependencies. A capable surrounding runtime can mitigate this; the
comparison is about where orchestration lives, not a blanket product ranking.

## When to use which

Use Serial for linear/exploratory work, Graph for useful independent workstreams,
or Auto for intent-based classification. See [the product route comparison](../../README.md#when-should-i-use-grapher)
instead of maintaining a second selection checklist here.

## Design philosophy

Models classify, plan and implement; deterministic host code validates, schedules
and publishes. The Merger is invoked for actual Git conflicts, not every delivery.
This separation makes control flow inspectable while retaining model flexibility
inside each task.

## Further reading

- [Architecture overview](overview.md) — Boundaries and invariants
- [Execution model](execution-model.md) — Planning side effects, sessions and publication
- [Workspace snapshots and feedback](workspace-snapshots-and-feedback.md) — File inheritance and portability
- [Runtime](runtime.md) — Scheduling, bounded feedback and persistence
- [Filesystem isolation](filesystem-isolation.md) — Actual platform permissions
