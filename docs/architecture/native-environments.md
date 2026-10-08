# Native workspace environment control

> **Status:** active
> **Maturity:** experimental; full proposal acceptance remains open.
> **Scope:** Backend-owned environment admission, Graph NodeAgent E/L, native resource controls and model-free result execution. No VM, WSL, container fallback, new allocator or maintenance Agent.
> **Maintained with:** [automatic admission](../../backend/src/environment_automatic.rs), [tool observations](../../backend/src/environment_discovery.rs), [environment state](../../backend/src/environment.rs), [resources](../../backend/src/environment_resources.rs), [runtime](../../backend/src/runtime.rs), [launch binding](../../engine/launch-binding.mjs), [state tests](../../backend/src/environment_tests.rs) and [native acceptance](../../scripts/environment-native.test.ts).

The [proposal](../proposals/shared-environment-control.zh-CN.md) includes
unimplemented and unverified capabilities. This page owns the current contract.

## Admission and configuration

**Users do not configure or choose environments.** Settings has no environment
mode selector, policy JSON editor, device selector or relocation assertion.
Runtime makes admission/selection decisions from native tool evidence;
ambiguity or missing capabilities produce diagnostics,
not a request that the user select an environment, authoritative parent or
CPU/OS fallback. Graph approval and result arguments remain business controls,
not environment configuration.

New production Runs without an already frozen policy record
`EnvironmentPolicyRequested`. At approval, after Planner's existing source
writes, Rust records `EnvironmentPolicyResolved` with the decision and reason:

- Standard Git Graph projects start with **no business environment binding**
  (`automatic-lazy`), irrespective of language or ML declarations. No venv,
  package installation or environment import occurs at admission. Trusted native
  Node/Git/Bash and available bootstrap tool hashes are frozen; private HOME and
  excluded caches are ownership boundaries, not precreated environments. A
  project that never needs an environment can complete and launch results while
  remaining unbound. Serial/shadow projects retain their source-native contract.
- Ordinary business tasks may create private venv/Conda environments. Managed
  Bash delegates actual `python`/`python3`/`pip`/`pip3`/`conda` invocations through
  Rust's native adapter, recording creation/use receipts per writer generation.
  Supported forms include `python -m venv`, `conda create` and `conda env create`
  with a private prefix/name. Conda names resolve inside `.environments`; its
  supported Bash-hook delegate remains observed. No task-text or arbitrary Shell
  parser, maintenance Agent, extra binding message or user choice is involved.
- After drain, Runtime verifies a unique candidate's ownership, native metadata,
  actual interpreter prefix, supported Python constraints and ABI/library-byte
  evidence, then versions L and captures E separately. `.env`, `environment.yml`
  and temporary activation/exports alone do not bind anything. Multiple candidates,
  external prefixes and unobserved executable environments refuse sealing rather
  than picking the newest or quietly retaining the bootstrap. Metadata inventory
  is a refusal guard bounded to 50,000 source directories, not an adoption heuristic.
- Bound environments use fixed physical layout; unbound views retain ordinary
  parallel allocation/copying. Fan-in accepts identical E/L or a provable descendant
  with unchanged L, never arbitrary authority or environment-directory merging.
  Native probes do not constitute a complete system-library/compiler/driver/root
  snapshot. Unsupported tools or requirement forms fail explicitly when used.

`environmentPolicy` is present in full/metadata projections and checkpoints.
The admission/discovery contract is frozen before execution; verified E/L and
private prefix scopes evolve through immutable composite references. Retry cannot
replace that contract. Draft/model-setting changes cannot override it. Future-Run Settings
projections/default saves do not carry environment policies from a previous Run.
Existing event-backed Run policies and result descriptors remain intact.

Legacy Runs without an admission event retain the original
[Git/ignored-resource contract](workspace-snapshots-and-feedback.md), including
unapproved saved drafts. Legacy explicit policies remain readable for replay,
descriptors and compatibility tests; they are not an exposed configuration
workflow. Legacy `automatic-managed` policies remain eager and frozen. Automatic
device/quota policy synthesis and complete package-manager coverage are **not
implemented**; lazy discovery is limited to the supported native tool adapters.

The internal frozen policy fixes platform/architecture, baseline, initial
ownership scopes, rebuildable caches, layout and discovery rules. A verified
binding adds its private prefix to the scopes through versioned L, not by editing
the Run policy. Legacy initializers/launch-file rules retain their old semantics.
Traversal, overlapping paths, Runtime metadata and tracked-file conflicts fail.
Windows case aliases and reserved names are checked.

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

New manifests include integrity checks. Legacy ordinary-resource snapshots remain
readable. Missing/damaged snapshots fail before materialization. Byte content is
verified, not trusted only from size/mtime. Event-actor reference/manifest checks
stay metadata-only; native writer byte/ABI checks and managed publication
preflight run outside the Run mutex. Verification does not save new blobs or
repair missing history from a live directory. A failed database commit may leave
unreferenced storage but never a completion referring to an incomplete seal.

Failed initialization/execution retries retain their selected partial directory.
A missing failed view blocks, rather than silently restoring an old snapshot.
Historical edits restore their recorded input. Dropping a dynamically added
prefix outside the frozen ownership roots is currently refused **before touching
the view**, rather than leaving or silently reclassifying an obsolete environment;
complete dynamic-scope rollback remains open. Default `.venv`/`.environments`
rollback and legacy frozen-scope behavior are unchanged. A missing successful
terminal directory rebuilds the **current** composite at its fixed path.

Feedback retains pinned sender results, generation/budget checks and
**drain-before-handoff**. It forks only the receiver's own history. Failed and
pending-feedback views are not opportunistically reclaimed. Managed layouts and
snapshots remain until explicit conversation deletion; bounded long-term
retention/reference GC is not implemented.

## Branches, metadata and storage

Once a business environment is bound, fixed layout refuses a different physical
slot, without repairing shebangs, `.pth` files or binaries. An empty business
binding does not impose that environment-only restriction on ordinary fan-out. Saved legacy `relocatable` assertions/import policies
are honored only under their recorded compatibility contract; automatic
admission never makes that assertion. Independent roots initialize independently.

Fan-in accepts identical E/L or, for automatic policies, a provable descendant
with unchanged L. Incompatible independent E/L block without a user-choice
prompt and are never directory-merged. Legacy recorded authorities remain
replayable. Arbitrary `activate`/`export` alone do not change L. A uniquely observed and
verified business-created/used private environment can establish the formerly
empty binding; creating a second independent candidate is ambiguity, not an
implicit switch. Legacy launch files retain their frozen rules; new Runs need no
binding file or user configuration.

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

Code/ordinary resources keep existing publication rules. Managed scopes/caches
are **not copied back into source**; source environments are not removed,
overwritten or activated. Publication commits a launchable descriptor. Graph
completion still requires successful publication.

| Local JSON POST endpoint | Body / result |
| --- | --- |
| `/api/environment_capabilities` | `{}` → compiled capabilities/limitations; not device acceptance |
| `/api/result_descriptor` | `{"runId":"…"}` → published composite descriptor |
| `/api/launch_result` | `{"runId":"…","args":["train.py","--smoke"]}` → native entry stdout, no model call |
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

Planner/Serial remain source-native. **Merger still does not use managed L**;
managed ML commands in that role are not accepted. Process groups/Job Objects
cover defined descendants, not arbitrary external services or universally
detached writers.

## Capabilities not implemented or accepted

- Complete dynamic-scope rollback outside the initial ownership roots.
- Complete automatic package/toolchain, resource/device policy synthesis and
  automatic reconciliation of incompatible independent fan-in environments.
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
- An optimized Windows legacy-policy Conda/PyTorch profile completed A→B→C,
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
