# Security Audit — Authentication / Session Layer (`server/auth.ts`)

- **Date:** 2025-09-14 (as originally recorded; the system clock at release-review time reads 2026-09-14 — the audit date is unverified metadata and does not affect findings)
- **Auditor:** Grapher execution instance (read-only audit; no source, config, test, or contract files modified)
- **Scope:** `server/auth.ts` in full, plus surrounding context: `server/users.ts`, `server/config.ts`, `server/storage.ts`, `web/users.ts`, `web/config.ts`, `contracts/users.json`, `tests/`, `clients/`, `src/`, `package.json`, `README.md`, `docs/configuration.md`.
- **Runtime:** Node.js v25.4.0, npm 11.7.0. No `tsconfig.json` or TypeScript toolchain is configured; `.ts` files are consumable directly by Node's built-in type stripping.

## 1. Code under audit (complete, verbatim)

`server/auth.ts` is two lines (file ends at line 2):

```ts
1: export const sessions = new Map<string, {userId: string, expiresAt: number}>();
2: export function authenticate(token: string) { return sessions.get(token)?.userId; }
```

A repository-wide search (`grep -rn "sessions\|auth\|token\|expiresAt\|expire" --include="*.ts" --include="*.py" --include="*.json" --include="*.md" .`, node_modules excluded) returned **exactly two matches — the two lines of `server/auth.ts` above**. There are no other producers or consumers of sessions, tokens, or `authenticate()` anywhere in the workspace. **Observed fact.**

## 2. Commands actually run and real results

| # | Command | Result | Exit code |
|---|---------|--------|-----------|
| 1 | `node --version` / `npm --version` | `v25.4.0` / `11.7.0` | 0 / 0 |
| 2 | `npm test` (= `node --test`) | Baseline green: `tests/normalize.test.ts` ✔, `tests/users-flow.test.ts` ✔ — 2 tests, 2 pass, 0 fail. **Neither test exercises auth.** Correction at release review (2026-09-14): *both* `tests/normalize.test.ts` and `tests/users-flow.test.ts` contain only comments — the suite has **zero test assertions**, and the "2 pass" figures are `node --test` per-file placeholder passes, not behavior coverage of anything (including email lowercasing, which the earlier wording of this row mis-stated). | 0 |
| 3 | `node probe-auth.mjs` (temporary scratch file that `import`s `server/auth.ts` unmodified, run then deleted) | Full output reproduced per-finding below; final line `unknown token authenticate() => undefined`. | 0 |

The probe file was created at the worktree root, executed, and removed; `git` metadata was not inspected or touched. No application file was modified at any point.

Probe source (for reproducibility — drop into worktree root and `node <file>`):

```js
import { sessions, authenticate } from "./server/auth.ts";
sessions.set("tok-expired", { userId: "alice", expiresAt: Date.now() - 60_000 });
console.log("expired authenticate() =>", JSON.stringify(authenticate("tok-expired")));
sessions.set("tok-nonsense", { userId: "bob", expiresAt: "yesterday" });
console.log("non-numeric expiresAt authenticate() =>", JSON.stringify(authenticate("tok-nonsense")));
sessions.clear();
sessions.set("forged", { userId: "admin", expiresAt: 0 });
console.log("forged session authenticate() =>", JSON.stringify(authenticate("forged")));
console.log("unknown token authenticate() =>", JSON.stringify(authenticate("nope")));
```

Observed output (exit 0):

```
expired authenticate() => "alice"
non-numeric expiresAt authenticate() => "bob"
forged session authenticate() => "admin"
unknown token authenticate() => undefined
```

## 3. Findings

Severity scale: Critical / High / Medium / Low / Info. Ratings assume the intended end-state described in the README (a service exposing `GET /users` guarded by this auth layer). Where a statement is reasoning rather than something the code demonstrates, it is labeled **[Inference]** or **[Interpretation]**.

---

### F-1 (Critical) — `expiresAt` is stored but never enforced; sessions are immortal

- **Evidence:** `server/auth.ts:2` — `authenticate` is `sessions.get(token)?.userId`. The returned record's `expiresAt` field is never read by any code in the repository (confirmed by the repo-wide grep in §1; the only occurrences of `expiresAt` are the type annotation on line 1 and my transient probe).
- **Reproduction:** Probe line 1: a session with `expiresAt: Date.now() - 60_000` (expired one minute ago) → `authenticate("tok-expired")` returned `"alice"`. Observed output above; exit 0. The token would authenticate a thousand years from now.
- **Additional observed detail:** type safety is not enforced either — passing `expiresAt: "yesterday"` was accepted by the live Map at runtime and still authenticated (`=> "bob"`), because type stripping performs no runtime validation and `authenticate` never touches the field.
- **Severity reasoning — Critical:** Session expiry is the *only* mitigation for a leaked or stolen token in an in-memory bearer-token design. Because expiry is advertised in the data model (`expiresAt` exists and is populated by whoever writes to the map) but silently ignored, this is worse than absent expiry: it creates a false sense of safety in the schema. Any token disclosure = permanent account access until process restart.
- **Recommended fix (design level):** Make expiry a property of the auth API, not of caller discipline. `authenticate` must compare `expiresAt` against a single, documented clock source and reject at-or-before-now, returning a discriminated result (valid-user / expired / unknown) so callers cannot accidentally conflate "expired" with "no user". Keep the session store private to the auth module (see F-3) so no code path can bypass the check.

---

### F-2 (High) — No invalidation, logout, or expiry cleanup of any kind; store grows unboundedly

- **Evidence (observed):** `server/auth.ts` contains no `delete`, no purge/timer, no revoke API; the file has exactly the two lines in §1. `authenticate` is the only function. Repo grep (§1) shows no other module performs `sessions.delete(...)` or scheduled cleanup.
- **Reproduction (observed):** The probe demonstrated that the *only* way to remove a session is for a caller to mutate the exported map (`sessions.clear()` in the probe — see F-3 for why that is itself the vulnerability). Conversely, a session inserted with an expired `expiresAt: 0` remains resident in the map indefinitely: `authenticate` returned `"admin"` for it, and nothing ever evicts it.
- **[Inference]:** In a long-running server, tokens issued per login would accumulate forever (expired entries are never swept), yielding slow memory growth plus an ever-larger set of live credentials — every token ever issued remains a valid credential (compounding F-1).
- **Severity reasoning — High:** Immediate exploit requires an actual HTTP surface (see F-5), but the module as written cannot support logout, password-change revocation, or admin kill-switch — all standard controls — because it exposes no invalidation primitive. Combined with F-1, "revocation" is only possible via process restart.
- **Recommended fix (design level):** Provide an explicit lifecycle API from the auth module: `revoke(token)` / `revokeAllForUser(userId)`, plus lazy deletion of an entry discovered expired during lookup and a periodic sweep (or an expiry-ordered index) so the store's live set matches the set of non-expired credentials.

---

### F-3 (High) — Session store exported as a mutable global; sessions can be forged or destroyed by any import

- **Evidence:** `server/auth.ts:1` — `export const sessions = new Map(...)`. `const` protects only the binding; the map's *contents* are writable by every importer.
- **Reproduction (observed):** Probe lines: `sessions.set("forged", { userId: "admin", expiresAt: 0 })` from outside the module → `authenticate("forged")` returned `"admin"` (exit 0). Any module able to `import { sessions }` can mint credentials for any `userId` with no proof of identity, or `sessions.clear()` every legitimate session (DoS).
- **Severity reasoning — High:** *In isolation* (a single trusted process where every importer is first-party code) this is a hygiene/encapsulation weakness, not a remotely reachable flaw — **[Inference]**. It is rated High anyway because (a) it is the mechanism that makes F-1/F-2 unfixable by convention — expiry can only be "remembered" by each writer, and (b) any future feature that surfaces map contents to request handlers, diagnostics endpoints, or serialized state turns direct forgery into a trivial one-liner.
- **Recommended fix (design level):** Do not export the collection. Expose only narrow operations (`issueSession`, `authenticate`, `revoke`) from the auth module; keep the map module-private. If enumeration is ever needed (admin dashboards), export read-only snapshots.

---

### F-4 (High) — No token issuance path exists: no login API, no entropy requirements, token format entirely caller-chosen

- **Evidence (observed):** There is no function anywhere in the repository that creates a session (`grep` for `sessions`, `token`, `auth` → only `server/auth.ts:1-2`; no `login`, `issueToken`, `randomBytes`, `crypto` usage anywhere). The type is `Map<string, ...>` with no constraints on the key. The probe used `"forged"`, `"tok-expired"`, `"nope"` — arbitrary low-entropy strings — and all were treated identically to a real credential.
- **Reproduction (observed):** `sessions.set("forged", ...)` then `authenticate("forged") === "admin"`. A token of one character would work equally well; nothing in the layer rejects weak keys because nothing generates or validates them.
- **Severity reasoning — High:** A session layer with no issuance is an unfinished design, and "finish it later at the call sites" is exactly how `session_<userId>` or sequential-ID tokens get shipped. If any future login handler lets the *client* supply its own token string, an attacker can pre-register a guessable token or collide/overwrite another user's entry (`Map.set` on an existing key silently replaces the value — e.g., stealing `alice`'s identity by overwriting her session). **[Inference]** for the attack chain; observed fact only that no guardrails exist.
- **Recommended fix (design level):** Server-side issuance only: generate ≥128 bits of CSPRNG entropy (e.g., `crypto.randomBytes` → base64url), return the token to the client exactly once, never accept client-proposed token strings, and treat the stored secret as an opaque random identifier (design note: at ≥128-bit random keys, Map/hash lookup is not a practical timing oracle — see §5).

---

### F-5 (Medium) — `authenticate` has zero consumers; the contracted `GET /users` endpoint defines no authentication

- **Evidence (observed):** Repo grep (§1) proves nothing calls `authenticate`. `server/users.ts` is `export const users = [];` plus a TODO comment — the endpoint is unimplemented. `contracts/users.json` lists query/response shapes and errors `{"400":"invalid cursor","500":"server error"}` — **no 401/403 and no auth parameters**.
- **Reproduction:** `npm test` passes (2/2) with auth entirely untested and unwired; `grep` shows zero call sites of `authenticate` outside its definition.
- **Severity reasoning — Medium / [Inference]:** No data currently flows through this layer (the service body is empty), so nothing is *actively* exposed today. The risk is contractual: the published contract is the spec a future implementer will code to, and it omits authentication from `GET /users`. Whoever builds the endpoint from `contracts/users.json` will, by following the spec, ship user data with no auth check — reproducing F-1..F-4's "auth exists but is never enforced" pattern at the route level.
- **Recommended fix (design level):** Add `401 unauthorized` (and `403` if authorization tiers exist) to the contract; make middleware-level authentication a named prerequisite in the contract for every non-public route; add an integration test asserting an unauthenticated request to `/users` is rejected, so enforcement is regression-protected.

---

### F-6 (Low) — Expiry semantics are undefined by the code: units, clock source, boundary, and comparison direction

- **Evidence (observed):** `expiresAt: number` (`server/auth.ts:1`) carries no comment, and `docs/configuration.md` / `README.md` define nothing about it. Nothing states epoch-ms vs. seconds vs. monotonic clocks; `authenticate` never reads the field, so no behavior pins the interpretation down. The probe passed `Date.now() - 60_000`, `"yesterday"`, and `0` — all accepted silently.
- **Classification:** This is an **interpretation gap, not an asserted rule violation** — the code genuinely leaves expiry semantics undefined. **[Interpretation]:** `expiresAt >= 0` epoch-ms against wall clock is the most natural reading and was assumed for the F-1 reproduction, but the audit explicitly does not claim the code mandates it.
- **Severity reasoning — Low:** Latent only; it becomes real the moment F-1's check is implemented (mixed epoch-ms/epoch-s units are a classic "sessions last 50 years" regression) and wall-clock jumps (NTP, DST-adjacent manual changes) can shorten or lengthen sessions if monotonic time isn't considered.
- **Recommended fix (design level):** Document the contract of the auth module: unit, epoch, clock (wall vs. monotonic-permissible), and whether `expiresAt === now` is expired. Validate on issuance (reject non-finite/implausible values at runtime, not just in types) so malformed expiry can never be persisted.

---

### F-7 (Info) — `authenticate` collapses "unknown token", "expired session", and "user deleted" into a single `undefined`

- **Evidence (observed):** Return type is `string | undefined` from `sessions.get(token)?.userId`. Probe: `authenticate("nope")` → `undefined`, identical to what a future expired/rejected path would return if implemented with the same shape.
- **[Inference]:** Callers cannot distinguish "prompt for login" from "session timed out, show re-login banner"; and if `userId` were ever allowed to be `""`, a valid session would be indistinguishable from failure at falsy checks.
- **Severity:** Info — usability/robustness, not directly exploitable.
- **Recommended fix (design level):** Return a structured result (`{status: "ok"|"expired"|"invalid", userId?}`) so handlers make policy decisions on explicit states.

## 4. Observed vs. inferred — summary

- **Observed (executed against the real module):** expired sessions authenticate; non-numeric `expiresAt` accepted and ignored; sessions forgeable/destructible via the exported map; unknown token → `undefined`; no login/logout/issuance/cleanup code exists anywhere; `authenticate` has zero call sites; `npm test` passes 2/2 without touching auth; contract `users.json` has no auth errors.
- **Inferred (not demonstrated by execution):** the unauthenticated-`/users` shipping path (F-5), token-guessing/overwrite consequences of client-supplied tokens (F-4), memory growth in production (F-2), unit-confusion regression (F-6).
- **Interpretation (behavior undefined in code):** all `expiresAt` semantics (units, clock, boundary) — F-6.

## 5. Checks performed where no issue was found

- **Timing side-channels on lookup:** `Map` key lookup is hash-bucketed, not a sequence of constant-time byte comparisons; with ≥128-bit random tokens (once F-4's fix lands) this is not a practical oracle. No `crypto.timingSafeEqual` requirement asserted. **[Inference/design-note]**
- **Crash-safety of lookup:** `?.` on `sessions.get` correctly avoids throwing on unknown tokens (observed: `undefined`, no exception, exit 0).
- **Case/whitespace sensitivity of tokens:** standard `Map` string-key semantics; no normalization surprises observed.

## 6. Prioritized release-blocking auth items

1. **RB-1 (= F-1, Critical):** Enforce `expiresAt` inside a private-store `authenticate`; expired tokens must not resolve to a userId; add a regression test with a past `expiresAt` (today's suite proves expiry is untested *and* unimplemented).
2. **RB-2 (= F-4, High):** Server-side token issuance with CSPRNG ≥128-bit entropy; forbid client-supplied token strings; validate expiry values at write time.
3. **RB-3 (= F-3, High):** Stop exporting the mutable `sessions` map; encapsulate the store behind issue/authenticate/revoke.
4. **RB-4 (= F-2, High):** Implement revocation/logout and lazy + periodic eviction of expired entries.
5. **RB-5 (= F-5, Medium, blocking if `/users` ships in this release):** Add `401` to `contracts/users.json` and wire auth middleware in the endpoint spec; test that unauthenticated `/users` fails.
6. **RB-6 (= F-6/F-7, Low/Info — release-gate only as code-review items):** Document expiry semantics (unit/clock/boundary); move to a discriminated auth result type.

**Bottom line:** the auth layer as committed enforces nothing — the single security property its data model advertises (`expiresAt`) is dead code, proven by execution (exit 0, `authenticate` returned the user for an expired, a nonsense-expiry, and a forged session). It must not be relied on for any release that exposes authenticated data.
