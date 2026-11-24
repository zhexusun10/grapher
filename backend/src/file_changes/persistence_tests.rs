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
    let mut guard = cache().lock().unwrap();
    guard.note_mutation(run);
    guard.git_changes.insert(
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
fn repeated_saves_replace_current_execution_counts_without_losing_unloaded_history() {
    let temp = tempfile::tempdir().unwrap();
    let run = uuid::Uuid::new_v4().to_string();
    put(&run, "history", "history.txt", 7);
    persist(temp.path(), &run).unwrap();
    invalidate_run(&run);
    cache().lock().unwrap().log_changes.insert(
        (run.clone(), "current".into()),
        summary("current.txt", "edit", 3),
    );
    for _ in 0..3 {
        persist(temp.path(), &run).unwrap();
    }
    let path = persisted_path(temp.path(), &run).unwrap();
    let saved = read_persisted(&path);
    assert_eq!(saved.executions["current"].total_additions, 3);
    assert_eq!(saved.executions["current"].total_deletions, 1);
    assert_eq!(saved.executions["history"].total_additions, 7);
    cache().lock().unwrap().log_changes.insert(
        (run.clone(), "current".into()),
        summary("replacement.txt", "edit", 2),
    );
    persist(temp.path(), &run).unwrap();
    let saved = read_persisted(&path);
    assert_eq!(saved.executions["current"].files.len(), 1);
    assert_eq!(saved.executions["current"].files[0].path, "replacement.txt");
    assert_eq!(saved.executions["history"].total_additions, 7);
    invalidate_run(&run);
}

#[test]
fn saving_a_pending_overlay_keeps_confirmed_edits_to_the_same_file() {
    let temp = tempfile::tempdir().unwrap();
    let run = uuid::Uuid::new_v4().to_string();
    let text = concat!(
        "{\"type\":\"tool_execution_start\",\"toolCallId\":\"done\",\"toolName\":\"edit\",\"args\":{\"path\":\"current.txt\",\"edits\":[{\"oldText\":\"old\",\"newText\":\"new\"}]}}\n",
        "{\"type\":\"tool_execution_end\",\"toolCallId\":\"done\",\"toolName\":\"edit\",\"isError\":false}\n",
        "{\"type\":\"tool_execution_start\",\"toolCallId\":\"pending\",\"toolName\":\"edit\",\"args\":{\"path\":\"current.txt\",\"edits\":[{\"oldText\":\"new\",\"newText\":\"pending\"}]}}\n",
    );
    update_from_log_chunk(&run, "current", "worker", "/repo", "/repo", text, true);
    persist(temp.path(), &run).unwrap();
    let saved = read_persisted(&persisted_path(temp.path(), &run).unwrap());
    let summary = &saved.executions["current"];
    assert_eq!(summary.total_files, 1);
    assert_eq!(summary.total_additions, 1);
    assert_eq!(summary.total_deletions, 1);
    assert!(!summary.is_running);
    assert!(!summary.files[0].is_running);
    let live = cache().lock().unwrap().log_changes[&(run.clone(), "current".into())].clone();
    assert!(live.is_running, "saving must not settle live UI state");
    assert_eq!(live.total_additions, 2);
    invalidate_run(&run);
}

#[test]
fn failed_or_unfinished_tools_disappear_from_persisted_and_rehydrated_summaries() {
    for planner in [false, true] {
        for failed_tool in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let run = uuid::Uuid::new_v4().to_string();
            let start = "{\"type\":\"tool_execution_start\",\"toolCallId\":\"pending\",\"toolName\":\"write\",\"args\":{\"path\":\"unconfirmed.txt\",\"content\":\"pending\"}}\n";
            let failed = "{\"type\":\"tool_execution_end\",\"toolCallId\":\"pending\",\"toolName\":\"write\",\"isError\":true}\n";
            let update = |chunk| {
                if planner {
                    update_planning_from_log_chunk(&run, "current", "/repo", "/repo", chunk);
                } else {
                    update_from_log_chunk(&run, "current", "worker", "/repo", "/repo", chunk, true);
                }
            };
            update(start);
            // A sibling's completion may save this still-running attempt too.
            persist(temp.path(), &run).unwrap();
            let saved = read_persisted(&persisted_path(temp.path(), &run).unwrap());
            let saved = if planner {
                &saved.planning["current"]
            } else {
                &saved.executions["current"]
            };
            assert!(
                saved.is_empty(),
                "pending overlays are not durable evidence"
            );
            if failed_tool {
                update(failed);
            } else if planner {
                settle_planning(&run, "current");
            } else {
                settle(&run, "current");
            }
            let check = || {
                let guard = cache().lock().unwrap();
                let changes = if planner {
                    &guard.planning_changes
                } else {
                    &guard.log_changes
                };
                let empty = changes
                    .get(&(run.clone(), "current".into()))
                    .is_none_or(FileChangeSummary::is_empty);
                drop(guard);
                assert!(empty, "planner={planner}, failed_tool={failed_tool}: unconfirmed tool must not survive");
            };
            check();
            persist(temp.path(), &run).unwrap();
            invalidate_run(&run);
            hydrate_run(temp.path(), &run);
            check();
            invalidate_run(&run);
        }
    }
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

#[test]
fn clean_hydrated_runs_are_lru_bounded_without_dropping_dirty_runs_or_sidecars() {
    let temp = tempfile::tempdir().unwrap();
    let dirty_run = uuid::Uuid::new_v4().to_string();
    put(&dirty_run, "exec", "dirty.txt", 9);

    let mut clean_runs = Vec::new();
    for idx in 0..(MAX_CLEAN_HYDRATED_RUNS + 5) {
        let run = uuid::Uuid::new_v4().to_string();
        put(&run, "exec", &format!("file-{idx}.txt"), idx + 1);
        persist(temp.path(), &run).unwrap();
        clean_runs.push(run);
    }

    {
        let guard = cache().lock().unwrap();
        let retained_clean = clean_runs
            .iter()
            .filter(|run| guard.hydrated_runs.contains(*run))
            .count();
        assert!(
            retained_clean <= MAX_CLEAN_HYDRATED_RUNS,
            "clean hydrated runs should be bounded ({retained_clean})"
        );
        assert!(
            !guard.hydrated_runs.contains(&clean_runs[0]),
            "oldest clean run should be evicted first"
        );
        assert!(
            guard.git_changes.contains_key(&(dirty_run.clone(), "exec".into())),
            "unpersisted dirty run must never be evicted"
        );
    }

    // Re-accessing an evicted run seamlessly restores its durable sidecar.
    hydrate_run(temp.path(), &clean_runs[0]);
    assert!(
        cache()
            .lock()
            .unwrap()
            .log_changes
            .contains_key(&(clean_runs[0].clone(), "exec".into()))
    );

    invalidate_run(&dirty_run);
    for run in clean_runs {
        invalidate_run(&run);
    }
}

#[test]
fn persisting_new_execution_over_unloaded_sidecar_keeps_history_hydratable() {
    let temp = tempfile::tempdir().unwrap();
    let run = uuid::Uuid::new_v4().to_string();

    put(&run, "exec-old", "old.txt", 3);
    persist(temp.path(), &run).unwrap();
    // Simulate a restart or LRU eviction: sidecar remains on disk, cache is cold.
    invalidate_run(&run);

    put(&run, "exec-new", "new.txt", 5);
    persist(temp.path(), &run).unwrap();
    assert!(
        !cache().lock().unwrap().hydrated_runs.contains(&run),
        "persisting a partial delta over an unloaded sidecar must not mark the Run hydrated"
    );

    hydrate_run(temp.path(), &run);
    let guard = cache().lock().unwrap();
    assert!(guard.hydrated_runs.contains(&run));
    assert!(
        guard.log_changes.contains_key(&(run.clone(), "exec-old".into())),
        "historical execution from disk sidecar must be restored by hydrate_run"
    );
    assert!(
        guard.git_changes.contains_key(&(run.clone(), "exec-new".into())),
        "new execution must remain cached"
    );
    drop(guard);
    invalidate_run(&run);
}

#[test]
fn invalidation_during_persist_does_not_resurrect_hydrated_marker() {
    let temp = tempfile::tempdir().unwrap();
    let run = uuid::Uuid::new_v4().to_string();

    put(&run, "exec-1", "a.txt", 2);
    persist_with(temp.path(), &run, || {
        invalidate_run(&run);
    })
    .unwrap();

    let guard = cache().lock().unwrap();
    assert!(
        !guard.hydrated_runs.contains(&run),
        "concurrent invalidation must fence mark_persisted_if_unchanged"
    );
    assert!(
        !guard.clean_persisted_seq.contains_key(&run),
        "concurrent invalidation must not leave a stale clean_persisted_seq entry"
    );
    drop(guard);
    invalidate_run(&run);
}
