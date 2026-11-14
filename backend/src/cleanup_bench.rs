//! Opt-in disposable Run cleanup timings, including a concurrent metadata reader.
use super::*;
use std::{sync::{mpsc, Arc, Mutex}, time::{Duration, Instant}};

fn fixture(files: usize) -> (tempfile::TempDir, PathBuf, PathBuf, Runtime) {
    let (temp, source, mut runtime) = setup();
    let id = Uuid::new_v4().to_string();
    runtime.emit(EventKind::Started {
        execution: execution(&runtime, &id), message_sequences: None, fresh_restart: false,
    }).unwrap();
    runtime.emit(EventKind::Finished {
        execution_id: id.clone(), head: String::new(), output: String::new(), output_bytes: 0, metrics: None,
    }).unwrap();
    runtime.emit(EventKind::WorkspaceIsolationSelected { isolated: true }).unwrap();
    runtime.emit(EventKind::PublicationCompleted { head: String::new() }).unwrap();
    let workspace = temp.path().join(".grapher-worktrees").join(&runtime.state.run_id);
    for group in 0..files.div_ceil(100) {
        fs::create_dir_all(workspace.join(format!("node/artifacts/{group}"))).unwrap();
    }
    for index in 0..files {
        fs::write(workspace.join(format!("node/artifacts/{}/file-{index}.txt", index / 100)), b"fixture output\n").unwrap();
    }
    let session = runtime.root.join("sessions").join(&id);
    fs::create_dir_all(&session).unwrap();
    fs::write(session.join("session.jsonl"), "retained history").unwrap();
    (temp, source, workspace, runtime)
}

fn median(mut values: Vec<Duration>) -> Duration {
    values.sort();
    values[values.len() / 2]
}

fn sample(files: usize, deferred: bool) -> (Duration, Duration, Duration) {
    let (_temp, source, workspace, runtime) = fixture(files);
    let root = runtime.root.clone();
    // Like the maintenance worker, use a separate connection outside the Run
    // mutex. Opening it is not part of either cleanup strategy's timed section.
    let purge_store = crate::store::Store::open(&root.join("events.sqlite")).unwrap();
    let session = root.join("sessions").join(&runtime.state.executions[0].id).join("session.jsonl");
    let run = Arc::new(Mutex::new(runtime));
    let guard = run.lock().unwrap();
    let (ready, waiting) = mpsc::channel();
    let reader_run = run.clone();
    let reader = std::thread::spawn(move || {
        let started = Instant::now();
        ready.send(()).unwrap();
        let runtime = reader_run.lock().unwrap();
        assert_eq!(runtime.state.phase, "completed");
        started.elapsed()
    });
    waiting.recv().unwrap();
    let started = Instant::now();
    if deferred { guard.defer_cleanup_worktrees().unwrap(); }
    else { guard.cleanup_worktrees().unwrap(); }
    let held = started.elapsed();
    drop(guard);
    if deferred { crate::cleanup::detached::drain(&root, &purge_store).unwrap(); }
    let elapsed = started.elapsed();
    let reader_wait = reader.join().unwrap();
    assert!(!workspace.exists());
    assert_eq!(fs::read_to_string(source.join("user.txt")).unwrap(), "keep user files");
    assert_eq!(fs::read_to_string(session).unwrap(), "retained history");
    assert!(purge_store.detached_workspaces().unwrap().is_empty());
    (held, reader_wait, elapsed)
}

#[test]
#[ignore = "synthetic cleanup lock benchmark; disposable Runs only"]
fn workspace_cleanup_lock_benchmark() {
    for files in [64, 5_000, 20_000] {
        let mut samples = [Vec::new(), Vec::new()];
        for round in 0..3 {
            // Every sample gets a new disposable Run/tree, not a warm deletion
            // of an already empty directory. Alternate the strategy order.
            for deferred in if round % 2 == 0 { [false, true] } else { [true, false] } {
                samples[usize::from(deferred)].push(sample(files, deferred));
            }
        }
        for (index, label) in ["baseline", "detached"].into_iter().enumerate() {
            let values = &samples[index];
            println!("cleanup {label} files={files}: median_run_lock={:?}, median_reader_wait={:?}, median_total={:?}",
                median(values.iter().map(|v| v.0).collect()),
                median(values.iter().map(|v| v.1).collect()),
                median(values.iter().map(|v| v.2).collect()));
        }
    }
}
