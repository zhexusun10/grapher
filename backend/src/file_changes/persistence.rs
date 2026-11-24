//! A coherent cache snapshot is captured briefly, then merged and saved without
//! the process-wide cache lock. The caller still owns its Run lifecycle lock.
use super::*;
use std::sync::{Arc, Weak};

#[derive(Default)]
pub(super) struct CacheSnapshot {
    executions: BTreeMap<String, Vec<FileChangeSummary>>,
    planning: BTreeMap<String, FileChangeSummary>,
    publication: Option<FileChangeSummary>,
}

impl CacheSnapshot {
    pub(super) fn capture(cache: &FileChangesCache, run: &str) -> Self {
        let mut captured = Self::default();
        for (changes, live) in [
            (&cache.log_changes, Some(&cache.live)),
            (&cache.git_changes, None),
        ] {
            for (key, summary) in changes {
                if key.0 == run {
                    captured.executions.entry(key.1.clone()).or_default().push(
                        Self::durable_summary(summary, live.and_then(|live| live.get(key))),
                    );
                }
            }
        }
        for (key, summary) in &cache.planning_changes {
            if key.0 == run {
                captured.planning.insert(
                    key.1.clone(),
                    Self::durable_summary(summary, cache.planning_live.get(key)),
                );
            }
        }
        captured.publication = cache.publication_changes.get(run).cloned();
        captured
    }

    fn durable_summary(
        summary: &FileChangeSummary,
        live: Option<&ChangeAccumulator>,
    ) -> FileChangeSummary {
        // A sibling can save while this process still has in-flight tools.
        // Persist only confirmed changes; pending overlays are live UI state,
        // not evidence that may become permanent if the backend crashes.
        live.map_or_else(
            || summary.clone(),
            |acc| {
                FileChangeSummary::from_files(
                    acc.committed.values().cloned().collect(),
                    false,
                    None,
                )
            },
        )
    }

    pub(super) fn merge_into(self, previous: PersistedRunChanges) -> PersistedRunChanges {
        let mut merged = merge_persisted_executions(previous, self.executions);
        merged.version = PERSISTED_CHANGES_VERSION;
        merged.planning.extend(self.planning);
        if self.publication.is_some() {
            merged.publication = self.publication;
        }
        merged
    }
}

type Writes = HashMap<String, Weak<Mutex<()>>>;
static WRITES: OnceLock<Mutex<Writes>> = OnceLock::new();

pub(super) fn write_lock(root: &Path, run: &str) -> Result<Arc<Mutex<()>>, String> {
    // Runtime roots already exist. Canonicalize before keying the gate so two
    // aliases of one data directory cannot race the same sidecar/temp file.
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    // Key only the existing root through filesystem identity. Resolving the
    // not-yet-created sidecar directory can change case normalization on macOS
    // as it appears, allowing simultaneous writers to acquire different gates.
    // Folding Run IDs is conservative on case-sensitive filesystems and also
    // serializes aliases on case-insensitive ones.
    let key = format!(
        "{}\0{}",
        crate::path_identity::path_key(&root),
        run.to_ascii_lowercase()
    );
    let mut writes = WRITES
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    writes.retain(|_, weak| weak.strong_count() > 0);
    if let Some(lock) = writes.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    writes.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

pub(super) fn persist(root: &Path, run: &str) -> Result<(), String> {
    persist_with(root, run, || {})
}

fn persist_with(root: &Path, run: &str, after_capture: impl FnOnce()) -> Result<(), String> {
    let Some(path) = persisted_path(root, run) else {
        return Ok(());
    };
    // Serialize the whole read-modify-write, not merely rename: a later save
    // must read the preceding save's history and capture the latest cache.
    // Never acquire this gate while holding the global cache mutex.
    let lock = write_lock(root, run)?;
    let _writer = lock.lock().map_err(|e| e.to_string())?;
    let previous = read_persisted(&path);
    let (captured, captured_seq) = {
        let guard = cache().lock().map_err(|e| e.to_string())?;
        let seq = guard.mutation_seq.get(run).copied().unwrap_or(0);
        (CacheSnapshot::capture(&guard, run), seq)
    };
    after_capture();
    let persisted = captured.merge_into(previous);
    if persisted.executions.is_empty()
        && persisted.planning.is_empty()
        && persisted.publication.is_none()
    {
        return Ok(());
    }
    // Keep the existing sidecar schema and save boundary. Large merges, JSON
    // serialization and filesystem I/O do not serialize unrelated Runs now.
    let bytes = serde_json::to_vec(&persisted).map_err(|e| e.to_string())?;
    let directory = path.parent().ok_or("Invalid file-change path")?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let temporary = path.with_file_name("changes.json.tmp");
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
    if let Ok(mut guard) = cache().lock() {
        guard.mark_persisted_if_unchanged(run, captured_seq);
    }
    Ok(())
}

#[cfg(test)]
#[path = "persistence_tests.rs"]
mod tests;
