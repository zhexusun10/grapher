use super::notify_snapshot_changed;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Mutex, OnceLock},
};

/// Transient display-only activity. It lives outside the Run mutex so the
/// browser can observe long Git/directory preparation passes without blocking
/// on their I/O. Entries are keyed by Run and by a unique operation key.
/// One in-flight operation. `phase` is an optional finer-grained step of the
/// operation (for example a node workspace's compose/conflict/verify stage) so
/// the browser can report what a long preparation is actually doing instead of
/// a single generic label.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ActivityEntry {
    kind: String,
    node: String,
    phase: Option<String>,
}
type ActivityEntries = BTreeMap<String, ActivityEntry>;
type ActivityRuns = BTreeMap<String, ActivityEntries>;

#[derive(Default)]
struct ActivityBoard {
    runs: Mutex<ActivityRuns>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeActivity {
    pub(super) kind: String,
    pub(super) nodes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) phase: Option<String>,
}

static ACTIVITY: OnceLock<ActivityBoard> = OnceLock::new();

fn activity() -> &'static ActivityBoard {
    ACTIVITY.get_or_init(ActivityBoard::default)
}

fn insert_activity(run: &str, key: &str, entry: ActivityEntry) {
    let mut changed = false;
    if let Ok(mut runs) = activity().runs.lock() {
        let prev = runs
            .entry(run.into())
            .or_default()
            .insert(key.into(), entry.clone());
        changed = prev.as_ref() != Some(&entry);
    }
    if changed {
        notify_snapshot_changed(run, "");
    }
}

pub(super) fn set_activity(run: &str, key: &str, kind: &str, node: &str) {
    insert_activity(
        run,
        key,
        ActivityEntry {
            kind: kind.to_owned(),
            node: node.to_owned(),
            phase: None,
        },
    );
}

/// Advance an existing operation's phase. A missing key is a no-op so callers
/// outside the HTTP worker (fixtures, embedded use) never create a dangling
/// activity entry that no guard will clear.
pub(super) fn set_activity_phase(run: &str, key: &str, phase: &str) {
    let mut changed = false;
    if let Ok(mut runs) = activity().runs.lock() {
        if let Some(entry) = runs.get_mut(run).and_then(|entries| entries.get_mut(key)) {
            if entry.phase.as_deref() != Some(phase) {
                entry.phase = Some(phase.to_owned());
                changed = true;
            }
        }
    }
    if changed {
        notify_snapshot_changed(run, "");
    }
}

/// Node-workspace preparation phase, keyed to the same activity entry the
/// worker's `ActivityGuard` owns. Runtime calls this while composing parent
/// results or preparing a conflicted worktree.
pub(crate) fn set_prepare_phase(run: &str, execution_id: &str, phase: &str) {
    set_activity_phase(run, &format!("prepare-{execution_id}"), phase);
}

pub(super) fn clear_activity(run: &str, key: &str) {
    let mut changed = false;
    if let Ok(mut runs) = activity().runs.lock() {
        if let Some(entries) = runs.get_mut(run) {
            changed = entries.remove(key).is_some();
            if entries.is_empty() {
                runs.remove(run);
            }
        }
    }
    if changed {
        notify_snapshot_changed(run, "");
    }
}

pub(super) fn run_activity(run: &str) -> Vec<RuntimeActivity> {
    let Ok(runs) = activity().runs.lock() else {
        return Vec::new();
    };
    let Some(entries) = runs.get(run) else {
        return Vec::new();
    };
    // A phase label applies to the whole kind and its node list, so it is only
    // reported when every entry agrees. Concurrent nodes in different stages
    // fall back to the generic label instead of mislabeling one of them.
    let mut grouped: BTreeMap<String, (BTreeSet<String>, BTreeSet<Option<String>>)> =
        BTreeMap::new();
    for entry in entries.values() {
        let group = grouped.entry(entry.kind.clone()).or_default();
        if !entry.node.is_empty() {
            group.0.insert(entry.node.clone());
        }
        group.1.insert(entry.phase.clone());
    }
    grouped
        .into_iter()
        .map(|(kind, (nodes, phases))| RuntimeActivity {
            kind,
            nodes: nodes.into_iter().collect(),
            phase: if phases.len() == 1 {
                phases.into_iter().next().flatten()
            } else {
                None
            },
        })
        .collect()
}

/// Clears its activity entry on drop, including early `?` returns.
pub(super) struct ActivityGuard {
    run: String,
    key: String,
}

impl ActivityGuard {
    pub(super) fn begin(run: &str, key: &str, kind: &str, node: &str) -> Self {
        set_activity(run, key, kind, node);
        Self {
            run: run.into(),
            key: key.into(),
        }
    }
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        clear_activity(&self.run, &self.key);
    }
}
