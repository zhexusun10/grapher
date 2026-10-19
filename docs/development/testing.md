# Testing

Use the [development guide](contributing.md) for setup and [AGENTS.md](../../AGENTS.md#verification) for verification constraints. Select checks for the changed behavior; this page is not an ordered checklist.

## Targeted checks

```sh
npm run check
npx tsx --test scripts/<specific>.test.ts
node --test scripts/<specific>.test.mjs
node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <filter>
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --test <target> <filter>
```

Choose `--lib` for `backend/src/` tests or `--test <target>` for `backend/tests/`; replace placeholders and verify which cases the filter selects. These are alternatives, not mandatory consecutive runs.

Assert behavior such as scheduling, replay, publication, cancellation, and isolation. Avoid assertions coupled to source spelling, translation counts, decorative styling, or workflow indentation. For documentation-only edits, check affected links and the diff.

## Build isolation

If a running backend locks build artifacts, keep the original check/filter and wrap its Cargo invocation:

```sh
node scripts/temporary-target.mjs -- node scripts/cargo.mjs <original-arguments>
```

The wrapper creates and cleans its own temporary target. An existing `CARGO_TARGET_DIR` is reused and never deleted. A fresh target may need a cold build. Do not stop the backend or clean its build cache to run a check.

For an already-selected npm suite, use `npm run test:temporary -- <script>`. `test:isolated` runs the full Rust fixture suite; it is not a substitute for a locked single-test run. Implementation and regressions: [temporary-target.mjs](../../scripts/temporary-target.mjs), [temporary-target.test.mjs](../../scripts/temporary-target.test.mjs).

## Broader suites

Choose a suite only when its scope is relevant. Invoke npm scripts with `npm run <script>`; [package.json](../../package.json) owns their exact composition.

| Script | Coverage / prerequisites |
| --- | --- |
| `test:frontend` | Frontend state, projection, and transcript logic. |
| `test:ui` | Mocked-API browser flows; needs Chromium or `GRAPHER_BROWSER_CHANNEL` (Edge on Windows). |
| `test:pi`, `test:extensions` | CLI/SDK transport and [Grapher role/tool contracts](pi-integration.md#role-loading-policy). |
| `test:native`, `test:prewarm`, `test:planner-bash` | Native launchers, preparation, paths, and Bash semantics. |
| `test:hardening`, `test:windows-native` | Production HTTP/filesystem checks and Windows local-response execution. |
| `test:environment`, `test:environment-chain` | Native environment admission, inheritance, and lifecycle; needs Python 3.11+, Git, Bash, and platform prerequisites below. |
| `test:merger`, `test:bindings` | Git composition/publication and project binding/routing. |
| `test:concurrent` | Fixture HTTP multi-Run concurrency; needs `/bin/sh`, skips on Windows. |
| `test:conversation-acceptance` | Large-log migration and stress harness; see [prerequisites](conversation-logs.md#acceptance-prerequisites). |

Native suites require the actual [platform boundary](../architecture/filesystem-isolation.md#platform-boundaries): Linux needs bubblewrap and permitted namespaces; macOS needs Seatbelt. Windows environment tests can use `GRAPHER_ENV_TEST_PARENT` for a short path. Harbor adapter checks have separate [Linux prerequisites](../benchmarks/harbor.md#adapter-tests).

## Specialized profiles and CI

- Offline Conda/ML profiles are opt-in. Set only one of `GRAPHER_ENV_TEST_CONDA_MANIFEST` or `GRAPHER_ENV_TEST_ML_MANIFEST` for `test:environment`; [environment-native.test.ts](../../scripts/environment-native.test.ts) defines their inputs. The read-only [storage probe](../../backend/examples/environment_storage_probe.rs) is a separate diagnostic, not a default check.
- CI composition lives in [planner-source.yml](../../.github/workflows/planner-source.yml), [release.yml](../../.github/workflows/release.yml), and [security-audit.yml](../../.github/workflows/security-audit.yml). Report actual check results, not configured coverage.
