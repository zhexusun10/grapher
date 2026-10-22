# Native workspace environment control

> **Maturity:** experimental; full native acceptance remains open.
> **Scope:** Backend-owned environment admission, Graph node environment snapshots and launch bindings, native resource controls and model-free result execution. No VM, WSL, container fallback, new allocator or maintenance Agent.
> **Maintained with:** [automatic admission](../../backend/src/environment_automatic.rs), [tool observations](../../backend/src/environment_discovery.rs), [environment state](../../backend/src/environment.rs), [resources](../../backend/src/environment_resources.rs), [runtime](../../backend/src/runtime.rs), [launch binding](../../engine/launch-binding.mjs), [state tests](../../backend/src/environment_tests.rs) and [native acceptance](../../scripts/environment-native.test.ts).

This page owns managed state outside project Git. [Workspace allocation](workspace-snapshots-and-feedback.md#physical-workspaces-and-ownership), [publication phases](execution-model.md#final-publication) and [platform permissions](filesystem-isolation.md#platform-boundaries) remain separate contracts. Capability limitations and acceptance gaps are listed at the end.

## Terms and stored references

| Term | Meaning |
| --- | --- |
| W | Current physical project directory; ownership follows Runtime's allocator, not a permanent node identity. |
| S | External process-state root for a current slot: `<run>/.grapher-state/<slot-digest>/process/`, never inside W. |
| D | `Domain`: platform, architecture, baseline, policy, and execution-contract identity. |
| E / `environmentRef` | Immutable managed-environment filesystem snapshot, separate from project Git files. |
| L / `launchRef` | Versioned `LaunchConfig`: business entry, PATH, variables, hooks, and verified binding metadata; inherited credentials are named, not stored as values. |
| `codeRef` | Host-only Git reference for the recorded project-code state. It is not written into the user's branch or object database. |

[Domain, LaunchConfig, and CompositeResult](../../backend/src/environment.rs) define the stored shapes. E/L are evidence and launch inputs, not additional user-selectable modes.

## Admission and configuration

Runtime admits environments from native tool evidence. Settings exposes no environment mode, policy JSON, device selector or relocation assertion. Ambiguity/missing capabilities produce diagnostics, not a request to choose an authoritative parent or CPU/OS fallback. Graph approval, result entry selection and arguments are business controls, not environment policy.

Graph approval without an already frozen environment policy records
`EnvironmentPolicyRequested`. After Planner's existing source writes, Rust resolves
the current workspace execution contract at approval; the contract is backend-owned
and not a user environment choice:

- Standard Git Graph projects start with **no business environment binding**
  (`automatic-lazy`), irrespective of language or ML declarations. No venv,
  package installation or environment import occurs at admission. Trusted native
  Node/Git/Bash and available bootstrap tool hashes are frozen; private HOME and
  excluded caches are ownership boundaries, not precreated environments. New
  automatic policies use `{state}` (S), not `{workspace}` (W), for HOME, cache and
  provisioned prefixes. `native-workspace-v4` is the production contract; older
  workspace contracts are not execution inputs. Start a new Run rather than
  migrating/relocating an old workspace. No SQLite/data migration, service stop
  or destructive legacy cleanup is implied. A project that never needs an environment can complete and launch results while
  remaining unbound. Serial/shadow projects retain their source-native contract.
- Ordinary business tasks may create, install into, activate and switch between
  whatever native Python/Conda environments their Bash process can access.
  For the active workspace, the adapter does not reject an ambient interpreter,
  rewrite Conda names, forbid package installation destinations, or turn a
  temporary activation into a Runtime failure. The OS sandbox/permissions and
  the command's own exit status still apply. Runtime records receipts only when
  a private project-owned environment can be verified; external use is recorded
  as unbound business execution. No task-text parser, extra binding message or maintenance Agent is involved.
- After drain, Runtime tries to identify a unique private candidate's ownership,
  native metadata, actual interpreter prefix and ABI/library-byte evidence, then
  versions L and captures E separately. The current workspace policy treats
  project Python/version declarations as business inputs, not startup/binding
  gates or proof of package compatibility. `.env`, `environment.yml` and
  temporary activation/exports alone do not bind anything. Multiple candidates,
  external prefixes and unverified switches fall back to an unbound launch rather
  than blocking the node. Metadata inventory remains bounded and is used only to
  retain managed-scope evidence, not to adopt an environment by directory name.
- Binding is an execution/workspace property, not an execution-label distinction. Reuse and fan-in follow [Branches, metadata and storage](#branches-metadata-and-storage).

`environmentPolicy` is present in full/metadata projections and checkpoints.
The current workspace contract is frozen for the execution, while verified E/L and
private prefix scopes evolve through immutable composite references. Retry cannot
replace that contract; a workspace that falls back to unbound remains runnable and
records that decision. Draft/model-setting changes cannot override it.

Persisted compatibility records retain their recorded ownership/offline contract for replay and recovery only, not as another admission mode. Lazy discovery is limited to supported native tool adapters; [capability gaps](#capabilities-not-implemented-or-accepted) are not admission promises.

The internal policy fixes platform/architecture, baseline, initial
managed-environment scopes, rebuildable caches, layout and discovery rules. A verified
binding adds its private prefix to the current workspace scopes through versioned L,
not by editing the policy. Traversal, overlapping paths, Runtime metadata and
tracked-file conflicts fail. Windows case aliases and reserved names are checked.

The default entry directory is first in the complete business PATH. Trusted
engine Node and the bootstrap Git used for Pi build and dependency verification
are resolved independently, before that binding. Pi PATH processing and Windows MSYS
startup cannot add host bins; managed Bash resets PATH inside Bash. Hooks run
before extension/MCP factories and cannot change Runtime/Pi identity, Node
bootstrap or the default entry. Loader variables enter inside the established
native boundary, not outer bubblewrap/Seatbelt. One-shot exports cannot rebind a
later tool call.

Credentials are transient values injected by authorized name, not serialized
into L. No secret values belong in literal policy variables, hooks, arguments or
managed trees. Arbitrary business files are not automatically scrubbed for
secrets. Existing [native permission limits](filesystem-isolation.md) apply.

## Current state, historical evidence and ownership

The existing allocator determines W. Environment control neither assigns new
node slots nor serializes the whole graph. Linear dependencies hand off the same
physical directory. A continuation of A in the unique terminal tree uses that
tree's **current** code/resources/E/L and A's conversation, not A0's environment. Physical handoff eligibility remains governed by the workspace allocator.

Successful execution fixes a composite input/result:

```text
D + codeRef + environmentRef + launchRef + resourceRefs
  + physical layout + writer generation + selected inputs
```

Immutable E snapshots and L records are retained under
`<data>/environments/<run>/`. Completion advances lineage current aliases in the
same SQLite transaction as completion/queued feedback; historical executions
stay unchanged. E/L changes count even when the Git head is unchanged.

Environment manifests and persisted E/L records remain readable for replay and
recovery. Missing or damaged records fail when that evidence is explicitly needed;
they do not resurrect an obsolete workspace or turn an unrelated current execution
into an environment-selection workflow. Byte content is verified, not trusted only
from size/mtime. Event-actor reference/manifest checks stay metadata-only; native
writer byte/ABI checks and managed publication preflight run outside the Run mutex.
Verification does not save new blobs or repair missing history from a live directory.

A failed database commit may leave unreferenced storage but never a completion
referring to an incomplete seal. A missing current workspace view is rebuilt only
from the current managed composite when the result contract requires it.
Environment evidence alone does not reconstruct ordinary project files; those
follow the [Git workspace contract](workspace-snapshots-and-feedback.md#cleanup-and-reproducibility).

Environment evidence participates in [feedback generation/drain checks](runtime.md#bounded-feedback) and [pinned workspace handoff](workspace-snapshots-and-feedback.md#feedback-and-history-edits). Failed and pending-feedback views are not opportunistically reclaimed. Managed layouts and snapshots remain until explicit conversation deletion; bounded long-term retention/reference GC is not implemented.

## Branches, metadata and storage

Private Planner switching rebinds the process cwd and the backend-provided
HOME/cache/project-Git environment together; direct filesystem APIs and Bash do
not keep using the previous slot. Planner uses host tools, not another node's
activation hook. Every visited slot is recovered from durable selection events
and captured after the Planner process tree drains (or by a still-running node's
own completion). `PlannerWorkspaceSnapshotted` advances code and E/L atomically,
including state-only writes, under a distinct writer generation. Its optional
composite result preserves replay of older code-only events. Only the final cwd
is a UI selection; it is not the inventory of state needing capture.

A verified fixed-layout environment is reused only at the current physical
workspace. When environment reuse is not possible, Runtime leaves the current workspace's
business environment paths untouched and starts the Node with an unbound launch.
The Node may then discover, activate, switch or install environments through Bash.
Runtime may carry a non-owning ambient hint as
`previous agent used: <manager> <selector> (<executable>)`. At fan-in all parent
hints are preserved, sorted and deduplicated; no hint is authoritative and
conflicting hints do not block the node. The downstream Node may ignore, verify, activate or replace a hint through Bash; it is not Runtime activation or authorization.

At fan-in, Runtime selects a provable local input if one exists; other parents'
E/L are provenance, not constraints on the downstream task. Otherwise the current
workspace starts unbound. Runtime never cleans or resets business environment
paths. All input manifests and stored bytes are still validated before preparation,
including environments not selected for reuse. Known custom prefixes remain
excluded from copying and Git collection. Ordinary business Bash retains its
existing exploration/creation behavior and permissions.

Scopes support basic files/directories, Unix modes/Windows readonly and supported
links. Special files, escaping directory links and nested Runtime/Git metadata
are rejected; managed Unix trees also reject hardlinks and special permission
bits. An unreadable or unresolvable link (for example a Windows reparse point
whose target no longer resolves, such as Chrome's `INetCache\Content.IE5`) is
skipped with a log instead of failing the whole snapshot: it has no content to
inherit, the live entry is left untouched, and the rest of the scope still
snapshots. A cache may be a top-level path or a subtree carved out of a scope:
anything at or below a cache path is excluded from the snapshot and left
untouched in the live view. The automatic policy excludes the machine-local
Windows/browser caches under S's redirected `.agent-home` (for example
`AppData/Local`, which holds `INetCache`, `D3DSCache` and browser profiles), npm
caches, and `.runtime-cache`. Environment capture/materialization is relative to
S and does not inspect a project Git index. S's `.project-git` / `.git-config`
metadata is not an environment scope and cannot be adopted by discovery.
Genuine project `.venv`, `.agent-home` and same-named files remain in W; external
state ownership never excludes or moves them by name. Environment preparation is
checked not to inject entries or change project files. A cache may not equal or contain a scope. Ownership, ACLs, xattrs/capabilities, sparse layout, ADS and general hardlink
topology are not preserved by the basic snapshot contract.

Physical copying uses the shared [native copy primitive](workspace-snapshots-and-feedback.md#physical-copy-primitive); it does not add environment relocation or logical-path guarantees.

## Native resources

Internal resource declarations can enforce Windows Job aggregate committed-memory
and CPU hard-cap limits **per managed process tree**, including descendants. They
are not aggregate limits across concurrent writers in a Run or across the host.
Linux/macOS reject these unsupported aggregate controls instead of substituting
per-process limits. Disk quotas are not implemented.

CUDA declarations bind exact NVIDIA GPU UUIDs through an absolute native
`nvidia-smi` probe. Host-user file locks coordinate execution scopes across
Grapher data roots/processes; partial multi-device acquisition releases its locks,
and OS handles release after a crash. These leases do not reserve against other
users, unrelated host applications or hostile tenants. A busy/unavailable device
fails without selecting another GPU or falling back to CPU.

Transient accelerator binding applies before activation hooks, reapplies after
hooks, and overrides ambient visibility before factories and managed Bash.
Admission records selected device/driver identity in D, but
`nvidia-smi` alone is not framework proof. Managed CUDA sealing requires real
PyTorch integer computation and synchronization for each selected device,
matching visibility and the framework's actual device UUID, with no CPU fallback.
Proof is retained at
`proofs/<generation>/accelerator.json`. This implementation does not establish
ROCm/MPS support or arbitrary CUDA framework compatibility.

## Publication and model-free execution

Code/Git state follows [Git publication](workspace-snapshots-and-feedback.md#publication). Managed scopes/caches are **not copied back into source**; source environments are not removed, overwritten or activated. New best-effort Runs publish schema-2 descriptors with
one named business entry per terminal, each retaining its own E/L and fixed
workspace. Every entry uses the final published code commit and passes native
integrity/startup checks. Validation and code preparation run outside the Run
mutex; descriptor/completion events commit together after the publication worker
identity/state check. Graph completion still requires successful publication.
Descriptor construction is best-effort and does not itself gate code
publication: if environment evidence cannot produce a descriptor, the Run still
publishes without one. Live-writer and workspace-exclusion safety checks still
apply. A descriptor whose code reference is not the current published head is
rejected.

Different terminal environments do not prevent publication. A default entry is
available only when startup bindings and business-prefix bytes agree (private
HOME changes do not constitute incompatibility). Otherwise `launch_result`
requires `entryId`, a terminal/business entry name, not an environment setting.
Failure/retry remains tied to that entry's partial workspace. Launching an entry
preserves the others; successful result execution still requests republication.
Schema-1 descriptors remain readable; current publication may expose multiple
business entries over the current project code.

| Local JSON POST endpoint | Body / result |
| --- | --- |
| `/api/environment_capabilities` | `{}` → compiled capabilities/limitations; not device acceptance |
| `/api/result_descriptor` | `{"runId":"…"}` → published composite descriptor |
| `/api/launch_result` | `{"runId":"…","entryId":"train","args":["train.py","--smoke"]}` → native entry stdout, no model call (`entryId` optional with a unique default) |
| `/api/cancel_result` | `{"runId":"…"}` → requests cancellation, not a claim of termination |

The interface does not expose descriptors or result launch/retry/cancel controls;
local API clients do. Result arguments/references are durable evidence, not Agent
conversation messages. Success advances matching current aliases and requests
**republishing**, not synthetic completion; failure preserves partial work.

Descriptor retrieval validates references/manifests, not another multi-GiB byte
scan. Native use still validates baseline and bytes before reuse/materialization.

Runtime reserves the durable generation under the Run mutex, executes native
preparation/work outside that mutex, then generation-checks and linearizes the
commit. Metadata remains accessible while the result runs. Cancellation covers
preparation, spawn registration and commit. Restart marks interrupted execution
failed; it does not resume a process or reset its partial view.

Results have **no implicit execution timeout**. Internal policies may set
`resultTimeoutSeconds`; initialization defaults to 120 seconds and can set
`initializeTimeoutSeconds`. Stdout/stderr each default to 4 MiB, adjustable through
`maxOutputBytes` (4–256 MiB). Output is bounded, not live streamed. Native probes
and computation proofs retain bounded time/drain checks.

Serial/source Planner launches retain their source-native environment contract; private Planner turns follow their selected workspace's access policy. A Git-conflict Merger keeps its plain workspace shell: environment differences do not invoke it or generate new Agent instructions, and managed ML commands are not accepted in that role. Process ownership guarantees belong to [Process lifecycle](filesystem-isolation.md#process-lifecycle).

## Capabilities not implemented or accepted

- Complete dynamic-scope rollback outside the initial ownership roots.
- Complete automatic package/toolchain and resource/device policy synthesis;
  transparent cross-slot environment rebuilding and arbitrary multi-environment
  execution; new fan-in uses local reuse/unbound selection, not a package solver.
- Namespace-backed fixed logical paths / transparent cross-slot migration.
- Shared working layers, system snapshots and extended snapshot metadata.
- Run/host-wide and Linux/macOS aggregate quotas, disk quotas and bounded GC.
- Native Linux/macOS acceptance and actual reflink/APFS/block-clone outcomes.
- Complete Conda/framework/GPU/platform matrix and large environment/checkpoint
  scan, seal, reconstruction and disk budgets.

Unsupported strong requirements fail closed, not by changing OS, mode, layout
or device. Compiled capability reporting and configured CI are not native
acceptance evidence.

For local native regressions, see [Testing](../development/testing.md) for suite selection, host prerequisites, and explicitly opt-in profiles.
