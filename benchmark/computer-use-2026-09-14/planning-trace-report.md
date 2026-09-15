# Partitioner + Planner planning trace review

This review stops at planning. It does not approve a graph, run Node Agents, merge worktrees, publish output, or run an execution-success judge. Raw Pi events, effective prompts, graphs, compiler results, role settings, and source snapshots are retained under [planning-trace-validation](planning-trace-validation/). Repository fixtures remained unchanged in every sample.

## Evidence reviewed

The committed read-only-inspection baseline contains 11 Partitioner calls and 4 Planner calls. This continuation added 10 Planner-only calls across P004/P005/P006: graph-only with the longer prompt, graph-only with the minimal prompt, a `thinking=off` comparison, and a final P004 tool-affordance check. Node execution count is zero.

All calls used `dashscope/qwen3.8-flash`. Planner comparisons used `thinking=medium` except the explicitly named off batch. No few-shot examples or sample topologies were added to any candidate prompt. No model judge was used; quality findings below are direct graph/task review against the goals and fixtures.

## Baseline findings

The last inspection-enabled P005/P006 samples compiled, but both failed semantic review. Planner inspected unrelated files, treated the server/browser `retryCount=3` setting as an SDK contract, pre-authored audit findings, added redundant verification work, and repeated host-owned feedback marker syntax. Inspection itself took less than 1.2 seconds while generation took 130-137 seconds, so shell execution was not the direct bottleneck. Its larger cost was additional model turns, context, and unsupported planning commitments.

| Inspection-enabled sample | Wall time | Inspection calls | Tool errors | Task words |
| --- | ---: | ---: | ---: | ---: |
| P005 refined | 137.181s | 15 | 4 | 1,777 |
| P006 refined | 130.467s | 15 | 3 | 1,966 |

## Architecture result

Planner now exposes only `node` and `edge`. It cannot read/search the repository, invoke a shell, access the network, or write repository files. Workers investigate implementation details in their own isolated worktrees. This narrows Planner to outcome decomposition and removes the source of the observed cross-subsystem assumption leak.

Every graph mutation still invokes the shipping Rust compiler atomically. Failure returns `mutationApplied=false`, detailed diagnostics, and `savedTopology`; the graph file remains unchanged. In a graph-only P005 sample, an absolute planner-checkout path was rejected with `workspace-portability`, and the model immediately replaced it with a repository-relative task. Compiler cycle, endpoint, and feedback-ancestor diagnostics remain covered by extension tests.

Normal dependencies may now omit `feedback`; omission means `false`. This matches the common operation and removes repeated schema-only retries. If a reverse review edge mistakenly omits `feedback:true`, the dependency-cycle/feedback checks still reject the structure with corrective diagnostics. The final P004 sample omitted the field on both dependencies, produced zero tool errors, and compiled the intended graph.

Successful mutation results return only the current compiler plan instead of replaying every accumulated edge. Failure results retain the saved topology because that state is needed for correction.

## Prompt result

The final system prompt is zero-shot and 246 English whitespace-delimited words, down from the interrupted 484-word candidate. It contains only role boundaries and general execution invariants: fresh worker sessions, standalone outcomes, authoritative inputs, ownership, dependency-as-state-flow, independent branches, requested feedback, and compiler correction. It has no example graph, fixed node count, audit checklist, SDK rule, or benchmark-specific forbidden path.

Operational edge cases live in the `node` and `edge` tool descriptions. The compiler owns structural enforcement and returns repair information. This follows Pi's compact custom-prompt style and avoids turning P004/P005/P006 fixes into a planning prior.

## Quality and timing

With the minimal prompt and `thinking=medium`, all three graph tasks produced usable graphs on direct review:

| Sample | Topology | Wall time | Tool calls | Errors | Task words |
| --- | --- | ---: | ---: | ---: | ---: |
| P004 users flow | backend + web in parallel, then integration | 49.779s | 7 | 2 schema retries | 433 |
| P005 retry contract | contract, parallel SDKs, joint conformance + requested feedback | 58.533s | 10 | 0 | 804 |
| P006 release audit | parallel audits, then release decision | 36.504s | 5 | 0 | 219 |

The final P004 affordance rerun used the same three-node topology with 5 calls and zero errors. It took 70.439s and produced 829 task words. This variance is important: the model/provider and generated text dominate wall time. Tool execution was about 0.1 seconds in that run, while process completion after the final tool took 9.3 seconds.

Compared with the last inspection-enabled run, the minimal medium samples reduced P005 from 137.181s to 58.533s (57%) and P006 from 130.467s to 36.504s (72%). These are same-case single-sample comparisons, not stable latency guarantees. The retained traces support the causal reduction in tool turns and context, but not a fixed percentage SLA.

Quality was not traded for speed in the three medium samples: P004 kept the existing contract as shared input and omitted an unrequested review node; P005 stopped importing unrelated server/browser retry configuration and preserved the requested two-target correction loop; P006 removed the redundant verifier and mapped one node to each requested report.

## Thinking comparison

`thinking=off` is not suitable as the Planner default. It reduced P005/P006 to 44.399s/35.612s, but P004 slowed to 68.186s and regressed semantically: it invented `docs/users-contract.md`, added a contract-summary producer, and added an unrequested final verifier. Medium remains the evaluated Planner setting. Partitioner stays at off based on the earlier classification-only evidence; that is separate from this Planner decision.

## Decision

On this small three-case graph corpus, the final medium zero-shot design is above the stated 80% stop threshold by direct review, so no few-shot should be added. The evidence supports keeping the compact prompt, graph-only tool boundary, compiler repair loop, and dependency default. It does not establish general planning quality or execution success.

The next evaluation should add new held-out goals, especially goals whose work boundaries genuinely depend on repository architecture. If those fail, first add a narrow structured affordance for the missing planning fact and strengthen its edge-case description and compiler/validator feedback. Do not restore shell-shaped exploration or add example graphs without evidence that a residual problem survives those measures.

## Deterministic verification

- Planning grade, boundary, and retained inspection-security tests: 20/20 pass.
- Rust engine tests: 12/12 pass.
- Rust benchmark host and product binary build with `benchmark` feature.
- Planner extension smoke passes: exact `node,edge` surface, default dependency flag, compiler rejection/repair, atomic rollback, saved topology, and workspace portability.
- Full Pi offline build passes at the publicly available upstream commit pinned in `engine/pi-lock.json`; that commit maps `FinishReason.TOO_MANY_TOOL_CALLS` to `error` and restores the exhaustive type check.
