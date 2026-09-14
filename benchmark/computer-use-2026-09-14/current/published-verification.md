# Verification Report — composed catalog toolkit

Scope: final verification of the composed result (`src/csv.mjs` + `src/search.mjs` + tests)
against the contract published in `README.md`, run from the repository root with the
contract's own command `npm test` (→ `node --test`).

* Environment: Node.js **v25.4.0**, npm **11.7.0**, macOS, repo root = worktree root.
* Outcome: **GREEN — 88 tests, 88 pass, 0 fail** (no skips, no todos, no cancelled).
* Code changes required: **none** — the first full-suite run passed, so no fix was applied.

---

## 1. Commands executed

All commands were run from the repository root (the directory containing `package.json`).

```bash
node --version                     # v25.4.0
npm --version                      # 11.7.0
npm test                           # contract command -> `node --test` (default discovery)
node --test tests/csv.test.mjs     # per-file counts (discovery cross-check)
node --test tests/search.test.mjs
node --test tests/integration.test.mjs
node /tmp/probe.mjs                # independent contract probe (scratch file, outside the repo)
grep -rInE "node:(http|https|net|dgram|tls|dns|child_process|worker_threads)|fetch\(|XMLHttpRequest|WebSocket|require\(" src tests package.json README.md
stat -f "%N size=%z mtime=%Sm" README.md package.json src/*.mjs tests/*.mjs
shasum -a 256 README.md package.json src/*.mjs tests/*.mjs
```

`npm test` exit status: **0**. The `/tmp/probe.mjs` scratch file was deliberately kept
outside the repository so it cannot influence `node --test` discovery or the published API.

Stability: `npm test` was executed repeatedly (including after `VERIFICATION.md` was added) —
`tests 88 / pass 88 / fail 0` on every run, `duration_ms` 146–175 ms, exit status 0 each time.
The tree contains exactly five source/test files (`src/csv.mjs`, `src/search.mjs`,
`tests/csv.test.mjs`, `tests/integration.test.mjs`, `tests/search.test.mjs`) — verified with
`find src tests -mindepth 1` — so no stray or hidden test file is in play.

## 2. Test counts and pass/fail outcome

Final `npm test` run (verbatim summary block from `/tmp/final.log`):

```
ℹ tests 88
ℹ suites 0
ℹ pass 88
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 149.771459
```

| Command | tests | pass | fail |
| --- | --- | --- | --- |
| `npm test` (`node --test`, default discovery) | 88 | 88 | 0 |
| `node --test tests/csv.test.mjs` | 38 | 38 | 0 |
| `node --test tests/search.test.mjs` | 38 | 38 | 0 |
| `node --test tests/integration.test.mjs` | 12 | 12 | 0 |
| `node /tmp/probe.mjs` (independent, 42 checks) | 42 | 42 | 0 |

Required suites present and discovered — the per-file counts **38 + 38 + 12 = 88** exactly
reconcile with the aggregate, proving that `node --test` file discovery picked up all three
files (`*.test.mjs` matches the built-in discovery pattern; no glob, `--test-name-pattern`,
or custom runner flag was needed):

* CSV unit tests — `tests/csv.test.mjs` (38 tests)
* Search unit tests — `tests/search.test.mjs` (38 tests)
* Interoperability integration tests — `tests/integration.test.mjs` (12 tests, composes
  `parseCatalog(csvText) → searchCatalog(items, opts)` end to end)

All test files use only `node:test` + `node:assert/strict` (top-level `test(...)` calls, run
in dependent-free child processes per file); none relies on a third-party runner.

## 3. Contract items checked — `src/csv.mjs` (`parseCatalog`)

Contract source: `README.md` — *"exports parseCatalog(csvText), returning
[{id: string, name: string, price: number}]. Header is id,name,price; handle quoted commas,
escaped quotes, CRLF, empty input, and reject malformed rows and negative/non-finite prices."*

| Contract item | How verified | Result |
| --- | --- | --- |
| Named export `parseCatalog`, single string argument | import in `tests/csv.test.mjs`, `tests/integration.test.mjs` | pass |
| Returns `[{id: string, name: string, price: number}]` — array of plain objects, exactly `id,name,price` keys, in that order, finite numeric price | "return shape: array of plain objects with exactly id/name/price keys and types"; integration "parsed rows are accepted by searchCatalog as-is"; probe | pass |
| Header must be `id,name,price`, order-sensitive | "rejects a missing or malformed header" (missing / 2-col / reordered / 4-col); probe "header wrong order" | pass |
| Header matching tolerant of case and surrounding whitespace; leading UTF-8 BOM ignored | "header matching is case and whitespace tolerant"; "a leading UTF-8 BOM is tolerated"; probe "BOM only header" | pass |
| Quoted commas inside fields | "handles quoted commas inside fields"; "handles several quoted fields on the same row"; integration "quoted commas, escaped quotes and embedded CRLF…" | pass |
| Escaped quotes (`""` → literal `"`), incl. field of only an escaped quote | "handles escaped double quotes inside quoted fields"; "handles a field that is only an escaped quote"; probe `esc quote tail`, `stray quote unquoted` | pass |
| CRLF handling (record separators, inside quoted fields, LF, lone CR, missing trailing newline) | "handles CRLF line endings, including CRLF inside a quoted field"; "quoted fields may contain newlines (LF)"; "lone CR line endings also terminate rows"; "last row without a trailing newline is parsed"; integration "CRLF and LF catalogs produce equal rows and equal search results" | pass |
| Empty input → empty catalog (also `null`/`undefined`/whitespace-only/newline-only/header-only) | "empty string input returns an empty catalog"; "whitespace-only and newline-only input…"; "nullish input is treated as empty input"; "header-only input (with and without trailing newline)…"; integration "an empty parse feeds an empty search result without error" | pass |
| Blank lines ignored, but a line carrying delimiters is still validated | "blank lines between rows are ignored"; "a line that only holds delimiters is still a malformed row, not a blank line" | pass |
| Reject malformed rows (wrong column count) with 1-based line numbers, counting embedded quoted newlines | "rejects rows with too few/too many columns"; "an unquoted comma inside a price is treated as a malformed row"; "reports the offending line number for later rows" (LF and CRLF) | pass |
| Reject empty id; non-string input is a `TypeError` | "rejects rows with an empty id"; "rejects a non-string csvText with a TypeError"; probe | pass |
| Reject negative prices | "rejects negative prices" (incl. `-1e3`) | pass |
| Reject non-finite prices (`Infinity`, `1e400`, …) | "rejects non-finite prices"; probe `1e400` | pass |
| Reject non-numeric / empty prices; accept integers, decimals, leading dot, exponents, leading `+`, surrounding spaces | "rejects non-numeric or empty prices"; "rejects a quoted price containing a comma"; "price formats: integers, decimals, leading dot, zero, exponents, leading +"; probe `underscore numeric` | pass |
| Zero price allowed, `-0` normalised to `0` | "zero price is allowed and never reported as -0"; probe | pass |
| Unterminated quoted field rejected | "rejects an unterminated quoted field"; probe "unterminated in header" | pass |
| Failure is atomic (no partial rows returned); non-header field values preserved verbatim | "a parse failure rejects the whole call rather than yielding partial data"; "field values other than the header are preserved verbatim"; "an empty name is allowed" | pass |
| No shared/mutable state between calls; order and count preserved at scale | "each call returns fresh arrays and objects (no shared state)"; "large catalog keeps order and count" (500 rows) | pass |

## 4. Contract items checked — `src/search.mjs` (`searchCatalog`)

Contract source: `README.md` — *"exports
searchCatalog(items, {query = '', minPrice = 0, maxPrice = Infinity} = {}). Case-insensitive
substring search on name; inclusive price bounds; preserve order, do not mutate input; reject
invalid bounds."*

| Contract item | How verified | Result |
| --- | --- | --- |
| Exported signature `searchCatalog(items, options?)`; options object optional and defaultable | "searchCatalog is exported as a function taking (items, options?)" (arity 1), "second argument is optional (omitted entirely)", "options may be an empty object…" | pass |
| Documented defaults `query=''`, `minPrice=0`, `maxPrice=Infinity` (incl. explicit `undefined` values) | "defaults are query="", minPrice=0, maxPrice=Infinity (per README)", "undefined option values fall back to the documented defaults"; integration "documented defaults … apply to parsed rows"; probe | pass |
| Case-insensitive **substring** match on `name` only (not prefix/word, not `id`, not price text); regex metacharacters literal; whitespace-only query is meaningful | "name matching is case-insensitive in both directions", "matching is a substring test…", "query containing spaces matches inside names", "whitespace-only query is not treated as empty", "search only looks at `name`…", "regex metacharacters in the query are literal" | pass |
| Inclusive price bounds on both ends (point queries valid) | "price bounds are inclusive on both ends", "fractional bounds work with floating point prices", "equal bounds are valid (point query)", "maxPrice=Infinity includes everything above minPrice" | pass |
| Query + bounds combine as a logical AND | "query and bounds combine (logical AND)"; integration "query and bounds combine as a logical AND over the parsed catalog" | pass |
| Preserves input order (no sorting) | "input order is preserved even when output order differs from sorted"; integration "result order comes from the parser, not from price or name ordering" | pass |
| Never mutates the input array or item objects; returns a **new** array holding the **original references** | "the input array and its items are never mutated", "a mutation-observing proxy confirms only reads happen" (0 `set`/`deleteProperty`/`defineProperty`), "frozen input … is accepted", "result holds references to the original items, not copies", "mutating the result does not affect the input", "validation happens before filtering"; integration "searching a parsed catalog never mutates the array or its row objects"; probe | pass |
| Rejects invalid bounds — `minPrice > maxPrice`, negative bounds, `NaN`, non-numbers, non-finite `minPrice`, `-Infinity` | "minPrice greater than maxPrice is rejected", "negative bounds are rejected with a RangeError", "NaN bounds are rejected", "non-numeric bounds are rejected with a TypeError", "-Infinity minPrice is rejected, +Infinity minPrice is rejected too" | pass |
| Rejects non-array `items` and non-string `query` with `TypeError`; skips unusable rows instead of crashing | "non-array items are rejected with a TypeError", "non-string query is rejected with a TypeError", "items with unusable name/price are skipped rather than crashing", "empty input returns an empty array" | pass |
| Reads each observed field at most once / only when needed (no hidden side effects) | "item fields are read (at most once) and never written" | pass |
| Dependency-free, self-contained module (no imports, no `require()`, no `node:` built-ins, no coupling to the CSV workstream) | "module source imports nothing and never references the CSV workstream" (static source scan of `src/search.mjs`); own source comment block; grep below | pass |
| Interop-ready row shape passes straight from parser to search | "search results are usable as plain rows (interop-ready shape)" + the 12 integration tests | pass |

Independent probe (`node /tmp/probe.mjs`): **42/42 checks ok**, additionally covering quoted
headers, `"a"""` trailing escaped quote, stray quote in an unquoted field, `\r` inside quotes,
`1_000`/`Infinity`/`1e400` prices, unterminated quote in the header, `id` remaining a string
(`007`), and the availability of the module's default export.

## 5. Defects found and fixes applied

**None.** The suite was green on the first execution, so no source or test file was modified.

Checks specifically looking for the defect classes named in the brief:

* *Wrong export shape* — `parseCatalog` is a named function export returning
  `{id, name, price}` objects in key order; `searchCatalog` is both a named and a default
  export with documented signature. Verified by tests plus the probe. No change needed.
* *Unhandled CSV edge case* — exercised quoted/escaped/embedded-CRLF/BOM/blank-line/
  last-row-without-newline/delimiter-only-line paths and the numeric-grammar rejections.
  All behave as documented; no change needed.
* *Mutated search input* — proxy write-observer (`set`/`deleteProperty`/`defineProperty`
  all counted 0), frozen-input acceptance, reference-equality of returned rows, and the
  integration snapshot against a fresh parse all pass. No change needed.
* *Test that does not run under `node --test` discovery* — all three files match the
  built-in `*.test.mjs` pattern and use `node:test` top-level `test()`; the aggregate (88)
  equals the sum of the per-file totals (38 + 38 + 12), so nothing is undiscovered or
  silently skipped. No change needed.

## 6. README.md and package.json unchanged

`README.md` and `package.json` were **not** modified; the only file added by this
verification is `VERIFICATION.md` (this file). Both retain their checkout byte size and
mtime, and their checksums are recorded here for comparison:

| File | bytes | mtime | SHA-256 |
| --- | --- | --- | --- |
| `README.md` | 703 | Sep 14 09:27:59 2026 | `1517c5c2de41c3a002ebc5cae683eb786a5a32614e5dbb2b6819f35b5c858941` |
| `package.json` | 105 | Sep 14 09:27:59 2026 | `6be848e7127cacdcf9db686e057730056351c3c4ceec621bf3470d5cfd1be890` |

`package.json` remains exactly
`{"name": "catalog-cu-evaluation", "private": true, "type": "module", "scripts": {"test": "node --test"}}`
— i.e. the contract command is untouched and has no `dependencies` or `devDependencies` key.
(Repo git metadata is not reachable from this sandbox, so change-freeness is evidenced by
identical size/mtime/checksum and by the fact that no write operation targeted these files.)

## 7. No dependencies, no network access

* No `node_modules/` directory and no `package-lock.json` exist in the repository — nothing
  was installed and nothing was resolved from a registry.
* Package manifest declares no `dependencies` / `devDependencies` / `peerDependencies`.
* Every import specifier in the tree is either a Node built-in or a relative path:
  * `src/csv.mjs` → `[]` (zero imports)
  * `src/search.mjs` → `[]` (zero imports)
  * `tests/csv.test.mjs` → `["node:test","node:assert/strict","../src/csv.mjs"]`
  * `tests/search.test.mjs` → `["node:test","node:assert/strict","node:fs","node:url","../src/search.mjs"]`
  * `tests/integration.test.mjs` → `["node:test","node:assert/strict","../src/csv.mjs","../src/search.mjs"]`
* Grep for `node:http|node:https|node:net|node:dgram|node:tls|node:dns|node:child_process|
  node:worker_threads|fetch(|XMLHttpRequest|WebSocket|require(` across `src/`, `tests/`,
  `package.json`, `README.md` produced a single hit — the literal `require(` string inside
  `tests/search.test.mjs`'s own "no require() allowed" assertion. No real network, socket,
  or dynamic-loading call site exists.
* `tests/search.test.mjs` uses `node:fs` only to read `src/search.mjs`'s own source text, and
  `node:url` only to resolve that path — local file reads, no remote I/O.
* The whole suite completed in ~150 ms with exit status 0 and no pending handles, confirming
  no service, port, or registry was contacted.

## 8. Final result

```
$ npm test
> node --test
... 88 top-level tests across tests/csv.test.mjs (38), tests/search.test.mjs (38),
    tests/integration.test.mjs (12)
ℹ tests 88 | ℹ pass 88 | ℹ fail 0 | ℹ cancelled 0 | ℹ skipped 0 | ℹ todo 0 | exit 0
```

The last full-suite runs were performed with `VERIFICATION.md` already present in the
repository root, so the recorded counts above match the final state of the tree.

**VERDICT: PASS.** The composed catalog toolkit satisfies the README contract for both
modules and their interoperability; the published API and default behaviour are unchanged,
no defects required repair, and the verification added only this report file.
