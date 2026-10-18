# Changelog

All notable changes to Grapher will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

Baseline release. The changelog is restarted from the current codebase at v1.1.0; this version is the reference point for future entries.

### Added

- **Post-task Planner review (`postTaskReview`)**: After all tasks complete and changes are successfully published back to the source project, the Planner is invoked to review the published outcome and decide the next move.
  - **Unrestricted follow-up actions**: Planner can inspect/audit the updated workspace, formulate a follow-up plan with new task nodes, report results to the user and wait for instructions, or finish wrap-up tasks directly.
  - **Zero conversational message passing preserved**: Strictly maintains the core invariant that no chat messages are passed between nodes; execution instances inherit Git workspace states rather than conversational context.
  - **Configurable**: Can be toggled on/off in Settings (`postTaskReview`, enabled by default).
  - **Loop engineering**: When combined with Auto Approve, creates a robust, closed-loop engineering cycle that autonomously plans, executes, verifies, and iterates until the Planner concludes.


[1.2.1]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.1
[1.2.0]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.0
[1.1.0]: https://github.com/zhexusun10/grapher/releases/tag/v1.1.0
