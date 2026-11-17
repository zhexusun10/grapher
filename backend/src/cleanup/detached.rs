//! Retire a workspace under its Run lock; delete only its unique detached path
//! outside that lock. Receipts survive both Run deletion and path reuse.
use super::{Store, Target};
use crate::path_safety::real_child_path;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    pub id: String,
    pub run_id: String,
    pub target: Target,
    pub detached: bool,
}

impl Record {
    /// Reconstruct, rather than trusting an arbitrary persisted deletion path.
    /// Never inspect the original slot here: a follow-up may already own it.
    fn location(&self, data: &Path) -> Result<(PathBuf, PathBuf), String> {
        if Uuid::parse_str(&self.id).is_err()
            || Uuid::parse_str(&self.run_id).is_err()
            || !matches!(self.target, Target::Workspace { .. })
        {
            return Err("Invalid detached workspace receipt".into());
        }
        let (root, original) = self.target.location(data, &self.run_id)?;
        let destination = original
            .parent()
            .ok_or("Missing workspace parent")?
            .join(format!(".grapher-cleanup-{}", self.id));
        Ok((root, destination))
    }
}

type Tickets = HashMap<(String, String), Weak<Mutex<()>>>;
static TICKETS: OnceLock<Mutex<Tickets>> = OnceLock::new();
static WAKE: AtomicBool = AtomicBool::new(false);

fn ticket(root: &Path, id: &str) -> Result<Arc<Mutex<()>>, String> {
    let mut tickets = TICKETS
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    tickets.retain(|_, weak| weak.strong_count() > 0);
    let key = (crate::path_identity::path_key(root), id.to_string());
    if let Some(guard) = tickets.get(&key).and_then(Weak::upgrade) {
        return Ok(guard);
    }
    let guard = Arc::new(Mutex::new(()));
    tickets.insert(key, Arc::downgrade(&guard));
    Ok(guard)
}

pub(crate) fn take_wakeup() -> bool {
    WAKE.swap(false, Ordering::SeqCst)
}

/// Caller already validated ownership, sharing, source protection and event
/// generation under the Run mutex. A receipt is committed before rename; the
/// detached bit is committed before any recursive deletion is permitted.
pub(super) fn retire(
    root: &Path,
    store: &Store,
    run_id: &str,
    target: &Target,
) -> Result<(), String> {
    let Some(original) = target.resolve(root, run_id)? else {
        return Ok(());
    };
    let mut record = Record {
        id: Uuid::new_v4().to_string(),
        run_id: run_id.into(),
        target: target.clone(),
        detached: false,
    };
    let lock = ticket(root, &record.id)?;
    let guard = lock.lock().map_err(|e| e.to_string())?;
    let (parent, destination) = record.location(root)?;
    if real_child_path(&parent, &destination, false)?.is_some() {
        return Err("Detached workspace destination already exists".into());
    }
    // Use the existing, checked physical parent. Rename stays on this volume;
    // no project bytes are copied while the Run is locked.
    let destination = original
        .parent()
        .ok_or("Missing physical workspace parent")?
        .join(
            destination
                .file_name()
                .ok_or("Missing detached workspace name")?,
        );
    store.save_detached_workspace(&record)?;
    let result = (|| {
        fs::rename(&original, &destination)
            .map_err(|e| format!("Cannot retire owned workspace {}: {e}", original.display()))?;
        record.detached = true;
        store.save_detached_workspace(&record)
    })();
    // Signal only after releasing the ticket. Otherwise the worker could
    // consume the wakeup, skip this still-locked receipt, and wait 30 seconds.
    drop(guard);
    WAKE.store(true, Ordering::SeqCst);
    result
}

/// Safe with only the receipt's own lease, never the Run lock. A missing
/// destination is complete; it must NEVER cause deletion/rename of the reused
/// original path, including after a crash between deletion and receipt removal.
fn purge(root: &Path, store: &Store, mut record: Record) -> Result<(), String> {
    let (parent, destination) = record.location(root)?;
    let path = if parent.exists() {
        real_child_path(&parent, &destination, false)?
    } else {
        match fs::symlink_metadata(&parent) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            _ => return Err("Detached workspace parent is missing or redirected".into()),
        }
    };
    let Some(path) = path else {
        // If rename never happened, the original generation-scoped cleanup
        // task still owns that work. The background worker never adopts it.
        return store.forget_detached_workspace(&record.id);
    };
    if !record.detached {
        // Recovery after rename but before its completion marker. Persist the
        // marker before deleting: otherwise a second crash could be ambiguous.
        record.detached = true;
        store.save_detached_workspace(&record)?;
    }
    if store
        .cleanup_sources()?
        .iter()
        .any(|source| source.starts_with(&path))
    {
        return Err("Detached workspace contains a protected source project".into());
    }
    // Delete only the receipt's unique path; that live parent is not owned
    // by this receipt and may have been adopted or reserved by another actor.
    crate::workspace_cleanup::remove_tree(&path).map_err(|error| {
        format!(
            "Cannot remove detached workspace {}: {error}",
            path.display()
        )
    })?;
    store.forget_detached_workspace(&record.id)
}

/// Runs in the existing background retry worker (and at startup). Per-ticket
/// leases skip an in-progress rename or duplicate purge, without serializing
/// unrelated Runs or holding the database write guard over filesystem I/O.
pub(crate) fn drain(root: &Path, store: &Store) -> Result<(), String> {
    let mut first_error = None;
    for record in store.detached_workspaces()? {
        let lock = ticket(root, &record.id)?;
        let _guard = match lock.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => continue,
            Err(error) => return Err(error.to_string()),
        };
        if let Err(error) = purge(root, store, record) {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(test)]
#[path = "detached_tests.rs"]
mod tests;
