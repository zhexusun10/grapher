# Changelog

All notable changes to Grapher will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Deleting a Graph conversation now removes its run-scoped internal Git refs, orphaned commit heads, and unreachable objects while preserving refs for other live Runs sharing the same source database.

## [1.2.6] - 2026-10-21

### Added

- Session details now show backend-reported token usage for Planner, Serial/Graph node, and Merger turns: total, input, output, cache read/write, and reasoning tokens. Completed Graph runs also show run-level token totals and cache hit rate in the topology footer.
- The workbench now displays explicit `Publishing…` and `Merging…` states while publication is in progress instead of a generic working label.

### Changed

- Graph mode now keeps node, snapshot, and merge commits in a host-only Git database. Final publication writes files only: the source branch, HEAD, index, and object database stay unchanged, and no node commit enters the source directory.
- Improved session-details readability with proportional typography, consistent row spacing, and wrapped multi-column timing and token fields.
- Snapshot commits created while preparing multi-agent workspaces now use the neutral subject `snapshot` instead of `Grapher execution snapshot`.
- Automatic Git maintenance is disabled during Grapher-owned snapshot commits and node ref imports so opportunistic repacking cannot stall node completion.

### Removed

- Removed the frontend native-environment result panel and its unused frontend command wrappers/types. Environment admission, publication descriptors, and result execution remain backend/runtime concerns and are no longer exposed in the UI.

### Fixed

- Token counts now exclude prompt-cache reads from consumed tokens while including one-time cache writes, sum every Planner turn including post-task review, and show the provider total separately. This fixes inflated or incomplete token totals in session details and the completed-run footer.
- Node Agent and Serial steer messages now stay with the execution they steered: they render above that execution's transcript instead of appearing as a separate later turn or below the response they produced.
- ML environment result-descriptor generation no longer gates code publication. If environment evidence cannot produce a launchable descriptor, the Run still publishes code without one; stale descriptors are rejected, and live-writer safety is preserved.

## [1.2.5] - 2026-10-20

### Changed

- Planner and node error messages now use the compact conversation-error styling, and sidebar hover/active states and conversation reveal transitions are more consistent.

### Fixed

- Windows planning no longer fails when Git receives a console interruption (Ctrl+C/Ctrl+Break) during a snapshot commit. Host Git now runs outside the backend console, and failed Git commands retain their exit status, working directory, command, and output instead of only line-ending warnings.
- Planning failure diagnostics survive backend restarts and remain visible in the conversation.

## [1.2.4] - 2026-10-20

### Added

- Markdown code blocks now include accessible copy buttons with clipboard success feedback.
- Added `npm run clean:stale` to inspect and clean stale build artifacts; the development launcher also attempts cleanup after a successful backend build.

### Changed

- Sidebar conversation cards now load from a prewarmed, read-only backend summary projection instead of hydrating every conversation history. SQLite commits invalidate the projection, and unavailable histories do not block settings or unrelated conversations.
- Improved workbench typography, spacing, sidebar cards, Markdown presentation, and session timing readability. Session durations now display whole seconds and refresh on elapsed-second boundaries.
- `npm run dev` now opens the frontend in the browser automatically.
- Renamed the backend test script to `test:backend` and updated CI and contributor documentation to use the explicit suite name.

### Fixed

- Sidebar reconciliation now replaces stale browser hints with the authoritative backend conversation index while preserving only explicitly unavailable conversations.
- Settings saves no longer depend on loading the global sidebar projection, and startup metadata no longer waits for repository scans.
- Code-block copying now handles clipboard failures and cleans up feedback timers when the component unmounts.

## [1.2.3] - 2026-10-19

### Added

- **Workspace file changes panel and diff card components**: Added a file changes disclosure panel and diff indicators to inspect files created, modified, or deleted across agent executions (`src/components/changes/`, `src/hooks/useWorkspaceChanges.ts`, `src/services/fileChanges.ts`, `src/components/AnimatedDisclosure.tsx`, `backend/src/file_changes.rs`).
  - Aggregates file change status (added, modified, deleted, renamed) alongside per-file line addition and deletion counts (`+N / −M`).
  - Displays real-time loading spinners on files actively being touched by in-flight tool runs (`write`, `edit`, `bash`).
  - Seamlessly integrates into the workspace details drawer across Planner, Serial, and Graph node conversation views with smooth animated transitions.
  - Backed by incremental backend log chunk parsing and Git working tree status, avoiding expensive full-repository diff operations on every turn.

### Changed

- **Optimized Settings modal and Sidebar layout**: Streamlined model selection, provider configuration, and conversation history drawers for faster navigation and clearer visual hierarchy (`src/components/ProviderSettings.tsx`, `src/components/RoleModelSettings.tsx`, `src/components/layout/Sidebar.tsx`, `src/modelConfig.ts`, `backend/src/workspace.rs`).
- **Bypassed Git pipeline in Serial mode**: Serial execution now operates directly against the project workspace without creating Git snapshots, staging commits, worktrees, or shadow repositories (`backend/src/runtime.rs`, `backend/src/workspace.rs`, `backend/src/server.rs`, `backend/src/serial_workspace_tests.rs`). Bypassing the Git snapshot cycle for single-agent execution eliminates unnecessary commit overhead, reduces file I/O churn, and keeps the host repository clean.
- **SQLite logging and output stream coalescing**: Introduced an in-memory output buffer to coalesce high-frequency, small streaming deltas (such as thinking and text tokens) into bounded batches (up to 4 KB or 50 ms) before database persistence (`backend/src/engine/output_buffer.rs`, `backend/src/engine.rs`). Combined with single-transaction batched log appends and incremental transcript projections (`backend/src/store/logs.rs`, `backend/src/store.rs`), this significantly reduces SQLite write operations and JSON serialization overhead while preserving responsive UI streaming and guaranteeing tail preservation on process interruption or timeout.

### Fixed

- **Teardown race on publication completion**: Fixed a teardown race condition where publication could complete while the background driver thread was still cleaning up workspace resources (`backend/src/server.rs`).
- **Top-aligned scroll for unrun node agents**: Fixed scroll positioning when opening the conversation view for a node agent that has never run (`src/components/views/GraphWorkbench.tsx`). Because unexecuted nodes only contain their initial task prompt at the top, the scroller now starts at the top rather than scrolling down to empty space or spuriously displaying the "scroll to bottom" button.
- **Planner chat transcript settlement and completion sync**: Fixed a race condition where the final message or trailing output of a Planner conversation turn could disappear from the UI (`backend/src/server.rs`, `src/components/PlanningActivity.tsx`). The backend now reliably broadcasts planning output completion notifications (`notify_planning_output`) across both foreground and background turns once durable logs are finalized, and the frontend resets settled segments upon notification and bounds empty-window retries to ensure transcripts are always read through to the true EOF.

## [1.2.2] - 2026-10-18

### Fixed

- **Connection stability and startup lock contention**: Deferred snapshot and label polling until initial bootstrap finishes (`src/App.tsx`, `src/hooks/useSnapshotPolling.ts`). This avoids lock contention between the frontend's early background polling and the backend's primary runtime lock during startup, stabilizing frontend-backend communication and automatically clearing transient "loading backend settings" banners once bootstrap completes. Added service responsiveness regression tests (`backend/src/service_responsiveness_tests.rs`).
- **Inline message edit cursor jumping**: Fixed an issue where typing during an inline message edit would force the caret to jump to the end of the textarea on every keystroke (`src/components/views/ChatBubbles.tsx`). Caret selection is now set only once upon entering edit mode, preserving the cursor position during user typing.
- **Planner session loss on interrupted first turn**: Fixed conversation session loss when interrupting, stopping, or editing the Planner's initial turn before a graph is committed (`backend/src/server.rs`, `backend/src/prompt_tests.rs`, `src/lib/plannerOutput.ts`). The backend now recognizes durable planning attempts across `PlanningStarted`, `PlannerWorkspaceSelected`, `PlannerTurnAborted`, and `PlanningFailed` events without requiring a committed `created` or `graph_revised` event, allowing session branching and rollback to operate safely.
- **Duplicate rendering when editing Planner initial goal**: Fixed an issue where editing the Planner's initial goal caused the user turn to be rendered twice in the UI during streaming continuation (`src/components/views/GraphWorkbench.tsx`, `src/services/plannerUserTurns.ts`). The live transcript stream now deduplicates the seeded initial user turn against the canonical goal bubble.

## [1.2.1] - 2026-10-18

### Changed

- Upgraded the bundled `pi-better-web-search` extension from `0.1.0` to `0.1.4`, adapting its entrypoint to `extensions/index.ts`.
- Switching project workspaces now resets cleanly to the home view instead of auto-opening the most recent conversation; existing conversations remain accessible from the sidebar.
- Clarified the Planner model description in Settings to refer to "Execution graph" (`执行拓扑图`) rather than "Collaborative graph" (`协作拓扑图`).

### Fixed

- Input composer now preserves the draft message when the backend does not acknowledge receipt or before the Planner bootstraps, preventing message loss on delivery failures.
- Sidebar scroll container styling adjusted with dedicated offset and padding variables (`--sidebar-scrollbar-offset`), preventing the scrollbar from overlapping project and run cards.
- Hardened cross-platform path compatibility across Windows, macOS, and Linux:
  - Preserved launched session working directory spellings on Windows.
  - Resolved workspace roots with native realpath to handle 8.3 short paths and junctions consistently.
  - Normalized Git Bash / MSYS mount paths (such as `/tmp/...`) to host paths before file-tool resolution.
  - Handled workspace paths containing semicolons safely with single-value `cygpath` fallbacks instead of broken batch splitting.
  - Excluded platform-specific ignored host metadata from Git snapshots portably using `git ls-files`.

## [1.2.0] - 2026-10-18

### Added

- Settings gained a **Planner file tools** toggle that mounts the Planner's `write` and `edit` tools. It is off by default; `read`, native Bash, node/edge, and extension tools stay available either way.
- Settings gained a **Chain of thought display** toggle that decides whether COT cards auto-expand while a node or the Planner is thinking. It is on by default, lives only in the browser, and collapsed cards render no Markdown.
- Settings now lists the bundled `pi-better-web-search` extension. It is on by default; when disabled it stops applying to Planner and Node Agent and its provider-native `web_search` tool is not registered.
- Tool cards recognize the bundled `web_search` tool and summarize its query or URL list instead of falling back to the generic tool card.

### Changed

- Model settings are now scoped to the selected conversation: a save inside a Run records that Run's selection and applies Node Agent overrides to its nodes, while the defaults used by other and new conversations are left untouched.
- Node and Serial transcripts now share the Planner transcript's layout, chat bubble styling, and card spacing, so every mode keeps the same rhythm and follow-up turn transitions.
- The English and Chinese READMEs now state the zero-conversation-passing positioning and document Post-task Planner review.
- New Planner turns no longer prepend workspace and node-status context when every node is completed or the Graph is still awaiting approval; those turns run in source with no workspace switch, send the user's instruction unchanged, and still consume the one-shot rework marker.
- Planner now always runs in the latest workspace and starts immediately: it no longer waits for or falls back to the source workspace when the corresponding node is still running.
- Session info labels the execution location as `workspace` instead of `worktree` for consistency.
- Node and Planner steering requests now return as soon as they are queued instead of blocking the UI.
- Session info for nodes, Serial, and the Planner shows an English `start time` before `time took`.
- Planner `node` and `edge` calls now accept the common single-edit shapes models send (a bare edit, an edit object under `nodes`/`edges`, a JSON string, or a thin batch) and coerce primitive fields before Pi's validator runs. Rejected calls return concise domain errors that state the graph is unchanged; only an accepted compiler result updates the graph and its returned topology.

### Fixed

- On macOS, untracked Finder/AppleDouble metadata (`.DS_Store`, `._*`) is no longer force-collected into Git snapshots, copied into private workspaces, or reported as uncommitted dirt. Explicitly tracked metadata remains part of the repository, and Windows/Linux collection is unchanged.
- Sidebar entrance animation could play more than once when progressive history validation removed and re-appended cached cards; validation now preserves the cache's card order, and a cold cache keeps the backend's newest-first order.
- Frontend real-time refresh treated SSE as the only source of truth, so snapshots were not read correctly; SSE and polling now reconcile consistently.
- Inconsistent spacing between information cards in the Planner conversation, and incorrect animation for user messages sent or appended.
- A persisted summary for a running planning session can reconnect automatically and is no longer blocked by an existing run; reconnect and error banners are unified, revisions no longer show a spurious `auto` route card, and the input stays unlocked while reconnecting.
- The bottom result card is hidden while a new message is appended or Planner output is streaming.
- Newly created nodes inherit the latest Node Agent settings, and session info records the model that was actually used.
- Node session info reported the conversation's Node Agent model instead of the model an attempt actually executed with; the recorded model now comes from the execution transcript, with the node's own override as the fallback for older runs.
- Downstream nodes marked `dirty` by feedback to an upstream node no longer keep showing Working while waiting for their dependencies; the composer now reflects only an actual running execution, an in-flight send, or a dispatch-eligible dirty node with a queued user message.
- A Planner follow-up sent as a new revision rendered its user turn and Chain of Thought twice while streaming; the in-flight attempt's durable JSONL is no longer replayed next to the live transcript.
- Tool cards held whole file bodies in memory when `write`/`edit` arguments carried them; arguments are now bounded like results, marked as truncated, and copying uses the bounded preview.
- Streaming Chain of Thought re-parsed its Markdown on every delta, which could stall streamed text and scrolling; COT bodies now render from a deferred value.
- A failed or still-running Planner `node`/`edge` call could open an empty execution graph pane; the pane now appears only after an accepted tool result.
- Windows command adaptation now maps unquoted native `C:\...` paths, including attached options such as `cc -IC:\...`, instead of treating the backslashes as POSIX escapes; external paths also keep the caller's spelling after file-tool resolution rather than being normalized in place.
- Command path words are resolved before source-prefix mapping, so 8.3/junction spellings map to the normalized workspace path instead of leaving a `..` tail inside the rewritten command; paths that escape every project root stay external, and known MSYS mounts are converted through cached `cygpath` roots so a native `C:\\tmp\\...` path is not mistaken for Git Bash `/tmp`.
- File-tool `read`/`write`/`edit` input now converts registered Git Bash mounts such as `/tmp` to their host path before resolving against the workspace, instead of treating `/tmp/...` as `C:\\tmp\\...`.
- JavaScript path identity now mirrors Rust `actual_path()` for native realpath, 8.3/junction aliases, symlinks and missing leaf components, keeping `samePath`, `pathKey` and file-tool mapping consistent across hosts.
- A Windows workspace name containing `;` no longer corrupts the one-shot `cygpath -u -p` batch; a split-count mismatch falls back to per-value conversion.
- A node attempt that failed before Pi created its conversation file left the node unresumable: a follow-up, Continue, or retried/edited message now starts the task in the retained workspace and session slot instead of failing with `Cannot resume node session` or `Expected exactly one persisted Pi session for this execution`.
- A Windows Pi fail-fast while tearing down the process (for example exit code `0xc0000409`) no longer discards a turn that already emitted its final response and `agent_settled`; the completed Planner/Partitioner result is kept and the abnormal exit remains in the execution log.
- Global extension deduplication kept only a scoped package's directory basename for skills, so `@a/tools` and `@b/tools` could shadow each other; skills now use the full package name. Native launch validation now resolves symlinks and compares filesystem identity, covering macOS `/var` aliases, symlinked environments and case-insensitive volumes.
- Settings mirrored unrelated application errors, so a failed node or Planner action also appeared inside the modal; it now reports only its own save, language, provider-auth and extension-operation failures.

## [1.1.0]

Baseline release. The changelog is restarted from the current codebase at v1.1.0; this version is the reference point for future entries. Project development began on 2026-09-12.

### Added

- **Post-task Planner review (`postTaskReview`)**: After all tasks complete and changes are successfully published back to the source project, the Planner is invoked to review the published outcome and decide the next move.
  - **Unrestricted follow-up actions**: Planner can inspect/audit the updated workspace, formulate a follow-up plan with new task nodes, report results to the user and wait for instructions, or finish wrap-up tasks directly.
  - **Zero conversational message passing preserved**: Strictly maintains the core invariant that no chat messages are passed between nodes; execution instances inherit Git workspace states rather than conversational context.
  - **Configurable**: Can be toggled on/off in Settings (`postTaskReview`, enabled by default).
  - **Loop engineering**: When combined with Auto Approve, creates a robust, closed-loop engineering cycle that autonomously plans, executes, verifies, and iterates until the Planner concludes.


[Unreleased]: https://github.com/zhexusun10/grapher/compare/v1.2.6...HEAD
[1.2.6]: https://github.com/zhexusun10/grapher/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.5
[1.2.4]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.4
[1.2.3]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.3
[1.2.2]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.2
[1.2.1]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.1
[1.2.0]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.0
[1.1.0]: https://github.com/zhexusun10/grapher/releases/tag/v1.1.0
