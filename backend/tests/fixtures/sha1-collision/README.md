# SHA-1 collision regression input

`sha-mbles-1.bin` is the 640-byte SHA-mbles test vector distributed in
RustCrypto `sha1-checked` 0.10.0, `tests/data/sha-mbles-1.bin`.
Source: <https://crates.io/crates/sha1-checked/0.10.0>.
Upstream project: <https://github.com/RustCrypto/hashes>.
The copied package's MIT license is retained in `LICENSE-MIT`.

SHA-256: `3ead211681cec93d265c8ac123dd062e105408cebf82fa6e2b126f4f40bcb88c`.

Used only to verify that the incremental hash finalizer reports known collision
inputs as errors, preserving libgit2's collision-detecting hash semantics. It is
not an executable, project dependency, or claim of a crafted Git-blob collision:
adding Git's object header changes the hashed message. Ordinary Git blob hash
compatibility is tested separately against libgit2 across chunk boundaries.
