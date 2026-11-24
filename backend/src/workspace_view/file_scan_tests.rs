use super::*;
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Barrier,
    },
};

fn pending(path: &Path, count: usize) -> Vec<PendingFile> {
    let metadata = fs::metadata(path).unwrap();
    // Distinct walk names can share a physical inode; scheduling must still
    // resolve every observation, not deduplicate or reuse content identities.
    (0..count)
        .map(|index| PendingFile {
            name: format!("{index:04}"),
            absolute: path.to_path_buf(),
            metadata: metadata.clone(),
        })
        .collect()
}

fn marker() -> Entry {
    Entry::Directory {
        mode: 0o755,
        extra: Default::default(),
    }
}

struct Active<'a>(&'a AtomicUsize);
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[test]
fn queue_resolves_every_file_once_with_bounded_workers_and_ordered_results() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("file");
    fs::write(&path, "data").unwrap();
    let count = 513;
    let visits: Vec<_> = (0..count).map(|_| AtomicUsize::new(0)).collect();
    let active = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let barrier = Barrier::new(4);
    let mut entries = BTreeMap::from([("existing-directory".into(), marker())]);
    fill_with(&mut entries, pending(&path, count), 4, |file| {
        let index: usize = file.name.parse().unwrap();
        visits[index].fetch_add(1, Ordering::Relaxed);
        let live = active.fetch_add(1, Ordering::SeqCst) + 1;
        let _active = Active(&active);
        peak.fetch_max(live, Ordering::SeqCst);
        if index < 4 {
            barrier.wait();
        }
        Ok(Entry::File {
            mode: 0o644,
            blob: format!("blob-{index}"),
            extra: Default::default(),
        })
    })
    .unwrap();
    assert_eq!(active.load(Ordering::SeqCst), 0);
    assert_eq!(peak.load(Ordering::SeqCst), 4);
    assert!(visits
        .iter()
        .all(|visits| visits.load(Ordering::Relaxed) == 1));
    let mut expected = BTreeMap::from([("existing-directory".into(), marker())]);
    for index in 0..count {
        expected.insert(
            format!("{index:04}"),
            Entry::File {
                mode: 0o644,
                blob: format!("blob-{index}"),
                extra: Default::default(),
            },
        );
    }
    assert_eq!(
        serde_json::to_vec(&entries).unwrap(),
        serde_json::to_vec(&expected).unwrap()
    );
}

#[test]
fn queue_keeps_original_insertion_order_for_duplicate_walk_names() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("file");
    fs::write(&path, "data").unwrap();
    let mut files = pending(&path, 513);
    for (index, file) in files.iter_mut().enumerate() {
        file.name = "duplicate".into();
        file.absolute = index.to_string().into();
    }
    let barrier = Barrier::new(4);
    let mut entries = BTreeMap::new();
    fill_with(&mut entries, files, 4, |file| {
        let index: usize = file.absolute.to_str().unwrap().parse().unwrap();
        if index < 4 {
            barrier.wait();
        }
        Ok(Entry::File {
            mode: 0o644,
            blob: index.to_string(),
            extra: Default::default(),
        })
    })
    .unwrap();
    assert_eq!(entries.len(), 1);
    assert!(matches!(&entries["duplicate"], Entry::File { blob, .. } if blob == "512"));
}

#[test]
fn queue_selects_first_walk_error_and_commits_no_partial_files() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("file");
    fs::write(&path, "data").unwrap();
    let barrier = Barrier::new(2);
    let active = AtomicUsize::new(0);
    let mut entries = BTreeMap::from([("existing-directory".into(), marker())]);
    let before = serde_json::to_vec(&entries).unwrap();
    let error = fill_with(&mut entries, pending(&path, 513), 4, |file| {
        active.fetch_add(1, Ordering::SeqCst);
        let _active = Active(&active);
        match file.name.as_str() {
            "0000" => {
                barrier.wait();
                Err("first walk error".into())
            }
            "0003" => {
                barrier.wait();
                Err("later walk error".into())
            }
            _ => Ok(marker()),
        }
    })
    .unwrap_err();
    assert_eq!(error, "first walk error");
    assert_eq!(active.load(Ordering::SeqCst), 0);
    assert_eq!(serde_json::to_vec(&entries).unwrap(), before);
}

#[test]
fn queue_joins_all_panicking_workers_before_returning_failure() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("file");
    fs::write(&path, "data").unwrap();
    let barrier = Barrier::new(4);
    let active = AtomicUsize::new(0);
    let mut entries = BTreeMap::from([("existing-directory".into(), marker())]);
    let before = serde_json::to_vec(&entries).unwrap();
    let error = fill_with(&mut entries, pending(&path, 4), 4, |file| {
        active.fetch_add(1, Ordering::SeqCst);
        let _active = Active(&active);
        barrier.wait();
        if file.name == "0000" || file.name == "0001" {
            panic!("scan worker fixture");
        }
        Ok(marker())
    })
    .unwrap_err();
    assert_eq!(error, "Project scan worker failed");
    assert_eq!(active.load(Ordering::SeqCst), 0);
    assert_eq!(serde_json::to_vec(&entries).unwrap(), before);
}

#[test]
fn queued_file_observations_match_sequential_capture_and_reread_same_size_edits() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("file");
    fs::write(&path, "before").unwrap();
    let files = pending(&path, 257);
    let old_observations = pending(&path, 257);
    let mut expected = BTreeMap::new();
    for file in pending(&path, 257) {
        let entry = file_entry(&file.name, &file.absolute, &file.metadata).unwrap();
        expected.insert(file.name, entry);
    }
    let mut actual = BTreeMap::new();
    fill(&mut actual, files, 4).unwrap();
    assert_eq!(
        serde_json::to_vec(&actual).unwrap(),
        serde_json::to_vec(&expected).unwrap()
    );

    fs::write(&path, "after!").unwrap();
    let mut refreshed = BTreeMap::new();
    fill(&mut refreshed, old_observations, 4).unwrap();
    let after = git2::Oid::hash_object(git2::ObjectType::Blob, b"after!")
        .unwrap()
        .to_string();
    assert_eq!(refreshed.len(), 257);
    for entry in refreshed.values() {
        assert!(matches!(entry, Entry::File { blob, .. } if blob == &after));
    }
    assert_ne!(actual, refreshed);

    let stale = pending(&path, 257);
    let before_error = serde_json::to_vec(&refreshed).unwrap();
    fs::remove_file(&path).unwrap();
    assert!(fill(&mut refreshed, stale, 4).is_err());
    assert_eq!(serde_json::to_vec(&refreshed).unwrap(), before_error);
}
