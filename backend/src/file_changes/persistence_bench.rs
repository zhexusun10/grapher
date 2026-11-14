//! Opt-in local cache-lock/sidecar timings. No model calls or user data.
use super::*;
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

#[derive(Clone, Copy)]
struct Timing {
    capture: Duration,
    held: Duration,
    waiter: Duration,
    total: Duration,
}

fn summary(execution: &str, files: usize, source: &str) -> FileChangeSummary {
    FileChangeSummary::from_files(
        (0..files)
            .map(|index| FileChangeItem {
                path: format!("src/modules/{:03}/file-{index:06}.ts", index / 100),
                old_path: None,
                status: "modified".into(),
                additions: 2,
                deletions: 1,
                is_running: false,
                nodes: vec!["worker".into()],
                execution_ids: vec![execution.into()],
                source: Some(source.into()),
            })
            .collect(),
        false,
        None,
    )
}

fn seed(run: &str, executions: usize, files: usize) -> PersistedRunChanges {
    let mut previous = PersistedRunChanges {
        version: PERSISTED_CHANGES_VERSION,
        ..Default::default()
    };
    let mut guard = cache().lock().unwrap();
    for index in 0..executions {
        let id = format!("exec-{index:04}");
        let git = summary(&id, files, "git");
        previous.executions.insert(id.clone(), git.clone());
        guard.git_changes.insert((run.into(), id.clone()), git);
        guard
            .log_changes
            .insert((run.into(), id.clone()), summary(&id, files, "edit"));
    }
    // An execution absent from this session's cache must survive every save.
    previous.executions.insert(
        "unloaded-history".into(),
        summary("unloaded-history", files, "git"),
    );
    previous
}

/// Reference: the former implementation merged the whole sidecar while holding
/// the process-wide cache mutex. Keep it only in this opt-in probe.
fn sample(root: &Path, run: &str, optimized: bool) -> (Timing, Vec<u8>) {
    let started = Instant::now();
    let writer = optimized.then(|| persistence::write_lock(root, run).unwrap());
    let _writer = writer.as_ref().map(|lock| lock.lock().unwrap());
    let path = persisted_path(root, run).unwrap();
    let mut persisted = read_persisted(&path);
    persisted.version = PERSISTED_CHANGES_VERSION;
    let mut guard_time = Duration::ZERO;
    let mut capture_time = Duration::ZERO;
    let waiter = std::thread::scope(|scope| {
        let guard = cache().lock().unwrap();
        let (ready, waiting) = mpsc::channel();
        let reader = scope.spawn(move || {
            let started = Instant::now();
            ready.send(()).unwrap();
            let guard = cache().lock().unwrap();
            let _ = guard.run_epochs.get("unrelated-run");
            started.elapsed()
        });
        waiting.recv().unwrap();
        let held = Instant::now();
        let captured = if optimized {
            let snapshot = persistence::CacheSnapshot::capture(&guard, run);
            capture_time = held.elapsed();
            Some(snapshot)
        } else {
            let mut parts: BTreeMap<String, Vec<FileChangeSummary>> = BTreeMap::new();
            for ((owner, execution), summary) in guard.log_changes.iter().chain(&guard.git_changes)
            {
                if owner == run {
                    parts
                        .entry(execution.clone())
                        .or_default()
                        .push(summary.clone());
                }
            }
            capture_time = held.elapsed();
            persisted = merge_persisted_executions(std::mem::take(&mut persisted), parts);
            for ((owner, planning), summary) in &guard.planning_changes {
                if owner == run {
                    persisted.planning.insert(planning.clone(), summary.clone());
                }
            }
            if let Some(publication) = guard.publication_changes.get(run) {
                persisted.publication = Some(publication.clone());
            }
            None
        };
        guard_time = held.elapsed();
        drop(guard);
        if let Some(snapshot) = captured {
            persisted = snapshot.merge_into(std::mem::take(&mut persisted));
        }
        reader.join().unwrap()
    });
    let bytes = serde_json::to_vec(&persisted).unwrap();
    let temporary = path.with_file_name("changes.json.tmp");
    fs::write(&temporary, &bytes).unwrap();
    fs::rename(&temporary, &path).unwrap();
    (
        Timing {
            capture: capture_time,
            held: guard_time,
            waiter,
            total: started.elapsed(),
        },
        bytes,
    )
}

fn median(mut values: Vec<Duration>) -> Duration {
    values.sort();
    values[values.len() / 2]
}

#[test]
#[ignore = "local file-summary persistence probe; disposable caches/sidecars only"]
fn file_summary_persistence_benchmark() {
    for (executions, files) in [(4, 20), (20, 500), (40, 1_250)] {
        let temp = tempfile::tempdir().unwrap();
        let run = uuid::Uuid::new_v4().to_string();
        let previous = seed(&run, executions, files);
        let path = persisted_path(temp.path(), &run).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let seed_bytes = serde_json::to_vec(&previous).unwrap();
        let mut samples = [Vec::new(), Vec::new()];
        let mut expected = None;
        for round in 0..3 {
            for optimized in if round % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            } {
                fs::write(&path, &seed_bytes).unwrap();
                let (timing, bytes) = sample(temp.path(), &run, optimized);
                if let Some(expected) = &expected {
                    assert_eq!(&bytes, expected);
                } else {
                    expected = Some(bytes);
                }
                samples[usize::from(optimized)].push(timing);
            }
        }
        // Also compare the reference against the actual current entry point.
        fs::write(&path, &seed_bytes).unwrap();
        persist_run(temp.path(), &run).unwrap();
        assert_eq!(fs::read(&path).unwrap(), expected.unwrap());
        for (index, label) in ["baseline", "snapshot"].into_iter().enumerate() {
            let values = &samples[index];
            println!("file-summary {label} executions={executions}, paths_per_execution={files}, sidecar_bytes={}: median_capture={:?}, median_cache_lock={:?}, median_unrelated_wait={:?}, median_total={:?}",
                fs::metadata(&path).unwrap().len(), median(values.iter().map(|s| s.capture).collect()),
                median(values.iter().map(|s| s.held).collect()), median(values.iter().map(|s| s.waiter).collect()),
                median(values.iter().map(|s| s.total).collect()));
        }
        invalidate_run(&run);
    }
}
