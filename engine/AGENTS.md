# Pi Adapter Instructions

Applies to `engine/`; supplements [../AGENTS.md](../AGENTS.md). Integration docs: [docs/development/pi-integration.md](../docs/development/pi-integration.md).

## Boundaries

- `pi-compat.ts` is the central binding for upstream SDK/CLI. Prefer public Pi exports; never re-implement an auth/model stack.
- `pi-lock.json`, `pi/`, `model-data/`, and `pi-dependencies/` form a frozen baseline. Upgrade only via documented procedure; never hand-edit or patch submodule in-place.
- Model overrides belong only in git-ignored `model-data-local/`. Never commit real credentials.
- Prewarming loads code without creating sessions or model calls; never share mutable run state.
- Prepared runtime copies retain loaded code; do not restart user backend merely to refresh them.

## Verification (Targeted only)

- **Type checks**: `npm run check`
- **Single targeted test**: `node --test scripts/<specific>.test.mjs` or `npx tsx --test scripts/<specific>.test.ts`

Do NOT run heavy integration suites (`npm run test:pi`, `npm run test:native`, `pi:upgrade-check`) for routine edits.
