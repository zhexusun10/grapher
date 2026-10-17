# Documentation index

Locate your task in **Task routes**, inspect **Implementation & tests** first, and read **Contract docs** only when source boundaries are unclear. Do not bulk-scan `docs/`.

## Task routes

| Task scope | Implementation & tests (Inspect first) | Contract docs (On-demand) |
| --- | --- | --- |
| Serial vs Graph routing | [compiler.rs](../backend/src/compiler.rs), [executionRoute.ts](../src/services/executionRoute.ts), [core.rs](../backend/tests/core.rs) | [Architecture](architecture/overview.md), [Why compile?](architecture/why-compile.md) |
| Graph validation & Planner tools | [compiler.rs](../backend/src/compiler.rs), [planner.ts](../backend/resources/planner.ts), [planner.md](../backend/resources/prompts/planner.md); `npm run test:extensions` | [Graph compilation](architecture/overview.md#graph-compilation), [Pi role policy](development/pi-integration.md#role-loading-policy) |
| Scheduling, feedback & recovery | [runtime.rs](../backend/src/runtime.rs), [model.rs](../backend/src/model.rs), [store.rs](../backend/src/store.rs), [runtime_tests.rs](../backend/src/runtime_tests.rs), [feedback_workspace_tests.rs](../backend/src/feedback_workspace_tests.rs) | [Runtime](architecture/runtime.md) |
| Git collection, handoff & sessions | [workspace.rs](../backend/src/workspace.rs), [native_copy.rs](../backend/src/native_copy.rs), [session_branch.rs](../backend/src/session_branch.rs), [workspace_tests.rs](../backend/src/workspace_tests.rs) | [Workspaces & Git](architecture/workspace-snapshots-and-feedback.md), [Sessions](architecture/execution-model.md#sessions-follow-ups-and-history-edits) |
| Native environments & admission | [environment_automatic.rs](../backend/src/environment_automatic.rs), [environment.rs](../backend/src/environment.rs), [environment_resources.rs](../backend/src/environment_resources.rs), [launch-binding.mjs](../engine/launch-binding.mjs), [environment_tests.rs](../backend/src/environment_tests.rs), [environment_best_effort_tests.rs](../backend/src/environment_best_effort_tests.rs) | [Native environments](architecture/native-environments.md) |
| Composition & final publication | [graph_merge.rs](../backend/src/graph_merge.rs), [publication.rs](../backend/tests/publication.rs), [merger-native.test.ts](../scripts/merger-native.test.ts); `npm run test:merger` | [Composition recovery](architecture/execution-model.md#parent-composition-conflicts), [Publication](architecture/execution-model.md#final-publication) |
| API projections, UI & conversations | [server.rs](../backend/src/server.rs), [runtime.ts](../src/services/runtime.ts), [types.ts](../src/types.ts), [GraphWorkbench.tsx](../src/components/views/GraphWorkbench.tsx) | [Runtime authority](architecture/runtime.md), [Development](development/contributing.md) |
| Transcript loading & log storage | [store/logs.rs](../backend/src/store/logs.rs), [transcriptCache.ts](../src/services/transcriptCache.ts), [conversation-acceptance.mjs](../scripts/conversation-acceptance.mjs) | [Conversation logs](testing/conversation-logs.md), [Event storage](architecture/runtime.md#event-and-output-storage) |
| Providers, models, auth & MCP | [provider_auth.rs](../backend/src/provider_auth.rs), [provider-host.ts](../engine/provider-host.ts), [mcp-config.ts](../engine/mcp-config.ts), [global-extensions.ts](../engine/global-extensions.ts) | [Providers](guides/providers.md), [Pi integration](development/pi-integration.md) |
| Upgrade Pi or bundled extensions | [pi-lock.json](../engine/pi-lock.json), [pi-baseline.mjs](../scripts/pi-baseline.mjs), [pi-compat.ts](../engine/pi-compat.ts); `npm run pi:upgrade-check` | [Upgrade procedure](development/pi-integration.md#upgrade-procedure), [pi-trim](development/pi-integration.md#updating-pi-trim-independently) |
| Startup & prewarming | [prewarm.rs](../backend/src/engine/prewarm.rs), [process_prewarm.rs](../backend/src/engine/process_prewarm.rs), [prepared-host.ts](../engine/prepared-host.ts); `npm run test:prewarm` | [Prewarming](development/pi-integration.md#prewarming-and-prepared-runtime) |
| Permissions, sandbox & paths | [native.rs](../backend/src/native.rs), [sandbox.rs](../backend/src/sandbox.rs), [linux_sandbox.rs](../backend/src/linux_sandbox.rs), [workspace-tools.ts](../engine/workspace-tools.ts) | [Filesystem isolation](architecture/filesystem-isolation.md), [Windows](guides/windows.md) |
| Workspace & cache cleanup | [cleanup.rs](../backend/src/cleanup.rs), [workspace_cleanup.rs](../backend/src/workspace_cleanup.rs), [native_runtime_storage.rs](../backend/src/native_runtime_storage.rs), [cleanup_tests.rs](../backend/src/cleanup_tests.rs), [native-runtime-storage.test.mjs](../scripts/native-runtime-storage.test.mjs) | [Storage & cleanup](architecture/execution-model.md#storage-and-cleanup) |
| Setup, config & troubleshooting | [package.json](../package.json), [.env.example](../.env.example), [dev.mjs](../scripts/dev.mjs) | [Installation](guides/installation.md), [Providers](guides/providers.md), [Windows](guides/windows.md) |
| Harbor benchmark evaluation | [harbor_agent.py](../benchmark/harbor_agent.py), [run.py](../benchmark/run.py), [Dockerfile](../benchmark/Dockerfile) | [Harbor](benchmarks/harbor.md), [benchmark README](../benchmark/README.md) |

## Current documentation

Canonical active inventory (see [Testing](development/testing.md) for suite prerequisites and [Documentation maintenance](development/documentation.md) for index rules):

- **Overview & entrypoints**: [README.md](../README.md), [Chinese README](../README.zh-CN.md), [docs/README.md](README.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [SECURITY.md](../SECURITY.md), [Repository homepage](../.github/repository-homepage.md)
- **Agent guides**: [Root AGENTS.md](../AGENTS.md), [backend AGENTS.md](../backend/AGENTS.md), [engine AGENTS.md](../engine/AGENTS.md)
- **Architecture**: [Overview](architecture/overview.md), [Why compile?](architecture/why-compile.md), [Execution model](architecture/execution-model.md), [Runtime](architecture/runtime.md), [Workspaces & Git](architecture/workspace-snapshots-and-feedback.md), [Native environments](architecture/native-environments.md), [Filesystem isolation](architecture/filesystem-isolation.md)
- **Guides, dev & testing**: [Installation](guides/installation.md), [Providers](guides/providers.md), [Windows](guides/windows.md), [Development](development/contributing.md), [Testing](development/testing.md), [Pi integration](development/pi-integration.md), [engine README](../engine/README.md), [Conversation logs](testing/conversation-logs.md), [Documentation maintenance](development/documentation.md), [Harbor](benchmarks/harbor.md), [benchmark README](../benchmark/README.md)

## Proposals and historical evidence

Do not use for current implementation instructions:

| Status | Document | Replacement / authority |
| --- | --- | --- |
| `archived` | [2026-10-06 run/system audit](reviews/latest-run-system-design-audit-2026-10-06.md) | [Execution model](architecture/execution-model.md) |
| `archived` | [v0.1.0-alpha.2](releases/v0.1.0-alpha.2.md), [v1.0.0](releases/v1.0.0.md), [v1.0.1](releases/v1.0.1.md) | [Installation](guides/installation.md) |
| `history` | [CHANGELOG.md](../CHANGELOG.md) | Versioned change record only |

## Upstream and executable text

- **Pinned upstream (read-only)**: [Pi README](../pi/README.md), [Pi AGENTS.md](../pi/AGENTS.md), [Pi coding-agent docs](../pi/packages/coding-agent/docs/index.md)
- **Production prompt inputs (not contributor docs)**: [planner.md](../backend/resources/prompts/planner.md), [partitioner.md](../backend/resources/prompts/partitioner.md)