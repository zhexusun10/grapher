# Grapher's Pi adapter

Scope: Grapher-side integration, not an upstream Pi implementation guide. [Development](contributing.md) covers checkout setup; [Testing](testing.md) covers check selection and prerequisites.

[pi-compat.ts](../../engine/pi-compat.ts) contains Grapher's SDK/CLI binding. Pi owns model/auth behavior; Grapher owns role loading, workspace policy, process lifecycle, and persistence. Role model resolution lives in `PiModelConfig` in [engine.rs](../../backend/src/engine.rs); the recorded baseline lives in [pi-lock.json](../../engine/pi-lock.json).

## Role loading policy

| Role | Grapher loading policy |
| --- | --- |
| Partitioner | No tools, context files, user extensions, MCP, or skills; bundled `pi-trim` only. |
| Planner | `node`, `edge`, `read`, `bash`, selected extensions/MCP/skills; `write`/`edit` only when `plannerWriteTools` is enabled (default false). Eligible [follow-ups](../architecture/execution-model.md#planner-follow-up-workspaces) expose `switch_workspace`. No automatic project context files. |
| Node Agent / Serial | Native file/shell tools, selected extensions/MCP/skills, and trusted workspace resources. |
| Merger | Native file/shell tools, bundled `pi-trim` and selected `pi-continuity`; no user extensions, MCP, skills, or automatic context files. Git repair appends the repair addendum; follow-ups retain the user's instruction. |

Working directories, source-write effects, and platform permissions belong to [Execution model](../architecture/execution-model.md) and [Filesystem isolation](../architecture/filesystem-isolation.md), not this loading table.

## Global extension settings

Settings Add/Remove changes Grapher's selection, not installed global files. Changes apply to new processes and invalidate affected idle prewarmed processes, not running turns. Discovery does not execute extension factories or install missing packages.

External resources default to `~/.pi/agent` (`GRAPHER_GLOBAL_PI_AGENT_DIR` overrides it). Grapher credentials and selection overrides use `PI_CODING_AGENT_DIR`, normally `~/.grapher/pi-agent`. Dedicated resources shadow external copies; bundled copies are deduplicated against both. [global-extensions.ts](../../engine/global-extensions.ts) owns discovery, identity, and precedence.

`pi-trim` is mandatory for every role. `pi-continuity` is enabled by default for Planner/Node/Merger and can be disabled. `pi-better-web-search` is enabled by default for Planner/Node, registering search only for supported available providers. Exact releases and integrity belong in `package.json` and `package-lock.json`, not a second version list here.

### MCP project overrides

[mcp-config.ts](../../engine/mcp-config.ts) merges external global, dedicated, then trusted project `.pi/mcp.json` definitions. Partial project entries may override only `enabled`, `exposure`, and `toolExposure`; full definitions replace matching servers but cannot select credentials through `auth`. Untrusted project definitions are ignored.

## Provider/auth contract checks

[provider-host.ts](../../engine/provider-host.ts) and [provider_auth.rs](../../backend/src/provider_auth.rs) bridge catalog/login/poll/cancel/logout to Pi; Grapher does not maintain a separate credential implementation. [Process contracts](../../scripts/pi-process-contract.test.mjs) cover the bridge's isolated IPC transport.

## Prewarming and prepared runtime

Source Partitioner/Planner/Serial roles prepare unbound processes without sessions, user extensions, project writes, or model calls. A matching request binds its own role/project/session before prompting; pending preparation is a cold-path miss, not a request-path wait. Claimed processes are not recycled across Runs. Serial may separately retain a verified continuation session.

Provider/Auth readiness loads code without constructing a credential runtime, checking credentials, or initiating login. Private Graph nodes, private Planner turns, and Mergers cold-start through their platform launcher; an already-started source process cannot acquire that private sandbox later.

[process_prewarm.rs](../../backend/src/engine/process_prewarm.rs), [prepared-host.ts](../../engine/prepared-host.ts), and their tests own handshake/timing details. Shared engine copies contain code/dependencies, not Run state; cache ownership and reclamation belong to [Storage and cleanup](../architecture/storage.md#shared-pi-runtime-cache).

## Upgrade procedure

Baseline upgrades are separate, explicitly requested maintenance, not part of routine adapter work:

1. Agree the reviewed exact target and authorize affected restarts. [pi-baseline.mjs](../../scripts/pi-baseline.mjs) owns adoption/setup/build; [pi-dependencies.mjs](../../scripts/pi-dependencies.mjs) owns the reviewed dependency profile. Review generated gitlink, manifest, catalog, and dependency changes together; do not hand-edit frozen inputs.
2. Adoption requires a clean target and valid model data. `pi:verify` currently only prints the recorded commit (`verifyBaseline()` is a no-op); it does not prove checkout cleanliness or baseline integrity.
3. Select affected adapter, bundled-extension, and platform checks from [Testing](testing.md). Existing processes keep loaded code, so coordinate restarts before accepting the upgraded runtime.

Bundled extensions can be updated independently using exact project dependency pins and matching lockfile changes, validated against the current baseline's [SDK contracts](../../scripts/pi-compat.test.ts). A global Pi/package update does not replace Grapher's bundled copy.
