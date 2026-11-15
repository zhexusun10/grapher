# Workspace environment baselines

This is a small, reproducible **component baseline**, not a compatibility matrix,
model evaluation, native sandbox substitute, or publication check. Production
publication does not run it and does not require host/node environment agreement.
The [native environment contract](../architecture/native-environments.md) owns
execution, ownership and recovery behavior.

## Run only the needed profile

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib environment_project_baseline -- --ignored --nocapture --test-threads=1
```

[The probe](../../backend/src/workspace_view/environment_probe.rs) reuses the
workspace-view test helpers and production snapshot/prepare/compose APIs. It
creates disposable projects and real local packages, invokes installed native
tools, and never calls a model, registry, updater or installer for host tools.
Prerequisites: Node/npm, Git, native Python with venv/ensurepip, Rustup shims on
PATH with an already installed default Cargo/Rustc toolchain, and a native linker. Local npm
installation and PEP-517/pip installation are explicitly offline. This is not a
large application or arbitrary venv/Conda relocation test.

Optional environment variables:

- `GRAPHER_ENV_PROBE_PROJECTS=node,python,cargo`: explicit subset for focused
  checks; omitted profiles are not validated.
- `GRAPHER_ENV_PROBE_FILES=128`: 1–4096 distinct roughly 4-KiB Node dependency
  payloads. Compare separate runs/sizes; there are no timing thresholds.
- `GRAPHER_ENV_TEST_PARENT`: short disposable parent, particularly on Windows.
- `GRAPHER_ENV_PROBE_REPORT`: **new** JSON report path; refuses to overwrite an
  existing report. Reports contain local paths/interpreter identities, not an
  environment-variable or HOME inventory. Keep machine reports in CI artifacts,
  not versioned per-run diaries.
- `GRAPHER_ENV_PROBE_UV`: optional explicit installed uv executable. Otherwise
  checks PATH for uv. An invalid explicit executable fails. Missing uv is
  recorded as **NOT RUN**, not replaced by a passing Python invocation.
- `GRAPHER_ENV_PROBE_REQUIRE_UV=1`: requires the Python profile and real uv
  coverage. CI provisions pinned uv explicitly and uses this setting.

| Profile | Actual execution and evidence |
| --- | --- |
| Node | Offline npm installation of a local package, independent installed bytes, ignored `node_modules`, local patch without a dependency declaration/installed package manifest, a Git-tracked dependency, real build script and ignored `.next` output, native Node execution. No dependency regeneration from today's source. |
| Python | Real `venv --copies`, offline PEP-517 backend/pip installation, patched installed package, actual interpreter/prefix/base-prefix/ABI evidence, source-less `.pyc` import. With uv installed, real `uv run --offline --no-sync --python …` must report the same interpreter/prefix/value. `--no-sync` deliberately does not erase a local package patch. |
| Cargo | Offline Cargo project with a local path dependency; successful source-default Rustup selection, actual private-HOME default-selection failure, and successful explicit installed Cargo/Rustc/Rustdoc invocation with private Cargo state/target. No download, `rustup default`, host modification or automatic runtime fallback. |

Each profile captures the source, changes its live dependency, prepares a node
from the earlier record, edits the node dependency, seals it, forks/seals two
concurrent branches and composes them. Mutating one branch must not affect its
parent, sibling, source or composed view. A fresh reconstruction must still use
recorded bytes. Source Git HEAD/index remain unchanged. The Python profile also
measures root-qualified managed W `.venv` plus S private-config capture, full
byte validation and all-root byte materialization separately, and checks
source/restored mutations cannot alter stored evidence. Cache carve-outs stay
untouched. The report identifies `rooted.schema = 1` coverage explicitly.
This does not establish that copied console scripts or editable installs relocate.

Python additionally executes an **explicit** project reconstruction in a fresh
prefix under the composed workspace's S: installed bootstrap `venv --copies
--without-pip`, then the same workspace's recorded `python -m pip --python
<new-interpreter> install --no-index --no-deps --no-build-isolation --no-compile .`.
It verifies the real new executable, prefix/base-prefix and ABI. This avoids
assuming an installer bootstrap works at every deep Windows path; it is one
predeclared flow on every platform, not retry with a silently different layout.
The rebuilt package deliberately lacks the captured installed local patch. The
report therefore records **not byte-equivalent / no automatic adoption**, despite
successful installation and matching ABI. It neither binds the environment nor
replaces the original snapshot; this is business-workflow evidence, not a generic
rebuild service or proof that manifests reproduce installed dependencies.

## Read measurements correctly

JSON reports include native tool versions, setup, source snapshot, prepare, node seal, per-worker
fork/seal, concurrent wall time, merge preparation and immutable reconstruction.
They include source file/directory/link counts and logical bytes, graph storage,
five retained private views plus their external metadata/state, and their ratio
to source project bytes. The Python S reconstruction is included in retained
private-state bytes. Managed E storage/restored-view sizes are separate from
that ratio. Git-tracked files and ignored dependencies use the existing single
project delivery channel; no delivery semantics are changed by the probe.

Resource counters record cumulative **test-process-only** CPU and peak RSS
before/after concurrent operations. Peak RSS is a process high-water mark, not a
per-phase allocation delta. Child Git/compiler resources, host-wide peak load,
allocated disk blocks, cold filesystem caches, full task latency, write-back and
large dependency distributions remain measurement gaps. Test-profile timings are
not a production speedup or evidence of reflink/block-clone support. Expensive
retention is not fixed merely because a small project passes.

The CI [Planner Source Contract](../../.github/workflows/planner-source.yml)
retains JSON reports for Windows, Linux and macOS. Those component runs remain
separate from its actual native launcher, bubblewrap/Seatbelt, lifecycle and
filesystem checks. A configured CI step is not a passing CI run. Missing tools,
namespace permission or unexecuted platforms are gaps, never replacement fixture
or unisolated acceptance.

## Private HOME: discovery is not mutable state

The Cargo case demonstrates a general failure class: retaining a tool shim on
PATH does not retain the configuration the shim normally finds through HOME.
Rustup's private-HOME error says no default is configured, even though the host
can build. Do **not** follow its suggested download automatically.

Keep these concerns separate:

| Concern | Explicit approach; current limitations |
| --- | --- |
| Toolchain discovery | A project business command/config can name already installed native executable paths. In the Cargo baseline, invoke the actual installed Cargo and set `RUSTC`/`RUSTDOC` to the corresponding real compiler/documentation binaries. Obtain these paths on the host with `rustup which --toolchain <already-installed-id> cargo` (and `rustc`/`rustdoc`). This explicit setup is not an engine-selected fallback or a promise that a host toolchain path is immutable. |
| Workspace-writable state | Keep HOME private. Set `CARGO_HOME="$HOME/.cargo"` and use the workspace's own target directory. Do not point it or `RUSTUP_HOME` at a shared writable host environment just to recover discovery. Other tools need their own documented project workflow; do not infer it from task text or directory names. |
| Rebuildable cache | An explicitly populated, private cache is different from the immutable installed dependency snapshot. An empty cache cannot replace offline preinstalled or locally patched dependencies. Missing cache/package evidence must fail rather than download implicitly. |
| Configuration and sensitive values | Existing explicitly authorized business variables (including proxy/certificate settings and credential helpers) remain transient. A project may explicitly name a necessary config file under existing permissions. Do not copy a whole HOME/config tree, persist a credential inventory, or grant source access. Files deliberately written into managed scopes are not automatically secret-scrubbed. |

The general extension point should be **explicit project business workflows**,
not a language-name admission table: identify read-only installed tool/config
inputs separately from per-slot writable state and cache; name credential helpers
rather than snapshotting secret values; record real interpreter/prefix/ABI/byte
proof after execution. Declarations alone cannot authorize compatibility or
select an environment. There is currently no generic host-config import or
transparent cross-layout rebuilding API. Business Node options remain excluded
from engine Node/Git, hook capture and extension/MCP factories.

## Storage/rebuild directions (not implemented)

The current correctness baseline retains installed bytes. Any proposed controlled
cache or immutable dependency layer must first preserve these properties:

1. Offline preinstalled dependencies and dependencies without manifests are
   captured from actual bytes, not reconstructed from a manifest or cache hit.
2. Local patches, new ignored dependencies and explicit dependency edits create
   new immutable evidence and propagate through ordinary project/E inheritance.
   A package-manager reinstall is not equivalent evidence and cannot silently
   discard those edits.
3. Git-tracked dependency content keeps its current project Git/index/metadata
   behavior. No second source publication path or new environment delivery gate.
4. A shared immutable byte store may back **independent** materialized views
   (e.g. a verified copy-on-write native copy); never writable hardlinks or shared
   mutable environments. Every retained/reused/materialized byte still receives
   the existing full integrity checks. Size/mtime is not authorization.
5. Old single-root E/L and project records remain readable/retryable without
   rewriting their checksum, manifest or execution result. Current root-qualified
   E records cover declared W/S scopes in one checksummed manifest; they do not
   retrofit missing other-root evidence into old records. Further storage layers
   must retain those root/scope/cache identities and complete immutable bytes;
   missing history cannot be repaired from today's live directories.
6. Explicit offline reconstruction needs both declared inputs and real runtime
   evidence; it must report when its installed result differs from captured local
   patches, remain unbound if equivalence cannot be proved, and never borrow a
   sibling's mutable prefix/cache. Arbitrary launcher/editable/binary rewriting
   and arbitrary Conda migration remain out of scope.

Before adopting a storage optimization, measure the affected capture, validation,
materialization and concurrent phases on retained dependency distributions.
Changes to file delivery require a separately reviewed proposal; this baseline
neither changes byte integrity nor promises lower write-back cost.
