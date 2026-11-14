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
