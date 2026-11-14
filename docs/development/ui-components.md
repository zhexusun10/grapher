# UI components and styles

## Shared components and styling

Shared shadcn-style components live in `src/components/ui/` (`@/components/ui/...`); application components live elsewhere in `src/components/`. `components.json` configures the CLI aliases. Add components with `npx shadcn@latest add <component>`; do not rerun `init` in this repository.

Tailwind v4 uses `@tailwindcss/vite` and `src/tailwind.css`, imported by `src/main.tsx`. Semantic colors use `src/tokens.css`; existing global styles remain in `src/styles.css`, `src/styles-workbench.css`, and `src/styles-planning.css`. Preflight is omitted to avoid resetting existing controls. Check new components against the global styles; `cn` in `src/lib/utils.ts` combines `clsx` and `tailwind-merge`.

`src/components/ui/dot-pattern.tsx` uses `useId` and needs no provider or image assets. See it for props and `src/components/views/LandingView.tsx` for home-screen usage.

## Sidebar navigation

Workspace and Conversation cards are native buttons with current/loading states and full accessible names. Sidebar text is not mouse-selectable, avoiding accidental selection while dragging; paths and prompts remain available through the context menu. Collapsed lists become inert immediately, including during their exit transition; keyboard focus rings stay inside the clipped list viewport.

Sidebar menus use [ContextMenu](../../src/components/ui/context-menu.tsx): right-click, Menu or Shift+F10 opens at the pointer/card, arrows and Home/End navigate enabled actions, Escape restores the invoking card, and Tab resumes navigation from it. Measured menu bounds account for translated/scaled text; outside clicks, scrolling and resizing dismiss stale menus. Reduced motion skips the entrance. [Sidebar browser tests](../../scripts/sidebar-copy-prompt-ui.test.mjs) cover keyboard focus, edge placement, copy actions and provisional conversations.

### Sidebar hover labels

The Sidebar deliberately does **not** show hover tags/tooltips, including native HTML `title` bubbles. Do not add them to workspace cards, conversation cards, icon actions or the collapsed rail, even when text is truncated. This avoids redundant floating labels covering nearby items. Keep visible labels and accessible names (`aria-label` for icon-only controls and full workspace paths); conversation text remains available to assistive technology despite visual ellipsis. Full paths and prompts can be copied through the context menu. Hover styling and keyboard focus indicators remain enabled. [Sidebar browser tests](../../scripts/sidebar-copy-prompt-ui.test.mjs) cover this choice in expanded and collapsed states.

## Transcript cards and composer

Slash-command scope, supported Pi RPC interactions and exclusions are defined in
[Composer commands](pi-integration.md#composer-commands). Command suggestions share
the existing keyboard-driven skill/file completion menu; model/thinking choices
come from Pi's catalog, not a separate capability table. Command errors and
notifications use a dismissible floating card above the composer, outside its
intrinsic height; attachment errors remain inline. The Settings model card places
its global Scoped models manager after all role controls. That manager has its own
Save/Cancel and does not change the scope of the surrounding Settings form.

Transcript cards and the overlaid composer share the conversation pane's horizontal centerline in split and full-width layouts. The history scroller reserves symmetric scrollbar gutters so overflow never shifts that axis; scrollbar hit testing excludes the mirrored left gutter. [Responsive layout tests](../../scripts/responsive-layout.test.mjs) check the rendered geometry with and without overflow.

The **Harness settings** card groups **Hide Auto mode**, plan approval, post-task Planner review, node workspaces, Planner file tools and **Enable Feedback**, separate from model configuration. Feedback defaults off and gates editing of its budget; the other toggles default on when unset. Explicit saved choices are preserved. Feedback capability and retained-route behavior belong to [Graph compilation](../architecture/overview.md#optional-feedback-capability). **Hide Auto mode** is a browser-local Settings preference in [displayPreferences.ts](../../src/services/displayPreferences.ts), committed only after a successful Settings save. The modal previews hiding the Partitioner controls without removing their saved model settings. Once saved, every composer mode selector fades and shrinks Auto away, including its flex gap; re-enabling it reverses the reveal. Exiting controls are inert, reduced motion skips transitions, and settled option wrappers remain unclipped so the selected pill can slide between modes. A selected or restored Auto mode becomes Graph and persists that fallback, while Serial/Graph selections remain unchanged. App submission also excludes a hidden Auto mode, including explicit overrides. Existing Run history and running routing decisions are unchanged. Cancelled or failed saves leave the live preference untouched. [Settings browser tests](../../scripts/background-settings-ui.test.mjs) cover persistence, retry, role preservation and submitted modes.

`ThinkingCard` and `ToolCallCard` use `CardReveal.tsx` to grow a grid track from `0fr` to `1fr` without a full-height jump. The card remains the clipped grid item so wrapping and row measurement stay accurate. Reduced motion skips the entrance; virtualized bottom-pin adjustments emit `TRANSCRIPT_SCROLL_ADJUSTED_EVENT` so they are not mistaken for reader scrolling. Execution-record headers, parsed system error rows and cards share the transcript list's 10px spacing, including between adjacent attempts; user follow-up turns retain their larger separation. Whitespace-only assistant text is omitted from the rendered row list, not the parser, so later deltas still extend it without leaving invisible gaps between cards. Revision boundary indices follow the visible rows.

The runtime's terminal `Final response` suffix is Markdown, not JSONL: preserve JSON code, blank lines and indentation until the next explicit transcript source boundary. Suppress the entire fallback when the structured assistant reply is loaded; when older pages recover that reply, retire only its matching fallback copy, not genuine repeated messages. [Transcript regressions](../../scripts/transcript-cache.test.ts) cover full, incremental and paged replay, including fenced JSON followed by feedback control markers.

Tool cards and their headers do not change appearance on hover; click-to-expand, keyboard focus and copy-button feedback remain enabled.

A reasoning card opens at its newest line. Scrolling stays inside a reasoning or tool card while it has room, then chains vertically to the conversation at the edge; only the latter stops outer bottom-following. Reopening reasoning resets to the newest line. Expansion keeps composer focus and does not move a reader who has scrolled away.

Planner revisions page independently. Appending a review or follow-up preserves mounted history windows and expanded cards, even after LRU eviction; earlier rows remain visible while the new log loads, and only that turn's readiness retires its live stream. Settled Planner history waits for its initial viewport fill and row measurements before the conversation fades in, even while graph workers are running; a bounded fallback reveals available rows if an older read stalls. Live Planner output still reveals on its first page. Pre-reveal layout movement is not a request for scrollback. [Planner handoff browser tests](../../scripts/planner-handoff-ui.test.mjs) cover reveal stability and worker-only snapshot updates. Newly measured virtualized rows retain the reader's visual position rather than cancelling their scroll progress. Cached local follow-ups with an unambiguous revision stay at that revision's boundary, not after newer replies; unmatched optimistic messages remain visible. Returning from a Node or the create-node form to a scrolled-up Planner retains measured row heights and restores the visible row, including after a pane resize. If a selected publication Merger appears after its view opens, the replacement conversation scroller receives its own listeners and initial position. A new Conversation still opens at its newest output. See [conversation history](../../scripts/conversation-history-ui.test.mjs) and [manual node](../../scripts/manual-node-ui.test.mjs) browser tests.

During submission, the composer shows a disabled, accessible sending indicator and delays Stop until the send settles. Continuation acceptance uses the same synchronous submission lock, so repeated Enter or clicks cannot submit it twice; Planner acceptance releases the lock as soon as streaming starts, not after the turn ends. A brief pointer-send grace prevents accidental Stop without blocking a new or restored draft. When the backend marks a Node/Serial attempt individually recoverable, its empty composer offers a node-scoped Continue action without adding a user message. A draft or attachment takes precedence over Continue. The footer remains a separate run-wide action. A failed Graph Planner turn can likewise be continued from its empty composer without a new user message. See [runtime recovery](../architecture/runtime.md#recovery-and-ownership) for eligibility and pause semantics.

With the composer focused, `Alt+Q` restores its live queued messages to the
input without replacing an existing draft; `Alt+S` interrupts current tool work
and sends a non-empty draft. Both shortcuts ignore IME composition, key repeat
and extra modifiers, share the submission lock, and appear below queued message
cards. Recalled text/images and an in-flight recall belong to the Run's draft
store, so changing views neither drops the result nor enables a duplicate recall.
An image-only recalled draft can be sent without requiring replacement text.
Physical key codes preserve Option-key behavior on macOS. Queue ownership
and interruption sequencing belong to the [runtime contract](../architecture/runtime.md#scheduling-and-concurrency).

## Workbench controls

Node task objectives edit inside their existing white card. Copy/Edit become Cancel/Save icons in the same positions, without changing the card dimensions; long drafts scroll inside the editor. Escape cancels and Ctrl/Cmd+Enter saves. [Frontend browser tests](../../scripts/frontend-audit.test.mjs) cover stable geometry, keyboard actions and rejected saves.

Long node headings and overview chips truncate without obscuring adjacent actions, retaining full accessible names. Node headings keep hover titles; overview chips deliberately omit hover tags/tooltips, including native `title` bubbles. Their hover styling, keyboard focus and click-to-open behavior remain enabled. Footer status copy wraps independently of the action group, and node completion exposes a labelled progress bar. Node creation stays in the graph background menu; opening its form on narrow layouts switches back to the conversation pane and focuses the name field without submitting a mutation. [Workbench detail browser tests](../../scripts/workbench-details-ui.test.mjs) cover both languages, narrow layouts and the existing node-creation restrictions.

## Graph viewport

Merger cards follow the top-to-bottom execution flow without widening task rows. Node-composition helpers occupy a compact row centered above their targets; batch publication helpers occupy a row below their recorded producers, ahead of later task rows. Final publication remains below the task graph. Publication edges enter from above and do not create a dependency to later tasks; ordinary and feedback edges bypass intervening helper rows. Historical batch helpers retain their recorded producers after publication clears. Geometry and edge projection live in [useGraphElements.ts](../../src/hooks/useGraphElements.ts), with [projection regressions](../../scripts/graph-elements.test.ts).

Automatic fitting tracks layout until it settles; status and log updates do not recenter the view. Fit View uses visible, measured cards, including Mergers. It fits the whole graph when it fits at minimum zoom or no cards are running; otherwise it keeps minimum zoom and centers a fitting group of running cards. During layout animation, manual fitting follows that focus until the cards settle. See [graphFit.ts](../../src/lib/graphFit.ts), [useGraphViewport.ts](../../src/hooks/useGraphViewport.ts), and the [browser regressions](../../scripts/graph-planning-fit.test.mjs). Planning projection belongs to [Runtime](../architecture/runtime.md#planning-graph-projection).

Opening or switching a Conversation paints the grey conversation surface and topology chrome immediately, independently of transcript loading. Only the scrollable conversation content fades in once ready; the composer remains opaque. The graph pane's entrance animation applies only when it opens later within that Conversation, not on the workbench's first mount.

The graph pane opens and closes through a clipped aperture, keeping the canvas measured at its split width instead of refitting every frame. Drag collapse starts at the dragged width and preserves the saved split. Interrupting an exit reverses the existing canvas; reopening after a completed exit initializes a fresh viewport. Exiting controls are inert, and reduced-motion preferences disable the transition. The persistent Pause/Continue control shares the pane/footer entrance without a separate reveal or replay when its label changes. See [GraphWorkbench.tsx](../../src/components/views/GraphWorkbench.tsx), [useWorkbenchResizer.ts](../../src/hooks/useWorkbenchResizer.ts), and [graph-switching.test.mjs](../../scripts/graph-switching.test.mjs).

## Production loading

The landing page loads the workbench on demand through [AppGraphWorkbench.tsx](../../src/components/views/AppGraphWorkbench.tsx), which also owns the React Flow node and edge implementations. [vite.config.ts](../../vite.config.ts) keeps React separate from graph and Markdown engines without moving their shared CSS out of the initial cascade. While the module loads, the landing composer stays visible but cannot submit a second request; failure offers a page reload without stopping background tasks, and leaving the view invalidates the pending load. [frontend-bundle.test.mjs](../../scripts/frontend-bundle.test.mjs) builds into a temporary directory and checks production chunk boundaries, slow/failed loads, and navigation during loading.

## Modal keyboard behavior

Dialogs share [useDialogFocus](../../src/hooks/useDialogFocus.ts): focus enters the dialog, Tab/Shift+Tab stay inside the topmost modal, and closing restores the triggering control when it still exists. Confirmations initially focus Cancel; the Graph IR editor focuses its draft. Escape closes only the topmost dialog, does not interrupt IME composition, and cannot dismiss a busy save/approval. Exiting dialogs are inert even while their animation remains mounted. Long confirmation details wrap and scroll within the viewport. [Dialog browser tests](../../scripts/dialog-accessibility.test.mjs) cover nested confirmations, busy controls, reduced motion and small windows.

## Large dialogs

Settings and the Graph IR editor share `.modal-backdrop.subtle-backdrop`, `.modal-backdrop-tint`, and `.modal.surface-modal`. Reuse these for large dialogs; the base dark overlay is for small dialogs. The tint is a light veil rather than an expensive full-screen blur, and its `pointer-events: none` lets backdrop clicks close dismissible dialogs.

Reuse `largeDialogMotion` and `dialogVeilMotion` from `src/components/modals/dialogMotion.ts`; reduced motion disables their transitions.

## Home background and icon

The **UI settings** card groups reasoning auto-expansion, **Show execution graph overview**, and the home background under the Wallpaper icon. All three are browser-local preferences in [displayPreferences.ts](../../src/services/displayPreferences.ts), staged in Settings and applied only after a successful Settings save, not Run/backend state. **Show execution graph overview** defaults off; enabling it displays the topology overview and write-back card at the bottom of the Graph Planner conversation. Static dots are the default home background; animated paths are optional. The decorative dots are hidden from assistive technology, follow the responsive title, and extend behind the sidebar without changing workbench clipping.

The home composer stays bottom-anchored while welcome copy uses only the remaining space above it. Its wide-screen right offset is capped by the available gutter; narrow or short free regions use smaller copy, and regions too short for readable text hide it until space returns. Draft growth, resizing and editor expansion must not clip the copy, overlap it with the composer, or discard the draft. The decorative dots remain mounted when copy is hidden. [Home viewport tests](../../scripts/ui-polish.test.mjs) cover both languages, the responsive breakpoint, long drafts, expansion/collapse and keyboard-visible composer controls.

`assets/icon-dots.svg` uses a transparent, color-scheme-aware 4×4 grid with the corners omitted. Keep dots aligned at 16 and 32 px and avoid a background tile. Browsers cache favicons by URL, so bump the `?v=` query in `index.html` when changing it; Vite hashes production assets.

## Initializing another Vite/React project

For a separate project, install TypeScript/React types and `tailwindcss @tailwindcss/vite`. Configure the Vite plugin, import a stylesheet containing `@import "tailwindcss";`, and set the `@/*` alias. Run `npx shadcn@latest init` and choose `src/components/ui` and that stylesheet. Consider omitting Preflight in an already styled app.
