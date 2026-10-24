# Changelog

All notable changes to Grapher will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A source-native conversation now stays resident. A successful **Serial** turn, or a **Planner** turn whose selected workspace is the source (for example after the graph has finished), **parks** its whole process boundary (the Pi process, its pipes and its tracked process tree) instead of terminating it, and the next turn of the same conversation **reuses** that warm process, so the conversation — and any server it started, such as a dev server — keeps running and hot-reloading across follow-ups. A Planner working in a node workspace, and every Graph node agent, are unaffected: their shell and Pi process are still reclaimed at the end of the turn. A parked shell has **no idle TTL**: a source-native conversation that ran in this backend stays warm for the whole backend process, and it is retired only when the Run or its workspace is deleted, or when the backend stops. Because a parked boundary is re-keyed off its execution owner, invalidating or retrying that turn no longer kills it, and the turn's lifecycle guard now terminates a boundary only when it is the last owner. See [Process lifecycle](docs/architecture/filesystem-isolation.md#parked-source-native-shells).

### Changed

- Upgrade the bundled `pi-continuity` extension from 0.3.0 to 0.3.1, validated against the pinned Pi public boundary: a TLS certificate validation failure is now terminal even when wrapped as `TLS handshake failed: ...`, while a reset connection and a TLS handshake failure without a certificate cause stay retryable.

## [1.3.0] - 2026-10-23

### Breaking

- **Workspaces and Runs created under the previous project-view/environment contract are not compatible and are not migrated.** Grapher now requires the `native-workspace-v4` environment contract and workspace-view schema 5. Legacy slot layouts, hidden in-slot graph Git, workspace-local HOME/caches/managed environments, legacy environment policies (`native-workspace-v1`/`v2`) and legacy ignored-file snapshots are refused with an explicit error before an agent launches, a node resumes, or a saved result runs. Existing conversations, events and on-disk data remain readable/untouched (no deletion, relocation or SQLite migration); start a new Run to use the new contract. External state is keyed by a slot digest (`.grapher-state/<slot-digest>/`) and graph metadata by `.grapher-git/<slot-digest>.git`, so old directories are never reused.

### Changed

- The execution graph pane can now collapse completely, smoothly expanding the conversation to full width. An edge control reopens it at the saved split width; drafts and the selected node are preserved, and reopening during the collapse animation no longer leaves a blank graph.
- Completed Graph runs now include the write-back result in the execution graph overview instead of a separate completion card, retaining the target workspace and copy action, completion time, write-back summary, and Merger execution history and logs.
- Graph and Planner slots now show the project tree itself. Grapher's process state (HOME, platform/XDG caches, npm/pip/conda caches, managed Python/Conda environments) and graph Git bookkeeping live beside the project under the run's `.grapher-state/<slot-digest>/`, never inside it, and the visible `.git` is the source-equivalent project view instead of the graph repository. The automatic environment uses `{state}` rather than `{workspace}` for those paths, caches are created on first use, and `native-workspace-v4` is the production contract. See **Breaking** above for legacy Runs.
- Upgrade the pinned Pi engine from 1.3.0 to the official stable 1.4.0 release (exact `v1.4.0` tag at `4a080252f06caf63a525d7873c5d94d3c23887e0`), refreshing the checksummed model catalog and reviewed dependency profile; the profile adds `marked-cjk-friendly` and keeps every other pin.
- Upgrade the bundled `pi-continuity` extension from 0.2.1 to 0.3.0, validated against the pinned Pi 1.4.0 public boundary: usage-limit polling without an advertised reset time now waits 10 minutes per attempt (was 15) and adds a 20-minute buffer to later windows after one is exhausted, and bare `stream error` wrappers recover as transient while auth, context-overflow and usage/billing causes stay terminal.
- Pi packages now build in workspace dependency order because 1.4.0's `chord` package depends on `pi-telemetry` while upstream's root build script still lists `chord` first. A clean offline build therefore no longer typechecks against a stale `pi-telemetry` copy, and a future upstream internal dependency is ordered automatically.
- Pi's dependency install gate temporarily audits at `--audit-level=high` instead of `moderate`: upstream 1.4.0 still pins the test runner `vitest@4.1.11`, whose two moderate advisories (`GHSA-qxg6-89mg-rqv8`, `GHSA-xp26-3454-mjgp`, fixed in 4.1.12) otherwise fail every clean `pi:setup` and CI job without any shipped-runtime impact. High and critical advisories still block, matching the scheduled [dependency audit](.github/workflows/security-audit.yml), which keeps reporting the profile; restore `moderate` when upstream Pi bumps `vitest`.
- The refreshed catalog retires `github-copilot/gpt-5.4`, `openai-codex/gpt-5.5`, `openai-codex/gpt-5.3-codex-spark` and the `gpt-5.2-chat-latest`/`gpt-5.3-chat-latest` aliases, so saved selections on those ids need an available replacement. Codex `gpt-6.1-sol`, `MiniMax-M3.1-Flash` and the `xhigh` thinking level on Grok 4.3 are now available; catalog regression coverage lives in the [Pi contracts](scripts/pi-compat.test.ts).
- The codebase was tidied up: obsolete and incorrect comments were removed.
- Streamed model text now reveals with a typewriter effect: assistant answers (including node and Planner output) type out as they arrive, and an expanded Chain of Thought card types its reasoning while a collapsed card stays silent and resumes only when reopened. The reveal keeps a steady pace and speeds up only to stay in sync with bursts, and it is skipped when the system asks for reduced motion.
- Private Graph executions on Linux and macOS now report a denied path as a permission error instead of the platform's raw errno. Linux masks are made unreadable rather than left empty, so listing a masked source, workspace or runtime path fails with a permission error instead of returning a silent empty directory, and a denied read no longer looks like a missing file. The backend supplies the execution's deny set to the engine for this diagnostic only; the platform boundary and the files themselves are unchanged.
- The workspace file-changes panel now orders added and deleted files first, and within each status group ranks rows by total changed lines (`additions + deletions`), so the most notable edits are the ones kept when the list is capped.
- Node workspace preparation no longer spawns a `git cat-file` process for every unchanged project file, and it no longer re-applies metadata (ACL, streams, attributes, encryption) that is already correct. Recomposing a large dependency/build tree — especially a conflicted one — is substantially faster; the complete post-preparation comparison still gates readiness, so verification is unchanged.
- The preparation status now names the stage in progress — merging upstream results, preparing a conflicted workspace, or copying ordinary files — instead of always reporting a directory copy. A stage label is shown only when every preparing node agrees, so concurrent nodes are never mislabeled.
- Dependency and bytecode artifacts are no longer collected, composed or published. Runtime excludes `node_modules`, `.next`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.turbo`, `.parcel-cache` and `.pyc`/`.pyo`/`.tsbuildinfo` files, so a large dependency/build tree no longer dominates preparation and write-back. The policy never overrides the project's own Git: a tracked dependency or bytecode file stays authored project content, and the excluded files remain on disk for the agent to use. `dist`/`build`/`out`/`target` are not excluded (ambiguous with authored directories).
- Publication (writing a result back to the source folder) no longer reads and hashes every delivered file twice, and no longer captures per-file filesystem metadata for a verification pass that only compares content. Staging reuses the content hash the scan already computed and only reads a file when its object is not yet stored, and the post-checkout check compares the private index tree and a stat-cache diff instead of taking a second full snapshot. Delivering a large dependency/build tree to the source is substantially faster; the delivered bytes are still verified against the composed result.

### Fixed

- Session token details now update while a turn is still running instead of waiting for the bounded watchdog poll or the committed turn summary. An Execution refreshes its snapshot as soon as a streamed record moves usage, context, model or tool counters, and an in-flight Planner turn publishes the same counters as a history-only `planner_turn_progress` event that the committed summary replaces.
- Enabling **Auto Approve** in Settings now takes effect for the current Planner conversation: a Graph already waiting for approval is approved and starts immediately, and a plan whose Planner turn is still running uses the newly enabled setting when it commits. Previously the toggle only affected Runs created afterwards, so an in-progress conversation stayed pending.
- Default environment discovery now binds a venv created in the visible project (`.venv` in W) as well as one provisioned under `{state}` (S). Receipts and launch records carry the owning root, project-owned environment scopes stay out of project-view comparison, Git status and composition, and the model shell keeps the path-free `GRAPHER_NODE_NAME` needed by ordinary task commands. Previously the discovery observer only looked at S, so the venv was never recorded and downstream nodes fell back to the host Python. macOS now also tolerates its system-managed `com.apple.provenance` xattr when copying read-only Git objects.
- The native acceptance teardowns now reclaim the Linux private-execution mask trees before deleting their temporary root, mirroring the backend's own mask-aware engine-cache reaping. A mask clears the read bit so that listing a protected path reports a permission error instead of a silent empty directory, and a generic recursive delete cannot list such a directory.
- The model-visible path namespace now renders the source project as the workspace root too, not only the current workspace. A denied source path therefore reports the model-visible `./...` spelling instead of echoing its physical location, matching the physical mapping that already redirects source paths into the current tree.
- The model shell environment check now reads the temp binding that survives the host shell: Git for Windows resets `TMPDIR`/`TMP`/`TEMP` to its own `/tmp` but keeps `XDG_RUNTIME_DIR`, so the Run cache scratch is verified through the surviving binding and no temp binding may reveal `data/`.
- Markdown replies and replayed transcripts now pass through a parsed HTML allowlist rather than regex filtering. Event handlers, executable/encoded URLs, embedded documents and other active markup cannot execute scripts or call the local API, while code blocks, tables, images and inert task-list checkboxes remain usable.
- Selecting or removing an unsent attachment no longer writes, overwrites or deletes project files. Send stores each attachment under a unique `grapher-attachments/<id>/` path and references the returned path; retries are idempotent, changed files are never overwritten, and deletion accepts only managed attachment paths.
- Uploading an attachment never edits a private Run workspace (a node slot, a Merger directory, or a Planner cwd borrowed from one). The file is staged as an immutable Run/node-scoped input outside that workspace and delivered only when an agent actually owns the directory, so an upload cannot change a completed project view, a Planner upload cannot mutate the node view it borrows, and the window where a worker has sealed its result but `Finished` is not yet recorded is safe too. Uploading an attachment no longer makes continuation fail with `Completed project/Git metadata changed outside its recorded execution`.
- Staged attachment inputs are delivered at the real ownership points (node execution, live steer, Planner turn/steer, Merger continuation) and only for the references an accepted instruction claims. Continue and initial recovery rebuild those references from the durable `Started` message claims and accepted steers, so a batched turn never loses one of its inputs even though Pi is not sent the prompt again. A completed-delivery receipt distinguishes an interrupted copy from the agent's own edits and deletions, and recovery preserves a deleted attachment directory instead of recreating it. Restart/retry keeps partial work, and explicit Run deletion cleans the staged inputs.
- Attachment mutations use new safe API commands and never fall back to the legacy basename-writing/deleting commands. A new frontend talking to an older backend now fails before any project-file write, instead of detecting an unsafe response only after the original file was overwritten; retired commands are rejected by the new backend too.
- Attachment uploads/deletions now route to their owning Run and resolve the actual Node, Planner or Merger workspace, including source-direct follow-ups after publication. Missing, mismatched or unwritable targets fail explicitly instead of silently falling back to the source directory, and linked attachment directories are refused. Late upload replies cannot send into a newly selected conversation/workspace.
- File completions now parse NUL-separated Git filenames, preserving Chinese/Unicode names, whitespace and other special characters instead of exposing Git's quoted escape sequences. References containing spaces or quotes are quoted before insertion into the composer.
- A bound project view keeps its composition merge in the graph Git. The Merger's own Git commands now target that repository, and the unresolved-conflict checks (node view and composition acceptance) inspect it too, so a Merger can see `MERGE_HEAD` and resolve composition conflicts instead of reporting `Unresolved project Git conflicts remain`.
- On Linux and macOS the Merger's Git now reaches that graph metadata inside the platform sandbox. Because the external graph Git sits beside the masked worktrees root, the Linux/macOS boundary hid it and the Merger's `git diff`/`git add` failed with `Not a git repository` (only Windows, which has no per-node sandbox, worked). The sandbox now exposes exactly that repository, plus its validated borrowed object store, to the Merger role, while node and Planner agents still cannot reach graph history.
- Project-view identity and equality now ignore storage history that does not change the project: the Windows security descriptor (SDDL inheritance differs by parent path) and the per-workspace `.git/index` stat cache (ctime/mtime/dev/ino). Equivalent workspaces and the independent entries of one publication therefore compare equal, so a failed result execution's partial state is reused on retry and independent published entries share one project code.
- Project staging composition accepts an input whose index still carries an unresolved conflict by composing its "ours" side, instead of refusing the whole composition after the graph merge was already resolved.
- Publication result descriptors give every independent entry the publication head as its code reference, and a re-publish verifies an entry workspace against the head it already holds rather than the entry's original node code.
- A history edit or feedback retry keeps its pinned base: collecting the source snapshot no longer overwrites the execution's `before`.
- Binding the source to a new workspace takes the live folder exactly as it is (uncommitted, untracked and ignored entries included); the source's Git status is not consulted.
- A private workspace whose external process root is missing now reports the source-equivalent/legacy error instead of a raw OS path error, and recording the composed publication head records that head's project view in place instead of manufacturing a per-entry commit.
- Resumed Planner and node sessions now keep extension tools that the session never added or removed, so follow-ups retain Grapher's `node`, `edge` and `switch_workspace` tools instead of losing them until the next explicit activation.
- Retrying or continuing a node whose physical workspace directory was removed (for example after a manual delete or an interrupted reclaim) no longer fails with `Cannot run git ... No such file or directory`. Stale hidden slot Git metadata beside a missing slot no longer reports a private repository, so preparation rebuilds the workspace instead of spawning Git in a directory that does not exist.
- Windows node preparation no longer fails after a successful merge when a project contains paths longer than the legacy `MAX_PATH` limit. Project metadata (ACL, alternate data streams, attributes, encryption) and project reparse points (junctions/symlinks) are opened through an extended-length native path, so a deeply nested dependency tree such as `UI/node_modules` prepares instead of failing with `系统找不到指定的路径。 (os error 3)`. The encoder is shared by the metadata and link layers, opens the link itself rather than following it, and leaves the ordinary Node/Git/Bash path namespace unchanged.
- Session details now update token usage while a node or merger turn is still running instead of waiting for its terminal event, and distinguish cumulative provider tokens (`cumulative tokens`) from `context window` (the model's capacity) and `current context` (the entire retained conversation prompt the latest model call read, with its share of that capacity). Model windows now also resolve custom providers from Pi's agent `models.json`, so local model aliases report their real capacity instead of only the used prompt. The two measurements answer different questions and do not converge as a session grows.
- Continue is now enabled for a managed-environment node that failed during preparation (before `Prepared`, with no conversation), such as a workspace/environment conflict. It re-dispatches as a fresh attempt instead of resuming a missing session; provider/model failures after preparation keep their existing recovery paths.
- Graph composition no longer commits managed environment/cache scopes (`.agent-home`, `.venv`, `.environments`) into a merge commit when the Merger resolves conflicts. Node composition now passes the same staging exclusions as publication, and merge completion removes any accidentally staged scope from the index while leaving the live files untouched; a merge the Merger committed itself is amended to drop the scope. This fixes the `Managed environment/cache conflicts with tracked file` failure at node preparation.
- Environment snapshots now exclude the agent's machine-local caches. The automatic policy carves the Windows/browser caches under the redirected `.agent-home` (for example `AppData/Local`, which holds `INetCache`, `D3DSCache` and browser profiles) out of the snapshot, and a cache may now be nested inside a managed scope instead of only being a top-level path. Excluded paths are left untouched in the live workspace. Runs that already resolved their environment policy keep it until re-resolved.
- Continuing or sealing a node no longer fails with `Cannot inherit broken link` when an environment scope (for example `.agent-home`) contains a Windows reparse point that the system cannot resolve or read, such as Chrome's `INetCache\Content.IE5`. The environment snapshot skips that entry and leaves the live link untouched instead of aborting the handoff.
- A completed node turn is no longer failed when a background helper the agent left running (for example a browser crashpad handler) is still inside the owned process boundary. Managed handoff now keeps the node `running` for a bounded grace so that helper can finish on its own, then terminates whatever remains and confirms the boundary is empty before sealing; only a descendant that escaped the boundary still refuses the seal.
- Session details now report the whole Pi session's token usage. Follow-ups, retries, and resumed Planner turns continue one session, so its counters accumulate instead of restarting with each attempt. Selecting an older attempt shows only the usage accumulated through that attempt, and omits token details when that prefix cannot be determined. Planner turns recorded before session tracking are attributed to the displayed conversation.
- Session details now show `context window`: the prompt the session's newest turn read, compared with the model's context window, instead of the summed provider total, which added cached prompt re-reads and could not be compared with the window. A failed or aborted turn no longer resets that reading to zero, and metrics recorded before this change recover it from the stored log tail instead of showing it as unknown.
- Deleting a Graph conversation now removes its run-scoped internal Git refs, orphaned commit heads, and unreachable objects while preserving refs for other live Runs sharing the same source database.
- Planner `node`/`edge` edits now render in the topology immediately while revising an approved graph that is not executing, instead of waiting for the Planner turn to finish. Accepted single-edit and JSON-string edit shapes also preview immediately, and runs with active work still keep the committed topology until the revision commits. A failed revision restores the committed topology.
- Planner and Node session details now report the Pi session's first start time and accumulated `time took`; follow-ups, retries, and resumed Planner turns no longer reset the clock to the newest attempt.
- Planner steers no longer disappear after the reply when the durable transcript window starts at that steer, and streamed assistant text no longer grows an optimistic user/steer bubble.
- Settled reasoning blocks that produced no visible text now keep their card and explain the missing content in live and replayed transcripts instead of disappearing without a trace.
- The workspace file-changes panel no longer mounts every row at once. Because its disclosure keeps children mounted even while collapsed, a Run with tens of thousands of changes froze the workbench even when the card was never opened; it now renders at most 500 rows and represents the remainder with an ellipsis count.
- Pausing a node no longer strands a steer Pi had not read yet. A message sent while the node's tool call was still running used to keep its card, so editing it failed with `Cannot locate that user turn in the Pi conversation tree`; the card is now removed and its text returns to the composer so it can be edited and resent.
- Selecting a not-yet-executed node (for example a Planner-added node still `waiting`) no longer shows every node's file changes. The file-changes panel treated a node with no executions as "unscoped" and fell back to the run-level aggregate that merges all nodes, Planner writes and publication; a node conversation now scopes to its own (possibly empty) execution list, so a waiting node reports no changes while the main view still shows the run total.

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


[1.3.0]: https://github.com/zhexusun10/grapher/compare/v1.2.6...v1.3.0
[1.2.6]: https://github.com/zhexusun10/grapher/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.5
[1.2.4]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.4
[1.2.3]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.3
[1.2.2]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.2
[1.2.1]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.1
[1.2.0]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.0
[1.1.0]: https://github.com/zhexusun10/grapher/releases/tag/v1.1.0
