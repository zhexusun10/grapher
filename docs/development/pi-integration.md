# Pi integration and upgrades

Pi is Grapher's only production execution-instance engine. Grapher owns graph compilation, orchestration, workspaces, platform boundaries, publication, and event persistence. Pi owns model calls, provider/auth behavior, CLI/SDK, tools, skills, and extensions.

## Ownership and pinned baseline

| Source | Responsibility |
| --- | --- |
| [pi/](../../pi/) | Unmodified upstream submodule |
| [pi-compat.ts](../../engine/pi-compat.ts) | Central SDK/private-path/CLI compatibility boundary |
| [entrypoint.mjs](../../engine/entrypoint.mjs) | Verified entrypoint using repository-local tsx; no global fallback |
| [pi-lock.json](../../engine/pi-lock.json) | Upstream commit, lockfile, and model-data checksums |
| [model-data/](../../engine/model-data/) | Upstream-hydrated catalog plus checksum manifest |
| [provider-host.ts](../../engine/provider-host.ts) | Separate-process upstream `ModelRuntime` bridge |
| [engine.rs](../../backend/src/engine.rs) | Role config, Pi protocol, cancellation, and execution lifecycle |
| [native.rs](../../backend/src/native.rs) | Native launchers, preflight, prepared runtime, and agent directory |
| [provider_auth.rs](../../backend/src/provider_auth.rs) | Rust provider/auth IPC bridge |

The lock manifest, submodule gitlink, and hydrated model data form one baseline. Runtime startup must not float to a different commit or silently use a global Pi. Catalog snapshots are not a separately maintained Grapher provider implementation.

## Setup and verification

```sh
git submodule update --init --recursive
npm run pi:setup
npm run pi:verify
npm run pi -- --version
npm run pi:build
```

`pi:setup` verifies commit/lock/checksums, installs upstream dependencies, restores pinned model data, and builds offline from that data. `pi:build` rebuilds the required upstream workspace artifacts. Installing dependencies still requires network/cache access; "offline build" does not mean a fresh checkout contains every npm package.

`npm run pi` starts the pinned CLI and shares the dedicated agent directory with Grapher. User-facing authentication and role selection are covered in [Providers](../guides/providers.md).

## Role loading policy

| Role | Policy |
| --- | --- |
| Partitioner | No tools, context files, automatic skills/extensions; thinking defaults to `off` |
| Planner | `node`, `edge`, `read`, `bash`; explicit Grapher planning extension; no automatic project context/extensions |
| Node Agent | Pi native tools and trusted workspace skills/extensions |
| Merger | Pi default prompt with a fixed conflict-repair addendum (`--append-system-prompt`); fixed tools; no automatic project context/extensions |

The Partitioner/Serial use source-native execution. The Planner uses a private project copy, and Graph nodes use their own repositories. The Merger runs in whichever workspace contains the conflict: a node repository, Planner publication preview, or source project. Private Mergers use the same validated launcher and platform boundaries as other private executions; see [composition recovery](../architecture/execution-model.md#parent-composition-conflicts). Platform access rules and Graph path adaptation are described in [Filesystem isolation](../architecture/filesystem-isolation.md).

The backend removes inherited Pi model/session selectors and sets explicit role/session identities. Long-term auth remains upstream-owned. Do not implement a competing Rust/browser token store or silently drop supported provider credentials from the child environment.

Production engine/command selection is fixed; custom historical command/args injection is restricted to `fixture` builds.

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
4. Install the target upstream lockfile and hydrate model data:

   ```sh
   npm ci --prefix pi
   npm --prefix pi run hydrate:model-data
   ```

5. Adopt the reviewed baseline:

   ```sh
   npm run pi:adopt -- <full-40-character-sha>
   ```

   Adoption requires a clean Pi tree and valid model data. It updates the lock manifest/checksums; it does not fetch or bypass verification. Review the parent gitlink and generated model-data changes together.

6. Run `npm run pi:setup`, review source-level bindings in `pi-compat.ts`, then run `npm run pi:upgrade-check`. Check applicable platform workflows and frontend tests separately where needed.
7. Manually verify authentication interactions and real provider calls. Fixture/contract tests cannot prove semantic model compatibility.
8. Commit the gitlink, manifest, model data, and adapter changes as one reviewed baseline. For a fork, first make the commit publicly fetchable, update `.gitmodules`, and verify a fresh recursive clone.

Centralized adaptation reduces upgrade scope; it does **not** promise API/behavior compatibility with arbitrary future Pi versions. Failed builds or contracts are not release-ready baselines.
