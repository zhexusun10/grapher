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

Browser fixtures use the current wire contract. [current-api.mjs](../../scripts/fixtures/current-api.mjs) builds conversation summaries, scoped log pages with `startOffset`, and file-change responses with explicit scope and summary counters. `fixtureFileChangeSummary` constructs complete synthetic row sets; production summary totals and scope aggregation belong to the backend. Full output in a synthetic fixture is backing log data; expose its byte count and serve pages through the mocked API. Completed model/thinking labels need recorded metrics. Keep old-format rejection cases separate from these current response builders.

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

## Opt-in baselines and microbenchmarks

All probes below are explicitly opt-in (`#[ignore]`), run in Cargo's test profile with disposable fixtures, make no model calls, enforce no timing thresholds, and are local component measurements—not native sandbox acceptance or end-to-end Run latency claims:

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <filter> -- --ignored --nocapture --test-threads=1
```

| `--lib` filter | Source | Scope and limits |
| --- | --- | --- |
| `environment_project_baseline` | [environment_probe.rs](../../backend/src/workspace_view/environment_probe.rs) | Offline Node/npm, Python venv/PEP-517/uv, and Rustup/Cargo baseline (source drift, forks, composition, managed E sealing/materialization, storage ratios). Missing `uv` is `NOT RUN` unless required. See [environment-baselines.md](environment-baselines.md). |
| `managed_recovery_preflight_benchmark` | [environment_probe.rs](../../backend/src/workspace_view/environment_probe.rs) | Dirty managed-state preflight/materialization cost without project Git preparation; see [managed dirty-view recovery](environment-baselines.md#managed-dirty-view-recovery-cost-opt-in). |
| `environment_dependency_sealing_benchmark` | [seal_tests.rs](../../backend/src/workspace_files/seal_tests.rs) | No-op/changed E capture, duplicate dependencies, concurrent writers, and store growth (`GRAPHER_ENV_SEAL_PROBE_REPORT`); see [sealing optimization](environment-baselines.md#immutable-dependency-sealing-optimization). |
| `staging_bench::delta_index_staging` | [staging_bench.rs](../../backend/src/graph_merge/publication/staging_bench.rs) | Warm full-index vs. delta-index staging on 64 and 50,000 paths (excludes source collection, composition, and atomic delivery). |
| `view_equality_benchmark` | [equality_tests.rs](../../backend/src/workspace_view/equality_tests.rs) | Legacy normalized-JSON vs. borrowed-field equality on 5,000 project + 1,000 Git metadata entries (excludes scanning/checksums). |
| `view_normalization_benchmark` | [equality_tests.rs](../../backend/src/workspace_view/equality_tests.rs) | Legacy JSON DOM vs. direct borrowed serialization for schema-6 checksums (in-memory only; use `--lib workspace_view::acl_tests` for native ACL regressions). |
| `index_flag_batching_benchmark` | [workspace_git_index_tests.rs](../../backend/src/workspace_git_index_tests.rs) | Per-path vs. batched Git index flag restoration on 65/257 entries (flag restoration only; adjacent tests cover SHA-1/SHA-256 intent-to-add, sparse checkout, and case aliases). |
| `scan_bench::file_scanning_benchmark`, `scan_bench::snapshot_staging_benchmark` | [scan_bench.rs](../../backend/src/workspace_view/scan_bench.rs) | Parallel regular-file scanning and SHA-1/SHA-256 object/index staging on disposable fixtures (warm caches only). |
| `sha256_blob_batching_benchmark` | [sha256_stage_bench.rs](../../backend/src/workspace_view/sha256_stage_bench.rs) | Per-file vs. batched `fast-import` SHA-256 blob staging (adjacent [sha256_stage_tests.rs](../../backend/src/workspace_view/sha256_stage_tests.rs) covers correctness/limits). |
| `workspace_cleanup_lock_benchmark` | [cleanup_bench.rs](../../backend/src/cleanup_bench.rs) | Run-lock hold time and concurrent reader wait for synchronous vs. detached out-of-lock cleanup on 64–20,000 files (lower lock wait does not imply faster disk deletion). |
| `file_summary_persistence_benchmark` | [persistence_bench.rs](../../backend/src/file_changes/persistence_bench.rs) | Global cache-lock hold time and reader wait for file-change sidecar persistence on 4×20 to 40×1,250 execution/path pairs. |

## Broader suites (on demand)

[test-suites.mjs](../../scripts/test-suites.mjs) owns the exact composition; pass `-- --list` to any `test:*` script in `package.json` to preview its commands. These are available tools, not completion requirements.

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
| `test:build-cache`, `test:release`, `test:desktop` | Temporary Cargo target isolation (`build-cache`), release launcher/updater/signing contracts (`release`), and full Tauri v2 desktop shell/migration/packaging suite (`desktop`). |

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
and manual dispatch. Linux runs the full fixture and frontend suites on every
event; macOS runs the full fixture suite on pull requests, the weekly schedule
and manual dispatch, while Linux remains the routine host-neutral gate for
pushes. Windows uses focused platform-specific coverage rather than repeating
the full host-neutral library suite. The dedicated macOS filesystem job runs
`test:filesystem` on both Apple Silicon (`macos-15`) and Intel
(`macos-15-intel`) host volumes, and runs the case-sensitive APFS sparse-image
variant once on Apple Silicon. A real case probe must succeed before testing,
so sensitive path branches cannot silently be skipped on a case-insensitive
volume; the image is detached on success or failure. The ARM job also installs
pinned Pi and Playwright Chromium and runs `test:macos-browser`; failure logs
are retained for seven days as an artifact. Failures fail the workflow; no
`continue-on-error` is used. Requiring these checks for merging remains a
branch-protection setting.

The frontend contract suite is host-neutral and runs once on Linux. Native
launcher, production HTTP hardening, prewarm, filesystem, Bash and platform
acceptance checks remain on the hosts where their process, path, sandbox or
native API behavior can differ.

A focused **Windows PTY lifecycle** job runs the shared native terminal tests,
including ConPTY's startup cursor-position handshake and natural-exit drain.
The Windows Planner job runs its focused ACL/path checks on every event. Windows
pushes additionally run focused `rooted_` capture/recovery regressions,
including NTFS aliases/junctions and real W/S interpreters, plus runtime-evidence
and trusted-bootstrap checks; Linux/macOS full fixture runs cover their
host-neutral counterparts. These component checks do not claim an OS sandbox on
Windows. Weekly scheduled and manual CI runs also explicitly provision pinned
uv and retain the model-free [dependency-cost report](environment-baselines.md)
for seven days; this is a component measurement, not a replacement for its real
native-boundary checks. Configuring a job is not evidence that it passed:
inspect the corresponding CI run. Model-free checks do not establish provider
quality or every sandbox boundary.
