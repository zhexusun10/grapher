# Testing

Use the smallest check that covers the change. A passing focused check is normally enough; broaden only for another affected boundary, a diagnostic reason or an explicit request. Do not rerun unchanged passing checks or reproduce the CI matrix locally. Docs-only edits need a diff/link review, not a build or test suite. Report what you ran and any relevant gap.

## Focused checks

These are alternatives, not steps to run in order:

| Change | Example |
| --- | --- |
| TypeScript types | `npm run check` |
| Browser wire DTOs | `npm run api:generate`, then `npm run api:check`; `node scripts/node-ts.mjs --test scripts/api-protocol.test.ts` |
| JS behavior or a browser flow | `node --test --test-name-pattern="<case>" scripts/<file>.test.mjs` |
| TypeScript behavior | `node scripts/node-ts.mjs --test scripts/<file>.test.ts` (use `node --import tsx --test` for the tsx groups in [test-suites.mjs](../../scripts/test-suites.mjs)) |
| Rust library behavior | `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <filter>` |
| Rust integration behavior | `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --test <target> <filter>` |

Omit the JS name filter to run that file. Rust `--lib` covers `backend/src/`; `--test <target>` covers `backend/tests/`. A filter matching zero cases is not validation. For a compile-only Rust change, use `node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features` instead of a test run.

Reuse existing coverage; add a small regression for changed behavior that is not covered. Assert observable behavior and meaningful failure paths, not source spelling, exact copy, decorative CSS or workflow indentation. An unavailable browser, platform tool or build environment is a validation gap—not a reason to retry unrelated suites.

The [batch-driver Node fixtures](../../backend/src/batch_workspace_tests.rs) embed
`launch-binding.mjs` and `path-identity.mjs` in the Rust test binary and materialize
a temporary adapter copy. A checkout edit therefore cannot switch adapter policy
between the source root and its parallel private children in an already-running
test. Rebuild the Rust test target after editing either module; Cargo tracks these
embedded inputs. The adjacent controlled-update regression uses an import barrier
and disposable modules, never edits the live checkout or runs a model.

## Test and script organization

[package.json](../../package.json) exposes stable npm commands; [test-suites.mjs](../../scripts/test-suites.mjs) owns their ordered commands and explicit file lists. [test.mjs](../../scripts/test.mjs) runs those commands without a shell, preserving the caller's environment (including `CARGO_TARGET_DIR`) and stopping at the first failure. It uses the installed `tsx`, not an `npx` download. There is deliberately no default/all suite: native, browser, build and stress checks have different prerequisites.

```sh
npm run test:list                    # suite scopes, no execution
npm run test:environment -- --list    # exact commands, including build prerequisites; no execution
npm run test:inventory               # missing files, unregistered tests, duplicate tests within a suite, npm wiring
npm run test:scripts                 # runner/setup/dev/build-isolation/release-helper regressions; no Rust build
```

Add each new `scripts/**/*.test.mjs` or `*.test.ts` to a suite, choosing the existing Node/source-resolver/tsx group it needs. Keep costly or platform-specific acceptance explicit. Shared suite references avoid maintaining duplicate lists; the inventory check runs in `test:scripts` and CI. The runner accepts only a suite name and optional `--list`; use the direct file commands above for case filters.

Files stay at their existing paths so fixtures, Rust `include_str!` callers and focused commands remain stable:

| Location / entry | Responsibility |
| --- | --- |
| `scripts/*.test.*`, `scripts/fixtures/` | JS/TS regressions and their browser/native fixtures; fixtures are not standalone suites. |
| `backend/src/*tests*`, `backend/tests/` | Rust library and integration coverage, selected with Cargo. |
| `benchmark/test_*.py` | Harbor adapter tests; see [Harbor](../benchmarks/harbor.md#adapter-tests). |
| `scripts/dev.mjs`, `pi-baseline.mjs`, `cargo.mjs`, `package-release.mjs` | Setup, launch and build/release tooling, not tests. |
| `probe:*`, `scripts/readme-screenshots.mjs`, `scripts/planning-trajectory.mjs` | Opt-in diagnostics/evidence generation, not default validation. |
| `clean:stale`, `cleanup:workspaces` | Explicit maintenance commands; never run these as test cleanup. |

Browser fixtures use the current wire contract. [current-api.mjs](../../scripts/fixtures/current-api.mjs) builds conversation summaries, scoped log pages with `startOffset`, and file-change responses with explicit scope and summary counters. Full output in a synthetic fixture is backing log data; expose its byte count and serve pages through the mocked API. Completed model/thinking labels need recorded metrics. Keep old-format rejection cases separate from these current response builders.

## Build isolation

If a running backend locks artifacts, wrap the **same targeted command**:

```sh
node scripts/temporary-target.mjs -- node scripts/cargo.mjs <original-arguments>
```

The wrapper cleans only its own temporary target; an existing `CARGO_TARGET_DIR` is reused and never deleted. A fresh target may require a cold build. Do not stop the backend or clean its cache. For an npm suite use `npm run test:temporary -- <script>`; `test:isolated` means the full Rust fixture suite, not a single-test workaround. Release builds and [packaging](../../scripts/package-release.mjs) must share the same target directory.

## Managed environment root recovery

Choose the affected boundary; these are not an execution checklist:

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib workspace_files::tests -- --test-threads=1
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib environment::snapshot_tests -- --test-threads=1
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib rooted_terminals_with_w_and_s_bindings -- --test-threads=1
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib rooted_result_reconstructs_missing_w -- --test-threads=1
```

The first two cover versioned checksums, unsupported-format refusal, all-root preflight, missing
blobs, root/coverage mismatch, unbound ownership, recorded absence and preserved
partial retries. They also cover a skipped/unresolvable link at a recorded leaf,
retained cache/link descendants blocking a file replacement before either root
changes, and successful sibling recovery without deleting those live entries.
Retained predecessor cleanup cannot delete/traverse skipped links. These are
recovery regressions, not evidence that omitted link targets are restorable.
The terminal check uses actual native venvs and interpreter/
prefix/ABI validation for W and S restoration, with named result descriptors;
the result check reconstructs a missing W, restores S and checks unchanged
historical execution results. Neither validates host/source compatibility or
native sandbox permissions. Existing `environment::tests::history_` checks
retain legacy refusal coverage.
The [contract](../architecture/native-environments.md#current-state-historical-evidence-and-ownership)
distinguishes current single-root snapshots from root-qualified byte evidence;
retired manifest and launch formats are rejected.

### Native runtime recovery evidence

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib runtime_evidence -- --test-threads=1
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib runtime_project_code_proof -- --test-threads=1
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib streaming_git_blob -- --test-threads=1
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib environment::best_effort_tests::rooted_ -- --test-threads=1
```

Choose the changed boundary rather than running all groups by default. The first checks protocol/old
ABI byte preservation, missing binding root/evidence refusal, root-qualified E versus ownership/cache
proof, full-byte external changes at the same size/mtime, missing roots, redirected
root/file paths and sibling-slot refusal through both physical W and trusted W
aliases, including aliased enclosing workspace buckets. A real native-module
fixture also distinguishes retired ABI-only binding refusal from current-evidence admission
without weakening the old ABI comparison. Selector cases cover schema-1 byte/JSON
compatibility, schema-2 original references, equivalent intermediate aliases,
equal-byte retargets, missing W/S with owned-link continuations, bounded metadata
and targets redirected during observation. Schema-3 cases additionally project
external return paths through immutable E, preserve both old formats, distinguish
staged project paths from live caches, retain early external checks despite code
deferral, and exercise normalized internal links, cycles and platform-native
parent traversal. Relative interpreter-link/POSIX-parent cases are Unix-only;
the Win32 dot-segment case is Windows-only. These use disposable inputs, never edit installed host tools and do
not exercise an OS sandbox.

`streaming_git_blob` verifies fixed-size read requests, native identity agreement
at chunk/hash boundaries, malformed/short/extra responses, read errors, stderr
backpressure and nonzero child exits after valid output. Cancellation tests cover
a blocked reader, isolation from another owner, and direct exit with inherited
pipe holders. A known SHA-mbles vector checks incremental collision rejection
(the raw vector tests the hash finalizer, not a crafted Git-blob collision).
A real 32 MiB file is
verified from loose and packed objects in SHA-1/SHA-256 repositories, after its
working file is removed, without changing refs or the index. This proves bounded
backend buffering, not a measured bound on Git's pack/delta or process-tree RSS.

`runtime_project_code_proof` reads existing graph Git objects: raw binary/ignored
native dependencies in SHA-1 and SHA-256 repositories, later source edits,
missing/corrupt object rejection without live-file repair, file/link/directory
classification and Windows ordinal case aliases (including distinct `K`/`K`,
exact-name precedence and ambiguous fallback refusal). It asserts unchanged source HEAD/index,
refs and immutable view records. A macOS-only case checks that nonexact spelling
is deferred without reading live files or claiming early byte verification;
prepared-file checks still decide those paths. `rooted_runtime_code_tests` injects a new stale
L only into copied history/result/descriptor worker inputs and also checks a
changed composed codeRef; known byte mismatches must preserve partial W/S or keep
missing W absent. Supported evidence schemas retain their checks.

The `rooted_` group includes real native venvs: remove their captured interpreter bin
folders, preflight without running those broken prefixes, restore W/S and verify
actual executable/prefix/ABI; check old L with omitted evidence/root fields;
exercise a W↔S switch and missing-W result reconstruction. The nested
`rooted_runtime_selector_tests` creates a real venv through a disposable external
Python alias; retargeting it must fail before either result-worker or descriptor
code reconstruction, while an unchanged alias still permits restoring a missing
interpreter. `rooted_runtime_return_native_tests` loads a real `_hashlib` module
through an external alias back into W and S in turn: equal-byte retargets must
fail before descriptor/result reconstruction, while valid dangling aliases permit
missing-W/prefix recovery followed by an actual native import. It uses the normal
publication/result lifecycle, not a reset of failed-run state. No installed Python
bytes are modified. A real `_hashlib` native
extension installed as a tracked project dependency through explicit fixture
business configuration is delivered/restored only through codeRef, never E;
its S venv interpreter and W are removed before a genuine import/result launch.
The fixture copies one named extension, not HOME or a complete host toolchain,
and Runtime does not rewrite its binary or `.pth` paths. Error injection creates
a **new** stale L and changes only a copied fixture worker input, not historical
records or installed libraries. Known bad native inputs must leave code, both
roots and historical results intact, including before missing-W reconstruction
in both result execution and publication-descriptor preparation.
These are recovery checks, not provider or Linux/macOS/Windows sandbox acceptance.
Production builds contain neither the worker fault-injection helper nor fixture
actuators. [The contract](../architecture/native-environments.md#native-runtime-inputs-during-recovery)
defines the bounded coverage and legacy limitations. Windows push CI explicitly
runs the runtime-evidence units beside `rooted_`; other event/platform paths use
the existing library suites. Configured CI is not a claim of a passing platform.

## Zero-configuration source HOME discovery (not implemented)

The functional acceptance target is explicitly opt-in and currently **fails**:

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib zero_configuration_home_source_and_parent_without_setup -- --ignored --nocapture --test-threads=1
```

It runs one unchanged ordinary HOME-reading/writing workload in source, then the
first private execution and two independent children. It checks latest-parent
config precedence, independent state, unchanged source and no bulk persistence
of an unrequested sensitive-file canary. The source HOME is an owned temporary
fixture passed through the ordinary process environment; no real host HOME is
modified, no tool-path config/query API is supplied, and no model chooses an E/L.
A subprocess keeps the fixture's environment out of other parallel tests. Passing
component or explicit-path Cargo checks cannot substitute for this target.
See the [required contract and native blocker](../architecture/native-environments.md#zero-configuration-source-home-discovery).

## Private HOME branch inheritance

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib unbound_home_fork -- --test-threads=1
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib home_fork_metadata -- --test-threads=1
```

These cover new-slot immutable HOME inheritance, two successive fan-outs,
per-branch native Node reads, cache exclusions, partial retry preservation,
append-only replay, common-descendant versus divergent fan-in, the frozen
descendant rule, internal link rebasing and retained-prefix/legacy non-adoption.
They also cover occupied-target runnable preservation (independent of diagnostic
reason strings), explicit restoration despite old fork provenance, ineligible
ancestors of an eligible newer frame, and missing parent bytes with matching
live target data that must not repair history. Existing bound-environment fan-out tests remain authoritative
for the no-venv-relocation boundary. This is a Runtime component check, not native
sandbox acceptance or a claim that paths embedded in copied configuration relocate.
The ordinary environment library suite includes these tests.

## Offline project environment baseline (opt-in)

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib environment_project_baseline -- --ignored --nocapture --test-threads=1
```

[Procedures and report definitions](environment-baselines.md) cover offline
Node/npm, real Python venv/PEP-517/uv and Rustup/Cargo projects, source drift,
concurrent forks, composition, managed E capture/materialization and storage
amplification. Missing uv is explicitly NOT RUN unless required (CI requires it).
This component probe does not run a native sandbox, validate host compatibility
or gate publication. Failed profiles retain diagnostics and completed measurements
before failing; missing phases are not validated. Native boundary/lifecycle
acceptance remains separate below.

For the narrower dirty managed-state preflight/materialization cost, without
project Git preparation:

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib managed_recovery_preflight_benchmark -- --ignored --nocapture --test-threads=1
```

Its synthetic distributions and measurement limits are documented in
[the baseline procedure](environment-baselines.md#managed-dirty-view-recovery-cost-opt-in).
Use `--lib workspace_files::tests` for regressions covering read-only successful
and refused preflight, same-size/mtime blob corruption and legacy restoration.

## Immutable dependency sealing comparison (opt-in)

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib environment_dependency_sealing_benchmark -- --ignored --nocapture --test-threads=1
```

[Procedure and limits](environment-baselines.md#immutable-dependency-sealing-optimization)
cover no-op/changed E capture, duplicate dependencies, concurrent writers and
store growth versus a test-only unbatched reference. `GRAPHER_ENV_SEAL_PROBE_REPORT`
can retain a new JSON report. There are no timing thresholds or native sandbox
claims. Use the existing `--lib workspace_files::tests` and
`--lib environment::snapshot_tests` checks for full-byte, scope/mode, legacy,
corruption/missing-history and append-only generation-record regressions. The
real Python baseline separately asserts three no-op seals have zero store growth
and restores both captured and explicitly patched installed dependencies.

## Workspace staging microbenchmark (opt-in)

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib staging_bench::delta_index_staging -- --ignored --nocapture --test-threads=1
```

[The probe](../../backend/src/graph_merge/publication/staging_bench.rs) creates disposable
repositories with 64 and 50,000 result paths, then compares warm full-index and
delta-index staging for a small delta, plus an all-files-changed case on the small
repository. It checks staged bytes and index entries, and reports time and index
size without timing thresholds. This does **not** measure
source collection, composition, atomic delivery or end-to-end Run latency.

## Workspace view equality microbenchmark (opt-in)

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib view_equality_benchmark -- --ignored --nocapture --test-threads=1
```

[The comparison probe](../../backend/src/workspace_view/equality_tests.rs) measures
legacy normalized-JSON equality against borrowed-field equality on 5,000 project
and 1,000 Git metadata entries, including a late difference. It excludes filesystem
scanning and checksum computation. The adjacent differential tests pin the
schema-5 serializer/checksum and cover schema-6 ACL/path identity separately.

## Workspace view normalization probe (opt-in)

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib view_normalization_benchmark -- --ignored --nocapture --test-threads=1
```

[The probe](../../backend/src/workspace_view/equality_tests.rs) compares the
legacy full-JSON construction, the previous borrowed-projection/JSON-DOM path,
and direct borrowed serialization. Cases include empty, ordinary and large
security descriptors; every output must match
byte-for-byte. Five warm samples alternate order and report medians in Cargo's
test profile. The adjacent differential tests cover serialized scalars, variants,
optional fields, nested repositories and legacy owners, and pin the historical
checksum and full stored JSON. Current-schema tests also reject ACL corruption
while loading legacy records without rewriting them. Native ACL-only snapshot,
fork and composition checks on Windows/macOS use `--lib workspace_view::acl_tests`.
This measures in-memory normalization only, not
filesystem scans, object staging or end-to-end task latency.

## Native project-index flag batching probe (opt-in)

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib index_flag_batching_benchmark -- --ignored --nocapture --test-threads=1
```

[The probe](../../backend/src/workspace_git_index_tests.rs) compares the former
per-path Git flag updates with batched restoration on 65/257 index entries,
including zero-flag and mixed assume-unchanged/skip-worktree cases. Three warm
samples alternate order, resetting the disposable index outside the timed region
and independently checking all resulting paths, modes, object IDs and flags.
It measures flag restoration only, not scanning, staged-object transfer, full
composition, publication or end-to-end handoff latency; there are no timing
assertions. Adjacent SHA-1/SHA-256 regressions cover literal unusual paths,
intent-to-add combinations, deleted intent paths and their recorded executable/
link modes, `core.ignorestat` flag injection, staged binary content, deletions,
flag clearing, intent-only changes on a committed empty blob, sparse-checkout
selection, foreign index locks during initial copying as well as flag updates,
copy failure/absent-index recovery, byte-exact case/Unicode aliases and aliased
directory prefixes under `core.ignorecase`, unchanged input indexes and retry. The
[workspace-view regressions](../../backend/src/workspace_view_tests.rs) also
exercise deleted, case-aliased intent-to-add through snapshot, fan-in, publication
and follow-up preparation without recreating the missing project files.

## Workspace scan and staging phase probes (opt-in)

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib scan_bench::file_scanning_benchmark -- --ignored --nocapture --test-threads=1
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib scan_bench::snapshot_staging_benchmark -- --ignored --nocapture --test-threads=1
```

[The disposable-fixture probes](../../backend/src/workspace_view/scan_bench.rs)
compare the former fixed file-count partitions with the production collector.
The scan cases cover below-threshold projects, uniform small files, clustered
or scattered large files, and one dominant large file. Each strategy performs
fresh content/metadata reads; full serialized entries must match. Five warm
samples alternate strategy order and report median file-resolution time, with
walk/enumeration time reported separately. The staging probe reports fresh-scan
and warm object/index-staging times separately for 64 files in SHA-1 and SHA-256
repositories, checking that each repeat produces the same tree.

These are local component measurements in Cargo's test profile, not cold-cache
or end-to-end preparation/handoff/publication speedups. Below-threshold scans
use the same sequential code in both strategies, so small differences there
are measurement noise. There are no timing assertions or production diagnostics.

## SHA-256 blob batching probe (opt-in)

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib sha256_blob_batching_benchmark -- --ignored --nocapture --test-threads=1
```

[The probe](../../backend/src/workspace_view/sha256_stage_bench.rs) retains the
former per-file implementation as a test-only reference. Separate disposable
SHA-256 object stores compare a singleton, 64/256 small files, and mixed small
files with larger streaming inputs. It checks identical result trees after each
operation, reports empty-object-store timings and three alternating warm samples
per strategy, and excludes fixture creation and the independent initial scan.
File caches are already warm even for the empty-store measurements. This is a
staging-component measurement in Cargo's test profile, not an end-to-end speedup.

[Focused regressions](../../backend/src/workspace_view/sha256_stage_tests.rs)
cover raw binary/protocol-looking bytes, path/mode preservation, batch limits,
pre/post-import changes, malformed/failed/null-OID imports, unchanged Git evidence,
Windows byte-exact executable-bit inheritance, and retry. `publication_recovery` also covers SHA-256 packed-object delivery without
source-Git leakage and SHA-1/SHA-256 partial-checkout recovery.

## Workspace cleanup lock probe (opt-in)

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib workspace_cleanup_lock_benchmark -- --ignored --nocapture --test-threads=1
```

[The probe](../../backend/src/cleanup_bench.rs) creates disposable completed Runs
with 64, 5,000 and 20,000 small files. It compares synchronous cleanup under the
Run mutex with durable directory retirement followed by out-of-lock deletion.
Three fresh fixtures per strategy alternate order and report medians for Run-lock
hold time, a concurrent metadata reader's wait, and cleanup total time (including
deletion for both strategies). Source sentinels and session history must survive,
and all detached receipts must be drained. It performs no model calls and touches
no retained user workspace. This is a local test-profile filesystem/lock probe,
not an HTTP, provider or end-to-end task benchmark. Lower lock/read latency does
not imply faster physical deletion; there are no timing assertions.

## File-change persistence lock probe (opt-in)

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib file_summary_persistence_benchmark -- --ignored --nocapture --test-threads=1
```

[The probe](../../backend/src/file_changes/persistence_bench.rs) seeds temporary
sidecars and cache entries for 4×20, 20×500 and 40×1,250 execution/path pairs,
with overlapping log/Git summaries and an unloaded historical execution. Three
samples alternate the former locked-merge algorithm and the production snapshot/
merge helpers, resetting the prior sidecar each time. It reports cache-copy time,
global cache-lock hold time, an unrelated cache reader's wait, and processing
through sidecar publication. All serialized results must match byte-for-byte,
including the actual `persist_run` entry point. This local test-profile probe
makes no model calls and changes no retained user data. It does not measure
HTTP latency or end-to-end node completion; lower global lock contention does
not imply that full-sidecar read/serialization/write costs disappeared. There
are no timing assertions.

## Broader suites (on demand)

[test-suites.mjs](../../scripts/test-suites.mjs) owns the exact composition; `npm run test:<suite> -- --list` previews it. These are available tools, not completion requirements.

| Script | Scope / prerequisites |
| --- | --- |
| `test:frontend`, `test:backend` | Frontend logic; full Rust fixture suite. |
| `test:ui` | Fast mocked-API feature browser flows. Needs Chromium or `GRAPHER_BROWSER_CHANNEL` (Edge on Windows). No production build. |
| `test:ui:audit` | Deep mocked-API transcript, history and layout audit browser suites; same browser requirement. |
| `test:bundle` | Separate temporary production build and deferred-loading browser checks; same browser requirement. |
| `test:ui-polish` | Separate bilingual home/settings viewport sweep; same browser requirement. `GRAPHER_UI_SCREENSHOTS` optionally saves screenshots. |
| `test:pi`, `test:extensions` | Pi transport and [role/tool contracts](pi-integration.md#role-loading-policy). `test:extensions` also typechecks the Planner extension, which is outside the frontend `npm run check` scope. |
| `test:native`, `test:native:scripts`, `test:planner-bash` | Native paths, launchers, Planner workspace rebinding and Bash semantics. `test:native:scripts` omits Rust tests; it still needs pinned Pi and Git/Bash. |
| `test:filesystem` | Native ACLs, path identity, links and versioned snapshot integrity; Rust/Git, no browser or model calls. |
| `test:prewarm` | Separate prewarm tests, production build and HTTP/native acceptance. |
| `test:environment`, `test:environment:acceptance`, `test:environment-chain` | Environment admission/lifecycle; `test:environment:acceptance` omits the Rust unit checks already covered by `test:backend`. Needs Python 3.11+, Git, Bash and the platform boundary. |
| `test:merger`, `test:bindings` | Git composition/publication and project binding/routing. |
| `test:hardening`, `test:windows-native`, `test:macos-browser` | Production HTTP/filesystem or host-specific acceptance; macOS browser acceptance also needs a browser. |
| `test:concurrent` | Fixture HTTP concurrency; needs `/bin/sh`, skipped on Windows. |
| `test:conversation-acceptance` | Current-format logs, restart and browser acceptance; see [prerequisites](conversation-logs.md#acceptance-prerequisites). |

Native suites need the real [platform boundary](../architecture/filesystem-isolation.md#platform-boundaries): bubblewrap/permitted namespaces on Linux, Seatbelt on macOS. Windows environment tests accept `GRAPHER_ENV_TEST_PARENT` for a short path. Environment-native, environment-chain and node-Merger fixtures seed historical runs to test retained private-workspace compatibility; new adaptive behavior lives in workspace-policy/batch tests and shared-native acceptance.

Native extension relocation fixtures select a Python on `PATH` with a file-backed
`_hashlib` module so they can copy and corrupt a genuine shared library. Other
environment/probe tests keep the default Python, including builds with built-in
extensions. Permission fixtures set their required modes explicitly and do not
require changing the runner's umask. Linux process-drain regressions include
zombie-only groups and zombie leaders with live threads; the latter builds a
small pthread fixture with the C compiler already required by the native build.

Offline Conda/ML profiles are opt-in via `GRAPHER_ENV_TEST_CONDA_MANIFEST` or `GRAPHER_ENV_TEST_ML_MANIFEST`; [environment-native.test.ts](../../scripts/environment-native.test.ts) defines inputs. Harbor has separate [Linux prerequisites](../benchmarks/harbor.md#adapter-tests).

## Files-only publication acceptance

Focused coverage lives in [files_only_publication.rs](../../backend/tests/files_only_publication.rs), [publication_recovery.rs](../../backend/tests/publication_recovery.rs), and [workspace_view_tests.rs](../../backend/src/workspace_view_tests.rs); Planner switching is covered by `planner_workspace_tests` and [planner-workspace-runtime.test.ts](../../scripts/planner-workspace-runtime.test.ts). Choose the affected target rather than running all publication suites.

For changes that need the complete real-backend path:

```sh
node scripts/cargo.mjs build --manifest-path backend/Cargo.toml --no-default-features --bin grapher
node scripts/accept-files-only-publication.mjs
```

This uses pinned Pi, native Git/Bash, a deterministic local provider and disposable projects. It covers branching, fan-in repair, publication and restart/retry, including unchanged source Git history and no duplicate delivery. It stops only its own child backend; evidence remains in the printed temporary directory. Use the same independent `CARGO_TARGET_DIR` for both commands if normal artifacts are locked. Linux/macOS require their native platform boundary.

## CI

[planner-source.yml](../../.github/workflows/planner-source.yml), [release.yml](../../.github/workflows/release.yml) and [security-audit.yml](../../.github/workflows/security-audit.yml) own CI coverage.

Planner Source Contract runs on main pushes, pull requests, its weekly schedule
and manual dispatch. Its dedicated macOS filesystem job runs `test:filesystem`
on both Apple Silicon (`macos-15`) and Intel (`macos-15-intel`), first on the host
volume and then with temporary fixtures on an explicitly mounted case-sensitive
APFS sparse image. A real case probe must succeed before testing, so sensitive
path branches cannot silently be skipped on a case-insensitive volume; the image
is detached on success or failure. The ARM job also installs pinned Pi and
Playwright Chromium and runs `test:macos-browser`; failure logs are retained for
seven days as an artifact. Failures fail the workflow; no `continue-on-error`
is used. Requiring these checks for merging remains a branch-protection setting.

A focused **Windows PTY lifecycle** job runs the shared native terminal tests,
including ConPTY's startup cursor-position handshake and natural-exit drain,
without waiting for the broad library suite. The full Windows library suite
uses the same `fixture` feature as the Linux/macOS backend suites so synthetic
execution completions retain their explicit test-only evidence.

Windows pushes run the focused filesystem suite; PR/scheduled/manual runs retain
the full Windows library suite. The Linux/macOS backend suites also execute the
applicable POSIX-link and snapshot regressions. Weekly scheduled and manual CI runs also explicitly provision pinned uv and retain the model-free
[dependency-cost report](environment-baselines.md) for seven days; this is a
component measurement, not a replacement for its real native-boundary checks.
Windows pushes additionally run focused `rooted_` capture/recovery regressions,
including NTFS aliases/junctions and real W/S interpreters; other matrix/event
paths cover them in their existing backend/environment suites. These component
checks do not claim an OS sandbox on Windows. Windows pushes also run the
trusted Node bootstrap-isolation check; other matrix/event paths cover it in
the existing backend suites.
Configuring a job is not evidence
that it passed: inspect the corresponding CI run. Model-free checks do not
establish provider quality or every sandbox boundary.
