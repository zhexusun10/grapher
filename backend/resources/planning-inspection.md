# Planner tools and workspace paths

Planner exposes exactly `node`, `edge`, `read`, and `bash`, plus compiler feedback from graph mutations.

`read` uses Pi's native implementation and description, including offset/limit behavior. `bash` uses Pi's native backend without write-command filtering or implicit errexit/pipefail. Planner has no automatic skills/extensions or project context files.

Planner runs as a host-native process at the selected source project's real absolute path. PATH, HOME, TMPDIR, external files and host-native executables remain available according to host permissions. Tools, commands, file contents and output are not rewritten. The host provides real, execution-specific graph/session paths and its own native graph compiler.

Planner writes affect source files immediately. Reject only rejects the plan and does not undo writes. The retained approval contract snapshots current source files before allocating node workspaces, including new nonignored files and uncommitted changes. This stages and commits user changes as well as Planner changes. A planner-generated single `task` graph stays Graph, using persisted routing.

Graph uses native Pi instances in private Git workspaces. File tools map source-project paths to the current workspace. Bash translates complete literal project paths, including common variable assignments and literal nested shell commands. Model-facing results normalize the current physical workspace prefix to the source-project prefix. Existing script files and programmatically assembled paths are not transparently remapped; direct source/sibling/session access remains denied by Seatbelt. See `engine/native-execution.md` for the supported contract and limitations. Baseline, parent snapshots and fresh sessions are retained.

See [the full native execution logic](../../engine/native-execution.md) for tested behavior and limits.
