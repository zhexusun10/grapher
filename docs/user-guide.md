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
- Git snapshots collect project files even when `.gitignore` matches them. Existing user changes can be staged and committed. Runtime internals and managed environment scopes are excluded; `.gitignore` is not a secret or artifact filter.
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
| Pause Graph node work | Use the topology's **Pause**; it interrupts active node processes and stops new dispatches for that Run. Wait for pausing to finish before **Continue**. It does not stop the Planner or other Runs. |
| Stop just one conversation | Use that node conversation's **Stop**. Global Stop/cancel also cancels planning. |

Switching conversations does not stop background Runs. Unsent text drafts survive conversation switching only in browser memory; reload clears them, and unsent attachments are not retained.

Planner follow-ups may work in a current node workspace, even alongside its active writer. They do not present a merged view of every parallel branch. Use **Planning session details** to inspect the actual directory used for each turn.

Review nodes can send bounded feedback to their graph-defined target. The target continues its own conversation with explicit instructions and completed file state; agent chat histories are not passed between nodes. An exhausted feedback budget means the requested rework was **not applied**, not that the review passed.

## Recover without starting over

| Situation | What to do |
| --- | --- |
| App/process interruption or an explicit pause | Inspect the retained output, then use **Continue** when offered. Startup does not silently resume model calls. |
| Provider credentials expired | Re-authenticate in Settings, then use **Continue** for the affected conversation. |
| Other task/provider failure | Inspect the error and intervene on the node, or save changed Node Agent model/thinking settings for that conversation and then use **Continue**. |
| Conflict while combining parent results | Inspect the node's Merger conversation and retained workspace. Retry the node to re-attempt preparation; publication retry does not fix this conflict. |
| Final publication failed | Inspect the publication panel and any publication Merger, then retry publication. It reuses retained results rather than rerunning the graph. |

Retained workspaces preserve partial work for recovery. Missing or changed recovery evidence may require explicit repair; Grapher does not silently reset it. Editing an old message branches conversation history: in Serial it does **not** rewind project files; Graph history edits retain Git rollback semantics.

## Know when the result is delivered

**Graph is complete only after successful publication to your project.** Green task cards or a model's final answer are not delivery evidence.

Publication combines valid terminal results with your source changes. Real Git conflicts invoke a Merger; repository/permission failures remain publication failures. Ordinary folders use temporary external Git metadata—Grapher does not add `.git` to your folder.

**Post-task Planner review** is enabled by default for new Graph Runs. After successful publication it invokes the existing Planner to inspect, report, wrap up or propose more work. With **Auto Approve**, new work can run without another approval click, leading to further iterations and model calls. These settings are captured when a Run is created; configure them before starting a new Run. An interrupted review is not silently repeated.

Native environment support is **experimental**. There is no user environment-mode selector; tasks use native tools and backend-verified bindings when available. Reuse is best-effort, not a promise of portable environments. Managed environments are not copied into source. Published results may offer named business entries and launch/retry/cancel controls; selecting an entry is not selecting an environment policy.

## Data and removal

Runtime data defaults to `.grapher/`; execution workspaces and the shared engine cache normally live in the OS cache. Successful publication can reclaim workspaces while keeping conversation history for follow-ups.

Removing a workspace in the UI deletes its conversations through the backend, including ones not loaded in that browser. Active conversations prevent removal; cleanup failures are retained for retry. Source projects and shared engine caches are not workspace-removal targets.

For exact paths and configuration variables, see [Storage and cleanup](architecture/storage.md). For implementation details, use the [developer documentation index](index.md#task-routes).
