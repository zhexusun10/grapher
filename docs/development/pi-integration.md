# Pi integration and upgrades

Pi is Grapher's only production execution-instance engine. Grapher owns graph compilation, orchestration, workspaces, platform boundaries, publication, and event persistence. Pi owns model calls, provider/auth behavior, CLI/SDK, tools, skills, and extensions.

## Ownership and pinned baseline

| Source | Responsibility |
| --- | --- |
| [pi/](../../pi/) | Unmodified upstream submodule |
| [pi-compat.ts](../../engine/pi-compat.ts) | Central SDK/private-path/CLI compatibility boundary |
| [mcp-config.ts](../../engine/mcp-config.ts) | Global/dedicated/project MCP layering using Pi validation |
| [entrypoint.mjs](../../engine/entrypoint.mjs) | Verified entrypoint using repository-local tsx; no global fallback |
| [pi-lock.json](../../engine/pi-lock.json) | Upstream commit, lockfile, and model-data checksums |
| [pi-dependencies/](../../engine/pi-dependencies/) | Reviewed, exact runtime/build dependency profile and lock |
| [model-data/](../../engine/model-data/) | Upstream-hydrated catalog plus checksum manifest |
| [provider-host.ts](../../engine/provider-host.ts) | Separate-process upstream `ModelRuntime` bridge |
| [engine.rs](../../backend/src/engine.rs) | Role config, Pi protocol, cancellation, and execution lifecycle |
| [native.rs](../../backend/src/native.rs) | Native launchers, preflight, prepared runtime, and agent directory |
| [provider_auth.rs](../../backend/src/provider_auth.rs) | Rust provider/auth IPC bridge |

The current baseline is **Pi 1.0.1**, official tag `v1.0.1`, commit `a7229ddc21810d6245105978033b7df645ecc2f7`.

The recorded validation ran on Windows x64 with Node.js 24.16.0, npm 12.1.0, Cargo 1.98.1, Git for Windows Bash, fd 10.5.0, and ripgrep 15.2.0. An isolated `CARGO_TARGET_DIR` was used because the existing backend process held `backend/target/debug/grapher.exe` open. The running service was not stopped or restarted.

The lock manifest, submodule gitlink, and hydrated model data form one baseline. Runtime startup must not float to a different commit or silently use a global Pi. Catalog snapshots are not a separately maintained Grapher provider implementation.

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

The Partitioner/Planner/Serial use source-native execution. Planner Bash writes reach the source immediately without command filtering; Graph nodes use their own repositories derived from source snapshots and dependencies. The Merger runs in whichever workspace contains the conflict: a node repository or source project. Private Mergers use the same validated launcher and platform boundaries as other private executions; see [composition recovery](../architecture/execution-model.md#parent-composition-conflicts). Platform access rules and Graph path adaptation are described in [Filesystem isolation](../architecture/filesystem-isolation.md).

The backend removes inherited Pi model/session selectors and sets explicit role/session identities. Long-term auth remains upstream-owned. Do not implement a competing Rust/browser token store or silently drop supported provider credentials from the child environment.

Production engine/command selection is fixed; custom historical command/args injection is restricted to `fixture` builds.

## Global extension settings

Settings starts with the enabled and available Pi extension lists. Remove disables an extension **only in Grapher**, keeps the globally installed files, and moves it into the available list; Add restores it. Changes save immediately and apply to new agent processes, not a currently running turn. Idle prewarmed processes are invalidated after selection changes.

Discovery uses Pi's package manager to resolve `~/.pi/agent/settings.json`, installed npm/git/local packages, and `~/.pi/agent/extensions/` without executing extension factories or installing missing packages. Set `GRAPHER_GLOBAL_PI_AGENT_DIR` for a different global Pi directory. Credentials and Grapher selection overrides (`extensions.json`) remain in Grapher's dedicated agent directory (`PI_CODING_AGENT_DIR`, normally `~/.grapher/pi-agent`). Global MCP config and skills are also available to Planner/Node Agent; dedicated/project MCP definitions take precedence on name collisions.

`pi-trim@0.2.0` is a pinned, required project dependency from the npm registry, always enabled for every role. `package-lock.json` records the official tarball URL and SHA-512 integrity; no vendored archive or Git dependency is needed. It replaces the former in-project prompt trimming; no second trimming implementation remains. A globally installed `pi-trim` (e.g. `pi install npm:pi-trim`) is deduplicated against the bundled copy. It cannot be removed or disabled in Settings or through the API; older disabled selections are ignored. The private Graph runtime includes this package so no network install is needed at agent startup.

### MCP project overrides in Pi 1.0.1

Grapher merges external global and dedicated MCP definitions **before** applying trusted `.pi/mcp.json` entries. A project entry without `command`, `url`, or `type` may override only `enabled`, `exposure`, and `toolExposure`; connection settings and credentials stay in their original global definition. Full project definitions still replace matching servers, but cannot select provider credentials through `auth`. Untrusted project files are ignored. Validation and namespace rules come from the pinned Pi implementation.

## Pi 1.0.1 compatibility validation

The `pi/` submodule was upgraded from `v1.0.0` (`a13d35a742c6ef8462812a28fbe1d8c8b7431c32`) to the official `v1.0.1` commit above. The submodule remains unmodified. `engine/pi-lock.json` and the checksummed model catalog were updated together; the upstream Pi source and upstream dependency lockfile were not patched.

The upgrade required these Grapher-side adaptations:

1. **MCP project overrides:** Grapher merges external global and dedicated MCP definitions before applying trusted project entries, using Pi's validator. Project overrides can change only `enabled`, `exposure`, and `toolExposure`; global credentials and source provenance remain attached to the base definition. Tests cover precedence, trust restrictions, invalid patches, namespace collisions, and parity with Pi's single-directory loader.
2. **Bash result contract:** Pi 1.0 returns nonzero commands as `isError: true` with structured exit status. Timeout and cancellation continue to throw. Grapher's smoke assertions now check the result shape without changing execution behavior.
3. **Isolated integration builds:** Extension, project-binding, and Windows native tests honor `CARGO_TARGET_DIR`, so they can run while another backend binary is in use.
4. **Windows planning history aliases:** `list_plannings` and `get_planning_snapshot` compare canonical directories and recognize Windows drive/device and UNC aliases for archived paths. Missing, unresolvable, unrelated, and unattributed paths remain fail-closed. Tests cover ordinary and `\\?\\` paths, case and separator aliases, Unicode names, UNC share boundaries, deleted directories, and failed history.
5. **Reviewed dependency profile:** `pi:setup` installs the exact profile in [engine/pi-dependencies](../../engine/pi-dependencies/) instead of Pi's optional example workspaces. It excludes the Gondolin example and the `shx`/`shelljs`/`fast-glob`/`micromatch`/`braces` chain. [build-pi.mjs](../../scripts/build-pi.mjs) rebuilds the required core artifacts with Node filesystem operations. Runtime launchers verify the profile marker, lock versions, package graph, and workspace bindings before starting Pi.

The validation results were:

| Check | Result |
| --- | --- |
| `npm run pi:setup` | Passed; profile installation audited with 0 vulnerabilities and all Pi 1.0.1 core artifacts rebuilt |
| `npm run pi:verify`, `npm run pi:build` | Passed; baseline, model catalog, profile, and workspace build checks |
| `npm run pi -- --version` | Reports `1.0.1` |
| `npm run test:pi` | Passed: 25 Pi CLI/SDK, provider/auth, extension, prompt, MCP, and adapter tests |
| `npm run pi:upgrade-check` | Passed; Pi contracts, TypeScript, full Rust fixtures, extension tools, native launchers, and project bindings |
| `npm run check`, `npm run build` | Passed; the production Vite build retains its normal large-chunk warning |
| `npm run check:docs` and documentation tests | Passed; local Markdown links, anchors, and npm references checked |
| `npm test` | Passed; full Rust fixture suite, with the existing synthetic performance test intentionally ignored |
| Targeted repository-binding Rust tests | Passed: four alias/Windows path tests plus the legacy fail-closed filtering test |
| `npm run test:windows-native` | Passed: native Planner Bash, concurrent Graph execution, inheritance/publication, cancellation, and crash recovery |
| `npm run test:merger` | Passed: source-native Planner writes/revisions, failed-revision persistence, retained dependency composition, node/source conflict repair, publication, and ordinary/extended Windows bindings |
| `npm audit --prefix engine/pi-dependencies --audit-level=high` | Passed with 0 info, low, moderate, high, or critical vulnerabilities |

The official upstream Pi lockfile still reports seven high-severity entries if audited directly with `npm audit --prefix pi`: five entries are the unused development `shx` chain and two are the optional Gondolin example's `node-forge` chain. Grapher's default setup does not install that graph, and the production launcher refuses to run an unreviewed Pi installation. The official source and checksum-verified upstream lockfile remain unchanged for baseline provenance.

The remaining acceptance limits are host and provider boundaries: paid provider calls and interactive OAuth were not performed; Linux bubblewrap and macOS Seatbelt were not exercised on this Windows host; and the documented Node.js 22.19 minimum was not separately exercised on this Node.js 24 host. Saved provider/model selections are not rewritten automatically after catalog refreshes. Already running or prewarmed agents and prepared native-runtime copies retain their loaded engine and adapter code, so the backend must be restarted after an engine or adapter upgrade.

To reproduce the recorded validation on Windows, use an isolated Cargo directory when a backend is running:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD '.grapher/pi-1.0.1-target'
$env:PI_OFFLINE = '1'
npm run pi:setup
npm run pi:verify
npm run pi:build
npm run pi -- --version
npm run test:pi
npm run test:windows-native
npm run test:merger
npm audit --prefix engine/pi-dependencies --audit-level=high
```

See [Testing](testing.md) for the responsibility of each suite and the platform-specific acceptance boundaries.

## Updating pi-trim independently

`pi-trim` can be upgraded without moving the pinned Pi submodule, **provided the target release passes the contracts against the current Pi baseline**. The upstream peer-dependency range `*` is not a compatibility guarantee. Current checks cover real provider requests for all four roles, Pi 1.0 structured sections and mid-turn updates, preserved tool declarations/project/user content, immutability, deduplication, and mandatory loading.

The Grapher prompt adapter edits `before_agent_start.systemPromptOptions`, not a full `systemPrompt` replacement. In pinned Pi 1.0, `forceSystemPrompt` is projected **after** `context_with_system`, which can overwrite pi-trim's changes. Third-party extensions returning full prompt overrides therefore need separate review; prefer structured prompt-option changes. This is a Pi pipeline boundary, not something an arbitrary future pi-trim version can be assumed to fix.

Upgrade procedure:

1. Review the release, Node/Pi API requirements, `pi.extensions` manifest, and runtime dependencies. Grapher currently loads `extensions/index.ts` and copies only pi-trim into private runtimes; entrypoint changes or new runtime dependencies require adapting that integration first.
2. Stop active agent work. Install an **exact** registry version (`npm install --save-exact pi-trim@<version>`). Update package/lock files together. The tests derive the selected version from those files; there is no hard-coded `0.2.0` assertion to change.
3. Run `npm run test:pi`, `npm run build`, and the applicable native-launcher tests. These local-model contracts verify prompt transformations, not paid-model quality or arbitrary third-party extensions.
4. Restart the backend. Graph uses a cached shared runtime copy, and source executions can reuse prewarmed processes; neither is refreshed by changing `node_modules` or reopening Settings. Already running agents retain their loaded code.

`npm update pi-trim` does not advance the current exact version pin; select a new version explicitly using the command above. Global `pi update` or `pi install npm:pi-trim` also does not replace Grapher's deduplicated, mandatory bundled copy. Automatic/hot updates are not supported.

## Prewarming and prepared runtime

The backend can prestart an idle, single-use Partitioner RPC session for the selected project/model. Auto planning claims it and replenishes the idle slot. Mismatched project/model or incompatible inputs still cold-start. Authentication changes invalidate idle warm state; a claimed process belongs to its Run and cancels with it.

A route preview is not a confirmed outcome until the engine completes normally. `grapher_process_started.prewarmed` in the partition stream records reuse.

Graph's verified shared runtime copy can also be prepared asynchronously at startup, config save, authentication completion, or preflight. Concurrent preparation coalesces; failures remain retryable. This preparation does not call a model, snapshot a project, or reuse a Planner conversation.

The prepared engine lives outside the source so self-hosted private executions can protect their source while still loading Pi. macOS/Linux protect the engine copy from writes; Windows retains host-user permissions. Restart the backend after adapter changes.

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
