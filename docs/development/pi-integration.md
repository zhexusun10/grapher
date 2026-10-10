# Pi integration and upgrades

> **Status:** active
> **Scope:** Current pinned Pi baseline, integration contracts, verification limits and upgrade procedure.
> **Maintained with:** [pi-compat.ts](../../engine/pi-compat.ts), [pi-lock.json](../../engine/pi-lock.json), [pi-baseline.mjs](../../scripts/pi-baseline.mjs) and [Pi contracts](../../scripts/pi-compat.test.ts).

Pi is Grapher's only production execution-instance engine. Grapher owns graph compilation, orchestration, workspaces, platform boundaries, publication, and event persistence. Pi owns model calls, provider/auth behavior, CLI/SDK, tools, skills, and extensions.

## Ownership and pinned baseline

| Source | Responsibility |
| --- | --- |
| [pi/](../../pi/) | Unmodified upstream submodule |
| [pi-compat.ts](../../engine/pi-compat.ts) | Central SDK/private-path/CLI compatibility boundary |
| [mcp-config.ts](../../engine/mcp-config.ts) | Global/dedicated/project MCP layering using Pi validation |
| [entrypoint.mjs](../../engine/entrypoint.mjs) | Verified entrypoint using Pi's source resolver; no global fallback |
| [pi-lock.json](../../engine/pi-lock.json) | Upstream commit, lockfile, and model-data checksums |
| [pi-dependencies/](../../engine/pi-dependencies/) | Reviewed, exact runtime/build dependency profile and lock |
| [model-data/](../../engine/model-data/) | Upstream-hydrated catalog plus checksum manifest |
| [provider-host.ts](../../engine/provider-host.ts) | Separate-process upstream `ModelRuntime` bridge |
| [engine.rs](../../backend/src/engine.rs) | Role config, Pi protocol, cancellation, and execution lifecycle |
| [engine/prewarm.rs](../../backend/src/engine/prewarm.rs) | Readiness exchanges, coalescing and stale-generation cancellation |
| [engine/process_prewarm.rs](../../backend/src/engine/process_prewarm.rs) | Independent Partitioner/Planner/Serial process pools and task binding |
| [prepared-host.ts](../../engine/prepared-host.ts) | One-use host preparation/binding protocol before normal Pi initialization |
| [native.rs](../../backend/src/native.rs) | Native launchers, preflight, prepared runtime, and agent directory |
| [provider_auth.rs](../../backend/src/provider_auth.rs) | Rust provider/auth IPC bridge |

The current baseline is **Pi 1.1.0**, pinned to official upstream commit `1cedd32724abfcb0915f76cc61b6827e2c16dbad` (2026-10-08), as recorded in [pi-lock.json](../../engine/pi-lock.json).

This checkout includes two commits after stable tag `v1.1.0` (released 2026-10-07), commit `abe508e1b89912adde45528136c3221eb69acdd7`. Its package version remains `1.1.0`; it is not the exact release-tag checkout or a floating `main` checkout. Later upstream commits require explicit review and adoption.

The lock manifest, submodule gitlink, and hydrated model data form one baseline. Runtime startup must not float to a different commit or silently use a global Pi. Catalog snapshots are not a separately maintained Grapher provider implementation.

### Current baseline checks

Checks against the pinned commit `1cedd32724abfcb0915f76cc61b6827e2c16dbad`:

| Check | Result |
| --- | --- |
| `npm run pi:verify` | Passed; pinned commit, clean upstream tree, lockfile and catalog checksums verified |
| `npm run pi -- --version` | Reports `1.1.0` |
| Release ancestry/count checks | `v1.1.0` commit is an ancestor of the pinned commit; two commits follow the release |

These checks establish baseline identity, not full compatibility. Build, upgrade, provider/auth and native acceptance suites were not run as part of this verification. The loaded version of already-running backend/prewarmed agents and prepared runtime copies remains unverified; restart the backend after an upgrade to load the new baseline.

## Setup and verification

```sh
git submodule update --init --recursive
npm run pi:setup
npm run pi:verify
npm run pi -- --version
npm run pi:build
```

`pi:setup` verifies the upstream commit/lock/checksums, installs the reviewed exact dependency profile in `engine/pi-dependencies`, runs its audit, restores pinned model data, and builds the required core workspaces with Node filesystem operations. The profile excludes Pi's optional example workspaces and the `shx`/`shelljs` build chain; Pi's official source and upstream lockfile remain unchanged and are still checked by the baseline. `pi:build` rebuilds the same artifacts and rejects an unreviewed installation. Installing dependencies still requires network/cache access; "offline build" means the model catalog and build inputs are local after setup.

`npm run pi` starts the pinned CLI and shares the dedicated agent directory with Grapher. User-facing authentication and role selection are covered in [Providers](../guides/providers.md).

## Role loading policy

| Role | Policy |
| --- | --- |
| Partitioner | No tools, context files, user extensions, MCP or skills; bundled `pi-trim` only; thinking defaults to `off` |
| Planner | `node`, `edge`, `read`, `bash` plus selected global extension/MCP tools and skills; no automatic project context files |
| Node Agent | Pi native tools, selected global extensions/MCP/skills, and trusted workspace resources |
| Merger | Pi default prompt with a conflict-repair addendum (`--append-system-prompt`); fixed tools; bundled `pi-trim` only; no user extensions, MCP, skills or automatic context files |

The [path-convention](../architecture/filesystem-isolation.md#path-convention)
addendum is injected directly for Node Agent and Merger, not Partitioner or
Planner; Planner does not need to repeat execution conventions in node tasks.

The Partitioner/Planner/Serial use source-native execution. Planner Bash writes reach the source immediately without command filtering; Graph nodes use their own repositories derived from source snapshots and dependencies. The Merger runs in whichever workspace contains the conflict: a node repository or source project. Private Mergers use the same validated launcher and platform boundaries as other private executions; see [composition recovery](../architecture/execution-model.md#parent-composition-conflicts). Platform access rules and Graph path adaptation are described in [Filesystem isolation](../architecture/filesystem-isolation.md).

The backend removes inherited Pi model/session selectors and sets explicit role/session identities. Long-term auth remains upstream-owned. Do not implement a competing Rust/browser token store or silently drop supported provider credentials from the child environment.

Production engine/command selection is fixed; custom command/args injection is restricted to `fixture` builds.

## Global extension settings

Settings starts with the enabled and available Pi extension lists. Remove disables an extension **only in Grapher**, keeps the globally installed files, and moves it into the available list; Add restores it. Changes save immediately and apply to new agent processes, not a currently running turn. Idle prewarmed processes are invalidated after selection changes.

Discovery uses Pi's package manager to resolve `~/.pi/agent/settings.json`, installed npm/git/local packages, and `~/.pi/agent/extensions/` without executing extension factories or installing missing packages. Set `GRAPHER_GLOBAL_PI_AGENT_DIR` for a different global Pi directory. Credentials and Grapher selection overrides (`extensions.json`) remain in Grapher's dedicated agent directory (`PI_CODING_AGENT_DIR`, normally `~/.grapher/pi-agent`). Global MCP config and skills are also available to Planner/Node Agent; dedicated/project MCP definitions take precedence on name collisions.

`pi-trim@0.2.0` is a pinned, required project dependency from the npm registry, always enabled for every role. `package-lock.json` records the official tarball URL and SHA-512 integrity; no vendored archive or Git dependency is needed. It is the only prompt-trimming implementation. A globally installed `pi-trim` (e.g. `pi install npm:pi-trim`) is deduplicated against the bundled copy. It cannot be removed or disabled in Settings or through the API; older disabled selections are ignored. The private Graph runtime includes this package so no network install is needed at agent startup.

`pi-continuity@0.1.0` is also bundled from npm and enabled by default for Planner and Node Agent. Unlike `pi-trim`, it can be removed and added back in Settings or through the API; its selection persists under the stable `npm:pi-continuity` ID. Remove disables recovery only in Grapher, without uninstalling the package or changing global Pi configuration. Global/project copies (including `pi install npm:pi-continuity`) are deduplicated against the bundled copy, even when disabled. Partitioner, Merger, and `--no-extensions` executions do not load it. Private Graph runtimes include the complete package, including its local `lib/` modules, so startup needs no network install. Recovery uses Pi's public session boundaries after native retries and can schedule extra model turns; cancellation and the extension's default recovery budgets remain upstream-owned.

### MCP project overrides

Grapher merges external global and dedicated MCP definitions **before** applying trusted `.pi/mcp.json` entries. A project entry without `command`, `url`, or `type` may override only `enabled`, `exposure`, and `toolExposure`; connection settings and credentials stay in their original global definition. Full project definitions still replace matching servers, but cannot select provider credentials through `auth`. Untrusted project files are ignored. Validation and namespace rules come from the pinned Pi implementation.

## Compatibility findings

- **Azure configuration:** the provider ID is `azure`; the Responses **API** ID is `azure-openai-responses`. Credentials, custom provider definitions and saved model selections must use the provider ID. See [Azure configuration](../guides/providers.md#azure-configuration).
- **Pinned catalog:** `openrouter/qwen/qwen3.8-27b:free`, `openrouter/stealth/space-bunny-alpha`, and `vercel-ai-gateway/inclusionai/ling-3.0-flash-sante-free` are absent from the current snapshot; select an available replacement if configured. `opencode-go/qwen3.7-plus` and `opencode-go/qwen3.8-max` use `anthropic-messages`. Catalog/API assertions are defined in the [Pi contracts](../../scripts/pi-compat.test.ts); actual endpoint, tool and thinking behavior requires provider acceptance.
- **Saved state and extensions:** configuration and conversations are not automatically migrated after catalog/provider changes. Verify saved selections before resuming. Third-party extensions require their own compatibility review; a passing bundled-extension contract does not establish arbitrary extension compatibility.

## Updating pi-trim independently

`pi-trim` can be upgraded without moving the pinned Pi submodule, **provided the target release passes the contracts against the current Pi baseline**. The upstream peer-dependency range `*` is not a compatibility guarantee. The Pi contracts exercise local-model provider requests for all four roles, structured system-prompt sections and mid-turn updates, preserved tool declarations/project/user content, immutability, deduplication, and mandatory loading.

The Grapher prompt adapter edits `before_agent_start.systemPromptOptions`, not a full `systemPrompt` replacement. In the pinned Pi pipeline, `forceSystemPrompt` is projected **after** `context_with_system`, which can overwrite pi-trim's changes. Third-party extensions returning full prompt overrides therefore need separate review; prefer structured prompt-option changes. This is a Pi pipeline boundary, not something an arbitrary future pi-trim version can be assumed to fix.

Upgrade procedure:

1. Review the release, Node/Pi API requirements, `pi.extensions` manifest, and runtime dependencies. Grapher currently loads `extensions/index.ts` and copies the bundled extension packages (`pi-trim` and `pi-continuity`) without their peers into private runtimes; entrypoint changes or new runtime dependencies require adapting that integration first.
2. Stop active agent work. Install an **exact** registry version (`npm install --save-exact pi-trim@<version>`). Update package/lock files together. The tests derive the selected version from those files; there is no hard-coded `0.2.0` assertion to change.
3. Run `npm run test:pi`, `npm run build`, and the applicable native-launcher tests. These local-model contracts verify prompt transformations, not paid-model quality or arbitrary third-party extensions.
4. Restart the backend. Graph uses a cached shared runtime copy, and source executions can reuse prewarmed processes; neither is refreshed by changing `node_modules` or reopening Settings. Already running agents retain their loaded code.

`npm update pi-trim` does not advance the current exact version pin; select a new version explicitly using the command above. Global `pi update` or `pi install npm:pi-trim` also does not replace Grapher's deduplicated, mandatory bundled copy. Automatic/hot updates are not supported.

## Prewarming and prepared runtime

Process preparation and task/session binding are separate phases. For the configured source project, the backend concurrently keeps **one unbound process each for Auto's Partitioner, Graph's Planner and Serial's Node**. Each role has one preparation job: duplicate keys coalesce, the latest configuration replaces queued work, and generation checks cancel superseded/invalidation/shutdown preparations. Initialization and teardown run outside the pool lock. Unfinished preparation is a cache miss, not a request-path wait. Failures remain retryable.

1. **Prepare:** run the verified Grapher entrypoint, load Pi's CLI/SDK and Grapher policy code and acknowledge a correlated `grapher_prepare`. No session directory, Run identity, project snapshot, extension factory, MCP connection, user prompt or model request is created. This is **process readiness**, not Pi session readiness.
2. **Claim/bind:** only a matching source project and role can claim the process. Model/thinking/prompt changes can reuse the unbound code-loaded process: those values have not been installed yet and are taken from the actual request. Rust assigns its process tree to the Run **before** binding. It supplies the exact arguments/environment built by the normal cold launcher: real session ID/directory, role prompt/tools, Graph path, compiler and Run/execution IDs. Only then does the child discover resources, instantiate extensions and construct/resume its ordinary Pi session. A correlated `get_state` must succeed before Rust sends the user's prompt. Every preparation/binding/readiness exchange has a 30-second deadline; an invalid binding fails closed and its process is terminated, not recycled into another Run.
3. **Refill:** claiming immediately schedules the role's next unbound process, overlapping preparation with current initialization/model execution. A cold request also schedules future preparation. End-of-call retry deduplicates and cannot revert newer settings or rearm invalidated state. Claimed processes are never put back in the idle pool.

**Planner and Serial first turns use process prewarming.** Planner's extension is instantiated only after its actual Graph file is bound, so it cannot capture a placeholder or another Run's path. Conversations are written directly into their final owned directories; Partitioner workers do not create disposable conversations needing copy-back. Recovery/cleanup of legacy `partition-workers` remains supported.

Serial also retains a separate **session-ready continuation slot** for a completed source conversation. Its key includes the persisted session fingerprint; only Pi's expected startup model/thinking metadata changes are accepted. A matching continuation takes precedence over an unbound Serial host; an edited history cannot reuse stale session state, and the host fallback constructs/resumes the normal session instead. Thus the bounded budget is three unbound role slots plus at most one continuation slot, not unlimited workers per Run. Settings, extension and authentication changes invalidate affected idle state. Shutdown cancels preparation and performs bounded cleanup waits.

HTTP workers and shutdown handling start before speculative warming. Startup selects saved settings or the selected Run's configuration without calling the full bootstrap, discovering/scanning the installation cwd, serializing history, or creating a shadow snapshot merely to select a warm key. An unconfigured startup defers project-role warming until explicit configuration or normal request execution/preflight.

The mandatory Grapher workspace/prompt adapter uses a named **native ESM inline factory**. Its code shares the already imported Pi SDK instead of reloading its relative dependency graph through jiti. Importing it does not execute its factory: role, cwd, path mapping, tool overrides and handler state are still created after task binding. User/bundled extensions keep the existing loading and selection policy, including mandatory `pi-trim`.

The independent **Provider/Auth host** also prepares asynchronously, even without a selected project. Its private correlated handshake verifies code/baseline readiness only: it does not construct `ModelRuntime`, enumerate/check credentials, refresh tokens, initiate login, connect MCP, or call a model. The first normal auth request claims the ready host; pending preparation is a cold-path miss and is cancelled, not awaited. Duplicate preparation coalesces; failure is retryable. Once claimed, this single backend-owned host retains login jobs and is not replenished or invalidated with individual Runs. Catalog/auth operations continue to use fresh upstream runtimes, not a cached credential result. Shutdown cancels pending readiness and rejects rearming. The host adds at most one steady-state process to the idle-role budget above.

Graph's verified shared runtime copy is prepared asynchronously as a separate optimization; concurrent preparation coalesces and failures remain retryable. It contains reusable engine/dependencies, not project snapshots or conversations. Planner uses its source-role process pool above. **Private Graph execution nodes and Mergers still cold-start:** an unbound source process cannot acquire a private node's filesystem sandbox after launch.

The prepared engine lives outside the source so self-hosted private executions can protect their source while still loading Pi. macOS/Linux protect the engine copy from writes; Windows retains host-user permissions. Restart the backend after adapter changes. See the [runtime cleanup lifecycle](../architecture/execution-model.md#storage-and-cleanup) for leases and abandoned-copy recovery.

### Timing and regression checks

A route preview is not a confirmed outcome until the engine completes normally. In Partitioner/Planner streams and Node output, `grapher_process_started.prewarmed` records actual reuse. `prewarmStage` distinguishes `process` (unbound host, subsequently bound and RPC-verified), `session` (verified Serial continuation), and `cold`. `prewarmReadyMs` records the corresponding background preparation duration, or `null` on a miss. `taskBindingMs` measures task binding through actual session RPC readiness for a claimed host; it is `null` for cold launches and already-bound continuations. `launchPreparationMs` covers launcher/claim overhead, including private-engine-copy preparation where required. `grapher_process_exited.firstOutputMs` measures time to the first live stdout frame, **not** model time-to-first-token. Process prewarming removes code-loading latency but does not eliminate resource discovery, extension/MCP initialization, session restore or model latency.

```sh
npm run test:prewarm
npm run probe:prewarm -- --runs 3
```

Tests cover readiness/rejection/timeout, retained stdout, nonblocking claims, duplicates, latest-configuration wins, stale cancellation/completion, retry, shutdown and claimed-worker independence. Provider/Auth tests additionally cover private readiness/auth-byte preservation, single-host reuse, Run-independent ownership, pending misses, late-completion rejection, EOF recovery and shutdown cancellation. Native inline-policy tests bind two workspaces and verify their file tools do not leak paths/state after cwd/environment changes. Production HTTP/local-model coverage verifies three-role preparation, Serial's first-turn reuse and replacement readiness during a held Router response, including configuration changes. The production launcher contract binds three distinct sessions, exercises Planner's real Graph tool/compiler, checks post-bind extensions/tool policies, rejects incorrect role/project/environment bindings, and batches control/RPC frames to detect lost bytes. Preparation must make no model calls, execute no user extensions and leave the project untouched. The suite is included in `test:native`.

### Agent Core / SDK boundary

Production runs pinned Pi coding-agent; its `AgentSession` internally uses `pi-agent-core`. The [startup probe](../../scripts/probe-prewarm.mjs) compares the CLI/RPC path with a [bare-Core lower bound](../../scripts/fixtures/prewarm-core-probe.ts), using isolated directories and `get_state` only. Neither path sends a prompt; timings do not establish model latency or equivalent execution performance.

The Core probe is deliberately **not a production engine**: its state query has no authenticated model runtime, persisted Pi conversation, required `pi-trim`, selected extensions/MCP/skills, or Grapher workspace-tool policy. Its lower bound cannot be advertised as an equivalent execution speedup. There is no production switch or command override selecting it.

## Provider/auth contract checks

The adapter supports catalog, login, polling, interaction responses, cancellation, and logout. `test:pi` uses an isolated authentication directory to check the real pinned CLI and provider IPC transport without paid model calls.

For provider/adapter changes:

```sh
npm run test:pi
npm run check
node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features
npm run test:bindings
```

These checks do not replace a real login flow and model invocation when accepting an upstream upgrade.

## Upgrade procedure

1. Run `npm run pi:verify`. Preserve unrelated parent-repository changes.
2. Fetch and review the target upstream commit in `pi/`; record its full 40-character SHA.
3. Check out that exact SHA. Do not use startup `git pull` or `git submodule update --remote` as an upgrade policy.
4. Prepare model data for the target checkout, then adopt the clean commit. The normal Grapher runtime uses the reviewed `engine/pi-dependencies` profile; a temporary upstream install may be needed only when an upstream hydration script introduces a new dependency before the target can be adopted:

   ```sh
   npm ci --prefix pi
   npm --prefix pi run hydrate:model-data
   ```

5. Adopt the reviewed baseline:

   ```sh
   npm run pi:adopt -- <full-40-character-sha>
   ```

   Adoption requires a clean Pi tree and valid model data. It updates the lock manifest/checksums; it does not fetch or bypass verification. Review the parent gitlink and generated model-data changes together.

6. Regenerate and audit the reviewed profile for the adopted Pi package manifests, then inspect the resulting lockfile before committing it:

   ```sh
   node scripts/pi-dependencies.mjs generate
   npm install --package-lock-only --ignore-scripts --prefix engine/pi-dependencies
   npm audit --prefix engine/pi-dependencies --audit-level=high
   ```

7. Run `npm run pi:setup`, review source-level bindings in `pi-compat.ts`, then run `npm run pi:upgrade-check`. Check applicable platform workflows and frontend tests separately where needed.
8. Manually verify authentication interactions and real provider calls. Fixture/contract tests cannot prove semantic model compatibility.
9. Commit the gitlink, manifest, model data, adapter changes, and reviewed dependency profile as one baseline. For a fork, first make the commit publicly fetchable, update `.gitmodules`, and verify a fresh recursive clone.

Centralized adaptation reduces upgrade scope; it does **not** promise API/behavior compatibility with arbitrary future Pi versions. Failed builds or contracts are not release-ready baselines.
