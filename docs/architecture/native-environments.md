# Native workspace environment control

> **Status:** active
> **Maturity:** experimental; full native acceptance remains open.
> **Scope:** Backend-owned environment admission, Graph NodeAgent E/L, native resource controls and model-free result execution. No VM, WSL, container fallback, new allocator or maintenance Agent.
> **Maintained with:** [automatic admission](../../backend/src/environment_automatic.rs), [tool observations](../../backend/src/environment_discovery.rs), [environment state](../../backend/src/environment.rs), [resources](../../backend/src/environment_resources.rs), [runtime](../../backend/src/runtime.rs), [launch binding](../../engine/launch-binding.mjs), [state tests](../../backend/src/environment_tests.rs) and [native acceptance](../../scripts/environment-native.test.ts).

This page owns the implemented contract. The capability limitations and native
acceptance boundaries below distinguish it from unimplemented design goals.

## Admission and configuration

**Users do not configure or choose environments.** Settings has no environment
mode selector, policy JSON editor, device selector or relocation assertion.
Runtime makes admission/selection decisions from native tool evidence;
ambiguity or missing capabilities produce diagnostics,
not a request that the user select an environment, authoritative parent or
CPU/OS fallback. Graph approval and result arguments remain business controls,
not environment configuration.

Graph approval without an already frozen environment policy records
`EnvironmentPolicyRequested`. After Planner's existing source writes, Rust resolves
the current workspace execution contract at approval; the contract is backend-owned
and not a user environment choice:

- Standard Git Graph projects start with **no business environment binding**
  (`automatic-lazy`), irrespective of language or ML declarations. No venv,
  package installation or environment import occurs at admission. Trusted native
  Node/Git/Bash and available bootstrap tool hashes are frozen; private HOME and
  excluded caches are ownership boundaries, not precreated environments. A
  project that never needs an environment can complete and launch results while
  remaining unbound. Serial/shadow projects retain their source-native contract.
- Ordinary business tasks may create, install into, activate and switch between
  whatever native Python/Conda environments their Bash process can access.
  For the active workspace, the adapter does not reject an ambient interpreter,
  rewrite Conda names, forbid package installation destinations, or turn a
  temporary activation into a Runtime failure. The OS sandbox/permissions and
  the command's own exit status still apply. Runtime records receipts only when
  a private project-owned environment can be verified; external use is recorded
  as unbound business execution. No task-text parser, extra binding message,
  maintenance Agent or user choice is involved. Persisted compatibility records
  retain their recorded ownership/offline contract for replay only; they are not
  a user-facing environment mode.
- After drain, Runtime tries to identify a unique private candidate's ownership,
  native metadata, actual interpreter prefix and ABI/library-byte evidence, then
  versions L and captures E separately. The current workspace policy treats
  project Python/version declarations as business inputs, not startup/binding
  gates or proof of package compatibility. `.env`, `environment.yml` and
  temporary activation/exports alone do not bind anything. Multiple candidates,
  external prefixes and unverified switches fall back to an unbound launch rather
  than blocking the node. Metadata inventory remains bounded and is used only to
  retain managed-scope evidence, not to adopt an environment by directory name.
- Environment binding is an execution/workspace property, not a distinction between
  execution labels. Runtime attempts safe reuse at the current workspace;
  if it cannot bind the observed environment, the execution remains unbound and
  is not blocked. Persisted E/L records are evidence for replay and recovery, not an
  instruction to resurrect an obsolete workspace or force a historical policy.

`environmentPolicy` is present in full/metadata projections and checkpoints.
The current workspace contract is frozen for the execution, while verified E/L and
private prefix scopes evolve through immutable composite references. Retry cannot
replace that contract; a workspace that falls back to unbound remains runnable and
records that decision. Draft/model-setting changes cannot override it. Environment
policy is not exposed as a frontend choice.

The active workspace contract is resolved by Runtime; persisted compatibility
records remain readable for replay and recovery but are not a second user-visible
mode. Automatic device/quota policy synthesis and complete package-manager
coverage are **not implemented**; lazy discovery is limited to the supported
native tool adapters.

The internal policy fixes platform/architecture, baseline, initial
managed-environment scopes, rebuildable caches, layout and discovery rules. A verified
binding adds its private prefix to the current workspace scopes through versioned L,
not by editing the policy. Traversal, overlapping paths, Runtime metadata and
tracked-file conflicts fail. Windows case aliases and reserved names are checked.

The default entry directory is first in the complete business PATH. Trusted
engine Node is resolved independently. Pi PATH processing and Windows MSYS
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
tree's **current** code/resources/E/L and A's conversation, not A0's environment.

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
from the current managed composite when the result contract requires it; ordinary
files have no reconstruction guarantee.

Feedback retains pinned sender results, generation/budget checks and
**drain-before-handoff**. It forks only the receiver's own history. Failed and
pending-feedback views are not opportunistically reclaimed. Managed layouts and
snapshots remain until explicit conversation deletion; bounded long-term
retention/reference GC is not implemented.

## Branches, metadata and storage

A verified fixed-layout environment is reused only at the current physical
workspace. When Runtime replaces that workspace with another slot, it does not
copy the environment directory; the next execution either observes an environment
it can use or runs unbound. Parent environments need not agree, and environment
mismatch alone never blocks the node.

At fan-in, Runtime selects a provable local input if one exists; other parents'
E/L are provenance, not constraints on the downstream task. Otherwise the current
workspace starts unbound. All input manifests and stored bytes are still validated
before preparation, including environments not selected for reuse. Known custom
prefixes remain excluded from copying and Git collection. Resetting an allocated
view touches only its managed scopes, checks its current writer's evidence and
tracked-path safety, and never changes an upstream tree or its history. There is
no automatic package installation/rebuild and no instruction asking an Agent to
perform one. Ordinary business Bash retains its existing exploration/creation
behavior and permissions.

Persisted records from earlier execution contracts remain readable for replay and
recovery; they are not a second user-visible environment mode. The current
workspace contract uses local reuse/unbound fallback. Arbitrary `activate`/`export`
may affect the Node's business process, but only a verifiable private environment
is recorded as reusable L. Multiple candidates do not block the node; they simply
remain unbound.

Scopes support basic files/directories, Unix modes/Windows readonly and supported
links. Special files, escaping directory links and nested Runtime/Git metadata
are rejected; managed Unix trees also reject hardlinks and special permission
bits. Ownership, ACLs, xattrs/capabilities, sparse layout, ADS and general hardlink
topology are not preserved by the basic snapshot contract.

[Private copy](../../backend/src/native_copy.rs) tries Linux FICLONE, macOS
`clonefile` or Windows block cloning, then uses independent byte copies for
unsupported storage operations. Other I/O errors fail. No writable hardlinks or
shared mutable inodes are used. Native clones optimize copies, not logical path
stability, shared working layers, sandboxing or system snapshots. Actual clone
support is filesystem-specific; the tested Windows filesystem reported **Bytes**.

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

Code/Git state follows the Git publication contract. Managed scopes/caches
are **not copied back into source**; source environments are not removed,
overwritten or activated. New best-effort Runs publish schema-2 descriptors with
one named business entry per terminal, each retaining its own E/L and fixed
workspace. Every entry uses the final published code commit and passes native
integrity/startup checks. Validation and code preparation run outside the Run
mutex; descriptor/completion events commit together after the publication worker
identity/state check. Graph completion still requires successful publication.

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

The workbench displays/copies descriptors and exposes business arguments,
launch/retry/cancel. Result arguments/references are durable evidence, not Agent
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

Planner/Serial remain source-native. A Git-conflict Merger keeps its plain
workspace shell. Environment differences do not create a Merger or a new Agent
instruction; the affected execution either reuses the current workspace
environment or runs unbound. Managed ML
commands in a Git-only Merger role are not accepted. Process groups/Job Objects
cover defined descendants, not arbitrary external services or universally
detached writers.

## Capabilities not implemented or accepted

- Complete dynamic-scope rollback outside the initial ownership roots.
- Complete automatic package/toolchain and resource/device policy synthesis;
  transparent cross-slot environment rebuilding and arbitrary multi-environment
  execution; new fan-in uses local reuse/unbound selection, not a package solver.
- Namespace-backed fixed logical paths / transparent cross-slot migration.
- Shared working layers, system snapshots and extended snapshot metadata.
- Run/host-wide and Linux/macOS aggregate quotas, disk quotas and bounded GC.
- Native Linux/macOS execution and actual reflink/APFS/block-clone outcomes.
- Complete Conda/framework/GPU/platform matrix and large environment/checkpoint
  scan, seal, reconstruction and disk budgets.

Unsupported strong requirements fail closed, not by changing OS, mode, layout
or device. Compiled capability reporting and configured CI are not native
acceptance evidence.

## Verification recorded for this working tree

Best-effort Runtime regressions: [native-venv fixtures](../../backend/src/environment_best_effort_tests.rs)
cover parallel bound fan-out, custom-prefix exclusions, local fan-in without a
Merger, independent multi-entry publication/launch/republication, serialized
roots retaining distinct terminal slots, HOME-only differences, discarded-input
corruption, entry-scoped partial retry, project-requirement decoupling, ambient
Python/pip exploration and saved policy compatibility, current-writer checks on
reused paths and explicit ancestor follow-ups through reserved terminal views. [Focused Pi acceptance](../../scripts/environment-chain.test.ts)
also covers default linear reuse and bound fan-out with existing business tasks,
independent bound/unbound terminal entries and model-free named launch. These
checks passed on Windows x86_64 with native Python 3.14 and pinned Pi. Verification
commands: `npm run check`, `npm run build`, `npm run test:frontend`, `npm test`,
`npm run test:environment`, `npm run test:environment-chain`, and the focused
`environment-ui.test.ts` browser/transport suite (isolated Cargo target and
disposable projects). They do not establish transparent relocation, offline
rebuilding, CUDA/Conda quality, or Linux/macOS native acceptance.

The following measurements are historical strict/lazy-profile evidence, not
new best-effort throughput budgets:

Windows x86_64, Node 24.16.0, Python 3.14.6, Git Bash, source base `c43b0c5` plus
these uncommitted changes. Pi baseline `1cedd32724abfcb0915f76cc61b6827e2c16dbad`
is an independent working-tree upgrade, not part of this environment change.

- Empty Python/Conda/non-ML admission, native creation/use evidence, ambiguous and
  stale receipts, host-prefix/package-mutation refusals, parallel unbound views,
  append-only replay and preservation of draft policies have focused regressions.
  Old Created records do not automatically become managed Runs.
- [API/browser tests](../../scripts/environment-ui.test.ts) passed with **no
  environment settings entry**, preservation of old policies on unrelated UI
  saves, invalid business argument rejection and Run-scoped stale response guards.
  The complete 15 existing browser tests also passed.
- Production pinned Pi/native Python acceptance passed **without a client-supplied
  environment policy**: install once, editable/console launchers, file/Bash and
  extension views, current follow-up, immutable history, same-path reconstruction,
  model-free results, cancellation/partial retry and background-writer refusal.
- `npm run test:environment` passed both ordinary venv and offline **lazy Conda**
  profiles without a client policy. Both include business creation, actual entry/
  ABI/library-byte checks, chain/current follow-up, immutable history,
  reconstruction, model-free results, cancellation/partial-result retry, drain
  refusal, discovery on failed-created-environment retry, and a separate plain
  project staying unbound despite `.env`/YAML creation. Latest debug venv: chain
  **45.92 s**, reconstruction **9.21 s**, environment **6,587,601 bytes**,
  harness **106.87 s**. Latest debug Conda: chain **133.80 s**, reconstruction
  **43.38 s**, environment **144,950,409 bytes**, harness **354.43 s**. This minimal Python/pip fixture excludes Conda setuptools'
  long packaged test data; tested Windows extraction of that package exceeded
  MAX_PATH and failed, without registry changes, archive modification or fallback.
  Neither fixture is a full ML/device acceptance or a production throughput budget.
- Full Rust fixture regression passed **251 lib tests** plus integration suites;
  the large synthetic storage benchmark remained explicitly ignored. Production
  `cargo check --no-default-features`, frontend/build, environment UI/launch,
  Pi/native/bindings/extensions/Merger/Windows-native/hardening and documentation
  checks passed. These are scoped regressions, not additional host/device evidence.
- Native Windows resource tests passed: one descendant fits a **384 MiB** Job
  ceiling, two 220 MiB allocating descendants fail; subsequent unbound launches
  do not inherit the limit. On **16 logical CPUs**, Job rate **312/10000** reduced
  aggregate descendant CPU from **5,983 ms** to **1,562 ms** over the test interval.
  Independent-process device-lock contention/crash release and partial multi-device
  release passed; these lock tests use disposable UUID keys, not GPU computation.
- An optimized Windows compatibility-policy Conda/PyTorch profile completed A→B→C,
  current-view follow-up and a model-free synchronized CUDA forward/backward
  result with retained computation proofs, including the framework's actual
  leased device UUID. Its complete harness nevertheless hit the **30-minute**
  timeout before long-result cancellation/retry and drain checks finished; it is
  **not a passed full ML acceptance or automatic Conda/device-policy proof**.
  The later optimized rerun also hit the **30-minute** timeout. Full ML acceptance
  remains open; lazy Conda's smaller native fixture does not close it. Host
  discovery or standalone computation alone is not managed acceptance. Native
  Conda's packaged paths exceeded MAX_PATH in the ordinary
  temporary layout, so its harness uses an explicitly short disposable workspace
  parent, still with Unicode/spaces. No registry change, Runtime path repair,
  execution fallback or allocator rewrite is used.

Run `npm run test:environment`; use an isolated `CARGO_TARGET_DIR` when another
backend is running. [Testing](../development/testing.md) covers offline ML
provisioning and test prerequisites. The [three-host matrix](../../.github/workflows/planner-source.yml)
is configured, not recorded as completed native Linux/macOS acceptance.
