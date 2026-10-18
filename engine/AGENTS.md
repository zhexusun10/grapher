# Pi Adapter Instructions

Applies to `engine/`; supplements root `AGENTS.md`. Deep dive: [docs/development/pi-integration.md](../docs/development/pi-integration.md).

## Boundaries

- **Single binding**: `pi-compat.ts` is the sole binding for upstream SDK/CLI. Use public Pi exports; never re-implement auth or model stacks.
- **Frozen baseline**: `pi-lock.json`, `pi/`, `model-data/`, and `pi-dependencies/` are read-only. Upgrade only via documented procedure.
- **Local overrides**: Place model overrides only in git-ignored `model-data-local/`. Never commit credentials.
- **Prewarming**: Prewarming loads code without creating sessions or model calls; never share mutable run state. Do not restart user backend merely to refresh prepared runtime copies.
