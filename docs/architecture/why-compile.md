# Why compile agent work?

## Two approaches to multi-agent orchestration

When a coding task requires multiple agents, there are two fundamentally different ways to coordinate their work:

### Conversational orchestration

```text
Goal
 ↓
Supervisor Agent (LLM)
 ↓
Worker Agent A
 ↓
Supervisor Agent (LLM) ← decides next step
 ↓
Worker Agent B
 ↓
Supervisor Agent (LLM) ← decides next step
 ↓
...
```

The supervisor stays in the execution loop, continuously deciding what to do next based on previous results. This is flexible and simple to implement, but:

- **Scheduling is opaque** — The supervisor's next decision is hidden in an LLM conversation
- **State management is implicit** — Dependencies and workspace state are managed through conversation context
- **Execution is non-deterministic** — The same input can produce different execution paths
- **Hard to inspect** — You see agent outputs, but the orchestration logic is in LLM weights
- **Cannot pause/resume easily** — The supervisor conversation is the execution state

### Compiled orchestration (Grapher's approach)

```text
Goal
 ↓
Partitioner (LLM) ← decides: Serial or Graph?
 ↓
[If Graph:]
Planner (LLM) ← creates execution plan
 ↓
Compiler (deterministic) ← validates and compiles
 ↓
User approval
 ↓
Rust Runtime (deterministic)
 ├─ Agent A (independent)
 ├─ Agent B (independent)
 └─ Agent C (depends on A + B)
      ↓
   Merge & Publish
```

The planning phase creates an explicit execution graph. After compilation, the Planner stops: scheduling no longer depends on an LLM coordinator's next message.

## Key differences

| Aspect | Conversational | Compiled |
|--------|---------------|----------|
| **Planning** | Continuous, interleaved with execution | Upfront, before execution |
| **Scheduling** | LLM decides next step | Deterministic runtime |
| **Dependencies** | Implicit in conversation | Explicit edges in graph |
| **Parallelism** | Sequential or ad-hoc | Dependency-aware |
| **Inspectability** | See outputs only | See graph, dependencies, workspace state |
| **Approval** | Before each agent call | Before entire graph |
| **State management** | Conversation context | Workspace snapshots + Git |
| **Pause/resume** | Difficult | Natural |

## Why not always compile?

**Compilation has overhead.** For simple, linear tasks, a single agent is faster and simpler:

- No planning phase
- No graph compilation
- No approval step
- No workspace inheritance complexity
- Direct access to your project

Grapher uses **Serial** for these cases. Only use **Graph** when you have genuinely independent workstreams:

- Frontend + backend changes
- Implementation + tests
- Multiple independent modules
- Implementation followed by bounded review/rework

**Auto** mode lets the Partitioner choose based on task complexity.

## Trade-offs

### Compiled orchestration advantages

- **Explicit dependencies** — The graph shows what depends on what
- **Deterministic scheduling** — Same graph, same execution order
- **Inspectable before execution** — Review and approve the plan
- **Workspace isolation** — Agents don't step on each other's changes
- **Better parallelism** — True parallel execution when dependencies allow
- **State is data** — Pause, resume, retry naturally

### Compiled orchestration costs

- **Planning overhead** — Creating and compiling the graph takes time
- **Upfront commitment** — Must plan entire graph before execution starts
- **Workspace complexity** — Managing multiple workspaces and merging results
- **Overkill for simple tasks** — Linear work doesn't benefit from graphs

### Conversational orchestration advantages

- **Simplicity** — One agent, one conversation
- **Adaptive** — Can change strategy mid-execution
- **Low overhead** — No separate planning/compilation phase
- **Good for exploration** — When you don't know the structure upfront

### Conversational orchestration costs

- **Opaque execution** — Can't see or approve the orchestration plan
- **Sequential bias** — Hard to exploit parallelism
- **State in conversation** — Pause/resume requires managing conversation history
- **Non-deterministic** — Same input, different execution paths

## When to use which

**Use Serial (conversational):**
- Small, linear coding tasks
- Exploratory work where structure emerges
- Tightly coupled changes
- Quick fixes and iterations

**Use Graph (compiled):**
- Independent workstreams that can run in parallel
- Complex dependencies you want to inspect
- Tasks where workspace isolation prevents conflicts
- Work you want to approve before full execution

**Use Auto:**
- Let the Partitioner decide based on task structure
- Default choice when uncertain

## Design philosophy

Grapher treats multi-agent orchestration as a **compiler problem**, not a conversation problem:

1. **Parse** the goal (Partitioner)
2. **Plan** the execution structure (Planner)
3. **Compile** and validate the graph (Compiler)
4. **Execute** deterministically (Runtime)
5. **Publish** the result (Merger)

This separation makes the system inspectable, testable, and deterministic where it matters, while keeping model intelligence focused on the creative parts: understanding the goal and implementing solutions.

## Further reading

- [Execution model](execution-model.md) — Planning, sessions, workspace inheritance, publication
- [Architecture overview](overview.md) — System design and invariants
- [Filesystem isolation](filesystem-isolation.md) — Workspace boundaries and sandboxing
