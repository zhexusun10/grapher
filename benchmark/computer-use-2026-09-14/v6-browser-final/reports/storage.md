# Reliability Audit — Persistence Layer (`server/storage.ts`)

- **Date:** 2025-09-14 (as originally recorded; the system clock at release-review time reads 2026-09-14 — the audit date is unverified metadata and does not affect findings)
- **Environment:** Node.js v25.4.0, macOS 26.6.2 (Build 25G83), APFS, x86_64
- **Auditor:** Grapher Execution Instance (read-only audit; deliverable is this report + reproduction scripts under `reports/repro/`)
- **Scope:** crash-consistency and data-loss risks of `save(path, data)`.

## 1. Code under audit

`server/storage.ts` (entire file, with line numbers):

```ts
1  import { writeFileSync } from "node:fs";
2  export function save(path: string, data: string) { writeFileSync(path, data); }
```

`server/users.ts`, `src/importer.ts` (named as callers in the task brief) are currently
stubs and **do not yet call `save`**; verified via:

```
grep -rn "save\|storage" --include='*.ts' --include='*.py' server src clients web
→ server/storage.ts:2:export function save(path: string, data: string) { writeFileSync(path, data); }
```

i.e. no other reference to `save` exists in the tree today. The findings below therefore
concern the primitive itself and any future wiring (e.g. `GET /users` persistence per
`contracts/users.json`).

`contracts/users.json` defines `500 server error` as a legal response for the users
endpoint — relevant to Finding 4 (error propagation must map to that contract, not to a
process crash).

### Baseline verification

- `npm test` → `node --test` → **2 pass, 0 fail, exit 0** (run before and after the audit;
  application tree unmodified — only files under `reports/` were created). Clarified at
  release review (2026-09-14): both "tests" are comment-only placeholder files with zero
  assertions; this green run demonstrates nothing about storage behavior and is recorded
  only as a no-regression baseline.

## 2. What `writeFileSync(path, data)` actually guarantees (node:fs API contract)

Per the node:fs contract (argued from documented API semantics, see §4 F3 for what was
and was not empirically demonstrated):

1. It is equivalent to `open(path, 'w')` (⇒ **immediate truncation of existing content**),
   `write(...)` the whole payload, `close()`.
2. There is **no atomicity**: the old content is destroyed *before* the new content is
   fully in place. Any crash, kill, ENOSPC, EFBIG, or EIO in that window leaves the file
   empty or partially written.
3. There is **no fsync**: on return, data is only in the OS page cache; neither file data
   nor the directory entry is forced to stable media.
4. There is **no locking**, no backup, no temp-file/rename strategy, and no option on
   `save()` to request any of these.

Each provable consequence below is a Finding with evidence, reproduction, severity, and
a design-level fix.

## 3. Findings

---

### F1 — Non-atomic overwrite: readers observe torn/empty files; a crash mid-save leaves a corrupt file on disk

**Severity: CRITICAL (release-blocking)**

**Evidence:** `server/storage.ts:2` — `writeFileSync(path, data)` = truncate-then-write;
no temp file, no rename (absence directly readable from the 2-line file).

**Reproduction — DEMONSTRATED by execution.**
Scripts: `reports/repro/repro1_supervisor.ts` + `reports/repro/repro1_writer.ts`.
Procedure: seed `state.json` with 39-byte valid JSON → spawn a process that calls
`save()` in a loop with a 206,638,901-byte JSON payload → a second process polls the
file every 5 ms → `SIGKILL` the writer mid-run.

Command: `node reports/repro/repro1_supervisor.ts reports/repro/out/state.json 900`
Actual observed output:

```
payload_bytes=206638901
writer_exit_signal=SIGKILL code=null
reader_observed_states={"other:39":128,"empty":23,"other:206638901":4}
final_size=0 valid_json=false fully_written=false
RESULT: file invalid size=0
exit=0
```

Interpretation of observed facts:
- The polling reader repeatedly observed **`empty` (0-byte) state while a save was in
  flight** (`"empty":23`; an earlier run at t=1200 recorded `"empty":59`) — live readers
  see the file truncated, proving the overwrite window is externally visible.
- With `SIGKILL` landing inside a `save()` call, the file left on disk was **0 bytes:
  the previously valid content was destroyed and nothing replaced it**. (When the kill
  lands between saves, the file remains valid — runs at t=75..870 ms — so the corruption
  is probabilistic per crash, but its *possibility* is what matters and was reproduced
  on the first in-flight kill.)
- Intermediate byte counts between 0 and full were not sampled by the 5 ms poller
  (sampling alias); whether a crash can strand a *partial prefix* (vs. only 0 bytes)
  depends on FS/page-cache behavior and is marked **interpretation / not demonstrated**.

**Why critical:** any process death (OOM, deploy kill, panic) during a save converts a
good data file into an empty/corrupt one. There is no recovery path in the code — no
backup, no journal, no validation on load.

**Design fix (no implementation here):** adopt write-new-then-publish: serialize payload
to a unique temp file in the *same directory*, `fsync` it, then `rename()` over the
target (rename is atomic on POSIX), then `fsync` the directory. Readers then only ever
see the old or the new complete file, and a crash leaves at worst the temp file as
garbage. Alternative designs: append-only log + snapshot, or embedded engine (SQLite).

---

### F2 — A failed write (ENOSPC / disk-quota / I/O error) destroys the previous good file

**Severity: CRITICAL (release-blocking)**

**Evidence:** `server/storage.ts:2` — truncation happens at open, before any payload
byte is written; failure of the write leaves the truncated file in place.

**Reproduction 2a — DEMONSTRATED with a real ENOSPC.**
Script: `reports/repro/repro5_enospc.ts` against a genuine 2 MB APFS disk image created
for this audit:

```
hdiutil create -size 2m -fs APFS -volname TINYENOSPC tiny
hdiutil attach tiny.dmg
node reports/repro/repro5_enospc.ts
```
Actual observed output:
```
seed_size=100035
SAVE_THREW code=ENOSPC
size_after_failed_save=0 equals_seed=false? true starts_with_y=false
exit=0
```
A 100,035-byte valid JSON file was replaced by a **0-byte file** by a save that then
*failed*. (Image detached afterwards with `hdiutil detach`; exit 0.)

**Reproduction 2b — DEMONSTRATED with a resource limit (same failure class).**
Script: `reports/repro/repro3_errors.ts fsize`, run under `ulimit -f 200` (102 KB):
```
bash -c 'ulimit -f 200; node reports/repro/repro3_errors.ts fsize'
```
Actual observed output:
```
SAVE_THREW code=EFBIG message=EFBIG: file too large, write
size_after_failed_save=204800 equals_original=false
exit=0
```
After the failed save the original seed content is gone, replaced by 204,800 bytes of
partial garbage `x…x` (note: 2× the rlimit — exact stranded length is FS/kernel
behavior; the *destruction of the seed* is the demonstrated fact).

**Why critical:** disk-full is a routine production event. With this design, the routine
outcome of a full disk is *corrupted persistent state*, not just a failed operation.
The 2b run also shows the write can be **partially flushed then throw**, i.e. the file
is corrupt even though the error was catchable.

**Design fix:** same temp-file + fsync + atomic-rename protocol as F1 (a failed write
then only ever corrupts the temp file; the published file survives untouched). Plus:
pre-flight free-space checks / reserve, and surface storage-failure metrics.

---

### F3 — No durability guarantee: `save()` returning does not mean data is on stable media

**Severity: HIGH (release-blocking if the service claims persistence)**

**Evidence:** `server/storage.ts:1-2` — only `writeFileSync` is used; nothing imports or
calls `fsync`, `fdatasync`, or opens the directory. `writeFileSync` offers no sync
guarantee (none is requested or possible through this call).

**Demonstration status: ARGUED FROM THE node:fs API CONTRACT, NOT empirically
demonstrated.** Proving cache-loss requires a real power-cut/kernel-crash test;
simulating it in-process would be tautological. The absence of any flush call in the
2-line file is direct code evidence that no such guarantee can exist. Marked as
contract argument rather than executed repro.

**Why high:** after `save()` "succeeds", a host crash/power loss can lose the write
entirely or leave it torn, *invisibly to the caller*. Combined with F1's lack of
rename, there is no point at which the caller can know data is durable.

**Design fix:** fsync the temp file's data before rename, fsync the parent directory
after rename (directory entry is metadata). Define, at the API level of `save()`,
whether it is durable-on-return or best-effort, and expose that as an explicit option
contract so callers (users store, importer) can choose.

---

### F4 — Error propagation: `save()` rethrows raw node:fs errors; in today's wiring an unhandled throw kills the process (exit 1), not a contract `500`

**Severity: MEDIUM (HIGH for availability once callers are wired)**

**Evidence:** `server/storage.ts:2` — no try/catch, no error mapping, no retry.
`contracts/users.json` requires `500 server error` for endpoint failures; no code maps
storage exceptions to that.

**Reproduction — DEMONSTRATED.** `node reports/repro/repro3_errors.ts missing-dir`:
```
Error: ENOENT: no such file or directory, open 'reports/repro/out/no/such/dir/x.json'
    at writeFileSync (node:fs:2404:20)
    at save (file:///.../server/storage.ts:2:52)
    ...
Node.js v25.4.0
exit=1
```
The raw exception propagates out of `save` and terminates the process with exit code 1.
(F2 repros additionally show the throw comes *too late*: the destructive truncate has
already happened, so throwing does not protect the data.)

**Why medium (data-wise) / high (service-wise):** failing loudly is the lesser evil and
preserves optionality for callers who do catch — but the current signature gives callers
no documented contract for what `save` throws, and an uncaught storage error in a request
path converts a recoverable write failure into a process crash (which, per F1, makes the
next crash-window corruption more likely: crashed-then-restarted writers, overlapping
saves, etc.). Parent-directory ENOENT also means first-run deployments can fail entirely.

**Design fix:** define `save`'s failure contract (typed errors: transient-vs-permanent),
ensure the F1/F2 atomic protocol makes throw-on-failure non-destructive, create/validate
the storage directory at startup, and have HTTP callers map storage failures to the
contract's `500`.

---

### F5 — No concurrency control: simultaneous saves silently lose updates; interleaving is undefined

**Severity: MEDIUM (design gap; becomes higher if multiple writers exist)**

**Evidence:** `server/storage.ts:2` — no lock file, in-process mutex, or single-writer
queue; nothing serializes concurrent `save()` calls to the same path.

**Reproduction — DEMONSTRATED (lost-update race).**
Script: `reports/repro/repro4_concurrent.ts`: two OS processes each call `save()` 60×
with distinct fixed payloads (8 MB `"A…|END-A"` vs 4 MB `"B…|END-B"`) on one file; 4
runs total. Actual outputs:
```
run 1 (first, buggy-path variant): final_len=4 is_exact_A=false is_exact_B=false → artifact; writers had crashed on a bad import path — excluded from conclusions
run 2: final_len=8388614 is_exact_A=true  is_exact_B=false
run 3: final_len=8388614 is_exact_A=true  is_exact_B=false
run 4: final_len=8388614 is_exact_A=true  is_exact_B=false
```
Observed behavior: outcome is *last-writer-wins with no detection whatsoever* — writer
B's 60 writes were all silently overwritten/lost. **Byte-level interleaved garbage was
NOT observed in these runs**; each surviving file was one writer's complete payload.
Whether concurrent overlapping `write()` calls can interleave torn bytes is **not
defined by POSIX for large non-atomic writes and is marked interpretation — not
demonstrated**.

**Design fix:** serialize writes per-path (single-writer actor / in-process queue plus
OS-level advisory lock if multi-process is supported). Document the concurrency model of
the storage layer; if multi-writer is unsupported, make that a checked precondition.

---

### F6 — No backup/temp-file/retention strategy anywhere in the layer

**Severity: LOW as a standalone defect (subsumed by F1/F2 fixes), but note it blocks any
"undo/recovery" story.**

**Evidence:** entire `server/storage.ts` (2 lines) — no `.bak`, no versioned names, no
retention; nothing else in the repo references such a concept (`grep` §1 shows no other
storage code). A corrupted file (F1/F2) is unrecoverable because no prior copy exists
anywhere.

**Demonstration status:** directly readable absence in code; no runtime repro needed
(negative evidence). Noted for completeness so the release assessment doesn't assume a
fallback exists.

**Design fix:** the atomic-rename protocol of F1 inherently keeps the previous version
until replaced; if point-in-time recovery is a product requirement, add versioned
snapshots or move persistence to an embedded transactional store.

## 4. Commands run and real results (full transparency)

| # | Command | Exit | Result |
|---|---------|------|--------|
| 1 | `npm test` (before edits) | 0 | 2 pass / 0 fail (`node --test`) |
| 2 | `cat server/storage.ts` / `cat -n` | 0 | 2-line file as quoted |
| 3 | `grep -rn "save\|storage" …` | 0 | no callers of `save` exist yet |
| 4 | `node reports/repro/repro1_supervisor.ts out/state.json {1200,75,150,260,400,640,900,870}` | 0 | reader saw `empty` 0-byte states 59× / 23×; **SIGKILL at t=900 → `final_size=0 valid_json=false`**; kills between saves → valid file |
| 5 | `node reports/repro/repro3_errors.ts missing-dir` | **1** | uncaught `ENOENT` thrown from `save` (traceback, exit 1) |
| 6 | `bash -c 'ulimit -f 200; node reports/repro/repro3_errors.ts fsize'` | 0 | `SAVE_THREW code=EFBIG`; seed file replaced by 204,800 bytes of partial junk |
| 7 | `hdiutil create -size 2m -fs APFS … && hdiutil attach … && node reports/repro/repro5_enospc.ts` | 0 | `SAVE_THREW code=ENOSPC`; 100,035-byte valid file → **0 bytes** |
| 8 | `hdiutil detach /Volumes/TINYENOSPC` | 0 | cleanup |
| 9 | `node reports/repro/repro4_concurrent.ts` ×4 | 0 | last-writer-wins, all of writer B's saves lost; no interleave observed |
| 10 | `npm test` (after audit) | 0 | still 2 pass / 0 fail; source tree untouched |

**Demonstrated vs. argued:**
- Demonstrated by execution: F1 (torn reads + 0-byte post-crash file), F2 (ENOSPC and
  EFBIG mid-write destroy prior content), F4 (throw propagates; exit code 1), F5
  (silent lost-update race).
- Argued from node:fs API contract only: F3 (no fsync/durability — absence of fsync is
  code-evident; the cache-loss consequence could not be safely power-cut-tested here).
- Marked interpretation / undefined behavior: partial-prefix stranding (F1),
  byte-interleaving under concurrent writes (F5), exact stranded length under EFBIG (F2b).

## 5. Prioritized release-blocking storage items (for downstream release assessment)

1. **P0 / F1 + F2 (+F3):** Replace truncate-in-place `writeFileSync` with the standard
   crash-safe protocol: temp file in same dir → write → fsync → atomic rename → fsync
   directory. Until then, **any crash or disk-full event can destroy the service's
   persistent state**; do not ship a caller that writes real user data through `save()`.
2. **P0 gate:** Add regression tests proving (a) kill -9 mid-save leaves the previous
   file intact and valid, and (b) an induced ENOSPC leaves the previous file intact.
   These are the acceptance criteria for item 1.
3. **P1 / F4:** Define `save()`'s error contract and map storage failures to
   `contracts/users.json`'s `500`; ensure startup creates/validates the storage
   directory (ENOENT repro above shows first-run failure mode).
4. **P1 / F5:** Choose and document a concurrency model (single-writer queue / lock);
   today concurrent savers silently lose updates.
5. **P2 / F6:** Decide whether versioned snapshots/undo are product requirements;
   otherwise rely on item 1's always-intact previous version.

**Bottom line:** `server/storage.ts` as written is not crash-consistent under any
failure mode; two of the destructive scenarios (crash-mid-write → 0-byte file;
ENOSPC → 0-byte file) were reproduced with executed scripts and real output above.
F1/F2/F3 should block any release that persists data through this function.
