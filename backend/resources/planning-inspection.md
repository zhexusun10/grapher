# Legacy planning inspection utility

`planning-inspection.mjs` is retained as a compatibility reference for historical Planner traces and its standalone security tests. It is not imported by the current Planner extension, not extracted by the production backend, and not included in the Planner tool allowlist.

The current Planner exposes only `node` and `edge`. It cannot list, read or search repository files, invoke a shell, run tests, or access the network. Repository investigation belongs to workers during execution.

Current benchmark evidence is identified by `planner-graph-tools-v1`. Runs that expose `inspect`, `read`, `bash`, or any other successful tool do not satisfy the current planning boundary, even if they used one of the historical read-only policies.
