//! Bounded work distribution for an already walked set of regular files.
use super::{file_entry, Entry, PendingFile};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        OnceLock,
    },
};

pub(super) fn fill(
    entries: &mut BTreeMap<String, Entry>,
    files: Vec<PendingFile>,
    threads: usize,
) -> Result<(), String> {
    fill_with(entries, files, threads, |file| {
        file_entry(&file.absolute, &file.metadata)
    })
}

fn fill_with(
    entries: &mut BTreeMap<String, Entry>,
    files: Vec<PendingFile>,
    threads: usize,
    resolve: impl Fn(&PendingFile) -> Result<Entry, String> + Sync,
) -> Result<(), String> {
    assert!(threads > 0, "Project scan requires a worker");
    // The caller retains the existing threshold and at-most-four worker cap.
    // These slots live only for this scan. Every claimed file runs the same
    // byte read, hashing and metadata capture as the sequential path.
    let resolved: Vec<_> = (0..files.len()).map(|_| OnceLock::new()).collect();
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                let files = &files;
                let resolved = &resolved;
                let next = &next;
                let resolve = &resolve;
                scope.spawn(move || loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(file) = files.get(index) else {
                        break;
                    };
                    let result = resolve(file);
                    let failed = result.is_err();
                    assert!(resolved[index].set(result).is_ok(), "Duplicate scan claim");
                    if failed {
                        break;
                    }
                })
            })
            .collect();
        let mut failed = false;
        // Join every worker before returning, including on a panic. No detached
        // reads or partially populated regular-file results escape a failure.
        for handle in handles {
            if handle.join().is_err() {
                failed = true;
            }
        }
        if failed {
            Err("Project scan worker failed".to_string())
        } else {
            Ok(())
        }
    })?;
    // Old partitions selected the first error in the original walk order, not
    // the fastest worker's error. Monotonic claims ensure all earlier indices
    // have been resolved even if workers stopped after their first error.
    for slot in &resolved {
        if let Some(Err(error)) = slot.get() {
            return Err(error.clone());
        }
    }
    if resolved.iter().any(|slot| slot.get().is_none()) {
        return Err("Project scan worker left an unresolved file".into());
    }
    // Keep original insertion order too (including any duplicate walk names).
    // Move the names rather than cloning one String for every resolved file.
    for (file, slot) in files.into_iter().zip(resolved) {
        let entry = slot.into_inner().ok_or("Missing resolved project file")??;
        entries.insert(file.name, entry);
    }
    Ok(())
}

#[cfg(test)]
#[path = "file_scan_tests.rs"]
mod tests;
