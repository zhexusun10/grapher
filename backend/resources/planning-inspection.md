# Planner inspection and workspace paths

Planner exposes exactly `node`, `edge`, `read`, and `bash` in addition to the graph compiler feedback returned by node/edge mutations.

`read` uses Pi's native implementation and description, including offset/limit behavior. Grapher adds no repository-scope, symlink, or Git metadata restriction.

`bash` uses Pi's native shell backend without write-command filtering. Planner runs with no approval, no skills, and no automatically discovered extensions.

Planner runs directly in the source repository. File changes take effect immediately and are not automatically backed up or reverted. Reject only rejects the plan; it does not undo file changes or other side effects. Approve likewise leaves existing changes in place.

Access outside the repository is not blocked by the workspace adapter. Virtual paths are translated by replacing their root prefix, leaving `..` and symlinks to the filesystem; this mapping is not an access-control boundary. This permits inspection of explicitly available host references, but graph tasks must remain self-contained and portable. External files are not automatically present in later isolated node workspaces.

Every role receives two host-owned roots:

- `GRAPHER_WORKSPACE_ROOT`: the physical checkout used by the current execution instance.
- `GRAPHER_ORIGINAL_ROOT`: the canonical source repository selected in the run configuration.

`workspace-paths.mjs` exposes the current checkout at `<original-parent>/workspace/<original-name>`. The same visible path maps to each node's private checkout, while Planner and Serial map it to the source repository. Context text, tool path arguments, shell commands, and tool results are translated per process; no mount or global symlink is created. Repository-relative paths remain preferred in graph tasks.
