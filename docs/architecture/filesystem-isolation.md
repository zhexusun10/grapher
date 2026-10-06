# Filesystem isolation and path mapping

**Use trusted projects, extensions, and tools.** Private Git state, filesystem access controls, and model-visible path adaptation are separate mechanisms. None is a general malicious-multi-tenant or credential-protection guarantee.

## Roles and permissions

| Role | Working directory | Tool policy |
| --- | --- | --- |
| Partitioner | Source project | Classification only; `pi-trim` only, no user extensions/MCP/skills or tools |
| Planner | Source project | `node`, `edge`, native `read`/`bash`, selected global extensions/MCP/skills |
| Serial agent | Source project | Pi tools and trusted skills/extensions |
| Graph node | Private Run repository with one active writer; ordinary dependencies and applied feedback may hand off a completed directory | Pi tools with Graph path adaptation |
| Merger | Conflicted node workspace or source project | Conflict-repair tools and `pi-trim`; no user extensions/MCP/skills or automatic context |

Planner runs with source-native permissions, without a write-command filter or private-workspace source boundary. Its Bash writes affect the source immediately; Reject, failure, and cancellation do not roll them back. Private Merger filesystem permissions follow the platform policy below; conflict repair does not grant source/sibling access. See [Planning and approval](execution-model.md#planning-and-approval).

## Platform boundaries

### macOS

Private Graph executions and Mergers use Seatbelt through `sandbox-exec`. Planner executes directly in the source with host-user permissions. The execution profile restricts ordinary access to the source, sibling workspaces, and other sessions while permitting its current workspace/session and required host resources. The shared engine copy is protected from writes.

### Linux

Private Graph executions and Mergers use bubblewrap. Source-native Planner execution does not use these private-workspace mounts. The host/task container must allow unprivileged user, mount, and PID namespaces plus required bind/proc mounts. Graph preflight fails closed; it does not replace a rejected Graph with an unisolated execution or test fixture.

The mount layout exposes the current private repository/session, masks source and unrelated workspace/data paths, and makes the shared engine and original installation read-only, including linked dependency targets. The container's `/dev` is explicitly mounted and `/dev/null` read/write is checked. Network access remains available for configured providers.

An outer Docker/Harbor container is **not** a substitute for these per-execution boundaries. See [Harbor requirements](../benchmarks/harbor.md#linux-task-environment).

On macOS/Linux, a workspace using Git alternates also has read access to the bound source's Git object database. Source working files and unrelated refs remain restricted, but object-store access can expose historical file contents and other stored snapshots. This is not a history-confidentiality boundary. The object database is protected from writes by private executions; see [workspace storage](execution-model.md#backend-git-storage).

### Windows

Private workspaces run stock Node, pinned Pi, and Git for Windows Bash with the host user's permissions. There is **no VM, per-node filesystem sandbox, custom isolation driver, or patched Node/MSYS binary**.

Processes may access the source, siblings, other sessions, engine files, HOME, and credentials where the host user can. Separate parallel workspaces, exclusive directory handoff, and private Git metadata organize edits and inherited snapshots, not access rights. See the [Windows guide](../guides/windows.md).

## Path convention

Use project-root-relative paths for tasks, handoffs, and generated configuration:

```text
src/app.ts
reports/result.json
```

Use real host absolute paths for external resources. Within a Graph node, relative paths resolve from its workspace. `cd` and `../` retain native shell semantics; `../shared` is not automatically redirected to a source-project sibling. Prepare a suitable directory layout or use an explicit external path.

## Graph tool adaptation

- `read`, `write`, `edit`, `ls`, `find`, and `grep` adapt recognized source-project path prefixes to the current node repository.
- Graph Bash adapts recognized complete project-path literals: common arguments, assignments, options, escaped spaces, redirects, glob patterns, command substitutions, and literal nested `sh/bash/zsh/dash -c` commands.
- Bash does not implicitly enable `set -e` or `pipefail` or change the caller's argument object.
- File write content, edit replacement content, and existing script files are not rewritten.
- Ordinary physical node paths in model-visible results are normalized to `.` or `./...`; structured file URLs/URIs retain valid source-project addresses.

| Example | Behavior in a Graph node |
| --- | --- |
| `read('/project/config.json')` | Recognized project path selects the node file |
| `cat /project/config.json` | Recognized literal is adapted before execution |
| `p='/project'; cat "$p/config.json"` | Recognized complete path assignment is adapted |
| `sh -c 'cat /project/config.json'` | Literal nested command adaptation is supported |
| External script using cwd/relative paths | Works from the node's actual cwd |
| Script hardcoding the source path internally | Not transparently remapped |
| Program assembling an absolute source path at runtime | Not transparently remapped |

This is finite tool/text adaptation, **not kernel-level transparent remapping for arbitrary programs**. On macOS/Linux, unsupported direct source access may be denied; on Windows it may access the real source under host permissions. Do not relax source permissions to hide a mapping failure.

The Planner uses native `read`/`bash` in the actual source cwd. Paths are not adapted to a private copy, and writes are not blocked by Graph-node source boundaries.

Model-visible normalization is not a byte-for-byte file representation or a data-loss-prevention system. Images, thinking content, provider signatures, unknown encodings, and extension channels are not universally sanitized. Perform exact byte processing inside programs rather than relying on normalized model-visible text.

## Inherited project resources

Ordinary dependencies and applied feedback use the same project-state channels: Git snapshots plus separately recorded ignored files. A linear ordinary chain can pass one completed directory between writers; applied feedback transfers the sender's completed directory to its target. Fan-out materializes independent writable state for concurrent branches, and fan-in composes recorded inputs in an available directory. Neither inheritance route assigns an active writer's directory to a second execution or requires additional sibling-write permissions; the platform access boundaries above remain unchanged. The backend prepares state and any required session-history forks before launching the private process, so macOS/Linux executors do not need new source/sibling write permissions.

Runtime/Git internals are excluded. Internal directory links are rebased to the destination (Windows uses junctions); external directory links are rejected rather than copied or granted broad access. External file links still need their targets permitted by the existing platform policy. Source-local ignored secrets are project files too; inheritance is not a credential filter.

Copied `.venv` files can reuse installed packages when invoked through the current workspace's interpreter, but activation/launcher paths and code-internal absolute paths are not transparently relocated. A copied environment is not a process-level namespace or a stable-path shared volume. Use relative resource paths and the current interpreter; the path-adapter limitations above still apply.

## Shared runtime and external state

Partitioner and Planner launch the installed entrypoint directly in the source cwd; their launchers do not create project copies or require a private engine copy. Graph preflight/startup may separately prewarm one shared Pi engine/dependency copy for later private node execution using [prepare-native-runtime.mjs](../../scripts/prepare-native-runtime.mjs). This is a content-keyed cache shared across workspaces and backend processes, not a Partitioner/Planner project workspace, and permits self-hosted Graph execution without write access to protected source engine files. Restart after adapter changes. Shared reader leases, preparation-failure removal, persistent reuse and obsolete-copy recovery follow the [runtime cleanup lifecycle](execution-model.md#storage-and-cleanup).

The runtime-copy parent defaults to the OS cache's `workspaces/.grapher-workspaces/` (Windows: `%LOCALAPPDATA%\Grapher\workspaces\.grapher-workspaces`). `GRAPHER_NATIVE_RUNTIME_PARENT` overrides it. Pi authentication uses its dedicated configuration directory, not a per-node credential vault. Model tools may still read authentication material available to their process. Shared HOME, temporary files, hard links, services, and global configuration are outside Git node-version isolation.

## Process lifecycle

Unix uses process groups; Windows attaches suspended children to kill-on-close Job Objects before resuming them. Cancellation, timeout, and shutdown use these lifecycle mechanisms. A Job Object is not a filesystem access policy.

Tests cover specific descendant writers and interruption cases. They do not establish a universal barrier against detached descendants, arbitrary third-party services, shared host state, or every crash scenario.

## Validation

[Testing](../development/testing.md) separates fixtures, real Pi launcher checks, platform boundary tests, and real-model acceptance. Passing one category does not prove the others.

Implementation: [native.rs](../../backend/src/native.rs), [sandbox.rs](../../backend/src/sandbox.rs), [linux_sandbox.rs](../../backend/src/linux_sandbox.rs), [workspace-paths.mjs](../../engine/workspace-paths.mjs), [workspace-tools.ts](../../engine/workspace-tools.ts), and [prompt-extension.ts](../../engine/prompt-extension.ts).
