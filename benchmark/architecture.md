# Partitioner / Planner benchmark contract

The primary benchmark is **B010, variant `planning-quality-v1`, schema v2**. The old B010 Pi file-writing task has been removed from executable code. Its historical results remain archived and are not comparable to this benchmark.

## What is evaluated

1. Can the real Partitioner distinguish linear work from substantial independent workstreams?
2. Can the real Planner generate a complete, actionable, appropriately parallel graph with sound dependencies and revision feedback?

There is no Runtime construction, graph approval, `drive`, node execution, worktree preparation or implementation-success criterion. Pi is used only as the production planning engine and, in a separate process, as the semantic judge.

`planning-host.rs` uses the production Pi adapter, Partitioner/Planner prompts, graph mutation extension, compiler and final compiler. This is a component evaluation of planning behavior, not a test of the HTTP `plan_goal` handler. The planner receives the same goal/system prompt and exact `node,edge` surface as production. Repository and contract investigation belongs to workers during execution. The partitioner receives route_task only.

## Corpus

`planning-cases.mjs` contains six authored goals and an isolated inspectable repository. Expected routes, rationale and evaluation rubrics stay outside that repository and are not included in candidate-model prompts.

| Task | Expected route | Workload / distinguishing feature |
|---|---|---|
| P001 | serial | local normalization fix with directly coupled tests |
| P002 | serial | multiple ordered refinements of one CSV importer |
| P003 | serial | mechanical rename across backend, frontend and documentation |
| P004 | graph | endpoint and browser implementation against an existing contract, then integration |
| P005 | graph | shared retry contract, TypeScript/Python SDKs, conformance review and feedback |
| P006 | graph | independent authentication/storage audits, then release synthesis |

These are finite authored cases with explicit rationales, not a broad statistical estimate. Six tasks do not establish general routing accuracy. Add new cases/version the corpus to broaden coverage; do not alter labels after observing model output merely to improve scores.

## Routing and isolated Planner quality

Routing accuracy depends only on the final valid route and successful process result. The separate protocol metric requires route_task exactly once; repeating the same correct route is a protocol failure, not a routing misclassification. Either can fail the overall sample. Missing routes and process/provider errors do not disappear from the denominator. Summary includes a confusion matrix with an error column.

For each **gold graph task**, the harness independently calls the Planner even if the Partitioner predicted serial. This exposes Planner quality despite a routing mistake. Routing accuracy and isolated Planner quality are reported separately; an incorrect route still fails the overall sample. Serial cases have no Planner requirement. `--planner-only` selects the three graph cases and does not call the Partitioner at all; routing is NOT_RUN, not PASS.

## Planner tool boundary

Planner exposes only `node` and `edge`, which atomically mutate the host-selected graph artifact through the shipping compiler. It has no shell, file read/search/listing, network or repository-write tool. This prevents planning-time implementation exploration and cross-subsystem facts from leaking into tasks merely because the model discovered similarly named files. Workers inspect their isolated worktrees during execution.

Rubrics are written only after candidate generation. `planning-boundary.mjs` checks policy `planner-graph-tools-v1`, the exact `node,edge` surface and tool start/end pairing before invoking the judge. Missing policy or any successful historical inspection tool is PLANNING_BOUNDARY failure even if Git is clean, the graph compiles and an old judge gave full marks. Replay retains originals but excludes unverified candidates from quality passes. Rejected unknown-tool attempts are not successful boundary breaches.

## Quality assessment

The shipping compiler checks final graph validity. A separate tool-free semantic judge sees the goal, repository, candidate graph and hidden rubric. It maps deliverable producers to node names and scores seven dimensions 0/1/2: goal coverage, standalone instructions, task boundaries, mergeability, verification, fidelity to authoritative requirements, and graph economy. Fidelity rejects unsupported cross-subsystem assumptions and planner-invented contract choices. Economy rejects redundant reviewers, reports and repeated evidence work that the user did not request. Each nonzero score needs a node and task-line reference; the grader extracts the exact original line as its quotation. Invalid references and incomplete schemas are JUDGE_FAILURE. Legacy quotation-based reviews remain readable only when their quotations match verbatim; ellipses/paraphrases are rejected. The initial development judge produced such invalid quotations, motivating the line-reference format rather than relaxing evidence validation.

The deterministic grader then checks:

- Compiler success and a workload-specific generous node-count ceiling (no exact graph/node-name matching).
- Workspace portability: tasks must not bind a fresh worker to the original inspected repository's absolute path. This static check remains visible even if semantic judging fails.
- Required deliverable ownership, with concrete output paths in producer tasks.
- Prerequisite reachability, accepting transitive dependency paths.
- Independent producers remain distinct and are not artificially serialized.
- Required feedback appears only for user-requested revision loops, maps to the expected reviewer/owner pairs, and no additional feedback route is accepted.
- Every node maps to an actual requested work unit; a pure extra reader, report or quality gate cannot hide behind compiler validity.
- Case-specific inapplicable repository references are rejected. In P005, the server/browser `retryCount` configuration files are not an SDK contract and may not be carried into node tasks.
- At least 12/14 semantic points with no zero dimension.

A positive judge cannot override failed topology/ownership checks. Tests include monolithic keyword stuffing, missing prerequisites, unnecessary serialization, omitted feedback and fabricated quotations. Semantic role mapping and scores remain model judgments: validated quotations ground the evidence but do not prove the judgment correct. Default judge may use the same model as the candidate in a fresh process; use BENCHMARK_JUDGE_MODEL for a different model. Inspect retained graphs/reviews and calibrate against human judgments before treating scores as independent gold truth.

## Commands

```sh
npm run benchmark                         # six goals, one fixed sample each
npm run benchmark:planner                 # three graph goals; Planner + judge only
npm run benchmark -- --task P005           # targeted routing + graph evaluation
npm run benchmark:validate                 # three fixed samples of every goal
npm run test:benchmark                     # grader regressions, no model
npm run benchmark:runtime                  # B001–B009 and B011, no real model
```

Supported primary runner flags: `--case B010`, `--task P001..P006`, `--label`, `--repeats 1..5`, `--planner-only`, `--replay <artifact-directory>`. Replay copies retained evidence to a new run and recalculates grades without building or calling any model; it records the original evidence run/source separately from the current grader source. Goals and corpus version must match. Raw original outputs remain unchanged. Add `--rejudge` to reuse candidate graphs but make exactly one new semantic evaluation per available complete graph with valid inspection-boundary evidence; this calls a model and records the new judge prompt/schema separately. It does not regenerate candidate graphs or retry invalid judgments until success. `gradingVersion` identifies grading policy; `evidenceRun` identifies the original candidate population.

Each real stage has the product's 900-second Pi timeout plus a 30-second host cleanup allowance. The initial development run used a shorter 240-second host limit; its interrupted samples remain explicit failures and cannot be compared as though they had the same planning budget.

Old `--planning`, `--agent-repeats`, and `--deterministic` primary-runner flags are removed; runtime regressions have their own command. Repetition is fixed in advance; no automatic resampling until a case passes.

BENCHMARK_PI_COMMAND/BENCHMARK_PI_ARGS configure the existing Pi installation. BENCHMARK_PI_MODEL overrides both candidate stages; otherwise PARTITIONER_MODEL/PLANNER_MODEL and the product default apply. BENCHMARK_JUDGE_MODEL selects the independent judging process's model. Product prompt overrides are honored and retained per stage. Existing Pi authentication/network are required; no new package dependencies.

## Artifacts and interpretation

`benchmark-results/<label>-<UTC>/` contains source manifest/snapshot/diff, corpus identity, build log, summary.json, cases.jsonl and report.md. Each sample retains the fixture repository and hidden rubric, stage inputs/effective prompts, model identity, raw JSONL events/session, route, graph, compiler diagnostics, judge response/quotations, quality checks and stage timings/tokens/tool counts.

Candidate and judge costs are separate. Provider 429/5xx/auth/network failures are classified as environment failures; invalid/failed judge responses remain separately observable. Failed attempts stay in the report. `nodeExecutionCount` is zero by construction; the harness additionally checks the fixture HEAD/worktree remain unchanged and no runtime database/worktrees were created. Case-level errors cause a nonzero exit code and preserved partial results.

Schema v2 and `planning-quality-v1` prevent mixing these results with the old B010 file task. Runtime reports from B001–B009/B011 concern execution correctness only; they contribute nothing to routing accuracy or graph-quality scores.
