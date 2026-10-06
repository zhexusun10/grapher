# Providers, authentication, and models

Grapher delegates provider APIs, login, token refresh, and model catalogs to its pinned Pi engine. You supply a provider account/API key; Grapher does not include free model credits or host model inference.

## Sign in

1. Open **Settings → Models and providers**.
2. Choose a provider and follow its API-key or interactive sign-in flow.
3. Refresh the catalog if needed, then select an available model.

Alternatively, from the Grapher checkout:

```sh
npm run pi
```

Use the upstream CLI's `/login` or `/logout`. This entrypoint uses Grapher's pinned Pi and dedicated configuration directory, so it shares authentication with the UI and execution instances.

Provider catalogs depend on the pinned version. Use the models actually offered by your authenticated provider rather than assuming a model from another Pi installation is available.

## Credentials and environment

Long-term authentication and refresh state belong to Pi's `ModelRuntime`. The UI submits the inputs required for an authentication interaction; the Rust adapter bridges the protocol rather than implementing its own token store.

The default configuration directory is **`~/.grapher/pi-agent`**. Set `PI_CODING_AGENT_DIR` to use another dedicated directory. Old credentials from `~/.pi/agent` are **not automatically migrated**; sign in through the Grapher entrypoint.

Pi can also use supported provider environment variables, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Set them in the backend's environment or the Git-ignored `.env`, not in `.env.example` or committed scripts. Environment changes require a backend restart.

Dedicated storage is not a credential sandbox: model tools can still access credentials available to their process. Avoid untrusted projects/extensions and never publish auth files, full logs, or screenshots containing secrets.

### Custom model configuration

Pi model configuration lives in its agent directory. For compatibility, when Grapher's `models.json` is absent, the launcher may link or copy an existing `~/.pi/agent/models.json`. This is model configuration reuse, not authentication migration.

`GRAPHER_ISOLATED_PI_MODELS=1` disables that inheritance. Benchmark runs use isolated model configuration so a hidden local endpoint cannot alter the evaluated model. See [Harbor](../benchmarks/harbor.md).

### Azure migration for Pi 1.0.3

Pi 1.0.3 renames the Azure **provider** from `azure-openai-responses` to `azure`. For example, select `azure/gpt-4o-mini` instead of `azure-openai-responses/gpt-4o-mini`. Old configuration is not migrated automatically.

1. Finish or cancel active work and restart the backend after the upgrade. Back up the dedicated Pi configuration before manual edits.
2. Sign in to **Azure** again in Settings or through `npm run pi` → `/login`. Alternatively, rename only the provider key in `auth.json` to `azure`, preserving its credential value.
3. Rename the provider key in custom `models.json` definitions. **Do not rename `api: "azure-openai-responses"`** on Responses models: that API ID is unchanged. Chat Completions models such as `azure/deepseek-v4-pro` use `api: "openai-completions"`.
4. Update Pi `settings.json` references (`defaultProvider`, `enabledModels`, `modelThinkingLevels`), Grapher's default/role model selections, and any `*_MODEL` environment overrides to `azure/...`. Reapply any Azure logout/disabled-provider selection under the new ID.

`AZURE_OPENAI_*` environment variables, including the API key, endpoint and deployment-name map, are unchanged. Old sessions retain their provider metadata; upstream restoration can fall back to another model and does not reuse the old Azure prompt cache. Verify the selected model before continuing, or start a new conversation. The [upgrade validation](../development/pi-integration.md#pi-103-compatibility-validation) records the tested boundaries.

## Default and role-specific models

A model identifier uses **`provider/model`**. In Settings, choose models and thinking levels separately for:

| Role | Purpose | Default behavior |
| --- | --- | --- |
| Partitioner | Fast route classification | Inherits the default model; thinking defaults to `off` |
| Planner | Graph design and repository inspection | Inherits default model/thinking unless overridden |
| Node Agent / Pi Instance | Coding tasks | Inherits default model/thinking unless overridden |
| Merger | Node composition, Planner publication, and final publication conflicts | Uses Node Agent settings unless overridden by environment |

Role settings are stored as `roleModels.partitioner`, `.planner`, and `.nodeAgent`. Legacy `model`/`thinkingLevel` remain defaults. Saving settings affects subsequent Runs, not already-running sessions.

Smaller low-latency models may suit the Partitioner; graph planning and difficult coding can need stronger models. This is a configuration choice, not a quality or speed guarantee.

## Environment overrides

Role-specific environment variables take precedence over UI settings:

```text
PARTITIONER_MODEL / PARTITIONER_THINKING
PLANNER_MODEL     / PLANNER_THINKING
NODE_AGENT_MODEL  / NODE_AGENT_THINKING
MERGER_MODEL      / MERGER_THINKING
```

The legacy `*_TIMEOUT_SECONDS` role variables are ignored. Production role sessions have no Grapher-imposed per-role deadline; stop/cancel ends a session. A benchmark runner can impose a separate end-to-end trial budget.

Available thinking levels depend on the selected model. The UI reports effective overrides; check them when a role appears to ignore a saved selection.

The backend removes inherited `PI_MODEL`, `PI_THINKING`, `PI_PROVIDER`, `PI_REASONING_LEVEL`, `PI_SESSION_ID`, and `PI_SESSION_FILE` before passing explicit role/session configuration. Set Grapher's documented role overrides, not an outer Pi session's identity.

## Troubleshooting

- **No available models:** authenticate the provider, refresh its status, and check environment credentials.
- **Unavailable saved model:** choose another available model; a saved identifier alone does not establish provider access. Upgrades can retire models or change their API; see the [Pi 1.0.3 catalog findings](../development/pi-integration.md#compatibility-findings) and the Azure migration above.
- **Unexpected endpoint/model:** inspect role environment overrides and Pi model configuration.
- **Authentication failure during routing:** the Run fails explicitly; it is not silently converted into Serial.
- **CLI login does not affect Grapher:** confirm you used `npm run pi` from this checkout and the same `PI_CODING_AGENT_DIR` as the backend.

For adapter development and safe upgrades, see [Pi integration](../development/pi-integration.md).
