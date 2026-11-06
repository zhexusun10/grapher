# Testing

Pick the checks that cover the behavior you changed; this is not an ordered checklist. Setup lives in [CONTRIBUTING.md](../../CONTRIBUTING.md); report the commands you actually ran and any gaps.

## Targeted checks

```sh
npm run check
npx tsx --test scripts/<specific>.test.ts
node --test scripts/<specific>.test.mjs
node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <filter>
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --test <target> <filter>
```

`--lib` covers `backend/src/`, `--test <target>` covers `backend/tests/`; confirm which cases your filter selects. These are alternatives, not consecutive steps.

Assert behavior—scheduling, replay, publication, cancellation, isolation—not source spelling, translation counts, decorative styling, or workflow indentation. For docs-only edits, check affected links and the diff.

## Build isolation

When a running backend locks build artifacts, keep the original check and wrap the Cargo call:

```sh
node scripts/temporary-target.mjs -- node scripts/cargo.mjs <original-arguments>
```

The wrapper owns and cleans its own temporary target; an existing `CARGO_TARGET_DIR` is reused and never deleted, and a fresh one may need a cold build. Do not stop the backend or clean its cache. For npm suites use `npm run test:temporary -- <script>`; `test:isolated` runs the full Rust fixture suite and does not replace a locked single-test run. Release builds also honor `CARGO_TARGET_DIR`—use one directory for the build and [package-release.mjs](../../scripts/package-release.mjs). Details: [temporary-target.mjs](../../scripts/temporary-target.mjs), [tests](../../scripts/temporary-target.test.mjs).

## Broader suites

Run `npm run <script>`; [package.json](../../package.json) owns the exact composition.

| Script | Covers / needs |
| --- | --- |
| `test:frontend` | Frontend state, projection, transcript logic. |
| `test:ui` | Mocked-API browser flows; needs Chromium or `GRAPHER_BROWSER_CHANNEL` (Edge on Windows). Ends with `test:bundle`. |
| `test:bundle` | Builds into a temporary directory and checks production chunk boundaries, then loads the deferred workbench slowly, unsuccessfully, and during navigation; same browser requirement. |
| `test:macos-browser` | Browser → production backend → pinned Pi/Seatbelt → publication and Serial follow-up, with a local model and disposable project; same browser requirement; isolate via `npm run test:temporary -- test:macos-browser`. |
| `test:pi`, `test:extensions` | CLI/SDK transport, [role/tool contracts](pi-integration.md#role-loading-policy). |
| `test:native`, `test:prewarm`, `test:planner-bash` | Native launchers, preparation, paths, Bash semantics. |
| `test:hardening`, `test:windows-native` | Production HTTP/filesystem checks, Windows local-response execution. |
| `test:environment`, `test:environment-chain` | Native environment admission, inheritance, lifecycle; needs Python 3.11+, Git, Bash, and the platform boundary. |
| `test:merger`, `test:bindings` | Git composition/publication, project binding/routing. |
| `test:concurrent` | Fixture HTTP multi-run concurrency; needs `/bin/sh`, skipped on Windows. |
| `test:conversation-acceptance` | Large-log migration and stress harness; see [prerequisites](conversation-logs.md#acceptance-prerequisites). |

Native suites need the real [platform boundary](../architecture/filesystem-isolation.md#platform-boundaries): Linux requires bubblewrap and permitted namespaces, macOS requires Seatbelt. Windows environment tests accept `GRAPHER_ENV_TEST_PARENT` for a short path. Harbor adapter checks have separate [Linux prerequisites](../benchmarks/harbor.md#adapter-tests).

## Files-only publication

For source snapshots, private node history, conflicts, and restart recovery, run the relevant target among `--test files_only_publication`, `publication_recovery`, `graph_merge`, `publication`, `publication_state`, `shadow`. The source-equivalence oracle is `--lib workspace_view::tests` (hardlink/symlink, named-pipe, and symbolic-`.git` cases are Unix-only and skip on Windows). Planner state/switch/recovery: `--lib planner_workspace_tests` (fixture), `--lib native::tests::planner_switch_keeps_exact` (native), and `npx tsx --test scripts/planner-workspace-runtime.test.ts`. Scheduler/workspace regressions also belong to `--lib`.

Manual end-to-end acceptance (real backend, not fixtures or mocks):

```sh
node scripts/cargo.mjs build --manifest-path backend/Cargo.toml --no-default-features --bin grapher
node scripts/accept-files-only-publication.mjs
```

This starts a separately owned production backend on a free port with pinned Pi, native Bash, real Git, and an isolated deterministic local provider. It exercises planner → approval → parallel branches/multiple terminals → publication, fan-in repair, and failed publication → owned restart → retry, then verifies source HEAD/index/objects are unchanged, node cwd keeps project Git but not graph history, delivery adds no commit, and resume adds no duplicate delivery. Repositories, snapshots, `report.json`, and logs stay in the printed temporary directory; only the child backend is stopped. Use one independent `CARGO_TARGET_DIR` for both commands when the normal executable is busy; native Git/Bash, the pinned Pi setup, and the Linux/macOS platform boundary are required.

## Profiles and CI

- Offline Conda/ML profiles are opt-in: set only one of `GRAPHER_ENV_TEST_CONDA_MANIFEST` or `GRAPHER_ENV_TEST_ML_MANIFEST` for `test:environment`; [environment-native.test.ts](../../scripts/environment-native.test.ts) defines their inputs. The read-only [storage probe](../../backend/examples/environment_storage_probe.rs) is a diagnostic, not a default check.
- CI composition: [planner-source.yml](../../.github/workflows/planner-source.yml), [release.yml](../../.github/workflows/release.yml), [security-audit.yml](../../.github/workflows/security-audit.yml). The three-OS matrix is long, so it keeps one Rust target cache per OS (keyed by `backend/Cargo.lock` and the toolchain), cancels a run that a newer push to the same ref supersedes, and sizes each step's `timeout-minutes` to a warm run instead of a cold one. Report actual results, not configured coverage.
