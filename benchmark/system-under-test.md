# System under test: planning quality

The architecture contract is [agent.md](../agent.md). The primary benchmark evaluates **Partitioner routing and Planner graph design**, independently of later task execution.

## Production components exercised

`benchmark/run.mjs` creates isolated repository fixtures and calls the planning-only Rust host in `benchmark/planning-host.rs`. The host reuses:

- `backend/resources/prompts/partitioner.md` and `planner.md`, including configured product overrides.
- `backend/resources/planner.ts`: real route_task/node/edge tools and the repository-scoped read guard plus a custom read-only bash override (`planning-inspection.mjs`). No arbitrary shell is exposed; curl is limited to public HTTP(S) GET/HEAD with validated/pinned DNS and redirects. This is a tool-level boundary, not an OS sandbox.
- `backend/src/engine.rs::run_pi`: fresh Pi processes, actual configured model, JSON output and provider retry behavior.
- The shipping `grapher --compile` CLI for each mutation and Rust final graph validation.

The host is under Cargo feature `benchmark`. It never initializes Runtime, approves a graph, calls drive, prepares an execution worktree or performs a graph node. The goal/repository are the candidate inputs; expected route/rubric remain hidden outside the model-visible repository.

A separate Pi call with **no tools or context files** provides semantic graph review. It receives a fixed rubric and the generated graph as untrusted data. Deterministic code validates quotations, ownership references, prerequisites, meaningful parallelism and requested feedback. This is not an independent human judgment or proof the graph would successfully execute.

## What is measured

The six-case corpus includes three serial and three graph goals. Default runs report route confusion, compile validity, graph-quality dimensions/checks, planning/judge duration, token use and tool calls. Gold graph tasks call the Planner independently even after a Partitioner misroute so the two capabilities remain separately measurable. The end-to-end sample still fails when routing is wrong.

`npm run benchmark:planner` skips the Partitioner and runs only the three graph tasks through Planner and evaluator. `npm run benchmark:validate` takes three fixed samples of each corpus task. Neither command runs node implementations.

See [benchmark contract](architecture.md) for corpus, grading rubric, failure classes, artifacts and limitations.

## Separate runtime regressions

`npm run benchmark:runtime` retains B001–B009 and B011 solely as deterministic regression tests. They cover compiler rejection, approval, scheduling, actual fixture worktree writes/merges, feedback, failure propagation, history, UI contracts, HTTP lifecycle and restart recovery. They do not measure planning quality and no longer include a real-Pi file task.

B008 extracts production frontend actions and uses a dispatcher transport bridge. B011 starts the real HTTP backend with fixture execution and scripted planning failures. Neither is browser-click automation. `npm run test:http` runs B011's script independently.

Historical Schema v1 suites (B001–B011 execution suite and old B010 file task) have been retired and purged; their legacy pass rates do not apply to the current planning benchmark.
