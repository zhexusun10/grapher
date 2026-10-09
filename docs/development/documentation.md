# Documentation maintenance

> **Status:** active
> **Scope:** Repository knowledge placement, navigation and verification; not a product runtime contract.
> **Maintained with:** [docs/index.md](../index.md) and [AGENTS.md](../../AGENTS.md).

The goal is to find the smallest **relevant, trustworthy** context for a task.
[AGENTS.md](../../AGENTS.md) is a map; [docs/index.md](../index.md) routes tasks to
knowledge; source, tests and CI verify implementation. Neither navigation file
should become a second architecture manual.

## Placement and inventory

| Material | Canonical placement |
| --- | --- |
| Product overview / translation | Root README / README.zh-CN.md; detailed contracts are linked, not copied |
| Cross-cutting current behavior | `docs/architecture/`, `docs/guides/`, `docs/development/`, `docs/testing/` |
| Module entrypoint / local constraints | Module README; local AGENTS.md only for material differences |
| New design discussion | `docs/proposals/`, visibly `draft`; promotion is not implied by approval of prose |
| Historical reviews / releases | Existing `docs/reviews/`, `docs/releases/`, `.github/releases/`; visibly historical |
| Production prompts / tool contracts | `backend/resources/`, beside their consumers; editing these changes behavior |
| Private logs / generated evidence | Ignored runtime/output directories; never the public knowledge base |
| Upstream Pi documentation | `pi/`; retain upstream organization and instructions |

Physical consolidation is unnecessary. Preserve stable URLs and code-adjacent
READMEs. Every repository-owned knowledge Markdown page must have a direct link
from [the index](../index.md); executable prompts and GitHub templates are exempt.
Upstream, dependencies, generated outputs and runtime data are out of scope.
The index is the inventory as well as the task router—do not maintain a second
unconnected catalogue.

For a new area, record a task route, canonical page, implementation entry point
and focused test/check. If two pages disagree, inspect code/tests, choose the
canonical responsibility and replace duplicate explanations with links. Preserve
unique design rationale or historical evidence; Git history alone is not a
convenient discovery mechanism for an active investigation.

## Status, responsibility and trust

| Status | Meaning |
| --- | --- |
| `active` | Intended current contract/guide; still verify relevant claims against code/tests |
| `draft` | Proposal, not implemented or accepted behavior |
| `deprecated` | Superseded guidance retained temporarily; link its replacement |
| `archived` | Historical evidence or release-specific description, not a current contract |

Important contracts and operational guides use a short visible header, for example:

```markdown
> **Status:** active
> **Scope:** What this page owns (and what it does not).
> **Maintained with:** [implementation](../../backend/src/runtime.rs) and [regressions](../../backend/src/runtime_tests.rs).
```

Use real Markdown links for related code/tests so path checks apply to them.
Responsibility follows that implementation area and the contributor changing its
contract; do not invent team owners. Ordinary forwarding READMEs need no header.
If an actual maintainer is assigned, name them rather than implying ownership.

Only add a `Last verified` date after reviewing the stated claims against named
code/tests; include revision, commands/results and untested boundaries. An edit
date is **not** such a review. Missing verification dates
mean "not recorded", not "verified recently". Dated Pi compatibility results and
benchmark observations apply only to their recorded revision/environment.

A `draft`, `deprecated` or `archived` page cannot be a direct recommendation in
the index's **Task routes** or **Current documentation** sections. Put it under
**Proposals and historical evidence**, with its current replacement/limitations.
These three level-two headings are the routing boundaries; keep them stable if
renaming them.
`docs/proposals/` is draft-only; `docs/reviews/`, `docs/releases/`,
`docs/archive/` and `.github/releases/` are historical; an explicit status must
not contradict these directory roles. Existing Chinese draft
and historical warning banners remain valid; do not rewrite discussion content
merely to standardize metadata.

When superseding a page, add a prominent warning and a current-contract link,
update index placement, and preserve useful provenance. Move to `docs/archive/`
only when it improves navigation; repair inbound links (or leave a forwarding
page). Promotion out of a proposal directory requires verified implementation,
canonical-page updates and a recorded decision, not just a status edit. Introduce
an ADR directory only when there is a real decision to preserve; existing design
rationale is already linked from the index.

## Change-driven maintenance

1. Public interfaces, persisted formats, runtime behavior, module boundaries,
   launch/permission rules and setup commands trigger a relevant-document review.
   Internal refactors do not automatically require prose changes.
2. Update the one canonical page; adjust summaries/translations only when their
   claims change. Link affected code/tests and repair task routes after renames.
3. Keep root AGENTS.md roughly 50–100 lines. Local guides only add independent
   constraints or validation differences; do not duplicate global rules.
4. Run applicable behavior tests and repair links/routes after renames; report
   what was not verified. A passing link check is not a semantic review.

## Agent exploration evaluation

After navigation changes, start from AGENTS.md and try representative tasks.
These are evaluation recipes, **not a claim that an agent has passed them**.

| Task | Expected discovery |
| --- | --- |
| Find feedback budget/drain behavior and restart evidence | Index → runtime/workspace contracts → runtime.rs/store.rs → runtime/feedback tests |
| Explain whether ignored `.venv` files survive inheritance and remain portable | Workspace contract → workspace_files.rs/tests → explicit portability limits; no proposal-as-feature inference |
| Locate the publication failure/retry boundary | Execution model → graph_merge.rs → publication tests and Merger acceptance prerequisites |
| Change a transcript-loading contract | Conversation logs → store/logs.rs + frontend cache/API → applicable frontend/log checks |
| Judge the old run audit or environment proposal | Historical/draft index row → warning/current authority → current implementation, not old recommendations |
| Identify the Pi upgrade path without scanning its entire monorepo | Pi integration + engine local guide → lock/compat boundary → upgrade checks and real-provider acceptance limits |

Record the task, revision, first relevant page, documents opened, exploration
steps, found code/tests, missed constraints, and any historical misclassification.
Compare before/after under the same agent/task settings; fewer unrelated reads
matter more than a larger AGENTS.md. Periodically repeat after module/contract
changes and fix the navigation where exploration actually gets stuck.
