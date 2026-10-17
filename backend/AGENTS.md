# Rust Backend Instructions

Applies to `backend/`; supplements root `AGENTS.md`.

## Invariants

- **Event sourcing**: Preserve append-only event replay and SQLite schema compatibility. Trace contract changes across reducer, SQLite, API (`server.rs`), and frontend types (`src/types.ts`).
- **Atomic state transitions**: `Finished` state + queued feedback must remain atomic (enforce generation checks, idempotent delivery, drain-before-handoff, and single active writer per directory).
- **Entity separation**: Keep node identity, execution attempt, physical directory, and Pi session strictly distinct. Continuation keeps history; a new node starts fresh.
- **Explicit failure**: Never manufacture completion during conflict resolution; retain explicit failure/recovery state.
- **Feature gates**: Production uses pinned engine; fixture command injection must stay behind `--features fixture`.
- **Tests**: Place regression tests in `src/*_tests.rs` or `tests/`, covering failure and restart paths.

## Backend Verification

- **Check**: `node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features`
- **Test**: `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <test_filter>`
- **Windows file lock**: If the binary is locked by a running service, use `npm run test:isolated` or set `CARGO_TARGET_DIR=target/temp` (never kill running processes).