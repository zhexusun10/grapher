# Release Readiness Assessment

- **Date:** 2026-09-14 (verified against the worktree system clock; both upstream
  reports are headed `2025-09-14`, which contradicts the current clock and is treated
  as unverified metadata, not evidence).
- **Role:** final corrective owner of `reports/auth.md`, `reports/storage.md`, this file.
- **No-fix constraint honored:** no source, config, test, or contract changed. I
  re-read `server/auth.ts` and `server/storage.ts`: both still match the verbatim
  listings in their reports, so no audit left the tree modified — nothing to restore.
- **Corrections applied upstream:** both reports implied the passing `npm test`
  provided coverage. It does not: `tests/normalize.test.ts` and
  `tests/users-flow.test.ts` are comment-only placeholders with **zero assertions**;
  `node --test`'s "2 pass" counts are per-file placeholder passes. Auth.md's claim
  that tests "cover email lowercasing" was also wrong. Both reports are annotated.
  Disk-image/crash/ENOSPC experiments were **not** re-run; their observed output is
  preserved as upstream evidence.

## Recommendation: HOLD

Not "release with accepted risk": both storage Criticals and the auth Critical are
proven by executed reproduction, and no compensating control exists in the tree.

### Blockers (must-fix-before-release)

1. **auth F-1 (Critical)** — `expiresAt` never read: expired, nonsense-expiry, and
   forged sessions all authenticated (probe, exit 0). A security control advertised in
   the data model but dead. (`auth.md` §2, F-1.)
2. **storage F1 (Critical)** — truncate-then-write: `SIGKILL` mid-save left a
   **0-byte file** replacing valid JSON. Executed repro. (`storage.md` F1.)
3. **storage F2 (Critical)** — a failed save (real ENOSPC; EFBIG under `ulimit -f`)
   destroyed the prior good file. Executed repros. (`storage.md` F2.)
4. **auth F-3 + F-4 (High, blocking with #1)** — mutable `sessions` map exported
   (any importer mints/destroys credentials) and no server-side issuance or entropy
   rule exists, so #1 cannot be safely closed at call sites.

### Follow-ups

- **High — storage F3:** no fsync ⇒ no durability. *Argued from the node:fs contract,
  not empirically demonstrated* (power-cut test out of scope).
- **High — auth F-2:** no revoke/eviction API (observed); unbounded store growth in
  production is **inference**.
- **Medium — auth F-5:** zero callers of `authenticate`; `contracts/users.json` has no
  401. Risk is contractual — an unauthenticated `/users` is **inference**, latent today.
- **Medium — storage F4/F5:** uncaught storage error kills the process, exit 1
  (observed); concurrent savers silently lose updates (observed); byte-interleaving
  **not** observed — interpretation.
- **Low — auth F-6:** `expiresAt` semantics undefined (interpretation gap, not a
  violated rule). **Low — storage F6:** no backup ⇒ corruption unrecoverable.
  **Info — auth F-7:** `undefined` conflates unknown/expired.

No material disagreement between the two reports; severities carried unchanged.

## Tradeoffs

**Release now, blockers accepted:** F-1 gives any leaked token permanent access
(blast radius: all accounts; irreversible without restart); F1/F2 turn routine
disk-full or deploy-kill events into destroyed persistent state with no recovery
path. Monitoring detects neither, and mitigations (external backups, forced
rotation) would have to supply guarantees the layer lacks. **Delay:** bounded cost —
atomic temp-file/fsync/rename for F1-F3; expiry enforcement over a private store for
F-1/F-3. Delay is cheaper than accepting irreversible credential and data loss.

## Verification (this review)

- `npm test` (`node --test`) → exit **0**, "2 pass / 0 fail" — both files are
  non-asserting placeholders; **no auth or storage behavior is verified**.
- Re-read `server/auth.ts`, `server/storage.ts`, `server/users.ts`,
  `contracts/users.json`: unmodified, matching audit citations.
- Repo greps (exit 0): `save` referenced only by its definition; auth surface only
  `server/auth.ts:1-2`.

## Remaining limits

Single macOS/APFS host; crash timing probabilistic; durability argued, not tested;
all remote-impact claims are inference because `server/users.ts` is an empty stub —
no HTTP surface exists to attack. `reports/repro/` scripts read, not re-executed.
