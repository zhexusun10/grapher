# Using Grapher: plan, run, recover

> **Audience:** Users running coding tasks. Start with the [English](../README.md#quick-start) or [Chinese](../README.zh-CN.md#快速开始) README for installation.
> Developers changing these behaviors should use the [architecture contracts](architecture/overview.md#contract-ownership).

**Review the plan. Watch the work. Check the published result.** A finished agent response is not the same as a successfully delivered Graph result.

## Choose the right mode

- **Serial:** one agent works directly in your project. Prefer it for small, linear or tightly coupled changes.
- **Graph:** review a compiled task graph, then run independent nodes. Each small execution batch shares your source directory; larger parallel batches use private workspaces by default. Nodes keep separate conversations. A Graph can have just one node.
- **Auto:** let the Partitioner choose Serial or Graph from your goal.

More agents help only when work can progress independently. Repeatedly splitting edits to the same files can add conflicts instead of useful parallelism.

All five **Settings → Harness settings** options default on; saved opt-outs remain off. **Hide Auto mode** keeps only Serial and Graph in the composer and hides Partitioner configuration without deleting its saved settings. If Auto is selected, it switches to Graph; an explicit Serial or Graph choice stays unchanged. This visibility preference applies only in this browser; turn it off and save to show Auto and Partitioner again.

## Refresh local Pi models

After editing `~/.pi/agent/models.json`, open **Settings → Model & Provider** and click **Refresh**. Grapher reads the latest local definitions for the catalog and for new execution runtimes. A model appears in role selectors only when its Provider is available; authenticate it in Settings if needed. Running sessions retain their current runtime.

For OpenAI Codex OAuth, choose **Browser login (default)** in the sign-in panel below its Provider card, then click **Continue sign-in**. If your browser blocks the authorization page from opening, use the authorization link in that panel. Device-code login is also available. After successful authentication, the supported-provider list automatically collapses after a short confirmation period. Bound credentials start collapsed each time you reopen Settings.

If Grapher also has its own `models.json`, local Pi definitions win on conflicts and Grapher-only models remain. The original Grapher file is retained and backed up as `models.json.grapher-backup`. To remove an old model that only exists in that file, remove it there as well. These files may contain credentials; keep them private. Merged snapshots are normally removed on exit, but a forced termination or crash may leave a `grapher-models-*` directory in the system temporary directory; check it before sharing or cleaning temporary files.

## Customize the home screen

At the bottom of **Settings**, choose the static **Dot pattern** (the default) or **Animated paths**, then save. The choice affects the home screen and is stored in the current browser; it does not change a conversation or backend settings.

## Choose node workspace isolation

**Settings → Harness settings → Isolate parallel node workspaces** applies to new
conversations. When no nodes are running, dispatching up to two ready nodes
shares your source directory; larger groups use independent workspaces. While
source-native nodes run, newly ready work fills free slots without waiting for
unrelated siblings and keeps sharing source, even above two concurrent nodes.
The overview's **batches** (when **Settings → UI settings → Show execution graph overview** is enabled; off by default) describe the graph topology, not dispatch groups:
ready nodes in earlier batches get priority, but a batch is not a barrier for
unrelated ready work. Private workspaces still drain and hand off the dispatched
results before another group starts—even if the concurrency cap left peers in
the same batch waiting. Those peers remain queued; then a smaller group can
return to source. Planner review follows the same rule.
A failed handoff blocks dispatch for repair/retry rather than losing files or
claiming completion. Manually
resolved private inputs are delivered before a retry moves to source; successful
managed result runs also deliver their new files before another result launch.

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
- Bind an actual project directory, not your desktop. Keep large datasets and external resources outside the workspace; project bindings over 10 GB are rejected.
- Use trusted projects, extensions and tools. Private workspaces are not credential vaults. **Windows has no per-node filesystem sandbox**; macOS/Linux have private-execution access restrictions, but these are not a general malicious-code guarantee.

Start with a disposable project and keep an independent backup of important work. Detailed access limits are in [Filesystem isolation](architecture/filesystem-isolation.md#platform-boundaries).

## Follow and steer the work

For Graph with **Auto Approve** off, inspect tasks and dependencies, then choose **Approve**; otherwise execution starts automatically. Independent ready nodes can run in parallel. Failure in one branch need not stop unrelated branches.

| What you want | Action and effect |
| --- | --- |
| Guide a running task | Send an instruction to that node's live conversation. |
| Add work to a completed node | Send a follow-up; it starts another execution using that node's own conversation. After publication, it edits the source directly. |
| Change the overall plan | Send a Graph follow-up without selecting a node; the Planner revises the graph. |
| Add a Graph node yourself | Right-click empty graph space and choose **New node**. Enter a name and task, optionally connecting a predecessor (`from`) and target (`to`), with feedback on the outgoing edge if needed. Saving validates the graph. Connecting to completed work requires confirmation and may rerun downstream results; feedback triggers rework only if applied. Pause or wait for affected running nodes first. An approved, unpaused Run starts new work when ready; a paused Run waits for **Continue**. |
| Copy a conversation's original prompt | Right-click it in the sidebar and choose **Copy prompt**; saved conversations use the backend's original goal. |
| Find running Graph work | Use the topology's **Fit View** button. If the whole graph cannot fit at the minimum zoom, it centers running cards where possible; otherwise it fits the whole graph. |
| Collapse or reopen the Graph | Drag the divider past the graph's minimum width to collapse it; use the edge arrow to reopen it at the previous width. You can also focus the divider and press Enter. |
| Pause Graph node work | Use the topology's **Pause**; it interrupts active node processes and stops new dispatches for that Run. Pause/Continue is disabled while the Planner is working; use the Planner conversation's **Stop** for that turn. Wait for node pausing to finish before **Continue**. Continuing user-paused work does not count as another attempt. Other Runs are unaffected. |
| Stop just one conversation | Use that node conversation's **Stop** to interrupt only that node. The Planner conversation's **Stop** cancels only its current Planner turn and leaves running node agents untouched. A run-wide Stop/cancel also cancels planning. |
| Inspect a changed file | Open the file-change list and click a row. The file opens in your system default application from its execution workspace, Planner workspace or the source repository. Deleted files remain listed but are not clickable. |

On macOS, the backend keeps the display and system awake while it runs and refreshes user activity so the idle screen saver cannot lock the session during a long task. This does not override a manual lock or closing the lid. Set `GRAPHER_KEEP_AWAKE=0` to allow normal sleep and locking.

A completed Serial agent and any server it started stay running for follow-ups. Deleting the Run or workspace, stopping the backend, editing history, or resuming with different model/thinking settings stops them; the saved conversation remains available. Planner and Graph node agents are reclaimed after their turns. See [Process lifecycle](architecture/filesystem-isolation.md#parked-serial-shells).

### Steers and attachments

Accepted text clears from the input; a rejected send keeps the draft. Planner steers appear in a separate pending area and join the conversation when taken, usually after the current tool-call batch; they do not interrupt tools. A steer proven unaccepted returns to the input. A recorded steer keeps its pending place even if queued, taken, failed or uncertain. Inspect the conversation before retrying an uncertain steer: Grapher will not resend it automatically. Tool cards distinguish calls being generated from calls running.

After a node reads a steer, you can edit it, even after reload; this branches the conversation without creating a new task goal. Earlier replies and tool records stay visible, and earlier steers remain editable even when repeated. Pause the node to return an unread text steer to the composer. If loaded history cannot prove consumption, the steer stays in place rather than being resent.

Switching conversations does not stop Runs. Unsent text survives switches only in browser memory, not reload; unsent attachments are not retained. Selecting or removing an attachment does not change project files. Sending uses a unique path without overwriting existing files. For a completed node, the attachment is staged for its follow-up without changing the completed snapshot. If the workspace is unavailable or the backend lacks safe upload support, the draft and attachment remain for retry.

### Planner follow-ups and review

Shared-source Planner follow-ups stay in your project and have no workspace-switch tool. With private execution, follow-ups may use a current node workspace alongside its active writer, not a merged view of parallel branches. Check **Planning session details** for the directory used. If the newest workspace is still preparing, the Planner uses the source project, never that partial workspace.

Review nodes can send bounded feedback to their graph-defined target. The target continues its own conversation with explicit instructions and completed file state; agent chat histories are not passed between nodes. An exhausted feedback budget means the requested rework was **not applied**, not that the review passed.

## Recover without starting over

After fixing the cause, use the play button in an empty Node, Serial Agent or Planner composer when available to continue that agent without adding a message. Graph also has a run-wide **Continue** in the topology. If a multi-node Graph is globally paused, use the run-wide control; individual node continuation does not bypass that pause. Planner continuation requires its saved session and draft; if either is unavailable or the graph has since changed, Grapher reports the problem instead of silently starting over.

| Situation | What to do |
| --- | --- |
| App/process interruption or an explicit pause | Inspect the retained output, then use **Continue** when offered. Startup does not silently resume model calls. |
| Provider credentials expired | Re-authenticate in Settings, then use **Continue** for the affected conversation. |
| Provider connection failure (`Connection error.`, connection reset/refused) | Check your network or proxy if it persists, then use **Continue** for the affected conversation. It resumes the unfinished turn in the same session. |
| Other task/provider failure, including an unrecognized error | Inspect and fix the cause, then use **Continue** to retry the failed tasks. You can also intervene on a node or change its Node Agent model/thinking settings first. |
| Conflict while combining parent results | Merger checks its resolution with Git; if backend validation finds a remaining issue, it automatically receives bounded repair follow-ups in the same conversation. If repair still fails, inspect that conversation and retained workspace, then retry the node; publication retry does not fix this conflict. |
| Final publication failed | Inspect the publication panel and any publication Merger, then retry publication. A “Source files changed” error is not proof of a manual edit: interrupted older versions can leave partial files. Preserve those files and use the documented [offline reconciliation](development/conversation-logs.md#reconcile-a-legacy-partial-publication-file) if normal retry refuses them. It reuses retained results rather than rerunning the graph. A changed branch is not silently written; interrupted-checkout recovery may require restoring the captured branch. Staged changes in excluded environment/runtime scopes stay staged and are not published; commit or unstage them explicitly. |

Changing the Node Agent model or reasoning level in a conversation applies to all its future node attempts, including retries, feedback repairs, rerun descendants and follow-ups to completed nodes. A running attempt keeps its current model and is not restarted; its recorded model remains in the history. Session details show a retry selection separately from the previous model. Other conversations keep their own settings, and environment overrides take precedence. After saving, reopening Settings shows that conversation's saved selection. Saving from the home screen instead changes the defaults for new conversations.

In Graph, Continue resumes paused or queued work first; after it settles, Continue again retries failed nodes without rerunning completed branches. Explicitly paused private nodes continue in their original workspaces and conversations without writing unfinished files to source just to resume them. Stopping only one node lets other branches finish and publish; that node still continues from its retained inputs. Retained workspaces preserve partial work; missing or changed recovery evidence may require explicit repair. Editing an old message branches history: Serial does **not** rewind project files, while private Graph workspaces retain Git rollback semantics. Shared-source Graphs do not rewind project files.

## Know when the result is delivered

**Private Graph results require successful publication to your project.** Green task cards or a model's final answer alone are not delivery evidence. Shared-source Graphs already edit your project directly and finish without a separate publication step.

Publication combines terminal results with source changes privately and writes files only: no commit, branch/HEAD advance or staging-area change. Graph workspaces do not expose internal Git history. A private Merger handles Git conflicts; failed composition leaves the source untouched and can be retried. Repository and permission errors remain failures. Ordinary folders use external Git metadata; Grapher does not add `.git`.

**Post-task Planner review** defaults on for new Graph Runs. After publication or shared-source completion, the Planner can inspect, report, wrap up or propose more work. With **Auto Approve**, further work and model calls can run without another click; publication still writes files without commits. Set review before creating the Run; Auto Approve applies live, including to a waiting or planning Graph. Interrupted reviews are not silently repeated.

Native environment support is **experimental**. There is no user environment-mode selector; tasks use native tools and backend-verified bindings when available. Reuse is best-effort, not a promise of portable environments. Managed environments are not copied into source. Published result descriptors and launch/retry/cancel controls are not exposed in the interface; they remain available only through the local API.

## Data and removal

Runtime data defaults to `.grapher/`; execution workspaces and the shared engine cache normally live in the OS cache. Successful publication can reclaim workspaces while keeping conversation history for follow-ups.

Removing a workspace in the UI deletes its conversations through the backend, including ones not loaded in that browser. Active conversations prevent removal; cleanup failures are retained for retry. Source projects and shared engine caches are not workspace-removal targets.

For exact paths and configuration variables, see [Storage and cleanup](architecture/storage.md). For implementation details, use the [developer documentation index](index.md#task-routes).
