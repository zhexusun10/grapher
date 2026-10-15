# Changelog

All notable changes to Grapher will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Dispatch a node-composition Merger when fan-in parent environments are incompatible: it selects one verified input environment or builds a new private environment offline, then Runtime discovers and captures the result. A simultaneous Git and environment conflict uses one Merger with both prompt segments concatenated; environment directory trees are never merged and there is no network or host-Python fallback.
- Show Mergers as selectable cards in the execution graph: node-composition Mergers beside their target and the publication Merger as a `publication merger` card below the terminal layer; steer a running merger, continue a settled publication merger's session, and keep settled node-composition cards read-only.

### Changed

- Materialize the temporary shadow Git snapshot for an ordinary folder lazily on the first node dispatch instead of during detection, planning or approval; reclaim it after a successful publication (Run deletion and offline GC also reclaim it), and keep it for failed/interrupted Runs that need `retry_publication`. The first dispatch reports a non-blocking `source_materialize` activity.
- Run completed-node conversations directly in the source directory (no worktree, commit, downstream invalidation or republication) for both ordinary folders and standard Git repositories; a settled publication-merger follow-up follows the same rule once a successful publication has reclaimed the ordinary folder's snapshot; only a Planner revision that dispatches new nodes rebuilds the snapshot.
- Accept user edits in the source directory during Graph execution: downstream handoff and explicit node updates no longer block on a dirty source, and publication commits pending user changes as its base before merging node results.
- Share content-keyed Pi engine/dependency caches across projects and backend restarts, with reader leases and serialized preparation instead of per-backend copies.
- Default workspace/engine caches to the OS cache directory (Windows: `%LOCALAPPDATA%\Grapher`), preserving existing runtime histories and legacy execution paths.
- Upgrade the pinned Pi engine to the official stable 1.2.0 release (exact `v1.2.0` tag), refreshing the checksummed model catalog and reviewed dependency profile; the profile drops the removed experimental `client`, `protocol` and `server` workspaces and adds `@silvia-odwyer/photon` for Durable image handling.
- Extend the Pi contracts with Azure provider/API, credential-migration, retired 1.2.0 catalog, OpenRouter router placeholder-price and `before_agent_start` user/custom event-union regressions; revalidate extensions, prepared hosts and Windows production execution against Pi 1.2.0.
- Upgrade the bundled `pi-continuity` extension from 0.2.0 to 0.2.1, expanding the default continuation budgets (16 resumes and 12 stream attempts per user request), broadening transient-error and output-truncation classification, and hardening malformed-message guards. The bounded 15-minute usage-limit polling added in 0.2.0 is unchanged.

### Fixed

- Reject the user's desktop folder as a project workspace. Forced Git collection ignores `.gitignore`, so a desktop binding would snapshot unrelated personal data and stall planning before any node is dispatched.
- Retry transient Chocolatey community-feed failures in Windows CI and verify both `rg` and `fd` before running tests, instead of failing later on a missing binary.
- Resolve host Git for the Grapher-owned engine bootstrap independently of the business launch PATH, so pinned-baseline verification keeps working when a managed environment omits Git.
- Keep fixture result-entry launches off the platform sandbox: disposable test workspaces live under the test data root, which production Linux/macOS geometry intentionally rejects. Native suites built without the fixture feature still cover the real boundaries.

### Breaking Changes

- Pi's Azure provider ID changes from `azure-openai-responses` to `azure`. Existing credentials, custom provider definitions and saved model references require [migration](docs/guides/providers.md#azure-configuration); the Responses API ID and `AZURE_OPENAI_*` environment variables are unchanged.
- The refreshed 1.2.0 snapshot additionally retires `openrouter/inclusionai/ling-3.0-flash-sante:free`, `opencode/fledge-alpha-free` and the `google-vertex` `gemini-flash-latest`/`gemini-flash-lite-latest` aliases, on top of the earlier OpenRouter/Vercel retirements, and switches two `opencode-go` models to the Anthropic API; see the [catalog compatibility findings](docs/development/pi-integration.md#compatibility-findings) before continuing saved selections. With an OpenRouter key, Pi now narrows its catalog to the models that key may use, so the Settings catalog and saved selections can change with the key.
- Pi's `before_agent_start` event is now a union and also fires for extension-triggered runs, and the session counts as busy while a run starts; third-party extension handlers that assume a user prompt must check `event.messageType === "user"`, and `pi.sendUserMessage()` requires `deliverAs` in that window.

## [0.1.0-alpha.2] - 2026-10-05

### Added

- Bundle pi-trim 0.2.0 and pi-continuity 0.1.0 with extension discovery and workbench settings.
- Provide separate macOS ARM64 and Intel x64 archives alongside Linux and Windows x64 packages.
- Smoke-test extracted release archives outside the build checkout, covering real Pi CLI/IPC and local-provider contracts, Graph runtime preparation, backend startup, provider discovery, extensions, and frontend assets.

### Changed

- Updated the pinned Pi engine to upstream 1.0.1 and refreshed the checksummed model catalog.

### Fixed

- Include runtime scripts, bundled extension dependencies, the ESM package boundary, and independent Pi Git metadata in relocatable distributions.
- Resolve runtime, frontend, configuration, and data paths relative to packaged executables instead of the CI checkout.
- Use Pi's audited source resolver for Provider/Auth without downloading tsx at startup.
- Fix graph display across sessions, planner state handling, and thinking transcript rendering.
- Apply Pi 1.0.1 project MCP overrides after merging global and Grapher-specific definitions, preserving credentials and project trust restrictions.
- Align Bash smoke assertions with Pi's nonzero-exit error results and honor `CARGO_TARGET_DIR` in integration checks.
- Match planning history across equivalent Windows repository bindings while keeping missing and unrelated paths fail-closed.
- Install Pi through the audited core dependency profile and build required artifacts without the vulnerable optional-example and shelljs dependency chains.

## [0.1.0-alpha.1] - TBD

### What is Grapher?

Grapher is a local coding-agent workbench that compiles complex work into inspectable execution graphs. Built on Pi, it runs simple tasks as a single agent, or compiles complex work into a dependency-aware execution graph scheduled by a deterministic Rust runtime.

### What's working

- **Serial mode** — Single Pi coding agent for linear tasks
- **Graph mode** — Multi-agent execution with explicit dependencies
- **Partitioner** — Automatically routes simple tasks to Serial, complex to Graph
- **Planner** — Creates execution plans with task decomposition
- **Compiler** — Validates graph structure and dependencies
- **Runtime** — Deterministic Rust scheduler with dependency-aware execution
- **Workspace inheritance** — Child nodes inherit parent workspace state, not conversations
- **Bounded feedback** — Explicit review/rework edges without conversation propagation
- **Result publication** — Git-based merging and validation before completion
- **Linux sandbox** — bubblewrap-based filesystem isolation for Graph nodes
- **UI** — React workbench with graph visualization, logs, and approval flow
- **Provider support** — OpenAI, Anthropic, and other Pi-compatible providers

### Current limitations

- **No packaged installers** — Requires manual Node.js, Rust, and build setup
- **Windows sandboxing** — Graph nodes use process isolation only, not filesystem sandbox
- **Routing heuristics** — Graph planning quality varies with task structure
- **Provider coverage** — Some providers may have compatibility issues
- **Performance** — No optimization work done yet; expect some overhead

### Installation requirements

- Node.js 22.19+
- Stable Rust toolchain
- Git with submodule support
- npm
- Linux: bubblewrap for Graph mode
- Windows: Git for Windows Bash
- Provider API credentials

### Platform status

| Platform | Serial | Graph | Notes |
|----------|--------|-------|-------|
| Linux (Ubuntu 22.04+) | ✅ | ✅ | Full bubblewrap sandbox |
| macOS | ✅ | ✅ | Uses sandbox-exec/Seatbelt |
| Windows | ✅ | ⚠️ | Process isolation only |

### Known issues

- First launch takes time while Cargo compiles the Rust backend
- Provider authentication requires manual setup
- Graph workspace merges can fail on complex conflicts
- Windows path handling edge cases
- Documentation still evolving

### Breaking changes

None (initial alpha release)

### Security notes

- **Use trusted projects** — Agents have filesystem access within configured boundaries
- **Windows warning** — No filesystem sandbox; agent can access full project
- **Review before approval** — Graph plans should be inspected before execution
- See [SECURITY.md](SECURITY.md) for vulnerability reporting

---

[Unreleased]: https://github.com/zhexusun10/grapher/compare/v0.1.0-alpha.2...HEAD
[0.1.0-alpha.2]: https://github.com/zhexusun10/grapher/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/zhexusun10/grapher/releases/tag/v0.1.0-alpha.1
