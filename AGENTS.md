## Instruction scope

- Keep `AGENTS.md` files limited to constraints applicable within their directory scope. Put task maps, background, and procedures in [docs/index.md](docs/index.md) or its linked documentation.
- Do not bulk-scan `docs/`; read only documentation relevant to the current task.

## Global Redlines

- **Read-only baseline**: Do not scan or edit `pi/`. Never hand-edit `pi-lock.json`, `model-data/`, or `pi-dependencies/`. Baseline upgrades must follow the [upgrade procedure](docs/development/pi-integration.md#upgrade-procedure).
- **Runtime authority**: Frontend interaction state and caches must not become an independent source of truth for backend-persisted runtime state.
- **Host & data safety**: Never stop running services, delete runtime/workspace data, or migrate SQLite without explicit user authorization.
- **Cargo wrapper**: Always invoke Cargo via `node scripts/cargo.mjs` (never bare `cargo`).

## Verification

Do not run `npm test` or full suites by default. Limit routine verification to checks relevant to the changed behavior; commands and prerequisites live in [Testing](docs/development/testing.md).
