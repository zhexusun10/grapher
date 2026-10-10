# Documentation index

Start with the current task, not a full-documentation read. English is canonical
for maintained contracts; [简体中文](../README.zh-CN.md) is the product translation.
[docs/README.md](README.md) remains the directory entrypoint.

**Trust:** current pages explain intended contracts; source and tests establish
implemented behavior. Drafts and historical evidence are separated below. A
valid path or recent edit does not establish semantic correctness. See
[maintenance policy](development/documentation.md) for status and review rules.

## Task routes

| When you need to… | Read first | Implementation / focused evidence |
| --- | --- | --- |
| Understand the system or choose Serial vs Graph | [Architecture](architecture/overview.md), [Why compile?](architecture/why-compile.md) | [compiler.rs](../backend/src/compiler.rs), [executionRoute.ts](../src/services/executionRoute.ts); [core tests](../backend/tests/core.rs) |
| Change graph validation or Planner graph tools | [Architecture](architecture/overview.md#graph-compilation), [Pi role policy](development/pi-integration.md#role-loading-policy) | [compiler.rs](../backend/src/compiler.rs), [planner.ts](../backend/resources/planner.ts), [Planner prompt](../backend/resources/prompts/planner.md); `npm run test:extensions` |
| Change scheduling, feedback or restart recovery | [Runtime](architecture/runtime.md) | [runtime.rs](../backend/src/runtime.rs), [model.rs](../backend/src/model.rs), [store.rs](../backend/src/store.rs); [runtime tests](../backend/src/runtime_tests.rs), [feedback tests](../backend/src/feedback_workspace_tests.rs) |
| Change ignored-resource inheritance, directory handoff or follow-ups | [Workspace snapshots and feedback](architecture/workspace-snapshots-and-feedback.md), [Sessions](architecture/execution-model.md#sessions-follow-ups-and-history-edits) | [workspace.rs](../backend/src/workspace.rs), [workspace_files.rs](../backend/src/workspace_files.rs), [session_branch.rs](../backend/src/session_branch.rs); [resource tests](../backend/src/workspace_files_tests.rs) |
| Change automatic environment admission, E/L, native resources or result launch | [Native workspace environments](architecture/native-environments.md) | [admission](../backend/src/environment_automatic.rs), [environment.rs](../backend/src/environment.rs), [resources](../backend/src/environment_resources.rs), [launch-binding.mjs](../engine/launch-binding.mjs), [environment tests](../backend/src/environment_tests.rs); `npm run test:environment` |
| Repair composition or change final publication | [Composition recovery](architecture/execution-model.md#parent-composition-conflicts), [Publication](architecture/execution-model.md#final-publication) | [graph_merge.rs](../backend/src/graph_merge.rs); [publication tests](../backend/tests/publication.rs), [Merger tests](../scripts/merger-native.test.ts); `npm run test:merger` |
| Change API projections, graph UI or conversations | [Runtime authority](architecture/runtime.md), [Development guide](development/contributing.md) | [server.rs](../backend/src/server.rs), [API client](../src/services/runtime.ts), [types](../src/types.ts), [GraphWorkbench](../src/components/views/GraphWorkbench.tsx); `npm run check`, `npm run test:frontend`, `npm run test:ui` |
| Change transcript loading, storage or log migration | [Conversation logs](testing/conversation-logs.md), [Event/output storage](architecture/runtime.md#event-and-output-storage) | [store/logs.rs](../backend/src/store/logs.rs), [transcriptCache.ts](../src/services/transcriptCache.ts), [acceptance harness](../scripts/conversation-acceptance.mjs); use copied data |
| Change providers, models, auth, MCP or extensions | [Providers](guides/providers.md), [Pi integration](development/pi-integration.md) | [provider_auth.rs](../backend/src/provider_auth.rs), [provider-host.ts](../engine/provider-host.ts), [mcp-config.ts](../engine/mcp-config.ts), [global-extensions.ts](../engine/global-extensions.ts); `npm run test:pi` |
| Upgrade Pi or a bundled extension | [Pi upgrade procedure](development/pi-integration.md#upgrade-procedure), [pi-trim upgrades](development/pi-integration.md#updating-pi-trim-independently) | [pi-lock.json](../engine/pi-lock.json), [pi-baseline.mjs](../scripts/pi-baseline.mjs), [pi-compat.ts](../engine/pi-compat.ts); `npm run pi:upgrade-check` |
| Change startup/prewarming | [Prewarming and prepared runtime](development/pi-integration.md#prewarming-and-prepared-runtime) | [engine/prewarm.rs](../backend/src/engine/prewarm.rs), [process_prewarm.rs](../backend/src/engine/process_prewarm.rs), [prepared-host.ts](../engine/prepared-host.ts); `npm run test:prewarm` |
| Change platform permissions, tools or path handling | [Filesystem isolation](architecture/filesystem-isolation.md), [Windows](guides/windows.md) | [native.rs](../backend/src/native.rs), [sandbox.rs](../backend/src/sandbox.rs), [linux_sandbox.rs](../backend/src/linux_sandbox.rs), [workspace tools](../engine/workspace-tools.ts); host-specific suites in [Testing](development/testing.md) |
| Change workspace/cache cleanup or deletion | [Storage and cleanup](architecture/execution-model.md#storage-and-cleanup) | [cleanup.rs](../backend/src/cleanup.rs), [workspace_cleanup.rs](../backend/src/workspace_cleanup.rs), [native_runtime_storage.rs](../backend/src/native_runtime_storage.rs); [cleanup tests](../backend/src/cleanup_tests.rs), [runtime-storage tests](../scripts/native-runtime-storage.test.mjs) |
| Install, start, configure or troubleshoot Grapher | [Installation](guides/installation.md), [Providers](guides/providers.md), [Windows](guides/windows.md) | [package.json](../package.json), [.env.example](../.env.example), [dev.mjs](../scripts/dev.mjs) |
| Run or modify Harbor evaluation | [Harbor guide](benchmarks/harbor.md), [adapter README](../benchmark/README.md) | [harbor_agent.py](../benchmark/harbor_agent.py), [run.py](../benchmark/run.py), [Dockerfile](../benchmark/Dockerfile); `python3 -m unittest discover -s benchmark -p 'test_*.py'` |

Test commands, prerequisites and acceptance limits are authoritative in
[Testing](development/testing.md) and [package.json](../package.json). A linked
test is a place to verify a claim, not an assertion that it passed.

## Current documentation

Each contract has one canonical home; overview pages and local READMEs link to it
rather than competing with it. Implementation/test links in those pages identify
the maintenance area, not a fictitious team owner.

| Document | Responsibility |
| --- | --- |
| [README.md](../README.md) / [Chinese README](../README.zh-CN.md) | Product overview and quick start; Chinese is a translation |
| [README.en.md](../README.en.md) | Compatibility URL pointing to the English homepage |
| [Architecture overview](architecture/overview.md) | System boundaries, invariants and implementation map |
| [Why compile?](architecture/why-compile.md) | Design rationale and trade-offs, not a benchmark claim |
| [Execution model](architecture/execution-model.md) | User-visible planning, sessions, composition, publication and cleanup |
| [Runtime](architecture/runtime.md) | Scheduling, events, feedback budgets and interruption recovery |
| [Workspace snapshots and feedback](architecture/workspace-snapshots-and-feedback.md) | Git/ignored channels, single-writer handoff and resource portability |
| [Native workspace environments](architecture/native-environments.md) | Backend-owned admission without user environment choices, E/L, native resources, results and open acceptance |
| [Filesystem isolation](architecture/filesystem-isolation.md) | Actual platform permissions and path-mapping limits |
| [Installation](guides/installation.md) | Host prerequisites, configuration and troubleshooting |
| [Providers](guides/providers.md) | Authentication, model selection and migration |
| [Windows](guides/windows.md) | Native setup, paths and limitations |
| [Development](development/contributing.md) / [CONTRIBUTING.md](../CONTRIBUTING.md) | Checkout setup, code responsibilities and contribution rules |
| [Testing](development/testing.md) | Suite selection, prerequisites and evidence boundaries |
| [Pi integration](development/pi-integration.md) / [engine README](../engine/README.md) | Current pinned baseline, integration contracts, verification limits and upgrades |
| [Conversation logs](testing/conversation-logs.md) | Offline maintenance, legacy migration and acceptance; Runtime owns storage/API limits |
| [Harbor](benchmarks/harbor.md) / [benchmark README](../benchmark/README.md) | Adapter interface, reproducibility and evidence requirements |
| [Documentation maintenance](development/documentation.md) | Knowledge placement, lifecycle, checks and exploration evaluation |
| [SECURITY.md](../SECURITY.md) | Vulnerability reporting and security boundaries |
| [Repository homepage settings](../.github/repository-homepage.md) | GitHub About-field/assets maintenance |
| [Root AGENTS.md](../AGENTS.md), [backend guide](../backend/AGENTS.md), [engine guide](../engine/AGENTS.md) | Global navigation and only the significant local development differences |

## Proposals and historical evidence

These are discoverable **without becoming current implementation instructions**.
Retain paths for provenance; do not read them for routine changes unless the task
requires design history. Promotion requires implementation and verification.

| Status | Document | Use / current authority |
| --- | --- | --- |
| `draft` | [Native environment-control proposal (中文)](proposals/shared-environment-control.zh-CN.md) | Partially implemented; full acceptance open. Current subset/limitations: [native environments](architecture/native-environments.md); compatibility inheritance: [workspace contract](architecture/workspace-snapshots-and-feedback.md) |
| `archived` | [2026-10-06 run/system audit (中文)](reviews/latest-run-system-design-audit-2026-10-06.md) | Review-time evidence and superseded suggestions, not today's protocol; see its warning and the current [execution model](architecture/execution-model.md) |
| `archived` | [v0.1.0-alpha.2 notes](releases/v0.1.0-alpha.2.md) / [initial preview notes](../.github/releases/v0.1.0.md) | Release-specific statements; current setup: [Installation](guides/installation.md) |
| Release history | [CHANGELOG.md](../CHANGELOG.md) | Versioned change record, not a full current architecture specification |

## Upstream and executable text

[Pi README](../pi/README.md), [Pi agent instructions](../pi/AGENTS.md) and
[Pi coding-agent docs](../pi/packages/coding-agent/docs/index.md) belong to the
pinned upstream tree. Follow them only when investigating that dependency; do not
reorganize or lint upstream docs as Grapher's knowledge base.

[Planner](../backend/resources/prompts/planner.md) and
[Partitioner](../backend/resources/prompts/partitioner.md) prompts are production
inputs, not contributor instructions. GitHub issue/PR templates are workflow
inputs. They stay beside their consumers and are excluded from index-coverage
requirements, but their local links are still checked.
