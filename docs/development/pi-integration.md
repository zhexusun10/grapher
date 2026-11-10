# Grapher's Pi adapter

Scope: Grapher-side integration, not an upstream Pi implementation guide. [CONTRIBUTING.md](../../CONTRIBUTING.md) covers checkout setup; [Testing](testing.md) covers check selection and prerequisites.

[pi-compat.ts](../../engine/pi-compat.ts) contains Grapher's SDK/CLI binding. Pi owns model/auth behavior; Grapher owns role loading, workspace policy, process lifecycle, and persistence. Role model resolution lives in `PiModelConfig` in [engine.rs](../../backend/src/engine.rs); the recorded baseline lives in [pi-lock.json](../../engine/pi-lock.json).

## Role loading policy

| Role | Grapher loading policy |
| --- | --- |
| Partitioner | No tools, context files, user extensions, MCP, or skills; bundled `pi-trim` only. |
| Planner | `node`, `edge`, `read`, `bash`, selected extensions/MCP/skills; `write`/`edit` only when `plannerWriteTools` is enabled (default false). Eligible [follow-ups](../architecture/execution-model.md#planner-follow-up-workspaces) expose `switch_workspace`. No automatic project context files. |
| Serial Agent | Pi's native file/shell tools, selected extensions/MCP/skills, trusted source resources and the ordinary source-project prompt. |
| Graph Node Agent | Grapher's path-adapted tools, selected extensions/MCP/skills and trusted workspace resources; private Graph nodes receive the relative-path convention. |
| Merger | Native file/shell tools, bundled `pi-trim` and selected `pi-continuity`; no user extensions, MCP, skills, or automatic context files. Git repair appends the repair addendum; follow-ups retain the user's instruction. |

Serial Agent and Graph Node Agent have distinct execution identities and Bash policies. They currently share the `nodeAgent` model/thinking settings profile; that profile does not determine runtime agent identity.

Working directories, source-write effects, and platform permissions belong to [Execution model](../architecture/execution-model.md) and [Filesystem isolation](../architecture/filesystem-isolation.md), not this loading table.

## Global extension settings

Settings Add/Remove changes Grapher's selection, not installed global files. Changes apply to new processes and invalidate affected idle prewarmed processes, not running turns. Discovery does not execute extension factories or install missing packages. The Settings card reads a page-session catalog ([piExtensions.ts](../../src/services/piExtensions.ts)) so a reopen paints the rows it last read and refreshes behind them; the card must not fall back to a shorter loading placeholder, because a late height change moves the Settings pane under a reader who already scrolled it. Only the refresh control and a successful Add/Remove bypass that snapshot.

External resources default to `~/.pi/agent` (`GRAPHER_GLOBAL_PI_AGENT_DIR` overrides it). Grapher credentials and selection overrides use `PI_CODING_AGENT_DIR`, normally `~/.grapher/pi-agent`. Dedicated resources shadow external copies; bundled copies are deduplicated against both. [global-extensions.ts](../../engine/global-extensions.ts) owns discovery, identity, and precedence.

`pi-trim` is mandatory for every role and recognizes both the Pi 1.4 and Pi 1.5 default identities. `pi-continuity` is enabled by default for Planner/Node/Merger and can be disabled. `pi-better-web-search` is off by default for Planner/Node and must be enabled in Settings; before enabling, confirm at least one configured provider supports the `web_search` API. It registers search only for supported available providers. Exact releases and integrity belong in `package.json` and `package-lock.json`, not a second version list here. The root `pi-ai` and `pi-coding-agent` packages provide extension peers and are pinned to the version recorded in `pi-lock.json`; review them alongside any source baseline upgrade.

### MCP project overrides

[mcp-config.ts](../../engine/mcp-config.ts) merges external global, dedicated, then trusted project `.pi/mcp.json` definitions. Partial project entries may override only `enabled`, `exposure`, and `toolExposure`; full definitions replace matching servers but cannot select credentials through `auth`. Untrusted project definitions are ignored.

## Provider/auth contract checks

[provider-host.ts](../../engine/provider-host.ts) and [provider_auth.rs](../../backend/src/provider_auth.rs) bridge catalog/login/poll/cancel/logout to Pi; Grapher does not maintain a separate credential implementation. [Process contracts](../../scripts/pi-process-contract.test.mjs) cover the bridge's isolated IPC transport.

Provider refresh and new execution runtimes read `~/.pi/agent/models.json` as an overlay on the dedicated `PI_CODING_AGENT_DIR/models.json` (normally `~/.grapher/pi-agent/models.json`). Pi fields win on conflicts; provider model arrays merge by model ID, with the Pi definition replacing the matching dedicated definition. Dedicated-only entries remain, including entries in older Windows copies; remove unwanted dedicated entries from that file explicitly. The original dedicated file is not rewritten, and a one-time `models.json.grapher-backup` is made before merging both files. The merged snapshot can contain credentials. It is written in a per-process temporary directory and removed on normal process exit; a forced termination or crash may leave it behind. The Pi credential and models stores stay in the dedicated agent directory. `GRAPHER_ISOLATED_PI_MODELS=1` disables the overlay. Running sessions keep their existing model runtime; refresh affects catalog reads and new execution runtimes.

## Prewarming and prepared runtime

Source Partitioner/Planner/Node roles prepare unbound processes without sessions, user extensions, project writes, or model calls. A matching request binds its execution agent kind, project and session before extension factories and tools are initialized; the role-neutral source prewarm can therefore become either a Serial Agent or a source-direct Graph Node Agent. Pending preparation is a cold-path miss, not a request-path wait. Claimed processes are not recycled across Runs. Serial may separately retain a verified continuation session.

Provider/Auth readiness loads code without constructing a credential runtime, checking credentials, or initiating login. A parked Serial shell must match the next turn's model and thinking settings; see [Process lifecycle](../architecture/filesystem-isolation.md#parked-serial-shells). Private Graph nodes, private Planner turns, and Mergers cold-start through their platform launcher; an already-started source process cannot acquire that private sandbox later.

[process_prewarm.rs](../../backend/src/engine/process_prewarm.rs), [prepared-host.ts](../../engine/prepared-host.ts), and their tests own handshake/timing details. Shared engine copies contain code/dependencies, not Run state; cache ownership and reclamation belong to [Storage and cleanup](../architecture/storage.md#shared-pi-runtime-cache).

## Upgrade procedure

Baseline upgrades are separate, explicitly requested maintenance, not part of routine adapter work:

1. Agree the reviewed exact target and authorize affected restarts. [pi-baseline.mjs](../../scripts/pi-baseline.mjs) owns adoption/setup/build; [pi-dependencies.mjs](../../scripts/pi-dependencies.mjs) owns the reviewed dependency profile. Review generated gitlink, manifest, catalog, and dependency changes together; do not hand-edit frozen inputs.
2. Adoption requires a clean target and valid model data. After updating the root Pi package pins and lockfile, run `npm run pi:verify`: it checks the source commit, tracked and untracked checkout changes, source package version and lock hash, reviewed model-data hashes, and root Pi peer pins. Runtime startup also checks the source baseline; its dependency-profile check is separate. Ignored build artifacts and the optional local model-data overlay are intentionally allowed and are not proven pristine by this check.
3. Select affected adapter, bundled-extension, and platform checks from [Testing](testing.md). Existing processes keep loaded code, so stop the backend, provider host, and every prewarmed Partition/Planner/Node worker before accepting the upgraded runtime; restart the whole application rather than only retrying planning. A process that survives the upgrade can mix an old cached module with new source and fail with a missing-export error such as `ownedSlice`.

Bundled extensions can be updated independently using exact project dependency pins and matching lockfile changes, validated against the current baseline's [SDK contracts](../../scripts/pi-compat.test.ts). A global Pi/package update does not replace Grapher's bundled copy.
