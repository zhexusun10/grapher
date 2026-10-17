# Rust Backend Instructions

Applies to `backend/`; supplements [../AGENTS.md](../AGENTS.md). Contracts & task routes: [docs/index.md](../docs/index.md).

## Local constraints

- Preserve append-only event replay and persisted-data compatibility; trace changes through reducer, SQLite, API, and frontend types.
- `Finished` plus queued feedback must remain atomic: generation checks, idempotent delivery, drain-before-handoff, one active writer per directory.
- Keep node identity, execution attempt, physical directory, and Pi session distinct. Continuation keeps history; new node starts fresh.
- Do not manufacture completion during conflict resolution; retain explicit failure/recovery state.
- Production uses pinned engine. Fixture command injection is strictly feature-gated (`fixture`).
- Put regression tests beside implementation (`src/*_tests.rs`) or in `tests/`. Cover failure/restart paths.

## Validation

```sh
node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <test_filter>
```

Run only the targeted test for touched code; **never run full `npm test` by default**.
On Windows, if the binary is locked by a running service, use `npm run test:isolated` or set `CARGO_TARGET_DIR=target/temp` rather than killing processes.
