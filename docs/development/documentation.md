# Documentation Maintenance
 
> **Scope:** Repository knowledge placement, navigation and verification; not a product runtime contract.  
> **Maintained with:** [docs/index.md](../index.md) and [AGENTS.md](../../AGENTS.md).

## Goal

Route tasks to the smallest relevant context.

- `AGENTS.md` is the top-level router.
- `docs/index.md` maps tasks to source code and contracts.
- Source, tests, and CI establish truth.

## Placement & Inventory Rules

- **Single inventory:** Every repo-owned knowledge Markdown file must be linked directly from [docs/index.md](../index.md).

- **Exemptions:** The following are exempt from index coverage:
  - Executable prompts (`backend/resources/prompts/`)
  - GitHub templates
  - Upstream `pi/`
  - Dependencies
  - Generated/runtime outputs

- **Canonical locations:**
  - **Product overview:** `README.md` / `README.zh-CN.md` (link contracts; do not copy).
  - **Active contracts & guides:** `docs/architecture/`, `docs/guides/`, `docs/development/`, `docs/testing/`.
  - **Local constraints:** Module `README.md`; use local `AGENTS.md` only for material workflow/validation differences (keep root `AGENTS.md` under ~100 lines, no duplicated rules).
  - **Proposals (draft-only):** `docs/proposals/`.
  - **Historical / release records:** `docs/reviews/`, `docs/releases/`, `docs/archive/`, `.github/releases/`.

## Status & Section Boundaries

In [docs/index.md](../index.md), keep these three `##` headings stable as strict routing boundaries:

1. **Task routes**
   - Active entrypoints only.
   - `Implementation & tests` first.
   - `Contract docs` second.

2. **Current documentation**
   - Active (`active`) canonical inventory only.

3. **Proposals and historical evidence**
   - All `draft`, `deprecated`, or `archived` pages.
   - Each page must be paired with its current replacement link.

### Documentation Status

| Status | Meaning & Placement |
| --- | --- |
| `active` | Current contract/guide. Verify claims against code/tests. |
| `draft` | Unimplemented proposal (`docs/proposals/`). Place under *Proposals and historical evidence*. |
| `deprecated` | Superseded guidance retained temporarily; must link its replacement. |
| `archived` | Historical evidence or release notes (`docs/reviews/`, `docs/releases/`, `docs/archive/`). |

### Contract Header Format

Active contracts and operational guides must start with the following blockquote.

Use real Markdown links so path checks can validate them:

```markdown
> **Status:** active
> **Scope:** What this page owns (and what it does not).
> **Maintained with:** [implementation](../../backend/src/runtime.rs) and [regressions](../../backend/src/runtime_tests.rs).
```

### Verification & Superseding Rules

- **Verification dates:**
  - Add `Last verified` only after checking claims against code/tests.
  - Include revision, commands run, and untested limits.
  - Edit dates do not count as verification dates.

- **Superseding pages:**
  - Add a top warning banner with a link to the current contract.
  - Move the index link to *Proposals and historical evidence*.
  - Repair inbound links.
  - Do not rewrite historical Chinese/draft discussions merely to standardize metadata.

## Change-Driven Maintenance

1. **When to update**
   - Update the single canonical doc when changing:
     - Public interfaces
     - Persisted schemas
     - Runtime behavior
     - Module boundaries
     - Permissions
     - Setup commands
   - Pure internal refactors need no prose edits.

2. **Resolve conflicts via code**
   - If two pages disagree, inspect source/tests.
   - Update the canonical page.
   - Replace duplicate explanations with links.

3. **Verify**
   - Run targeted behavior tests.
   - Run documentation link/route checks after renaming files or changing contracts.