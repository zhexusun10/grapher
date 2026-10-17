# Testing and Validation

> **Scope:** Test suite selection, build target isolation, and opt-in acceptance boundaries.
> **Maintained with:** [package.json](../../package.json) and [AGENTS.md](../../AGENTS.md).

**Default rule:** Run targeted single-file checks for routine edits. Run full suites or opt-in acceptance harnesses **only** when cross-layer changes require them or when explicitly requested.

## 1. Targeted & Baseline Checks

For routine edits, run only the targeted check matching your changes:

```sh
npm run check                                                                                                  # TypeScript & types
npx tsx --test scripts/<specific>.test.ts                                                                      # Single TS test
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <filter> # Single Rust test
```

Full baseline (run only on explicit request):

```sh
npm ci --ignore-scripts
npm run pi:setup
npm run build
npm run test:frontend
npm test
```

1. **Scope limits:** `npm test` uses Rust fixtures (no paid API calls). Frontend tests check UI logic/smoke cases, not real provider/sandbox behavior. Update the canonical documentation page when a public contract changes, and check links in the pages you touch.
2. **Test design rules:** Assert public contract outcomes (scheduling, replay, publication, isolation, schema compatibility, cancellation, timeouts). Never lock source spelling, exact translation counts, decorative CSS/icon sizes, or workflow indentation.
3. **Registered agent tools:** Node, Serial, and Merger workspaces expose only `read`, `write`, `edit`, and `bash`; the Planner additionally exposes `node`/`edge` and a follow-up-only `switch_workspace`. Agents search via Bash, so host `rg`/`fd` are not required by `test:extensions`; the [benchmark image](../../benchmark/Dockerfile) installs them for Pi's own search tools.

## 2. Cargo Build Cache & Target Isolation

`backend/Cargo.toml` disables debug symbols and incremental builds in `dev`/`test` profiles while reusing compiled dependencies in `target/`. Override `CARGO_PROFILE_DEV_DEBUG`, `CARGO_PROFILE_TEST_DEBUG`, or `CARGO_INCREMENTAL` only for manual debugging. **Never run `cargo clean` or stop an active user backend.**

If a running backend locks binaries on Windows, use disposable or isolated targets:

```sh
npm run test:isolated -- --locked          # Rust fixture suite in a temporary target
npm run test:temporary -- test:bindings    # Wrap any npm script in a shared temporary target
npm run test:build-cache                   # Verify target cleanup/lock/signal behavior
```

**Temp target lifecycle:** [temporary-target.mjs](../../scripts/temporary-target.mjs) creates OS temporary targets and deletes them on exit. Caller-supplied `CARGO_TARGET_DIR` paths (e.g., PowerShell: `$env:CARGO_TARGET_DIR = Join-Path $PWD '.grapher/verification-target'`) are reused and **never** automatically deleted.

## 3. Suites by Responsibility (Run on Demand)

| Command | Scope & Host Prerequisites |
| --- | --- |
| `npm run test:ui` | Mocked-API Playwright browser flows (bootstrap, recovery, graph UI, settings). Needs Chromium or `GRAPHER_BROWSER_CHANNEL` (Edge on Windows). |
| `npm run test:pi` | Pinned Pi CLI/SDK and isolated provider/auth transport (no paid model). |
| `npm run test:extensions` | Real Pi extension tools and Planner graph mutations using local shell tools. |
| `npm run test:environment` | Native environment admission, discovery, E/L, resources, launch binding, and process/Job cleanup ([contract](../architecture/native-environments.md), [lifecycle](../architecture/filesystem-isolation.md#process-lifecycle), [drain fixture](../../scripts/fixtures/environment-native.mjs)). Needs Python 3.11+, Git, Bash, plus Linux `bubblewrap` or macOS Seatbelt. |
| `npm run test:environment-chain` | Fast companion to `test:environment`: parallel/serial private venv sharing (`--without-pip`), runtime-bound `python` launch, and fan-out publication using deterministic local responses. Needs Python 3.11+, Git, Bash. |
| `npm run test:native` | Path adaptation and native launcher/filesystem isolation with pinned Pi. |
| `npm run test:planner-bash` | Cross-platform Planner Bash semantics, worktree path stability, Unicode/space paths, pipelines, and timeouts. |
| `npm run test:hardening` | Static-file traversal, Windows drive/UNC/ADS paths, symlinked roots, and workspace cleanup. |
| `npm run test:windows-native` | Windows production backend + real Pi/Bash with local deterministic responses. |
| `npm run test:merger` | Production backend + pinned Pi/Git composition, conflict repair, and Merger follow-ups. |
| `npm run test:bindings` | Local HTTP project binding lifecycle and execution routing. |
| `npm run test:concurrent` | Fixture HTTP multi-Run concurrency regression (requires `/bin/sh`; skips on Windows). |
| `npm run test:conversation-acceptance` | Legacy database migration and large transcript stress harness (see [Conversation logs](../testing/conversation-logs.md)). |
| `python3 -m unittest discover -s benchmark -p 'test_*.py'` | Harbor benchmark adapter unit tests; Linux/POSIX host required, Windows unsupported (see [Harbor](../benchmarks/harbor.md)). |

**Focused API responsiveness checks:** [service_responsiveness_tests.rs](../../backend/src/service_responsiveness_tests.rs), [request-timeout.test.ts](../../scripts/request-timeout.test.ts), and [bootstrap-settings-ui.test.mjs](../../scripts/bootstrap-settings-ui.test.mjs).

## 4. Platform & CI Workflows

- **Weekly CI:** [planner-source.yml](../../.github/workflows/planner-source.yml) (cross-platform frontend contracts plus native/sandbox/Merger suites) and [security-audit.yml](../../.github/workflows/security-audit.yml) (npm + RustSec audits).
- **Platform requirements:** Linux native suites require unprivileged user/mount/PID namespaces (never bypass failed preflights). macOS requires Seatbelt (`sandbox-exec`). On Windows, if pip/Conda hits `MAX_PATH`, set `GRAPHER_ENV_TEST_PARENT=C:/tmp`.

## 5. Opt-In Heavy, Offline ML & Paid Acceptance

**Never run these harnesses unless explicitly instructed by the user.**

**Offline Windows Conda / ML profiles:** Built via [environment-build.mjs](../../scripts/environment-build.mjs). Set **one** manifest variable, never both:

```sh
# Full PyTorch/CUDA profile
GRAPHER_ENV_TEST_ML_MANIFEST=C:/tmp/grapher-ml-tools/manifest.json GRAPHER_ENV_TEST_PARENT=C:/tmp CARGO_TARGET_DIR=C:/tmp/grapher-env-control-target npm run test:environment

# Small empty-start Conda profile
GRAPHER_ENV_TEST_CONDA_MANIFEST=C:/tmp/grapher-ml-tools/manifest.json GRAPHER_ENV_TEST_PARENT=C:/tmp CARGO_TARGET_DIR=C:/tmp/grapher-env-control-target npm run test:environment
```

**Read-only libgit2 blob hash probe:** [environment_storage_probe.rs](../../backend/examples/environment_storage_probe.rs)

```sh
node scripts/cargo.mjs run --manifest-path backend/Cargo.toml --release --features acceptance --example environment_storage_probe -- C:/tmp/owned-artifact.bin
```

**Paid real-model browser acceptance:** Requires explicit `GRAPHER_REAL_MODEL_ACCEPTANCE=1`; defaults to `zicc/gpt-6-luna`. Override via `GRAPHER_ACCEPTANCE_MODEL`, `GRAPHER_ACCEPTANCE_AGENT_SOURCE`, `GRAPHER_ACCEPTANCE_PARENT`, or `GRAPHER_ACCEPTANCE_RESUME_DIR`.

```sh
# Parallel execution + Merger publication
GRAPHER_REAL_MODEL_ACCEPTANCE=1 node scripts/real-model-parallel-acceptance.mjs

# Live-source conflict + attachment + fan-in risk
GRAPHER_REAL_MODEL_ACCEPTANCE=1 node scripts/real-model-risk-acceptance.mjs

# Skip paid Planner stage (other paid-model operations may still run)
GRAPHER_REAL_MODEL_ACCEPTANCE=1 GRAPHER_ACCEPTANCE_MANUAL_GRAPH=1 node scripts/real-model-risk-acceptance.mjs
```

Acceptance script sources: [real-model-parallel-acceptance.mjs](../../scripts/real-model-parallel-acceptance.mjs) and [real-model-risk-acceptance.mjs](../../scripts/real-model-risk-acceptance.mjs).