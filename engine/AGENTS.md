# Pi Adapter Instructions

Applies to `engine/`; supplements [../AGENTS.md](../AGENTS.md). Commands run from
the repository root. [README.md](README.md) links the canonical integration docs.

## Boundaries

- [pi-compat.ts](pi-compat.ts) is the central upstream SDK/private-path/CLI binding.
  Prefer Pi's public exports; do not implement another model/auth/tool stack.
- [pi-lock.json](pi-lock.json), the `pi/` gitlink, [model-data/](model-data/) and
  [pi-dependencies/](pi-dependencies/) form one reviewed baseline. Upgrade only via
  [the documented procedure](../docs/development/pi-integration.md#upgrade-procedure),
  not hand edits, a global Pi installation or uncommitted submodule patches.
- Preserve role-specific resource/tool loading, project trust and credential
  provenance. Use isolated auth/model directories for tests, never user secrets.
- File-tool path adaptation is not transparent rewriting of shell commands or
  program internals. Planner Bash writes directly to source before approval;
  private Graph roles must keep their validated platform launcher boundaries.
- Prewarming loads code without creating sessions, running extension factories,
  writing projects or making model calls. Bind exact role/project/session state
  before normal initialization; never reuse mutable per-Run tool/history state.
- Prepared runtime copies and running agents retain loaded code. Do not restart
  a user's backend merely to refresh them; report when a restart is needed.

## Task-specific checks

| Change | Read / verify |
| --- | --- |
| Baseline, provider/auth, MCP, role policy | [Pi integration](../docs/development/pi-integration.md), [Providers](../docs/guides/providers.md); `npm run pi:verify`, `npm run test:pi` |
| Workspace tools / path mapping | [Filesystem isolation](../docs/architecture/filesystem-isolation.md); `node --test scripts/workspace-paths.test.mjs`, applicable `npm run test:native` / `npm run test:extensions` |
| Prepared hosts / prewarming | [Prewarming contract](../docs/development/pi-integration.md#prewarming-and-prepared-runtime); `npm run test:prewarm` |
| Project/route binding | [Execution model](../docs/architecture/execution-model.md); `npm run test:bindings` |

Run `npm run check` for TypeScript consumers, but it does not replace the engine
contract suites. Consult [Testing](../docs/development/testing.md) for setup and
host prerequisites. Local-model contracts are not paid-provider acceptance or
cross-platform sandbox proof.
