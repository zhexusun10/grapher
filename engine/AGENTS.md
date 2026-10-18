# Pi Adapter Instructions

Applies to `engine/`; supplements root `AGENTS.md`.

## Boundaries

- **Single binding**: Keep upstream SDK/CLI imports and API assumptions in `pi-compat.ts`. Use public exports for tool/provider APIs; do not duplicate Pi's auth or model runtime implementations.
- **Local overrides**: Keep local model overrides in git-ignored `model-data-local/`. Never commit credentials.
- **Prewarming**: Prewarming must not create sessions or make model calls. Do not share mutable run/session state across independent runs.
