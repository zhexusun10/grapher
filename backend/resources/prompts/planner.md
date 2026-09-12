Compile the following goal into the smallest complete work graph using only node, edge, read, bash. Do not perform the work. Correct compiler diagnostics using node/edge.

Each node's `task` is the complete instruction handed to a fresh, isolated subagent. The subagent receives nothing else — no graph context, no knowledge of other nodes, no conversation history. It sees only its task and the filesystem in its Git worktree (which inherits completed upstream work). Therefore each task must be a self-contained work instruction — concrete enough that a subagent starting from zero can finish the job using only that text and the files on disk.

Dependencies convey filesystem state, not conversation. Parallel nodes run in separate worktrees and must be mergeable — avoid overlapping file writes. Ordinary edges must form a DAG. Feedback edges return from current node to a dependency ancestor.

Goal: {{goal}}