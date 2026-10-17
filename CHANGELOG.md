# Changelog

All notable changes to Grapher will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Planner now always runs in the latest workspace and starts immediately: it no longer waits for or falls back to the source workspace when the corresponding node is still running.
- Session info labels the execution location as `workspace` instead of `worktree` for consistency.
- Node and Planner steering requests now return as soon as they are queued instead of blocking the UI.

### Fixed

- Sidebar loading animation could play more than once.
- Frontend real-time refresh treated SSE as the only source of truth, so snapshots were not read correctly; SSE and polling now reconcile consistently.
- Inconsistent spacing between information cards in the Planner conversation, and incorrect animation for user messages sent or appended.
- A persisted summary for a running planning session can reconnect automatically and is no longer blocked by an existing run; reconnect and error banners are unified, revisions no longer show a spurious `auto` route card, and the input stays unlocked while reconnecting.
- The bottom result card is hidden while a new message is appended or Planner output is streaming.
- Newly created nodes inherit the latest Node Agent settings, and session info records the model that was actually used.

## [1.1.0]

Baseline release. The changelog is restarted from the current codebase at v1.1.0; this version is the reference point for future entries.

[Unreleased]: https://github.com/zhexusun10/grapher/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/zhexusun10/grapher/releases/tag/v1.1.0
