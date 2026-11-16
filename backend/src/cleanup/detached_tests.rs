use super::*;
use std::collections::BTreeSet;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    store: Store,
    run: String,
    target: Target,
    original: PathBuf,
    source: PathBuf,
}
fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    fs::create_dir(&root).unwrap();
    let store = Store::open(&root.join("events.sqlite")).unwrap();
    let run = Uuid::new_v4().to_string();
    let target = Target::workspace(temp.path(), &run, ".grapher-worktrees");
    let original = temp.path().join(".grapher-worktrees").join(&run);
    fs::create_dir_all(original.join("node")).unwrap();
    fs::write(original.join("node/old.txt"), "old workspace").unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("user.txt"), "user source").unwrap();
    store.remember_cleanup_source(&source).unwrap();
    Fixture {
        _temp: temp,
        root,
        store,
        run,
        target,
        original,
        source,
    }
}

#[test]
fn retired_cleanup_never_deletes_a_reused_workspace_path() {
    let f = fixture();
    retire(&f.root, &f.store, &f.run, &f.target).unwrap();
    assert!(!f.original.exists());
    let record = f.store.detached_workspaces().unwrap().remove(0);
    assert!(record.detached);
    let retired = record.location(&f.root).unwrap().1;
    assert!(retired.join("node/old.txt").is_file());
    fs::create_dir_all(&f.original).unwrap();
    fs::write(f.original.join("new.txt"), "new execution").unwrap();
    drain(&f.root, &f.store).unwrap();
    assert!(!retired.exists());
    assert_eq!(
        fs::read_to_string(f.original.join("new.txt")).unwrap(),
        "new execution"
    );
    assert_eq!(
        fs::read_to_string(f.source.join("user.txt")).unwrap(),
        "user source"
    );
    assert!(f.store.detached_workspaces().unwrap().is_empty());
}

#[test]
fn detached_receipts_recover_before_and_after_rename_and_delete() {
    for boundary in 0..4 {
        let f = fixture();
        let mut record = Record {
            id: Uuid::new_v4().to_string(),
            run_id: f.run.clone(),
            target: f.target.clone(),
            detached: false,
        };
        f.store.save_detached_workspace(&record).unwrap();
        let destination = record.location(&f.root).unwrap().1;
        if boundary > 0 {
            fs::rename(&f.original, &destination).unwrap();
            fs::create_dir(&f.original).unwrap();
            fs::write(f.original.join("new.txt"), "new execution").unwrap();
        }
        if boundary > 1 {
            record.detached = true;
            f.store.save_detached_workspace(&record).unwrap();
        }
        if boundary > 2 {
            crate::workspace_cleanup::remove_tree(&destination).unwrap();
        }
        drop(f.store);
        let store = Store::open(&f.root.join("events.sqlite")).unwrap();
        drain(&f.root, &store).unwrap();
        assert!(store.detached_workspaces().unwrap().is_empty());
        assert!(!destination.exists());
        if boundary == 0 {
            assert!(
                f.original.join("node/old.txt").exists(),
                "unrenamed work belongs to the main cleanup task"
            );
        } else {
            assert_eq!(
                fs::read_to_string(f.original.join("new.txt")).unwrap(),
                "new execution"
            );
        }
    }
}

#[test]
fn retirement_keeps_ownership_when_receipt_writes_fail() {
    for fail_marker in [false, true] {
        let f = fixture();
        let db = rusqlite::Connection::open(f.root.join("events.sqlite")).unwrap();
        db.execute_batch(if fail_marker {
            "CREATE TRIGGER fail_receipt BEFORE UPDATE ON detached_workspaces
             WHEN json_extract(NEW.payload,'$.detached')=1
             BEGIN SELECT RAISE(ABORT,'receipt marker failed'); END;"
        } else {
            "CREATE TRIGGER fail_receipt BEFORE INSERT ON detached_workspaces
             BEGIN SELECT RAISE(ABORT,'receipt insert failed'); END;"
        })
        .unwrap();
        assert!(retire(&f.root, &f.store, &f.run, &f.target).is_err());
        let records = f.store.detached_workspaces().unwrap();
        db.execute_batch("DROP TRIGGER fail_receipt").unwrap();
        if fail_marker {
            assert!(!f.original.exists());
            assert_eq!(records.len(), 1);
            assert!(!records[0].detached);
            fs::create_dir(&f.original).unwrap();
            fs::write(f.original.join("new.txt"), "new execution").unwrap();
            drain(&f.root, &f.store).unwrap();
            assert!(f.store.detached_workspaces().unwrap().is_empty());
            assert_eq!(
                fs::read_to_string(f.original.join("new.txt")).unwrap(),
                "new execution"
            );
        } else {
            assert!(records.is_empty());
            assert!(
                f.original.join("node/old.txt").is_file(),
                "no receipt means no rename"
            );
        }
    }
}

#[test]
fn detached_cleanup_cannot_finish_a_newer_generation_cleanup_task() {
    let f = fixture();
    retire(&f.root, &f.store, &f.run, &f.target).unwrap();
    f.store
        .enqueue_cleanup(
            &f.run,
            &super::super::Manifest {
                targets: BTreeSet::from([f.target.clone()]),
                sequence: Some(99),
                ..Default::default()
            },
        )
        .unwrap();
    drain(&f.root, &f.store).unwrap();
    assert_eq!(
        f.store
            .cleanup_task(&f.run)
            .unwrap()
            .unwrap()
            .manifest
            .sequence,
        Some(99)
    );
}

#[test]
fn detached_receipts_survive_conversation_deletion() {
    let f = fixture();
    retire(&f.root, &f.store, &f.run, &f.target).unwrap();
    let destination = f.store.detached_workspaces().unwrap()[0]
        .location(&f.root)
        .unwrap()
        .1;
    f.store
        .delete_run_with_cleanup(&f.run, Some(&super::super::Manifest::default()))
        .unwrap();
    assert!(f.store.run_was_deleted(&f.run).unwrap());
    assert_eq!(f.store.detached_workspaces().unwrap().len(), 1);
    drain(&f.root, &f.store).unwrap();
    assert!(!destination.exists());
    assert!(f.source.join("user.txt").is_file());
}

#[test]
fn retry_does_not_discard_a_receipt_while_rename_is_in_progress() {
    let f = fixture();
    let record = Record {
        id: Uuid::new_v4().to_string(),
        run_id: f.run.clone(),
        target: f.target.clone(),
        detached: false,
    };
    let lock = ticket(&f.root, &record.id).unwrap();
    let guard = lock.lock().unwrap();
    f.store.save_detached_workspace(&record).unwrap();
    drain(&f.root, &f.store).unwrap();
    assert_eq!(f.store.detached_workspaces().unwrap().len(), 1);
    fs::rename(&f.original, record.location(&f.root).unwrap().1).unwrap();
    drop(guard);
    drain(&f.root, &f.store).unwrap();
    assert!(f.store.detached_workspaces().unwrap().is_empty());
}

#[test]
fn detached_cleanup_rejects_redirected_paths_and_protected_sources() {
    let f = fixture();
    retire(&f.root, &f.store, &f.run, &f.target).unwrap();
    let record = f.store.detached_workspaces().unwrap().remove(0);
    let destination = record.location(&f.root).unwrap().1;
    crate::workspace_cleanup::remove_tree(&destination).unwrap();
    crate::path_safety::directory_link(&f.source, &destination);
    assert!(drain(&f.root, &f.store).is_err());
    assert!(f.source.join("user.txt").is_file());
    assert_eq!(f.store.detached_workspaces().unwrap().len(), 1);
    crate::path_safety::remove_directory_link(&destination);
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("adopted.txt"), "new project").unwrap();
    f.store.remember_cleanup_source(&destination).unwrap();
    assert!(drain(&f.root, &f.store)
        .unwrap_err()
        .contains("protected source"));
    assert!(destination.join("adopted.txt").is_file());
}

#[test]
fn detached_planner_cleanup_never_removes_its_live_parent_directory() {
    let f = fixture();
    let checkout = Uuid::new_v4().to_string();
    let target = Target::Workspace {
        parent: f._temp.path().to_path_buf(),
        bucket: ".grapher-workspaces".into(),
        owner: f.run.clone(),
        checkout: Some(checkout.clone()),
    };
    let parent = f._temp.path().join(".grapher-workspaces").join(&f.run);
    let original = parent.join(checkout);
    fs::create_dir_all(&original).unwrap();
    fs::write(original.join("old.txt"), "retired Planner").unwrap();
    retire(&f.root, &f.store, &f.run, &target).unwrap();
    // This parent is outside the detached receipt. It may now be a source
    // project or an allocation root reserved by another actor, even if empty.
    f.store.remember_cleanup_source(&parent).unwrap();
    drain(&f.root, &f.store).unwrap();
    assert!(
        parent.is_dir(),
        "purging one detached checkout removed its source/allocation parent"
    );
    assert!(!original.exists());
    assert!(f.store.detached_workspaces().unwrap().is_empty());
}

#[test]
fn detached_cleanup_refuses_non_workspace_receipts() {
    let f = fixture();
    let record = Record {
        id: Uuid::new_v4().to_string(),
        run_id: f.run.clone(),
        target: Target::data("sessions", &f.run),
        detached: true,
    };
    f.store.save_detached_workspace(&record).unwrap();
    assert!(drain(&f.root, &f.store)
        .unwrap_err()
        .contains("Invalid detached"));
    assert!(f.original.join("node/old.txt").is_file());
}

#[cfg(windows)]
#[test]
fn detached_cleanup_retains_readonly_file_and_directory_support() {
    let f = fixture();
    for path in [
        f.original.join("node/old.txt"),
        f.original.join("node"),
        f.original.clone(),
    ] {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions).unwrap();
    }
    retire(&f.root, &f.store, &f.run, &f.target).unwrap();
    drain(&f.root, &f.store).unwrap();
    assert!(!f.original.exists());
    assert!(f.store.detached_workspaces().unwrap().is_empty());
    assert!(f.source.join("user.txt").is_file());
}

#[cfg(windows)]
#[test]
fn failed_detached_delete_retries_without_touching_the_new_slot() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = fixture();
    retire(&f.root, &f.store, &f.run, &f.target).unwrap();
    let record = f.store.detached_workspaces().unwrap().remove(0);
    let destination = record.location(&f.root).unwrap().1;
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1 | 2)
        .open(destination.join("node/old.txt"))
        .unwrap();
    fs::create_dir(&f.original).unwrap();
    fs::write(f.original.join("new.txt"), "new execution").unwrap();
    assert!(drain(&f.root, &f.store).is_err());
    assert_eq!(f.store.detached_workspaces().unwrap().len(), 1);
    drop(held);
    drain(&f.root, &f.store).unwrap();
    assert_eq!(
        fs::read_to_string(f.original.join("new.txt")).unwrap(),
        "new execution"
    );
    assert!(f.store.detached_workspaces().unwrap().is_empty());
}
