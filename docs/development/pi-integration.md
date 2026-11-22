# Grapher's Pi adapter

Scope: Grapher-side integration, not an upstream Pi implementation guide. [CONTRIBUTING.md](../../CONTRIBUTING.md) covers checkout setup; [Testing](testing.md) covers check selection and prerequisites.

[pi-compat.ts](../../engine/pi-compat.ts) contains Grapher's SDK/CLI binding. Pi owns model/auth behavior; Grapher owns role loading, workspace policy, process lifecycle, and persistence. Role model resolution lives in `PiModelConfig` in [engine.rs](../../backend/src/engine.rs); the recorded baseline lives in [pi-lock.json](../../engine/pi-lock.json).

## Role loading policy

| Role | Grapher loading policy |
| --- | --- |
| Partitioner | No tools, context files, user extensions, MCP, or skills; bundled `pi-trim` only. |
| Planner | `edit_graph`, `read_graph`, `read`, `bash`, selected extensions/MCP/skills; `write`/`edit` only when `plannerWriteTools` is enabled (default true; explicit opt-outs are preserved). Eligible [follow-ups](../architecture/execution-model.md#planner-follow-up-workspaces) expose `switch_workspace`. No automatic project context files. |
| Serial Agent | Pi's native file/shell tools, selected extensions/MCP/skills, trusted source resources and the ordinary source-project prompt. |
| Graph Node Agent | Grapher's path-adapted tools, selected extensions/MCP/skills and trusted workspace resources; private Graph nodes receive the relative-path convention. |
| Merger | Native file/shell tools, bundled `pi-trim` and selected `pi-continuity`; no user extensions, MCP, skills, or automatic context files. Git repair appends the repair addendum; follow-ups retain the user's instruction. |

Serial Agent and Graph Node Agent have distinct execution identities and Bash policies. They currently share the `nodeAgent` model/thinking settings profile; that profile does not determine runtime agent identity.

Merger inherits the effective Node Agent model and thinking level. Each field resolves independently: nonblank `MERGER_MODEL` / `MERGER_THINKING`, then `NODE_AGENT_MODEL` / `NODE_AGENT_THINKING`, then the saved `nodeAgent` role field, then the legacy configuration default. Saving and dispatch timing belong to [Runtime](../architecture/runtime.md#scheduling-and-concurrency); running calls are not hot-swapped.

Working directories, source-write effects, and platform permissions belong to [Execution model](../architecture/execution-model.md) and [Filesystem isolation](../architecture/filesystem-isolation.md), not this loading table.

## Composer commands

The composer owns `/model` and `/thinking` menus and validates selections against
Pi's provider catalog/capabilities. `/model` shares Settings' full available-model
selection and ordering (without a result-count cap); its open menu observes catalog
refreshes and authentication changes through the shared catalog store. Graph (and Auto) main input targets Planner;
Serial main input targets the conversation's Node Agent profile; a node input
targets only that node. Home-screen selections stay in the unsent conversation
draft. Settings always edits the conversation's role profiles, even while a node
is selected; outside a conversation it edits defaults for new conversations.
Persistence, dispatch timing and explicit node precedence belong to [Runtime](../architecture/runtime.md#scheduling-and-concurrency).

`/scoped-models` (also `/scoped model`) opens Grapher's global model visibility
manager, available before a Pi session starts. The same control sits at the bottom
of the Settings model card. Its own Save persists only edited hide/show entries in
`PI_CODING_AGENT_DIR/model-visibility.json`, not role selections or Pi credentials.
Hidden entries are excluded from `/model` (including manually typed selections)
and every Settings role picker. Already-selected hidden models keep their stored
configuration and are represented by a generic hidden-selection label; running
calls and historical metrics are not rewritten. The manager can restore hidden or
retired entries. The Provider/Auth bridge serializes updates, merges
changes with the latest file and fails explicitly on invalid/unwritable data.
Visibility survives backend/browser restarts, propagates across open same-origin
tabs and is re-read on picker opening. This is a Grapher-wide visibility rule,
not Pi's session-local Ctrl+P cycling scope.

Enabled extensions register their composer commands through Pi's ordinary extension loader and `get_commands` protocol. [extension-commands.ts](../../engine/extension-commands.ts) supplies an independent command context when no matching active Pi process is available; command names and handlers are not maintained in per-package lists. It loads the selected extensions for the composer's current repository, including trusted project extensions and MCP overrides. Each discovery or execution uses a short-lived RPC worker with an in-memory Pi context, without creating a Grapher Run, saving a session, or making model calls. Host, project, invocation and dialog identities fence replies; changing projects or leaving the composer cancels pending dialogs, and abandoned invocations expire. Settings' read-only extension catalog remains separate from this explicit command-loading path.

The composer reads one command catalog: the matching active Pi process when present, otherwise the selected project's independent command host. It does not merge a second catalog into an active process or synthesize MCP/third-party extension entries and subcommands. Opening `/` shows catalog loading/failure state and a refresh/retry control. Extension selection changes invalidate the catalog, and scope/revision/request checks discard stale responses. Unknown or disabled commands receive an explicit error instead of a misleading request to start a conversation.

Extension dialogs focus their first control and return focus on close. Selection lists longer than eight options have a text filter; arrow keys navigate choices and Escape cancels. Input dialogs submit with Enter and preserve newlines with Shift+Enter; editors retain Enter for newlines and submit with Ctrl/Cmd+Enter. IME confirmation never submits or cancels a dialog.

`/name` renames the opened conversation card in the sidebar without altering
its original goal prompt; it works only in the main conversation composer (Graph
Planner or Serial), not in a Graph node agent dialog. `/compact`, `/session` (`/stats`) and `/copy` require an **active** Pi process because they operate on conversation history. Registered extension commands, including `/reload`, use the matching active process when available and otherwise the independent command context; operations that request a real conversation or inference fail explicitly there.
`/mcp` appears when the selected command context has registered it. With an active process it reports that process's connection status; without one it reports the independent context's status for the selected project. `/mcp login`, `/mcp logout` and `/mcp reconnect` retain Pi's server selection and authentication flows (optional server name). MCP must be enabled for the role. Command names in both contexts come from `get_commands`. Skills keep their existing
prompt-expansion path, and active-session prompt templates use ordinary message
submission. Unknown commands (including `/help`) and session-management commands (`/quit`, `/exit`,
`/new`, `/tree`, `/fork`, `/clone`, `/resume`, session switching, auth and Pi
settings) are rejected, never submitted as an ordinary goal. `/reload` delegates
to Pi's command-context reload action after the current turn becomes idle; the
adapter does not implement a second resource loader. `/compact` likewise uses an
adapter extension command that waits for idle, then awaits the SDK compaction
callback. It never sends the raw compact RPC, which aborts a streaming turn;
processes without the adapter command reject it instead of falling back.

[Composer RPC](../../backend/src/engine/composer.rs) resolves a Run-owned active
execution or Planner and pins each request to a process-instance token. UI reads
and replies also carry a unique command ID. Because Pi's UI stream is process-wide,
[command ownership](../../backend/src/engine/composer_ui.rs) admits only one composer
invocation at a time until Pi acknowledges it; overlapping invocations are rejected
without sending another command. A late poll/reply/completion cannot drain, cancel
or release a newer invocation, even in another tab or after returning to the same
live process. HTTP timeout alone does not release an unacknowledged command.
Only the server's command allowlist reaches Pi, not arbitrary client RPC. Command pending
requests hold the normal settle handoff open; catalog/control acknowledgements
do not manufacture another agent turn. Extension `select`, `confirm`, `input`,
and `editor` requests use browser controls; notifications and editor replacement
are supported. TUI-only widgets/status/title/custom rendering are not emulated.
RPC custom-terminal component factories produce an explicit warning instead of
Pi's silent no-op; their TUI cannot be rendered in the browser. Notification URLs
are clickable, and string status/widgets are projected to the floating card.
Leaving the composer cancels outstanding dialogs. Until that command settles,
in-flight and subsequent polls still drain/cancel dialogs against the original
process instance and command ID; late editor updates/notices never reach the newly
selected scope. A client that stops polling loses its UI lease: outstanding and
subsequent dialogs are cancelled, while another invocation still waits for Pi's
acknowledgement. UI requests/responses and command-handler errors (which can echo
input values) stay in process memory. Ordinary extension lifecycle errors remain
durable diagnostics, visible in live Planner and replayed execution transcripts;
they do not by themselves mark the underlying agent turn failed. A timeout reports
an unknown result, not rollback. See [browser coverage](../../scripts/composer-commands-ui.test.mjs)
and the engine/server composer tests for scope, filtering and UI round trips.

## Global extension settings

Settings Add/Remove changes Grapher's selection, not installed global files. Changes apply to new processes and invalidate affected idle prewarmed processes, not running turns. Discovery does not execute extension factories or install missing packages. The Settings card reads a page-session catalog ([piExtensions.ts](../../src/services/piExtensions.ts)) so a reopen paints the rows it last read and refreshes behind them; the card must not fall back to a shorter loading placeholder, because a late height change moves the Settings pane under a reader who already scrolled it. Only the refresh control and a successful Add/Remove bypass that snapshot.

External resources default to `~/.pi/agent` (`GRAPHER_GLOBAL_PI_AGENT_DIR` overrides it). Grapher credentials and selection overrides use `PI_CODING_AGENT_DIR`, normally `~/.grapher/pi-agent`. Dedicated resources shadow external copies; bundled copies are deduplicated against both. [global-extensions.ts](../../engine/global-extensions.ts) owns discovery, identity, and precedence.

`pi-trim` is mandatory for every role and recognizes both the Pi 1.4 and Pi 1.5 default identities; Grapher launches default `pi-trim` to `aggressive` mode (stripping Pi's `<tools>` summary list while preserving `<rules>`, tool schemas, and explicit `/pi-trim mode` branch overrides). `pi-continuity` is enabled by default for Planner/Node/Merger and can be disabled. `pi-better-web-search` is off by default for Planner/Node and must be enabled in Settings. It exposes `web_search` when a dedicated search API, Pi-authenticated official DeepSeek Search/Fetch, or an authenticated compatible lightweight model is available. Exact releases and integrity belong in `package.json` and `package-lock.json`, not a second version list here. The root `pi-ai` and `pi-coding-agent` packages provide extension peers and are pinned to the version recorded in `pi-lock.json`; review them alongside any source baseline upgrade.

Dedicated search APIs support Parallel, Keenable, Exa, Perplexity and DeepSeek independently of the conversation model. Saved keys are resolved per provider: Grapher's `<PI_CODING_AGENT_DIR>/better-web-search-auth.json`, then the external Pi directory's `better-web-search-auth.json` (normally `~/.pi/agent`, overridden by `GRAPHER_GLOBAL_PI_AGENT_DIR`), then `PARALLEL_API_KEY`, `KEENABLE_API_KEY`, `EXA_API_KEY`, `PERPLEXITY_API_KEY` or `DEEPSEEK_API_KEY`. The bundled compatibility shim delegates parsing to the extension, reads inherited keys afresh, and keeps writes in the dedicated store; it never copies inherited keys into environment values or rewrites the external file. An explicit `PI_BETTER_WEB_SEARCH_AUTH` path or `GRAPHER_ISOLATED_PI_SEARCH=1` disables inheritance. The upstream extension's login/logout/status actions still require its local TUI; its help, provider and API menus use the normal RPC command bridge. Pi's official DeepSeek provider credentials work without an available chat model. Model-backed routes require OpenAI `luna`, Claude `haiku`, or other brands' `flash` models; other tiers are not fallback candidates. The default timeout is 60 seconds for response headers and a separate 60 seconds of output inactivity, both configurable with `PI_BETTER_WEB_SEARCH_TIMEOUT_MS`.

An available Parallel key (including an inherited saved key) activates Parallel unless `apis.parallel` is explicitly `false` in the search settings. While active, `web_search` uses `objective` plus 1–3 `search_queries` for search, or `urls` with an optional `objective` for extraction. Parallel takes priority over manual provider preferences and disables cross-provider fallback because its schema differs from the usual `query` / `urls` schema. Disable it with `/web-search-api parallel` to restore the usual schema, provider selection and fallback. Parallel also counts as a private search API in Grapher's Settings and suppresses the synthetic Keenable public-endpoint default; an explicit Keenable choice remains intact.

### MCP project overrides

[mcp-config.ts](../../engine/mcp-config.ts) merges external global, dedicated, then trusted project `.pi/mcp.json` definitions. Partial project entries may override only `enabled`, `exposure`, and `toolExposure`; full definitions replace matching servers but cannot select credentials through `auth`. Untrusted project definitions are ignored.

## Provider/auth contract checks

[provider-host.ts](../../engine/provider-host.ts) and [provider_auth.rs](../../backend/src/provider_auth.rs) bridge catalog/login/poll/cancel/logout to Pi; Grapher does not maintain a separate credential implementation. [Process contracts](../../scripts/pi-process-contract.test.mjs) cover the bridge's isolated IPC transport, including Codex method selection, browser URL/callback prompts and cancellation/restart without storing credentials.

[ProviderSettings.tsx](../../src/components/ProviderSettings.tsx) renders upstream select/text/secret prompts for both API-key and OAuth flows; OAuth must not assume the first interaction is a URL. It attempts to open each HTTP(S) authorization/device URL once and retains a clickable fallback for popup blocking. The animated login panel follows the provider card or bound-credential row that started it; an active provider remains visible when the search filter changes, and exiting panels are inert. Bound-credential expansion resets on reopening Settings; only the supported-provider list retains its page-session expansion. Successful authentication briefly displays confirmation before automatically collapsing the supported-provider list. Closing the login panel, starting another login or closing Settings cancels that pending collapse. Closing Settings immediately stops polling and automatic URL opening, including during its exit animation. Refresh errors remain visible outside a collapsed login section.

Provider refresh and new execution runtimes read `~/.pi/agent/models.json` as an overlay on the dedicated `PI_CODING_AGENT_DIR/models.json` (normally `~/.grapher/pi-agent/models.json`). Pi fields win on conflicts; provider model arrays merge by model ID, with the Pi definition replacing the matching dedicated definition. Dedicated-only model definitions remain part of the current two-source configuration; remove unwanted dedicated entries from that file explicitly. The original dedicated file is not rewritten, and a one-time `models.json.grapher-backup` is made before merging both files. The merged snapshot can contain credentials. It is written in a per-process temporary directory and removed on normal process exit; a forced termination or crash may leave it behind. The Pi credential and models stores stay in the dedicated agent directory. `GRAPHER_ISOLATED_PI_MODELS=1` disables the overlay. Running sessions keep their existing model runtime; refresh affects catalog reads and new execution runtimes.

## Persisted format boundary

Grapher owns admission in [pi-compat.ts](../../engine/pi-compat.ts). Managed sessions require Pi header `version: 3`, `grapherFormat: 1` and the owning `grapherRunId`. SDK load/continue/switch/fork and backend header/cwd edits reject unsupported or foreign sessions before rewriting them. A standalone Pi process can create its own tagged session, but that session cannot be imported into a managed Run without matching Run ownership. Same-Run forks retain entry IDs and history, including SDK `createBranchedSession` branches whose generated headers must be tagged before their first write. Headerless current entry lists remain valid for `SessionManager.inMemory`; an explicit session header still goes through format and ownership validation. Current timestamp/occurrence matching remains necessary because Pi live user rows precede persistence of the tree entry ID.

Startup rejects inputs that would trigger upstream migrations: session JSONL files in the agent root, `commands/`, old `tools/fd` or `tools/rg` binaries, `oauth.json` without `auth.json`, old settings fields and old keybinding names. Preflight uses Pi's path normalization, including tilde and file-URL inputs. Settings validation respects the SDK's project trust option; ignored project settings cannot block global-only discovery. CLI checks still cover migration directories. Unrelated extension logs, including large first records, are not classified as sessions. These checks also apply before SettingsManager/resource loading; files are left untouched. Current `auth.json`, shared model overlays and explicitly configured global extensions/skills remain supported. npm resources must resolve from their managed agent/project installation paths; Grapher does not search old npm/pnpm global installations.

The built-in `edit` boundary accepts `{path, edits}` and rejects top-level `oldText/newText`, including mixed requests that also carry `edits`. Normalization of a stringified edits array or one edit object remains available for current model input. `pi-trim` remains mandatory; retired trim overrides are rejected rather than silently corrected in memory.

[Pi boundary tests](../../scripts/pi-compat.test.ts) verify refusal without migration side effects and current session/tool behavior. These policies do not modify the pinned Pi checkout or bypass the baseline upgrade procedure.

## Prewarming and prepared runtime

Source Partitioner/Planner/Node roles prepare unbound processes without sessions, user extensions, project writes, or model calls. A matching request binds its execution agent kind, project and session before extension factories and tools are initialized; the role-neutral source prewarm can therefore become either a Serial Agent or a source-direct Graph Node Agent. Pending preparation is a cold-path miss, not a request-path wait. Claimed processes are not recycled across Runs. Serial may separately retain a verified continuation session.

Provider/Auth readiness loads code without constructing a credential runtime, checking credentials, or initiating login. A parked Serial shell must match the next turn's model and thinking settings; see [Process lifecycle](../architecture/filesystem-isolation.md#parked-serial-shells-and-held-planner-services). Private Graph nodes, private Planner turns, and Mergers cold-start through their platform launcher; an already-started source process cannot acquire that private sandbox later.

[process_prewarm.rs](../../backend/src/engine/process_prewarm.rs), [prepared-host.ts](../../engine/prepared-host.ts), and their tests own handshake/timing details. Startup dispatch carries a selection generation reserved before reading settings or delaying work; a newer settings save or invalidation prevents that producer from submitting any remaining roles. Global and project resource discovery run concurrently after binding, read current settings, and retain project precedence; discovery does not execute factories.

Within one backend lifecycle, the host issues a verification context (`GRAPHER_BASELINE_CONTEXT`) so `verifyRuntimeBaseline` reuses fingerprint-checked Git baseline and `pi/node_modules` dependency stamps across source hosts. After admitting the shared private runtime, the host also primes its `.grapher-runtime-cache` with a separate stamp for that installation and V8 compiled CLI code. Private launches receive this path through `GRAPHER_RUNTIME_CACHE_DIR`; macOS/Linux expose it through the existing read-only engine boundary, while session temp directories remain independent. Stamps remain context/fingerprint scoped, survive other backends' startup, and are reclaimed with the leased runtime. Missing or unavailable caches retain full verification. Resident Provider/Auth and prepared-role hosts flush compiled code before reporting readiness so later processes can consume it without waiting for their exit. Pi source aliases still resolve to `pi/packages/*/src`.

`npm run probe:prewarm -- --runs 3` compares verified CLI/Core startup and isolated Serial cold, process-bind, and already-ready-session RPC latency. Process preparation is reported separately; the probe makes no model requests and does not measure first model output or a full Run handoff. Core omits required production policies and is only a lower bound. Shared engine copies contain code/dependencies and code caches, not Run state; cache ownership and reclamation belong to [Storage and cleanup](../architecture/storage.md#shared-pi-runtime-cache).

## Upgrade procedure

Baseline upgrades are separate, explicitly requested maintenance, not part of routine adapter work:

1. Agree the reviewed exact target and authorize affected restarts. [pi-baseline.mjs](../../scripts/pi-baseline.mjs) owns adoption/setup/build; [pi-dependencies.mjs](../../scripts/pi-dependencies.mjs) owns the reviewed dependency profile. Review generated gitlink, manifest, catalog, and dependency changes together; do not hand-edit frozen inputs.
2. Adoption requires a clean target and valid model data. After updating the root Pi package pins and lockfile, run `npm run pi:verify`: it checks the source commit, tracked and untracked checkout changes, source package version and lock hash, reviewed model-data hashes, and root Pi peer pins. Runtime startup also checks the source baseline; its dependency-profile check is separate. Ignored build artifacts and the optional local model-data overlay are intentionally allowed and are not proven pristine by this check.
3. Select affected adapter, bundled-extension, and platform checks from [Testing](testing.md). Existing processes keep loaded code, so stop the backend, provider host, and every prewarmed Partition/Planner/Node worker before accepting the upgraded runtime; restart the whole application rather than only retrying planning. A process that survives the upgrade can mix an old cached module with new source and fail with a missing-export error such as `ownedSlice`.

Bundled extensions can be updated independently using exact project dependency pins and matching lockfile changes, validated against the current baseline's [SDK contracts](../../scripts/pi-compat.test.ts). A global Pi/package update does not replace Grapher's bundled copy.

Pi terminal components return readonly render output and may reuse the same cached array. Extensions that transform a component's output must copy it before mutation. Grapher's browser command bridge does not render terminal components; check any selected extension's terminal behavior separately when upgrading it.
