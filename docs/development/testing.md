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

`npm test` uses Rust fixtures; no paid model is required. Frontend tests exercise UI logic and isolated browser smoke cases, not provider quality. `check:docs` checks repository-owned Markdown links/anchors and npm command references; it does not fetch external websites or inspect upstream Pi documentation.

## Suites by responsibility

| Command | Scope / prerequisites |
| --- | --- |
| `npm run test:pi` | Pinned Pi CLI/SDK and provider/auth transport; isolated auth; no paid model |
| `npm run test:extensions` | Real Pi extension tools and Planner graph mutations; compatible `rg`/`fd` required |
| `npm run test:native` | Path adaptation plus native launcher/platform filesystem tests; actual pinned Pi and host tools |
| `npm run test:windows-native` | Windows production backend + real Pi/Bash; model responses served locally |
| `npm run test:merger` | Production backend + pinned Pi/Git; local-model node, Planner-preview, and source conflict repair, including shadow folders and retained failures; native Graph prerequisites apply |
| `npm run test:bindings` | Local HTTP project binding/lifecycle and execution-route behavior |
| `npm run test:concurrent` | Fixture HTTP multi-Run regression; requires `/bin/sh`, skips on Windows |
| `npm run test:conversation-acceptance` | Legacy-history copies, log migration, browser/HTTP/process stress; see prerequisites below |
| `python3 -m unittest discover -s benchmark -p 'test_*.py'` | Harbor adapter tests; real import-path interface test needs a separate Harbor installation |

Local deterministic model responses exercise production integration without paid API calls. They are not a real-model benchmark. Similarly, fixture engines cannot establish real launcher permissions or shell compatibility.

## Platform checks

- [Linux CI](../../.github/workflows/linux-native.yml) checks bubblewrap preflight, real namespace boundaries, pinned Pi/native tools, Harbor import-path integration, and fixture regressions.
- [Windows CI](../../.github/workflows/windows-native.yml) checks native Bash/Pi, independent workspaces, lifecycle, bindings, and extension tools. It does not expect filesystem permission rejection from Windows Graph.
- macOS native checks require working Seatbelt/`sandbox-exec` on an actual host.

Linux container tests need permitted unprivileged user/mount/PID namespaces. A failed preflight must remain a failure, not be bypassed with Serial or an unisolated substitute.

Process-group/Job Object tests cover defined writers and descendants; they do not prove universal detached-process cleanup. Unknown third-party tools and external services need separate acceptance.

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

## Conversation-log acceptance

The full TC-01–TC-14 harness needs Python 3.11+, a browser, and a suitable real legacy database with large saved transcripts. It is not a fresh-clone smoke test. It creates retained isolated copies and a large stress fixture, and can consume substantial disk/memory/time.

Follow [Conversation logs and acceptance](../testing/conversation-logs.md) for source requirements, environment variables, maintenance, and report locations. No historical evidence report is bundled as a claimed current result.

## Diagnostic probes

```sh
npm run probe:file-mapping
npm run probe:native-mapping
```

These investigate tool/subprocess mapping boundaries; they are not substitutes for production launcher or sandbox tests. The native mapping probe requires macOS and writes local evidence under `.grapher/probes/`. A demonstrated mapping limit is not a reason to claim transparent remapping or loosen source access controls.

## Real-model and evaluation acceptance

When accepting a provider, role policy, or Pi baseline change, separately run real authentication/model flows against trusted disposable projects. Record provider/model/endpoint, platform, commit, configuration, and failures—not just successful outputs.

For benchmark comparisons, use [Harbor](../benchmarks/harbor.md). Record exact task digests, image architecture/tools/permissions, budget, concurrency, retry policy, and all terminal outcomes. Protocol mocks and one-task smoke runs are not aggregate performance results.
