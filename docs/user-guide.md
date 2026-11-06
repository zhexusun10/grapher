# Using Grapher: plan, run, recover

> **Audience:** Users running coding tasks. Start with the [English](../README.md#quick-start) or [Chinese](../README.zh-CN.md#快速开始) README for installation.
> Developers changing these behaviors should use the [architecture contracts](architecture/overview.md#contract-ownership).

**Review the plan. Watch the work. Check the published result.** A finished agent response is not the same as a successfully delivered Graph result.

## Choose the right mode

- **Serial:** one agent works directly in your project. Prefer it for small, linear or tightly coupled changes.
- **Graph:** review a compiled task graph, then run independent branches in private workspaces. Dependencies carry completed project-file state, not other agents' conversations. A Graph can have just one node.
- **Auto:** let the Partitioner choose Serial or Graph from your goal.

More agents help only when work can progress independently. Repeatedly splitting edits to the same files can add conflicts instead of useful parallelism.

## Customize the home screen

At the bottom of **Settings**, choose the static **Dot pattern** (the default) or **Animated paths**, then save. The choice affects the home screen and is stored in the current browser; it does not change a conversation or backend settings.

## Before you approve

**Approval starts execution; it is not a “no changes yet” checkpoint.**

- Initial Planner commands run in your source project and can change files before approval. Rejecting a plan, stopping it or encountering a failure does **not** roll those writes back.
- Git snapshots collect project files even when `.gitignore` matches them. Graph snapshots/history stay private and leave your branch and staging area unchanged. Final publication writes files only and creates no commit. Runtime internals and managed environment scopes are excluded; `.gitignore` is not a secret or artifact filter.
- Bind an actual project directory, not your desktop. Keep large datasets and external resources outside the workspace; project bindings over 10 GB are rejected.
- Use trusted projects, extensions and tools. Private workspaces are not credential vaults. **Windows has no per-node filesystem sandbox**; macOS/Linux have private-execution access restrictions, but these are not a general malicious-code guarantee.

Start with a disposable project and keep an independent backup of important work. Detailed access limits are in [Filesystem isolation](architecture/filesystem-isolation.md#platform-boundaries).

## Follow and steer the work

For Graph, inspect tasks and dependencies, then choose **Approve**. Independent ready nodes can run in parallel. Failure in one branch need not stop unrelated branches.

| What you want | Action and effect |
| --- | --- |
| Guide a running task | Send an instruction to that node's live conversation. |
| Add work to a completed node | Send a follow-up; it starts another execution using that node's own conversation. After publication, it edits the source directly. |
| Change the overall plan | Send a Graph follow-up without selecting a node; the Planner revises the graph. |
| Add a Graph node yourself | Right-click empty graph space and choose **New node**. Enter a name and task, optionally connecting a predecessor (`from`) and target (`to`), with feedback on the outgoing edge if needed. Saving validates the graph. Connecting to completed work requires confirmation and may rerun downstream results; feedback triggers rework only if applied. Pause or wait for affected running nodes first. An approved, unpaused Run starts new work when ready; a paused Run waits for **Continue**. |
| Copy a conversation's original prompt | Right-click it in the sidebar and choose **Copy prompt**; saved conversations use the backend's original goal. |
| Find running Graph work | Use the topology's **Fit View** button. If the whole graph cannot fit at the minimum zoom, it centers running cards where possible; otherwise it fits the whole graph. |
| Collapse or reopen the Graph | Drag the divider past the graph's minimum width to collapse it; use the edge arrow to reopen it at the previous width. You can also focus the divider and press Enter. |
| Pause Graph node work | Use the topology's **Pause**; it interrupts active node processes and stops new dispatches for that Run. Wait for pausing to finish before **Continue**. It does not stop the Planner or other Runs. |
| Stop just one conversation | Use that node conversation's **Stop** to interrupt only that node. The Planner conversation's **Stop** cancels only its current Planner turn and leaves running node agents untouched. A run-wide Stop/cancel also cancels planning. |
| Inspect a changed file | Open the file-change list and click a row. The file opens in your system default application from its execution workspace, Planner workspace or the source repository. Deleted files remain listed but are not clickable. |

On macOS, the backend keeps the display and system awake while it runs and refreshes user activity so the idle screen saver cannot lock the session during a long task. This does not override a manual lock or closing the lid. Set `GRAPHER_KEEP_AWAKE=0` to allow normal sleep and locking.

A completed Serial agent and any server it started stay running for follow-ups. Deleting the Run or workspace, stopping the backend, editing history, or resuming with different model/thinking settings stops them; the saved conversation remains available. Planner and Graph node agents are reclaimed after their turns. See [Process lifecycle](architecture/filesystem-isolation.md#parked-serial-shells).

### Steers and attachments

Accepted text clears from the input; a rejected send keeps the draft. Planner steers appear in a separate pending area and join the conversation when taken, usually after the current tool-call batch; they do not interrupt tools. A steer proven unaccepted returns to the input. A recorded steer keeps its pending place even if queued, taken, failed or uncertain. Inspect the conversation before retrying an uncertain steer: Grapher will not resend it automatically. Tool cards distinguish calls being generated from calls running.

After a node reads a steer, you can edit it, even after reload; this branches the conversation without creating a new task goal. Earlier replies and tool records stay visible, and earlier steers remain editable even when repeated. Pause the node to return an unread text steer to the composer. If loaded history cannot prove consumption, the steer stays in place rather than being resent.

Switching conversations does not stop Runs. Unsent text survives switches only in browser memory, not reload; unsent attachments are not retained. Selecting or removing an attachment does not change project files. Sending uses a unique path without overwriting existing files. For a completed node, the attachment is staged for its follow-up without changing the completed snapshot. If the workspace is unavailable or the backend lacks safe upload support, the draft and attachment remain for retry.

### Planner follow-ups and review

Planner follow-ups may use a current node workspace alongside its active writer, not a merged view of parallel branches. Check **Planning session details** for the directory used. If the newest workspace is still preparing, the Planner uses the source project, never that partial workspace.

Review nodes can send bounded feedback to their graph-defined target. The target continues its own conversation with explicit instructions and completed file state; agent chat histories are not passed between nodes. An exhausted feedback budget means the requested rework was **not applied**, not that the review passed.

## Recover without starting over

The **Continue** control below is available in Graph. In Serial, after fixing the cause, send a follow-up in the conversation to retry the task.

| Situation | What to do |
| --- | --- |
| App/process interruption or an explicit pause | Inspect the retained output, then use **Continue** when offered. Startup does not silently resume model calls. |
| Provider credentials expired | Re-authenticate in Settings, then use **Continue** for the affected conversation. |
| Provider connection failure (`Connection error.`, connection reset/refused) | Check your network or proxy if it persists, then use **Continue** for the affected conversation. It resumes the unfinished turn in the same session. |
| Other task/provider failure, including an unrecognized error | Inspect and fix the cause, then use **Continue** to retry the failed tasks. You can also intervene on a node or change its Node Agent model/thinking settings first. |
| Conflict while combining parent results | Inspect the node's Merger conversation and retained workspace. Retry the node to re-attempt preparation; publication retry does not fix this conflict. |
| Final publication failed | Inspect the publication panel and any publication Merger, then retry publication. It reuses retained results rather than rerunning the graph. A changed branch is not silently written; interrupted-checkout recovery may require restoring the captured branch. Staged changes in excluded environment/runtime scopes stay staged and are not published; commit or unstage them explicitly. |

Changing the Node Agent model affects failed or paused nodes on their next attempt. A running attempt keeps its current model and is not restarted. Session details show the retry selection separately from the previous model. Environment overrides take precedence.

In Graph, Continue resumes paused or queued work first; after it settles, Continue again retries failed nodes without rerunning completed branches. Retained workspaces preserve partial work; missing or changed recovery evidence may require explicit repair. Editing an old message branches history: Serial does **not** rewind project files, while Graph retains Git rollback semantics.

## Know when the result is delivered

**Graph is complete only after successful publication to your project.** Green task cards or a model's final answer are not delivery evidence.

Publication combines terminal results with source changes privately and writes files only: no commit, branch/HEAD advance or staging-area change. Graph workspaces do not expose internal Git history. A private Merger handles Git conflicts; failed composition leaves the source untouched and can be retried. Repository and permission errors remain failures. Ordinary folders use external Git metadata; Grapher does not add `.git`.

**Post-task Planner review** defaults on for new Graph Runs. After publication, the Planner can inspect, report, wrap up or propose more work. With **Auto Approve**, further work and model calls can run without another click; publication still writes files without commits. Set review before creating the Run; Auto Approve applies live, including to a waiting or planning Graph. Interrupted reviews are not silently repeated.

Native environment support is **experimental**. There is no user environment-mode selector; tasks use native tools and backend-verified bindings when available. Reuse is best-effort, not a promise of portable environments. Managed environments are not copied into source. Published result descriptors and launch/retry/cancel controls are not exposed in the interface; they remain available only through the local API.

## Data and removal

Runtime data defaults to `.grapher/`; execution workspaces and the shared engine cache normally live in the OS cache. Successful publication can reclaim workspaces while keeping conversation history for follow-ups.

Removing a workspace in the UI deletes its conversations through the backend, including ones not loaded in that browser. Active conversations prevent removal; cleanup failures are retained for retry. Source projects and shared engine caches are not workspace-removal targets.

For exact paths and configuration variables, see [Storage and cleanup](architecture/storage.md). For implementation details, use the [developer documentation index](index.md#task-routes).
