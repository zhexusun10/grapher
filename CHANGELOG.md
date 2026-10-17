# Changelog

All notable changes to Grapher will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Settings gained a **Planner file tools** toggle that mounts the Planner's `write` and `edit` tools. It is off by default; `read`, native Bash, node/edge, and extension tools stay available either way.
- Settings gained a **Chain of thought display** toggle that decides whether COT cards auto-expand while a node or the Planner is thinking. It is off by default, lives only in the browser, and collapsed cards render no Markdown.

### Changed

- Model settings are now scoped to the selected conversation: a save inside a Run records that Run's selection and applies Node Agent overrides to its nodes, while the defaults used by other and new conversations are left untouched.
- Node and Serial transcripts now share the Planner transcript's layout, chat bubble styling, and card spacing, so every mode keeps the same rhythm and follow-up turn transitions.
- The English and Chinese READMEs now state the zero-conversation-passing positioning and document Post-task Planner review.
- New Planner turns no longer prepend workspace and node-status context when every node is completed or the Graph is still awaiting approval; those turns run in source with no workspace switch, send the user's instruction unchanged, and still consume the one-shot rework marker.
- Planner now always runs in the latest workspace and starts immediately: it no longer waits for or falls back to the source workspace when the corresponding node is still running.
- Session info labels the execution location as `workspace` instead of `worktree` for consistency.
- Node and Planner steering requests now return as soon as they are queued instead of blocking the UI.
- Session info for nodes, Serial, and the Planner shows an English `start time` before `time took`.

### Fixed

- Sidebar loading animation could play more than once.
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

## [1.1.0]

Baseline release. The changelog is restarted from the current codebase at v1.1.0; this version is the reference point for future entries.

### Added

- **Post-task Planner review (`postTaskReview`)**: After all tasks complete and changes are successfully published back to the source project, the Planner is invoked to review the published outcome and decide the next move.
  - **Unrestricted follow-up actions**: Planner can inspect/audit the updated workspace, formulate a follow-up plan with new task nodes, report results to the user and wait for instructions, or finish wrap-up tasks directly.
  - **Zero conversational message passing preserved**: Strictly maintains the core invariant that no chat messages are passed between nodes; execution instances inherit Git workspace states rather than conversational context.
  - **Configurable**: Can be toggled on/off in Settings (`postTaskReview`, enabled by default).
  - **Loop engineering**: When combined with Auto Approve, creates a robust, closed-loop engineering cycle that autonomously plans, executes, verifies, and iterates until the Planner concludes.


[Unreleased]: https://github.com/zhexusun10/grapher/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/zhexusun10/grapher/releases/tag/v1.1.0
