//! Bounded raw-blob import for SHA-256 repositories (unsupported by libgit2).
use super::Entry;
use crate::workspace;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const SMALL_BLOB_LIMIT: u64 = 1024 * 1024;
const BATCH_BYTES: usize = 8 * 1024 * 1024;
const BATCH_ENTRIES: usize = 128;
const CHANGED: &str = "Project changed while capturing SHA-256 bytes";

struct Pending {
    name: String,
    mode: &'static str,
    // Links retain their already inspected target bytes, just as before.
    file_check: Option<(PathBuf, String)>,
}

#[derive(Default)]
struct Batch {
    input: Vec<u8>,
    pending: Vec<Pending>,
    bytes: usize,
}

impl Batch {
    fn append(&mut self, item: Pending, bytes: &[u8]) -> Result<(), String> {
        let mark = self.pending.len() + 1;
        // Only numeric marks and length-delimited raw data enter this protocol.
        // Filenames belong to the existing NUL-delimited index-info channel.
        write!(
            &mut self.input,
            "blob\nmark :{mark}\ndata {}\n",
            bytes.len()
        )
        .map_err(|e| e.to_string())?;
        self.input.extend_from_slice(bytes);
        write!(&mut self.input, "\nget-mark :{mark}\n").map_err(|e| e.to_string())?;
        self.bytes += bytes.len();
        self.pending.push(item);
        Ok(())
    }

    fn flush(
        &mut self,
        index: &mut Vec<u8>,
        import: &mut impl FnMut(&[u8]) -> Result<Vec<u8>, String>,
    ) -> Result<(), String> {
        if self.pending.is_empty() {
            return Ok(());
        }
        self.input.extend_from_slice(b"done\n");
        let output = import(&self.input)?;
        let text = std::str::from_utf8(&output).map_err(|e| e.to_string())?;
        let ids: Vec<_> = text.lines().collect();
        if ids.len() != self.pending.len()
            || ids.iter().any(|id| {
                id.len() != 64
                    || !id.bytes().all(|b| b.is_ascii_hexdigit())
                    || id.bytes().all(|b| b == b'0')
            })
        {
            return Err("Invalid SHA-256 blob import response".into());
        }
        for (item, oid) in self.pending.iter().zip(ids) {
            // Keep the original post-write content reread. The exact bytes
            // sent to Git also passed the scan identity check before import.
            if let Some((file, blob)) = &item.file_check {
                verify_file(file, blob)?;
            }
            crate::workspace_git_index::append_index_info(index, item.mode, oid, &item.name);
        }
        self.input.clear();
        self.pending.clear();
        self.bytes = 0;
        Ok(())
    }
}

fn verify_file(file: &Path, blob: &str) -> Result<(), String> {
    let len = fs::metadata(file).map_err(|e| e.to_string())?.len();
    if super::file_blob(file, len)?.to_string() != blob {
        return Err(CHANGED.into());
    }
    Ok(())
}

#[cfg(windows)]
fn executable_paths(
    path: &Path,
    prefix: &[&str],
) -> Result<std::collections::BTreeSet<Vec<u8>>, String> {
    let mut args = prefix.to_vec();
    args.extend(["ls-files", "--stage", "-z"]);
    let output = workspace::git_bytes(path, &args, None, None)?;
    let mut paths = std::collections::BTreeSet::new();
    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or("Invalid graph index entry")?;
        let mut fields = record[..tab].split(|byte| *byte == b' ');
        let mode = fields.next().ok_or("Missing graph index mode")?;
        let _oid = fields.next().ok_or("Missing graph index object")?;
        let stage = fields.next().ok_or("Missing graph index stage")?;
        if fields.next().is_some() {
            return Err("Invalid graph index fields".into());
        }
        // Match the SHA-1 path: only a stage-zero, byte-exact path owns the bit.
        // Keep raw bytes so unrelated non-UTF-8 index names cannot be rewritten.
        if mode == b"100755" && stage == b"0" {
            paths.insert(record[tab + 1..].to_vec());
        }
    }
    Ok(paths)
}

fn read_small(file: &Path, blob: &str) -> Result<Option<Vec<u8>>, String> {
    // A growing file cannot turn a small-file batch into an unbounded read.
    let mut bytes = Vec::new();
    fs::File::open(file)
        .map_err(|e| e.to_string())?
        .take(SMALL_BLOB_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > SMALL_BLOB_LIMIT {
        // Size is only a routing hint, never a freshness check. If it grew
        // beyond this budget, use the original streaming path and revalidation.
        return Ok(None);
    }
    if git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
        .map_err(|e| e.to_string())?
        .to_string()
        != blob
    {
        return Err(CHANGED.into());
    }
    Ok(Some(bytes))
}

pub(super) fn stage(
    path: &Path,
    metadata: &Path,
    entries: BTreeMap<String, Entry>,
) -> Result<(), String> {
    let args = [
        "--git-dir",
        metadata.to_str().ok_or("Invalid graph Git")?,
        "--work-tree",
        path.to_str().ok_or("Invalid project path")?,
        "fast-import",
        "--quiet",
        "--done",
    ];
    stage_with(path, metadata, entries, |input| {
        workspace::git_bytes(path, &args, None, Some(input))
    })
}

fn stage_with(
    path: &Path,
    metadata: &Path,
    entries: BTreeMap<String, Entry>,
    mut import: impl FnMut(&[u8]) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    let prefix = [
        "--git-dir",
        metadata.to_str().ok_or("Invalid graph Git")?,
        "--work-tree",
        path.to_str().ok_or("Invalid project path")?,
    ];
    #[cfg(windows)]
    let old_executables = executable_paths(path, &prefix)?;
    // A singleton cannot amortize importing a pack: retain its original path.
    let batchable = entries
        .values()
        .filter(|entry| matches!(entry, Entry::File { .. } | Entry::Link { .. }))
        .take(2)
        .count()
        > 1;
    let mut batch = Batch::default();
    let mut index = Vec::new();
    for (name, entry) in entries {
        let (item, bytes) = match entry {
            Entry::Directory { .. } | Entry::Special { .. } => continue,
            Entry::File { mode, blob, .. } => {
                let file = crate::native::host_path(&path.join(&name));
                let file_text = file.to_str().ok_or("Invalid file path")?;
                let executable = if cfg!(unix) {
                    mode & 0o111 != 0
                } else {
                    #[cfg(windows)]
                    {
                        old_executables.contains(name.as_bytes())
                    }
                    #[cfg(not(windows))]
                    {
                        false
                    }
                };
                let mode = if executable { "100755" } else { "100644" };
                let buffered = if batchable
                    && fs::metadata(&file).map_err(|e| e.to_string())?.len() <= SMALL_BLOB_LIMIT
                {
                    read_small(&file, &blob)?
                } else {
                    None
                };
                let Some(bytes) = buffered else {
                    batch.flush(&mut index, &mut import)?;
                    let mut args = prefix.to_vec();
                    args.extend(["hash-object", "-w", "--no-filters", "--", file_text]);
                    let oid = workspace::git(path, &args)?;
                    verify_file(&file, &blob)?;
                    crate::workspace_git_index::append_index_info(&mut index, mode, &oid, &name);
                    continue;
                };
                (
                    Pending {
                        name,
                        mode,
                        file_check: Some((file, blob)),
                    },
                    bytes,
                )
            }
            Entry::Link { target, .. } => {
                if !batchable || target.value.len() as u64 > SMALL_BLOB_LIMIT {
                    batch.flush(&mut index, &mut import)?;
                    let mut args = prefix.to_vec();
                    args.extend(["hash-object", "-w", "--no-filters", "--stdin"]);
                    let oid =
                        workspace::git_bytes(path, &args, None, Some(target.value.as_bytes()))?;
                    let oid = String::from_utf8(oid).map_err(|e| e.to_string())?;
                    crate::workspace_git_index::append_index_info(
                        &mut index,
                        "120000",
                        oid.trim(),
                        &name,
                    );
                    continue;
                }
                (
                    Pending {
                        name,
                        mode: "120000",
                        file_check: None,
                    },
                    target.value.into_bytes(),
                )
            }
        };
        if batch.pending.len() == BATCH_ENTRIES || batch.bytes + bytes.len() > BATCH_BYTES {
            batch.flush(&mut index, &mut import)?;
        }
        batch.append(item, &bytes)?;
    }
    batch.flush(&mut index, &mut import)?;
    // No index mutation until every blob and every independent reread passed.
    // The existing private-index replacement and recovery behavior is unchanged.
    let mut args = prefix.to_vec();
    args.extend(["read-tree", "--empty"]);
    workspace::git(path, &args)?;
    let mut args = prefix.to_vec();
    args.extend(["update-index", "-z", "--index-info"]);
    workspace::git_bytes(path, &args, None, Some(&index))?;
    Ok(())
}

#[cfg(test)]
#[path = "sha256_stage_bench.rs"]
mod bench;

#[cfg(test)]
#[path = "sha256_stage_tests.rs"]
mod tests;
