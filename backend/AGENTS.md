# Rust Backend Instructions

Applies to `backend/`; supplements root `AGENTS.md`.

## Invariants

- **Event sourcing**: Preserve append-only event replay and SQLite schema compatibility. When changing shared events or payloads, keep the affected reducer, persistence, API, and frontend type contracts compatible.
- **Atomic state transitions**: `Finished` state + queued feedback must remain atomic (enforce generation checks, idempotent delivery, drain-before-handoff, and single active writer per directory).
- **Entity separation**: Do not treat node identity, execution attempt, physical directory, and Pi session as interchangeable identifiers. Continuation must retain its history; a new node must not inherit another node's conversation.
- **Explicit failure**: Never manufacture completion during conflict resolution; retain explicit failure/recovery state.
- **Feature gates**: Production must use the pinned engine; fixture command injection must stay behind `--features fixture`.
- **Tests**: Changes to failure or recovery behavior must have regression coverage for the affected failure and restart paths.
- **Locked build artifacts**: If a running service locks build artifacts, isolate the original targeted check's Cargo output rather than switching to a broader test suite.