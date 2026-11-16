//! Original per-file implementation kept only for differential tests/profiling.
use super::*;
use std::time::{Duration, Instant};

pub(super) fn legacy_stage(
    path: &Path,
    metadata: &Path,
    entries: BTreeMap<String, Entry>,
) -> Result<(), String> {
    let mut input = Vec::new();
    let prefix = [
        "--git-dir",
        metadata.to_str().ok_or("Invalid graph Git")?,
        "--work-tree",
        path.to_str().ok_or("Invalid project path")?,
    ];
    for (name, entry) in entries {
        let (oid, mode) = match entry {
            Entry::Directory { .. } | Entry::Special { .. } => continue,
            Entry::File { mode, blob, .. } => {
                let file = crate::native::host_path(&path.join(&name));
                let mut args = prefix.to_vec();
                args.extend([
                    "hash-object",
                    "-w",
                    "--no-filters",
                    "--",
                    file.to_str().ok_or("Invalid file path")?,
                ]);
                let oid = workspace::git(path, &args)?;
                if git2::Oid::hash_file(git2::ObjectType::Blob, &file)
                    .map_err(|e| e.to_string())?
                    .to_string()
                    != blob
                {
                    return Err("Project changed while capturing SHA-256 bytes".into());
                }
                (
                    oid,
                    if cfg!(unix) && mode & 0o111 != 0 {
                        "100755"
                    } else {
                        "100644"
                    },
                )
            }
            Entry::Link { target, .. } => {
                let mut args = prefix.to_vec();
                args.extend(["hash-object", "-w", "--no-filters", "--stdin"]);
                let oid = workspace::git_bytes(path, &args, None, Some(target.value.as_bytes()))?;
                (
                    String::from_utf8(oid)
                        .map_err(|e| e.to_string())?
                        .trim()
                        .into(),
                    "120000",
                )
            }
        };
        crate::workspace_git_index::append_index_info(&mut input, mode, &oid, &name);
    }
    let mut args = prefix.to_vec();
    args.extend(["read-tree", "--empty"]);
    workspace::git(path, &args)?;
    let mut args = prefix.to_vec();
    args.extend(["update-index", "-z", "--index-info"]);
    workspace::git_bytes(path, &args, None, Some(&input))?;
    Ok(())
}

fn observations(root: &Path) -> BTreeMap<String, Entry> {
    let mut entries = BTreeMap::new();
    super::super::scan(root, Path::new(""), &mut entries, false).unwrap();
    entries
}

fn tree(root: &Path, metadata: &Path) -> String {
    workspace::git(
        root,
        &["--git-dir", metadata.to_str().unwrap(), "write-tree"],
    )
    .unwrap()
}

fn median(mut samples: Vec<Duration>) -> Duration {
    samples.sort();
    samples[samples.len() / 2]
}

#[test]
#[ignore = "local SHA-256 blob batching benchmark; run explicitly with --ignored --nocapture"]
fn sha256_blob_batching_benchmark() {
    crate::ensure_test_data_root();
    for (label, count, large) in [
        ("singleton", 1, false),
        ("small_64", 64, false),
        ("small_256", 256, false),
        ("mixed_streaming", 64, true),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let old = temp.path().join("legacy-git");
        let new = temp.path().join("batch-git");
        fs::create_dir(&root).unwrap();
        for metadata in [&old, &new] {
            workspace::git(
                &root,
                &[
                    "--git-dir",
                    metadata.to_str().unwrap(),
                    "--work-tree",
                    root.to_str().unwrap(),
                    "init",
                    "-q",
                    "--object-format=sha256",
                ],
            )
            .unwrap();
        }
        for index in 0..count {
            let size = if large && index % 16 == 0 {
                2 * 1024 * 1024
            } else {
                4096
            };
            let mut bytes = vec![b'x'; size];
            bytes[..4].copy_from_slice(&(index as u32).to_le_bytes());
            fs::write(root.join(format!("file-{index:04}.bin")), bytes).unwrap();
        }
        // Empty object stores, not cold filesystem caches: fixture writes and
        // the independent scan have already read/touched these files.
        let entries = observations(&root);
        let started = Instant::now();
        legacy_stage(&root, &old, entries).unwrap();
        let empty_old = started.elapsed();
        let entries = observations(&root);
        let started = Instant::now();
        stage(&root, &new, entries).unwrap();
        let empty_new = started.elapsed();
        let expected = tree(&root, &old);
        assert_eq!(tree(&root, &new), expected);
        let mut old_times = Vec::new();
        let mut new_times = Vec::new();
        for round in 0..3 {
            for batch in if round % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            } {
                let entries = observations(&root);
                let started = Instant::now();
                if batch {
                    stage(&root, &new, entries).unwrap();
                } else {
                    legacy_stage(&root, &old, entries).unwrap();
                }
                let elapsed = started.elapsed();
                assert_eq!(tree(&root, if batch { &new } else { &old }), expected);
                if batch {
                    new_times.push(elapsed);
                } else {
                    old_times.push(elapsed);
                }
            }
        }
        println!("SHA-256 {label}: empty-store legacy={empty_old:?}, batch={empty_new:?}; warm median legacy={:?}, batch={:?}", median(old_times), median(new_times));
    }
}
