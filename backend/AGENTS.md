# Rust Backend Instructions

Applies to `backend/`; supplements root `AGENTS.md`.

## Invariants

- **Event sourcing**: Preserve append-only replay and transactions within the current persisted format. Reject unsupported database, event, session and workspace formats before mutation; do not migrate or repair older generations. Server startup may preserve an incompatible store and select a separate current-format data directory; direct Store/Runtime opens stay strict. When changing shared events or payloads, keep the current reducer, persistence, API, and frontend contracts aligned.
- **Atomic state transitions**: `Finished` state + queued feedback must remain atomic (enforce generation checks, idempotent delivery, drain-before-handoff, and single active writer per directory).
- **Entity separation**: Do not treat node identity, execution attempt, physical directory, and Pi session as interchangeable identifiers. Continuation must retain its history; a new node must not inherit another node's conversation.
- **Explicit failure**: Never manufacture completion during conflict resolution; retain explicit failure/recovery state.
- **Feature gates**: Production must use the pinned engine; fixture command injection must stay behind `--features fixture`.
- **Regression coverage**: Reuse existing failure/recovery tests; add a focused case only for a changed behavior not already covered.