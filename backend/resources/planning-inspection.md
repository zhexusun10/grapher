# Planner tool contract

This implementation-adjacent document specifies the Planner's tools. User-visible workspace/approval behavior is canonical in [Execution model](../../docs/architecture/execution-model.md); platform permissions are covered in [Filesystem isolation](../../docs/architecture/filesystem-isolation.md).

## Atomic graph mutations

Planner exposes exactly `node`, `edge`, `read`, and `bash`, plus compiler diagnostics from graph mutations. It is not a runtime agent dispatcher.

`node` accepts a nonempty `nodes` array; `edge` accepts a nonempty `edges` array. Use a length-one array for a single edit. Top-level single-edit fields are rejected.

```json
{"nodes":[{"name":"build","task":"Implement the requested change."}]}
```

```json
{"edges":[{"from":"build","to":"review","relation":"Review implementation","feedback":false}]}
```

Within one call, node names and ordered edge pairs must be unique, including identical repeats or delete-and-recreate edits. Duplicate diagnostics identify the array positions/target; the whole batch is rejected before edits or compilation. To replace a target, supply its final edit once.

A valid batch applies edits in order and compiles once. A rejected mutation leaves the saved graph unchanged. Deleting a node removes its incident edges; updating its task preserves edges. An edge batch can delete one pair and add another atomically; only the resulting graph is compiled, so an intermediate rewiring cycle does not alone reject a valid final graph.

Opposite directions are distinct ordered pairs. Dependency and feedback edits in the same direction refer to the same target. An omitted `feedback` field in the **tool edit** defaults to `false`; the saved Graph IR contains an explicit boolean. A feedback source has at most one target, which must be a dependency ancestor.

Compiler validation is not task execution or model-quality assessment. Final Graph execution still requires a valid plan and approval.

## Mutation feedback

Both tools return `applied` and a `topology` snapshot of the **saved graph after the call**, not just the edited targets. `topology.nodes` contains all node names; `topology.edges` contains all edges with `from`, `to`, `relation`, and explicit `feedback`. Task text, the original goal, and runtime node status are not repeated.

A successful call returns `applied: true` and the saved topology. It includes `warnings` as readable strings only when the compiler emits at least one warning; otherwise the field is omitted:

```json
{
  "applied": true,
  "topology": {
    "nodes": ["build", "review"],
    "edges": [{"from": "build", "to": "review", "relation": "Review implementation", "feedback": false}]
  }
}
```

A rejected call returns `applied: false`, the **unchanged saved topology**, and `diagnostics` as readable strings. The diagnostics describe the rejected candidate edits, not the returned topology. This also applies to duplicate-target errors and compiler failures; reporting the saved topology does not invoke the compiler a second time. Rejections are marked as tool errors; successful calls with warnings are not.

`E208` also suggests reconsidering feedback ownership instead of merely dropping routes. Separate feedback sources for independent workstreams and a shared rework owner are examples, not required graph shapes. The Planner should choose what fits the task and check that node tasks still match the resulting routes; these suggestions add no validation rules.

The compiler's execution plan stays internal. Derived dependency layers, roots, and terminals are not repeated in tool results; the topology already contains the graph structure.

Compiler warnings are advisory and do not reject otherwise valid edits:

- `W301`: distinct nodes have exactly identical task text. The warning lists their names so the Planner can confirm whether repeating the work is intentional; no semantic similarity or file-write conflict is inferred.
- `W302`: a task mentions `<FEEDBACK>` but its node has no outgoing feedback edge, so the marker cannot send an additional instruction.
- `W303`: each feedback edge reports what happens **if its source sends `<FEEDBACK>` and the feedback is applied**. It lists the target and all dependency descendants that would be invalidated, including the feedback source when reachable. Completed results in this set must be recomputed; the target continues its existing session/workspace. Other branches stay valid. Feedback edges are not traversed when computing this set. This describes the effect without judging the scope's size.

The feedback protocol uses an exact standalone final line: `<ACCEPT>` sends no additional instruction; `<FEEDBACK>` sends the preceding instruction to the edge's target. File-write conflict detection is not part of these warnings.

`applied: true` means the request passed mutation validation and was saved, even if it made no change. Mutation compilation uses `finalCheck: false`, so it can accept an empty graph during editing. Success does not mean final validation, approval, or execution has occurred.

## Native inspection tools

`read` uses Pi's native implementation, description, and offset/limit behavior. `bash` uses Pi's native backend without write-command filtering or implicit `errexit`/`pipefail`. The base tool set has no file `edit`/`write` tools or automatic project context files. Selected global Pi extensions, MCP tools and skills may additionally be available to the Planner.

The native tools run in the **bound source project's actual cwd**. Commands and file contents are passed unchanged, without mapping to a private copy. Native Bash and user extensions can write files directly into the source immediately; the base tool policy is not read-only inspection. Access to external resources is subject to host-user permissions.

## Source effects and approval

Planner writes are immediate source changes, not a deferred merge. No Planner preview or publication Merger runs. The same applies to a failed or cancelled planning session.

Approval snapshots the current source, including existing non-ignored user changes, before node workspaces are allocated. Approved Planner revisions snapshot their updated source and persist that input head for future nodes and event replay. Failed/cancelled revisions retain the previous graph but likewise snapshot their surviving source writes; snapshot errors pause execution. New jobs in that Run wait until the live revision ends; existing node workspaces are not overwritten. Source locks protect snapshots, not the Planner's model/Bash session. **Reject, failure, and cancellation do not undo file writes or external command side effects.**

A Planner-generated single `task` graph remains Graph because routing is persisted independently. First node executions get fresh sessions: roots start from the latest recorded source snapshot, and children compose that snapshot with completed parents' workspace state. Continuations can reuse the same node session. Planner/parent conversations are not copied into downstream agents.

## Boundaries

Graph-node path adaptation is a separate execution policy, not the Planner tool contract. It does not transparently remap scripts or programmatically assembled paths. macOS/Linux enforce defined private filesystem boundaries; Windows retains host-user permissions. Do not claim universal source denial or credential isolation across platforms.

Implementation: [planner.ts](planner.ts), [compiler.rs](../src/compiler.rs), and [server.rs](../src/server.rs).
