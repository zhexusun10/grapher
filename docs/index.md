# Documentation index

This index routes development and maintenance tasks. For installing and using Grapher, start with the [English](../README.md#quick-start) or [Chinese](../README.zh-CN.md#快速开始) quick start.

Repository instructions live in [AGENTS.md](../AGENTS.md), supplemented by the [backend](../backend/AGENTS.md) and [engine](../engine/AGENTS.md) guides for work in those directories. This index is a routing map, not a reading or execution checklist.

Choose the closest task row and inspect only the relevant entry files; follow imports and callers as needed. Source, tests, and CI describe current behavior. Consult the linked contract when changing behavior or clarifying a boundary. For check selection and prerequisites, use [Testing](development/testing.md).

## Task routes

| Task scope | Implementation & tests (entry points, not exhaustive) | Contract docs (on demand) |
| --- | --- | --- |
| Serial vs Graph routing | [server.rs](../backend/src/server.rs) (`plan_goal_internal_with_started`), [engine.rs](../backend/src/engine.rs) (`parse_route_decision`), [executionRoute.ts](../src/services/executionRoute.ts), [execution-route.test.mjs](../scripts/execution-route.test.mjs), [partitioner prompt](../backend/resources/prompts/partitioner.md) | [Serial and Graph](architecture/execution-model.md#serial-and-graph) |
| Graph validation & Planner tools | [compiler.rs](../backend/src/compiler.rs), [planner.ts](../backend/resources/planner.ts), [planner prompt](../backend/resources/prompts/planner.md), [core.rs](../backend/tests/core.rs), [check-pi-extension.ts](../scripts/check-pi-extension.ts) | [Graph compilation](architecture/overview.md#graph-compilation), [Pi role policy](development/pi-integration.md#role-loading-policy) |
| Scheduling, feedback & recovery | [runtime.rs](../backend/src/runtime.rs), [model.rs](../backend/src/model.rs), [store.rs](../backend/src/store.rs), [runtime_tests.rs](../backend/src/runtime_tests.rs), [feedback_workspace_tests.rs](../backend/src/feedback_workspace_tests.rs) | [Runtime](architecture/runtime.md) |
| Git collection, handoff & sessions | [workspace.rs](../backend/src/workspace.rs), [native_copy.rs](../backend/src/native_copy.rs), [session_branch.rs](../backend/src/session_branch.rs), [workspace_tests.rs](../backend/src/workspace_tests.rs) | [Workspaces & Git](architecture/workspace-snapshots-and-feedback.md), [Sessions](architecture/execution-model.md#sessions-follow-ups-and-history-edits) |
| Native environments & admission | [environment_automatic.rs](../backend/src/environment_automatic.rs), [environment.rs](../backend/src/environment.rs), [environment_resources.rs](../backend/src/environment_resources.rs), [launch-binding.mjs](../engine/launch-binding.mjs), [environment_tests.rs](../backend/src/environment_tests.rs), [environment_best_effort_tests.rs](../backend/src/environment_best_effort_tests.rs) | [Native environments](architecture/native-environments.md) |
| Composition & final publication | [graph_merge.rs](../backend/src/graph_merge.rs), [publication.rs](../backend/tests/publication.rs), [merger-native.test.ts](../scripts/merger-native.test.ts) | [Composition recovery](architecture/execution-model.md#parent-composition-conflicts), [Publication](architecture/execution-model.md#final-publication) |
| Post-task Planner review & continuation | [server.rs](../backend/src/server.rs), [planner_review_tests.rs](../backend/src/planner_review_tests.rs), [SettingsModal.tsx](../src/components/modals/SettingsModal.tsx) | [Post-task Planner review](architecture/execution-model.md#post-task-planner-review) |
| API snapshots & live updates | [server.rs](../backend/src/server.rs), [runtime.ts](../src/services/runtime.ts), [runtimeEvents.ts](../src/services/runtimeEvents.ts), [types.ts](../src/types.ts), [runtime-completions.test.ts](../scripts/runtime-completions.test.ts) | [Runtime authority](architecture/runtime.md) |
| Graph UI & conversation switching | [GraphWorkbench.tsx](../src/components/views/GraphWorkbench.tsx), [useGraphElements.ts](../src/hooks/useGraphElements.ts), [graph-elements.test.ts](../scripts/graph-elements.test.ts), [graph-switching.test.mjs](../scripts/graph-switching.test.mjs) | [Graph representation](architecture/runtime.md#graph-representation), [Development](development/contributing.md) |
| Transcript loading & log storage | [store/logs.rs](../backend/src/store/logs.rs), [transcriptCache.ts](../src/services/transcriptCache.ts), [useAutoTranscriptHistory.ts](../src/hooks/useAutoTranscriptHistory.ts), [transcript_page_tests.rs](../backend/src/transcript_page_tests.rs), [transcript-cache.test.ts](../scripts/transcript-cache.test.ts) | [Conversation logs](testing/conversation-logs.md), [Event storage](architecture/runtime.md#event-and-output-storage) |
| Providers & authentication | [provider_auth.rs](../backend/src/provider_auth.rs), [provider-host.ts](../engine/provider-host.ts), [provider-auth-adapter.mjs](../engine/provider-auth-adapter.mjs), [pi-process-contract.test.mjs](../scripts/pi-process-contract.test.mjs) | [Provider/auth checks](development/pi-integration.md#providerauth-contract-checks) |
| Role models & settings | [engine.rs](../backend/src/engine.rs) (`PiModelConfig`), [modelConfig.ts](../src/modelConfig.ts), [RoleModelSettings.tsx](../src/components/RoleModelSettings.tsx), [model-settings.test.ts](../scripts/model-settings.test.ts) | [Pi integration](development/pi-integration.md) |
| Extensions & MCP | [global-extensions.ts](../engine/global-extensions.ts), [mcp-config.ts](../engine/mcp-config.ts), [ExtensionSettings.tsx](../src/components/ExtensionSettings.tsx), [global-extensions.test.ts](../scripts/global-extensions.test.ts), [extension-settings.test.ts](../scripts/extension-settings.test.ts) | [Extension settings](development/pi-integration.md#global-extension-settings), [MCP overrides](development/pi-integration.md#mcp-project-overrides) |
| Upgrade Pi or bundled extensions | [pi-baseline.mjs](../scripts/pi-baseline.mjs), [pi-compat.ts](../engine/pi-compat.ts), [pi-compat.test.ts](../scripts/pi-compat.test.ts) | [Upgrade procedure](development/pi-integration.md#upgrade-procedure) |
| Startup & prewarming | [prewarm.rs](../backend/src/engine/prewarm.rs), [process_prewarm.rs](../backend/src/engine/process_prewarm.rs), [prepared-host.ts](../engine/prepared-host.ts), [startup_prewarm_tests.rs](../backend/src/startup_prewarm_tests.rs), [prepared-host.test.mjs](../scripts/prepared-host.test.mjs) | [Prewarming](development/pi-integration.md#prewarming-and-prepared-runtime) |
| Permissions, sandbox & paths | [native.rs](../backend/src/native.rs), [sandbox.rs](../backend/src/sandbox.rs), [linux_sandbox.rs](../backend/src/linux_sandbox.rs), [workspace-tools.ts](../engine/workspace-tools.ts) | [Filesystem isolation](architecture/filesystem-isolation.md) |
| Workspace & cache cleanup | [cleanup.rs](../backend/src/cleanup.rs), [workspace_cleanup.rs](../backend/src/workspace_cleanup.rs), [native_runtime_storage.rs](../backend/src/native_runtime_storage.rs), [cleanup_tests.rs](../backend/src/cleanup_tests.rs), [native-runtime-storage.test.mjs](../scripts/native-runtime-storage.test.mjs) | [Storage & cleanup](architecture/execution-model.md#storage-and-cleanup) |
| Setup, config & troubleshooting | [package.json](../package.json), [.env.example](../.env.example), [dev.mjs](../scripts/dev.mjs) | [README quick start](../README.md#quick-start) |
| Verification, build targets & CI | [package.json](../package.json), [cargo.mjs](../scripts/cargo.mjs), [temporary-target.mjs](../scripts/temporary-target.mjs), [planner-source.yml](../.github/workflows/planner-source.yml), [release.yml](../.github/workflows/release.yml) | [Testing](development/testing.md) |
| Harbor benchmark evaluation | [harbor_agent.py](../benchmark/harbor_agent.py), [run.py](../benchmark/run.py), [Dockerfile](../benchmark/Dockerfile) | [Harbor](benchmarks/harbor.md), [benchmark README](../benchmark/README.md) |

## Reference pages (on demand)

- **Entrypoints**: [README.md](../README.md), [Chinese README](../README.zh-CN.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [SECURITY.md](../SECURITY.md)
- **Architecture**: [Overview](architecture/overview.md), [Execution model](architecture/execution-model.md), [Runtime](architecture/runtime.md), [Workspaces & Git](architecture/workspace-snapshots-and-feedback.md), [Native environments](architecture/native-environments.md), [Filesystem isolation](architecture/filesystem-isolation.md)
- **Development & testing**: [Development](development/contributing.md), [Testing](development/testing.md), [Pi integration](development/pi-integration.md), [engine README](../engine/README.md), [Conversation logs](testing/conversation-logs.md), [Harbor](benchmarks/harbor.md), [benchmark README](../benchmark/README.md), [Repository homepage settings](../.github/repository-homepage.md)

## History

[CHANGELOG.md](../CHANGELOG.md) owns the versioned change record. Published release notes live on GitHub Releases; do not keep duplicate release pages or per-run audit diaries in the repository.

## Maintenance

- Keep routes current when entry files move or ownership changes; add new permanent documentation here.
- Keep this a routing map, not a complete file inventory or command catalog. Link check procedures and prerequisites to the testing guide.
- Update the single canonical contract when behavior changes; avoid duplicate explanations, volatile constants, and per-run reports.
- Prompts linked in the task routes are production inputs, not contributor documentation.
