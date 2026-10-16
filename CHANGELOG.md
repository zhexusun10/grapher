# Changelog

All notable changes to Grapher will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-10-17

### Changed

- Rename the node execution status `done` to `completed` across the runtime, snapshot events, planner prompts and UI. Historical checkpoints are normalized in memory on load while stored events stay unchanged, so existing Runs keep rendering and completing correctly.
- Clarify the Planner prompt and `node`/`edge` tool contracts: an Executor's context is isolated — other nodes' names, tasks and file responsibilities are not automatically included, so necessary context must be supplied in the task or inherited project files — and dependency handoff is described as project-file results instead of filesystem state; the feedback-edge description states that the feedback target receives the source's completed project-file state.
- Rework the conversation transcript pipeline: a dedicated incremental transcript parser service replaces the ad-hoc rendering logic in the virtualized transcript, conversation-history auto-fill is bounded per burst by bytes and resumes on upward wheel, touch or keyboard gestures instead of loading unbounded history, the planner shows a live elapsed duration while planning, and expanding or collapsing the workspace details panel scrolls only the additional required height without shifting the conversation.
- Batch concurrent `<FEEDBACK>` requests that review the same target execution and revision into one repair: only senders of applicable `<FEEDBACK>` contribute project-file results and instructions (`<ACCEPT>`, exhausted and superseded requests contribute neither), a separate target-owned Git slot composes the senders' pinned commits with the existing Merger handling conflicts, the target and its ordinary dependency descendants are invalidated once, feedback budgets are consumed once per applied source/target edge rather than per batch, and sender directories stay reserved as immutable recovery evidence until the repair releases them.
- Treat a malformed `<ACCEPT>`/`<FEEDBACK>` verdict as a protocol error instead of a node failure: the worker synchronously pushes at most two bounded repair turns into the node's own session asking it to restate the verdict without repeating work, streaming into the same execution transcript with the first readable verdict committed; the execution fails with the protocol error only when the repair budget is exhausted, while provider or execution errors inside a repair turn fail normally.
- Stop running executions in a pending feedback's scope immediately instead of letting them finish into a discarded result: the runtime marks them doomed, records their failures, and settles them before the batch invalidates the scope and dispatches the repair.
- Pin the reviewed target execution from dispatch order in feedback requests so directory handoff cannot redirect a repair at a moved head; legacy requests without that execution identity retain exact-head validation and are not grouped into batches.
- Bound Grapher's outbound tool-output display log: a new engine projection retains at most 100 KiB per tool-result body (trailing `...` plus truncation metadata), suppresses redundant cumulative `tool_execution_update.partialResult` bodies while keeping one identity/arguments update per tool, applies the same limit to message/turn/agent aggregates so results cannot return through another event, and a browser preview limiter caps legacy results and live cards before rendering or copying. Pi's own session, model context and actual tool results are untouched, and existing stored logs are never rewritten.

### Fixed

- Sort the workbench overview node chips by execution order instead of alphabetically and remove their redundant hover title.
- Prevent the workbench prompt placeholder from clipping when the node name is long.
- Keep prompt-box controls in normal flow instead of nested layout projections, fixing mode-selector motion and broken button hover transitions during resize.
- Adopt only the residue of the target's own failed repair attempt when retrying a single-source feedback handoff, provided the pinned input is still a Git ancestor of the live tree and the attempt failed in that same directory; external mutations, sender drift and multi-source senders remain refused. A failed multi-source repair retains its partial target workspace for continuation and claims a queued user continuation that would duplicate the node instruction, so the retry keeps the batch input instead of re-batching the text.
- Make the transcript paging status label represent a paging burst rather than each individual request: fast isolated reads do not flash it, short gaps between successive pages do not hide it, and its display timers never initiate reads, advance cursors or gate conversation readiness.

## [1.0.0] - 2026-10-16

### Added

- Dispatch a node-composition Merger when fan-in parent environments are incompatible: it selects one verified input environment or builds a new private environment offline, then Runtime discovers and captures the result. A simultaneous Git and environment conflict uses one Merger with both prompt segments concatenated; environment directory trees are never merged and there is no network or host-Python fallback.
- Show Mergers as selectable cards in the execution graph: node-composition Mergers beside their target and the publication Merger as a `publication merger` card below the terminal layer; steer a running merger, continue a settled publication merger's session, and keep settled node-composition cards read-only.

### Changed

- Stop injecting the "Already published in this run" paragraph into Planner revision prompts and instead carry a rework note — modifying a completed node's task re-runs it in a fresh session and invalidates its downstream dependents, while unrelated branches keep their results — in both the revision status block and the post-task review turn; the `node` tool description and the `E210` unremovable-node rejection still enforce the never-delete rule.
- Materialize the temporary shadow Git snapshot for an ordinary folder lazily on the first node dispatch instead of during detection, planning or approval; reclaim it after a successful publication (Run deletion and offline GC also reclaim it), and keep it for failed/interrupted Runs that need `retry_publication`. The first dispatch reports a non-blocking `source_materialize` activity.
- Run completed-node conversations directly in the source directory (no worktree, commit, downstream invalidation or republication) for both ordinary folders and standard Git repositories; a settled publication-merger follow-up follows the same rule once a successful publication has reclaimed the ordinary folder's snapshot; only a Planner revision that dispatches new nodes rebuilds the snapshot.
- Accept user edits in the source directory during Graph execution: downstream handoff and explicit node updates no longer block on a dirty source, and publication commits pending user changes as its base before merging node results.
- Share content-keyed Pi engine/dependency caches across projects and backend restarts, with reader leases and serialized preparation instead of per-backend copies.
- Default workspace/engine caches to the OS cache directory (Windows: `%LOCALAPPDATA%\Grapher`), preserving existing runtime histories and legacy execution paths.
- Upgrade the pinned Pi engine to the official stable 1.2.0 release (exact `v1.2.0` tag), refreshing the checksummed model catalog and reviewed dependency profile; the profile drops the removed experimental `client`, `protocol` and `server` workspaces and adds `@silvia-odwyer/photon` for Durable image handling.
- Upgrade the pinned Pi engine to the official stable 1.3.0 release (exact `v1.3.0` tag), refreshing the checksummed model catalog and reviewed dependency profile against the new release.
- Extend the Pi contracts with Azure provider/API, credential-migration, retired 1.2.0 catalog, OpenRouter router placeholder-price and `before_agent_start` user/custom event-union regressions; revalidate extensions, prepared hosts and Windows production execution against Pi 1.2.0.
- Extend the Pi catalog contract with the 1.3.0 retirements (`openrouter/inclusionai/ling-3.0-flash-sante`, `opencode/step-5-preview-free`) and the OpenCode Go inference-endpoint/Google Generative AI API change; the source-level `pi-compat.ts` bindings, the reviewed dependency profile build and the bundled `pi-trim`/`pi-continuity` extensions needed no adaptation for Pi 1.3.0.
- Upgrade the bundled `pi-continuity` extension from 0.2.0 to 0.2.1, expanding the default continuation budgets (16 resumes and 12 stream attempts per user request), broadening transient-error and output-truncation classification, and hardening malformed-message guards. The bounded 15-minute usage-limit polling added in 0.2.0 is unchanged.

### Fixed

- Keep aborted Planner turns in the conversation after a reload or restart. A revision turn that ends without committing a graph — a failed or stopped follow-up, or one interrupted by exiting the backend — is now recorded once as a `planner_turn_aborted` history event (startup recovery records interrupted attempts too), so its durable planning output replays with the rest of the Run conversation while the compiled graph, phase and approval state stay untouched.
- Scrub the synthetic post-task review prompt from embedded lifecycle records (`agent_end`) when persisting the Planner transcript, so the hidden turn stays out of the browser-facing planning data, not only out of the rendered user turns.
- Strip injected transport lines (the rework note and the legacy "Already published in this run" paragraph) from Planner status blocks so saved transcripts render the user's turn instead of leaking runtime status context.
- Reject the user's desktop folder as a project workspace. Forced Git collection ignores `.gitignore`, so a desktop binding would snapshot unrelated personal data and stall planning before any node is dispatched.
- Retry transient Chocolatey community-feed failures in Windows CI and verify both `rg` and `fd` before running tests, instead of failing later on a missing binary.
- Resolve host Git for the Grapher-owned engine bootstrap independently of the business launch PATH, so pinned-baseline verification keeps working when a managed environment omits Git.
- Keep fixture result-entry launches off the platform sandbox: disposable test workspaces live under the test data root, which production Linux/macOS geometry intentionally rejects. Native suites built without the fixture feature still cover the real boundaries.

### Breaking Changes

- Pi's Azure provider ID changes from `azure-openai-responses` to `azure`. Existing credentials, custom provider definitions and saved model references require [migration](docs/guides/providers.md#azure-configuration); the Responses API ID and `AZURE_OPENAI_*` environment variables are unchanged.
- The refreshed 1.2.0 snapshot additionally retires `openrouter/inclusionai/ling-3.0-flash-sante:free`, `opencode/fledge-alpha-free` and the `google-vertex` `gemini-flash-latest`/`gemini-flash-lite-latest` aliases, on top of the earlier OpenRouter/Vercel retirements, and switches two `opencode-go` models to the Anthropic API; see the [catalog compatibility findings](docs/development/pi-integration.md#compatibility-findings) before continuing saved selections. With an OpenRouter key, Pi now narrows its catalog to the models that key may use, so the Settings catalog and saved selections can change with the key.
- The refreshed 1.3.0 snapshot retires `openrouter/inclusionai/ling-3.0-flash-sante` and `opencode/step-5-preview-free` and shrinks the OpenCode Zen catalog, so saved selections for those providers need replacement; see the [catalog compatibility findings](docs/development/pi-integration.md#compatibility-findings). `kimi-coding` now uses Chat Completions at `https://api.kimi.com/coding/v1`, so a custom `models.json` base URL for that provider must include the trailing `/v1`. A resumed session now restores the tools activated during it, applied under Grapher's explicit `--tools`/`--no-tools`/`--exclude-tools` role selection.
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
- **Performance** — No optimization work completed yet; expect some overhead

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
