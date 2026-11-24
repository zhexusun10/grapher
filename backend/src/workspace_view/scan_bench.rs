//! Opt-in, disposable-fixture component timings; not end-to-end Run latency.
use super::*;
use std::time::{Duration, Instant};

// Retain the original algorithm only as the opt-in benchmark's reference.
fn fixed(entries: &mut BTreeMap<String, Entry>, files: Vec<PendingFile>) -> Result<(), String> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(4);
    if threads <= 1 || files.len() < 256 {
        for file in files {
            let entry = file_entry(&file.name, &file.absolute, &file.metadata)?;
            entries.insert(file.name, entry);
        }
        return Ok(());
    }
    let chunk = files.len().div_ceil(threads);
    let resolved = std::thread::scope(|scope| {
        let handles: Vec<_> = files
            .chunks(chunk)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|file| {
                            Ok((
                                file.name.clone(),
                                file_entry(&file.name, &file.absolute, &file.metadata)?,
                            ))
                        })
                        .collect::<Result<Vec<_>, String>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| "Project scan worker failed".to_string())?
            })
            .collect::<Result<Vec<_>, String>>()
    })?;
    for chunk in resolved {
        for (name, entry) in chunk {
            entries.insert(name, entry);
        }
    }
    Ok(())
}

fn observe(root: &Path) -> (BTreeMap<String, Entry>, Vec<PendingFile>, Duration) {
    let mut entries = BTreeMap::new();
    let mut files = Vec::new();
    let started = Instant::now();
    walk_scoped(
        root,
        Path::new(""),
        &mut entries,
        &mut files,
        false,
        root,
        &[],
        &Default::default(),
    )
    .unwrap();
    // Fix enumeration order in this synthetic workload on every host. In the
    // clustered case the first old partition owns all large files.
    files.sort_by(|a, b| a.name.cmp(&b.name));
    (entries, files, started.elapsed())
}

fn timed(root: &Path, queue: bool) -> (Vec<u8>, Duration, Duration) {
    let (mut entries, files, walk) = observe(root);
    let started = Instant::now();
    if queue {
        fill_file_entries(&mut entries, files).unwrap();
    } else {
        fixed(&mut entries, files).unwrap();
    }
    let elapsed = started.elapsed();
    // Compare all serialized metadata, not only normalized View equality.
    (serde_json::to_vec(&entries).unwrap(), walk, elapsed)
}

fn median(mut samples: Vec<Duration>) -> Duration {
    samples.sort();
    samples[samples.len() / 2]
}

#[test]
#[ignore = "local scan scheduling benchmark; run explicitly with --ignored --nocapture"]
fn file_scanning_benchmark() {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(4);
    for (label, count, large_count, large_bytes, stride) in [
        ("small_below_threshold", 64, 0, 0, 1),
        ("uniform_small", 512, 0, 0, 1),
        ("clustered_large", 512, 8, 16 * 1024 * 1024, 1),
        ("scattered_large", 512, 8, 16 * 1024 * 1024, 64),
        ("single_large", 512, 1, 64 * 1024 * 1024, 1),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let small = vec![b'x'; 4096];
        let large = vec![b'y'; large_bytes];
        for index in 0..count {
            fs::write(
                temp.path().join(format!("file-{index:05}.bin")),
                if index % stride == 0 && index / stride < large_count {
                    &large
                } else {
                    &small
                },
            )
            .unwrap();
        }
        let expected = timed(temp.path(), false).0;
        assert_eq!(timed(temp.path(), true).0, expected);
        let mut fixed = Vec::new();
        let mut queue = Vec::new();
        let mut walks = Vec::new();
        // Alternate order to avoid always giving one strategy the warmer cache.
        for round in 0..5 {
            for candidate in if round % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            } {
                let (actual, walk, elapsed) = timed(temp.path(), candidate);
                assert_eq!(actual, expected);
                walks.push(walk);
                if candidate {
                    queue.push(elapsed);
                } else {
                    fixed.push(elapsed);
                }
            }
        }
        println!("scan {label}: files={count}, workers={threads}, median_walk={:?}, fixed={:?}, queued={:?}",
            median(walks), median(fixed), median(queue));
    }
}

#[test]
#[ignore = "local completion record benchmark; run explicitly with --ignored --nocapture"]
fn node_completion_record_comparison_benchmark() {
    let temp = tempfile::tempdir().unwrap();
    let mut view = inspect(temp.path()).unwrap();
    let extra = serde_json::from_value(serde_json::json!({
        "attributes": [], "security": vec![42u8; 224], "protected": false,
        "flags": 0, "owner": null, "efs": false,
    }))
    .unwrap();
    let entry = Entry::File {
        mode: 0o644,
        blob: "a".repeat(40),
        extra,
    };
    for index in 0..53_000 {
        view.entries.insert(
            format!("node_modules/pkg-{index:05}/index.js"),
            entry.clone(),
        );
    }
    let record = temp.path().join("record");
    fs::create_dir(&record).unwrap();
    save(&record, &view).unwrap();
    let identity = node_view_identity(&view).unwrap();
    let mut repeated = Vec::new();
    let mut reused = Vec::new();
    for round in 0..3 {
        for reuse in if round % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            let started = Instant::now();
            // Both paths validate the complete stored checksum. The original
            // special-entry check discarded this record before HEAD comparison.
            let baseline = load(&record).unwrap();
            let matches = if reuse {
                baseline == view
            } else {
                drop(baseline);
                node_view_identity(&load(&record).unwrap()).unwrap() == identity
            };
            assert!(matches);
            let elapsed = started.elapsed();
            if reuse {
                reused.push(elapsed);
            } else {
                repeated.push(elapsed);
            }
        }
    }
    println!(
        "completion record comparison: entries=53000, record_bytes={}, repeated={:?}, reused={:?}",
        fs::metadata(record.join("view.json")).unwrap().len(),
        median(repeated),
        median(reused)
    );
}

#[test]
#[ignore = "local SHA-1/SHA-256 staging benchmark; run explicitly with --ignored --nocapture"]
fn snapshot_staging_benchmark() {
    crate::ensure_test_data_root();
    for format in ["sha1", "sha256"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let metadata = temp.path().join("graph-git");
        fs::create_dir(&root).unwrap();
        workspace::git(
            &root,
            &[
                "--git-dir",
                metadata.to_str().unwrap(),
                "--work-tree",
                root.to_str().unwrap(),
                "init",
                "-q",
                &format!("--object-format={format}"),
            ],
        )
        .unwrap();
        for index in 0..64u32 {
            let mut bytes = vec![b'z'; 4096];
            bytes[..4].copy_from_slice(&index.to_le_bytes());
            fs::write(root.join(format!("file-{index:05}.bin")), bytes).unwrap();
        }
        stage_project(&root, &metadata).unwrap();
        let prefix = ["--git-dir", metadata.to_str().unwrap(), "write-tree"];
        let expected = workspace::git(&root, &prefix).unwrap();
        let mut scans = Vec::new();
        let mut stages = Vec::new();
        for _ in 0..3 {
            let mut entries = BTreeMap::new();
            let started = Instant::now();
            scan(&root, Path::new(""), &mut entries, false).unwrap();
            scans.push(started.elapsed());
            let started = Instant::now();
            stage_project_entries(&root, &metadata, entries).unwrap();
            stages.push(started.elapsed());
            assert_eq!(workspace::git(&root, &prefix).unwrap(), expected);
        }
        println!(
            "snapshot staging {format}: files=64, median_scan={:?}, median_stage={:?}",
            median(scans),
            median(stages)
        );
    }
}
