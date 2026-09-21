# Planner tools and workspace paths

Planner exposes exactly `node`, `edge`, `read`, and `bash`, plus compiler feedback from graph mutations.

`node` accepts only a nonempty `nodes` array; `edge` accepts only a nonempty `edges` array. A single edit uses a length-one array. Top-level single-edit fields are rejected. Within a call, node names and ordered edge pairs must be unique, including identical repeats or delete-and-recreate edits. Duplicate diagnostics identify the array positions and target; the entire batch is rejected before applying edits or invoking the compiler. To replace a target, supply its final edit once. Each valid batch applies its edits in order and compiles once. A failed mutation leaves the saved graph unchanged.

```json
{"nodes":[{"name":"build","task":"Implement the requested change."}]}
```

```json
{"edges":[{"from":"build","to":"review"}]}
```

An edge batch may delete an old edge and add a different edge atomically. Only the resulting graph is compiled, so a temporary cycle during rewiring does not block a valid final graph. Opposite edge directions are different ordered pairs; dependency and feedback edits for the same direction are the same target.

`read` uses Pi's native implementation and description, including offset/limit behavior. `bash` uses Pi's native backend without write-command filtering or implicit errexit/pipefail. Planner has no automatic skills/extensions or project context files.

Planner runs as a host-native process at the selected source project's real absolute path. PATH, HOME, TMPDIR, external files and host-native executables remain available according to host permissions. Tools, commands, file contents and output are not rewritten. The host provides real, execution-specific graph/session paths and its own native graph compiler.

Planner writes affect source files immediately. Reject only rejects the plan and does not undo writes. The retained approval contract snapshots current source files before allocating node workspaces, including new nonignored files and uncommitted changes. This stages and commits user changes as well as Planner changes. A planner-generated single `task` graph stays Graph, using persisted routing.

Graph uses native Pi instances in private Git workspaces. File tools map source-project paths to the current workspace. Bash translates complete literal project paths, including common variable assignments and literal nested shell commands. New tasks and handoffs use project-root-relative paths; external resources use their real host absolute paths. Graph results render ordinary physical workspace paths as `./...`; structured URIs retain valid source-project addresses. Absolute project inputs remain a compatibility feature. Shell cd and ../ keep native semantics and do not select the source project's parent. Existing script files and programmatically assembled paths are not transparently remapped; direct source/sibling/session access remains denied by Seatbelt. See `engine/native-execution.md` for the supported contract and limitations. Baseline, parent snapshots and fresh sessions are retained.

See [the full native execution logic](../../engine/native-execution.md) for tested behavior and limits.
