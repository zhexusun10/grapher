# Filesystem isolation and path mapping

> **Scope:** Actual role/platform permissions and path-mapping limits, not a future isolation proposal.
> **Maintained with:** [native.rs](../../backend/src/native.rs), [sandbox.rs](../../backend/src/sandbox.rs), [linux_sandbox.rs](../../backend/src/linux_sandbox.rs) and [native acceptance](../../scripts/windows-native.test.ts).

**Use trusted projects, extensions, and tools.** Private Git state, filesystem access controls, and model-visible path adaptation are separate mechanisms. None is a general malicious-multi-tenant or credential-protection guarantee.

[Native environment controls](native-environments.md#native-resources) operate inside these access boundaries; quotas, device locks and computation proofs do not strengthen filesystem isolation.

## Roles and permissions

| Role | Working directory | Access boundary |
| --- | --- | --- |
| Partitioner | Source project | Host-user process; classification has no tools |
| Planner | Source initially/after publication; selected current node worktree for follow-ups | Native Bash without write-command filtering; follows the selected workspace's platform/source policy |
| Serial agent | Source project | Host-user project access |
| Graph Node Agent (private) | Current private Run repository | Platform policy below; path adaptation is not additional permission |
| Graph Node Agent (shared source) | Source project | Host-user project access; no per-node filesystem isolation |
| Merger | Conflicted node workspace or source project | Follows that workspace's platform/source policy, without extra conflict-repair access |

Exact tool, extension, MCP, skill and context loading belongs to the [Pi role policy](../development/pi-integration.md#role-loading-policy).

The [adaptive workspace policy](workspace-snapshots-and-feedback.md#adaptive-workspace-policy) selects shared-source versus private execution before launch; sharing is not a fallback for a failed private sandbox. Source-native Planner and shared Graph node turns use host-user permissions; private-workspace turns retain the platform boundaries below, without extra source/sibling access. A Merger gets no additional conflict-repair permissions. Tool availability and immediate-write/rollback behavior belong to [Planning and approval](execution-model.md#planning-and-approval).

## Platform boundaries

A denied path is reported to the model as a permission error rather than a
platform errno: macOS Seatbelt returns `EPERM`, while on Linux a masked read
looks like a missing file and a read-only write looks like a read-only
filesystem. The backend supplies the private execution's deny set to the engine
for this diagnostic only. It grants no access and does not change the platform
boundary.

### macOS

Private Graph executions, Planner turns and Mergers use Seatbelt through `sandbox-exec`. Source-native Planner turns use host-user permissions. The execution profile restricts ordinary access to the source, sibling workspaces, and other sessions while permitting its current workspace/session and required host resources. The shared engine copy and the original Grapher installation (the source checkout or packaged app) are protected from writes, so an execution cannot modify Grapher's own code or the cache it loads from.

### Linux

Private Graph executions, Planner turns and Mergers use bubblewrap. Source-native Planner execution does not use these private-workspace mounts. The host/task container must allow unprivileged user, mount, and PID namespaces plus required bind/proc mounts. Private Graph preflight fails closed; it does not replace a rejected Graph with an unisolated execution or test fixture.

The mount layout exposes the current private repository/session, masks source and unrelated workspace/data paths, and makes the shared engine and original installation read-only, including linked dependency targets. A masked directory is made unreadable rather than left empty, so listing or traversing it fails with a permission error instead of a silent empty listing. The container's `/dev` is explicitly mounted and `/dev/null` read/write is checked. Network access remains available for configured providers.

An outer Docker/Harbor container is **not** a substitute for these per-execution boundaries. See [Harbor requirements](../benchmarks/harbor.md#linux-task-environment).

New agent views have independent project Git and never borrow a graph-object
alternate. Backend graph Git may still use alternates, but those control paths
are not agent write allowances. Unix profiles expose the current project's files, session and exact external
process-state root. A switching Planner additionally receives only the explicit
same-Run workspace/state targets authorized by the backend at launch, not all
siblings or the whole cache/run parent. Changing cwd cannot raise OS privileges. Source history intentionally present in project Git is
not confidential; see [workspace storage](workspace-snapshots-and-feedback.md#backend-git-storage).

### Windows

Private workspaces run stock Node, pinned Pi, and Git for Windows Bash with the host user's permissions. There is **no VM, per-node filesystem sandbox, custom isolation driver, or patched Node/MSYS binary**.

Processes may access the source, siblings, other sessions, engine files, HOME, and credentials where the host user can. Separate parallel workspaces, exclusive directory handoff, independent project
Git and external graph/process state organize edits and inherited snapshots,
not access rights. Moving HOME or caches outside the project does not make those
paths inaccessible to the host user.

## Project-view launch gate

Every private native role needs recorded source-equivalent preparation, not just
a directory containing some `.git`. Source-native roles do not add runtime/session
data to the project either. A layout that places runtime data inside the source
is refused with an external-data-root diagnostic; existing records are not moved
or deleted. Missing/corrupt view evidence and unsupported source features fail
before agent launch, rather than switching to the live source or filtering tool
output. The precise project/Git contract and capability gaps belong to
[Agent project views](workspace-snapshots-and-feedback.md#agent-project-views).

## Path convention

Serial is a separate source-native agent, not a Graph Node Agent running at a different cwd. It keeps the ordinary source-project Pi prompt and native Pi Bash; Graph Node Agents use Grapher's workspace adapters and receive the relative-path convention.

Use project-root-relative paths for tasks, handoffs, and generated configuration:

```text
src/app.ts
reports/result.json
```

Use real host absolute paths for external resources. Within a Graph node, relative paths resolve from its workspace. `cd` and `../` retain native shell semantics; `../shared` is not automatically redirected to a source-project sibling. Prepare a suitable directory layout or use an explicit external path.

Model-visible paths use `/` separators on every host, including Windows, so the same relative path works in Bash and the file tools. Windows drive, UNC, `/c/...`, extended-length and case variants are accepted at tool boundaries and normalized for comparison. Plain filesystem paths inside heredoc bodies and paths inside remote/container commands are intentionally not rewritten (known `file://` URLs are still translated); use project-relative paths there or an explicit external path.

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

Planner's `read`/`bash` (and mounted `write`/`edit`) share Graph tool adaptation, including source-native turns. Across cwd changes the model retains a stable project-root-relative namespace and source addresses for structured URIs; existing prompt paths, tool results and conversation context are normalized. Physical paths remain backend/session/UI metadata, and source/sibling access remains subject to platform policy. Workspace selection, transport announcements and `switch_workspace` availability belong to [Planner follow-up workspaces](execution-model.md#planner-follow-up-workspaces).

Model-visible normalization is not a byte-for-byte file representation or a data-loss-prevention system. Images, thinking content, provider signatures, unknown encodings, and extension channels are not universally sanitized. Perform exact byte processing inside programs rather than relying on normalized model-visible text.

## Inherited project resources

[Workspace inheritance](workspace-snapshots-and-feedback.md) does not expand source/sibling write permissions. The backend prepares inherited files and session forks before launching the private process; the platform boundaries above remain unchanged.

Internal directory links are rebased. External targets remain subject to platform permissions. Source-local secrets can be copied as ordinary files: physical-directory inheritance is not a credential filter. Managed environment scopes have their own policy and evidence rules.

Managed snapshot metadata and copy limitations belong to [Native environments](native-environments.md#branches-metadata-and-storage); copying is not a process namespace or stable-path volume.

## Shared runtime and external state

Private executions load the shared engine copy from [prepare-native-runtime.mjs](../../scripts/prepare-native-runtime.mjs), allowing self-hosting without source-engine write access. Cache paths, contents, leases and reclamation belong to [Storage and cleanup](storage.md#shared-pi-runtime-cache); role/process preparation belongs to [Pi prewarming](../development/pi-integration.md#prewarming-and-prepared-runtime).

Pi authentication uses its dedicated configuration directory, not a per-node credential vault. Model tools may read auth material available to their process. Shared HOME, temporary files, hard links, services and global configuration are outside Git node-version isolation.

Environment exposure is separate from path mapping. Grapher's custom Bash adapters for Graph nodes, Planner and Merger remove Grapher variables (`GRAPHER_*`, including `GRAPHER_NODE_NAME`), Pi session/credential path variables and selected path-free editor breadcrumbs. They retain inherited Bash startup/option variables (`BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `CDPATH`, `OLDPWD`, `GLOBIGNORE`) and ordinary `PATH`; an explicitly bound native environment still supplies its declared complete `PATH`. When a safe Run-cache scratch exists, `TMPDIR`/`TMP`/`TEMP`/`XDG_RUNTIME_DIR` point there instead of the session directory under `data/`. Without one, safe inherited temporary paths are retained and only paths into private `data/` are removed. Bash scrubbing retains ordinary non-Grapher variables that reached the Pi host, including Git credential-helper bindings needed by host Git; it is not an allowlist or credential filter. New automatic native admission also preserves ordinary business variables; legacy explicit policies retain their recorded inheritance restrictions. Runtime/engine identity remains excluded; Node startup settings are deferred to business children rather than the trusted host. Private HOME/cache bindings still differ from source. See the [native launch contract](native-environments.md#admission-and-configuration) for those exceptions. OS plumbing and the Run-state HOME/cache bindings remain. Serial uses Pi's native Bash tool without Grapher's Bash adapter. The Pi host and its loaded extensions still receive internal control variables required by the runtime, but `GRAPHER_NODE_NAME` is removed from their launch environment, including inherited outer values. This removes selected environment breadcrumbs only; it is not an access boundary, and a variable the host shell itself re-injects is left alone. See the [launch binding](../../engine/launch-binding.mjs).

## Bash compatibility review

Bash here is a command tool, not a terminal session. Pi resolves a Bash executable and starts a fresh non-interactive `bash -c` process for each call (the legacy WSL launcher uses stdin transport). Login/interactive startup files, terminal job control and shell state are therefore not the host terminal's behavior; `BASH_ENV` is still honored. A command's `cd`, exports, aliases and functions do not persist into the next call. This is an intentional and reasonable tool boundary, not an attempt to emulate an interactive terminal. Serial keeps Pi's built-in Bash tool and operations; Graph Node Agent's adapter preserves the same execution model while adding Grapher policy.

The remaining differences have been reviewed as follows:

| Difference from an ordinary host shell | Scope | Review |
| --- | --- | --- |
| `BASH_ENV` is honored; afterwards the selected execution cwd is restored using the Bash/Zsh builtin or a POSIX-shell fallback before PATH conversion and business commands/hooks. | Non-Serial Grapher Bash adapter calls (including source-direct Graph Node turns) and managed activation hooks | Keeps startup variables, functions and options while preventing a startup script's `cd` from redirecting relative tool/hook paths. Startup-script side effects have already happened, and nested shells can source `BASH_ENV` again; this is not a sandbox. |
| Pi adds its own executable bin directory to `PATH`; a managed native environment restores its declared PATH inside Bash after startup (including undoing Git Bash/MSYS host-bin injection). | All Pi Bash; declared managed environments | Pi needs its bundled tools. Restoring a declared PATH is required for environment reproducibility and to prevent accidental host-bin selection. Source-native roles do not get a managed PATH binding. |
| Inherited `NODE_OPTIONS`/`NODE_PATH` are supplied to business Bash/result children, not to the trusted engine, hook capture or factories. | New automatic managed launches | Keeps ordinary Node memory/preload/module settings without injecting project code into Grapher startup. Project-root `NODE_PATH` entries follow the selected workspace; opaque option strings are not rewritten. |
| `PYTHONDONTWRITEBYTECODE=1`; host Git override variables such as `GIT_DIR` and `GIT_INDEX_FILE` are cleared at process launch. | All managed executions | Accepted: avoid Python bytecode entering project changes and prevent an ambient Git override from redirecting commands away from the bound repository. Git's normal host config and credentials remain available unless a role explicitly binds workspace config. |
| Grapher control variables, Pi session/credential paths and selected editor breadcrumbs are removed from adapter Bash environments; this is selective scrubbing, not a general environment allowlist. | Graph Node, Planner, Merger adapters; not Serial's Bash adapter | Accepted to avoid exposing internal paths and control metadata. Ordinary variables and host credential-helper bindings are retained; this is not a credential security boundary. |
| HOME, caches, Conda paths and temporary directories may be rebound to the workspace's external Run state/cache. | Private Graph/Planner/Merger roles; not source-native Serial or source-direct Graph Node temp bindings | Accepted isolation and cleanup policy. Source-native agents keep host temporary bindings. |
| Supported project-path literals, tool inputs/results and prompts may be mapped to the active Graph workspace. Arbitrary paths constructed inside scripts, heredocs or remote commands are not transparently remapped. | Graph Node and Planner adapters | Accepted finite model-facing namespace; it is not kernel-level path virtualization. Platform permissions remain authoritative. |
| During native-environment discovery, `python`, `python3`, `pip`, `pip3` and `conda` executables may be wrapped in shell functions that invoke a recorder. | Only when discovery is explicitly active | Existing functions (including readonly wrappers) and aliases are preserved, not replaced. Calls through those wrappers may remain unobserved/unbound; provenance instrumentation must not change their business behavior. |
| stdout and stderr are collected into the tool result, output may be truncated, and timeout/abort kills the command process tree. | Every Bash tool call | Accepted model-tool transport/lifecycle behavior; unlike a host terminal, the tool is not an interactive stream or unrestricted background-job supervisor. |

No other Bash startup option is injected: Grapher does not add `set -e` or `pipefail`. A source-direct Graph Node Agent still uses the Grapher adapter for identity/path policy, so it is not identical to Serial's Pi-native tool environment; the reviewed adapter differences above remain, but it keeps host temp bindings and ordinary PATH. Tests cover the source-direct temp exception, preserved shell controls, managed PATH, selected-workspace cwd restoration after `BASH_ENV`, and the intentional private-environment differences.

## Process lifecycle

Unix uses process groups; Windows attaches suspended children to kill-on-close Job Objects before resuming them. Cancellation, timeout, and shutdown use these lifecycle mechanisms. A Job Object is not a filesystem access policy. Linux checks live process/thread states in `/proc` when a group still exists: with complete membership visibility, two stable zombie-only snapshots can drain even when a container init has not reaped the processes. A zombie leader with live threads still blocks handoff; restricted `/proc` visibility or unreadable process evidence does not authorize sealing.

Tests cover specific descendant writers and interruption cases. They do not establish a universal barrier against detached descendants, arbitrary third-party services, shared host state, or every crash scenario.

Before a managed snapshot/handoff the owning process first waits a bounded grace
for its lifecycle boundary to drain on its own, so a short-lived helper can
finish while the node stays `running`. Only a writer still alive after that
window is terminated, followed by a bounded drain confirmation; a completed turn
is therefore not failed while a killable descendant is still alive. Only a
descendant that escaped the boundary still refuses the seal. The observe-only
drain check used by tests does not terminate.

Pinned Pi's Unix Bash launches in a detached session. Background processes left
in that session are outside Rust's original owner process group and are not
covered by its process-group drain check. Linux's private PID namespace may
still terminate them when the execution exits. The native environment drain
fixture uses a project-extension child in the owned Unix group or Windows Job;
a passing group check is not detection or cleanup evidence for detached Bash writers.

### Parked Serial shells and held Planner services

A successful **Serial** turn stays resident. It **parks** its whole lifecycle
boundary — the Pi process, its stdin/stdout channels and the tracked
`ProcessTree` — in a backend-owned pool and re-keys it from the execution owner
to `linger:<repository>:<session>`, instead of terminating it. The next turn of
the same conversation **claims** a parked boundary with matching model and
thinking settings and runs on the same process, so the conversation and any
service it started (for example a dev server) stay alive. A dead or mismatched
entry is retired and that turn cold-launches the persisted session instead;
retirement stops the shell and any services it owns.

A **Planner worker is never parked**: its launch binding is per planning attempt
(`GRAPHER_GRAPH_PATH` is `graph-{planningId}.json`), so reusing a Planner could
mutate the previous attempt's graph. After a successful settled Planner reply
whose cwd is the bound source, Grapher reassigns that worker's process-tree
boundary to a Run-scoped service owner after closing the Pi worker and RPC
channels. It does not reuse the old Planner process; the next attempt
cold-launches with its own graph binding while any child still attached to the
held boundary can keep running (for example `npm run dev`). Output readers keep
draining inherited stdout/stderr after the turn's receiver closes, so continuing
to log does not break the service's pipes; those later bytes are discarded.

Only source-root Planner descendants are held. Private-workspace/managed
Planner turns and Graph Node Agents are reclaimed at turn end. Held services
have no idle TTL: they remain until Run/workspace deletion, workspace reset,
clearing history, or backend shutdown. A completed Run does not own their process boundary, so
normal Run completion cannot terminate them. Unix Pi Bash can launch detached
sessions outside the tracked process group; those escaped descendants cannot
be retained or cleaned up reliably by this process-tree mechanism.

Because a parked Serial boundary no longer answers `terminate_node`/`terminate_owner`
for the execution that created it, invalidating or retrying that turn cannot
kill the resident shell. Retained Planner services similarly have a separate
owner, but no live Planner worker or RPC session. `terminate_all()` (backend
shutdown) and explicit cleanup reclaim both. The lifecycle guard terminates a
boundary only when it is the **last owner**, so a boundary kept by either
registry is not torn down when the turn's guard drops.

A Serial shell or retained Planner service boundary has **no idle TTL and no
browser-owned deadline**. Workspace reset, history clearing, Run/workspace
deletion and backend shutdown reclaim both. History edits and incompatible
model/thinking selections additionally retire Serial shells. There is no
capacity eviction, so a long-lived backend can accumulate one parked shell per
Serial conversation and one held process boundary per source Planner reply
that leaves live descendants; this is bounded only by user activity.

Only settled Serial turns park the Pi worker. Planner service retention carries
no Planner session or snapshot obligation, so the drain-before-seal rule for
Graph turns is unchanged. Holding a process boundary is not a filesystem access
policy and does not widen what a process may reach.

## Validation

[Testing](../development/testing.md) lists fixture, Pi launcher, and platform-boundary checks. Validate permission changes on the affected platform.

Implementation: [native.rs](../../backend/src/native.rs), [sandbox.rs](../../backend/src/sandbox.rs), [linux_sandbox.rs](../../backend/src/linux_sandbox.rs), [workspace-paths.mjs](../../engine/workspace-paths.mjs), [workspace-tools.ts](../../engine/workspace-tools.ts), [launch-binding.mjs](../../engine/launch-binding.mjs), and [prompt-extension.ts](../../engine/prompt-extension.ts).
