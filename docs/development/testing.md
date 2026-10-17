# Testing and validation

Tests establish different things: deterministic runtime correctness, Pi transport/tool compatibility, platform boundaries, and actual model behavior. Do not treat one as evidence for all the others.

## Baseline checks

From a checkout prepared with `npm ci --ignore-scripts` and `npm run pi:setup`:

```sh
npm run check
npm run build
npm run test:frontend
npm test
```

`npm test` uses Rust fixtures; no paid model is required. Frontend tests exercise UI logic and isolated browser smoke cases, not provider quality. They do not fetch external sites, judge prose correctness, enforce freshness from a timestamp, or prove provider/sandbox/benchmark claims. See [Documentation maintenance](documentation.md) for the review and exploration checks.

## Rust build storage

`backend/Cargo.toml` disables debug symbols and incremental compilation in the
`dev` and `test` profiles. Routine builds still reuse Cargo's compiled dependency
artifacts in the fixed target directory; source edits do not create a new target
root. Release optimization is unchanged. For a deliberate debugging session,
override `CARGO_PROFILE_DEV_DEBUG` / `CARGO_PROFILE_TEST_DEBUG` and, if desired,
`CARGO_INCREMENTAL`; these explicit settings are not overridden by the launchers.

Use disposable targets only when an independent build is needed:

```sh
npm run test:isolated -- --locked
npm run test:temporary -- test:bindings
npm run test:build-cache
```

`test:isolated` runs the normal Rust fixture suite; `test:temporary` wraps an
entire named npm script, so its build and all subsequent test processes share
one `CARGO_TARGET_DIR`. Targets created by
[`temporary-target.mjs`](../../scripts/temporary-target.mjs) live under the OS
temporary directory and are removed after command completion/failure. The
runner forwards interrupt/termination to its own command tree and waits for its
exit before cleanup. A caller-supplied `CARGO_TARGET_DIR` remains reusable and
is **never** deleted. Locked files or changed ownership/redirected roots defer
cleanup with a warning rather than guessing that deletion is safe. Forced
termination of the runner itself (for example SIGKILL/power loss) can leave a
marked directory behind; this is not an automatic sweep of old/user directories.

Normal `npm test`, `npm run backend`, and `npm run dev` keep their reusable
build cache. No build hook runs `cargo clean`, removes an active backend, clears
the Cargo registry, or deletes runtime data. Native harnesses must finish their
own child-process cleanup before returning. `test:build-cache` verifies target
ownership, successful/failed commands, caller overrides, links, exit codes and
host-specific locked-file/signal behavior.

## Keep tests focused on behavior

Retain regression coverage for scheduling/replay, publication, workspace and
credential isolation, persisted compatibility, cancellation, stale responses and
bounded requests. Test public outcomes rather than copying implementation details
into assertions.

Do not lock source spelling, translation-call syntax/counts, decorative animation
frames, exact colors/icon sizes, section order or tunable default layout values.
Locale detection, translation placeholders and rendered-language smoke checks
remain covered; approval/publication disclosures are checked in rendered output.
Use suite commands from `package.json` in CI instead of duplicating test-file lists
or testing workflow step names/indentation. A refactor that preserves the contract
should not require test or workflow edits.

## Suites by responsibility

| Command | Scope / prerequisites |
| --- | --- |
| `npm run test:ui` | Mocked-API browser interactions, stalled bootstrap/history/Provider catalog/settings recovery, graph switching and Planner auto-fit, settings and managed result controls; installed Playwright Chromium or `GRAPHER_BROWSER_CHANNEL` (Windows defaults to Edge), no credentials/backend |
| `npm run test:pi` | Pinned Pi CLI/SDK and provider/auth transport; isolated auth; no paid model |
| `npm run test:extensions` | Real Pi extension tools and Planner graph mutations; compatible `rg`/`fd` required |
| `npm run test:environment` | Rust empty-start admission/discovery/E/L/resources/private copies, launch binding and production pinned Pi/native Python acceptance without user policy input. Windows includes real Job CPU/memory enforcement; device-lock tests include process/crash release. Python 3.11+/Git/Bash plus Linux bubblewrap or macOS Seatbelt required. Optional offline Windows Conda/CUDA profile described below; [contract/evidence](../architecture/native-environments.md) |
| `npm run test:environment-chain` | Focused real-Pi/native Python Graph acceptance for default lazy discovery with no client policy: a parallel branch plus serial create/verify/report nodes share one `--without-pip` private venv, downstream nodes use the Runtime-bound `python` entry, ordinary reports publish, and host/workspace isolation is checked from backend records. A bound-parent fan-out also verifies parallel bound/unbound branches, schema-2 independent entry publication and model-free named launch without new prompt instructions or an environment Merger. Deterministic localhost model; Python 3.11+/Git/Bash required. Fast companion to the long `test:environment` profile |
| `npm run test:native` | Path adaptation plus native launcher/platform filesystem tests; actual pinned Pi and host tools |
| `npm run test:planner-bash` | Shared macOS/Windows/Linux Planner contract: pinned Pi's native Bash semantics, direct source writes via Bash/write/edit, stable read/bash/write/edit/context/prompt paths across source and changing worktrees without instruction injection, absolute/Unicode/space paths, pipelines, nested shells, errors and timeouts |
| `npm run test:hardening` | Production static-file path traversal, Windows drive/UNC/alternate-stream paths, linked web roots/children, and linked workspace cleanup |
| `npm run test:windows-native` | Windows production backend + real Pi/Bash; model responses served locally |
| `npm run test:merger` | Production backend + pinned Pi/Git; local-model source-native Planner writes/revisions, failed-revision persistence, latest-source + retained-dependency composition, node/source conflict repair, settled publication-merger follow-ups, and shadow folders; native Graph prerequisites apply |
| `npm run test:bindings` | Local HTTP project binding/lifecycle and execution-route behavior |
| `npm run test:concurrent` | Fixture HTTP multi-Run regression; requires `/bin/sh`, skips on Windows |
| `npm run test:conversation-acceptance` | Legacy-history copies, log migration, browser/HTTP/process stress; see prerequisites below |
| `python3 -m unittest discover -s benchmark -p 'test_*.py'` | Harbor adapter tests; real import-path interface test needs a separate Harbor installation |

Focused API-responsiveness checks: [Rust lock/ownership tests](../../backend/src/service_responsiveness_tests.rs)
(`--lib service_responsiveness` with the fixture feature),
[request deadline tests](../../scripts/request-timeout.test.ts), and
[real-App browser tests](../../scripts/bootstrap-settings-ui.test.mjs). The browser
suite deliberately stalls transport/response bodies and uses a controlled clock;
it does not prove the exact cause of a past production stall without its trace.

Local deterministic model responses exercise production integration without paid API calls. They are not a real-model benchmark. Similarly, fixture engines cannot establish real launcher permissions or shell compatibility.

## Platform checks

- [Planner source CI](../../.github/workflows/planner-source.yml) runs weekly (and on manual dispatch) on macOS, Windows, and Linux. It covers the snapshot/replay fixtures, real Planner Bash contract, native launcher tests, Linux bubblewrap preflight and namespace boundaries, the full backend library suite and native Bash/Pi acceptance on Windows (it does not expect filesystem permission rejection from Windows Graph), managed-environment state/launch/native acceptance with Python 3.12, macOS Seatbelt child-process tests, and production Planner/Merger acceptance. Windows acceptance includes extended-drive-prefix paths; shared tests use Unicode and spaces. Pushes and pull requests do not trigger it; run the focused local suites above instead.
- [Dependency Security Audit](../../.github/workflows/security-audit.yml) runs weekly (and on manual dispatch) npm audits for Grapher and the reviewed Pi dependency profile, plus RustSec auditing for `backend/Cargo.lock`. Audit evidence is uploaded even when a high-severity finding fails the job. The current Grapher root and reviewed Pi profile audits are clean; a direct audit of the upstream `pi/` tree reports optional/example `node-forge`/Gondolin and dev-only `braces`/`micromatch`/`fast-glob`/`shelljs`/`shx` findings, which are excluded from the runtime profile. Treat any new finding in the reviewed profile as an open baseline risk until it is reviewed.

If a development backend binary is already running on Windows, isolate integration builds instead of stopping that service. `npm run test:temporary -- test:bindings` (or another suite above) supplies a disposable target to the complete build/test chain and cleans it afterwards. For intentional reuse across several commands, set an explicit directory instead:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD '.grapher/verification-target'
```

Extension, project-binding and Windows native harnesses honor `CARGO_TARGET_DIR`. Explicit directories remain caller-owned; remove them only when their builds/test backends have stopped. Select the relevant suites above; this setting is not permission to upgrade Pi or restart agents. Offline tool provisioning is described below.

macOS native checks require working Seatbelt/`sandbox-exec` on an actual host. A configured CI matrix is not evidence that its jobs passed; check the individual platform results. Windows drive/UNC prefix normalization tests do not establish access to a real network share.

Linux container tests need permitted unprivileged user/mount/PID namespaces. A failed preflight must remain a failure, not be bypassed with Serial or an unisolated substitute.

Managed Python/pip acceptance can hit Windows package path limits even when Git
accepts the path. Set `GRAPHER_ENV_TEST_PARENT` to an explicit short disposable
parent (for example `C:/tmp`); the harness still uses Unicode and spaces. This
is test configuration, not a Runtime path repair or execution-mode fallback.
Native results have no implicit 120-second execution limit; initialization and
probes remain bounded, and result output defaults to 4 MiB per pipe. An internal
profile may set explicit time/output bounds. This is not blanket long-training or
large-environment acceptance. See the
[native-environment evidence and open capabilities](../architecture/native-environments.md#verification-recorded-for-this-working-tree).

Process-group/Job Object tests cover defined writers and descendants; they do not prove universal detached-process cleanup. Unknown third-party tools and external services need separate acceptance.

The environment harness selects its probed native Python for the observed venv
creation call using a call-local PATH, rather than relying on the unbound Bash
entry's directory order. Its [drain fixture](../../scripts/fixtures/environment-native.mjs)
starts a writer owned by the Unix process group or Windows Job from a real project
extension. Windows bypasses libuv's additional kill-on-parent-exit child Job,
not Rust's outer Job. Whether the host seals a result while such a writer lives,
or refuses to, is a platform property rather than a Grapher contract: the harness
accepts either outcome and asserts only the invariant both hosts share, namely
that native cleanup stops the 90-second writer instead of waiting it out, and
that an explicitly interrupted attempt keeps its created partial environment as
append-only evidence which the next turn reuses instead of rebuilding. The
[lifecycle limits](../architecture/filesystem-isolation.md#process-lifecycle)
still apply. Fixture regressions run with `npm run test:environment`.

## Search tools and offline runs

Grapher registers `read`, `write`, `edit` and `bash` for every project and role; Pi's separate `ls`, `find` and `grep` tools are not registered, so no suite requires ripgrep or fd on PATH — agents list and search through Bash. Tests that load production extensions pin `PI_OFFLINE=1` so nothing downloads implicitly at test time; this avoids test-time downloads, not initial dependency installation. The Harbor base image still preinstalls pinned ripgrep/fd binaries for agent Bash use in [benchmark/Dockerfile](../../benchmark/Dockerfile).

## Offline native ML acceptance

Use only explicitly owned disposable directories for acceptance. Acceptance itself
uses local artifacts and a supplied manifest:

```sh
GRAPHER_ENV_TEST_ML_MANIFEST=C:/tmp/grapher-ml-tools/manifest.json GRAPHER_ENV_TEST_PARENT=C:/tmp CARGO_TARGET_DIR=C:/tmp/grapher-env-control-target npm run test:environment
```

The optional profile currently targets native Windows Miniforge/Python 3.12,
PyTorch 2.8.0+cu128, NumPy 2.3.1 and a real NVIDIA GPU. It verifies wheel hashes,
automatically builds the optimized `--release` backend, uses offline
`conda create --copy`/pip, then exercises CUDA synchronization,
forward/backward, preserved environment handoff and a cancelable result remaining
active beyond 120 seconds. It also checks bounded metadata latency during that
execution. It uses a separate short workspace test parent, still with Unicode
and spaces, to accommodate Conda's packaged MAX_PATH-sensitive data.

For the separate small empty-start Conda profile, reuse the provisioned tools:

```sh
GRAPHER_ENV_TEST_CONDA_MANIFEST=C:/tmp/grapher-ml-tools/manifest.json GRAPHER_ENV_TEST_PARENT=C:/tmp CARGO_TARGET_DIR=C:/tmp/grapher-env-control-target npm run test:environment
```

This profile verifies native Conda package archives against their staged SHA-256
metadata, creates Python/pip through the upstream business Bash, and exercises
automatic discovery and subsequent E/L use without a client policy. It omits
Conda setuptools' long packaged test data (not needed by the fixture's editable
backend); that package's extraction exceeded Windows MAX_PATH in the tested
layout. No archive is modified, no registry setting changes, and production has
no failed-layout repair or tool fallback. This is not Torch/CUDA acceptance.
Do not set both profile variables.

The ML saved-policy compatibility profile does **not** establish automatic
Conda/device policy synthesis. A downloaded wheelhouse, standalone CUDA probe,
configured CI or partially completed harness is not managed acceptance. Record
actual native results and storage/latency budgets separately; see the canonical
[native environment evidence](../architecture/native-environments.md#verification-recorded-for-this-working-tree).

## Conversation-log acceptance

The full TC-01–TC-14 harness needs Python 3.11+, a browser, and a suitable real legacy database with large saved transcripts. It is not a fresh-clone smoke test. It creates retained isolated copies and a large stress fixture, and can consume substantial disk/memory/time.

Follow [Conversation logs and acceptance](../testing/conversation-logs.md) for source requirements, environment variables, maintenance, and report locations. No historical evidence report is bundled as a claimed current result.

## Diagnostic probes

For owned large artifacts, the opt-in read-only
[storage probe](../../backend/examples/environment_storage_probe.rs) measures
libgit2 blob hashing without writing Git objects or changing runtime data:

```sh
node scripts/cargo.mjs run --manifest-path backend/Cargo.toml --release --features acceptance --example environment_storage_probe -- C:/tmp/owned-artifact.bin
```

Hash timing alone is not a scan/seal/copy/restore budget or device acceptance.
Use optimized builds for large-ML performance checks; ordinary debug fixtures
establish functional behavior, not production throughput. The
[environment builder](../../scripts/environment-build.mjs) selects that profile
automatically when the offline ML manifest is supplied.

## Real-model and evaluation acceptance

When accepting a provider, role policy, or Pi baseline change, separately run real authentication/model flows against trusted disposable projects. Record provider/model/endpoint, platform, commit, configuration, and failures—not just successful outputs.

### Short parallel browser acceptance (paid, opt-in)

[`scripts/real-model-parallel-acceptance.mjs`](../../scripts/real-model-parallel-acceptance.mjs)
starts an isolated production backend and Vite frontend, then drives the real UI
with Playwright. It plans two parallel nodes, publishes their conflicting ignored
project file through a Merger, sends live steering and a settled-Merger follow-up,
and reloads durable history. It verifies execution overlap, Git publication,
deletions, actual Pi model metadata, and browser/API errors. No API is mocked.

Build the production backend first (using an isolated `CARGO_TARGET_DIR` if a
user service is running), then explicitly authorize provider calls:

```sh
GRAPHER_REAL_MODEL_ACCEPTANCE=1 node scripts/real-model-parallel-acceptance.mjs
```

The default model is `zicc/gpt-6-luna`; override it with
`GRAPHER_ACCEPTANCE_MODEL=provider/model`. Model/auth definitions are read from
`GRAPHER_ACCEPTANCE_AGENT_SOURCE` (default `~/.pi/agent`) without changing them.
Only the selected provider/model is copied into a temporary agent directory;
that credential copy is removed after the harness-owned backend exits. Reports,
screenshots, and disposable project/data directories are retained outside the
checkout. `GRAPHER_ACCEPTANCE_PARENT` selects their parent. Treat retained traces
as local evidence, not publishable artifacts. Installed Playwright Chromium or
Edge and native Graph prerequisites are required. The task budget is four minutes;
provider latency/failure can still prevent completion. To test publication recovery
without repeating completed node model calls, set `GRAPHER_ACCEPTANCE_RESUME_DIR`
to a failed harness directory. This mode requires its original failed report and
Run identity, retries publication through the UI, and retains a new `retry-*`
evidence directory without overwriting the original failure. It does not accept
arbitrary user runtime data. This script is deliberately excluded from default
test suites and is not a provider benchmark or sandbox proof.

### Attachment, live-source and private fan-in risk acceptance

[`scripts/real-model-risk-acceptance.mjs`](../../scripts/real-model-risk-acceptance.mjs)
uses the same isolated production-backend/browser prerequisites and credential
handling as the short parallel acceptance above. Two parallel nodes modify one
ignored project file, followed by a dependent verifier. The harness checks the
private composition Merger's completion and the child's **prepared Git input**
before publication, then verifies the child's copied output. During root
execution it edits that same file in the source; publication must preserve the
user line through explicit Git conflict repair. Image colors and random text-file
tokens must be returned by the real model for both live node Steer and completed
node continuations. Each accepted attachment turn must retain exactly one card
(and image thumbnail) after acceptance, Run switching and reload.

```sh
GRAPHER_REAL_MODEL_ACCEPTANCE=1 GRAPHER_ACCEPTANCE_MANUAL_GRAPH=1 node scripts/real-model-risk-acceptance.mjs
```

The fixed-graph option avoids a paid Planner call while still approving and
controlling the real graph through the browser; omit it to include Planner.
The model defaults to `zicc/gpt-6-luna` and the overall attempt budget is four
minutes. Provider latency may exceed that budget. The harness waits for a real
Pi tool call before steering (a scheduled execution is not yet a live RPC
session), and for published completion to reach the browser before continuing.
`GRAPHER_ACCEPTANCE_RESUME_DIR` can finish continuation checks from a failed
harness-owned report only when its private-composition/source-publication checks
passed and that Run is already completed. Recovery does not repeat the graph;
it retains a `retry-*` report linked to the original evidence. An accumulated
recovery report is not an uninterrupted single-attempt pass. Native Windows
acceptance exercised these three risks with the real model; no cross-platform,
aggregate provider-quality or sandbox guarantee follows from this small task.

For benchmark comparisons, use [Harbor](../benchmarks/harbor.md). Record exact task digests, image architecture/tools/permissions, budget, concurrency, retry policy, and all terminal outcomes. Protocol mocks and one-task smoke runs are not aggregate performance results.
