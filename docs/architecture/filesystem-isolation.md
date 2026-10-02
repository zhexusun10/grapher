# Filesystem isolation and path mapping

**Use trusted projects, extensions, and tools.** Private Git state, filesystem access controls, and model-visible path adaptation are separate mechanisms. None is a general malicious-multi-tenant or credential-protection guarantee.

## Roles and permissions

| Role | Working directory | Tool policy |
| --- | --- | --- |
| Partitioner | Source project | Classification only; `pi-trim` only, no user extensions/MCP/skills or tools |
| Planner | Private project copy | `node`, `edge`, native `read`/`bash`, selected global extensions/MCP/skills |
| Serial agent | Source project | Pi tools and trusted skills/extensions |
| Graph node | Independent node repository | Pi tools with Graph path adaptation |
| Merger | Conflicted node workspace, Planner preview, or source project | Conflict-repair tools and `pi-trim`; no user extensions/MCP/skills or automatic context |

Planner and private Merger filesystem permissions follow the private-workspace platform policy below. A private Merger does not gain source/sibling access merely because it repairs conflicts. Its Bash is still Pi's native tool, not a read-only command filter. Successful Planner changes can be merged into the source before approval; Reject does not roll them back. See [Planning and approval](execution-model.md#planning-and-approval).

## Platform boundaries

### macOS

Private Planner and Graph executions use Seatbelt through `sandbox-exec`. The execution profile restricts ordinary access to the source, sibling workspaces, and other sessions while permitting its current workspace/session and required host resources. The shared engine copy is protected from writes.

### Linux

Private executions use bubblewrap. The host/task container must allow unprivileged user, mount, and PID namespaces plus required bind/proc mounts. Graph preflight fails closed; it does not replace a rejected Graph with an unisolated execution or test fixture.

The mount layout exposes the current private repository/session, masks source and unrelated workspace/data paths, and makes the shared engine and original installation read-only, including linked dependency targets. The container's `/dev` is explicitly mounted and `/dev/null` read/write is checked. Network access remains available for configured providers.

An outer Docker/Harbor container is **not** a substitute for these per-execution boundaries. See [Harbor requirements](../benchmarks/harbor.md#linux-task-environment).

On macOS/Linux, a workspace using Git alternates also has read access to the bound source's Git object database. Source working files and unrelated refs remain restricted, but object-store access can expose historical file contents and other stored snapshots. This is not a history-confidentiality boundary. The object database is protected from writes by private executions; see [workspace storage](execution-model.md#backend-git-storage).

### Windows

Private workspaces run stock Node, pinned Pi, and Git for Windows Bash with the host user's permissions. There is **no VM, per-node filesystem sandbox, custom isolation driver, or patched Node/MSYS binary**.

Processes may access the source, siblings, other sessions, engine files, HOME, and credentials where the host user can. Separate node workspaces and Git metadata isolate edits and inherited snapshots, not access rights. See the [Windows guide](../guides/windows.md).

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

The Planner uses native `read`/`bash` in its actual private cwd; do not assume Graph-node tool adaptation applies identically to it.

Model-visible normalization is not a byte-for-byte file representation or a data-loss-prevention system. Images, thinking content, provider signatures, unknown encodings, and extension channels are not universally sanitized. Perform exact byte processing inside programs rather than relying on normalized model-visible text.

## Shared runtime and external state

The backend prepares and verifies a shared Pi engine copy outside the source using [prepare-native-runtime.mjs](../../scripts/prepare-native-runtime.mjs). This permits self-hosted Graph execution without requiring write access to protected source engine files. Restart the backend after adapter changes; the prepared copy is cached and has no general automatic cleanup policy.

`GRAPHER_NATIVE_RUNTIME_PARENT` selects the runtime-copy parent. Pi authentication uses its dedicated configuration directory, not a per-node credential vault. Model tools may still read authentication material available to their process. Shared HOME, temporary files, hard links, services, and global configuration are outside Git node-version isolation.

## Process lifecycle

Unix uses process groups; Windows attaches suspended children to kill-on-close Job Objects before resuming them. Cancellation, timeout, and shutdown use these lifecycle mechanisms. A Job Object is not a filesystem access policy.

Tests cover specific descendant writers and interruption cases. They do not establish a universal barrier against detached descendants, arbitrary third-party services, shared host state, or every crash scenario.

## Validation

[Testing](../development/testing.md) separates fixtures, real Pi launcher checks, platform boundary tests, and real-model acceptance. Passing one category does not prove the others.

Implementation: [native.rs](../../backend/src/native.rs), [sandbox.rs](../../backend/src/sandbox.rs), [linux_sandbox.rs](../../backend/src/linux_sandbox.rs), [workspace-paths.mjs](../../engine/workspace-paths.mjs), [workspace-tools.ts](../../engine/workspace-tools.ts), and [prompt-extension.ts](../../engine/prompt-extension.ts).
