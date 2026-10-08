# Testing and validation

Tests establish different things: deterministic runtime correctness, Pi transport/tool compatibility, platform boundaries, and actual model behavior. Do not treat one as evidence for all the others.

## Baseline checks

From a checkout prepared with `npm ci --ignore-scripts` and `npm run pi:setup`:

```sh
npm run check
npm run build
npm run check:docs
node --test scripts/check-docs.test.mjs
npm run test:frontend
npm test
```

`npm test` uses Rust fixtures; no paid model is required. Frontend tests exercise UI logic and isolated browser smoke cases, not provider quality. `check:docs` checks repository-owned Markdown links/anchors, npm command references, knowledge-index coverage, status-directory consistency and current-vs-historical routing. Local documentation checks run it and the checker tests without building Pi or Rust. It does not fetch external websites, lint upstream Pi docs, verify prose against code, or certify freshness. See [Documentation maintenance](documentation.md) for the review and exploration checks.

## Suites by responsibility

| Command | Scope / prerequisites |
| --- | --- |
| `npm run test:ui` | Mocked-API browser interactions, graph switching, settings and managed result controls; installed Playwright Chromium or `GRAPHER_BROWSER_CHANNEL` (Windows defaults to Edge), no credentials/backend |
| `npm run test:pi` | Pinned Pi CLI/SDK and provider/auth transport; isolated auth; no paid model |
| `npm run test:extensions` | Real Pi extension tools and Planner graph mutations; compatible `rg`/`fd` required |
| `npm run test:environment` | Rust empty-start admission/discovery/E/L/resources/private copies, launch binding and production pinned Pi/native Python acceptance without user policy input. Windows includes real Job CPU/memory enforcement; device-lock tests include process/crash release. Python 3.11+/Git/Bash plus Linux bubblewrap or macOS Seatbelt required. Optional offline Windows Conda/CUDA profile described below; [contract/evidence](../architecture/native-environments.md) |
| `npm run test:native` | Path adaptation plus native launcher/platform filesystem tests; actual pinned Pi and host tools |
| `npm run test:planner-bash` | Shared macOS/Windows/Linux Planner contract: pinned Pi's unmodified Bash, direct source writes, absolute/Unicode/space paths, pipelines, nested shells, errors and timeouts |
| `npm run test:hardening` | Production static-file path traversal, Windows drive/UNC/alternate-stream paths, linked web roots/children, and linked workspace cleanup |
| `npm run test:windows-native` | Windows production backend + real Pi/Bash; model responses served locally |
| `npm run test:merger` | Production backend + pinned Pi/Git; local-model source-native Planner writes/revisions, failed-revision persistence, latest-source + retained-dependency composition, node/source conflict repair, and shadow folders; native Graph prerequisites apply |
| `npm run test:bindings` | Local HTTP project binding/lifecycle and execution-route behavior |
| `npm run test:concurrent` | Fixture HTTP multi-Run regression; requires `/bin/sh`, skips on Windows |
| `npm run test:conversation-acceptance` | Legacy-history copies, log migration, browser/HTTP/process stress; see prerequisites below |
| `python3 -m unittest discover -s benchmark -p 'test_*.py'` | Harbor adapter tests; real import-path interface test needs a separate Harbor installation |

Local deterministic model responses exercise production integration without paid API calls. They are not a real-model benchmark. Similarly, fixture engines cannot establish real launcher permissions or shell compatibility.

## Platform checks

- [Linux CI](../../.github/workflows/linux-native.yml) checks bubblewrap preflight, real namespace boundaries, pinned Pi/native tools, Harbor import-path integration, and fixture regressions.
- [Windows CI](../../.github/workflows/windows-native.yml) checks native Bash/Pi, independent workspaces, lifecycle, bindings, and extension tools. It does not expect filesystem permission rejection from Windows Graph.
- [Planner source CI](../../.github/workflows/planner-source.yml) runs the same snapshot/replay fixtures, real Planner Bash contract, native launcher tests, and production Planner/Merger acceptance on macOS, Windows, and Linux. It now includes managed-environment state/launch/native acceptance with Python 3.12, and also runs macOS Seatbelt child-process tests. Windows acceptance includes extended-drive-prefix paths; shared tests use Unicode and spaces.
- [Dependency Security Audit](../../.github/workflows/security-audit.yml) runs scheduled and change-triggered npm audits for Grapher and the reviewed Pi dependency profile, plus RustSec auditing for `backend/Cargo.lock`. Audit evidence is uploaded even when a high-severity finding fails the job. The current Grapher root and reviewed Pi profile audits are clean; a direct audit of the upstream `pi/` tree reports optional/example `node-forge`/Gondolin and dev-only `braces`/`micromatch`/`fast-glob`/`shelljs`/`shx` findings, which are excluded from the runtime profile. Treat any new finding in the reviewed profile as an open baseline risk until it is reviewed.

If a development backend binary is already running on Windows, isolate integration builds instead of stopping that service:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD '.grapher/verification-target'
```

Extension, project-binding and Windows native harnesses honor `CARGO_TARGET_DIR`. Select the relevant suites above; this setting is not permission to upgrade Pi or restart agents. Offline tool provisioning is described below.

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
not Rust's outer Job. Linux namespace cleanup may stop the writer before sealing;
the harness then requires stopped-heartbeat evidence and separately checks an
explicitly interrupted writer's partial-environment retry. The
[lifecycle limits](../architecture/filesystem-isolation.md#process-lifecycle)
still apply. Fixture regressions run with `npm run test:environment`.

## Search tools and offline runs

Pi's `grep`/`find` need compatible ripgrep and fd binaries. `test:extensions` resolves the actual executables and prints versions. Missing tools keep managed-download diagnostics; tests are not silently skipped.

Install tools on PATH before offline runs, for example:

```text
Windows:       choco install ripgrep fd -y
macOS:         brew install ripgrep fd
Debian/Ubuntu: sudo apt-get install ripgrep fd-find
```

`fdfind` is recognized, but distribution packages must support the flags used by pinned Pi; an old fd package may need replacement. The Harbor base image pins compatible tool versions/checksums in [benchmark/Dockerfile](../../benchmark/Dockerfile).

Windows CI explicitly provisions search tools and sets `PI_OFFLINE=1` for extension tests. This avoids test-time implicit downloads, not initial dependency installation.

## Offline native ML acceptance tools

This is developer acceptance provisioning, **not** a product environment-settings
workflow. Use only explicitly owned disposable directories. The
[provisioner](../../scripts/provision-environment-ml.mjs) verifies the official
Miniforge installer checksum, disables PATH/Python registration, and records
hashed offline wheels. It does not use model credentials or alter the host's
installed Python. Provisioning downloads public packages; acceptance itself
uses the resulting local artifacts.

```sh
node scripts/provision-environment-ml.mjs --directory C:/tmp/grapher-ml-tools --backend cuda
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

```sh
npm run probe:file-mapping
npm run probe:native-mapping
```

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

The mapping probes investigate tool/subprocess mapping boundaries; they are not substitutes for production launcher or sandbox tests. The native mapping probe requires macOS and writes local evidence under `.grapher/probes/`. A demonstrated mapping limit is not a reason to claim transparent remapping or loosen source access controls.

## Real-model and evaluation acceptance

When accepting a provider, role policy, or Pi baseline change, separately run real authentication/model flows against trusted disposable projects. Record provider/model/endpoint, platform, commit, configuration, and failures—not just successful outputs.

For benchmark comparisons, use [Harbor](../benchmarks/harbor.md). Record exact task digests, image architecture/tools/permissions, budget, concurrency, retry policy, and all terminal outcomes. Protocol mocks and one-task smoke runs are not aggregate performance results.
