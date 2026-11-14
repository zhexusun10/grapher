//! Opt-in microbenchmark of staging only. Source scans, composition, delivery
//! and fsync are intentionally outside this measurement; no timing assertions.
use super::*;
use std::time::{Duration, Instant};

#[test]
#[ignore = "local synthetic staging benchmark; run explicitly with --ignored --nocapture"]
fn delta_index_staging() {
    crate::ensure_test_data_root();
    for (count, changed) in [(64, 1), (64, 64), (50_000, 1)] {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        workspace::snapshot_repository(&source).unwrap();
        let repository =
            git2::Repository::open(workspace::shadow_repo_dir(&source).unwrap()).unwrap();
        let contents = b"raw\npayload\r\n";
        let blob = repository.blob(contents).unwrap();
        let mut builder = repository.treebuilder(None).unwrap();
        for i in 0..count {
            builder.insert(format!("file-{i:05}.txt"), blob, 0o100644).unwrap();
        }
        let tree = builder.write().unwrap().to_string();
        let result = repository_git(&source, &["commit-tree", &tree, "-m", "staging fixture"])
            .unwrap();
        let path = "file-00000.txt";
        let selected_paths: BTreeSet<_> = (0..changed)
            .map(|i| format!("file-{i:05}.txt")).collect();
        let paths: Vec<_> = selected_paths.iter().map(String::as_str).collect();
        let selected = entries(&source, &result, &selected_paths).unwrap();
        let full = temp.path().join("full-index");
        let delta = temp.path().join("delta-index");
        fs::create_dir(&full).unwrap();
        fs::create_dir(&delta).unwrap();

        // Warm both checkout databases. Legacy repair's helper is the retained
        // full-index implementation, so both paths use identical Git options.
        stage_files(&source, &full, &result, &paths).unwrap();
        stage_entries(&source, &delta, &selected).unwrap();
        let mut full_time = Duration::ZERO;
        let mut delta_time = Duration::ZERO;
        const ITERATIONS: usize = 8;
        for iteration in 0..ITERATIONS {
            // Alternate ordering to avoid consistently favoring one warm cache.
            for delta_first in [iteration % 2 == 0, iteration % 2 != 0] {
                let start = Instant::now();
                if delta_first {
                    let staged = stage_entries(&source, &delta, &selected).unwrap();
                    delta_time += start.elapsed();
                    assert_eq!(fs::read(staged.join(path)).unwrap(), contents);
                } else {
                    let staged = stage_files(&source, &full, &result, &paths).unwrap();
                    full_time += start.elapsed();
                    assert_eq!(fs::read(staged.join(path)).unwrap(), contents);
                }
            }
        }
        let indexed_count = |journal: &Path| {
            private_index_git(&source, &journal.join("staging-index"), &["ls-files", "-z"])
                .unwrap().split('\0').filter(|name| !name.is_empty()).count()
        };
        assert_eq!(indexed_count(&full), count);
        assert_eq!(indexed_count(&delta), changed);
        println!(
            "{count} result paths / {changed} changed, {ITERATIONS} warm stages: full={:.2}ms delta={:.2}ms; index bytes={} -> {}",
            full_time.as_secs_f64() * 1000.0,
            delta_time.as_secs_f64() * 1000.0,
            fs::metadata(full.join("staging-index")).unwrap().len(),
            fs::metadata(delta.join("staging-index")).unwrap().len(),
        );
    }
}
