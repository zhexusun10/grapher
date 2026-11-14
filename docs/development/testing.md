# Testing

Use the smallest check that covers the change. A passing focused check is normally enough; broaden only for another affected boundary, a diagnostic reason or an explicit request. Do not rerun unchanged passing checks or reproduce the CI matrix locally. Docs-only edits need a diff/link review, not a build or test suite. Report what you ran and any relevant gap.

## Focused checks

These are alternatives, not steps to run in order:

| Change | Example |
| --- | --- |
| TypeScript types | `npm run check` |
| JS behavior or a browser flow | `node --test --test-name-pattern="<case>" scripts/<file>.test.mjs` |
| TypeScript behavior | `node scripts/node-ts.mjs --test scripts/<file>.test.ts` (use `node --import tsx --test` for the tsx groups in [test-suites.mjs](../../scripts/test-suites.mjs)) |
| Rust library behavior | `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <filter>` |
| Rust integration behavior | `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --test <target> <filter>` |

Omit the JS name filter to run that file. Rust `--lib` covers `backend/src/`; `--test <target>` covers `backend/tests/`. A filter matching zero cases is not validation. For a compile-only Rust change, use `node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features` instead of a test run.

Reuse existing coverage; add a small regression for changed behavior that is not covered. Assert observable behavior and meaningful failure paths, not source spelling, exact copy, decorative CSS or workflow indentation. An unavailable browser, platform tool or build environment is a validation gap—not a reason to retry unrelated suites.

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
| `clean:stale`, `cleanup:workspaces`, `compact`, `migrate` | Explicit maintenance commands; never run these as test cleanup. |

## Build isolation

If a running backend locks artifacts, wrap the **same targeted command**:

```sh
node scripts/temporary-target.mjs -- node scripts/cargo.mjs <original-arguments>
```

The wrapper cleans only its own temporary target; an existing `CARGO_TARGET_DIR` is reused and never deleted. A fresh target may require a cold build. Do not stop the backend or clean its cache. For an npm suite use `npm run test:temporary -- <script>`; `test:isolated` means the full Rust fixture suite, not a single-test workaround. Release builds and [packaging](../../scripts/package-release.mjs) must share the same target directory.

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
scanning and checksum computation. The adjacent differential tests compare the new
projection with the unchanged serializer and pin a legacy fixture checksum.

## Workspace view normalization probe (opt-in)

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib view_normalization_benchmark -- --ignored --nocapture --test-threads=1
```

[The probe](../../backend/src/workspace_view/equality_tests.rs) compares the
legacy full-JSON construction with the borrowed checksum projection. Cases
include empty, ordinary and large security descriptors; every output must match
byte-for-byte. Five warm samples alternate order and report medians in Cargo's
test profile. The adjacent differential tests cover serialized scalars, variants,
optional fields, nested repositories and legacy owners, and pin the historical
checksum and full stored JSON. This measures in-memory normalization only, not
filesystem scans, object staging or end-to-end task latency.

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
| `test:ui` | Mocked-API browser flows. Needs Chromium or `GRAPHER_BROWSER_CHANNEL` (Edge on Windows). No production build. |
| `test:bundle` | Separate temporary production build and deferred-loading browser checks; same browser requirement. |
| `test:ui-polish` | Separate bilingual home/settings viewport sweep; same browser requirement. `GRAPHER_UI_SCREENSHOTS` optionally saves screenshots. |
| `test:pi`, `test:extensions` | Pi transport and [role/tool contracts](pi-integration.md#role-loading-policy). |
| `test:native`, `test:native:scripts`, `test:planner-bash` | Native paths, launchers, Planner workspace rebinding and Bash semantics. `test:native:scripts` omits Rust tests; it still needs pinned Pi and Git/Bash. |
| `test:prewarm` | Separate prewarm tests, production build and HTTP/native acceptance. |
| `test:environment`, `test:environment-chain` | Environment admission/lifecycle; needs Python 3.11+, Git, Bash and the platform boundary. |
| `test:merger`, `test:bindings` | Git composition/publication and project binding/routing. |
| `test:hardening`, `test:windows-native`, `test:macos-browser` | Production HTTP/filesystem or host-specific acceptance; macOS browser acceptance also needs a browser. |
| `test:concurrent` | Fixture HTTP concurrency; needs `/bin/sh`, skipped on Windows. |
| `test:conversation-acceptance` | Large-log migration/stress; see [prerequisites](conversation-logs.md#acceptance-prerequisites). |

Native suites need the real [platform boundary](../architecture/filesystem-isolation.md#platform-boundaries): bubblewrap/permitted namespaces on Linux, Seatbelt on macOS. Windows environment tests accept `GRAPHER_ENV_TEST_PARENT` for a short path. Environment-native, environment-chain and node-Merger fixtures seed historical runs to test retained private-workspace compatibility; new adaptive behavior lives in workspace-policy/batch tests and shared-native acceptance.

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

[planner-source.yml](../../.github/workflows/planner-source.yml), [release.yml](../../.github/workflows/release.yml) and [security-audit.yml](../../.github/workflows/security-audit.yml) own CI coverage. Model-free checks do not establish provider quality or every sandbox boundary.
