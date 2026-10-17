# Filesystem isolation and path mapping

> **Scope:** Actual role/platform permissions and path-mapping limits, not a future isolation proposal.
> **Maintained with:** [native.rs](../../backend/src/native.rs), [sandbox.rs](../../backend/src/sandbox.rs), [linux_sandbox.rs](../../backend/src/linux_sandbox.rs) and [native acceptance](../../scripts/windows-native.test.ts).

**Use trusted projects, extensions, and tools.** Private Git state, filesystem access controls, and model-visible path adaptation are separate mechanisms. None is a general malicious-multi-tenant or credential-protection guarantee.

[Native workspace environments](native-environments.md) add backend-owned business
entry/PATH/state and device binding inside these same boundaries, without a user
environment configuration surface. Native CUDA proofs are per execution, not
universal GPU acceptance. Job quotas/device locks do not add a Windows filesystem
sandbox, system snapshots or stronger cross-slot path/metadata guarantees.
Unsupported requirements are rejected without a user-selected fallback.

## Roles and permissions

| Role | Working directory | Access boundary |
| --- | --- | --- |
| Partitioner | Source project | Host-user process; classification has no tools |
| Planner | Source initially/after publication; selected current node worktree for follow-ups | Native Bash without write-command filtering; follows the selected workspace's platform/source policy |
| Serial agent | Source project | Host-user project access |
| Graph node | Current private Run repository | Platform policy below; path adaptation is not additional permission |
| Merger | Conflicted node workspace or source project | Follows that workspace's platform/source policy, without extra conflict-repair access |

Exact tool, extension, MCP, skill and context loading belongs to the [Pi role policy](../development/pi-integration.md#role-loading-policy).

Source-native Planner turns use host-user permissions and write the source immediately. Follow-ups in private node worktrees retain the platform boundaries below, without extra source/sibling access. There is no Bash write-command filter, and Reject, failure, and cancellation do not roll back writes in the selected directory. A Merger's permissions follow the policy for its selected workspace; conflict repair does not grant access to the source or sibling workspaces beyond that. See [Planning and approval](execution-model.md#planning-and-approval).

## Platform boundaries

### macOS

Private Graph executions, Planner turns and Mergers use Seatbelt through `sandbox-exec`. Source-native Planner turns use host-user permissions. The execution profile restricts ordinary access to the source, sibling workspaces, and other sessions while permitting its current workspace/session and required host resources. The shared engine copy is protected from writes.

### Linux

Private Graph executions, Planner turns and Mergers use bubblewrap. Source-native Planner execution does not use these private-workspace mounts. The host/task container must allow unprivileged user, mount, and PID namespaces plus required bind/proc mounts. Graph preflight fails closed; it does not replace a rejected Graph with an unisolated execution or test fixture.

The mount layout exposes the current private repository/session, masks source and unrelated workspace/data paths, and makes the shared engine and original installation read-only, including linked dependency targets. The container's `/dev` is explicitly mounted and `/dev/null` read/write is checked. Network access remains available for configured providers.

An outer Docker/Harbor container is **not** a substitute for these per-execution boundaries. See [Harbor requirements](../benchmarks/harbor.md#linux-task-environment).

On macOS/Linux, a workspace using Git alternates also has read access to the bound source's Git object database. Source working files and unrelated refs remain restricted, but object-store access can expose historical file contents and other stored snapshots. This is not a history-confidentiality boundary. The object database is protected from writes by private executions; see [workspace storage](workspace-snapshots-and-feedback.md#backend-git-storage).

### Windows

Private workspaces run stock Node, pinned Pi, and Git for Windows Bash with the host user's permissions. There is **no VM, per-node filesystem sandbox, custom isolation driver, or patched Node/MSYS binary**.

Processes may access the source, siblings, other sessions, engine files, HOME, and credentials where the host user can. Separate parallel workspaces, exclusive directory handoff, and private Git metadata organize edits and inherited snapshots, not access rights.

## Path convention

Use project-root-relative paths for tasks, handoffs, and generated configuration:

```text
src/app.ts
reports/result.json
```

Use real host absolute paths for external resources. Within a Graph node, relative paths resolve from its workspace. `cd` and `../` retain native shell semantics; `../shared` is not automatically redirected to a source-project sibling. Prepare a suitable directory layout or use an explicit external path.

## Graph tool adaptation

- `read`, `write`, and `edit` adapt recognized source-project path prefixes to the current node repository.
- No project or role registers separate `ls`, `find` or `grep` tools; listing and search run inside Bash with its own command adaptation.
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

Planner's `read`/`bash`/`write`/`edit` share Graph tool path adaptation and model-facing normalization, including source-native turns. Its physical cwd can change while the model keeps the same project-root-relative namespace (and stable source addresses for structured URIs). Existing prompt paths, tool results and conversation context are normalized. Each Planner follow-up receives a regenerated transport announcement for the selected node workspace and graph status; when an alternate exists, the follow-up-only `switch_workspace` tool is exposed. The rework explanation is included only on the first follow-up, and the browser removes this transport context from the displayed conversation. Physical worktree paths remain backend/session/UI metadata. Source/sibling access remains subject to the platform policy. See [Planner follow-up workspaces](execution-model.md#planner-follow-up-workspaces).

Model-visible normalization is not a byte-for-byte file representation or a data-loss-prevention system. Images, thinking content, provider signatures, unknown encodings, and extension channels are not universally sanitized. Perform exact byte processing inside programs rather than relying on normalized model-visible text.

## Inherited project resources

[Workspace inheritance](workspace-snapshots-and-feedback.md) does not expand source/sibling write permissions. The backend prepares inherited files and session forks before launching the private process; the platform boundaries above remain unchanged.

Internal directory links are rebased (Windows uses junctions); external directory links are rejected rather than granted broad access. External file targets remain subject to platform permissions. Source-local secrets can be copied as ordinary files: physical-directory inheritance is not a credential filter. Managed environment scopes have their own policy and evidence rules.

The [managed environment portability boundary](workspace-snapshots-and-feedback.md#managed-environment-boundary) and tool-mapping limits above apply to copied environments; copying is not a process namespace or stable-path volume.

## Shared runtime and external state

Private executions load a prepared shared engine copy prepared by [prepare-native-runtime.mjs](../../scripts/prepare-native-runtime.mjs), allowing self-hosting without source-engine write access. The copy holds engine/dependencies, not project snapshots or conversations. Cache paths, leases and reclamation belong to [Storage and cleanup](execution-model.md#storage-and-cleanup); role/process preparation belongs to [Pi prewarming](../development/pi-integration.md#prewarming-and-prepared-runtime).

Pi authentication uses its dedicated configuration directory, not a per-node credential vault. Model tools may read auth material available to their process. Shared HOME, temporary files, hard links, services and global configuration are outside Git node-version isolation.

## Process lifecycle

Unix uses process groups; Windows attaches suspended children to kill-on-close Job Objects before resuming them. Cancellation, timeout, and shutdown use these lifecycle mechanisms. A Job Object is not a filesystem access policy.

Tests cover specific descendant writers and interruption cases. They do not establish a universal barrier against detached descendants, arbitrary third-party services, shared host state, or every crash scenario.

Pinned Pi's Unix Bash launches in a detached session. Background processes left
in that session are outside Rust's original owner process group and are not
covered by its process-group drain check. Linux's private PID namespace may
still terminate them when the execution exits. The native environment drain
fixture uses a project-extension child in the owned Unix group or Windows Job;
a passing group check is not detection or cleanup evidence for detached Bash writers.

## Validation

[Testing](../development/testing.md) separates fixtures, real Pi launcher checks, platform boundary tests, and real-model acceptance. Passing one category does not prove the others.

Implementation: [native.rs](../../backend/src/native.rs), [sandbox.rs](../../backend/src/sandbox.rs), [linux_sandbox.rs](../../backend/src/linux_sandbox.rs), [workspace-paths.mjs](../../engine/workspace-paths.mjs), [workspace-tools.ts](../../engine/workspace-tools.ts), and [prompt-extension.ts](../../engine/prompt-extension.ts).
