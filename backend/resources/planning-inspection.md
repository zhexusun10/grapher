# Planner read-only inspection

Planner exposes `node / edge / read / bash`. The extension overrides the built-in Bash tool; the name preserves the model-facing command interface, not arbitrary shell semantics. `planning-inspection.mjs` parses and dispatches commands without invoking a shell. Production extracts this module alongside the embedded extension; the benchmark loads the same sources.

Supported forms (one command per call):

```text
pwd
ls [-lah] [path]
find [path] [-name/-iname glob] [-type f/d] [-maxdepth N]
rg --files [path]
rg/grep [-nilFrR] [-g/--glob glob] pattern [paths]
cat paths
head/tail [-n N] paths
curl [-fsSIL] URL
```

Quotes group arguments. Shell expansion, escapes, pipes, chaining, redirection, scripts, tests and arbitrary programs are rejected. This is deliberately not full Bash/Unix-command compatibility: pwd returns `.`; ls returns names rather than long stat formatting; recursive search skips `.git`, `node_modules` and symlinks; regex search uses system grep's extended expressions over stdin, not ripgrep's full option set. No user-controlled executable, environment or command flags reach that subprocess.

Search options precede the pattern. Repeat `-g` to include file globs (OR); `-g '!*.test.ts'` excludes matches. Globs without `/` match basenames; others match repository-relative paths. Filtering happens before reading files. Overlapping search paths are deduplicated. Search subprocesses are asynchronous and cancellable; `-l` stops each file scan at the first match. Search stops collecting output at 64 KiB rather than continuing through the repository. Prefer discovering paths first, then searching a narrow directory. An empty search result means no matches.

All local paths must resolve within the captured inspection root. Symlink components, `.git`, devices, sockets and other non-regular inputs are rejected. `read` uses the same guard and supports pagination for larger files. Bash reads up to 256 KiB per file, searches up to 4 MiB / 10000 entries, and limits output to 64 KiB. No shell process or repository code runs. Node/edge graph mutation remains an intentional write capability to the host-selected graph artifact, not to arbitrary paths.

`curl` is implemented using Node HTTP(S), not a curl binary. It supports GET and HEAD (`-I`/`--head`), optional redirects (`-L`/`--location`), and HTTP error rejection (`-f`); `-s/-S` are accepted because there is no progress output. There are no uploads, bodies, custom headers, cookies, credentials, local curl config, proxy environment, file URLs or non-default ports. Every DNS result must be public; connection lookup is pinned to a checked address to avoid DNS rebinding. Redirects repeat the same checks, with a four-hop limit. HTTP requests have a 15-second deadline and 64 KiB response limit. Localhost, private/link-local/reserved ranges and IPv4-mapped/transition IPv6 are denied.

This is a restricted tool capability, **not an OS sandbox** against malicious host processes, filesystem races, compromised Pi/extensions, or hostile system binaries. Concurrent external mutation of the repository is outside this boundary. Public GET/HEAD can still have server-side effects, and outbound URLs can disclose information; never include repository contents/secrets in URLs. Retrieved documents are untrusted data. Strong confidentiality/untrusted-repository deployment additionally needs process/filesystem and egress isolation.

## Benchmark validity

Rubrics are written only after candidate stages end. This is defense in depth; hiding a filename alone is not isolation. Restricted local inspection cannot read fixture parents, other sample artifacts or hidden grading files, including via symlinks or local HTTP endpoints.

The host records `inspectionPolicy: repository-inspection-v1`; every bash result records the same policy. The evaluator validates actual tool start/end evidence, policy identity, successful read paths and tool surface before judging a graph. Missing/incomplete or historical unrestricted evidence is `PLANNING_BOUNDARY` failure even when compilation passes and Git is clean. Rejected attempts are not successful boundary breaches. Policy attestation assumes the captured benchmark host and extension sources are trusted; it is not remote attestation.

Original evidence and scores are never overwritten during replay. Old runs without policy evidence can be replayed diagnostically but cannot regain a valid quality PASS by rejudging the same graph.
