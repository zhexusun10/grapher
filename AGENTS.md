## Routing (Read on demand ONLY)

Do NOT bulk-scan `docs/` or read sub-guides outside your task scope:

- `backend/` (Rust runtime, SQLite, API): Read [backend/AGENTS.md](backend/AGENTS.md)
- `engine/` (Pi adapter, workspace tools): Read [engine/AGENTS.md](engine/AGENTS.md)
- `src/` (React UI, API client): Stateless projection view; backend owns all state truth.
- `pi/`: Pinned upstream submodule (**READ-ONLY**, never scan or edit).
- Cross-cutting tasks: Check the `Task routes` table in [docs/index.md](docs/index.md) for exact entry files.

## Global Redlines

- **Read-only baseline**: Never hand-edit `pi/`, `pi-lock.json`, `model-data/`, or `pi-dependencies/`.
- **Host & data safety**: Never stop running services, delete runtime/workspace data, or migrate SQLite without explicit user authorization.
- **Cargo wrapper**: Always invoke Cargo via `node scripts/cargo.mjs` (never bare `cargo`).

## Verification (Targeted Only)

**NEVER run `npm test` or full suites by default.** Run only the single check matching your edits:

- **Types**: `npm run check`
- **Frontend/Engine test**: `npx tsx --test scripts/<specific>.test.ts` (or `node --test scripts/<specific>.test.mjs`)
- **Backend test**: `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <test_filter>`