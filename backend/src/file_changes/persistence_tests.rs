use super::*;
use std::{sync::mpsc, time::Duration};

fn summary(path: &str, source: &str, additions: usize) -> FileChangeSummary {
    FileChangeSummary::from_files(
        vec![FileChangeItem {
            path: path.into(),
            old_path: None,
            status: "modified".into(),
            additions,
            deletions: 1,
            is_running: false,
            nodes: vec!["worker".into()],
            execution_ids: vec![],
            source: Some(source.into()),
        }],
        false,
        None,
    )
}

fn put(run: &str, execution: &str, path: &str, additions: usize) {
    cache().lock().unwrap().git_changes.insert(
        (run.into(), execution.into()),
        summary(path, "git", additions),
    );
}

#[test]
fn persistence_snapshot_keeps_history_and_git_precedence_without_the_cache_lock() {
    let temp = tempfile::tempdir().unwrap();
    let run = uuid::Uuid::new_v4().to_string();
    let other = uuid::Uuid::new_v4().to_string();
    let path = persisted_path(temp.path(), &run).unwrap();
    let mut previous = PersistedRunChanges {
        version: PERSISTED_CHANGES_VERSION,
        ..Default::default()
    };
    previous
        .executions
        .insert("history".into(), summary("history.txt", "git", 7));
    previous
        .planning
        .insert("old-plan".into(), summary("old-plan.txt", "write", 1));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, serde_json::to_vec(&previous).unwrap()).unwrap();
    put(&run, "current", "current.txt", 3);
    {
        let mut guard = cache().lock().unwrap();
        guard.log_changes.insert(
            (run.clone(), "current".into()),
            summary("current.txt", "edit", 99),
        );
        guard.planning_changes.insert(
            (run.clone(), "new-plan".into()),
            summary("new-plan.txt", "write", 2),
        );
        guard
            .publication_changes
            .insert(run.clone(), summary("published.txt", "git", 4));
    }
    persist_with(temp.path(), &run, || {
        // Deterministic lock-boundary assertion, not a wall-clock threshold.
        // A different Run can write its cache before this save merges or does I/O.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut guard = loop {
            match cache().try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::WouldBlock) => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "save retained the global cache lock"
                    );
                    std::thread::yield_now();
                }
                Err(error) => panic!("{error}"),
            }
        };
        guard.git_changes.insert(
            (other.clone(), "other".into()),
            summary("other.txt", "git", 1),
        );
        guard.git_changes.insert(
            (run.clone(), "current".into()),
            summary("current.txt", "git", 8),
        );
    })
    .unwrap();
    let saved = read_persisted(&path);
    assert_eq!(saved.executions["history"].total_additions, 7);
    assert_eq!(
        saved.executions["current"].total_additions, 3,
        "the snapshot must be coherent and owned"
    );
    assert_eq!(saved.planning.len(), 2);
    assert_eq!(saved.publication.unwrap().total_additions, 4);
    persist(temp.path(), &run).unwrap();
    assert_eq!(
        read_persisted(&path).executions["current"].total_additions,
        8
    );
    invalidate_run(&run);
    invalidate_run(&other);
}

#[test]
fn same_run_saves_serialize_read_modify_write_even_through_root_aliases() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let alias = temp.path().join("alias");
    fs::create_dir(&root).unwrap();
    crate::path_safety::directory_link(&root, &alias);
    let run = uuid::Uuid::new_v4().to_string();
    let path = persisted_path(&root, &run).unwrap();
    put(&run, "first", "first.txt", 1);
    let (captured, capture) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let first_root = root.clone();
    let first_run = run.clone();
    let first = std::thread::spawn(move || {
        persist_with(&first_root, &first_run, || {
            captured.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(10)).unwrap();
        })
    });
    capture.recv_timeout(Duration::from_secs(10)).unwrap();
    // A newer save may only read/capture after the earlier write commits.
    let gate = write_lock(&alias, &run).unwrap();
    let serialized = matches!(gate.try_lock(), Err(std::sync::TryLockError::WouldBlock));
    // Creating the sidecar hierarchy must not change the gate identity. On
    // case-insensitive macOS, probing a missing parent used to change the key
    // when the directory appeared, allowing two writers to race the temp file.
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let after_creation = write_lock(&alias, &run).unwrap();
    assert!(
        Arc::ptr_eq(&gate, &after_creation),
        "directory creation changed the writer gate"
    );
    {
        let mut guard = cache().lock().unwrap();
        guard.git_changes.remove(&(run.clone(), "first".into()));
        guard.git_changes.insert(
            (run.clone(), "second".into()),
            summary("second.txt", "git", 2),
        );
    }
    let second_run = run.clone();
    let second_alias = alias.clone();
    let second = std::thread::spawn(move || persist(&second_alias, &second_run));
    release.send(()).unwrap();
    first.join().unwrap().unwrap();
    second.join().unwrap().unwrap();
    assert!(
        serialized,
        "save must retain its per-file gate through publication"
    );
    let saved = read_persisted(&path);
    assert_eq!(saved.executions.len(), 2);
    assert_eq!(saved.executions["first"].files[0].path, "first.txt");
    assert_eq!(saved.executions["second"].files[0].path, "second.txt");
    invalidate_run(&run);
    crate::path_safety::remove_directory_link(&alias);
}

#[test]
fn failed_save_keeps_prior_sidecar_and_releases_the_writer_for_retry() {
    let temp = tempfile::tempdir().unwrap();
    let run = uuid::Uuid::new_v4().to_string();
    let path = persisted_path(temp.path(), &run).unwrap();
    put(&run, "first", "first.txt", 1);
    persist(temp.path(), &run).unwrap();
    let before = fs::read(&path).unwrap();
    put(&run, "second", "second.txt", 2);
    let blocked = path.with_file_name("changes.json.tmp");
    fs::create_dir(&blocked).unwrap();
    assert!(persist(temp.path(), &run).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::remove_dir(&blocked).unwrap();
    persist(temp.path(), &run).unwrap();
    assert_eq!(read_persisted(&path).executions.len(), 2);
    invalidate_run(&run);
}
