# Rust Backend Instructions

Applies to `backend/`; supplements [../AGENTS.md](../AGENTS.md). Commands below
run from the repository root.

## Locate the contract

| Change | Documentation and implementation |
| --- | --- |
| Graph validation / Planner tools | [Architecture](../docs/architecture/overview.md); [compiler.rs](src/compiler.rs), [planner.ts](resources/planner.ts) |
| Scheduling, feedback, replay | [Runtime](../docs/architecture/runtime.md); [runtime.rs](src/runtime.rs), [model.rs](src/model.rs), [store.rs](src/store.rs) |
| Inheritance, ignored files, directory ownership | [Workspace snapshots](../docs/architecture/workspace-snapshots-and-feedback.md); [workspace.rs](src/workspace.rs), [workspace_files.rs](src/workspace_files.rs) |
| Composition and publication | [Execution model](../docs/architecture/execution-model.md); [graph_merge.rs](src/graph_merge.rs) |
| Launchers and permissions | [Filesystem isolation](../docs/architecture/filesystem-isolation.md); [native.rs](src/native.rs), [sandbox.rs](src/sandbox.rs), [linux_sandbox.rs](src/linux_sandbox.rs) |
| API / logs / cleanup | [Conversation logs](../docs/testing/conversation-logs.md); [server.rs](src/server.rs), [store/](src/store/), [cleanup.rs](src/cleanup.rs) |

## Local constraints

- Preserve append-only event replay and persisted-data compatibility; trace
  changes through the reducer, SQLite transactions, API and frontend types.
- `Finished` plus queued feedback must remain atomic. Preserve generation checks,
  idempotent delivery, drain-before-handoff and one active writer per directory.
- Keep node identity, execution attempt, physical directory and Pi session distinct.
  A new node has a fresh conversation; a continuation keeps its own history.
- Do not manufacture completion during conflict resolution. Failed composition,
  publication and interrupted writers retain explicit recovery state.
- Production uses the pinned engine. Command injection belongs only to the
  `fixture` feature; acceptance instrumentation must remain opt-in.
- Regression tests belong beside the implementation (`src/*_tests.rs` or inline
  tests) or in `tests/`. Cover restart/failure paths, not only successful runs.

## Validation

```sh
node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <test-filter>
npm test
```

Use the first two for focused work and `npm test` for wider fixture coverage.
For publication, launchers or API changes, select the relevant integration suite
from [Testing](../docs/development/testing.md). Do not run database maintenance on
real user data as a test. On Windows, if the backend binary is in use, set an
isolated `CARGO_TARGET_DIR` rather than stopping the user's service.
