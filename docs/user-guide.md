# Using Grapher: plan, run, recover

> **Audience:** Users running coding tasks. Start with the [English](../README.md#quick-start) or [Chinese](../README.zh-CN.md#快速开始) README for installation.
> Developers changing these behaviors should use the [architecture contracts](architecture/overview.md#contract-ownership).

**Review the plan. Watch the work. Check the published result.** A finished agent response is not the same as a successfully delivered Graph result.

## Choose the right mode

- **Serial:** one agent works directly in your project. Prefer it for small, linear or tightly coupled changes.
- **Graph:** review a compiled task graph, then run independent nodes. Each small execution batch shares your source directory; larger parallel batches use private workspaces by default. Nodes keep separate conversations. A Graph can have just one node.
- **Auto:** let the Partitioner choose Serial or Graph from your goal.

More agents help only when work can progress independently. Repeatedly splitting edits to the same files can add conflicts instead of useful parallelism.

In **Settings → Harness settings**, **Enable Feedback** defaults off; the other toggles default on. Saved choices are preserved. In **Settings → UI settings**, **Hide Auto mode** defaults on, keeps only Serial and Graph in the composer, and hides Partitioner configuration without deleting its saved settings. If Auto is selected, it switches to Graph; an explicit Serial or Graph choice stays unchanged. This visibility preference applies only in this browser; turn it off and save to show Auto and Partitioner again.

## Refresh local Pi models

After editing `~/.pi/agent/models.json`, open **Settings → Model & Provider** and click **Refresh**. Grapher reads the latest local definitions for the catalog and for new execution runtimes. A model appears in role selectors only when its Provider is available; authenticate it in Settings if needed. Running sessions retain their current runtime.

For OpenAI Codex OAuth, choose **Browser login (default)** in the sign-in panel below its Provider card, then click **Continue sign-in**. If your browser blocks the authorization page from opening, use the authorization link in that panel. Device-code login is also available. After successful authentication, the supported-provider list automatically collapses after a short confirmation period. Bound credentials start collapsed each time you reopen Settings.

If Grapher also has its own `models.json`, local Pi definitions win on conflicts and Grapher-only models remain. The original Grapher file is retained and backed up as `models.json.grapher-backup`. To remove an old model that only exists in that file, remove it there as well. These files may contain credentials; keep them private. Merged snapshots are normally removed on exit, but a forced termination or crash may leave a `grapher-models-*` directory in the system temporary directory; check it before sharing or cleaning temporary files.

## Customize the home screen

At the bottom of **Settings**, choose the static **Dot pattern** (the default) or **Animated paths**, then save. The choice affects the home screen and is stored in the current browser; it does not change a conversation or backend settings.

## Choose node workspace isolation

**Settings → Harness settings → Isolate parallel node workspaces** applies to new
conversations. When no nodes are running, dispatching up to three ready nodes
shares your source directory; larger groups use independent workspaces. While
source-native nodes run, newly ready work fills free slots without waiting for
unrelated siblings and keeps sharing source, even above three concurrent nodes.
The overview's **batches** (when **Settings → UI settings → Show execution graph overview** is enabled; off by default) describe topology layers. A private batch
keeps all its peers together for delivery: the concurrency cap limits execution,
not which results are written back. Free slots can run remaining peers and
independent retries, but failures or pauses hold the batch's delivery. Once the
whole batch succeeds and is delivered, the next group's workspace mode is chosen
again. Shared-source execution still follows dependencies without this delivery
barrier. Planner review follows the same workspace-selection rule.
A failed handoff blocks dispatch for repair/retry rather than losing files or
claiming completion. Manually resolved private inputs stay private until their
node task succeeds; successful managed result runs also deliver their new files
before another result launch.

Turn the option off to always share source, reducing environment setup and merge
cost and making intermediate files visible immediately. Shared agents have no
per-node filesystem isolation: concurrent edits can overwrite each other, failed
work remains in source, and there is no automatic file rollback. Your external
file edits before or during a source-native node's execution are accepted as live
changes, not treated as workspace-integrity failures. Keep backups and avoid
assigning overlapping edits. Each node still has its own conversation.

## Before you approve

**Approval starts execution; it is not a “no changes yet” checkpoint.** **Auto Approve** defaults on. To inspect each Graph before execution, turn it off in **Settings → Harness settings** and save before submitting your goal.

- Initial Planner commands run in your source project and can change files before approval. Rejecting a plan, stopping it or encountering a failure does **not** roll those writes back.
- Git snapshots collect project files even when `.gitignore` matches them. Graph snapshots/history stay private and leave your branch and staging area unchanged. Final publication writes files only and creates no commit. Runtime internals and managed environment scopes are excluded; `.gitignore` is not a secret or artifact filter.
- Bind an actual project directory, not your desktop. Keep large datasets and external resources outside the workspace; new project bindings and Runs over 15 GB are rejected. If an existing Run grows beyond the limit, it continues normally; the size warning appears after active Runs in that workspace finish.
- Use trusted projects, extensions and tools. Private workspaces are not credential vaults. **Windows has no per-node filesystem sandbox**; macOS/Linux have private-execution access restrictions, but these are not a general malicious-code guarantee.

Start with a disposable project and keep an independent backup of important work. Detailed access limits are in [Filesystem isolation](architecture/filesystem-isolation.md#platform-boundaries).

## Follow and steer the work

For Graph with **Auto Approve** off, inspect tasks and dependencies, then choose **Approve**; otherwise execution starts automatically. Independent ready nodes can run in parallel. Failure in one branch need not stop unrelated branches.

| What you want | Action and effect |
| --- | --- |
| Guide a running task | Send an instruction to that node's live conversation. |
| Add input to a node that has not started or is waiting after feedback | Send a message to queue it. It accompanies the task/feedback turn when dependencies and scheduling allow; it does not start the node early or resume a paused Run. |
| Add work to a completed node | Send a follow-up; it starts another execution using that node's own conversation. After publication, it edits the source directly. |
| Change the overall plan | Send a Graph follow-up without selecting a node; the Planner revises the graph. |
| Add a Graph node yourself | Right-click empty graph space and choose **New node**. Enter an `id` and task, optionally connecting a predecessor (`from`) and target (`to`), with feedback on the outgoing edge if enabled in Settings and needed. Saving validates the graph. Connecting to completed work requires confirmation and may rerun downstream results; feedback triggers rework only if applied. Pause or wait for affected running nodes first. An approved, unpaused Run starts new work when ready; a paused Run waits for **Continue**. |
| Copy a conversation's original prompt | Right-click it in the sidebar and choose **Copy prompt**; saved conversations use the backend's original goal. |
| Find running Graph work | Use the topology's **Fit View** button. If the whole graph cannot fit at the minimum zoom, it centers running cards where possible; otherwise it fits the whole graph. |
| Collapse or reopen the Graph | Drag the divider past the graph's minimum width to collapse it; use the edge arrow to reopen it at the previous width. You can also focus the divider and press Enter. |
| Pause Graph node work | Use the topology's **Pause**; it interrupts active node processes and stops new dispatches for that Run. Pause/Continue is disabled while the Planner is working; use the Planner conversation's **Stop** for that turn. Wait for node pausing to finish before **Continue**. Continuing user-paused work does not count as another attempt. Other Runs are unaffected. |
| Stop just one conversation | Use that node conversation's **Stop** to interrupt only that node. The Planner conversation's **Stop** cancels only its current Planner turn and leaves running node agents untouched. A run-wide Stop/cancel also cancels planning. |
| Inspect a changed file | Open the file-change list and click a row. The file opens in your system default application from its execution workspace, Planner workspace or the source repository. Deleted files remain listed but are not clickable. |
| Read older execution records | The newest output loads first. Earlier failed or stopped attempts start collapsed; expand their headers to load them. Successful earlier turns stay expanded and load when reached or through **Load history**. Your expand/collapse choices survive new attempts. A slow or failed older read does not hide newer replies; retry is local to that record. |

On macOS, the backend keeps the display and system awake while it runs and refreshes user activity so the idle screen saver cannot lock the session during a long task. This does not override a manual lock or closing the lid. Set `GRAPHER_KEEP_AWAKE=0` to allow normal sleep and locking.

A completed Serial agent and any server it started stay running for follow-ups. Editing its history or resuming with different model/thinking settings stops that shell and its services. A successful Planner turn in the source project can also leave background services running, while its Planner worker exits; later planning uses a separate worker. Deleting the Run or workspace, resetting the workspace, clearing history, or stopping the backend stops both retained Serial shells and Planner services. Private Planner and Graph node agents are reclaimed after their turns. See [Process lifecycle](architecture/filesystem-isolation.md#parked-serial-shells-and-held-planner-services).

### Steers and attachments

Accepted text clears from the input; a rejected send keeps the draft. Planner steers appear in a separate pending area and join the conversation when taken, usually after the current tool-call batch; they do not interrupt tools. A steer proven unaccepted returns to the input. A recorded steer keeps its pending place even if queued, taken, failed or uncertain. Inspect the conversation before retrying an uncertain steer: Grapher will not resend it automatically. Tool cards distinguish calls being generated from calls running.

With the message input focused, **Alt + Q** withdraws unread messages from the current agent's live queue and returns them to the input, keeping any existing draft. **Alt + S** interrupts its current tool execution and immediately sends your draft; an empty input does nothing. Already-read messages are not withdrawn, and other agents keep running.

After a node reads a steer, you can edit it, even after reload; this branches the conversation without creating a new task goal. Earlier replies and tool records stay visible, and earlier steers remain editable even when repeated. Pause the node to return an unread text steer to the composer. If loaded history cannot prove consumption, the steer stays in place rather than being resent.

Switching conversations does not stop Runs. Unsent text survives switches only in browser memory, not reload; unsent attachments are not retained. Selecting or removing an attachment does not change project files. Sending uses a unique path without overwriting existing files. For a completed node, the attachment is staged for its follow-up without changing the completed snapshot. If the workspace is unavailable or the backend lacks safe upload support, the draft and attachment remain for retry.

Replies can display web images and workspace-relative screenshots inline. Local previews support PNG, JPEG, GIF, WebP and BMP up to 20 MiB and read the conversation's current workspace (or published source file), not a saved historical image. Missing, deleted or unsupported files show an image-unavailable label; SVG and paths outside the workspace are not previewed.

### Planner follow-ups and review

The Planner edits its candidate graph with `edit_graph`, combining related node and edge changes in one batch. Only the final graph is validated; a rejected batch changes nothing, while earlier successful calls remain. It can inspect the latest candidate with `read_graph`, including earlier successful edits but not rejected ones. This candidate is separate from the graph already approved for execution; inspecting it does not change either graph.

Shared-source Planner follow-ups stay in your project and have no workspace-switch tool. With private execution, follow-ups may use a current node workspace alongside its active writer, not a merged view of parallel branches. Check **Planning session details** for the directory used. If the newest workspace is still preparing, the Planner uses the source project, never that partial workspace.

Feedback is optional and **off by default**. Enable **Settings → Harness → Enable Feedback** to let subsequent Planner turns or manual node additions create feedback routes; the feedback budget becomes editable when enabled. Turning it off removes the Planner's feedback option and prevents adding feedback routes through graph editing, including Graph JSON. Existing sessions keep their feedback edges visible because those routes, execution and queued feedback are preserved, not cancelled. Sessions without Feedback omit the edge-type legend; old sessions with retained routes keep their edges and legend.

When enabled, review nodes can send bounded feedback to their graph-defined target. The target continues its own conversation with explicit instructions and completed file state. Reviewers and other affected nodes retain their own conversations too: after their dependencies update, they receive a new message and recheck their tasks against current files instead of starting over. Old results still need fresh verification; agent chat histories are never passed between nodes. An exhausted feedback budget means the requested rework was **not applied**, not that the review passed.

Separate continuation notices are provided for feedback senders and other affected nodes. If a custom [notice template](architecture/runtime.md#feedback-continuation-notices) is empty or unreadable, history and pending work remain intact; fix the template before Continue. No placeholder message is sent.

## Recover without starting over

After fixing the cause, use the play button in an empty Node, Serial Agent or Planner composer when available to continue that agent without adding a message. Graph also has a run-wide **Continue** in the topology. If a multi-node Graph is globally paused, use the run-wide control; individual node continuation does not bypass that pause. Planner continuation requires its saved session and draft; if either is unavailable or the graph has since changed, Grapher reports the problem instead of silently starting over.

| Situation | What to do |
| --- | --- |
| App/process interruption or an explicit pause | Inspect the retained output, then use **Continue** when offered. Startup does not silently resume model calls. |
| Provider credentials expired | Re-authenticate in Settings, then use **Continue** for the affected conversation. |
| Provider connection failure (`Connection error.`, connection reset/refused) | Check your network or proxy if it persists, then use **Continue** for the affected conversation. It resumes the unfinished turn in the same session. |
| Other task/provider failure, including an unrecognized error | Inspect and fix the cause, then use **Continue** to retry the failed tasks. You can also intervene on a node or change its Node Agent model/thinking settings first. |
| Conflict while combining parent results | Merger checks its resolution with Git; if backend validation finds a remaining issue, it automatically receives bounded repair follow-ups in the same conversation. If repair still fails, inspect that conversation and retained workspace, then retry the node; publication retry does not fix this conflict. |
| Final publication failed | Inspect the publication panel and any publication Merger, then retry publication. A “Source files changed” error names any mismatching paths and fails closed rather than overwriting unverified edits; inspect and reconcile those files manually before retrying. Retry reuses retained results rather than rerunning the graph. A changed branch is not silently written; interrupted-checkout recovery may require restoring the captured branch. Staged changes in excluded environment/runtime scopes stay staged and are not published; commit or unstage them explicitly. |

Changing the conversation's Node Agent model or reasoning level applies to its future node attempts, including retries, feedback repairs, rerun descendants and follow-ups to completed nodes, except nodes with an explicit individual selection. Newly dispatched Merger work follows the same selection, including publication retries after restart, unless an explicit Merger environment override is set. A running attempt keeps its current model and is not restarted; its recorded model remains in the history. Session details show a retry selection separately from the previous model. Other conversations keep their own settings, and environment overrides take precedence. After saving, reopening Settings shows that conversation's saved selection. Model commands in the home composer apply only to the conversation you are preparing. Settings opened outside a conversation instead saves defaults for new conversations.

### Pi slash commands

Type `/model` or `/thinking` to open suggestions, or enter `/model provider/model` or `/thinking high` directly. In the Graph home input this changes Planner; in Serial it changes Node Agent. In a node input it changes only that node, leaving other nodes unchanged. Settings always edits the whole conversation's role profiles, even while viewing an individual node; node commands remain node-specific. Changes take effect on subsequent calls, without restarting a running call. Changing the conversation's Node Agent defaults also updates roles configured to inherit those defaults; explicitly selected role models stay unchanged.

Use `/scoped-models` (or `/scoped model`) to hide models globally from all model pickers, including Settings. The same manager is at the bottom of the Settings model card. Save in that manager applies across conversations and workspaces and survives restart; it does not change any existing model assignment. Use it again to restore hidden models.

Use `/name` in the main conversation input to rename the sidebar conversation card (node agent dialogs cannot use `/name`). Enabled extensions' registered commands are available before starting a conversation and after its Pi process ends, including their select/confirm/input/editor dialogs. They load for the currently selected project, so project extensions and `.pi/mcp.json` overrides follow project changes. `/mcp` shows MCP status; `/mcp login`, `/mcp logout` and `/mcp reconnect` accept an optional server name when MCP is enabled. A matching active Pi process handles its own commands; otherwise a temporary command context runs them without creating a conversation or calling a model. Changing projects, conversations or nodes, or leaving the composer, cancels pending dialogs. During an active Pi session you can also use `/compact`, `/session` (or `/stats`) and `/copy` to operate on its history. `/compact` waits for the current response to finish rather than interrupting your task. Only one Pi command can run in an active process at a time. Ordinary extension hook errors remain visible in conversation history. Commands that require real conversation history still need an active session, and terminal-only custom screens retain their compatibility warning. Skills remain available through `/skill:...`. Bare `/quit`, `/new`, `/tree` and other Pi session-management commands are intentionally unavailable; use Grapher's conversation controls instead. Other text starting with `/` (such as file paths, routes, or unregistered names) is sent as a normal prompt.

The `/` menu shows loading and retry controls while discovering enabled extension commands; use its refresh button after changes made outside Grapher. Updating extension selections in Settings refreshes the available commands. Commands come from the current active Agent, or the selected project's standalone context when no Agent is active. Selection dialogs support keyboard navigation and filter long lists. Escape cancels; Enter submits a text input, Shift+Enter inserts a newline, and Ctrl/Cmd+Enter submits an editor. IME composition keeps its normal confirmation behavior.

In Graph, Continue resumes paused or queued work first; after it settles, Continue again retries failed nodes without rerunning completed branches. Failed or paused private nodes continue in their original workspaces and conversations without writing unfinished files to source just to resume them. One failed member holds delivery of the entire private topology batch: successful siblings stay private without rerunning, and the batch writes back together only after every member succeeds. The concurrency limit splits execution, not delivery; the overview shows the whole private batch's completion count. An independent private node can retry while its siblings keep working, subject to available worker slots and workspace ownership. This also survives restart; acknowledging a repaired conflict does not count as task completion. Unrelated plan edits do not release a partially finished batch. If a required parent failed in shared source, it can retry in its original directory after private writers stop, without first publishing their results; its unstarted consumers then receive the recovered source files. Stopping one private node lets already-running siblings finish, but does not automatically write their results back while you decide how to continue. Sending a new instruction keeps the stopped node in its original workspace. If another write-back has already started, an unfinished node with a separate retained workspace can continue working when its files are not inputs to that write-back; shared source and overlapping inputs still wait. Retained workspaces preserve partial work; missing or changed recovery evidence may require explicit repair. Editing an old message branches history: Serial does **not** rewind project files, while private Graph workspaces retain Git rollback semantics. Shared-source Graphs do not rewind project files.

## Know when the result is delivered

**Private Graph results require successful publication to your project.** Green task cards or a model's final answer alone are not delivery evidence. Shared-source Graphs already edit your project directly and finish without a separate publication step.

Publication combines terminal results with source changes privately and writes files only: no commit, branch/HEAD advance or staging-area change. Graph workspaces do not expose internal Git history. A private Merger handles Git conflicts; failed composition leaves the source untouched and can be retried. Repository and permission errors remain failures. Ordinary folders use external Git metadata; Grapher does not add `.git`.

**Post-task Planner review** defaults on for new Graph Runs. After publication or shared-source completion, the Planner can inspect, report, wrap up or propose more work. With **Auto Approve**, further work and model calls can run without another click; publication still writes files without commits. Set review before creating the Run; Auto Approve applies live, including to a waiting or planning Graph. Interrupted reviews are not silently repeated.

Native environment support is **experimental**. There is no user environment-mode selector; tasks use native tools and backend-verified bindings when available. Reuse is best-effort, not a promise of portable environments. New private automatic launches retain ordinary host business settings and rebind project-local tool paths to the selected workspace. Node options and module paths apply to business commands, not Grapher's engine. Private HOME/cache bindings remain separate; tools relying only on host-HOME configuration still need explicit setup. See the [native launch contract](architecture/native-environments.md#admission-and-configuration). Inherited variable values are not stored in environment descriptors. Project-local installed dependencies and runnable artifacts are retained in new snapshots, including ignored `node_modules`, `.next` and standalone Python bytecode; larger dependency trees therefore increase snapshot cost. Copied venv activation scripts are still not portable. Observed calls that select a source-bound environment tool from a private workspace are refused with a recreation diagnostic, including after the local copy is removed; use the project's documented setup at the current path. Managed environments are not copied into source. New snapshots can restore recorded project and private-state environment scopes at their original layout, including inactive prefixes. Older records may lack that evidence; caches, external link targets and host state are not reconstructed. See [recovery coverage](architecture/native-environments.md#current-state-historical-evidence-and-ownership). Published result descriptors and launch/retry/cancel controls are not exposed in the interface; they remain available only through the local API.

## Desktop app, updates & data migration

The Tauri v2 desktop app (macOS `.dmg` for Apple Silicon and Intel; Windows x64 NSIS `.exe`) bundles the compiled Rust backend, verified pinned Pi/engine runtime, and a private Node.js `22.19.0` binary. You can move `Grapher.app` anywhere (such as `/Applications`) without keeping a source checkout or global Node.js installation.

- **Git provisioning:** Grapher uses your host `git` executable when available. If no working host Git is found on first launch—or if macOS `/usr/bin/git` is an uninstalled Xcode Command Line Tools shim—the desktop app automatically downloads and SHA-256-verifies a portable Git runtime in the background (`dugite-native` on macOS, `PortableGit` with Git Bash on Windows) with no restart required. If offline or download fails, Grapher opens cleanly with **Retry download**, manual installation instructions, and **Re-check** controls.
- **Desktop data directory & preserve-first legacy migration:** Because `.app` and installer directories are read-only or replaced on upgrade, the desktop app stores persistent runtime data in your OS application data directory (`~/Library/Application Support/io.github.zhexusun10.grapher/data` on macOS; `%APPDATA%\io.github.zhexusun10.grapher\data` on Windows). On first launch only—when that `data` directory does not yet exist—Grapher checks for an eligible legacy `.grapher` store (or an explicit `GRAPHER_LEGACY_DATA_DIR` path), acquires its exclusive `runtime.lock` so a running legacy instance cannot write mid-copy, copies files atomically via a temporary staging directory, and **leaves the legacy source store completely intact**. If the desktop `data` directory already exists, migration is skipped.
- **Shared provider logins & caches:** Provider credentials continue using `~/.grapher/pi-agent` (`PI_CODING_AGENT_DIR`), so existing logins carry over without duplicating secrets. Disposable workspaces and engine caches continue using your OS cache directory.
- **Launch at login:** Open **Settings → Desktop settings → Launch at login** in the desktop app to start Grapher automatically when you sign in to your user account (per-user LaunchAgent on macOS; per-user `HKCU\...\Run` on Windows, never an elevated system service). Changes apply immediately and reflect the actual OS registration.
- **Software updates:** Open **Settings → Software Update** to check for updates. Signed releases verify minisign signatures before downloading and restarting. Unsigned local or CI builds start normally, remain quiet on startup, and link directly to GitHub Releases.
- **Clean shutdown:** Closing the desktop app signals the local backend over stdin EOF to pause active runs cleanly, stop all child Node/Pi processes, and release `runtime.lock`.

## Data and removal

In browser/archive mode (`npm run dev`, `npm start`, `./start.sh`, `start.bat`), runtime data defaults to `.grapher/` (override with `GRAPHER_DATA_DIR`). In the desktop app, runtime data defaults to the OS application data directory described above. Execution workspaces and the shared engine cache normally live in the OS cache. Successful publication can reclaim workspaces while keeping conversation history for follow-ups.

Removing a workspace in the UI deletes its conversations through the backend, including ones not loaded in that browser. Active conversations prevent removal; cleanup failures are retained for retry. Source projects and shared engine caches are not workspace-removal targets.

For exact paths and configuration variables, see [Storage and cleanup](architecture/storage.md). For building, signing, and releasing desktop installers, see [Desktop Releases & Secrets](development/desktop-releases.md). For implementation details, use the [developer documentation index](index.md#task-routes).
