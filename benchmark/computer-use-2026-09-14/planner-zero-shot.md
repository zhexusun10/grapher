# Planner zero-shot architecture

The final Planner starts zero-shot. Its system prompt is 246 English whitespace-delimited words and contains no example graph, fixed topology, node-count target, audit recipe, SDK policy, or benchmark-specific path. Real planning evidence and timing are in [planning-trace-report.md](planning-trace-report.md).

## Responsibility split

| Layer | Responsibility |
| --- | --- |
| System prompt | Convert the user goal into the smallest executable graph; describe fresh worker sessions, standalone outcomes, ownership, state-carrying dependencies, independent branches, requested feedback, and semantic self-review. |
| `node` tool | Create, replace, or delete a standalone work outcome. Its description defines task inputs, path portability, replacement/delete behavior, and the distinction between structural success and goal coverage. |
| `edge` tool | Define dependency and bounded feedback runtime semantics. Ordinary dependencies default `feedback` to false; reverse revision routes must use true and target a dependency ancestor. |
| Compiler | Validate every mutation atomically. Rejection returns detailed diagnostics and unchanged `savedTopology`; success returns only the current structural plan and warnings. |
| Worker | Inspect its own worktree, resolve repository conventions and implementation choices, implement its owned outcome, and establish completion evidence. |

Planner intentionally has no repository read, search, shell, network, or repository-write tool. It can only mutate the host-selected Graph IR through `node` and `edge`. This is a capability boundary, not a prompt request.

## Why no few-shot

The medium-thinking graph-only samples produced usable P004/P005/P006 graphs on direct review. They removed the observed unsupported cross-subsystem assumptions and redundant review nodes while preserving parallel producers, integration dependencies, and the one user-requested feedback loop. That is above the current 80% stop threshold on this small corpus, so adding examples would add token cost and a topology prior without evidence of need.

The earlier failures were addressed below the example layer:

- Removed shell-shaped planning exploration that caused extra turns and leaked unrelated repository facts into tasks.
- Kept runtime semantics in focused tool descriptions rather than repeating them in the system prompt.
- Preserved compiler diagnostics and saved topology so the model can repair rejected mutations.
- Made the common dependency operation ergonomic by allowing omitted `feedback` to mean false; incorrect reverse dependencies still receive cycle/ancestor feedback.
- Stopped replaying accumulated edges after every successful mutation.

## Limits and next step

Three authored graph cases do not establish general quality or execution success. `thinking=off` is not the Planner default because it invented an extra contract artifact and verifier on P004 despite mixed latency results. Medium is the evaluated setting.

The next benchmark expansion should use held-out goals where decomposition genuinely depends on repository architecture. If failures reveal a missing planning input, add the narrowest structured tool affordance and precise edge-case/error descriptions first. Keep compiler feedback actionable. Consider few-shot only if a well-defined residual failure survives those changes and independent evaluation shows that examples generalize without imposing their topology on unrelated goals.
