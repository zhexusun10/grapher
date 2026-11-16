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

New Graph Runs record `EnvironmentPolicyRequested` and defer native admission to
the first private [execution batch](workspace-snapshots-and-feedback.md#adaptive-workspace-policy),
after Planner's source writes. Shared batches never initialize/load private E/L
bindings or require private completion seals; existing private evidence remains
owned by the Run for later batches and recovery. Admission
requires the current initialization events. The execution contract is backend-owned, not a user environment choice:

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
  remaining unbound. Serial/shared batches use source-native launches; ordinary-folder private batches retain their unmanaged launch contract.
- Ordinary business tasks may create, install into, activate and switch between
  whatever native Python/Conda environments their Bash process can access.
  For the active workspace, the adapter accepts unrelated ambient interpreters;
  it does not rewrite Conda names, forbid package installation destinations, or turn a
  temporary activation into a Runtime failure. The OS sandbox/permissions and
  the command's own exit status still apply. Runtime records receipts only when
  a private project-owned environment can be verified; external use is recorded
  as unbound business execution. Discovery accepts both roots: a genuine project
  `.venv` stays in W and binds as workspace-owned, while a prefix provisioned
  under S binds as state-owned; the receipt and L record the owning root. No
  task-text parser, extra binding message or maintenance Agent is involved.
- After drain, Runtime tries to identify a unique private candidate's ownership,
  native metadata, actual interpreter prefix and ABI/library-byte evidence, then
  versions L and captures E separately. Actual use of a unique verified private
  prefix can replace the previous binding, including W↔S switches in the same
  physical slot; both roots retain their ownership and captured bytes. A private
  switch is not external use merely because it differs from the old binding.
  During a bound turn, creating a prefix through a host interpreter still
  records external use; creation does not prove that the new prefix was used
  instead of the host. The current workspace policy treats
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

Unsupported persisted records are rejected before recovery or launch. Lazy discovery is limited to supported native tool adapters; [capability gaps](#capabilities-not-implemented-or-accepted) are not admission promises.

The internal policy fixes platform/architecture, baseline, initial
managed-environment scopes, rebuildable caches, layout and discovery rules. A verified
binding adds its private prefix to the current workspace scopes through versioned L,
not by editing the policy. Traversal, overlapping paths, Runtime metadata and
tracked-file conflicts fail. Windows case aliases and reserved names are checked.

New automatic launches inherit ordinary host business variables transiently,
including proxy/certificate settings, package-manager configuration, credentials
and Bash startup controls. They do not inherit an outer Agent's `GRAPHER_*`/`PI_*`
identity. `NODE_OPTIONS`/`NODE_PATH` are transported transiently and applied only
to business Bash/result children, never to the trusted Node bootstrap, activation
capture, extension/MCP factories or baseline probes. Explicit business-child
settings still override those inherited defaults. Host Git overrides are cleared;
explicit backend project-Git bindings and HOME/cache ownership still win.
A verified Python prefix also suppresses ambient `PYTHONHOME`, as native activation
would; an unbound launch retains it. Legacy explicit launches keep their recorded
name-based inheritance contract. The trusted baseline probe remains restricted.

New automatic launches preserve business PATH order and external shim spelling,
including missing, relative and empty entries; missing bootstrap directories are
appended, not prepended. Absolute project-root entries (including root aliases)
are rebound to `{workspace}` instead of discarded. Relative entries retain native
cwd semantics; Windows Bash represents empty entries as `.` so MSYS conversion
does not drop the cwd search. Windows PATH quoting is preserved: a directory
containing `;` remains one native entry, including in bootstrap-tool evidence.
Activation-hook capture transports Bash's PATH separately from MSYS's lossy
native-environment conversion. Existing components retain their native spelling;
new absolute components are converted together, while relative/empty entries
keep cwd semantics. Entries removed by a hook are not silently reintroduced.
Bash conversion batches separate path arguments in one native converter process,
not a lossy split of a joined path list. Absolute paths containing `..` are not guessed or
rewritten. The recorded `unboundPath` survives environment switches: activation
prepends its verified bins, while unbinding restores the original business path
rather than deleting all project paths. Explicit launches retain their declared,
allowlisted business environment and entry precedence; this is a current policy,
not a fallback selected by missing historical fields.

For these launches, project-root `NODE_PATH` / `PYTHONPATH` entries and absolute
activation markers (`VIRTUAL_ENV`, `CONDA_PREFIX`, `CONDA_DEFAULT_ENV`) are also
rebound transiently. Module paths use their literal native-delimiter grammar,
not Windows PATH quoting: quote characters remain literal. A rebased directory
containing the module list delimiter is refused rather than split into unintended
search roots. Absolute project-owned `BASH_ENV` / `ENV` startup-file references
also follow the selected workspace's recorded files, not today's source files.
Existing project-owned absolute `PIP_CONFIG_FILE` and `npm_config_userconfig`
references follow those same recorded project bytes, including a downstream
node's latest config edits; npm's case-insensitive variable names are respected.
These are existing tool variables, not Grapher declarations or a host-config
import. File contents (including paths written inside config files) are not
rewritten. Effective overrides/removals are respected; external paths, relative
paths, startup expressions and Conda names stay unchanged. Arbitrary variable
strings, `NODE_OPTIONS` contents and script bytes are not rewritten; this is not
environment relocation. No host HOME/configuration tree is copied as a fallback.
A PATH shim may still depend on missing HOME defaults: the offline project
[baseline and explicit setup guidance](../development/environment-baselines.md#private-home-discovery-is-not-mutable-state)
reproduce this with real Rustup/Cargo. Tool discovery/configuration, per-slot
writable state, cache and credential helpers are distinct inputs; there is no
generic automatic host-config import. Rebuilding an existing fixed-layout private
environment at another physical path is an explicit non-goal under the current
workspace lifecycle.

An unbound automatic entry is an absolute Bash and need not be first in PATH.
Bound environments, activation hooks and explicit launches still require
the default entry directory first as a fully absolute path. A hook cannot replace
it with an empty/relative PATH merely because the current cwd matches that
directory. Activation subprocesses restore the selected workspace after
`BASH_ENV`, before path conversion and hook execution, while retaining startup
variables/functions; startup side effects are not undone. When already in the
same physical directory (including a root alias), the adapter skips `cd` so it
does not overwrite `OLDPWD`, change `cd -`, or fail on a readonly `OLDPWD`. Trusted engine Node and bootstrap Git are
resolved independently outside the business project, before that binding. Pi PATH processing and Windows MSYS
startup cannot add host bins; managed Bash resets PATH inside Bash. Hooks run
before extension/MCP factories and cannot change Runtime/Pi identity, Node
bootstrap or the default entry. Trusted Node path discovery itself also removes
ambient `NODE_OPTIONS`/`NODE_PATH` before executing its probe. Loader variables enter inside the established
native boundary, not outer bubblewrap/Seatbelt. One-shot exports cannot rebind a
later tool call.

Inherited credentials are transient process values, not serialized into L.
Automatic policies record the inheritance rule, not an inventory of secret values;
explicit policies authorize inherited values by name. No secret values belong in literal policy variables, hooks, arguments or
managed trees. Arbitrary business files are not automatically scrubbed for
secrets. Existing [native permission limits](filesystem-isolation.md) apply.

## Zero-configuration source HOME discovery

**Status: not implemented.** Private HOME isolation and later inheritance of
already private HOME bytes do not establish source-default tool/config discovery.
A project working in its source context can still fail in its first private slot
when an unchanged tool looks for defaults through HOME. No project-only file-query
interface is accepted as satisfying this contract.

The required business contract is:

- The original project, command and setup scripts run unchanged. No Grapher query
  API, tool-path manifest, environment selector or added model instruction.
- Runtime supplies the first private workspace's necessary source discovery
  context without running the business workload on the host as a compatibility
  check. Ordinary private writes/cache remain independent and source is unchanged.
- Later executions use Runtime's selected workspace's **latest** state, not newly
  imported host defaults. Parent edits, deletions, independent branches and failed
  retry state retain their existing semantics. No parallel inheritance selector.
- Source metadata/credentials are not bulk-copied or automatically persisted.
  Referenced host input changes must not silently override recorded private state.
  Source/sibling/data permission denials still apply through any redirected view.
- No silent tool/OS/namespace fallback, downloads, global changes, writable
  hardlinks, arbitrary script/binary rewriting or new publication gate/channel.

An arbitrary tool can use the same HOME both to read implicit defaults and to
write state. PATH/variable forwarding alone cannot generically split those file
operations. A general native private read/write view, or another demonstrably
equivalent lower-level mechanism, needs design and native acceptance before this
can be claimed. Current Linux bubblewrap and macOS Seatbelt permissions do not
implement that HOME view; Windows currently has no such virtualization layer.
No driver, mount, host registration or filesystem-semantic change is implicitly
authorized by this requirement.

A Runtime-owned implementation would need one logical HOME view per physical
workspace: an automatically selected read-only source/config layer beneath the
selected workspace's existing private state, with writes/deletions represented
only in that workspace's private upper layer. The same business path (for example
`$HOME/.config/tool/settings`) must work without shell hooks or API calls. A later
node's selected parent bytes must win over the source layer; copy-up and
whiteouts must remain branch-local, survive drain/retry and seal through the
existing E ownership boundary. Runtime does not choose a different parent, and
this view cannot become a project-code/publication channel.

This is a design target, **not a claim that a specific union mount is sufficient**.
A candidate native provider must also account for lookup/enumeration, links,
renames, concurrent host changes and the source files actually observed. If a
referenced host input drifts, silently substituting new bytes is not acceptable;
full bytes/config contents must not be persisted just to pin the lower layer.
Directory listing and file-reference evidence, cache carve-outs, lifecycle/drain,
cleanup and all native permission boundaries need explicit proofs. The mechanism
must be available without downloading/installing a driver, changing the host or
falling back to an unisolated launch. Linux, macOS and Windows each need genuine
native acceptance for source reads, private writes, parent precedence, branch
independence and cleanup before this can ship. No source-HOME mount, read-through
view, filesystem provider or new admission requirement is currently implemented.

No admission metadata, business-shell query API, path manifest or project helper is
shipped. E/L and HOME inheritance are not modified to simulate source discovery.
The opt-in `zero_configuration_home_source_and_parent_without_setup` acceptance
case uses one unchanged ordinary HOME-reading/writing workload in source, first
private execution and two independent children. It requires source defaults,
latest-parent precedence, independent writes and no bulk sensitive-file capture.
It currently fails at the first private execution; its ignored/default status is
an explicit implementation gap, never passing coverage. Native platform boundary
acceptance remains separate. [Explicit baseline setup](../development/environment-baselines.md#private-home-discovery-is-not-mutable-state)
is still useful cost/tool evidence, not a replacement for this contract.

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
stay unchanged. E/L changes count even when the Git head is unchanged. Managed capture fully
validates the parent bytes and collects current bytes/metadata before publishing
a new E manifest; unchanged contents and root/scope/cache coverage reuse the old
E without an orphan version. Each generation still appends its own execution
records. A per-operation checked set reads each distinct immutable stored blob
once, while every live file and materialized destination still receives full
byte verification. No proof survives into another operation; no size/mtime
cache or historical-record rewrite is involved. Offline dependencies and local
patches remain actual captured bytes, not manifest-based reconstruction. See the
[sealing cost procedure](../development/environment-baselines.md#immutable-dependency-sealing-optimization)
for the scope and measurement limits.

Current E manifests carry `schema=1`, an integrity checksum and UUID-only names;
L records use a `schema=1` envelope with explicit root-qualified ownership.
Unversioned manifests/launches and `before-`/`after-` aliases are unsupported.
Current environment manifests and persisted E/L records remain available for replay and
recovery. Missing or damaged records fail when that evidence is explicitly needed;
they do not resurrect an obsolete workspace or turn an unrelated current execution
into an environment-selection workflow. Byte content is verified, not trusted only
from size/mtime. Event-actor reference/manifest checks stay metadata-only; native
writer byte/ABI checks and managed publication preflight run outside the Run mutex.
Verification does not save new blobs or repair missing history from a live directory.
History restoration compares recorded **root-qualified byte coverage**, not
project Git exclusions or directory names. New state-bound discovery snapshots
with root-qualified ownership use `rooted.schema = 1` inside the existing immutable
E manifest. Each W/S frame includes its declared scopes, cache exclusions and
entries; all are included in the manifest checksum. S captures the frozen state
scopes plus known S prefixes; W captures only known W prefixes. Active, switched
and unbound environments retain their ownership. An equally named W directory
is never a substitute for S. This does not capture arbitrary external state.

| Evidence | What it can restore |
| --- | --- |
| New validated root-qualified E | Its recorded non-cache scopes in **both** W and S, including inactive/unbound prefixes and private HOME. Recorded absence can remove later entries within that coverage, subject to the existing link/metadata limitations below. |
| Current single-root E (`schema=1`, no `rooted` frame) | Empty initialization snapshots and explicit-policy captures retain their declared single-root coverage. They cannot supply another root's bytes. |
| `ownedScopes` / Git exclusions alone | Ownership only, not byte evidence. A target lacking coverage for a previously known root/scope cannot authorize partial rollback. |
| Link targets outside recorded scopes | Link metadata/reference only; target bytes are not captured merely because a link is inside a managed scope. This includes external toolchain files. |
| Cache paths, skipped unresolved links, ambient toolchains/configuration/services | Not restorable E evidence. Project code separately follows its immutable Git/view record. |

The native worker validates every stored byte and all root targets/conflicts
before materializing the first root; historical preflight runs before project
code reset, outside the Run mutex. Current-tree inspection still hashes live
files and checks paths/links/metadata, but never saves their discarded partial
bytes as new blobs. Successful or refused preflight does not write/repair the
immutable store; actual capture/sealing remains the only source of new byte
evidence. Materialized files still receive full byte verification. Actual project
Git conflicts are checked in W, not in S or against the engine's force-collected
index. W's preparation guard
excludes only recorded managed W prefixes; ordinary project/Git bytes remain
protected. A binding may change its active W/S root only when the selected E has
coverage for **all** previously known scopes. Otherwise live partial state is
preserved and recovery explicitly fails. Native interpreter/prefix/ABI validation
still applies after materialization; this is not environment relocation.

Unsupported manifest and launch generations are rejected without rewriting their
JSON, checksums or references. Current single-root and rooted records share the
versioned manifest contract; missing other-root history is never filled from live
files. Failed retries preserve their current W/S bytes instead
of restoring an old input. All-root preflight is not a filesystem transaction:
an I/O failure during application can still leave a failed partial view, never a
successful partial rollback. Full host-state and arbitrary-root rollback remain
out of scope.

A failed database commit may leave unreferenced storage but never a completion
referring to an incomplete seal. A missing current workspace view is rebuilt only
from the current managed composite when the result contract requires it.
Environment evidence alone does not reconstruct ordinary project files; those
follow the [Git workspace contract](workspace-snapshots-and-feedback.md#cleanup-and-reproducibility).

Environment evidence participates in [feedback generation/drain checks](runtime.md#bounded-feedback) and [pinned workspace handoff](workspace-snapshots-and-feedback.md#feedback-and-history-edits). Failed and pending-feedback views are not opportunistically reclaimed. Managed layouts and snapshots remain until explicit conversation deletion; bounded long-term retention/reference GC is not implemented.

### Native runtime inputs during recovery

Verified bindings require `runtimeEvidence` and an explicit owning root in L.
New discoveries write `runtimeEvidence.schema = 3`. Schemas 1/2 retain their
recorded file/selector semantics inside a current launch envelope; missing evidence
is rejected for a bound launch. An unbound launch legitimately has no binding or
evidence. No missing relationships are inferred.
This reuses the existing interpreter/ABI probe's bounded native-file inventory;
it does not import a host environment or enumerate HOME/configuration/secrets.
The probe hashes each observed file's same byte stream for the existing SHA-256
ABI payload and a Git blob identity. Its framed extra output is removed before
computing `Binding.abi`, preserving the exact legacy ABI payload/startup output.
L's immutable content hash binds the new evidence alongside that ABI.

The evidence records canonical W/S locations and root-qualified native files.
Recorded locations are not resolved through today's filesystem: redirecting an
old root must not authorize a different root with the same name/content. Trusted
aliases that still resolve to the recorded location remain valid; missing W/S
can be reconstructed only at that location. Another managed slot's native files
inside the backend-selected workspace bucket cannot be labeled host toolchain
inputs or used to bind the current environment. The bucket is derived from the
physical workspace, so a trusted W alias cannot bypass this ownership boundary.

| Native file evidence | Recovery behavior |
| --- | --- |
| W/S file covered by the selected E frame | Require that root's recorded regular-file entry and matching fully verified blob. A damaged/missing live interpreter is not used to supply evidence or run preflight; the captured bytes may restore it. |
| Ordinary project W file outside E scopes | Keep the original `codeRef` channel. Schema-3 recovery workers with the exact target codeRef verify its regular-file tree entry and full Git blob bytes before code reconstruction/reset. After code preparation, recheck real paths and bytes before E writes. Do not copy it through E or use current files to repair missing code history. |
| Explicitly excluded private cache | Verification-only live input: require its current real file/path and bytes to match. Missing/changed cache inputs fail; no rebuild/download or cache restoration is implied. |
| External native file | Verification-only observed input: require its canonical path, regular-file type and full bytes to match. Schemas 2/3 also check recorded external selector paths against that same target before recovery writes (schema 3 projects any owned portions through E). Do not copy, activate, repair or grant access to its host directory. |
| State root/path without captured coverage, or absence/link-only entry inside an E scope | Refuse; live or same-named other-root files cannot fill missing E history. Project Git ownership is not E byte evidence. |
| Schema 2 `runtimeEvidence` | Preserve its original external-target selectors and startup rules. It does not contain selectors whose final targets return to W/S; no new return-path evidence is inferred for it. |
| Schema 1 `runtimeEvidence` | Preserve its file-only preflight and startup checks, without adding selector admission rules, changing its serialization or inventing missing original paths. Its originally aliased external inputs can still evade early detection if the old canonical target survives. |
| Bound L without `runtimeEvidence` or an explicit root | Reject before native startup or restoration; never synthesize missing evidence. An unbound launch remains valid. |

Native workers check E-owned/external/cache evidence before historical code reset
or managed root materialization. Missing-W result/descriptor entry also checks it
before reconstructing project code, so a known bad external input cannot first
reset S or create W. Schema-3 workers also check observed project native bytes
against the **codeRef about to be installed**, including a composed descriptor's
new head rather than just the entry's previous codeRef. This reads existing graph
Git trees/blobs, never current source files; no checkout, refs, index, filters or
object repair are involved. SHA-1 and SHA-256 Git storage both retain the native
probe's SHA-1 blob identity. Exact Git names take precedence; Windows alias
fallback uses native ordinal case comparison and requires one match, rather than
Unicode lowercase equivalence. Missing/non-file entries, ambiguous fallback
aliases and missing/corrupt objects fail early. macOS nonexact Git spelling is
explicitly deferred to the existing prepared-file check: Git alone cannot prove
the destination volume's case/Unicode equivalence, and early preflight must not
introduce a refusal for that uncertainty. This is a coverage limit, not successful
early byte verification. Only referenced tree levels and observed blobs are read.
Blob bodies are streamed from Git through a fixed 64 KiB input buffer and hashed
incrementally, including the original Git blob header. The incremental hasher
retains libgit2's collision-detection failure semantics; ordinary SHA-1 output
alone is insufficient. The reader verifies the
response object/type/length, terminator, EOF, full content hash and successful
Git exit; truncated/extra output and missing/corrupt objects cannot pass. Stderr
is continuously drained with only a 16 KiB prefix retained. The read-only utility
is registered under the current execution/result owner, so cancellation interrupts
blocked pipe reads without stopping another owner. It keeps host Git's existing
resource-limit semantics. Child waiting runs concurrently with output verification;
direct exit or failure terminates any remaining pipe holders in that invocation's
process boundary. No temporary blob copy or object-store write is needed.
This bounds backend blob buffering, not Git's own pack/delta memory, tree-listing
memory or whole-process-tree peak usage. Schemas 1/2 keep their prior staged rules.

Project selector traversal and supplemental view metadata still follow codeRef
preparation and the prepared-path check; this is not complete pre-code native
verification. Known bad prepared-code inputs fail before E writes; existing code
restoration is not rolled back. Actor/reference queries remain metadata-only. After materialization, actual
interpreter/prefix/ABI/library verification still gates startup as before; file
proof alone is not a compatibility assertion. Recovery-only evidence locations
are excluded from the existing business-launch equivalence comparison, while
ABI, entry/PATH/hooks/variables and managed prefix-byte criteria remain. They add
no source/host run validation, environment agreement condition or publication gate.

Schema 2 captures the probe's original native-file references before resolving
away their selectors. For files whose canonical targets are external, observation
follows links out of owned W/S prefixes and records the external continuation
and its observed canonical target. Early preflight checks that relationship
without executing or reading a recoverable live prefix. Thus a real venv's
external Python alias may remain valid, but retargeting it cannot pass merely
because the old installation survives or a replacement has equal bytes. An
intermediate alias change that still selects the same target remains valid;
link spelling/topology itself is not frozen. A target already redirected between
the probe and evidence construction is rejected, not reinterpreted as new proof.

Schema 3 additionally retains the original references for **all** observed native
files, including external aliases returning to W/S. Preflight projects pathname
resolution without creating anything: E-owned directories, file types and links
come from the selected immutable manifest; external links and excluded caches
remain live inputs. Native target blobs are still fully verified independently.
This permits dangling external aliases to missing-but-restorable W/S files while
rejecting redirected targets, cross-root substitutions, missing recorded entries,
non-directory traversal and link cycles. Missing root scaffolds do not require a
live interpreter. If E stores an internal link directly to its root-relative
target, preflight uses that restored link, not an obsolete external detour that
materialization removes. Win32 dot-segment normalization and POSIX link/parent
traversal retain their respective native semantics.

Path **traversal** crossing ordinary project code is deferred until codeRef
preparation, then rechecked before E writes; current/partial W cannot supply that
historical path proof early. The native target's recorded Git blob bytes can be
checked beforehand as described above. Intermediate project links remain staged
even if the final native file is in E or external. Schema 3 separately retains the earlier external
continuations, so project deferral cannot hide already-observed bad external
inputs. It adds no alternative project-code delivery channel or filesystem
transaction; prepared-code changes are not rolled back on a later failure.

Each original-reference/external-continuation inventory is bounded to 128, and
path resolution to 64 traversal passes. They are recovery-only evidence, not
additional business-launch agreement criteria; real startup still verifies the
original ABI and native-file inventory. Unobserved tool-manager configuration,
loader search decisions, unsupported filesystem redirections and transitive
dependencies remain outside this bounded pathname proof.

Coverage is only the interpreter and explicitly observed native files from the
existing adapter, not all transitive OS libraries, arbitrary application imports,
services, credentials or every inactive environment's startup dependencies.
Inactive/unbound prefixes can have restorable E bytes without a runnable native
binding. Existing current-format L/E JSON, checksums, references and execution results are not
rewritten. This preflight is not a filesystem transaction or protection against
concurrent host toolchain changes; later I/O/startup failures remain failures,
not successful partial recovery. Full host-state rollback and arbitrary venv/
Conda relocation are still outside this contract.

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
workspace. Selection and dispatch compare native path identity, not literal
layout spelling; equivalent paths must not discard the latest parent E/L.
Reuse still requires the current physical slot's matching E/L evidence, never
another slot with matching references. When environment reuse is not possible,
Runtime leaves the current workspace's business environment paths untouched and
starts the Node with an unbound launch.
The Node may then discover, activate, switch or install environments through Bash.
Runtime may carry a non-owning ambient hint as
`previous agent used: <manager> <selector> (<executable>)`. At fan-in all parent
hints are preserved, sorted and deduplicated; no hint is authoritative and
conflicting hints do not block the node. The downstream Node may ignore, verify, activate or replace a hint through Bash; it is not Runtime activation or authorization.

### Unbound private HOME branches

A fresh slot can inherit a parent's **already private HOME bytes** without
adopting an interpreter. This applies only to the automatic unbound launch,
with no active binding, hook, or retained environment-prefix ownership, and a
root-qualified E containing only S HOME files/internal HOME links (plus empty
default-scope directories). The frozen launch must still match; older single-root
records, external links, W frames and files elsewhere in S do not establish this
capability. Runtime does not scan/copy the host HOME or read the parent's live tree.

Selection records `unbound-home-fork` and retains the selected immutable E;
non-owning hints are combined in L as usual. The native worker validates all
stored bytes; only an otherwise empty managed target receives independent
materialization. A populated target instead keeps its live state and remains
runnable unbound, recording `unbound-home-target-preserved` rather than claiming
parent-byte inheritance. Input byte validation is still required; this cannot
repair or bypass missing history. Existing target caches are retained; parent
cache bytes were excluded from E. Links within HOME are rebased to the child's
own HOME. A failed retry keeps that child's partial state. Explicit historical
restoration keeps its prior rollback semantics. Neither operation is governed
by a diagnostic `inheritance.reason` string from an earlier generation. Each
child seals its own latest state; historical references/source delivery stay unchanged.

At a fresh-slot fan-in, equal E refs or (when the frozen policy permits) a single
descendant of every input can supply HOME bytes. Only that selected frame must
be forkable; older frames need not be, since their bytes are not copied. Equal
E refs cannot order incompatible launches. Divergent independent states are not
directory-merged or selected by input ordering; they retain the existing unbound
fallback. A slot with current state is never reset by this path. This is byte inheritance, **not**
venv/Conda relocation, package reconciliation or a guarantee that absolute paths
embedded inside HOME files remain usable. Unsupported inputs are not reported as
successful HOME inheritance. No environment-selection UI or declaration is added.

At fan-in, Runtime selects a provable local input if one exists; other parents'
E/L are provenance, not constraints on the downstream task. Otherwise the current
workspace starts unbound, with the narrow HOME inheritance above when proven. Runtime never cleans or resets business environment
paths. All input manifests and stored bytes are still validated before preparation,
including environments not selected for reuse. Known custom prefixes remain
excluded from copying and Git collection. Root-qualified ownership in L is
independent of the active interpreter: ambiguity, an external switch or failed
verification cannot drop an already known project prefix from the exclusion set.
The same relative name under W and S has distinct ownership. Reusing a physical
slot preserves its current ownership even when activation falls back to unbound;
a sibling does not inherit that ownership. A retained current alias must pass
the same domain and manifest checks as parent inputs before contributing ownership;
a matching physical layout alone cannot authorize corrupt or foreign evidence.
Selecting a project environment never
turns S's HOME/cache scope names into exclusions of same-named project files.
Tracked project-file conflicts are checked against native project Git, not the
force-collected graph index. Ownership alone does not prove an unselected
environment can be reconstructed or relocated.

Ordinary business Bash retains its existing exploration/creation behavior and
permissions. Best-effort tool observation preserves per-command exports rather
than resetting HOME or package-manager configuration to the initial launch.
Relative Conda prefix arguments (including `--prefix env`) resolve from that
invocation's actual cwd, never from S or a same-named scope under another root;
name-based selection is not reinterpreted as a path. Conda `run` selectors end
before the child executable, with or without `--`; application `--prefix` /
`--name` options cannot select a managed environment. Python module observation
follows the interpreter entrypoint, including compact short options: `-m venv`
inside script, `-c`, stdin or another module's arguments is not creation evidence,
and application `-m pip` arguments do not trigger package policy. Option values
and help/version requests are not environment actions. Unrecognized interpreter
options still run unchanged but cannot supply module-based binding evidence.
Interpreter provenance keeps the lexical entry path: a private venv symlink does
not become an external-use hint merely because its target is a host Python binary.

Copying project bytes is not venv relocation. New native observer contexts also
record the backend-bound source root. If an observed environment tool resolves
into that source, the observer refuses execution before starting the source tool
and asks for environment recreation at the current path or an unrelated external
environment. Removing a private copy does not authorize a stale source prefix.
It checks both executable directories (before resolving Unix interpreter
symlinks) and resolved executables; it does not rewrite activation scripts, console launchers,
editable paths or package bytes. Direct local interpreters and unrelated ambient
environments remain usable. Observer contexts use schema 2 and their source
binding is immutable within a generation; an old or source-less generation cannot
be adopted by clearing the new source identity. This guard covers
observed tool invocations, not arbitrary scripts, explicit executables or custom
wrappers that bypass observation; the OS permission boundary is unchanged.

Scopes support basic files/directories, Unix modes/Windows readonly and supported
links. Special files, escaping directory links and nested Runtime/Git metadata
are rejected; managed Unix trees also reject hardlinks and special permission
bits. An unreadable or unresolvable link (for example a Windows reparse point
whose target no longer resolves, such as Chrome's `INetCache\Content.IE5`) is
skipped with a log instead of failing the whole snapshot: it has no content to
inherit, the live entry is left untouched, and the rest of the scope still
snapshots. Recovery inventories these omitted entries separately from byte
evidence. If a recorded destination would traverse/replace one, or a recorded
file/link would replace a directory containing an omitted entry or live cache,
all-root preflight refuses before either root changes. The diagnostic names the
obstruction; history is not repaired and the entry is not silently removed.
Unrelated omitted links/caches do not block restoration of recorded siblings.
Legacy predecessor paths also cannot authorize deleting or traversing a skipped
live link. This is obstruction handling, not recovery of the omitted target.
A cache may be a top-level path or a subtree carved out of a scope:
anything at or below a cache path is excluded from the snapshot and left
untouched in the live view. The automatic policy excludes the machine-local
Windows/browser caches under S's redirected `.agent-home` (for example
`AppData/Local`, which holds `INetCache`, `D3DSCache` and browser profiles), npm
caches, and `.runtime-cache`. Environment capture/materialization does not inspect a project Git index. S's `.project-git` / `.git-config`
metadata is not an environment scope and cannot be adopted by discovery.
Genuine project `.venv`, `.agent-home` and same-named files remain in W; external
state ownership never excludes or moves them by name. Environment preparation is
checked not to inject entries or change project files. A cache may not equal or contain a scope. Ownership, ACLs, xattrs/capabilities, sparse layout, ADS and general hardlink
topology are not preserved by the basic snapshot contract.

Physical copying uses the shared [native copy primitive](workspace-snapshots-and-feedback.md#physical-copy-primitive); it does not add environment relocation or logical-path guarantees.
Managed Windows directory links use the existing native junction implementation,
not a PATH-selected Node subprocess; business Node options/module paths cannot
inject into that backend materialization helper. The basic link contract is
unchanged.

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
identity/state check. Private results must complete their batch handoff before
graph completion.
Descriptor construction is best-effort and does not itself gate code
publication: if environment evidence cannot produce a descriptor, the Run still
publishes without one. Live-writer and workspace-exclusion safety checks still
apply. A descriptor whose code reference is not the current published head is
rejected. Under the [batch policy](workspace-snapshots-and-feedback.md#adaptive-workspace-policy),
current-result queries/launches also require `ResultPublished` after the latest
batch started; shared edits or file-only delivery must not reuse an older private
code/E/L descriptor merely because the historical published head still matches.

Different terminal environments do not prevent publication. A default entry is
available only when startup bindings and business-prefix bytes agree (private
HOME changes do not constitute incompatibility). Otherwise `launch_result`
requires `entryId`, a terminal/business entry name, not an environment setting.
Failure/retry remains tied to that entry's partial workspace. Launching an entry
preserves the others; successful result execution still requests republication.
All current descriptors use schema 2 with nonempty named business entries.
A single explicit-policy result has a `default` entry; schema 1 is rejected.

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

- Recovery outside recorded W/S scope coverage, arbitrary external-root rollback
  and complete host-state restoration.
- Complete automatic package/toolchain and resource/device policy synthesis;
  arbitrary multi-environment execution; new fan-in uses local reuse/unbound
  selection, not a package solver.
- **Non-goal:** moving an existing private workspace, rebasing its W/S roots, or
  rebuilding its fixed-layout environment at another physical path. A private
  workspace stays at its allocated location; same-location E recovery remains
  supported. Source-checkout relocation belongs to its external owner; the source
  lifecycle may remove its records, and Runtime does not migrate them.
- Namespace-backed fixed logical paths / transparent cross-slot migration are
  not implemented and are not prerequisites for the current fixed-layout lifecycle.
- Shared working layers, system snapshots and extended snapshot metadata.
- Run/host-wide and Linux/macOS aggregate quotas, disk quotas and bounded GC.
- Native Linux/macOS acceptance and actual reflink/APFS/block-clone outcomes.
- Complete Conda/framework/GPU/platform matrix and large environment/checkpoint
  scan, seal, reconstruction and disk budgets.

Unsupported strong requirements fail closed, not by changing OS, mode, layout
or device. Compiled capability reporting and configured CI are not native
acceptance evidence.

For local native regressions, see [Testing](../development/testing.md) for suite selection, host prerequisites, and explicitly opt-in profiles. The
[offline real-tool baseline](../development/environment-baselines.md) measures
retention costs and records explicit validation gaps; it is not native boundary
acceptance or a publication condition.
