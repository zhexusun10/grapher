# Planner inspection and workspace paths

Planner exposes exactly `node`, `edge`, `read`, and `bash` in addition to the graph compiler feedback returned by node/edge mutations.

`read` is repository-scoped. It accepts regular files, rejects repository traversal, symlinks, directories, and `.git` metadata, and retains the Pi read tool's offset/limit behavior.

`bash` uses Pi's native shell backend so Planner can inspect repository structure with ordinary read-only commands, pipelines, and variables. The Planner extension rejects commands containing explicit write operators or commands (`>`, `>>`, `touch`, `mkdir`, `rm`, `rmdir`, `mv`, `cp`, and `tee`) before execution. This is a planning guardrail, not a complete shell sandbox: it does not claim to recognize every program that could mutate state. Planner runs with no approval, no skills, and no automatically discovered extensions. Repository cleanliness is checked after planning by evaluation and normal product workflow boundaries.

Read-only access outside the repository is not hidden by the workspace adapter. This permits inspection of explicitly available host references, but graph tasks must remain self-contained and portable. External files are not automatically present in later isolated node workspaces.

Every role receives two host-owned roots:

- `GRAPHER_WORKSPACE_ROOT`: the physical checkout used by the current execution instance.
- `GRAPHER_ORIGINAL_ROOT`: the canonical source repository selected in the run configuration.

`workspace-paths.mjs` exposes the current checkout at `<original-parent>/workspace/<original-name>`. The same visible path maps to each node's private checkout, while Planner and Serial map it to the source repository. Context text, tool path arguments, shell commands, and tool results are translated per process; no mount or global symlink is created. Repository-relative paths remain preferred in graph tasks.
