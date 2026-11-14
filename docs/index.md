# Documentation index

- **Using Grapher:** [English README](../README.md), [中文 README](../README.zh-CN.md), [User guide](user-guide.md), [Security policy](../SECURITY.md).
- **Changing Grapher:** [CONTRIBUTING.md](../CONTRIBUTING.md) for setup and ownership; [AGENTS.md](../AGENTS.md) for repository instructions, with [backend](../backend/AGENTS.md) and [engine](../engine/AGENTS.md) boundaries.
- **Choosing a check:** [Testing](development/testing.md). The routes below are starting points, not a reading or execution checklist.

## Task routes

Choose the nearest area, then follow its source imports/callers and nearby tests. Consult the linked contract only when needed; this index is not a complete file inventory.

| Area | Entry points | Reference |
| --- | --- | --- |
| Serial/Graph routing, sessions & review | [server.rs](../backend/src/server.rs), [engine.rs](../backend/src/engine.rs), [executionRoute.ts](../src/services/executionRoute.ts) | [Execution model](architecture/execution-model.md) |
| Graph validation & Planner tools | [compiler.rs](../backend/src/compiler.rs), [planner.ts](../backend/resources/planner.ts), [Planner prompt](../backend/resources/prompts/planner.md) | [Compilation](architecture/overview.md#graph-compilation), [role policy](development/pi-integration.md#role-loading-policy) |
| Optional Feedback setting & topology | [SettingsModal.tsx](../src/components/modals/SettingsModal.tsx), [planner.ts](../backend/resources/planner.ts), [feedback_settings_tests.rs](../backend/src/feedback_settings_tests.rs) | [Feedback capability](architecture/overview.md#optional-feedback-capability) |
| Scheduling, feedback & recovery | [runtime.rs](../backend/src/runtime.rs), [feedback_continuation.rs](../backend/src/feedback_continuation.rs), [feedback_delivery.rs](../backend/src/feedback_delivery.rs) | [Runtime](architecture/runtime.md), [offline recovery](development/conversation-logs.md#restore-an-undelivered-paused-batch) |
| Shared/private workspaces, Git & handoff | [workspace_policy.rs](../backend/src/workspace_policy.rs), [workspace.rs](../backend/src/workspace.rs), [session_branch.rs](../backend/src/session_branch.rs) | [Workspaces & Git](architecture/workspace-snapshots-and-feedback.md) |
| Composition & publication | [graph_merge.rs](../backend/src/graph_merge.rs), [publication_driver.rs](../backend/src/publication_driver.rs) | [Publication](architecture/execution-model.md#final-publication), [offline file repair](development/conversation-logs.md#reconcile-a-legacy-partial-publication-file) |
| Native environments, sandbox & paths | [environment.rs](../backend/src/environment.rs), [native.rs](../backend/src/native.rs), [workspace-tools.ts](../engine/workspace-tools.ts) | [Native environments](architecture/native-environments.md), [Filesystem isolation](architecture/filesystem-isolation.md) |
| API snapshots & live updates | [server.rs](../backend/src/server.rs), [runtime.ts](../src/services/runtime.ts), [runtimeEvents.ts](../src/services/runtimeEvents.ts) | [Runtime authority](architecture/runtime.md) |
| Graph projection, viewport & manual nodes | [useGraphElements.ts](../src/hooks/useGraphElements.ts), [useGraphViewport.ts](../src/hooks/useGraphViewport.ts), [CreateNodeForm.tsx](../src/components/views/CreateNodeForm.tsx) | [Graph viewport](development/ui-components.md#graph-viewport), [manual nodes](architecture/runtime.md#manual-graph-nodes) |
| Workbench, conversation switching & layout | [GraphWorkbench.tsx](../src/components/views/GraphWorkbench.tsx), [styles-workbench.css](../src/styles-workbench.css) | [UI components](development/ui-components.md) |
| Sidebar, settings & dialogs | [Sidebar.tsx](../src/components/layout/Sidebar.tsx), [SettingsModal.tsx](../src/components/modals/SettingsModal.tsx), [useDialogFocus.ts](../src/hooks/useDialogFocus.ts) | [UI components](development/ui-components.md) |
| Transcript cards & composer | [ThinkingCard.tsx](../src/components/ThinkingCard.tsx), [ToolCallCard.tsx](../src/components/ToolCallCard.tsx), [chatgpt-prompt-input.tsx](../src/components/ui/chatgpt-prompt-input.tsx) | [Transcript UI](development/ui-components.md#transcript-cards-and-composer) |
| Transcript loading & log storage | [store/logs.rs](../backend/src/store/logs.rs), [transcriptCache.ts](../src/services/transcriptCache.ts) | [Conversation logs](development/conversation-logs.md), [event storage](architecture/runtime.md#event-and-output-storage) |
| Providers, authentication & role models | [provider_auth.rs](../backend/src/provider_auth.rs), [provider-host.ts](../engine/provider-host.ts), [modelConfig.ts](../src/modelConfig.ts) | [Provider/auth bridge](development/pi-integration.md#providerauth-contract-checks) |
| Composer commands & model scope | [useComposerCommands.ts](../src/hooks/useComposerCommands.ts), [composer RPC](../backend/src/engine/composer.rs), [model-visibility.mjs](../engine/model-visibility.mjs) | [Composer commands](development/pi-integration.md#composer-commands) |
| Extensions, MCP & Pi upgrades | [global-extensions.ts](../engine/global-extensions.ts), [mcp-config.ts](../engine/mcp-config.ts), [pi-compat.ts](../engine/pi-compat.ts) | [Pi integration](development/pi-integration.md) |
| Startup & prewarming | [process_prewarm.rs](../backend/src/engine/process_prewarm.rs), [prepared-host.ts](../engine/prepared-host.ts) | [Prewarming](development/pi-integration.md#prewarming-and-prepared-runtime) |
| Workspace & cache cleanup | [cleanup.rs](../backend/src/cleanup.rs), [workspace_cleanup.rs](../backend/src/workspace_cleanup.rs), [native_runtime_storage.rs](../backend/src/native_runtime_storage.rs) | [Storage & cleanup](architecture/storage.md) |
| Tests & script maintenance | [test-suites.mjs](../scripts/test-suites.mjs), [test.mjs](../scripts/test.mjs) | [Testing](development/testing.md#test-and-script-organization) |
| Setup, builds & CI | [package.json](../package.json), [dev.mjs](../scripts/dev.mjs), [workflows](../.github/workflows) | [Contributing](../CONTRIBUTING.md), [Testing](development/testing.md) |
| Harbor evaluation | [harbor_agent.py](../benchmark/harbor_agent.py), [run.py](../benchmark/run.py) | [Harbor](benchmarks/harbor.md), [benchmark README](../benchmark/README.md) |

## Reference pages (on demand)

- **Architecture:** [Contract ownership](architecture/overview.md#contract-ownership), [Execution model](architecture/execution-model.md), [Runtime](architecture/runtime.md), [Workspaces & Git](architecture/workspace-snapshots-and-feedback.md), [Native environments](architecture/native-environments.md), [Filesystem isolation](architecture/filesystem-isolation.md), [Storage](architecture/storage.md).
- **Development:** [Testing](development/testing.md), [Pi integration](development/pi-integration.md), [Conversation logs](development/conversation-logs.md), [UI components](development/ui-components.md), [engine README](../engine/README.md), [Repository homepage settings](../.github/repository-homepage.md).
- **Proposals:** [Workspace cleanliness](proposals/workspace-cleanliness.md) describes work in progress, not the current contract.

## History

[CHANGELOG.md](../CHANGELOG.md) owns versioned history; published release notes live on GitHub Releases. Do not add per-run audit diaries.

## Maintenance

Keep routes current, not exhaustive. Update the single [contract owner](architecture/overview.md#contract-ownership) and affected user guidance when behavior changes; link rather than duplicate background or procedures. Prompts are production inputs, not contributor instructions.
