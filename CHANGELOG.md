# Changelog

All notable changes to Grapher will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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


[1.2.0]: https://github.com/zhexusun10/grapher/releases/tag/v1.2.0
[1.1.0]: https://github.com/zhexusun10/grapher/releases/tag/v1.1.0
