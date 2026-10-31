# Using Grapher: plan, run, recover

> **Audience:** Users running coding tasks. Start with the [English](../README.md#quick-start) or [Chinese](../README.zh-CN.md#快速开始) README for installation.
> Developers changing these behaviors should use the [architecture contracts](architecture/overview.md#contract-ownership).

**Review the plan. Watch the work. Check the published result.** A finished agent response is not the same as a successfully delivered Graph result.

## Choose the right mode

- **Serial:** one agent works directly in your project. Prefer it for small, linear or tightly coupled changes.
- **Graph:** review a compiled task graph, then run independent branches in private workspaces. Dependencies carry completed project-file state, not other agents' conversations. A Graph can have just one node.
- **Auto:** let the Partitioner choose Serial or Graph from your goal.

More agents help only when work can progress independently. Repeatedly splitting edits to the same files can add conflicts instead of useful parallelism.

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
| Copy a conversation's original prompt | Right-click it in the sidebar and choose **Copy prompt**; saved conversations use the backend's original goal. |
| Collapse or reopen the Graph | Drag the divider past the graph's minimum width to collapse it; use the edge arrow to reopen it at the previous width. You can also focus the divider and press Enter. |
| Pause Graph node work | Use the topology's **Pause**; it interrupts active node processes and stops new dispatches for that Run. Wait for pausing to finish before **Continue**. It does not stop the Planner or other Runs. |
| Stop just one conversation | Use that node conversation's **Stop**. Global Stop/cancel also cancels planning. |
| Inspect a changed file | Open the file-change list and click a row. The file opens in your system default application from its execution workspace, Planner workspace or the source repository. Deleted files remain listed but are not clickable. |

A completed Serial task stays resident: its agent process — and any server it started, such as a dev server — keeps running for as long as the Grapher backend runs, so you can open the running app and follow up in the same session. It is stopped only when you delete the Run or remove its workspace, or when you stop the backend. Planner turns and Graph node agents are reclaimed at the end of their turn as usual. See [Process lifecycle](architecture/filesystem-isolation.md#parked-serial-shells).

After sending, the submitted text clears from the input immediately; a rejected or failed send restores the draft for retry. Once a running node has read a steering message, you can edit it in the conversation, including after reload. Editing branches from that message without turning it into a new task goal. Earlier replies and tool records stay visible, and earlier steering messages remain editable, even if their text is repeated. If a text steer is still unread, pause the node to return its text to the composer instead; a steer whose consumption the loaded history cannot yet prove is left in place rather than resent.

Switching conversations does not stop background Runs. Unsent text drafts survive conversation switching only in browser memory; reload clears them, and unsent attachments are not retained. Selecting or removing an attachment does not change project files. Sending stores it under a unique path without replacing an existing same-name file. For a completed node, the file is staged separately and delivered when its follow-up execution is prepared, leaving the completed snapshot unchanged. If the workspace is unavailable or the backend is too old to support safe uploads, the draft and attachment stay in the composer for retry.

Planner follow-ups may work in a current node workspace, even alongside its active writer. They do not present a merged view of every parallel branch. Use **Planning session details** to inspect the actual directory used for each turn.

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

In Graph, Continue first resumes paused or queued work without retrying unrelated failures. Once that work settles, use Continue again to retry the failed nodes in that Run; completed branches are left intact. Retained workspaces preserve partial work for recovery. Missing or changed recovery evidence may require explicit repair; Grapher does not silently reset it. Editing an old message branches conversation history: in Serial it does **not** rewind project files; Graph history edits retain Git rollback semantics.

## Know when the result is delivered

**Graph is complete only after successful publication to your project.** Green task cards or a model's final answer are not delivery evidence.

Publication combines valid terminal results with your source changes in a private workspace. It writes files only: no commit is created, your branch/HEAD is not advanced, and your existing staging area is preserved. Ordinary Graph nodes do not expose internal Git history in their working directory. Real Git conflicts invoke a Merger privately; a failed composition leaves your source untouched and can be retried. Repository/permission failures remain publication failures. Ordinary folders use temporary external Git metadata—Grapher does not add `.git` to your folder.

**Post-task Planner review** is enabled by default for new Graph Runs. After successful publication it invokes the existing Planner to inspect, report, wrap up or propose more work. With **Auto Approve**, new work can run without another approval click, leading to further iterations and model calls; each additional publication again writes files without committing them. Post-task review is captured when a Run is created, so configure it before starting a new Run; **Auto Approve** applies live, so enabling it approves a Graph that is already waiting (or still planning). An interrupted review is not silently repeated.

Native environment support is **experimental**. There is no user environment-mode selector; tasks use native tools and backend-verified bindings when available. Reuse is best-effort, not a promise of portable environments. Managed environments are not copied into source. Published result descriptors and launch/retry/cancel controls are not exposed in the interface; they remain available only through the local API.

## Data and removal

Runtime data defaults to `.grapher/`; execution workspaces and the shared engine cache normally live in the OS cache. Successful publication can reclaim workspaces while keeping conversation history for follow-ups.

Removing a workspace in the UI deletes its conversations through the backend, including ones not loaded in that browser. Active conversations prevent removal; cleanup failures are retained for retry. Source projects and shared engine caches are not workspace-removal targets.

For exact paths and configuration variables, see [Storage and cleanup](architecture/storage.md). For implementation details, use the [developer documentation index](index.md#task-routes).
