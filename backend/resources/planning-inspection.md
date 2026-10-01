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

## Native inspection tools

`read` uses Pi's native implementation, description, and offset/limit behavior. `bash` uses Pi's native backend without write-command filtering or implicit `errexit`/`pipefail`. There are no file `edit`/`write` tools, automatic project context files, or automatically discovered skills/extensions for the Planner.

The native tools run in the **private Planner repository's actual cwd**. Commands and file contents are not transparently rewritten to the source directory. Required PATH/HOME/temp/external resources remain subject to the host and private-workspace platform policy. Native Bash can write files in that workspace; a four-tool policy is not read-only inspection.

## Source effects and approval

After the planning session succeeds, the host snapshots and merges private Planner changes into the source, with a preview merge to detect ordinary conflicts. Short source locks protect copying and merging, not the entire model session. A failed merge preserves the private workspace.

This happens before graph approval. Approval snapshots the resulting current source, including existing non-ignored user changes, and can stage/commit those changes before node workspaces are allocated. **Reject does not undo already-merged changes or external command side effects.**

A Planner-generated single `task` graph remains Graph because routing is persisted independently. First node executions get fresh sessions and Git dependency state; continuations can reuse the same node session. Planner/parent conversations are not copied into downstream agents.

## Boundaries

Graph-node path adaptation is a separate execution policy, not the Planner tool contract. It does not transparently remap scripts or programmatically assembled paths. macOS/Linux enforce defined private filesystem boundaries; Windows retains host-user permissions. Do not claim universal source denial or credential isolation across platforms.

Implementation: [planner.ts](planner.ts), [compiler.rs](../src/compiler.rs), and [server.rs](../src/server.rs).
