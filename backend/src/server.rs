use crate::{
    compiler,
    engine::{parse_route_decision, run_pi, PiModelConfig, PiRequest, PiRole},
    model::*,
    runtime::{perform_with_merger, Runtime},
    snapshot_view::snapshot_metadata,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, OnceLock, Weak,
    },
    thread,
};

use uuid::Uuid;

#[path = "workspace_attachments.rs"]
mod workspace_attachments;
use workspace_attachments::{delete_workspace_attachment, write_workspace_attachment};

pub struct Service {
    runtime: Mutex<Runtime>,
    driving: AtomicBool,
    drive_signal: (Mutex<u64>, Condvar),
    planning: AtomicBool,
    extension: PathBuf,
}

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
struct RuntimeActivity {
    kind: String,
    nodes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<String>,
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

fn set_activity(run: &str, key: &str, kind: &str, node: &str) {
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
fn set_activity_phase(run: &str, key: &str, phase: &str) {
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

fn clear_activity(run: &str, key: &str) {
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

fn run_activity(run: &str) -> Vec<RuntimeActivity> {
    let Ok(runs) = activity().runs.lock() else {
        return Vec::new();
    };
    let Some(entries) = runs.get(run) else {
        return Vec::new();
    };
    // A phase label applies to the whole kind and its node list, so it is only
    // reported when every entry agrees. Concurrent nodes in different stages
    // fall back to the generic label instead of mislabeling one of them.
    let mut grouped: BTreeMap<String, (BTreeSet<String>, BTreeSet<Option<String>>)> = BTreeMap::new();
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
struct ActivityGuard {
    run: String,
    key: String,
}

impl ActivityGuard {
    fn begin(run: &str, key: &str, kind: &str, node: &str) -> Self {
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

// Keep only weak references: active workers own their service; idle runs can
// always be reconstructed from the shared event store on demand.
static RUN_SERVICES: OnceLock<
    Mutex<std::collections::HashMap<PathBuf, std::collections::HashMap<String, Weak<Service>>>>,
> = OnceLock::new();
// Active workers retain their own services; only two idle/historical services
// are pinned so repeated polls do not replay a Run on every HTTP request.
static HOT_SERVICES: OnceLock<Mutex<std::collections::VecDeque<(PathBuf, String, Arc<Service>)>>> = OnceLock::new();

fn cache_service(root: &std::path::Path, id: &str, service: Arc<Service>) -> Arc<Service> {
    if let Ok(mut cache) = HOT_SERVICES.get_or_init(Default::default).lock() {
        cache.retain(|(path, key, saved)| path != root || (key != id && !Arc::ptr_eq(saved, &service)));
        cache.push_back((root.to_owned(), id.to_owned(), service.clone()));
        while cache.len() > 2 { cache.pop_front(); }
    }
    service
}

fn invalidate_service_cache(root: &std::path::Path, id: Option<&str>) {
    if let Some(registry) = RUN_SERVICES.get() {
        if let Ok(mut registry) = registry.lock() {
            if let Some(runs) = registry.get_mut(root) {
                runs.retain(|key, _| id.is_some_and(|id| key != id));
            }
        }
    }
    if let Ok(mut cache) = HOT_SERVICES.get_or_init(Default::default).lock() {
        cache.retain(|(path, key, _)| path != root || id.is_some_and(|id| key != id));
    }
}

static SOURCE_LOCKS: OnceLock<Mutex<std::collections::HashMap<PathBuf, Weak<Mutex<()>>>>> =
    OnceLock::new();
static CANCELLED_PLANNING: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

struct PlanningCancellationGuard(String);
impl PlanningCancellationGuard {
    fn finish(&mut self, planning: &AtomicBool) {
        if let Ok(mut cancelled) = CANCELLED_PLANNING.get_or_init(Default::default).lock() {
            planning.store(false, Ordering::SeqCst);
            cancelled.remove(&self.0);
            self.0.clear();
        } else {
            planning.store(false, Ordering::SeqCst);
        }
    }
}
impl Drop for PlanningCancellationGuard {
    fn drop(&mut self) {
        if let Ok(mut cancelled) = CANCELLED_PLANNING.get_or_init(Default::default).lock() {
            cancelled.remove(&self.0);
        }
    }
}
fn check_planning_cancelled(run_id: &str) -> Result<(), String> {
    if !run_id.is_empty()
        && CANCELLED_PLANNING
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| e.to_string())?
            .contains(run_id)
    {
        return Err("Planning was stopped for this Run".into());
    }
    Ok(())
}

fn source_lock(repository: &std::path::Path) -> Result<Arc<Mutex<()>>, String> {
    let key = std::path::PathBuf::from(crate::path_identity::path_key(repository));
    let mut locks = SOURCE_LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    locks.retain(|_, weak| weak.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

/// Resolve `before` for a settled publication-merger continuation. Reclaiming a
/// successful publication's snapshot is asynchronous, so a plain folder whose
/// snapshot vanished while reading resolves to "no snapshot".
fn merger_continuation_before(worktree: &std::path::Path) -> Result<String, String> {
    if crate::workspace::is_standard_git(worktree) {
        return crate::workspace::repository_git(worktree, &["rev-parse", "HEAD"]);
    }
    let Some(shadow) = crate::workspace::shadow_repo_if_exists(worktree)? else {
        return Ok(String::new());
    };
    let git_dir = shadow.to_str().ok_or("Invalid shadow path")?;
    match crate::workspace::git(worktree, &["--git-dir", git_dir, "rev-parse", "HEAD"]) {
        Ok(head) => Ok(head),
        // The snapshot was reclaimed between the check and this read.
        Err(_) if crate::workspace::shadow_repo_if_exists(worktree)?.is_none() => {
            Ok(String::new())
        }
        Err(error) => Err(error),
    }
}

/// Lazily materialize the external shadow repository for the first dispatched
/// job of a plain-directory graph run. Git collection runs without the runtime
/// lock; the source lock serializes it with planning and other workers.
fn materialize_job_source(
    service: &Arc<Service>,
    root: &std::path::Path,
    job: &mut crate::runtime::Job,
) -> Result<(), String> {
    let repository = crate::runtime::resolve_repository(root, &job.config)?;
    let activity_key = format!("materialize-{}", job.execution.id);
    let _activity = ActivityGuard::begin(
        &job.run_id,
        &activity_key,
        "source_materialize",
        &job.execution.node,
    );
    // Hold the source lock across the freshness check, the Git collection and
    // the ownership/event record. Sibling workers of the same first batch are
    // serialized here, so the first one materializes and the rest reuse its
    // commit instead of committing again and duplicating SourceSnapshotted.
    let lock = source_lock(&repository)?;
    let _source_guard = lock.lock().map_err(|error| error.to_string())?;
    // Short lock: read the managed-environment exclusions and this Run's
    // snapshot freshness, then release before any Git work.
    let (exclusions, fresh) = {
        let runtime = service
            .runtime
            .lock()
            .map_err(|error| error.to_string())?;
        (
            runtime.exclusions()?,
            runtime.job_source_is_fresh(&repository)?,
        )
    };
    let head = crate::runtime::collect_source_snapshot(&repository, &exclusions, fresh)?;
    // Short lock: durable ownership and the one-time source snapshot event.
    service
        .runtime
        .lock()
        .map_err(|error| error.to_string())?
        .record_job_source(job, &repository, &head)
}

const SERVICE_LOOKUP_BUSY: &str =
    "Run lookup is busy; retry after the current workspace operation";

/// How long an existing-Run lookup waits for an unrelated Run to release its
/// projection lock before reporting [`SERVICE_LOOKUP_BUSY`].
///
/// A colliding reader usually finishes in milliseconds, but scheduler jitter on
/// a loaded host stretches even a short critical section by an order of
/// magnitude, so this budget cannot be a tight bound on that work. It must stay
/// far below client retry patience instead: a genuinely busy alias still fails
/// fast rather than queueing behind a long replay.
const SERVICE_LOOKUP_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

/// Polling a background Run can collide with another Run's replay. That is a
/// retryable condition, not a client error; encode it in the same shape as a
/// busy Run lock so the poller backs off without a failed HTTP request.
fn busy_snapshot_poll(command: &str, input: &str, error: &str) -> Option<serde_json::Value> {
    if command != "snapshot_if_changed" || error != SERVICE_LOOKUP_BUSY {
        return None;
    }
    let version = serde_json::from_str::<serde_json::Value>(input).ok()
        .and_then(|body| body.get("version")
            .and_then(serde_json::Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    Some(serde_json::json!({
        "version": version, "snapshot": null, "activity": [], "busy": true
    }))
}

fn remember_run_service(
    root: &std::path::Path,
    run_id: &str,
    service: Arc<Service>,
) -> Result<Arc<Service>, String> {
    RUN_SERVICES
        .get_or_init(Default::default)
        .lock()
        .map_err(|error| error.to_string())?
        .entry(root.to_owned())
        .or_default()
        .insert(run_id.to_owned(), Arc::downgrade(&service));
    Ok(cache_service(root, run_id, service))
}

fn service_for_run(
    primary: &Arc<Service>,
    run_id: &str,
    create: bool,
) -> Result<Arc<Service>, String> {
    let (root, exists, open_run) = {
        let runtime = primary.runtime.lock().map_err(|e| e.to_string())?;
        if runtime.state.run_id == run_id {
            return Ok(primary.clone());
        }
        (
            runtime.root.clone(),
            runtime.store.contains_run(run_id)?,
            runtime.run_opener(),
        )
    };
    if !create && !exists {
        return Err("Run not found".into());
    }
    // Serialize construction of this identity only. Never hold the primary or
    // registry mutex while waiting on another Run or replaying its database.
    type LookupLocks = std::collections::HashMap<(PathBuf, String), Weak<Mutex<()>>>;
    static LOOKUP_LOCKS: OnceLock<Mutex<LookupLocks>> = OnceLock::new();
    let lookup = {
        let mut locks = LOOKUP_LOCKS
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| e.to_string())?;
        locks.retain(|_, weak| weak.strong_count() > 0);
        let key = (root.clone(), run_id.to_owned());
        let lock = locks
            .get(&key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(Mutex::new(())));
        locks.insert(key, Arc::downgrade(&lock));
        lock
    };
    let _lookup = lookup.lock().map_err(|e| e.to_string())?;
    let (cached, candidates) = {
        let mut registry = RUN_SERVICES
            .get_or_init(Default::default)
            .lock()
            .map_err(|e| e.to_string())?;
        let runs = registry.entry(root.clone()).or_default();
        runs.retain(|_, weak| weak.strong_count() > 0);
        (
            runs.get(run_id).and_then(Weak::upgrade),
            runs.values().filter_map(Weak::upgrade).collect::<Vec<_>>(),
        )
    };
    if let Some(service) = cached {
        return Ok(cache_service(&root, run_id, service));
    }
    // Planning persists identities before publishing them. A new provisional
    // ID cannot alias an existing service, so it need not inspect busy Runs.
    if exists {
        let mut busy_candidates = Vec::new();
        for service in candidates {
            let mut alias = false;
            let mut busy = false;
            match service.runtime.try_lock() {
                Ok(runtime) => alias = runtime.state.run_id == run_id,
                Err(std::sync::TryLockError::WouldBlock) => busy = true,
                Err(error) => return Err(error.to_string()),
            }
            if alias {
                return remember_run_service(&root, run_id, service);
            }
            if busy {
                busy_candidates.push(service);
            }
        }
        // A poll can collide with another Run's snapshot/replay for a few
        // milliseconds. Give those short-lived readers a moment to release
        // before treating an unverifiable identity as a real alias conflict.
        if !busy_candidates.is_empty() {
            let deadline = std::time::Instant::now() + SERVICE_LOOKUP_GRACE;
            loop {
                let mut remaining = Vec::new();
                for service in busy_candidates {
                    let mut alias = false;
                    let mut busy = false;
                    match service.runtime.try_lock() {
                        Ok(runtime) => alias = runtime.state.run_id == run_id,
                        Err(std::sync::TryLockError::WouldBlock) => busy = true,
                        Err(error) => return Err(error.to_string()),
                    }
                    if alias {
                        return remember_run_service(&root, run_id, service);
                    }
                    if busy {
                        remaining.push(service);
                    }
                }
                if remaining.is_empty() {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err(SERVICE_LOOKUP_BUSY.into());
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
                busy_candidates = remaining;
            }
        }
    }
    let mut child_runtime = open_run(if exists { run_id } else { "" })?;
    if !exists {
        child_runtime.state.run_id = run_id.to_owned();
    }
    let child = Arc::new(Service {
        runtime: Mutex::new(child_runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: primary.extension.clone(),
    });
    RUN_SERVICES
        .get()
        .unwrap()
        .lock()
        .map_err(|e| e.to_string())?
        .entry(root.clone())
        .or_default()
        .insert(run_id.to_owned(), Arc::downgrade(&child));
    Ok(cache_service(&root, run_id, child))
}

// Worker logs flow through one bounded-batch event writer rather than each
// worker acquiring Runtime's mutex on every output chunk. A flush barrier
// commits all earlier output before that worker emits Finished/Failed.
enum OutputMessage {
    Text { execution_id: String, text: String },
    Flush(std::sync::mpsc::Sender<Result<(), String>>),
}

fn persist_outputs(service: Arc<Service>, rx: std::sync::mpsc::Receiver<OutputMessage>) {
    let mut failure: Option<String> = None;
    while let Ok(first) = rx.recv() {
        let mut events = Vec::with_capacity(64);
        let mut barrier = None;
        let mut next = Some(first);
        loop {
            match next.take() {
                Some(OutputMessage::Text { execution_id, text }) => {
                    events.push(EventKind::Output { execution_id, text });
                }
                Some(OutputMessage::Flush(reply)) => barrier = Some(reply),
                None => break,
            }
            if barrier.is_some() || events.len() == 64 {
                break;
            }
            next = rx.try_recv().ok();
        }
        if failure.is_none() && !events.is_empty() {
            failure = service
                .runtime
                .lock()
                .map_err(|e| e.to_string())
                .and_then(|mut runtime| runtime.emit_outputs(events))
                .err();
            if let Some(error) = &failure {
                eprintln!("Cannot persist Pi output: {error}");
            }
        }
        if let Some(reply) = barrier {
            let _ = reply.send(failure.clone().map_or(Ok(()), Err));
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    snapshot: serde_json::Value,
    config: Config,
    runs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversations: Option<Vec<crate::store::ConversationSummary>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    unavailable_conversation_ids: Vec<String>,
    data_path: String,
    repository_info: Option<crate::workspace::RepositoryInfo>,
    pub effective_role_models: std::collections::HashMap<String, String>,
    pub env_overrides: std::collections::HashMap<String, String>,
}

const PARTITIONER_PROMPT: &str = include_str!("../resources/prompts/partitioner.md");
const PLANNER_PROMPT: &str = include_str!("../resources/prompts/planner.md");
const POST_TASK_REVIEW_PROMPT: &str = "All tasks you assigned are completed. Consider your next move.";
/// Rework semantics shared by the injected Planner status block and the
/// post-task review turn so revisions price downstream re-runs correctly.
/// Both consume the same durable one-shot marker.
/// Runtime enforces the same rule in `revision_affected` regardless.
const PLANNER_REWORK_NOTE: &str = "Modifying a completed node's task re-runs that node in a fresh session and invalidates all its downstream dependents (they re-run their previous tasks with the updated dependencies' workspace states); unrelated branches keep their work.";

fn post_task_review_task(include_rework_note: bool) -> String {
    if include_rework_note {
        format!("{POST_TASK_REVIEW_PROMPT}\n\n{PLANNER_REWORK_NOTE}")
    } else {
        POST_TASK_REVIEW_PROMPT.to_string()
    }
}

fn is_post_task_review_task(task: &str) -> bool {
    // A resumed session can contain both variants, including older turns.
    task == POST_TASK_REVIEW_PROMPT || task == post_task_review_task(true)
}

// Keep the synthetic turn in Pi's own session, not in the UI transcript.
fn hidden_review_turn(line: &str, background_review: bool) -> bool {
    if !background_review { return false; }
    let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else { return false; };
    matches!(event["type"].as_str(), Some("message_start" | "message_end"))
        && event["message"]["role"] == "user"
        && event["message"]["content"].as_array().is_some_and(|parts| {
            is_post_task_review_task(&parts.iter().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("\n"))
        })
}

/// Transcript projection of one Planner engine output line. Background-review
/// user records of the synthetic turn are dropped; lifecycle records that
/// embed the conversation (`agent_end`) lose the synthetic user message while
/// keeping their own metrics and retry accounting.
fn review_transcript_line(line: &str, background_review: bool) -> Option<std::borrow::Cow<'_, str>> {
    if !background_review { return Some(std::borrow::Cow::Borrowed(line)); }
    if hidden_review_turn(line, true) { return None; }
    let Ok(mut event) = serde_json::from_str::<serde_json::Value>(line) else { return Some(std::borrow::Cow::Borrowed(line)); };
    let synthetic = |message: &serde_json::Value| -> bool {
        message.get("role").and_then(|role| role.as_str()) == Some("user")
            && message.get("content").and_then(|content| content.as_array()).is_some_and(|parts| {
                is_post_task_review_task(&parts.iter().filter_map(|part| part.get("text").and_then(|text| text.as_str()))
                    .collect::<Vec<_>>().join("\n"))
            })
    };
    let Some(messages) = event.get_mut("messages").and_then(|messages| messages.as_array_mut()) else {
        return Some(std::borrow::Cow::Borrowed(line));
    };
    let before = messages.len();
    messages.retain(|message| !synthetic(message));
    if messages.len() == before { return Some(std::borrow::Cow::Borrowed(line)); }
    let mut redacted = serde_json::to_string(&event).ok()?;
    if line.ends_with('\n') { redacted.push('\n'); }
    Some(std::borrow::Cow::Owned(redacted))
}

#[cfg(test)]
#[path = "planning_lifecycle_tests.rs"]
mod planning_lifecycle_tests;
#[cfg(test)]
#[path = "planning_repository_tests.rs"]
mod planning_repository_tests;
#[cfg(test)]
#[path = "prompt_tests.rs"]
mod prompt_tests;
#[cfg(all(test, feature = "fixture"))]
#[path = "merger_continuation_tests.rs"]
mod merger_continuation_tests;
#[cfg(test)]
#[path = "file_changes_api_tests.rs"]
mod file_changes_api_tests;
#[cfg(all(test, feature = "fixture"))]
#[path = "node_message_delivery_tests.rs"]
mod node_message_delivery_tests;
#[cfg(all(test, feature = "fixture"))]
#[path = "planner_review_tests.rs"]
mod planner_review_tests;
#[cfg(all(test, feature = "fixture"))]
#[path = "planner_workspace_tests.rs"]
mod planner_workspace_tests;
#[cfg(test)]
#[path = "transcript_page_tests.rs"]
mod transcript_page_tests;
#[cfg(test)]
#[path = "service_cache_tests.rs"]
mod service_cache_tests;
#[cfg(test)]
#[path = "service_responsiveness_tests.rs"]
mod service_responsiveness_tests;
#[cfg(test)]
#[path = "startup_prewarm_tests.rs"]
mod startup_prewarm_tests;

fn load_env_file() {
    let candidates = [
        PathBuf::from(".env"),
        crate::native::installation_root().join(".env"),
        crate::native::installation_root().join("backend/.env"),
    ];
    for path in &candidates {
        if let Ok(content) = fs::read_to_string(path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = trimmed.split_once('=') {
                    let k = k.trim();
                    let v = v.trim().trim_matches('"').trim_matches('\'');
                    if std::env::var(k).is_err() {
                        std::env::set_var(k, v);
                    }
                }
            }
            break;
        }
    }
}

fn bootstrap(service: &Arc<Service>, metadata: bool) -> Result<Bootstrap, String> {
    // The UI detects repository status separately. Git/working-tree scans are
    // not prerequisites for settings or the prewarmed sidebar summary index.
    bootstrap_projection(service, metadata, !metadata, true)
}

fn bootstrap_projection(
    service: &Arc<Service>,
    metadata: bool,
    discover_repository: bool,
    include_conversations: bool,
) -> Result<Bootstrap, String> {
    load_env_file();
    let active_config = if service.planning.load(Ordering::SeqCst) {
        let active = list_plannings(service, None)?
            .into_iter()
            .find(|summary| summary.status.as_deref() == Some("running"));
        let root = service
            .runtime
            .lock()
            .map_err(|e| e.to_string())?
            .root
            .clone();
        active
            .and_then(|summary| {
                fs::read(
                    root.join("planning")
                        .join(summary.planning_id)
                        .join("request.json"),
                )
                .ok()
            })
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| serde_json::from_value::<Config>(value["config"].clone()).ok())
    } else {
        None
    };
    let (root, snapshot, runs, event_config) = {
        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        let snapshot = if metadata {
            snapshot_metadata(&runtime.state)?
        } else {
            serde_json::to_value(&runtime.state).map_err(|e| e.to_string())?
        };
        (
            runtime.root.clone(),
            snapshot,
            runtime.store.runs()?,
            runtime.state.config.clone(),
        )
    };
    #[cfg(feature = "fixture")]
    let entrypoint = crate::native::installation_root().join("engine/entrypoint.mjs");
    // Repository status can touch an arbitrarily large/native working tree.
    // It must not hold the primary Run lock or be part of saving model defaults.
    let detected_repo = discover_repository
        .then(|| crate::workspace::detect(None).ok().flatten())
        .flatten();
    let saved_config_on_disk = {
        let path = root.join("config.json");
        if let Ok(bytes) = fs::read(&path) {
            serde_json::from_slice::<Config>(&bytes).ok()
        } else {
            None
        }
    };
    // Settings describe future Runs. Model updates for unstarted/failed nodes
    // are recorded separately; the current Run keeps its original config.
    let mut config = saved_config_on_disk
        .or(active_config)
        .or_else(|| {
            let mut cfg = event_config?;
            if !cfg.model.is_empty() && !cfg.model.contains('/') {
                cfg.model = String::new();
            }
            Some(cfg)
        })
        .unwrap_or(Config {
            repository: detected_repo
                .as_ref()
                .map(|r| r.path.clone())
                .unwrap_or_default(),
            model: String::new(),
            role_models: Default::default(),
            thinking_level: "low".into(),
            max_parallel: 0,
            max_feedback: 3,
            auto_approve: false,
            post_task_review: true, planner_write_tools: false,
            environment: None,
            #[cfg(feature = "fixture")]
            engine: "pi".into(),
            #[cfg(feature = "fixture")]
            pi_command: "node".into(),
            #[cfg(feature = "fixture")]
            pi_args: vec![entrypoint.to_string_lossy().into()],
        });
    config.max_feedback = config.max_feedback.min(3);
    // Settings are future-Run defaults, not an environment selection surface.
    // Historical Run/descriptor policies remain in their immutable projections.
    config.environment = None;
    if config.repository.is_empty() {
        if let Some(ref repo) = detected_repo {
            config.repository = repo.path.clone();
        }
    }
    let repository_info = if discover_repository && !config.repository.is_empty() {
        if let Some(ref repo) = detected_repo {
            if repo.path == config.repository {
                Some(repo.clone())
            } else {
                crate::workspace::detect(Some(std::path::Path::new(&config.repository)))
                    .ok()
                    .flatten()
            }
        } else {
            crate::workspace::detect(Some(std::path::Path::new(&config.repository)))
                .ok()
                .flatten()
        }
    } else {
        None
    };
    let mut effective_role_models = std::collections::HashMap::new();
    let mut env_overrides = std::collections::HashMap::new();

    let planner_cfg = PiModelConfig::resolve(PiRole::Planner, &config);
    let partitioner_cfg = PiModelConfig::resolve(PiRole::Partitioner, &config);
    let node_cfg = PiModelConfig::resolve(PiRole::NodeAgent, &config);
    let merger_cfg = PiModelConfig::resolve(PiRole::Merger, &config);

    effective_role_models.insert("planner".into(), planner_cfg.model);
    effective_role_models.insert("partitioner".into(), partitioner_cfg.model);
    effective_role_models.insert("nodeAgent".into(), node_cfg.model);
    effective_role_models.insert("merger".into(), merger_cfg.model);

    for (role_name, env_var) in [
        ("planner", "PLANNER_MODEL"),
        ("partitioner", "PARTITIONER_MODEL"),
        ("nodeAgent", "NODE_AGENT_MODEL"),
        ("merger", "MERGER_MODEL"),
    ] {
        if let Ok(val) = std::env::var(env_var) {
            if !val.trim().is_empty() {
                env_overrides.insert(role_name.into(), val);
            }
        }
    }

    for (role_name, role) in [
        ("partitioner", PiRole::Partitioner),
        ("planner", PiRole::Planner),
        ("nodeAgent", PiRole::NodeAgent),
        ("merger", PiRole::Merger),
    ] {
        if let Ok(value) = std::env::var(role.thinking_env_var()) {
            if !value.trim().is_empty() {
                env_overrides.insert(format!("{role_name}Thinking"), value);
            }
        }
    }

    let (conversations, unavailable_conversation_ids) = if include_conversations {
        match crate::store::conversation_summaries(&root.join("events.sqlite")) {
            Ok(catalog) => (Some(catalog.conversations), catalog.unavailable_run_ids),
            Err(error) => {
                // A display projection is not a prerequisite for settings or
                // startup. Omit it (not an authoritative empty list) on failure.
                eprintln!("[Grapher] Sidebar metadata unavailable: {error}");
                (None, Vec::new())
            }
        }
    } else {
        (None, Vec::new())
    };
    Ok(Bootstrap {
        snapshot,
        config,
        runs,
        conversations,
        unavailable_conversation_ids,
        data_path: crate::native::host_path(&root).to_string_lossy().into(),
        repository_info,
        effective_role_models,
        env_overrides,
    })
}

fn snapshot(service: &Arc<Service>) -> Result<Snapshot, String> {
    Ok(service
        .runtime
        .lock()
        .map_err(|error| error.to_string())?
        .state
        .clone())
}

fn history(run_id: String, service: &Arc<Service>) -> Result<Snapshot, String> {
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    // Labels and history fallbacks never read file changes, so do not parse a
    // potentially huge sidecar (or replay logs) just to answer them.
    runtime.store.load(&run_id)
}

fn load_run(run_id: String, service: &Arc<Service>) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish before switching runs".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    #[cfg(not(feature = "fixture"))]
    crate::engine::invalidate_warm_node();
    let snapshot = runtime.load_run(&run_id)?;
    crate::file_changes::warm_run_changes(&snapshot, &runtime.store, Some(&runtime.root));
    #[cfg(not(feature = "fixture"))]
    runtime.warm_completed_serial_node();
    Ok(snapshot)
}

fn compile_graph(graph: Graph) -> Result<Plan, Vec<compiler::Diagnostic>> {
    compiler::compile(&graph, true)
}

fn save_graph(
    graph: Graph,
    config: Config,
    run_id: Option<String>,
    service: &Arc<Service>,
) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    if let Some(expected) = run_id {
        if runtime.state.run_id != expected {
            return Err("Run changed while editing the graph".into());
        }
        runtime.edit_draft_graph(graph, config)?;
    } else {
        runtime.create(graph, config)?;
        // A new manual Graph IR is a graph even if its only node is "task".
        runtime.set_route("graph")?;
    }
    Ok(runtime.state.clone())
}

#[cfg(test)]
fn save_config(config: Config, service: &Arc<Service>) -> Result<Bootstrap, String> {
    save_config_projection(config, None, service, false)
}

/// The persisted global Auto Approve toggle, or `None` when no config has been
/// saved yet. A Planner turn consults it when it commits its plan, so toggling
/// Auto Approve while that turn runs still decides the plan it produces.
fn saved_auto_approve(runtime: &Runtime) -> Option<bool> {
    fs::read(runtime.root.join("config.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok())
        .map(|config| config.auto_approve)
}

/// A save inside a conversation owns only that Run's model selection. Keep the
/// last-saved global model defaults so other conversations and new ones do not
/// inherit this conversation's switch; all non-model settings stay global.
fn conversation_save_defaults(runtime: &Runtime, config: &Config) -> Config {
    let mut saved = config.clone();
    let global = fs::read(runtime.root.join("config.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok())
        .or_else(|| runtime.state.config.clone());
    if let Some(global) = global {
        saved.model = global.model;
        saved.thinking_level = global.thinking_level;
        saved.role_models = global.role_models;
    }
    saved
}

fn save_config_projection(
    mut config: Config,
    run_id: Option<String>,
    service: &Arc<Service>,
    metadata: bool,
) -> Result<Bootstrap, String> {
    config.environment = None; // Native admission is Runtime-owned, never a UI default.
    config.validate_model_settings()?;
    config.max_feedback = 3;
    let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    if let Some(run_id) = &run_id {
        if runtime.state.run_id != *run_id {
            return Err("Run changed while saving settings".into());
        }
        // A Planner turn publishes its Run identity before it commits the Run's
        // configuration. The repository binding is validated at commit, so a
        // settings save may still proceed while that Run is planning.
        if let Some(current) = runtime.state.config.as_ref() {
            if !same_repository_binding(&current.repository, &config.repository) {
                return Err("Settings repository does not match the selected Run".into());
            }
        }
    }
    let defaults = run_id.as_ref()
        .map(|_| conversation_save_defaults(&runtime, &config))
        .unwrap_or_else(|| config.clone());
    runtime.save_default_config(&defaults)?;
    if run_id.is_some() {
        runtime.update_node_models(&config)?;
    }
    // Auto Approve is a live boolean, not a creation-time snapshot: while it is
    // on, a Graph waiting for approval starts instead of staying pending. A Run
    // that already has Auto Approve on cannot normally be waiting (its Planner
    // and review turns approve as they commit), so this is idempotent for the
    // ordinary case and also retries after a transient approval failure.
    let approve_repository = if run_id.is_some()
        && config.auto_approve
        && !runtime.state.approved
        && runtime.state.plan_type.as_deref() == Some("graph")
        && runtime.state.phase == "awaiting_approval"
    {
        runtime.state.config.as_ref().map(|current| current.repository.clone())
    } else {
        None
    };
    drop(runtime);
    // Approval is a best-effort side effect of the save, like the other
    // post-commit enrichments here: the settings are already durable, so a
    // failed approval must not turn the save into an error or leave the client
    // with a setting it was told did not persist. The returned snapshot is the
    // source of truth, so a Run that could not be approved still shows as
    // waiting and can be approved manually, which surfaces the real reason.
    //
    // Approval records a source snapshot, and the manual Approve path serializes
    // that against every other source capture with the per-repository lock. Take
    // it before re-acquiring the Run lock rather than inverting the lock order.
    let approval = if let Some(repository) = approve_repository {
        let repository = PathBuf::from(repository);
        (|| -> Result<bool, String> {
            crate::workspace::validate_binding(&repository)?;
            let lock = source_lock(&repository)?;
            let _guard = lock.lock().map_err(|e| e.to_string())?;
            let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            // The Run may have changed while the locks were released; re-check.
            if run_id.as_deref() == Some(runtime.state.run_id.as_str())
                && config.auto_approve
                && !runtime.state.approved
                && runtime.state.plan_type.as_deref() == Some("graph")
                && runtime.state.phase == "awaiting_approval"
            {
                runtime.approve()?;
                Ok(true)
            } else {
                Ok(false)
            }
        })()
    } else {
        Ok(false)
    };
    match approval {
        Ok(true) => drive(service.clone()),
        Ok(false) => {}
        Err(error) => eprintln!(
            "[Grapher] Auto Approve saved but could not start Run {}: {error}",
            run_id.as_deref().unwrap_or_default()
        ),
    }
    #[cfg(not(feature = "fixture"))]
    {
        crate::engine::invalidate_warm_node();
        crate::provider_auth::warm();
        crate::engine::warm_planning_engines(config);
    }
    // Saving settings must not depend on a global sidebar read after commit.
    bootstrap_projection(service, metadata, false, false)
}

/// Fold one streamed role line into a Planner/Partitioner metrics accumulator.
///
/// Returns whether the line moved a counter the live session panel reads, so
/// callers can publish a progress update at assistant-message boundaries
/// instead of on every timestamped delta. Tool counts are folded but do not
/// publish on their own: the live session panel never shows them, so a durable
/// record would only bloat the log. `parse_planning_role_metrics` replays a
/// whole log through the same fold, so the live and final views agree.
fn accumulate_planning_role_line(metrics: &mut PlanningRoleMetrics, line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("[stderr]") {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return false;
    };
    if let Some(ts) = value.get("grapherReceivedAt").or_else(|| value.get("timestamp")) {
        let ts_str = if let Some(s) = ts.as_str() {
            s.to_string()
        } else if let Some(n) = ts.as_u64() {
            format!("{n}")
        } else {
            String::new()
        };
        if !ts_str.is_empty() {
            if metrics.session_start.is_none() {
                metrics.session_start = Some(ts_str.clone());
            }
            metrics.last_event = Some(ts_str);
        }
    }
    match value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
    {
        "grapher_process_exited" => {
            if let Some(elapsed) = value.get("elapsedMs").and_then(|v| v.as_f64()) {
                metrics.duration_seconds += elapsed / 1000.0;
            }
            false
        }
        // Every role process reports the Pi session it appends to, so a
        // resumed Planner turn stays in the same session bucket.
        "grapher_process_started" => {
            if let Some(id) = value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .filter(|id| !id.is_empty())
            {
                metrics.session_id = Some(id.to_string());
                return true;
            }
            false
        }
        "message_end" => {
            if let Some(msg) = value.get("message") {
                if msg.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                    metrics.assistant_messages += 1;
                    if let Some(u) = msg.get("usage") {
                        let message = TokenUsage::from_message_usage(u);
                        // An aborted turn reports usage without a prompt; keep
                        // the last turn that actually read a context.
                        let prompt = message.context_tokens();
                        if prompt > 0 {
                            metrics.context_tokens = prompt;
                            metrics.context_peak = metrics.context_peak.max(prompt);
                        }
                        metrics.usage.accumulate(&message);
                    }
                    return true;
                }
            }
            false
        }
        "tool_execution_start" => {
            metrics.tools += 1;
            false
        }
        "tool_execution_end" => {
            if value
                .get("isError")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                metrics.tool_errors += 1;
            }
            false
        }
        _ => false,
    }
}

pub fn parse_planning_role_metrics(model: &str, log: &str) -> PlanningRoleMetrics {
    let mut metrics = PlanningRoleMetrics {
        model: model.to_string(),
        ..Default::default()
    };
    for line in log.lines() {
        accumulate_planning_role_line(&mut metrics, line);
    }
    if metrics.duration_seconds == 0.0 {
        if let (Some(start), Some(end)) = (
            metrics.session_start.as_deref().and_then(|s| s.parse::<u64>().ok()),
            metrics.last_event.as_deref().and_then(|s| s.parse::<u64>().ok()),
        ) {
            metrics.duration_seconds = end.saturating_sub(start) as f64 / 1000.0;
        }
    }
    metrics
}

pub fn validate_planning_preflight(config: &Config, mode: Option<&str>) -> Result<(), String> {
    #[cfg(not(feature = "fixture"))]
    {
        // Cover unsaved/request-specific bindings too. Preparation can overlap
        // provider validation and Auto routing; no project snapshot is taken.
        if mode != Some("serial") {
            crate::native::warm_graph_runtime(PathBuf::from(&config.repository));
        }
        if mode == Some("graph") {
            crate::native::require_graph_execution()?;
        }
    }
    validate_planning_models_preflight(config, mode, || {
        #[cfg(not(feature = "fixture"))]
        {
            crate::provider_auth::request(serde_json::json!({
                "version": 1,
                "operation": "catalog",
                "refresh": false
            }))
            .ok()
        }
        #[cfg(feature = "fixture")]
        {
            None
        }
    })
}

fn validate_planning_models_preflight(
    config: &Config,
    mode: Option<&str>,
    fetch_catalog: impl Fn() -> Option<serde_json::Value>,
) -> Result<(), String> {
    config.validate_model_settings()?;
    if config.environment.is_some() && mode != Some("graph") {
        return Err("Managed environments require explicit Graph routing; Auto/Serial are not silently changed".into());
    }
    let need_partitioner = mode.is_none();
    let need_planner = mode != Some("serial");
    // Keep validation order and failure behavior, but reuse one catalog response
    // when both roles need checking. Check each model's format before its lookup.
    let catalog = std::cell::OnceCell::new();

    if need_partitioner {
        let partitioner_cfg = PiModelConfig::resolve(PiRole::Partitioner, config);
        validate_role_model_preflight(
            PiRole::Partitioner,
            &partitioner_cfg.model,
            &catalog,
            &fetch_catalog,
        )?;
    }
    if need_planner {
        let planner_cfg = PiModelConfig::resolve(PiRole::Planner, config);
        validate_role_model_preflight(
            PiRole::Planner,
            &planner_cfg.model,
            &catalog,
            &fetch_catalog,
        )?;
    }
    // Explicit per-instance settings must also be checked before approving
    // Serial or handing a Graph to the user, not only when a node starts.
    if config.role_models.contains_key("nodeAgent") {
        let node_cfg = PiModelConfig::resolve(PiRole::NodeAgent, config);
        validate_role_model_preflight(PiRole::NodeAgent, &node_cfg.model, &catalog, &fetch_catalog)?;
    }
    Ok(())
}

fn validate_role_model_preflight(
    role: PiRole,
    model: &str,
    _catalog: &std::cell::OnceCell<Option<serde_json::Value>>,
    _fetch_catalog: &impl Fn() -> Option<serde_json::Value>,
) -> Result<(), String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Err(format!(
            "Pre-flight check failed: {} model is not configured. Please select or specify a model in settings.",
            role.name()
        ));
    }
    if !trimmed.contains('/') {
        return Err(format!(
            "Pre-flight check failed: {} model '{}' is missing a provider prefix (e.g. 'openai/{}' or 'opencode-go/{}'). Please specify the fully qualified provider/model identifier in settings.",
            role.name(),
            trimmed,
            trimmed,
            trimmed
        ));
    }
    let provider_id = trimmed.split('/').next().unwrap_or("");
    if provider_id.is_empty() {
        return Err(format!(
            "Pre-flight check failed: Invalid model identifier '{}'.",
            trimmed
        ));
    }

    #[cfg(not(feature = "fixture"))]
    {
        let catalog = _catalog.get_or_init(_fetch_catalog);
        if let Some(resp) = catalog {
            if let Some(providers) = resp
                .get("result")
                .and_then(|r| r.get("providers"))
                .and_then(|p| p.as_array())
            {
                if let Some(prov) = providers
                    .iter()
                    .find(|p| p.get("id").and_then(|i| i.as_str()) == Some(provider_id))
                {
                    let is_configured = prov
                        .get("configured")
                        .and_then(|c| c.as_bool())
                        .unwrap_or(false);
                    if !is_configured {
                        return Err(format!(
                            "Pre-flight check failed: Provider '{}' for model '{}' is not authenticated. Please configure API credentials or log in before starting planning.",
                            provider_id,
                            trimmed
                        ));
                    }
                }
            }
        }
    }

    Ok(())
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    const TABLE: [i8; 256] = {
        let mut t = [-1i8; 256];
        let mut i = 0usize;
        while i < 26 {
            t[(b'A' + i as u8) as usize] = i as i8;
            i += 1;
        }
        let mut i = 0usize;
        while i < 26 {
            t[(b'a' + i as u8) as usize] = (26 + i) as i8;
            i += 1;
        }
        let mut i = 0usize;
        while i < 10 {
            t[(b'0' + i as u8) as usize] = (52 + i) as i8;
            i += 1;
        }
        t[b'+' as usize] = 62;
        t[b'/' as usize] = 63;
        t
    };
    let clean: Vec<u8> = input
        .bytes()
        .filter(|&b| !b.is_ascii_whitespace())
        .collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &b in &clean {
        if b == b'=' {
            break;
        }
        let val = TABLE[b as usize];
        if val < 0 {
            continue;
        }
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

fn planner_node_status(snapshot: &Snapshot) -> String {
    let mut text = String::from("Current graph node status:\n");
    for node in &snapshot.graph.nodes {
        if let Some(state) = snapshot.nodes.get(&node.name) {
            let status_desc = if snapshot.is_node_user_paused(&node.name) {
                "paused (manually paused by user)".to_string()
            } else if state.status == "failed" {
                if let Some(err) = &state.error {
                    let first_line = err.lines().next().unwrap_or("").trim();
                    if !first_line.is_empty() {
                        let truncated = if first_line.chars().count() > 80 {
                            format!("{}...", first_line.chars().take(80).collect::<String>())
                        } else {
                            first_line.to_string()
                        };
                        format!("failed (error: {})", truncated)
                    } else {
                        "failed".to_string()
                    }
                } else {
                    "failed".to_string()
                }
            } else {
                state.status.clone()
            };
            text.push_str(&format!("- {}: {}\n", node.name, status_desc));
        }
    }
    text
}

fn planner_rework_note_pending(snapshot: &Snapshot, revision_run_id: Option<&str>) -> bool {
    revision_run_id == Some(snapshot.run_id.as_str())
        && snapshot.approved
        && snapshot.plan_type.as_deref() == Some("graph")
        && !snapshot.events.iter().any(|event| {
            matches!(event.kind, EventKind::PlannerReworkNoteInjected)
        })
}

/// Planner transport context narrates an executing Graph. A draft awaiting
/// approval has no execution to report, and a finished Graph has no work left
/// to coordinate, so those turns carry only the user's instruction.
fn planner_followup_context_required(snapshot: &Snapshot) -> bool {
    snapshot.approved
        && snapshot.phase != "awaiting_approval"
        && snapshot.graph.nodes.iter().any(|node| {
            snapshot
                .nodes
                .get(&node.name)
                .is_none_or(|state| state.status != "completed")
        })
}

fn planner_workspace_label(snapshot: &Snapshot, selected_node: Option<&str>) -> String {
    selected_node
        .or_else(|| {
            snapshot
                .planning
                .as_ref()
                .and_then(|planning| planning.workspace_execution_id.as_deref())
                .and_then(|execution_id| snapshot.executions.iter().find(|execution| execution.id == execution_id))
                .map(|execution| execution.node.as_str())
        })
        .unwrap_or("source")
        .to_string()
}

fn planner_followup_prompt_for_workspace(
    instruction: &str,
    workspace_node: Option<&str>,
    snapshot: &Snapshot,
    include_rework_note: bool,
    include_workspace_move: bool,
    workspace_notice: Option<&str>,
) -> String {
    if !planner_followup_context_required(snapshot) {
        return instruction.to_string();
    }
    let workspace = planner_workspace_label(snapshot, workspace_node);
    let move_instruction = include_workspace_move.then_some(
        " You can use the switch_workspace tool to move to another node's latest workspace state.",
    ).unwrap_or("");
    let notice = workspace_notice
        .map(|notice| format!("\n{notice}"))
        .unwrap_or_default();
    let note = include_rework_note
        .then_some(format!("\n{PLANNER_REWORK_NOTE}"))
        .unwrap_or_default();
    format!(
        "You are now at {}'s workspace.{}{}\n{}{}\n{}",
        workspace,
        move_instruction,
        notice,
        planner_node_status(snapshot),
        note,
        instruction,
    )
}

#[cfg(test)]
fn planner_followup_prompt(
    instruction: &str,
    revision_run_id: Option<&str>,
    snapshot: &Snapshot,
) -> String {
    if revision_run_id == Some(snapshot.run_id.as_str())
        && snapshot.approved
        && snapshot.plan_type.as_deref() == Some("graph")
    {
        planner_followup_prompt_for_workspace(instruction, None, snapshot, true, false, None)
    } else {
        instruction.to_string()
    }
}

/// Planning attempts have separate logs/graph files, but a run has exactly one
/// Planner conversation. Older runs kept the Pi session in their first planning
/// attempt; manual graphs (and attempts without a persisted session) use a
/// dedicated run-scoped directory instead.
fn stored_planner_session_id(
    directory: &std::path::Path,
    repository: &std::path::Path,
    workspace: &std::path::Path,
    expected: &str,
) -> Result<Option<String>, String> {
    if !directory.is_dir() {
        return Ok(None);
    }
    let repository = repository
        .canonicalize()
        .map_err(|error| error.to_string())?;
    // A previously selected checkout may have been reclaimed after publication.
    // Its recorded layout/identity still permits rebinding the same conversation.
    let erased_workspace = (|| -> Result<Option<String>, String> {
        let Some(leaf) = workspace.file_name().and_then(|name| name.to_str()) else { return Ok(None); };
        let Some(owner_dir) = workspace.parent() else { return Ok(None); };
        let Some(owner) = owner_dir.file_name().and_then(|name| name.to_str()) else { return Ok(None); };
        let Some(bucket) = owner_dir.parent() else { return Ok(None); };
        let legacy = bucket.file_name().is_some_and(|name| name == ".grapher-workspaces")
            && leaf == expected && Uuid::parse_str(leaf).is_ok();
        let node = bucket.file_name().is_some_and(|name| name == ".grapher-worktrees")
            && leaf.get(leaf.len().saturating_sub(36)..).is_some_and(|id| Uuid::parse_str(id).is_ok());
        if Uuid::parse_str(owner).is_err() || !(legacy || node) { return Ok(None); }
        let Some(parent) = bucket.parent().and_then(|parent| parent.canonicalize().ok()) else { return Ok(None); };
        let recorded = parent.join(bucket.file_name().ok_or("Missing workspace bucket")?).join(owner).join(leaf);
        if crate::path_safety::real_child_path(&parent, &recorded, false)?.is_some() {
            return Ok(None);
        }
        Ok(Some(session_path_identity(workspace)))
    })()?;
    let workspace = workspace.canonicalize().ok();
    let mut ids = std::collections::BTreeSet::new();
    let mut found_file = false;
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path().extension().is_none_or(|ext| ext != "jsonl")
            || !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
        {
            continue;
        }
        found_file = true;
        // Pi's first JSONL entry is the session header. A corrupt or foreign
        // session must not silently start a second conversation.
        let mut header = String::new();
        BufReader::new(fs::File::open(entry.path()).map_err(|error| error.to_string())?)
            .take(8192)
            .read_line(&mut header)
            .map_err(|error| error.to_string())?;
        let value: serde_json::Value = serde_json::from_str(&header)
            .map_err(|_| "Invalid Planner session header".to_string())?;
        let id = value
            .get("id")
            .and_then(|id| id.as_str())
            .ok_or("Missing Planner session ID")?;
        let cwd = value
            .get("cwd")
            .and_then(|cwd| cwd.as_str())
            .ok_or("Missing Planner session repository")?;
        if value.get("type").and_then(|kind| kind.as_str()) != Some("session")
            || Uuid::parse_str(id).is_err()
            || !(crate::path_identity::same_path(std::path::Path::new(cwd), &repository)
                || workspace.as_deref().is_some_and(|workspace| crate::path_identity::same_path(std::path::Path::new(cwd), workspace))
                || erased_workspace.as_ref().is_some_and(|path| *path == session_path_identity(std::path::Path::new(cwd))))
        {
            return Err("Planner session belongs to another repository or is invalid".into());
        }
        ids.insert(id.to_string());
    }
    if !found_file {
        return Ok(None);
    }
    if ids.contains(expected) {
        return Ok(Some(expected.to_string()));
    }
    if ids.len() == 1 {
        return Ok(ids.into_iter().next());
    } // Legacy session with a random Pi ID.
    Err("Multiple Planner conversations found for one run; cannot select one safely".into())
}

fn session_path_identity(path: &std::path::Path) -> String {
    crate::path_identity::path_key(path)
}

/// Keep the same Pi identity/history when the Planner's cwd changes between
/// turns. Pi matches a custom-session-dir resume by the literal header cwd
/// (`SessionManager.findById` -> `sessionCwdMatches`), and the resumed child's
/// `process.cwd()` spelling is platform-dependent: Windows keeps the launched
/// path as-is (8.3 short names are not expanded), while Unix resolves
/// symlinks through `getcwd`. Record exactly that spelling.
fn rebind_planner_session(directory: &std::path::Path, id: &str, workspace: &std::path::Path) -> Result<(), String> {
    crate::session_branch::rebind_session_cwd_by_header(directory, id, workspace)
}

#[cfg(all(test, feature = "fixture"))]
fn planner_session_directory(
    root: &std::path::Path,
    attempt: &std::path::Path,
    repository: &std::path::Path,
    revision: Option<&Snapshot>,
) -> Result<(PathBuf, String), String> {
    planner_session_directory_for_workspace(root, attempt, repository, repository, revision)
}

/// Planner attempts are durable as soon as their first event is written. A
/// failed or stopped first turn keeps its Pi conversation without committing
/// a graph, so history edits must not require `created`/`graph_revised`.
fn event_planner_id(kind: &EventKind) -> Option<&str> {
    match kind {
        EventKind::Created {
            planning_id: Some(id),
            ..
        }
        | EventKind::GraphRevised { planning_id: id, .. } => Some(id),
        EventKind::Created {
            planning: Some(planning),
            ..
        } => Some(&planning.planning_id),
        EventKind::PlanningStarted { planning, .. }
        | EventKind::PlannerWorkspaceSelected { planning }
        | EventKind::PlannerTurnProgress { planning }
        | EventKind::PlannerReviewStarted { planning }
        | EventKind::PlannerReviewFinished { planning, .. }
        | EventKind::PlannerTurnAborted { planning }
        | EventKind::PlanningFailed { planning } => Some(&planning.planning_id),
        _ => None,
    }
}

fn planner_session_directory_for_workspace(
    root: &std::path::Path,
    attempt: &std::path::Path,
    repository: &std::path::Path,
    workspace: &std::path::Path,
    revision: Option<&Snapshot>,
) -> Result<(PathBuf, String), String> {
    let Some(snapshot) = revision else {
        let id = attempt
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid planning identity")?;
        return Ok((attempt.join("planner-session"), id.to_string()));
    };
    if Uuid::parse_str(&snapshot.run_id).is_err() {
        return Err("Invalid run identity for Planner session".into());
    }
    // The session header follows the latest cwd, while the conversation stays
    // in its original directory. Accept only source or recorded turn workspaces.
    let stored = |session: &std::path::Path, original: &std::path::Path, id: &str| {
        let candidates = snapshot.events.iter().rev().filter_map(|event| match &event.kind {
            EventKind::PlannerWorkspaceSelected { planning } => planning.worktree.as_deref().map(std::path::Path::new),
            _ => None,
        }).chain(std::iter::once(original));
        let mut error = None;
        for cwd in candidates {
            match stored_planner_session_id(session, repository, cwd, id) {
                Ok(value) => return Ok(value),
                Err(err) => error = Some(err),
            }
        }
        Err(error.unwrap_or_else(|| "Invalid Planner session".into()))
    };
    // Prefer the oldest surviving conversation, not the latest attempt. Only a
    // committed attempt makes a missing session unrecoverable: an attempt that
    // never launched Pi legitimately has no session yet.
    let mut committed_planner_attempt = false;
    for event in &snapshot.events {
        let Some(id) = event_planner_id(&event.kind) else { continue; };
        if matches!(&event.kind,
            EventKind::Created { planning_id: Some(_), .. } | EventKind::GraphRevised { .. })
        {
            committed_planner_attempt = true;
        }
        if Uuid::parse_str(id).is_err() {
            continue;
        }
        let previous = root.join("planning").join(id);
        let session = previous.join("planner-session");
        let previous_workspace = fs::read_to_string(previous.join("planner-workspace"))
            .map(PathBuf::from).unwrap_or_else(|_| workspace.to_path_buf());
        if let Some(pi_id) = stored(&session, &previous_workspace, id)? {
            return Ok((session, pi_id));
        }
    }
    let session = root.join("planner-sessions").join(&snapshot.run_id);
    if let Some(id) = stored(&session, workspace, &snapshot.run_id)?
    {
        return Ok((session, id));
    }
    // A committed Planner turn with a missing session cannot safely start a
    // new conversation. Fixtures do not persist Pi session files.
    if committed_planner_attempt && !cfg!(feature = "fixture") {
        return Err("Planner conversation is missing; cannot silently start a new session".into());
    }
    Ok((session, snapshot.run_id.clone()))
}

fn plan_goal_internal(
    goal: String,
    config: Config,
    mode: Option<&str>,
    images: Option<Vec<crate::model::ImageAttachment>>,
    revision_run_id: Option<String>,
    service: &Arc<Service>,
    on_partitioner_line: impl FnMut(&str),
    on_route: impl FnMut(&Route),
    on_planner_line: impl FnMut(&str),
) -> Result<Snapshot, (String, Option<PlanningSummary>)> {
    plan_goal_internal_with_started(goal, config, mode, images, revision_run_id, service,
        false, |_| {}, on_partitioner_line, on_route, on_planner_line)
}

fn plan_goal_internal_with_started(
    goal: String,
    config: Config,
    mode: Option<&str>,
    images: Option<Vec<crate::model::ImageAttachment>>,
    revision_run_id: Option<String>,
    service: &Arc<Service>,
    background_review: bool,
    mut on_started: impl FnMut(&str),
    mut on_partitioner_line: impl FnMut(&str),
    mut on_route: impl FnMut(&Route),
    mut on_planner_line: impl FnMut(&str),
) -> Result<Snapshot, (String, Option<PlanningSummary>)> {
    if goal.trim().is_empty() {
        return Err(("Enter a goal".into(), None));
    }
    let mut config = config;
    config.max_feedback = config.max_feedback.min(3);
    #[cfg(feature = "fixture")]
    if config.engine != "pi" {
        return Err((
            "Automatic planning requires the Execution Instance Engine".into(),
            None,
        ));
    }
    if revision_run_id.is_none() && service.driving.load(Ordering::SeqCst) {
        return Err(("Another operation is running".into(), None));
    }
    // Allow up to 1.5s if an explicitly interrupted planning process is terminating.
    let mut acquired = false;
    for _ in 0..30 {
        if !service.planning.swap(true, Ordering::SeqCst) {
            acquired = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if !acquired {
        return Err(("Another operation is running".into(), None));
    }
    let service = service.clone();
    let cleanup = service.clone();
    let mut resume_after = false;
    let owner = match service.runtime.lock() {
        Ok(runtime) => {
            if revision_run_id.is_none()
                && (runtime.state.run_id.is_empty() || !runtime.state.events.is_empty())
            {
                Uuid::new_v4().to_string()
            } else {
                runtime.state.run_id.clone()
            }
        },
        Err(error) => {
            cleanup.planning.store(false, Ordering::SeqCst);
            return Err((error.to_string(), None));
        }
    };
    let mut cancellation_guard = PlanningCancellationGuard(owner.clone());
    let result = crate::process_control::with_owner(&owner, || {
        (|| {
            let original_graph = if let Some(ref run_id) = revision_run_id {
                if mode != Some("graph") {
                    return Err(("Graph revisions require graph mode".into(), None));
                }
                let runtime = service
                    .runtime
                    .lock()
                    .map_err(|error| (error.to_string(), None))?;
                if runtime.state.run_id != *run_id
                    || runtime.state.plan_type.as_deref() != Some("graph")
                    || runtime.state.config.as_ref().map(|c| c.repository.as_str())
                        != Some(config.repository.as_str())
                    || matches!(
                        runtime.state.phase.as_str(),
                        "publishing" | "merging" | "publication_failed"
                    )
                {
                    return Err(("Graph is no longer available for revision".into(), None));
                }
                Some(runtime.state.graph.clone())
            } else {
                None
            };
            let service = service.clone();
            let planning_start = std::time::Instant::now();
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let root = service
                .runtime
                .lock()
                .map_err(|error| (error.to_string(), None))?
                .root
                .clone();
            let repository = PathBuf::from(&config.repository);
            let repo_str = repository.to_string_lossy().to_string();
            crate::workspace::validate_binding(&repository).map_err(|e| (e, None))?;
            let lock = source_lock(&repository).map_err(|e| (e, None))?;
            {
                let _source_guard = lock.lock().map_err(|e| (e.to_string(), None))?;
                crate::workspace::validate_binding(&repository).map_err(|error| (error, None))?;
            }
            check_planning_cancelled(&owner).map_err(|e| (e, None))?;
            validate_planning_preflight(&config, mode).map_err(|error| (error, None))?;
            let planning_id = Uuid::new_v4().to_string();
            let directory = root.join("planning").join(&planning_id);
            // Persist provisional ownership before the first filesystem write.
            // Startup can reclaim an attempt that never reached PlanningStarted.
            service.runtime.lock().map_err(|error| (error.to_string(), None))?.store
                .remember_cleanup_targets(&owner, &std::collections::BTreeSet::from([
                    crate::cleanup::Target::data("planning", &planning_id),
                ])).map_err(|error| (error, None))?;
            fs::create_dir_all(&directory).map_err(|error| (error.to_string(), None))?;
            fs::write(
                directory.join("request.json"),
                serde_json::to_vec(&serde_json::json!({
                    "goal": goal, "config": config, "mode": mode, "revisionRunId": revision_run_id,
                    "runId": owner, "backgroundReview": background_review
                }))
                .map_err(|e| (e.to_string(), None))?,
            )
            .map_err(|e| (e.to_string(), None))?;
            // Publish identity before launching Pi; a browser connection does not own planning.
            let mut running = PlanningSummary {
                planning_id: planning_id.clone(),
                status: Some("running".into()),
                created_at: Some(now_ms),
                repository: Some(repo_str.clone()),
                plan_type: mode.filter(|mode| matches!(*mode, "graph" | "serial")).map(str::to_owned),
                goal: Some(if background_review { original_graph.as_ref().map(|graph| graph.original_goal.clone()).unwrap_or_else(|| goal.clone()) } else { goal.clone() }),
                run_id: Some(owner.clone()),
                roles: ["partition", "planner"]
                    .into_iter()
                    .map(|role| (role.to_string(), PlanningRoleMetrics::default()))
                    .collect(),
                ..Default::default()
            };
            write_planning_summary(&directory, &running).map_err(|error| (error, None))?;
            if revision_run_id.is_none() {
                let mut runtime = service.runtime.lock().map_err(|e| (e.to_string(), None))?;
                runtime.state = Snapshot { run_id: owner.clone(), ..Default::default() };
                runtime.emit(EventKind::PlanningStarted {
                    goal: goal.clone(), config: config.clone(), planning: running.clone(),
                    plan_type: mode.filter(|mode| matches!(*mode, "graph" | "serial")).map(str::to_owned),
                }).map_err(|error| (error, None))?;
                runtime.store.select_run(Some(&owner)).map_err(|error| (error, None))?;
            }
            if background_review {
                let mut runtime = service.runtime.lock().map_err(|e| (e.to_string(), None))?;
                if runtime.state.phase != "completed" || runtime.state.stop_requested
                    || !runtime.state.nodes.values().all(|node| node.status == "completed") {
                    return Err(("Run is no longer ready for post-task review".into(), None));
                }
                runtime.emit(EventKind::PlannerReviewStarted { planning: running.clone() })
                    .map_err(|error| (error, None))?;
            }
            // Publish only an identity whose request and initial event are durable.
            on_started(&owner);
            let mut image_file_args: Vec<String> = Vec::new();
            if let Some(ref imgs) = images {
                if !imgs.is_empty() {
                    let attach_dir = directory.join("attachments");
                    let _ = fs::create_dir_all(&attach_dir);
                    for (idx, img) in imgs.iter().enumerate() {
                        let file_path = planning_attachment_path(&attach_dir, idx, img);
                        if let Some(bytes) = decode_base64(&img.data) {
                            if fs::write(&file_path, bytes).is_ok() {
                                if let Ok(canon) = file_path.canonicalize() {
                                    image_file_args.push(format!("@{}", canon.to_string_lossy()));
                                } else {
                                    image_file_args
                                        .push(format!("@{}", file_path.to_string_lossy()));
                                }
                            }
                        }
                    }
                }
            }
            let mut planner_execution_id: Option<String> = None;
            let plan_outcome = (|| -> Result<Snapshot, String> {
                let route_path = directory.join("route.json");
                let (route, partition_metrics) = match mode {
                    Some("serial") => {
                        let route = Route {
                            plan_type: "serial".into(),
                        };
                        fs::write(&route_path, serde_json::to_string_pretty(&route).unwrap())
                            .map_err(|error| error.to_string())?;
                        on_route(&route);
                        (route, PlanningRoleMetrics::default())
                    }
                    Some("graph") => {
                        let route = Route {
                            plan_type: "graph".into(),
                        };
                        fs::write(&route_path, serde_json::to_string_pretty(&route).unwrap())
                            .map_err(|error| error.to_string())?;
                        on_route(&route);
                        (route, PlanningRoleMetrics::default())
                    }
                    _ => {
                        let partitioner_system_prompt = std::env::var("PARTITIONER_SYSTEM_PROMPT")
                            .unwrap_or_else(|_| PARTITIONER_PROMPT.trim().to_string());
                        let task = goal.clone();
                        let partitioner_model_cfg =
                            PiModelConfig::resolve(PiRole::Partitioner, &config);
                        let partitioner_config = partitioner_model_cfg.effective_config(&config);
                        let mut partitioner_extra_args = vec!["--no-tools", "--no-context-files"];
                        if let Some(thinking) = &partitioner_model_cfg.thinking {
                            partitioner_extra_args.push("--thinking");
                            partitioner_extra_args.push(thinking.as_str());
                        }
                        for arg in &image_file_args {
                            partitioner_extra_args.push(arg.as_str());
                        }
                        let mut log = String::new();
                        let mut partition_log = fs::File::create(directory.join("partition.jsonl"))
                            .map_err(|e| e.to_string())?;
                        let mut log_error = None;
                        let partition_start = std::time::Instant::now();
                        let partition_result = run_pi(
                            PiRequest {
                                role: PiRole::Partitioner,
                                config: &partitioner_config,
                                cwd: &repository,
                                task: &task,
                                session_dir: &directory.join("partition-session"),
                                extension: None,
                                tools: Some(""),
                                session_id: None,
                                extra_args: partitioner_extra_args,
                                environment: vec![
                                    ("GRAPHER_MODE", "partition".into()),
                                    ("GRAPHER_GRAPH_PATH", route_path.to_string_lossy().into()),
                                ],
                                system_prompt: Some(&partitioner_system_prompt),
                                images: None,
                            },
                            |text| {
                                if let Err(error) = partition_log.write_all(text.as_bytes()) {
                                    log_error = Some(error.to_string());
                                }
                                log.push_str(&text);
                                on_partitioner_line(&text);
                            },
                        );
                        let partition_wall_sec = partition_start.elapsed().as_secs_f64();
                        if let Some(error) = log_error {
                            return Err(format!("Cannot persist planning output: {error}"));
                        }
                        let mut partition_metrics =
                            parse_planning_role_metrics(&partitioner_config.model, &log);
                        if partition_metrics.duration_seconds == 0.0 {
                            partition_metrics.duration_seconds = partition_wall_sec;
                        }
                        // A failed engine call is not a routing decision. In particular, do not
                        // turn authentication/provider failures into an auto-approved serial run.
                        let output = partition_result
                            .map_err(|error| format!("Partitioner failed: {error}"))?;
                        let route = parse_route_decision(&output);
                        fs::write(&route_path, serde_json::to_string_pretty(&route).unwrap())
                            .map_err(|error| error.to_string())?;
                        on_route(&route);
                        eprintln!(
                        "[Grapher] [Router] Goal routed as '{}' in {:.2}s (tokens: in={}, out={})",
                        route.plan_type, partition_metrics.duration_seconds, partition_metrics.usage.input, partition_metrics.usage.output
                    );
                        (route, partition_metrics)
                    }
                };
                running.plan_type = Some(route.plan_type.clone());
                let _ = write_planning_summary(&directory, &running);
                if revision_run_id.is_none() {
                    service.runtime.lock().map_err(|e| e.to_string())?
                        .emit(EventKind::Routed { plan_type: route.plan_type.clone() })?;
                }
                // Do not spend Planner tokens on a Graph that cannot run in this
                // environment (e.g. a Harbor container without user namespaces).
                #[cfg(not(feature = "fixture"))]
                if route.plan_type == "graph" {
                    crate::native::require_graph_execution()?;
                }
                let mut planner_metrics = None;
                let graph = match route.plan_type.as_str() {
                    "serial" => Graph {
                        original_goal: goal.clone(),
                        nodes: vec![Node {
                            name: "task".into(),
                            task: goal.clone(),
                        }],
                        edges: Vec::new(),
                    },
                    "graph" => {
                        // The planning gate prevents new dispatch/publication.
                        let (selected, planner_context_required) = if revision_run_id.is_some() && !background_review {
                            check_planning_cancelled(&owner)?;
                            let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
                            if runtime.state.run_id != owner { return Err("Run changed during workspace selection".into()); }
                            let context_required = planner_followup_context_required(&runtime.state);
                            let selected = if context_required { runtime.planner_workspace()? } else { None };
                            (selected, context_required)
                        } else { (None, false) };
                        let planner_workspace_targets = if planner_context_required {
                            service
                                .runtime
                                .lock()
                                .map_err(|e| e.to_string())?
                                .planner_workspace_targets(selected.as_ref().map(|execution| execution.node.as_str()))?
                        } else {
                            serde_json::json!({})
                        };
                        let planner_workspace_targets_file = directory.join("planner-workspaces.json");
                        fs::write(&planner_workspace_targets_file, planner_workspace_targets.to_string())
                            .map_err(|e| e.to_string())?;
                        let mut planner_workspace = selected.as_ref().map(|execution| PathBuf::from(&execution.worktree))
                            .unwrap_or_else(|| repository.clone());
                        planner_execution_id = selected.as_ref().map(|execution| execution.id.clone());
                        running.worktree = Some(crate::native::host_path(&planner_workspace).to_string_lossy().into_owned());
                        running.workspace_execution_id = selected.as_ref().map(|execution| execution.id.clone());
                        write_planning_summary(&directory, &running)?;
                        fs::write(directory.join("planner-workspace"), planner_workspace.to_string_lossy().as_bytes())
                            .map_err(|e| e.to_string())?;
                        service.runtime.lock().map_err(|e| e.to_string())?
                            .emit(EventKind::PlannerWorkspaceSelected { planning: running.clone() })?;
                        let planner_model_cfg = PiModelConfig::resolve(PiRole::Planner, &config);
                        let planner_config = planner_model_cfg.effective_config(&config);
                        // The live progress fold reports the model that actually
                        // answered, so session details never show an empty model
                        // while the turn is still streaming.
                        if let Some(role) = running.roles.get_mut("planner") {
                            role.model = planner_config.model.clone();
                        }
                        let planner_system_prompt = std::env::var("PLANNER_SYSTEM_PROMPT")
                            .unwrap_or_else(|_| PLANNER_PROMPT.trim().to_string());
                        let (task, is_followup) = {
                            let mut runtime =
                                service.runtime.lock().map_err(|error| error.to_string())?;
                            let is_approved = runtime.state.approved;
                            let is_followup = !background_review
                                && revision_run_id.is_some()
                                && is_approved
                                && planner_context_required;
                            let include_rework_note = planner_rework_note_pending(
                                &runtime.state,
                                revision_run_id.as_deref(),
                            );
                            let workspace_node = selected.as_ref().map(|execution| execution.node.as_str());
                            let include_workspace_move = is_followup
                                && planner_workspace_targets.as_object().is_some_and(|targets| !targets.is_empty());
                            let task = if background_review {
                                post_task_review_task(include_rework_note)
                            } else if is_followup {
                                planner_followup_prompt_for_workspace(
                                    &goal,
                                    workspace_node,
                                    &runtime.state,
                                    include_rework_note,
                                    include_workspace_move,
                                    None,
                                )
                            } else {
                                goal.clone()
                            };
                            // Reviews and follow-ups share the one-shot marker;
                            // follow-ups consume it even without transport context.
                            if include_rework_note {
                                runtime.emit(EventKind::PlannerReworkNoteInjected)?;
                            }
                            (task, is_followup)
                        };
                        let mut planner_extra_args = Vec::new();
                        if let Some(thinking) = &planner_model_cfg.thinking {
                            planner_extra_args.push("--thinking");
                            planner_extra_args.push(thinking.as_str());
                        }
                        for arg in &image_file_args {
                            planner_extra_args.push(arg.as_str());
                        }
                        let (planner_session_dir, planner_session_id) = {
                            let runtime =
                                service.runtime.lock().map_err(|error| error.to_string())?;
                            planner_session_directory_for_workspace(
                                &root,
                                &directory,
                                &repository,
                                &planner_workspace,
                                original_graph.as_ref().map(|_| &runtime.state),
                            )?
                        };
                        rebind_planner_session(&planner_session_dir, &planner_session_id, &planner_workspace)?;
                        // Keep Graph IR and conversation logs out of project snapshots.
                        fs::create_dir_all(&planner_session_dir).map_err(|e| e.to_string())?;
                        let graph_path =
                            planner_session_dir.join(format!("graph-{planning_id}.json"));
                        fs::write(
                            &graph_path,
                            serde_json::to_vec(&original_graph.clone().unwrap_or_else(|| Graph {
                                original_goal: goal.clone(),
                                ..Graph::default()
                            }))
                            .map_err(|e| e.to_string())?,
                        )
                        .map_err(|e| e.to_string())?;
                        let mut log = String::new();
                        // Runtime rejects removing a node whose result this run
                        // already published. Tell the Planner at the tool boundary
                        // so it reworks the task instead of losing the turn.
                        let unremovable_nodes = revision_run_id
                            .as_ref()
                            .and_then(|run_id| {
                                let runtime = service.runtime.lock().ok()?;
                                (runtime.state.run_id == *run_id
                                    && runtime.state.approved
                                    && runtime.state.published_head.is_some())
                                .then(|| {
                                    runtime
                                        .state
                                        .nodes
                                        .iter()
                                        .filter(|(_, node)| node.status == "completed")
                                        .map(|(name, _)| name.clone())
                                        .collect::<Vec<_>>()
                                })
                            })
                            .unwrap_or_default();
                        // Each attempt retains its own stream/metrics for recovery;
                        // only Pi's private conversation directory is shared.
                        let mut planner_log = fs::File::create(directory.join("planner.jsonl"))
                            .map_err(|e| e.to_string())?;
                        crate::file_changes::reset_planning(&owner, &planning_id);
                        let planning_worktree = planner_workspace.to_string_lossy().into_owned();
                        let mut log_error = None;
                        check_planning_cancelled(&owner)?;
                        // Planner uploads are staged like node inputs; deliver the
                        // accepted references now that this turn owns the workspace.
                        crate::attachment_inputs::deliver_prepared(
                            &root,
                            &owner,
                            "planner",
                            &task,
                            &planner_workspace,
                            true,
                        )?;
                        let planner_start = std::time::Instant::now();
                        let launch_workspace = planner_workspace.clone();
                        let planner_result = run_pi(
                            PiRequest {
                                role: PiRole::Planner,
                                config: &planner_config,
                                cwd: &launch_workspace,
                                task: &task,
                                session_dir: &planner_session_dir,
                                extension: Some(&service.extension),
                                tools: Some("node,edge,read,bash,write,edit"),
                                session_id: Some(&planner_session_id),
                                extra_args: planner_extra_args,
                                environment: vec![
                                    ("GRAPHER_MODE", "planner".into()),
                                    ("GRAPHER_PLANNER_RUN_ID", revision_run_id.clone().unwrap_or_default()),
                                    ("GRAPHER_PLANNER_FOLLOWUP", is_followup.to_string()),
                                    ("GRAPHER_PLANNER_WORKSPACES", planner_workspace_targets.to_string()),
                                    ("GRAPHER_PLANNER_WORKSPACES_FILE", planner_workspace_targets_file.to_string_lossy().into()),
                                    ("GRAPHER_ACTIVE_RUN_ID", owner.clone()),
                                    ("GRAPHER_GRAPH_PATH", graph_path.to_string_lossy().into()),
                                    (
                                        "GRAPHER_COMPILER_PATH",
                                        std::env::current_exe()
                                            .map_err(|error| error.to_string())?
                                            .to_string_lossy()
                                            .into(),
                                    ),
                                    (
                                        "GRAPHER_UNREMOVABLE_NODES",
                                        serde_json::to_string(&unremovable_nodes)
                                            .unwrap_or_else(|_| "[]".into()),
                                    ),
                                ],
                                system_prompt: Some(&planner_system_prompt),
                                images: None,
                            },
                            |text| {
                                let Some(text) = review_transcript_line(&text, background_review) else { return; };
                                if let Err(error) = planner_log.write_all(text.as_bytes()) {
                                    log_error = Some(error.to_string());
                                }
                                log.push_str(&text);
                                crate::file_changes::update_planning_from_log_chunk(
                                    &owner,
                                    &planning_id,
                                    &planning_worktree,
                                    &repo_str,
                                    &text,
                                );
                                on_planner_line(&text);
                                // Publish live Planner usage at assistant-message
                                // and tool boundaries so the session token panel
                                // does not wait for the committed turn summary.
                                let advanced = running
                                    .roles
                                    .get_mut("planner")
                                    .is_some_and(|role| accumulate_planning_role_line(role, &text));
                                if advanced {
                                    if let Ok(mut runtime) = service.runtime.lock() {
                                        if runtime.state.run_id == owner {
                                            let _ = runtime.emit(EventKind::PlannerTurnProgress {
                                                planning: running.clone(),
                                            });
                                        }
                                    }
                                }
                                if let Some(event) = serde_json::from_str::<serde_json::Value>(&text).ok() {
                                    if event["type"] == "tool_execution_end" && event["toolName"] == "switch_workspace" && event["isError"] != true {
                                        let result_text = event["result"]["content"].as_array().map(|parts| parts.iter()
                                            .filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("\n"));
                                        if let Some(result) = result_text.and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok()) {
                                            let requested_node = result["requestedNode"].as_str().unwrap_or_default().to_string();
                                            let resolution = service.runtime.lock().ok()
                                                .and_then(|runtime| runtime.planner_workspace_for_node(&requested_node).ok().flatten());
                                            if let Some(resolution) = resolution {
                                                let target = resolution.execution;
                                                planner_execution_id = Some(target.id.clone());
                                                planner_workspace = PathBuf::from(&target.worktree);
                                                running.worktree = Some(crate::native::host_path(&planner_workspace).to_string_lossy().into_owned());
                                                running.workspace_execution_id = Some(target.id.clone());
                                                let _ = fs::write(directory.join("planner-workspace"), planner_workspace.to_string_lossy().as_bytes());
                                                if let Ok(mut runtime) = service.runtime.lock() {
                                                    if runtime.state.run_id == owner {
                                                        let _ = runtime.emit(EventKind::PlannerWorkspaceSelected { planning: running.clone() });
                                                        if let Some(requested_node) = resolution.redirected_from {
                                                            let actual_node = target.node.clone();
                                                            let _ = runtime.emit(EventKind::PlannerWorkspaceRedirected {
                                                                requested_node,
                                                                actual_node: actual_node.clone(),
                                                                reason: format!("the requested workspace was inherited and modified by {actual_node}; using the latest downstream workspace state"),
                                                            });
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    if background_review && event["toolName"].as_str().is_some_and(|name| matches!(name, "node" | "edge")) && event["type"] == "tool_execution_end" {
                                        let candidate = fs::read(&graph_path).map_err(|e| e.to_string())
                                            .and_then(|bytes| serde_json::from_slice::<Graph>(&bytes).map_err(|e| e.to_string()));
                                        match candidate.and_then(|graph| {
                                            let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
                                            if runtime.state.review_graph.as_ref() != Some(&graph) {
                                                runtime.emit(EventKind::PlannerReviewProgress { graph })?;
                                            }
                                            Ok(())
                                        }) {
                                            Ok(()) => {},
                                            Err(error) => log_error = Some(error),
                                        }
                                    }
                                }
                            },
                        );
                        crate::file_changes::settle_planning(&owner, &planning_id);
                        if let Ok(runtime) = service.runtime.lock() {
                            let _ = crate::file_changes::persist_run(&runtime.root, &owner);
                        }
                        let planner_wall_sec = planner_start.elapsed().as_secs_f64();
                        if let Some(error) = log_error {
                            return Err(format!("Cannot persist planning output: {error}"));
                        }
                        let mut m = parse_planning_role_metrics(&planner_config.model, &log);
                        if m.duration_seconds == 0.0 {
                            m.duration_seconds = planner_wall_sec;
                        }
                        planner_metrics = Some(m);
                        planner_result.map_err(|error| {
                            check_planning_cancelled(&owner).err().unwrap_or(error)
                        })?;
                        if background_review {
                            notify_planning_output(&owner, &planning_id);
                        }
                        let candidate_graph: Graph = serde_json::from_str(
                            &fs::read_to_string(&graph_path).map_err(|error| error.to_string())?,
                        )
                        .map_err(|error| error.to_string())?;
                        fs::copy(&graph_path, directory.join("graph.json"))
                            .map_err(|e| e.to_string())?;
                        candidate_graph
                    },
                    _ => return Err("Partitioner returned an invalid route".into()),
                };
                let total_planning_duration = planning_start.elapsed().as_secs_f64();
                let model_duration = partition_metrics.duration_seconds
                    + planner_metrics
                        .as_ref()
                        .map(|p| p.duration_seconds)
                        .unwrap_or(0.0);
                let mut roles = std::collections::BTreeMap::new();
                roles.insert("partition".to_string(), partition_metrics);
                if let Some(m) = planner_metrics {
                    roles.insert("planner".to_string(), m);
                }
                if let Some(m) = roles.get("planner") {
                    eprintln!(
                    "[Grapher] [Planner] Plan compiled: {} nodes, {} edges in {:.2}s (tokens: {}, tools: {}, errors: {})",
                    graph.nodes.len(),
                    graph.edges.len(),
                    m.duration_seconds,
                    m.usage.total_tokens,
                    m.tools,
                    m.tool_errors
                );
                }

                let summary = PlanningSummary {
                    planning_id: planning_id.clone(),
                    roles,
                    total_planning_duration,
                    model_duration,
                    status: Some("success".to_string()),
                    error: None,
                    created_at: Some(now_ms),
                    repository: Some(repo_str.clone()),
                    worktree: running.worktree.clone(),
                    workspace_execution_id: running.workspace_execution_id.clone(),
                    plan_type: Some(route.plan_type.clone()),
                    goal: running.goal.clone(),
                    run_id: Some(owner.clone()),
                };

                if let Some(ref run_id) = revision_run_id {
                    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                    if runtime.state.run_id != *run_id {
                        return Err("Run changed during graph revision".into());
                    }
                    if runtime.state.approved {
                        compiler::compile(&graph, true)
                            .map_err(|errors| serde_json::to_string(&errors).unwrap_or_default())?;
                        loop {
                            let affected = runtime.revision_affected(&graph);
                            let busy = runtime.state.executions.iter().any(|execution| {
                                execution.status == "running" && affected.contains(&execution.node)
                            });
                            if !busy {
                                break;
                            }
                            if !runtime.state.paused {
                                runtime.pause(true)?;
                                resume_after = true;
                            }
                            drop(runtime);
                            thread::sleep(std::time::Duration::from_millis(50));
                            runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                            if runtime.state.run_id != *run_id {
                                return Err("Run changed during graph revision".into());
                            }
                        }
                    }
                }
                // Auto Approve is a live toggle. A settings save made while this
                // Planner turn was running must decide the plan it produces, not
                // the value captured when the turn started.
                if let Ok(runtime) = service.runtime.lock() {
                    if let Some(auto_approve) = saved_auto_approve(&runtime) {
                        config.auto_approve = auto_approve;
                    }
                }
                let _source_guard = if route.plan_type == "serial" || config.auto_approve || revision_run_id.is_some() {
                    Some(lock.lock().map_err(|e| e.to_string())?)
                } else {
                    None
                };
                let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                check_planning_cancelled(&owner)?;
                capture_planner_turn_workspaces(&mut runtime, &planning_id, planner_execution_id.as_deref())?;
                if let Some(ref run_id) = revision_run_id {
                    if runtime.state.run_id != *run_id {
                        return Err("Run changed during graph revision".into());
                    }
                    if runtime.state.approved {
                        runtime.revise_graph(graph, summary.clone())?;
                    } else {
                        runtime.update_draft_graph(graph, planning_id.clone(), summary.clone())?;
                    }
                } else {
                    runtime.create_with_planning(
                        graph,
                        config.clone(),
                        Some(planning_id.clone()),
                        Some(summary.clone()),
                    )?;
                    runtime.set_route(&route.plan_type)?;
                }
                if (route.plan_type == "serial" && revision_run_id.is_none())
                    || (route.plan_type == "graph"
                        && config.auto_approve
                        && !runtime.state.approved)
                {
                    runtime.approve()?;
                }
                if background_review {
                    let pending = runtime.state.nodes.values().any(|node| node.status != "completed");
                    runtime.emit(EventKind::PlannerReviewFinished {
                        planning: summary.clone(),
                        approval_required: pending && !config.auto_approve,
                    })?;
                }
                let snapshot = runtime.state.clone();
                drop(runtime);
                write_planning_summary(&directory, &summary)?;
                // The durable log is final now; tell every open conversation so a
                // transcript read that raced the writer (or settled at a stale EOF)
                // is re-read instead of staying cached until a page reload. This is
                // not review-only: foreground turns need the same completion signal.
                notify_planning_output(&owner, &planning_id);
                if snapshot.approved && (route.plan_type == "serial" || config.auto_approve) {
                    drive(service.clone());
                }
                Ok(snapshot)
            })();
            match plan_outcome {
                Ok(snapshot) => Ok(snapshot),
                Err(err) => {
                    let mut roles: std::collections::BTreeMap<String, PlanningRoleMetrics> =
                        Default::default();
                    let mut model_duration = 0.0;
                    let partition_file = directory.join("partition.jsonl");
                    if partition_file.exists() {
                        if let Ok(content) = fs::read_to_string(&partition_file) {
                            let partitioner_model_cfg =
                                PiModelConfig::resolve(PiRole::Partitioner, &config);
                            let partitioner_config =
                                partitioner_model_cfg.effective_config(&config);
                            let m =
                                parse_planning_role_metrics(&partitioner_config.model, &content);
                            model_duration += m.duration_seconds;
                            roles.insert("partition".into(), m);
                        }
                    }
                    let planner_file = directory.join("planner.jsonl");
                    if planner_file.exists() {
                        if let Ok(content) = fs::read_to_string(&planner_file) {
                            let planner_model_cfg =
                                PiModelConfig::resolve(PiRole::Planner, &config);
                            let planner_config = planner_model_cfg.effective_config(&config);
                            let m = parse_planning_role_metrics(&planner_config.model, &content);
                            model_duration += m.duration_seconds;
                            roles.insert("planner".into(), m);
                        }
                    }
                    if let Ok(content) = fs::read_to_string(directory.join("merger.jsonl")) {
                        if !content.is_empty() {
                            let model = PiModelConfig::resolve(PiRole::Merger, &config);
                            let metrics = parse_planning_role_metrics(&model.model, &content);
                            model_duration += metrics.duration_seconds;
                            roles.insert("merger".into(), metrics);
                        }
                    }
                    let failure_summary = PlanningSummary {
                        planning_id: planning_id.clone(),
                        roles,
                        total_planning_duration: planning_start.elapsed().as_secs_f64(),
                        model_duration,
                        status: Some("failed".to_string()),
                        error: Some(err.clone()),
                        created_at: Some(now_ms),
                        repository: Some(repo_str.clone()),
                        worktree: running.worktree.clone(),
                        workspace_execution_id: running.workspace_execution_id.clone(),
                        plan_type: fs::read(directory.join("route.json")).ok()
                            .and_then(|bytes| serde_json::from_slice::<Route>(&bytes).ok())
                            .map(|route| route.plan_type)
                            .or_else(|| mode.filter(|m| matches!(*m, "graph" | "serial")).map(str::to_owned)),
                        goal: running.goal.clone(),
                        run_id: Some(owner.clone()),
                    };
                    if let Err(error) = write_planning_summary(&directory, &failure_summary) {
                        eprintln!("Cannot persist planning failure: {error}");
                    }
                    if revision_run_id.is_none() {
                        let persisted = service.runtime.lock().map_err(|e| e.to_string())
                            .and_then(|mut runtime| runtime.emit(EventKind::PlanningFailed {
                                planning: failure_summary.clone(),
                            }));
                        if let Err(error) = persisted {
                            eprintln!("Cannot persist failed planning Run: {error}");
                        }
                    } else {
                        // Failed/cancelled revisions keep the old graph, but writes
                        // in the selected workspace still belong to subsequent jobs.
                        let captured = (|| -> Result<(), String> {
                            let _guard = lock.lock().map_err(|e| e.to_string())?;
                            let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
                            if runtime.state.approved && revision_run_id.as_deref() == Some(&runtime.state.run_id) {
                                let capture = if let Some(id) = &planner_execution_id {
                                    capture_planner_turn_workspaces(&mut runtime, &planning_id, Some(id))
                                } else { runtime.capture_planner_source() };
                                if let Err(error) = capture {
                                    if !runtime.state.paused { let _ = runtime.pause(true); }
                                    return Err(error);
                                }
                            }
                            Ok(())
                        })();
                        if let Err(error) = captured {
                            resume_after = false; // Do not undo the safety pause below.
                            eprintln!("Cannot snapshot Planner writes after failed revision: {error}");
                        }
                        if background_review {
                            if let Ok(mut runtime) = service.runtime.lock() {
                                let _ = runtime.emit(EventKind::PlannerReviewFinished {
                                    planning: failure_summary.clone(), approval_required: false,
                                });
                            }
                        } else if let Ok(mut runtime) = service.runtime.lock() {
                            // The aborted turn's durable planner.jsonl stays part of
                            // this Run's conversation; record it without touching the
                            // compiled graph or the Run phase. Only the owning Run may
                            // receive it: a switched-away Run is recovered at startup.
                            if runtime.state.run_id == owner {
                                let _ = runtime.emit(EventKind::PlannerTurnAborted {
                                    planning: failure_summary.clone(),
                                });
                            }
                        }
                        // The failed turn's log is final too; re-read it instead of
                        // trusting a transcript window read while it was still writing.
                        notify_planning_output(&owner, &planning_id);
                    }
                    Err((err, Some(failure_summary)))
                }
            }
        })()
    });
    let cancelled = check_planning_cancelled(&owner).is_err();
    if resume_after && !cancelled {
        if let Ok(mut runtime) = service.runtime.lock() {
            if check_planning_cancelled(&owner).is_ok()
                && runtime.state.approved
                && runtime.state.paused
                && runtime.state.phase == "paused"
            {
                let _ = runtime.pause(false);
            }
        }
    }
    if !cancelled
        && revision_run_id.is_some()
        && service
            .runtime
            .lock()
            .map(|runtime| runtime.state.phase == "running" && !runtime.state.paused)
            .unwrap_or(false)
    {
        drive(service.clone());
    }
    cancellation_guard.finish(&cleanup.planning);
    // A temporary pause is already undone; return that state rather than the
    // snapshot captured while the affected workers were being drained.
    result.map(|snapshot| {
        if resume_after {
            service
                .runtime
                .lock()
                .map(|runtime| runtime.state.clone())
                .unwrap_or(snapshot)
        } else {
            snapshot
        }
    })
}

fn write_planning_summary(
    directory: &std::path::Path,
    summary: &PlanningSummary,
) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(summary).map_err(|e| e.to_string())?;
    let pending = directory.join("summary.pending");
    fs::write(&pending, &json).map_err(|e| e.to_string())?;
    fs::rename(pending, directory.join("summary.json")).map_err(|e| e.to_string())?;
    Ok(())
}

fn recover_plannings(service: &Arc<Service>) -> Result<(), String> {
    let mut primary = service.runtime.lock().map_err(|e| e.to_string())?;
    let Ok(entries) = fs::read_dir(primary.root.join("planning")) else { return Ok(()); };
    for entry in entries.flatten() {
        let directory = entry.path();
        let Some(mut summary) = fs::read(directory.join("summary.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<PlanningSummary>(&bytes).ok()) else { continue; };
        if !is_valid_planning_id(&summary.planning_id)
            || directory.file_name().and_then(|s| s.to_str()) != Some(&summary.planning_id)
        { continue; }
        let recorded = primary.store.run_for_planning_id(&summary.planning_id)?;
        let interrupted = summary.status.as_deref() == Some("running");
        if interrupted {
            // The graph commit may have reached SQLite just before shutdown,
            // while the terminal sidecar rename had not happened yet.
            if let Some(saved) = recorded.as_deref().and_then(|id| primary.store.load(id).ok()) {
                if saved.planning_id.as_ref() == Some(&summary.planning_id) {
                    if let Some(committed) = saved.planning.filter(|p| p.status.as_deref() == Some("success")) {
                        write_planning_summary(&directory, &committed)?;
                        continue;
                    }
                }
            }
            summary.status = Some("failed".into());
            summary.error = Some("Backend stopped during planning. Saved output is preserved; start a new planning attempt.".into());
        }
        if summary.status.as_deref() != Some("failed") { continue; }
        let request = fs::read(directory.join("request.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if let Some(request) = &request {
            if let Ok(config) = argument::<Config>(request, "config") {
                // Interrupted summaries used to retain zero metrics despite saved JSONL.
                if interrupted || summary.roles.values().all(|m| m.session_start.is_none()) {
                    summary.roles.clear();
                    summary.model_duration = 0.0;
                    for (role, pi_role) in [("partition", PiRole::Partitioner), ("planner", PiRole::Planner), ("merger", PiRole::Merger)] {
                        if let Ok(log) = fs::read_to_string(directory.join(format!("{role}.jsonl"))) {
                            let model = PiModelConfig::resolve(pi_role, &config);
                            let metrics = parse_planning_role_metrics(&model.model, &log);
                            summary.model_duration += metrics.duration_seconds;
                            summary.roles.insert(role.into(), metrics);
                        }
                    }
                    summary.total_planning_duration = summary.model_duration;
                }
            }
        }
        enrich_planning_summary(&mut summary, &directory);
        write_planning_summary(&directory, &summary)?;
        let Some(request) = request else { continue; };
        let unrecorded = recorded.is_none();
        let run_id = recorded.clone().or_else(|| request["runId"].as_str().map(str::to_owned))
            .or_else(|| {
                // Legacy requests omitted the provisional Run ID. The private
                // workspace preserves it as .grapher-workspaces/<runId>/<attempt>.
                let path = PathBuf::from(fs::read_to_string(directory.join("planner-workspace")).ok()?);
                let id = path.parent()?.file_name()?.to_str()?;
                Uuid::parse_str(id).ok().map(|_| id.to_owned())
            }).unwrap_or_else(|| summary.planning_id.clone());
        // A failed revision must not replace its existing compiled graph, but
        // its durable Planner output stays part of the conversation: record the
        // aborted turn once so a reload can replay it. Successful attempts are
        // already identified by their GraphRevised/review events (`recorded`).
        if !request["revisionRunId"].is_null() {
            if unrecorded
                && is_valid_planning_id(&run_id)
                && !primary.store.run_was_deleted(&run_id)?
                && primary.store.contains_run(&run_id)?
            {
                let mut recovered = primary.open_run(&run_id)?;
                // A crash can leave Planner writes in a borrowed node slot.
                // Keep those bytes/history, snapshot them before any later jobs,
                // and pause rather than silently scheduling stale inputs on error.
                if interrupted {
                    if let Some(id) = &summary.workspace_execution_id {
                        if let Err(error) = capture_planner_turn_workspaces(&mut recovered, &summary.planning_id, Some(id)) {
                            recovered.pause(true)?;
                            summary.error = Some(format!("{}; workspace recovery failed: {error}", summary.error.as_deref().unwrap_or("Planner interrupted")));
                            write_planning_summary(&directory, &summary)?;
                        }
                    }
                }
                recovered.emit(EventKind::PlannerTurnAborted { planning: summary })?;
                if primary.state.run_id == run_id {
                    primary.state = recovered.state;
                    primary.touch();
                }
            }
            continue;
        }
        if !is_valid_planning_id(&run_id) || primary.store.run_was_deleted(&run_id)? { continue; }
        let exists = primary.store.contains_run(&run_id)?;
        let mut recovered = primary.open_run(if exists { &run_id } else { "" })?;
        if !exists {
            let (Ok(goal), Ok(config)) = (argument::<String>(&request, "goal"), argument::<Config>(&request, "config")) else { continue; };
            recovered.state.run_id = run_id.clone();
            recovered.emit(EventKind::PlanningStarted {
                goal, config, planning: summary.clone(),
                plan_type: fs::read(directory.join("route.json")).ok()
                    .and_then(|bytes| serde_json::from_slice::<Route>(&bytes).ok())
                    .map(|route| route.plan_type),
            })?;
        }
        if recovered.state.planning_id.as_ref() == Some(&summary.planning_id)
            && matches!(recovered.state.phase.as_str(), "planning" | "planning_failed")
        {
            if recovered.state.phase != "planning_failed" || recovered.state.planning.as_ref() != Some(&summary) {
                recovered.emit(EventKind::PlanningFailed { planning: summary })?;
            }
            if primary.state.run_id == run_id {
                primary.state = recovered.state;
                primary.touch();
            }
        }
    }
    Ok(())
}

// Selection events are the durable list of every borrowed slot, not just the
// final cwd. Capture after the entire Planner process tree has drained so a
// background Bash writer in a previous slot cannot escape the checkpoint.
fn capture_planner_turn_workspaces(runtime: &mut Runtime, planning_id: &str, fallback: Option<&str>) -> Result<(), String> {
    let mut executions = Vec::new();
    for event in &runtime.state.events {
        if let EventKind::PlannerWorkspaceSelected { planning } = &event.kind {
            if planning.planning_id == planning_id {
                if let Some(id) = &planning.workspace_execution_id {
                    if !executions.contains(id) { executions.push(id.clone()); }
                }
            }
        }
    }
    if let Some(id) = fallback {
        if !executions.iter().any(|existing| existing == id) { executions.push(id.to_string()); }
    }
    for id in executions { capture_planner_workspace_when_idle(runtime, &id)?; }
    Ok(())
}

/// The Planner may share its workspace with a node/Merger that is still
/// running. Git-snapshotting that directory concurrently is unsafe, so leave
/// the capture to the writer's own completion path; it snapshots every byte
/// (including Planner writes) exactly once when the shared directory drains.
fn capture_planner_workspace_when_idle(runtime: &mut Runtime, execution_id: &str) -> Result<(), String> {
    let running = runtime
        .state
        .executions
        .iter()
        .find(|execution| execution.id == execution_id)
        .is_some_and(|execution| runtime.path_is_running(std::path::Path::new(&execution.worktree)));
    if running { return Ok(()); }
    runtime.capture_planner_workspace(execution_id)
}

fn plan_goal(
    goal: String,
    config: Config,
    mode: Option<String>,
    images: Option<Vec<crate::model::ImageAttachment>>,
    service: &Arc<Service>,
) -> Result<Snapshot, String> {
    plan_goal_internal(
        goal,
        config,
        mode.as_deref(),
        images,
        None,
        service,
        |_| {},
        |_| {},
        |_| {},
    )
    .map_err(|(error, _)| error)
}

/// Reclaim a Run's temporary source snapshot once nothing needs it. Takes the
/// per-source lock and re-checks under it: a concurrent dispatch may have
/// materialized a new snapshot while this caller was finishing.
fn reclaim_source_snapshot(service: &Arc<Service>, repository: &std::path::Path) {
    let result = (|| -> Result<(), String> {
        let lock = source_lock(repository)?;
        let _guard = lock.lock().map_err(|error| error.to_string())?;
        let reclaimable = service
            .runtime
            .lock()
            .map_err(|error| error.to_string())?
            .shadow_reclaimable(repository)?;
        if reclaimable {
            crate::workspace::remove_shadow_repo(repository)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("[Grapher] Cannot reclaim source snapshot: {error}");
    }
}

fn drive(service: Arc<Service>) {
    if service.driving.swap(true, Ordering::SeqCst) {
        // Wake the active driver even if its current workers are long-running.
        if let Ok(mut generation) = service.drive_signal.0.lock() {
            *generation += 1;
            service.drive_signal.1.notify_one();
        }
        return;
    }
    let run_id = service
        .runtime
        .lock()
        .map(|runtime| runtime.state.run_id.clone())
        .unwrap_or_default();
    let drive_service = service.clone();
    if let Err(error) = thread::Builder::new().name("grapher-drive".into()).spawn(move || {
        let (output_tx, output_rx) = std::sync::mpsc::sync_channel(256);
        let writer_service = service.clone();
        let writer = match thread::Builder::new().name("grapher-output".into())
            .spawn(move || persist_outputs(writer_service, output_rx)) {
            Ok(writer) => writer,
            Err(error) => {
                eprintln!("Cannot start output writer: {error}");
                if let Ok(mut runtime) = service.runtime.lock() {
                    let _ = runtime.emit(EventKind::Paused { paused: true });
                }
                service.driving.store(false, Ordering::SeqCst);
                return;
            }
        };
        let result = (|| -> Result<(), String> {
            let (completed_tx, completed_rx) = std::sync::mpsc::channel();
            let mut in_flight = 0usize;
            loop {
                let observed = *service.drive_signal.0.lock().map_err(|e| e.to_string())?;
                // Pending verdicts are durable. The scheduler applies them
                // after affected workers drain, including after a restart.
                let (jobs, root, parents) = {
                    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                    // Only nodes that a pending feedback verdict could invalidate
                    // must drain. Independent branches may fill available slots.
                    // Drain the selected writer before Planner borrows its worktree.
                    // Dispatch new work only after the turn records its selected
                    // workspace snapshot and graph.
                    let jobs = if service.planning.load(Ordering::SeqCst) {
                        Vec::new()
                    } else {
                        runtime.jobs_with_pending_feedback(true, &[])?
                    };
                    let parents: Vec<_> = jobs
                        .iter()
                        .map(|job| runtime.parents(&job.execution.node))
                        .collect();
                    (jobs, runtime.root.clone(), parents)
                };
                if jobs.is_empty() && in_flight == 0 {
                    if service.planning.load(Ordering::SeqCst) {
                        thread::sleep(std::time::Duration::from_millis(50));
                        continue;
                    }
                    // PublicationStarted is durable before any user files change.
                    let publication = {
                        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                        if runtime.state.phase == "publishing" {
                            Some((
                                runtime.state.config.clone().ok_or("Missing config")?,
                                runtime.state.graph.original_goal.clone(),
                                runtime
                                    .state
                                    .publication
                                    .clone()
                                    .ok_or("Missing publication state")?,
                            ))
                        } else {
                            None
                        }
                    };
                    if let Some((config, query, publication)) = publication {
                        let repository = PathBuf::from(&publication.repository);
                        // Publication/model sessions are deliberately not guarded by
                        // a per-project lock. Concurrent Runs are allowed to reach
                        // Git publication; any resulting repository conflict is left
                        // for the existing publication state to expose.
                        let preflight = {
                            let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                            runtime.publication_environment_input()
                        };
                        {
                            let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                            if let Some(layout) = runtime.publication_live_writer()? {
                                return Err(format!("Cannot publish over a live writer: {layout}"));
                            }
                        }
                        let result = crate::process_control::with_owner(&run_id, || {
                            let exclusions = service.runtime.lock().map_err(|e| e.to_string())?.exclusions()?;
                            let publication_path = crate::workspace::workspaces_parent(&root)
                                .join(".grapher-worktrees").join(&run_id).join(
                                    crate::graph_merge::publication_workspace(&repository, &publication.heads)?
                                        .file_name().ok_or("Invalid publication workspace")?);
                            let head = crate::graph_merge::merge_graph_scoped_at(&repository, &publication.heads, &exclusions, &publication_path, |publication_workspace| {
                                let attempt = service
                                    .runtime
                                    .lock()
                                    .map_err(|e| e.to_string())?
                                    .state
                                    .mergers
                                    .len()
                                    + 1;
                                crate::graph_merge::resolve_with_merger(
                                    publication_workspace,
                                    &query,
                                    &config,
                                    &root,
                                    attempt,
                                    |event| {
                                        service
                                            .runtime
                                            .lock()
                                            .map_err(|e| e.to_string())?
                                            .emit(event)
                                    },
                                )
                            })?;
                            let descriptor = match preflight {
                                Ok(Some(job)) => match job.validate().and_then(|_| job.descriptor(&head)) {
                                    Ok(descriptor) => Some(descriptor),
                                    Err(error) => {
                                        eprintln!("[Grapher] Result descriptor unavailable; publishing code without it: {error}");
                                        None
                                    }
                                },
                                Ok(None) => None,
                                Err(error) => {
                                    eprintln!("[Grapher] Environment preflight unavailable; publishing code without it: {error}");
                                    None
                                }
                            };
                            Ok((head, descriptor))
                        });
                        let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
                        match result {
                            Ok((head, descriptor)) => {
                                eprintln!(
                                    "[Grapher] [Publication] Files delivered; internal result: {head}"
                                );
                                if runtime.state.run_id != run_id
                                    || !matches!(runtime.state.phase.as_str(), "publishing" | "merging")
                                    || runtime.state.publication.as_ref().is_none_or(|current|
                                        current.heads != publication.heads || current.repository != publication.repository)
                                {
                                    return Err("Stale publication worker cannot commit to this Run".into());
                                }
                                let base_commit = runtime.state.base.clone();
                                let published_commit = head.clone();
                                let mut events = Vec::new();
                                if let Some(descriptor) = descriptor { events.push(EventKind::ResultPublished { descriptor }); }
                                events.push(EventKind::PublicationCompleted { head });
                                runtime.emit_outputs(events)?;
                                if let Err(error) = runtime.cleanup_worktrees() {
                                    eprintln!("Cannot clean completed run worktrees: {error}");
                                }
                                // Publication succeeded, so the user's source now
                                // contains the merged result.
                                let repository = PathBuf::from(&publication.repository);
                                drop(runtime);
                                crate::file_changes::record_publication_git_changes(
                                    &run_id,
                                    &repository,
                                    &base_commit,
                                    &published_commit,
                                );
                                reclaim_source_snapshot(&service, &repository);
                                let review = {
                                    let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
                                    runtime.state.effective_config().filter(|config| config.post_task_review)
                                        .filter(|_| runtime.state.plan_type.as_deref() == Some("graph")
                                            && runtime.state.phase == "completed" && !runtime.state.stop_requested
                                            && runtime.state.nodes.values().all(|node| node.status == "completed"))
                                };
                                if let Some(config) = review {
                                    if let Err((error, _)) = plan_goal_internal_with_started(
                                        POST_TASK_REVIEW_PROMPT.into(), config, Some("graph"), None,
                                        Some(run_id.clone()), &service, true, |_| {}, |_| {}, |_| {}, |_| {},
                                    ) {
                                        eprintln!("Post-task Planner review failed: {error}");
                                    }
                                    // The same driver owns continuation execution. No new
                                    // jobs can dispatch until the entire turn has settled.
                                    continue;
                                }
                            }
                            Err(error) => {
                                eprintln!("[Grapher] [Publication] Failed: {error}");
                                runtime.emit(EventKind::PublicationFailed { error })?;
                            }
                        }
                    }
                    // Retry Graph snapshot cleanup if publication's first pass
                    // was interrupted. Serial never participates in the shadow
                    // repository lifecycle, even when it shares a Graph source.
                    let settled_repository = {
                        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
                        if runtime.state.phase == "completed" && !runtime.is_serial() {
                            runtime.source_repository()?
                        } else {
                            None
                        }
                    };
                    if let Some(repository) = settled_repository {
                        reclaim_source_snapshot(&service, &repository);
                    }
                    break;
                }
                for (job, parents) in jobs.into_iter().zip(parents) {
                    let execution = job.execution.clone();
                    let spawn_service = service.clone();
                    let service = service.clone();
                    let root = root.clone();
                    let completed_tx = completed_tx.clone();
                    let output_tx = output_tx.clone();
                    eprintln!(
                        "[Grapher] [Execution] Started node '{}' (id: {}, attempt: {})",
                        job.execution.node, job.execution.id, job.execution.attempt
                    );
                    let run_id = run_id.clone();
                    let spawned = thread::Builder::new().name("grapher-node".into()).spawn(move || {
                        let mut job = job;
                        let node_owner = crate::process_control::execution_owner(
                            &run_id, &job.execution.node, &job.execution.id,
                        );
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            // Every model session is independent. Serial mode selects
                            // the source checkout, but it does not serialize sessions
                            // from different Runs or attempt to reconcile their writes.
                            crate::process_control::with_owner(&node_owner, || {
                                crate::process_control::check_current_owner_stop()?;
                                if job.materialize_source {
                                    materialize_job_source(&service, &root, &mut job)?;
                                }
                                let activity_key =
                                    format!("prepare-{}", job.execution.id);
                                // Covers Git checkout, ordinary-file copying and
                                // environment preparation until Prepared is emitted.
                                let _prepare_activity = ActivityGuard::begin(
                                    &job.run_id,
                                    &activity_key,
                                    "workspace_prepare",
                                    &job.execution.node,
                                );
                                perform_with_merger(
                                    &job,
                                    &root,
                                    &parents,
                                    |text| {
                                        let _ = output_tx.send(OutputMessage::Text {
                                            execution_id: job.execution.id.clone(),
                                            text,
                                        });
                                    },
                                    |head| {
                                        crate::process_control::check_current_owner_stop()?;
                                        clear_activity(&job.run_id, &activity_key);
                                        service
                                            .runtime
                                            .lock()
                                            .map_err(|error| error.to_string())?
                                            .emit(EventKind::Prepared {
                                                execution_id: job.execution.id.clone(),
                                                head,
                                            })
                                    },
                                    |event| {
                                        service
                                            .runtime
                                            .lock()
                                            .map_err(|e| e.to_string())?
                                            .emit(event)
                                    },
                                )
                            })
                        }))
                        .unwrap_or_else(|_| Err("Execution worker panicked".into()));
                        let (reply, ack) = std::sync::mpsc::channel();
                        let flushed = output_tx
                            .send(OutputMessage::Flush(reply))
                            .map_err(|_| {
                                "Output writer stopped before execution finished".to_string()
                            })
                            .and_then(|_| {
                                ack.recv().map_err(|_| {
                                    "Output writer stopped before flushing".to_string()
                                })
                            })
                            .and_then(|result| result);
                        let result = if let Err(error) = flushed {
                            Err(error)
                        } else {
                            result
                        };
                        // Finish in the driver: the review's Finished event and
                        // its pending feedback barrier must be observed together
                        // before the next scheduler pass.
                        let _ = completed_tx.send((job.execution, result));
                        if let Ok(mut generation) = service.drive_signal.0.lock() {
                            *generation += 1;
                            service.drive_signal.1.notify_one();
                        }
                    });
                    match spawned {
                        Ok(_) => in_flight += 1,
                        Err(error) => {
                            // Started was persisted when the batch was scheduled.
                            // Fail this node explicitly rather than leaving it running
                            // or losing the entire drive loop to a spawn panic.
                            spawn_service.runtime.lock().map_err(|e| e.to_string())?
                                .finish(&execution, Err(format!("Cannot start node worker: {error}")))?;
                        }
                    }
                }
                if in_flight > 0 {
                    // Hold the signal mutex while checking the queue: neither
                    // a completion nor a control event can be lost before wait.
                    let generation = service.drive_signal.0.lock().map_err(|e| e.to_string())?;
                    match completed_rx.try_recv() {
                        Ok((execution, result)) => {
                            drop(generation);
                            in_flight -= 1;
                            service.runtime.lock().map_err(|e| e.to_string())?.finish(&execution, result)?;
                        }
                        Err(std::sync::mpsc::TryRecvError::Empty) => {
                            if *generation != observed {
                                // A control event arrived while scheduling.
                                continue;
                            }
                            drop(service.drive_signal.1.wait(generation).map_err(|e| e.to_string())?);
                            continue;
                        }
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                            return Err("Execution channel closed".into());
                        }
                    }
                }
            }
            Ok(())
        })();
        drop(output_tx);
        if writer.join().is_err() {
            eprintln!("Output writer panicked");
        }
        if let Ok(runtime) = service.runtime.lock() {
            if let Some(m) = &runtime.state.run_metrics {
                eprintln!(
                    "[Grapher] [RunSummary] Run '{}' settled (phase: {}, wall-clock: {:.2}s, total tokens: {}, tools: {}, errors: {})",
                    runtime.state.run_id,
                    runtime.state.phase,
                    m.total_duration_seconds,
                    m.total_usage.total_tokens,
                    m.tools,
                    m.tool_errors
                );
            }
        }
        if let Err(error) = result {
            eprintln!("Runtime halted safely: {error}");
            if let Ok(mut runtime) = service.runtime.lock() {
                if matches!(runtime.state.phase.as_str(), "publishing" | "merging") {
                    let _ = runtime.emit(EventKind::PublicationFailed { error });
                } else {
                    let _ = runtime.emit(EventKind::Paused { paused: true });
                }
            }
        }
        service.driving.store(false, Ordering::SeqCst);
        let resume = service
            .runtime
            .lock()
            .map(|runtime| {
                runtime.state.approved
                    && !runtime.state.paused
                    && runtime.state.phase == "running"
                    && !runtime.active()
            })
            .unwrap_or(false);
        if resume {
            drive(service.clone());
        }
    }) {
        eprintln!("Cannot start Run driver: {error}");
        if let Ok(mut runtime) = drive_service.runtime.lock() {
            let _ = runtime.emit(EventKind::Paused { paused: true });
        }
        drive_service.driving.store(false, Ordering::SeqCst);
    }
}

fn control(
    action: String,
    node: Option<String>,
    instruction: Option<String>,
    run_id: Option<String>,
    execution_id: Option<String>,
    images: Option<Vec<crate::model::ImageAttachment>>,
    service: &Arc<Service>,
) -> Result<Snapshot, String> {
    // A viewed historical Run is not necessarily the backend's active Run.
    // Never apply controls (especially stop) to a different conversation.
    if let Some(expected) = &run_id {
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        if runtime.state.run_id != *expected {
            return Err("Run changed; reload this conversation before controlling it".into());
        }
    }
    if action == "steer_planner" {
        let instruction = instruction.ok_or("Enter a planning message")?;
        if instruction.trim().is_empty() {
            return Err("Enter a planning message".into());
        }
        if !service.planning.load(Ordering::SeqCst) {
            return Err("Planner is no longer accepting messages".into());
        }
        // A reconnected browser can steer while the replacement Planner is
        // still starting. Wait only for that short registration window; the
        // message is not a new planning request and must not be rejected just
        // because the Pi RPC entry is not visible yet.
        let wait_until = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let active_run_id = loop {
            let lookup = if let Some(ref id) = run_id {
                crate::engine::planner_revision_run_id_for_run(id)
            } else {
                crate::engine::planner_revision_run_id()
            };
            match lookup {
                Ok(id) => break id,
                Err(_) if service.planning.load(Ordering::SeqCst) &&
                    std::time::Instant::now() < wait_until => {
                    thread::sleep(std::time::Duration::from_millis(100));
                    continue;
                }
                Err(error) => return Err(error),
            }
        };
        let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        if active_run_id
            .as_ref()
            .is_some_and(|id| id != &runtime.state.run_id)
        {
            return Err("Run changed while steering Planner".into());
        }
        let include_rework_note = planner_rework_note_pending(
            &runtime.state,
            active_run_id.as_deref(),
        );
        let workspace_node = runtime
            .state
            .planning
            .as_ref()
            .and_then(|planning| planning.workspace_execution_id.as_deref())
            .and_then(|execution_id| runtime.state.executions.iter().find(|execution| execution.id == execution_id))
            .map(|execution| execution.node.as_str());
        let is_followup = active_run_id.is_some()
            && runtime.state.approved
            && runtime.state.plan_type.as_deref() == Some("graph")
            && planner_followup_context_required(&runtime.state);
        // An empty file makes a switch_workspace call left over from the
        // launch-time tool registration fail once this turn no longer has
        // another workspace worth selecting.
        let workspace_targets = if is_followup {
            runtime.planner_workspace_targets(workspace_node)?
        } else {
            serde_json::json!({})
        };
        let include_workspace_move = workspace_targets.as_object().is_some_and(|targets| !targets.is_empty());
        let workspace_targets_file = runtime
            .state
            .planning
            .as_ref()
            .map(|planning| runtime.root.join("planning").join(&planning.planning_id).join("planner-workspaces.json"));
        if let Some(file) = &workspace_targets_file {
            fs::write(file, workspace_targets.to_string()).map_err(|e| e.to_string())?;
        }
        let message = if is_followup {
            planner_followup_prompt_for_workspace(
                instruction.trim(),
                workspace_node,
                &runtime.state,
                include_rework_note,
                include_workspace_move,
                None,
            )
        } else {
            instruction.trim().to_string()
        };
        // The one-shot marker is consumed by this follow-up even when the
        // transport context itself is omitted.
        if include_rework_note {
            runtime.emit(EventKind::PlannerReworkNoteInjected)?;
        }
        // Staged Planner uploads become inputs of the workspace this turn owns.
        if let Some(worktree) = runtime.state.planning.as_ref().and_then(|planning| planning.worktree.clone()) {
            crate::attachment_inputs::deliver_prepared(
                &runtime.root,
                &runtime.state.run_id,
                "planner",
                instruction.trim(),
                std::path::Path::new(&worktree),
                true,
            )?;
        }
        let snapshot = runtime.state.clone();
        drop(runtime);
        if let Some(id) = run_id {
            crate::engine::steer_planner_for_run_nowait(&id, &message, images)?;
        } else {
            crate::engine::steer_planner_nowait(&message, images)?;
        }
        return Ok(snapshot);
    }
    if action == "message_node" {
        let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        if run_id.as_deref() != Some(runtime.state.run_id.as_str()) {
            return Err("Run changed while messaging node".into());
        }
        runtime.message_completed_node(
            node.as_deref().unwrap_or_default(),
            instruction.as_deref().unwrap_or_default(),
            images,
        )?;
        return Ok(runtime.state.clone());
    }
    // Decide queue-vs-live delivery under the same Run mutex as dispatch.
    // A stale browser may still send `intervene` after its queued turn started;
    // transparently steer that writer instead of rejecting or overwriting it.
    let (action, execution_id) = if action == "intervene" {
        let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        if let Some(running) = runtime.state.executions.iter().rev().find(|execution|
            execution.node == node.as_deref().unwrap_or_default() && execution.status == "running") {
            ("steer".to_string(), Some(running.id.clone()))
        } else {
            if service.planning.load(Ordering::SeqCst) { return Err("Wait for planning to finish".into()); }
            runtime.intervene_with_images(node.as_deref().unwrap_or_default(),
                instruction.as_deref().unwrap_or_default(), images)?;
            let snapshot = runtime.state.clone();
            drop(runtime);
            drive(service.clone());
            return Ok(snapshot);
        }
    } else { (action, execution_id) };
    if action == "steer" {
        let node = node.ok_or("Select a node to steer")?;
        let instruction = instruction.ok_or("Enter a steering message")?;
        if instruction.trim().is_empty() {
            return Err("Enter a steering message".into());
        }
        let execution_id = execution_id.ok_or("Missing execution identity")?;
        {
            let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            // Merger executions are steerable while their native process is
            // alive, exactly like node executions.
            let running = runtime
                .state
                .executions
                .iter()
                .chain(&runtime.state.mergers)
                .find(|e| e.id == execution_id && e.node == node && e.status == "running");
            if run_id.as_deref() != Some(runtime.state.run_id.as_str()) || running.is_none() {
                return Err(
                    "Node execution is no longer running; send a new instruction instead".into(),
                );
            }
            crate::attachment_inputs::deliver(&runtime.root, &runtime.state.run_id, &node,
                &instruction, std::path::Path::new(&running.unwrap().worktree))?;
        }
        crate::engine::steer_nowait(&execution_id, instruction.trim(), images.clone())?;
        let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        if run_id.as_deref() != Some(runtime.state.run_id.as_str()) {
            return Err("Run changed while steering".into());
        }
        runtime.emit(EventKind::Steered {
            execution_id,
            node,
            instruction: instruction.trim().into(),
            images,
        })?;
        return Ok(runtime.state.clone());
    }
    if action == "continue_merger" {
        let instruction = instruction.ok_or("Enter a message for the merger")?;
        if instruction.trim().is_empty() {
            return Err("Enter a message for the merger".into());
        }
        let execution_id = execution_id.ok_or("Missing merger execution identity")?;
        let (previous, config, session_dir, target_worktree, source_direct) = {
            let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            if run_id.as_deref() != Some(runtime.state.run_id.as_str()) {
                return Err("Run changed while messaging the merger".into());
            }
            let target_node = node.as_deref().unwrap_or("merger");
            let previous = runtime
                .state
                .mergers
                .iter()
                .find(|m| m.id == execution_id && (m.node == target_node || target_node == "merger"))
                .cloned()
                .ok_or("Merger execution not found in this Run")?;
            if previous.status == "running" {
                return Err("Steer the running merger instead".into());
            }
            if previous.node != "merger" && previous.status != "failed" {
                return Err("Only failed node mergers can be re-run with a follow-up message".into());
            }
            // The publication writer/materializer owns the source directory
            // while its phase is active; never start a second writer there.
            if previous.node == "merger"
                && matches!(runtime.state.phase.as_str(), "publishing" | "merging")
            {
                return Err("Wait for publication to finish before messaging the merger".into());
            }
            let config = runtime.state.effective_config().ok_or("Missing config")?;
            let source_direct = previous.node == "merger" && runtime.state.publication.as_ref()
                .is_some_and(|publication| publication.status == "completed");
            let target_worktree = if source_direct { config.repository.clone() } else { previous.worktree.clone() };
            if !std::path::Path::new(&target_worktree).is_dir() {
                return Err("Merger workspace is no longer available".into());
            }
            if runtime.path_is_running(std::path::Path::new(&target_worktree)) {
                return Err("This workspace is currently in use; wait for it to finish".into());
            }
            // Retain Pi history; a delivered publication returns to source,
            // whereas failed repair stays private. The new native execution
            // identity keeps the continued conversation steerable.
            let session_dir = if runtime.root.join("mergers").join(&previous.session_id).is_dir() {
                runtime.root.join("mergers").join(&previous.session_id)
            } else {
                runtime.root.join("mergers").join(&previous.id)
            };
            (previous, config, session_dir, target_worktree, source_direct)
        };
        let id = Uuid::new_v4().to_string();
        // A successful publication may reclaim the temporary snapshot at any
        // moment, so a plain folder whose snapshot vanished resolves to no
        // `before` commit instead of failing the continuation request.
        let before = if source_direct { String::new() } else {
            merger_continuation_before(std::path::Path::new(&target_worktree))?
        };
        let mut execution = Execution {
            id: id.clone(),
            node: previous.node.clone(),
            revision: previous.revision,
            attempt: previous.attempt + 1,
            session_id: previous.session_id.clone(),
            worktree: target_worktree.clone(),
            before,
            workspace_lineage: previous.workspace_lineage.clone(),
            after: None,
            input: None,
            result: None,
            status: "running".into(),
            output: String::new(),
            output_bytes: 0,
            pid: None,
            started_at: now(),
            completed_at: None,
            metrics: None,
        };
        let run_id = run_id.ok_or("Missing run identity")?;
        let root = {
            let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            // Re-check under the Run lock: publication may have started and a
            // scheduled execution may have claimed the workspace meanwhile.
            if previous.node == "merger"
                && matches!(runtime.state.phase.as_str(), "publishing" | "merging")
            {
                return Err("Wait for publication to finish before messaging the merger".into());
            }
            if runtime.path_is_running(std::path::Path::new(&target_worktree)) {
                return Err("This workspace is currently in use; wait for it to finish".into());
            }
            // Pin the target generation, not the original Merger's revision:
            // a successful repair must not revive a subsequently revised node.
            if let Some(target) = previous.node.strip_prefix("merge:")
                .and_then(|name| runtime.state.nodes.get(name))
            {
                execution.revision = target.revision;
            }
            runtime.emit(EventKind::MergerStarted {
                execution: execution.clone(),
            })?;
            runtime.root.clone()
        };
        // Reservation precedes delivery, but every failure after reservation
        // needs a terminal event, including errors before a worker is spawned.
        let prepared = (|| -> Result<Snapshot, String> {
            service.runtime.lock().map_err(|e| e.to_string())?.emit(EventKind::Steered {
                execution_id: id.clone(),
                node: previous.node.clone(),
                instruction: instruction.trim().into(),
                images: images.clone(),
            })?;
            crate::attachment_inputs::deliver_prepared(
                &root,
                &run_id,
                &previous.node,
                instruction.trim(),
                std::path::Path::new(&target_worktree),
                true,
            )?;
            Ok(service.runtime.lock().map_err(|e| e.to_string())?.state.clone())
        })();
        let snapshot = match prepared {
            Ok(snapshot) => snapshot,
            Err(error) => {
                service.runtime.lock().map_err(|e| e.to_string())?.emit(EventKind::MergerFailed {
                    execution_id: id,
                    error: error.clone(),
                    output_bytes: 0,
                    metrics: None,
                })?;
                return Err(error);
            }
        };
        let worker_service = service.clone();
        let worker_execution = execution.clone();
        let worker_previous = previous.clone();
        let worker_config = config.clone();
        let worker_instruction = instruction.trim().to_string();
        let worker_images = images.clone();
        let spawned = thread::Builder::new()
            .name("grapher-merger".into())
            .spawn(move || {
                let _ = crate::process_control::with_owner(&run_id, || {
                    let result = crate::graph_merge::continue_merger_for_node(
                        &worker_previous,
                        &worker_execution,
                        &worker_instruction,
                        worker_images.as_deref(),
                        &worker_config,
                        &session_dir,
                        |event| {
                            worker_service
                                .runtime
                                .lock()
                                .map_err(|e| e.to_string())?
                                .emit(event)
                        },
                    );
                    if let Err(error) = result {
                        eprintln!("[Grapher] [Merger] Continuation worker failed: {error}");
                        // An early filesystem error may return before the model
                        // turn recorded its terminal event; never leave a running
                        // merger behind without a native process.
                        if let Ok(mut runtime) = worker_service.runtime.lock() {
                            if runtime.state.mergers.iter().any(|m| {
                                m.id == worker_execution.id && m.status == "running"
                            }) {
                                let _ = runtime.emit(EventKind::MergerFailed {
                                    execution_id: worker_execution.id.clone(),
                                    error,
                                    output_bytes: 0,
                                    metrics: None,
                                });
                            }
                        }
                    }
                });
                // Wake the scheduler: the workspace reservation is released.
                drive(worker_service.clone());
            });
        if let Err(error) = spawned {
            let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            runtime.emit(EventKind::MergerFailed {
                execution_id: id,
                error: format!("Cannot start merger worker: {error}"),
                output_bytes: 0,
                metrics: None,
            })?;
            return Err(format!("Cannot start merger worker: {error}"));
        }
        return Ok(snapshot);
    }
    if matches!(action.as_str(), "stop" | "cancel") {
        let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        let active_id = runtime.state.run_id.clone();
        let target_node = node.as_deref().filter(|n| !n.trim().is_empty());
        if let Some(node_name) = target_node {
            // 用户在单个 Node 的对话框中点击停止/打断：
            // 只打断目标 Node 的独立执行进程，绝不暂停全图，绝不影响其他并发运行的 Node，绝不打断 Planner
            stop_node_executions(&mut runtime, Some(node_name))?;
            crate::engine::terminate_node(&active_id, node_name);
            let snapshot = runtime.state.clone();
            drop(runtime);
            return Ok(snapshot);
        }

        // 全局 stop/cancel（未指定 node 时，才打断 Planner 并暂停整个图）
        if service.planning.load(Ordering::SeqCst) && !active_id.is_empty() {
            CANCELLED_PLANNING
                .get_or_init(Default::default)
                .lock()
                .map_err(|e| e.to_string())?
                .insert(active_id.clone());
        }
        if runtime.state.approved {
            let _ = runtime.pause(true);
        }
        runtime.emit(EventKind::StopRequested)?;
        stop_node_executions(&mut runtime, None)?;
        let snapshot = runtime.state.clone();
        drop(runtime);
        crate::engine::terminate_run(&active_id);
        return Ok(snapshot);
    }
    if !matches!(action.as_str(), "pause" | "resume") && service.planning.load(Ordering::SeqCst) {
        return Err("Wait for planning to finish".into());
    }
    if matches!(action.as_str(), "resolve" | "retry_publication")
        && service.driving.load(Ordering::SeqCst)
    {
        return Err(
            "Wait for active executions to finish before resolving or retrying publication".into(),
        );
    }
    let approval_lock = if action == "approve" {
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        if runtime.state.phase == "awaiting_approval" {
            let repository = runtime
                .state
                .config
                .as_ref()
                .ok_or("Missing config")?
                .repository
                .clone();
            crate::workspace::validate_binding(std::path::Path::new(&repository))?;
            Some(source_lock(std::path::Path::new(&repository))?)
        } else {
            None
        }
    } else {
        None
    };
    let _approval_guard = approval_lock
        .as_ref()
        .map(|lock| lock.lock().map_err(|e| e.to_string()))
        .transpose()?;
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    match action.as_str() {
        "retry_publication" => runtime.retry_publication()?,
        "approve" => {
            let _activity =
                ActivityGuard::begin(&runtime.state.run_id, "approve", "source_capture", "");
            runtime.approve()?;
        }
        "pause" => {
            runtime.pause(true)?;
            // UI Pause interrupts current nodes, not the Planner or other Runs.
            stop_node_executions(&mut runtime, None)?;
        },
        "resume" => runtime.pause(false)?,
        "reject" => {
            if runtime.state.phase != "awaiting_approval" {
                return Err("Only an unapproved plan can be rejected".into());
            }
            runtime.emit(EventKind::Rejected)?;
        }
        "resolve" => runtime.resolved(node.as_deref().unwrap_or_default())?,
        _ => return Err("Unknown action".into()),
    }
    let snapshot = runtime.state.clone();
    drop(runtime);
    if matches!(
        action.as_str(),
        "approve" | "resume" | "resolve" | "retry_publication"
    ) {
        drive(service.clone());
    }
    Ok(snapshot)
}

fn stop_node_executions(runtime: &mut Runtime, node: Option<&str>) -> Result<(), String> {
    for (node, execution_id) in runtime.request_execution_stop(node)? {
        crate::process_control::stop_owner(&crate::process_control::execution_owner(
            &runtime.state.run_id, &node, &execution_id,
        ))?;
    }
    Ok(())
}

fn edit_planner(
    run_id: String,
    old_text: String,
    instruction: String,
    selected_version: Option<usize>,
    service: &Arc<Service>,
) -> Result<Snapshot, String> {
    if service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current Planner turn to finish before editing history".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    let state = &runtime.state;
    if state.run_id != run_id || state.plan_type.as_deref() != Some("graph") {
        return Err("Select the active Graph Planner conversation".into());
    }
    if matches!(
        state.phase.as_str(),
        "publishing" | "merging" | "publication_failed"
    ) {
        return Err("Wait for publication before editing the Planner".into());
    }
    if instruction.trim().is_empty() || old_text.trim().is_empty() {
        return Err("Enter a Planner message".into());
    }
    let repository = PathBuf::from(&state.config.as_ref().ok_or("Missing config")?.repository);
    crate::workspace::validate_binding(&repository)?;
    let first = state
        .events
        .iter()
        .find_map(|event| event_planner_id(&event.kind))
        .or(state.planning_id.as_deref())
        .ok_or("No persisted Planner conversation")?
        .to_owned();
    let attempt = runtime.root.join("planning").join(&first);
    let workspace = fs::read_to_string(attempt.join("planner-workspace"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| repository.clone());
    let (session_dir, session_id) = planner_session_directory_for_workspace(
        &runtime.root,
        &attempt,
        &repository,
        &workspace,
        Some(state),
    )?;
    let session_file = match fs::read_dir(&session_dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(&format!("_{session_id}.jsonl"))
            })
            .map(|entry| entry.path()),
        // An attempt that never launched Pi has no conversation to branch.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let branch = match session_file {
        Some(file) => {
            let header = fs::read_to_string(&file).map_err(|error| error.to_string())?;
            let cwd = serde_json::from_str::<serde_json::Value>(
                header.lines().next().ok_or("Empty Planner session")?,
            )
            .map_err(|error| error.to_string())?["cwd"]
                .as_str()
                .ok_or("Missing Planner cwd")?
                .to_string();
            Some(crate::session_branch::branch_before_planner_user(
                &session_dir,
                &session_id,
                std::path::Path::new(&cwd),
                old_text.trim(),
            )?)
        }
        None => {
            // A legacy conversation stored under an unexpected filename must
            // fail loudly rather than be silently replaced by a fresh one.
            let has_sessions = fs::read_dir(&session_dir).ok().is_some_and(|entries| {
                entries.filter_map(Result::ok).any(|entry| {
                    entry.path().extension().is_some_and(|ext| ext == "jsonl")
                        && entry.path().is_file()
                })
            });
            if has_sessions {
                return Err("Planner Pi session is missing".into());
            }
            None
        }
    };
    let mut first_turn = old_text.trim() == state.graph.original_goal.trim();
    if selected_version == Some(0) {
        first_turn = true;
    }
    if let Err(error) = runtime.emit(EventKind::PlannerConversationEdited {
        old_instruction: old_text.trim().into(),
        instruction: instruction.trim().into(),
        first_turn,
        selected_version,
    }) {
        return Err(match branch {
            Some(branch) => match branch.rollback() {
                Ok(()) => error,
                Err(rollback) => format!("{error}; {rollback}"),
            },
            None => error,
        });
    }
    Ok(runtime.state.clone())
}

fn edit_node(
    node: String,
    execution_id: String,
    old_text: String,
    instruction: String,
    run_id: String,
    images: Option<Vec<crate::model::ImageAttachment>>,
    selected_version: Option<usize>,
    user_turn_offset: Option<usize>,
    service: &Arc<Service>,
) -> Result<Snapshot, String> {
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    if runtime.state.run_id != run_id {
        return Err("Run changed while editing a message".into());
    }
    #[cfg(not(feature = "fixture"))]
    crate::engine::invalidate_warm_node();
    runtime.edit_node_message_at(
        &node,
        &execution_id,
        &old_text,
        &instruction,
        images,
        selected_version,
        user_turn_offset,
    )?;
    let snapshot = runtime.state.clone();
    drop(runtime);
    drive(service.clone());
    Ok(snapshot)
}

fn detect_repository(
    path: Option<String>,
) -> Result<Option<crate::workspace::RepositoryInfo>, String> {
    crate::workspace::detect(path.as_deref().map(std::path::Path::new))
}

fn reset_workspace(service: &Arc<Service>) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    #[cfg(not(feature = "fixture"))]
    crate::engine::invalidate_warm_node();
    let root = runtime.root.clone();
    let id = runtime.state.run_id.clone();
    let result = runtime.reset_workspace()?;
    drop(runtime);
    invalidate_service_cache(&root, Some(&id));
    Ok(result)
}

fn clear_history(service: &Arc<Service>) -> Result<(), String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let root = service
        .runtime
        .lock()
        .map_err(|e| e.to_string())?
        .root
        .clone();
    let children: Vec<_> = if let Some(registry) = RUN_SERVICES.get() {
        let registry = registry.lock().map_err(|e| e.to_string())?;
        registry.get(&root).into_iter().flat_map(|runs| runs.values()).filter_map(Weak::upgrade).collect()
    } else { Vec::new() };
    // Never wait on a runtime while holding the registry mutex: service lookup
    // holds the primary runtime before acquiring the registry.
    for child in children {
        if child.driving.load(Ordering::SeqCst)
            || child.planning.load(Ordering::SeqCst)
            || child.runtime.lock().map_err(|e| e.to_string())?.active()
        {
            return Err("Cannot clear history while another Run is active".into());
        }
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    #[cfg(not(feature = "fixture"))]
    crate::engine::invalidate_warm_node();
    runtime.clear_history()?;
    drop(runtime);
    invalidate_service_cache(&root, None);
    Ok(())
}

fn delete_run(run_id: String, service: &Arc<Service>) -> Result<(), String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    #[cfg(not(feature = "fixture"))]
    crate::engine::invalidate_warm_node();
    // A deleted Run must not leave a warm Serial shell (and its services) behind.
    crate::engine::stop_lingering_for_run(&run_id);
    let root = runtime.root.clone();
    runtime.delete_run(&run_id)?;
    drop(runtime);
    invalidate_service_cache(&root, Some(&run_id));
    Ok(())
}

/// Remove a binding's conversations, never the source project or shared engine
/// cache. Resolve ownership from the database, not the browser's run index.
fn delete_workspace(repository: String, service: &Arc<Service>) -> Result<Vec<String>, String> {
    if repository.trim().is_empty() || !std::path::Path::new(&repository).is_absolute() {
        return Err("An absolute workspace repository is required".into());
    }
    let (root, mut ids) = {
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        let mut ids = Vec::new();
        for id in runtime.store.runs()? {
            let state = runtime.store.load(&id)?;
            if state.config.as_ref().is_some_and(|config| same_repository_binding(&config.repository, &repository)) {
                ids.push(id);
            }
        }
        (runtime.root.clone(), ids)
    };
    ids.sort();
    if ids.is_empty() { return Ok(ids); }
    let services = ids.iter().map(|id| service_for_run(service, id, false)).collect::<Result<Vec<_>, _>>()?;
    // Keep every affected Run locked until the batch commits. Try-lock rather
    // than waiting while holding another Run; never hold the registry here.
    let mut runtimes = Vec::new();
    for (id, target) in ids.iter().zip(&services) {
        let runtime = target.runtime.try_lock().map_err(|_| "Workspace is busy; wait for its operations to finish")?;
        if target.driving.load(Ordering::SeqCst) || target.planning.load(Ordering::SeqCst) || runtime.active()
            || runtime.state.phase == "planning"
        {
            return Err("Cannot remove a workspace while one of its conversations is active".into());
        }
        if runtime.state.run_id != *id
            || !runtime.state.config.as_ref().is_some_and(|config| same_repository_binding(&config.repository, &repository))
        {
            return Err("Workspace ownership changed; refresh before removing it".into());
        }
        runtimes.push(runtime);
    }
    #[cfg(not(feature = "fixture"))]
    crate::engine::invalidate_warm_node();
    for id in &ids {
        crate::engine::stop_lingering_for_run(id);
    }
    runtimes[0].delete_runs(&ids)?;
    for runtime in &mut runtimes { runtime.forget_deleted_runs(&ids); }
    drop(runtimes);
    for id in &ids { invalidate_service_cache(&root, Some(id)); }
    Ok(ids)
}

fn retry_cleanup_tasks(service: &Arc<Service>) -> Result<(), String> {
    let tasks = service.runtime.lock().map_err(|error| error.to_string())?.store.pending_cleanups()?;
    for task in tasks {
        let target = if task.manifest.sequence.is_some() {
            match service_for_run(service, &task.run_id, false) {
                Ok(target) => target,
                Err(_) => service.clone(),
            }
        } else { service.clone() };
        if task.manifest.sequence.is_some()
            && (target.driving.load(Ordering::SeqCst) || target.planning.load(Ordering::SeqCst)) { continue; }
        let runtime = target.runtime.lock().map_err(|error| error.to_string())?;
        if task.manifest.sequence.is_some()
            && (target.driving.load(Ordering::SeqCst) || target.planning.load(Ordering::SeqCst)) { continue; }
        if let Err(error) = runtime.retry_cleanup(&task.run_id) {
            eprintln!("[Grapher] Pending cleanup {}: {error}", task.run_id);
        }
    }
    Ok(())
}

fn recover_cleanup_tasks(service: &Arc<Service>) -> Result<(), String> {
    {
        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        runtime.store.backfill_cleanup_sources()?;
        for id in runtime.store.orphaned_cleanup_owners()? {
            let manifest = crate::cleanup::Manifest {
                targets: runtime.store.owned_cleanup_targets(&id)?, ..Default::default()
            };
            runtime.store.delete_run_with_cleanup(&id, Some(&manifest))?;
        }
        for task in crate::cleanup::idle_partitioners(&runtime.root, &runtime.store)? {
            runtime.store.delete_run_with_cleanup(&task.run_id, Some(&task.manifest))?;
        }
        // Catch successful publications whose cleanup was interrupted before
        // queueing, including workspaces left by older versions.
        for id in runtime.store.completed_workspace_runs()? {
            if runtime.store.cleanup_task(&id)?.is_none() {
                let state = runtime.store.load(&id)?;
                runtime.store.enqueue_cleanup(&id, &crate::cleanup::Manifest {
                    targets: runtime.store.owned_cleanup_targets(&id)?,
                    sequence: Some(state.events.last().map_or(0, |event| event.sequence)),
                    ..Default::default()
                })?;
            }
        }
    }
    retry_cleanup_tasks(service)
}

fn planning_attachment_path(
    dir: &std::path::Path,
    index: usize,
    image: &ImageAttachment,
) -> PathBuf {
    let ext = match image.mime_type.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    };
    // Client filenames are display data, not paths under our writable data dir.
    dir.join(format!("image_{index}.{ext}"))
}

fn is_valid_planning_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !id.starts_with('.')
        && id != ".."
}

fn enrich_planning_summary(summary: &mut PlanningSummary, directory: &std::path::Path) {
    if summary.plan_type.is_none() {
        summary.plan_type = fs::read(directory.join("route.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<Route>(&bytes).ok())
            .map(|route| route.plan_type);
    }
    if summary.goal.is_none() || summary.run_id.is_none() {
        if let Ok(bytes) = fs::read(directory.join("request.json")) {
            if let Ok(req) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if summary.goal.is_none() {
                    summary.goal = req["goal"].as_str().map(str::to_owned);
                }
                if summary.run_id.is_none() {
                    summary.run_id = req["runId"].as_str().map(str::to_owned);
                }
            }
        }
    }
}

fn get_planning(planning_id: String, service: &Arc<Service>) -> Result<PlanningSummary, String> {
    if !is_valid_planning_id(&planning_id) {
        return Err(format!("Invalid planning ID: {planning_id}"));
    }
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    let planning_dir = runtime.root.join("planning");
    let summary_path = planning_dir.join(&planning_id).join("summary.json");
    if let Ok(canonical_summary) = summary_path.canonicalize() {
        if let Ok(canonical_planning_dir) = planning_dir.canonicalize() {
            if !canonical_summary.starts_with(&canonical_planning_dir) {
                return Err(format!(
                    "Invalid planning ID: path traversal detected: {planning_id}"
                ));
            }
        }
    }
    if summary_path.exists() {
        let content = fs::read_to_string(&summary_path).map_err(|error| error.to_string())?;
        let mut summary =
            serde_json::from_str::<PlanningSummary>(&content).map_err(|error| error.to_string())?;
        if summary.repository.is_none() {
            if let Some(repo) = runtime
                .store
                .find_repository_by_planning_id(&summary.planning_id)
            {
                summary.repository = Some(repo);
                if let Ok(migrated_json) = serde_json::to_string_pretty(&summary) {
                    let _ = fs::write(&summary_path, migrated_json);
                }
            }
        }
        enrich_planning_summary(&mut summary, &planning_dir.join(&planning_id));
        Ok(summary)
    } else {
        Err(format!("Planning summary not found: {planning_id}"))
    }
}

// Planning traces are loaded only when opened in the UI. Keep raw model output
// out of bootstrap/list/poll responses and cap each UTF-8-safe page.
fn get_planning_output(
    planning_id: String,
    role: String,
    offset: u64,
    tail: bool,
    before: Option<u64>,
    limit: Option<u64>,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    if !is_valid_planning_id(&planning_id) {
        return Err("Invalid planning ID".into());
    }
    if !matches!(role.as_str(), "partition" | "planner") {
        return Err("Invalid planning role".into());
    }
    let root = service
        .runtime
        .lock()
        .map_err(|e| e.to_string())?
        .root
        .join("planning");
    let root = root
        .canonicalize()
        .map_err(|_| "Planning output not found")?;
    let directory = root
        .join(&planning_id)
        .canonicalize()
        .map_err(|_| "Planning output not found")?;
    if !directory.starts_with(&root) {
        return Err("Invalid planning output path".into());
    }
    let running = fs::read(directory.join("summary.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PlanningSummary>(&bytes).ok())
        .is_some_and(|summary| summary.status.as_deref() == Some("running"));
    let file_path = directory.join(format!("{role}.jsonl"));
    if !file_path.exists() && running && offset == 0 {
        return Ok(
            serde_json::json!({ "planningId": planning_id, "role": role, "content": "",
            "nextOffset": 0, "totalBytes": 0, "complete": true, "running": true }),
        );
    }
    let file_path = file_path
        .canonicalize()
        .map_err(|_| "Planning output not found")?;
    if !file_path.starts_with(&root) {
        return Err("Invalid planning output path".into());
    }
    let mut file = fs::File::open(file_path).map_err(|e| e.to_string())?;
    let total_bytes = file.metadata().map_err(|e| e.to_string())?.len();
    // Larger bounded backward pages reduce scrollback round trips. Live forward
    // reads retain the existing 256 KiB ceiling and byte-cursor contract.
    let limit = limit.unwrap_or(256 * 1024).clamp(4, if tail { 1024 * 1024 } else { 256 * 1024 });
    if offset > total_bytes {
        return Err("Invalid planning output offset".into());
    }
    if tail {
        let end = before.unwrap_or(total_bytes).min(total_bytes);
        if end == 0 {
            return Ok(serde_json::json!({ "planningId": planning_id, "role": role,
                "content": "", "startOffset": 0, "nextOffset": 0, "totalBytes": total_bytes,
                "complete": total_bytes == 0, "running": running }));
        }
        let candidate = end.saturating_sub(limit);
        // Include the line containing the candidate when it is cheap to do so.
        // JSONL consumers can then prepend an older page without losing a
        // message split at the window boundary.
        let window_start = candidate.saturating_sub(256 * 1024);
        file.seek(SeekFrom::Start(window_start)).map_err(|e| e.to_string())?;
        let mut window = Vec::new();
        (&mut file).take(candidate.saturating_sub(window_start)).read_to_end(&mut window).map_err(|e| e.to_string())?;
        let valid_start = window.iter().rposition(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(0);
        let start = window_start + valid_start as u64;
        file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        (&mut file).take(end.saturating_sub(start)).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        // A single JSONL record can exceed the look-behind budget. In that
        // case start may be in a Unicode code point; move to its next boundary
        // without scanning or loading the entire file.
        let leading = bytes.iter().take_while(|byte| (**byte & 0xc0) == 0x80).count();
        let start = start + leading as u64;
        let bytes = &bytes[leading..];
        let length = match std::str::from_utf8(bytes) {
            Ok(_) => bytes.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => return Err("Invalid planning output UTF-8 offset".into()),
        };
        let content = std::str::from_utf8(&bytes[..length]).map_err(|e| e.to_string())?;
        let next_offset = start + length as u64;
        // The planner writer appends to this file concurrently. A size sampled
        // before the reads may already be stale; re-sample so totalBytes covers
        // what this page actually observed.
        let total_bytes = total_bytes.max(file.metadata().map(|meta| meta.len()).unwrap_or(0));
        return Ok(serde_json::json!({ "planningId": planning_id, "role": role,
            "content": content, "startOffset": start, "nextOffset": next_offset,
            "totalBytes": total_bytes, "complete": next_offset >= total_bytes, "running": running }));
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    (&mut file).take(limit)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let length = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => return Err("Invalid planning output UTF-8 offset".into()),
    };
    let content = std::str::from_utf8(&bytes[..length]).map_err(|e| e.to_string())?;
    let next_offset = offset + length as u64;
    // Same concurrent-append hazard as the tail path: the size was sampled
    // before the read, so a page that observed bytes appended in between would
    // report nextOffset beyond totalBytes and the frontend would reject it as
    // an invalid transcript byte range. Re-sample, and keep the reported total
    // at or above the observed cursor by construction.
    let total_bytes = total_bytes
        .max(file.metadata().map(|meta| meta.len()).unwrap_or(0))
        .max(next_offset);
    Ok(serde_json::json!({ "planningId": planning_id, "role": role,
        "content": content, "startOffset": offset, "nextOffset": next_offset, "totalBytes": total_bytes,
        "complete": next_offset >= total_bytes, "running": running }))
}

// History keeps the original binding string. Compare resolved directories when
// available; on Windows also recognize lexical aliases for archived/deleted paths.
// Never treat two failed canonicalizations (or an unattributed record) as equal.
fn same_repository_binding(left: &str, right: &str) -> bool {
    if left.is_empty() || right.trim().is_empty() { return false; }
    if left == right { return true; }
    let left = std::path::Path::new(left);
    let right = std::path::Path::new(right);
    if !left.is_absolute() || !right.is_absolute() { return false; }
    if let (Ok(left), Ok(right)) = (left.canonicalize(), right.canonicalize()) {
        return left == right;
    }
    #[cfg(windows)]
    if let (Some(left), Some(right)) = (windows_repository_key(left), windows_repository_key(right)) {
        return left == right;
    }
    false
}

#[cfg(windows)]
fn windows_repository_key(path: &std::path::Path) -> Option<String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return None;
    }
    // Archived bindings may point at a deleted final directory. Canonicalize
    // the longest existing ancestor first so 8.3 aliases such as RUNNER~1
    // still match the saved long path without guessing a missing component.
    let original = path.to_path_buf();
    let mut probe = original.clone();
    let mut missing = Vec::new();
    let mut found_existing = probe.exists();
    while !found_existing {
        let Some(name) = probe.file_name().map(|name| name.to_os_string()) else {
            break;
        };
        missing.push(name);
        if !probe.pop() {
            break;
        }
        found_existing = probe.exists();
    }
    if found_existing {
        if let Ok(canonical) = probe.canonicalize() {
            probe = canonical;
            for name in missing.iter().rev() {
                probe.push(name);
            }
        }
    } else {
        probe = original;
    }
    let value = probe.to_str()?.replace('/', "\\").to_lowercase();
    let value = if let Some(unc) = value.strip_prefix(r"\\?\unc\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
    };
    Some(value.trim_end_matches('\\').to_owned())
}

fn list_plannings(
    service: &Arc<Service>,
    repository_filter: Option<String>,
) -> Result<Vec<PlanningSummary>, String> {
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    let planning_dir = runtime.root.join("planning");
    if !planning_dir.exists() {
        return Ok(Vec::new());
    }
    let filter = repository_filter.as_deref().map(str::trim);
    if filter == Some("") { return Ok(Vec::new()); }
    let mut summaries = Vec::new();
    if let Ok(entries) = fs::read_dir(planning_dir) {
        for entry in entries.flatten() {
            let summary_path = entry.path().join("summary.json");
            if summary_path.exists() {
                if let Ok(content) = fs::read_to_string(&summary_path) {
                    if let Ok(mut summary) = serde_json::from_str::<PlanningSummary>(&content) {
                        // If repository is missing, attempt to backfill from associated run in event store
                        if summary.repository.is_none() {
                            if let Some(repo) = runtime
                                .store
                                .find_repository_by_planning_id(&summary.planning_id)
                            {
                                summary.repository = Some(repo);
                                if let Ok(migrated_json) = serde_json::to_string_pretty(&summary) {
                                    let _ = fs::write(&summary_path, migrated_json);
                                }
                            }
                        }

                        // Filter by repository if requested (fail closed)
                        if let Some(filter) = filter {
                            if !summary.repository.as_deref().is_some_and(|repo| same_repository_binding(repo, filter)) {
                                continue; // Reject unrelated or unattributed history.
                            }
                        }
                        enrich_planning_summary(&mut summary, &entry.path());
                        summaries.push(summary);
                    }
                }
            }
        }
    }
    summaries.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.planning_id.cmp(&a.planning_id))
    });
    Ok(summaries)
}

fn argument<T: serde::de::DeserializeOwned>(
    body: &serde_json::Value,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(body.get(key).cloned().unwrap_or(serde_json::Value::Null))
        .map_err(|error| format!("Invalid {key}: {error}"))
}

fn get_execution_output(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    let run_id: String = argument(body, "runId")?;
    let execution_id: String = argument(body, "executionId")?;
    let offset: usize = body
        .get("offset")
        .map(|_| argument(body, "offset"))
        .transpose()?
        .unwrap_or(0);
    let tail = body.get("tail").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let before: Option<usize> = body
        .get("before")
        .map(|_| argument(body, "before"))
        .transpose()?;
    let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    if runtime.state.run_id != run_id { return Err("Run does not match service".into()); }
    let status = runtime.state.executions.iter().chain(&runtime.state.mergers)
        .find(|exec| exec.id == execution_id).ok_or("Execution not found in run")?.status.clone();
    let mut total = runtime.store.log_bytes(&run_id, &execution_id)?;
    if total == 0 && status != "running" {
        total = runtime.store.ensure_legacy_logs(&run_id, &execution_id)?;
        let state = &mut runtime.state;
        if let Some(exec) = state.executions.iter_mut().chain(state.mergers.iter_mut()).find(|e| e.id == execution_id) {
            exec.output_bytes = total;
        }
        if total > 0 { runtime.touch(); }
    }
    let limit = if status != "running" && body.get("full").and_then(serde_json::Value::as_bool) == Some(true) {
        usize::MAX
    } else {
        body.get("limit").map(|_| argument::<usize>(body, "limit")).transpose()?.unwrap_or(256 * 1024).clamp(4, 1024 * 1024)
    };
    // Prefix views use the durable edit cursor, not the abandoned execution's
    // physical EOF. Byte offsets stay those of the original immutable log.
    let end = body.get("endOffset").map(|_| argument::<usize>(body, "endOffset")).transpose()?.unwrap_or(total).min(total);
    let mut page = if tail {
        runtime.store.execution_log_tail_page(&run_id, &execution_id, before.unwrap_or(end).min(end), limit)?
    } else {
        if offset > end { return Err("Invalid prefix output offset".into()); }
        runtime.store.execution_log_page(&run_id, &execution_id, offset, limit.min(end - offset))?
    };
    page.total_bytes = end;
    page.complete = page.next_offset == end;
    // Legacy events without a checkpoint have no structured metrics. Recover
    // them from the already requested full response, never during Store::load.
    if end == total && !page.content.is_empty() && page.start_offset == 0 && page.complete {
        if let Some(exec) = runtime.state.executions.iter().chain(&runtime.state.mergers)
            .find(|e| e.id == execution_id) {
            let repo = runtime.state.config.as_ref().map(|c| c.repository.as_str()).unwrap_or_default();
            crate::file_changes::update_from_log_text(
                &run_id,
                &execution_id,
                &exec.node,
                &exec.worktree,
                repo,
                &page.content,
                status == "running",
                true,
            );
        }
    }
    if end == total && status != "running" && page.start_offset == 0 && page.complete {
        let state = &mut runtime.state;
        if let Some(exec) = state.executions.iter_mut().chain(state.mergers.iter_mut())
            .find(|e| e.id == execution_id && e.metrics.is_none()) {
            exec.metrics = Some(parse_execution_metrics(&page.content, exec.started_at, exec.completed_at.unwrap_or_else(now)));
            state.run_metrics = Some(state.compute_run_metrics());
            runtime.touch();
        }
    }
    // Metrics written before context counters existed only carry totals, and a
    // finished session's context is its newest prompt: at the end of the log.
    // Recover it from whichever page reaches that end instead of re-reading
    // whole historical logs during load.
    if end == total && status != "running" && page.complete {
        let stale = |metrics: &Option<ExecutionMetrics>| metrics.as_ref()
            .is_some_and(|metrics| metrics.context_tokens == 0 && metrics.assistant_messages > 0);
        if runtime.state.executions.iter().chain(&runtime.state.mergers)
            .any(|e| e.id == execution_id && stale(&e.metrics)) {
            let mut recovered = crate::model::parse_context_from_tail(&page.content);
            if recovered == 0 {
                // A long failed tail can exceed the delivered page. Look back one
                // bounded window instead of charging a full log to every read.
                const BACKFILL_WINDOW: usize = 1024 * 1024;
                recovered = runtime.store
                    .execution_log_tail_page(&run_id, &execution_id, page.total_bytes, BACKFILL_WINDOW)
                    .map(|wide| crate::model::parse_context_from_tail(&wide.content))
                    .unwrap_or(0);
            }
            if recovered > 0 {
                let state = &mut runtime.state;
                let target = state.executions.iter_mut().chain(state.mergers.iter_mut())
                    .find(|e| e.id == execution_id && stale(&e.metrics));
                if let Some(metrics) = target.and_then(|e| e.metrics.as_mut()) {
                    metrics.context_tokens = recovered;
                    state.run_metrics = Some(state.compute_run_metrics());
                    runtime.touch();
                }
            }
        }
    }
    Ok(serde_json::json!({ "runId":run_id, "executionId":execution_id,
        "content":page.content, "startOffset":page.start_offset, "nextOffset":page.next_offset, "totalBytes":page.total_bytes,
        "complete":page.complete, "status":status }))
}

fn get_file_changes(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    let requested_run_id = body
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let execution_id = body
        .get("executionId")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let execution_ids: Option<Vec<String>> = argument(body, "executionIds")?;
    if execution_id.is_some() && execution_ids.is_some() {
        return Err("Specify executionId or executionIds, not both".into());
    }
    let scope = execution_ids.clone().or_else(|| execution_id.clone().map(|id| vec![id]));
    let (state, root, fence) = {
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        let state = if requested_run_id.is_empty() || runtime.state.run_id == requested_run_id {
            runtime.state.clone()
        } else {
            runtime.store.load(&requested_run_id)?
        };
        // Pair freshness tokens with this snapshot before releasing its Run
        // mutex. Sampling tokens only when cold I/O starts is already too late.
        let fence = crate::file_changes::capture_warm_fence(&state, scope.as_deref())?;
        (state, runtime.root.clone(), fence)
    };
    // Cold sidecar/log parsing and Git diffs never hold the Run mutex. Use a
    // read-only connection, and warm only this request's execution scope.
    // Cache publication is fenced against concurrent live output/invalidation.
    let reader = crate::store::Store::open_reader(&root.join("events.sqlite"))?;
    crate::file_changes::warm_scoped_changes(&state, &reader, Some(&root), scope.as_deref(), &fence);

    let summary = if let Some(ids) = &scope {
        let selected: Vec<_> = state.executions.iter().chain(state.mergers.iter())
            .filter(|exec| ids.contains(&exec.id))
            .collect();
        let parts: Vec<_> = selected.iter().map(|exec| {
            let cached = crate::file_changes::get_cached_execution_changes(&state.run_id, exec)
                .unwrap_or_default();
            if exec.status == "running" && !exec.before.is_empty() && !exec.worktree.is_empty() {
                if let Some(live_git) = crate::file_changes::compute_git_changes(
                    std::path::Path::new(&exec.worktree),
                    &exec.before,
                    None,
                    &exec.node,
                    &exec.id,
                ) {
                    return crate::file_changes::merge_summaries(&[cached, live_git], true);
                }
            }
            cached
        }).collect();
        // Union complete per-execution paths before capping the response. Adding
        // already-capped totals in the browser cannot deduplicate shared files.
        crate::file_changes::merge_summaries(&parts, selected.iter().any(|exec| exec.status == "running"))
    } else {
        crate::file_changes::get_cached_run_changes(&state).unwrap_or_default()
    };
    // The browser renders at most a small slice; keep the true totals and cap
    // the transferred rows so a build-heavy Run stays cheap to display.
    let summary = crate::file_changes::cap_summary_files(
        summary, crate::file_changes::MAX_DISPLAYED_FILE_CHANGES);

    Ok(serde_json::json!({
        "runId": state.run_id,
        "executionId": execution_id,
        "executionIds": execution_ids,
        "summary": summary,
    }))
}

fn get_merger_prompt(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    let run_id: String = argument(body, "runId")?;
    let execution_id: String = argument(body, "executionId")?;
    let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    if runtime.state.run_id != run_id {
        return Err("Run does not match service".into());
    }
    let prompt_path = runtime
        .root
        .join("mergers")
        .join(&execution_id)
        .join("system-prompt.md");
    if prompt_path.is_file() {
        let content = fs::read_to_string(&prompt_path).map_err(|e| e.to_string())?;
        return Ok(serde_json::json!({
            "runId": run_id,
            "executionId": execution_id,
            "prompt": content,
        }));
    }
    if let Some(merger) = runtime.state.mergers.iter().find(|m| m.id == execution_id) {
        let target_node_name = merger.node.strip_prefix("merge:").unwrap_or(&merger.node);
        let target_task = if target_node_name == "merger" {
            runtime.state.graph.original_goal.clone()
        } else {
            runtime
                .state
                .graph
                .nodes
                .iter()
                .find(|n| n.name == target_node_name)
                .map(|n| n.task.clone())
                .unwrap_or_else(|| runtime.state.graph.original_goal.clone())
        };
        let content = crate::graph_merge::merger_prompt(
            &target_task,
            crate::graph_merge::MergerConflicts::GIT,
        );
        return Ok(serde_json::json!({
            "runId": run_id,
            "executionId": execution_id,
            "prompt": content,
        }));
    }
    Err("Merger execution not found in run".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillItem {
    name: String,
    description: String,
    path: String,
    scope: String,
}

fn parse_skill_markdown(path: &std::path::Path) -> Option<(String, String)> {
    let content = fs::read_to_string(path).ok()?;
    let mut name = None;
    let mut description = None;

    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("---") {
            let frontmatter = &content[3..3 + end_idx];
            let mut in_desc_block = false;
            let mut desc_lines = Vec::new();

            for line in frontmatter.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("name:") {
                    in_desc_block = false;
                    let val = rest.trim().trim_matches('"').trim_matches('\'').trim();
                    if !val.is_empty() {
                        name = Some(val.to_string());
                    }
                } else if let Some(rest) = trimmed.strip_prefix("description:") {
                    let val = rest.trim().trim_matches('"').trim_matches('\'').trim();
                    if val.is_empty() || val == ">-" || val == "|" || val == ">" {
                        in_desc_block = true;
                    } else {
                        in_desc_block = false;
                        description = Some(val.to_string());
                    }
                } else if in_desc_block {
                    if line.starts_with("  ") || line.starts_with('\t') {
                        let t = line.trim();
                        if !t.is_empty() {
                            desc_lines.push(t);
                        }
                    } else if !trimmed.is_empty() {
                        in_desc_block = false;
                    }
                }
            }

            if description.is_none() && !desc_lines.is_empty() {
                description = Some(desc_lines.join(" "));
            }
        }
    }

    let skill_name = name.unwrap_or_else(|| {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".to_string())
    });

    let skill_desc = description.unwrap_or_else(|| {
        content
            .lines()
            .find(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#') && !t.starts_with("---")
            })
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    });

    Some((skill_name, skill_desc))
}

fn resolve_repo_path(service: &Arc<Service>, repository_param: Option<String>) -> PathBuf {
    if let Some(repo) = repository_param.filter(|s| !s.trim().is_empty()) {
        return PathBuf::from(repo);
    }
    if let Ok(runtime) = service.runtime.lock() {
        if let Some(config) = &runtime.state.config {
            if !config.repository.trim().is_empty() {
                return PathBuf::from(&config.repository);
            }
        }
    }
    if let Ok(Some(repo)) = crate::workspace::detect(None) {
        return PathBuf::from(repo.path);
    }
    // 当进程在子目录（如 backend/）执行时，通过 git rev-parse 向上查找仓库根目录
    if let Ok(output) = std::process::Command::new("git")
        .arg("rev-parse")
        .arg("--show-toplevel")
        .output()
    {
        if output.status.success() {
            let toplevel = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !toplevel.is_empty() {
                return PathBuf::from(toplevel);
            }
        }
    }
    let installation = crate::native::installation_root();
    if installation.exists() {
        return installation;
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn is_excluded_project_path(rel_path: &str) -> bool {
    let lower = rel_path.to_lowercase();
    // 排除技能目录、内部框架目录、版本控制和编译产物，不把 skill 规则文档当做项目文件
    if lower.starts_with(".agents/")
        || lower == ".agents"
        || lower.starts_with(".pi/")
        || lower == ".pi"
        || lower.starts_with(".git/")
        || lower == ".git"
        || lower.starts_with(".grapher/")
        || lower == ".grapher"
        || lower.starts_with(".gemini/")
        || lower == ".gemini"
        || lower.starts_with(".codex/")
        || lower == ".codex"
        || lower.starts_with("node_modules/")
        || lower == "node_modules"
        || lower.starts_with("target/")
        || lower == "target"
        || lower.starts_with("dist/")
        || lower == "dist"
        || lower.starts_with("build/")
        || lower == "build"
        || lower.starts_with(".next/")
        || lower == ".next"
        || lower.ends_with(".ds_store")
    {
        return true;
    }
    // 排除任何以点开头的隐藏目录（如 .cache/, .husky/ 等），保留根目录常规点文件（如 .gitignore, .env.example）
    for (idx, part) in rel_path.split('/').enumerate() {
        if part.starts_with('.') {
            let is_root_file = idx == 0 && !rel_path.contains('/');
            let is_allowed_dotfile =
                part == ".gitignore" || part == ".gitmodules" || part.starts_with(".env");
            if !(is_root_file && is_allowed_dotfile) {
                return true;
            }
        }
    }
    false
}

fn collect_files_from_dir(dir: &std::path::Path) -> Vec<String> {
    let mut files = Vec::new();
    let is_git = dir.join(".git").exists() || crate::workspace::is_standard_git(dir);
    if is_git {
        if let Ok(output) = std::process::Command::new("git")
            .arg("ls-files")
            .arg("-z")
            .arg("--cached")
            .arg("--others")
            .arg("--exclude-standard")
            .current_dir(dir)
            .output()
        {
            if output.status.success() {
                for entry in output.stdout.split(|byte| *byte == 0) {
                    let Ok(path) = std::str::from_utf8(entry) else { continue; };
                    if !path.is_empty() && !is_excluded_project_path(path) {
                        files.push(path.to_string());
                    }
                }
            }
        }
    }

    if files.is_empty() {
        fn walk(
            walk_dir: &std::path::Path,
            base: &std::path::Path,
            files: &mut Vec<String>,
            limit: usize,
        ) {
            if files.len() >= limit {
                return;
            }
            if let Ok(entries) = fs::read_dir(walk_dir) {
                for entry in entries.flatten() {
                    if files.len() >= limit {
                        break;
                    }
                    let path = entry.path();
                    if let Ok(rel) = path.strip_prefix(base) {
                        let rel_str = rel.to_string_lossy().replace('\\', "/");
                        if is_excluded_project_path(&rel_str) {
                            continue;
                        }
                    }
                    if path.is_dir() {
                        walk(&path, base, files, limit);
                    } else if path.is_file() {
                        if let Ok(rel) = path.strip_prefix(base) {
                            let rel_str = rel.to_string_lossy().replace('\\', "/");
                            if !is_excluded_project_path(&rel_str) {
                                files.push(rel_str);
                            }
                        }
                    }
                }
            }
        }
        walk(dir, dir, &mut files, 3000);
    }
    files
}

fn list_files(
    service: &Arc<Service>,
    repository_param: Option<String>,
) -> Result<serde_json::Value, String> {
    let repo_path = resolve_repo_path(service, repository_param);
    let mut files = if repo_path.exists() {
        collect_files_from_dir(&repo_path)
    } else {
        Vec::new()
    };

    files.sort();
    Ok(serde_json::json!({ "files": files }))
}

fn list_skills(
    service: &Arc<Service>,
    repository_param: Option<String>,
) -> Result<serde_json::Value, String> {
    let repo_path = resolve_repo_path(service, repository_param);
    let home_dir = crate::native::home_dir();
    let mut search_dirs: Vec<(PathBuf, &'static str)> = Vec::new();

    // 1. Pi 工作区技能规范 (Project Skills: .agents/skills, .pi/skills, skills)
    search_dirs.push((repo_path.join(".agents").join("skills"), "workspace"));
    search_dirs.push((repo_path.join(".pi").join("skills"), "workspace"));
    search_dirs.push((repo_path.join("skills"), "workspace"));

    // 2. Grapher 宿主内置技能规范 (Grapher Host App: .agents/skills, .pi/skills, skills)
    {
        let grapher_root = crate::native::installation_root();
        if grapher_root != repo_path {
            search_dirs.push((grapher_root.join(".agents").join("skills"), "builtin"));
            search_dirs.push((grapher_root.join(".pi").join("skills"), "builtin"));
            search_dirs.push((grapher_root.join("skills"), "builtin"));
        }
    }

    // 3. Pi 全局用户技能规范 (User Skills: agent_dir/skills, ~/.pi/agent/skills, ~/.agents/skills, ~/.pi/skills)
    if let Ok(agent_dir) = crate::native::agent_dir() {
        search_dirs.push((agent_dir.join("skills"), "global"));
    }
    if let Some(ref home) = home_dir {
        search_dirs.push((
            home.join(".grapher").join("pi-agent").join("skills"),
            "global",
        ));
        search_dirs.push((home.join(".pi").join("agent").join("skills"), "global"));
        search_dirs.push((home.join(".agents").join("skills"), "global"));
        search_dirs.push((home.join(".pi").join("skills"), "global"));
    }

    let mut skills = Vec::new();
    let mut seen_names = std::collections::HashSet::new();

    fn scan_skills_dir(
        dir: &std::path::Path,
        scope: &str,
        skills: &mut Vec<SkillItem>,
        seen_names: &mut std::collections::HashSet<String>,
    ) {
        if !dir.exists() || !dir.is_dir() {
            return;
        }
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let skill_md = path.join("SKILL.md");
                    if skill_md.exists() {
                        if let Some((name, desc)) = parse_skill_markdown(&skill_md) {
                            if !seen_names.contains(&name) {
                                seen_names.insert(name.clone());
                                skills.push(SkillItem {
                                    name,
                                    description: desc,
                                    path: skill_md.to_string_lossy().to_string(),
                                    scope: scope.to_string(),
                                });
                            }
                        }
                    } else {
                        // 深入子分组目录扫描
                        scan_skills_dir(&path, scope, skills, seen_names);
                    }
                } else if path.is_file() {
                    // Pi 规范：~/.pi/agent/skills 与 ~/.pi/skills 支持直接根级单文件技能
                    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if file_name.ends_with(".md")
                        && file_name != "README.md"
                        && file_name != "AGENTS.md"
                    {
                        if let Some((name, desc)) = parse_skill_markdown(&path) {
                            if !seen_names.contains(&name) {
                                seen_names.insert(name.clone());
                                skills.push(SkillItem {
                                    name,
                                    description: desc,
                                    path: path.to_string_lossy().to_string(),
                                    scope: scope.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    for (dir, scope) in &search_dirs {
        scan_skills_dir(dir, scope, &mut skills, &mut seen_names);
    }

    skills.sort_by(|a, b| {
        let scope_order = |s: &str| match s {
            "workspace" => 0,
            "builtin" => 1,
            "global" => 2,
            _ => 3,
        };
        scope_order(&a.scope)
            .cmp(&scope_order(&b.scope))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(serde_json::json!({ "skills": skills }))
}

pub fn dispatch(
    service: &Arc<Service>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::to_value;
    let compact = body
        .get("compact")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let metadata = body.get("detail").and_then(serde_json::Value::as_str) == Some("metadata");
    if command == "snapshot_if_changed" {
        // Read transient activity before trying the Run lock: a long
        // source/workspace snapshot must not hide the progress indicator.
        let activity_run = body
            .get("runId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let activity = activity_run
            .as_deref()
            .map(run_activity)
            .unwrap_or_default();
        let requested = body
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let Ok(runtime) = service.runtime.try_lock() else {
            // The Run mutex is held by long filesystem work. Report progress
            // instead of queueing this poll behind the lock, and tell the client
            // to retry soon rather than wait for another change notification.
            return Ok(serde_json::json!({
                "version": requested,
                "snapshot": null,
                "activity": activity,
                "busy": true
            }));
        };
        let version = runtime.snapshot_version();
        if body.get("version").and_then(serde_json::Value::as_str) == Some(version.as_str()) {
            return Ok(
                serde_json::json!({ "version": version, "snapshot": null, "activity": activity }),
            );
        }
        // Hold the lock across version and snapshot capture so they describe
        // exactly the same state. Do not clone or serialize on a cache hit.
        let mut value = if metadata {
            snapshot_metadata(&runtime.state)?
        } else {
            serde_json::to_value(&runtime.state).map_err(|e| e.to_string())?
        };
        if compact {
            if let Some(events) = value
                .get_mut("events")
                .and_then(serde_json::Value::as_array_mut)
            {
                events.retain(|event| {
                    event.get("type").and_then(serde_json::Value::as_str) != Some("output")
                });
            }
        }
        return Ok(
            serde_json::json!({ "version": version, "snapshot": value, "activity": activity }),
        );
    }
    if command == "snapshot" && metadata {
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        return snapshot_metadata(&runtime.state);
    }
    if command == "history" && metadata {
        return snapshot_metadata(&history(argument(&body, "runId")?, service)?);
    }
    // Project strongly typed snapshots before converting them to JSON. These
    // commands return a Snapshot; other commands keep their usual response.
    if metadata {
        let state = match command {
            "load_run" => Some(load_run(argument(&body, "runId")?, service)?),
            "save_graph" => Some(save_graph(
                argument(&body, "graph")?,
                argument(&body, "config")?,
                argument(&body, "runId")?,
                service,
            )?),
            "plan_goal" => Some(plan_goal(
                argument(&body, "goal")?,
                argument(&body, "config")?,
                argument(&body, "mode").ok(),
                argument(&body, "images").ok(),
                service,
            )?),
            "control" => Some(control(
                argument(&body, "action")?,
                argument(&body, "node")?,
                argument(&body, "instruction")?,
                argument(&body, "runId")?,
                argument(&body, "executionId")?,
                argument(&body, "images").ok(),
                service,
            )?),
            "edit_planner" => Some(edit_planner(
                argument(&body, "runId")?,
                argument(&body, "oldText")?,
                argument(&body, "instruction")?,
                argument(&body, "versionIndex").ok(),
                service,
            )?),
            "edit_node" => Some(edit_node(
                argument(&body, "node")?,
                argument(&body, "executionId")?,
                argument(&body, "oldText")?,
                argument(&body, "instruction")?,
                argument(&body, "runId")?,
                argument(&body, "images").ok(),
                argument(&body, "versionIndex").ok(),
                body.get("userTurnOffset").filter(|value| !value.is_null()).map(|_| argument(&body, "userTurnOffset")).transpose()?,
                service,
            )?),
            "reset_workspace" => Some(reset_workspace(service)?),
            _ => None,
        };
        if let Some(state) = state {
            return snapshot_metadata(&state);
        }
    }
    let result = match command {
        "pi_extensions" => {
            let changed = body["operation"] == "set_enabled";
            let result = crate::pi_extensions::request(body)?;
            #[cfg(not(feature = "fixture"))]
            if changed {
                crate::engine::invalidate_prepared_processes();
                crate::engine::invalidate_warm_node();
                warm_selected_engines(service);
            }
            #[cfg(feature = "fixture")]
            let _ = changed;
            to_value(result)
        }
        "provider_auth" => {
            #[cfg(not(feature = "fixture"))]
            let operation = body["operation"].as_str().map(str::to_owned);
            let result = crate::provider_auth::request(body)?;
            #[cfg(not(feature = "fixture"))]
            if operation.as_deref() == Some("logout")
                || (operation.as_deref() == Some("poll") && result["status"] == "complete")
            {
                crate::engine::invalidate_prepared_processes();
                crate::engine::invalidate_warm_node();
                if operation.as_deref() == Some("poll") {
                    warm_selected_engines(service);
                }
            }
            to_value(result)
        }
        "environment_capabilities" => to_value(crate::environment::capabilities()),
        "cancel_result" => {
            let run: String = argument(&body, "runId")?;
            Uuid::parse_str(&run).map_err(|_| "Invalid result Run ID")?;
            crate::process_control::cancel_result(&run)?;
            to_value(serde_json::json!({"requested": true}))
        }
        "launch_result" => {
            // Publication can be durable before the driver thread has finished its
            // final cleanup. Give that short teardown window to close before starting
            // a result execution; otherwise drive() below can observe the old driver
            // and fail to start a new one.
            if service.driving.load(Ordering::SeqCst) && !service.planning.load(Ordering::SeqCst) {
                let settled = service.runtime.lock().map(|runtime| {
                    runtime.state.phase == "completed" && !runtime.active()
                }).unwrap_or(false);
                if settled {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                    while service.driving.load(Ordering::SeqCst)
                        && std::time::Instant::now() < deadline
                    {
                        thread::sleep(std::time::Duration::from_millis(10));
                    }
                }
            }
            if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) { return Err("Wait for the Run driver/Planner before launching its published result".into()); }
            let args: Vec<String> = argument(&body, "args")?;
            let entry: Option<String> = body.get("entryId").map(|_| argument(&body, "entryId")).transpose()?;
            let (job, control) = service.runtime.lock().map_err(|e| e.to_string())?.start_result_entry(&args, entry.as_deref())?;
            let outcome = crate::runtime::perform_result(&job, &control, |input| {
                service.runtime.lock().map_err(|e| e.to_string())?.emit(EventKind::ResultExecutionPrepared { input })
            });
            let output = service.runtime.lock().map_err(|e| e.to_string())?.finish_result(&job, &control, outcome)?;
            drive(service.clone());
            to_value(serde_json::json!({"output": output}))
        }
        "result_descriptor" => {
            let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            to_value(runtime.result_descriptor()?)
        }
        "bootstrap" => to_value(bootstrap(service, metadata)?),
        "snapshot" => to_value(snapshot(service)?),
        "history" => to_value(history(argument(&body, "runId")?, service)?),
        "load_run" => to_value(load_run(argument(&body, "runId")?, service)?),
        "compile_graph" => to_value(
            compile_graph(argument(&body, "graph")?)
                .map_err(|errors| serde_json::to_string(&errors).unwrap())?,
        ),
        "save_graph" => to_value(save_graph(
            argument(&body, "graph")?,
            argument(&body, "config")?,
            argument(&body, "runId")?,
            service,
        )?),
        "save_config" => to_value(save_config_projection(
            argument(&body, "config")?,
            argument(&body, "runId")?,
            service,
            metadata,
        )?),
        "plan_goal" => to_value(plan_goal(
            argument(&body, "goal")?,
            argument(&body, "config")?,
            argument(&body, "mode").ok(),
            argument(&body, "images").ok(),
            service,
        )?),
        "get_execution_output" => return get_execution_output(&body, service),
        "get_file_changes" => to_value(get_file_changes(&body, service)?),
        "get_merger_prompt" => to_value(get_merger_prompt(&body, service)?),
        "get_planning_snapshot" => {
            let id: String = argument(&body, "planningId")?;
            let repository: String = argument(&body, "repository")?;
            let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            let state = if runtime.state.planning_id.as_ref() == Some(&id) {
                snapshot_metadata(&runtime.state)?
            } else {
                let run = runtime
                    .store
                    .runs()?
                    .into_iter()
                    .find_map(|run| {
                        let state = runtime.store.load(&run).ok()?;
                        (state.planning_id.as_ref() == Some(&id)).then_some(state)
                    })
                    .ok_or("Planning run not found")?;
                snapshot_metadata(&run)?
            };
            if !state["config"]["repository"].as_str().is_some_and(|saved| same_repository_binding(saved, &repository)) {
                return Err("Planning repository mismatch".into());
            }
            return Ok(state);
        }
        "get_planning_output" => to_value(get_planning_output(
            argument(&body, "planningId")?,
            argument(&body, "role")?,
            body.get("offset")
                .map(|_| argument(&body, "offset"))
                .transpose()?
                .unwrap_or(0),
            body.get("tail").and_then(serde_json::Value::as_bool).unwrap_or(false),
            body.get("before")
                .map(|_| argument(&body, "before"))
                .transpose()?,
            body.get("limit")
                .map(|_| argument(&body, "limit"))
                .transpose()?,
            service,
        )?),
        "get_planning" => to_value(get_planning(argument(&body, "planningId")?, service)?),
        "list_plannings" => to_value(list_plannings(service, argument(&body, "repository").ok())?),
        "control" => to_value(control(
            argument(&body, "action")?,
            argument(&body, "node")?,
            argument(&body, "instruction")?,
            argument(&body, "runId")?,
            argument(&body, "executionId")?,
            argument(&body, "images").ok(),
            service,
        )?),
        "edit_planner" => to_value(edit_planner(
            argument(&body, "runId")?,
            argument(&body, "oldText")?,
            argument(&body, "instruction")?,
            argument(&body, "versionIndex").ok(),
            service,
        )?),
        "edit_node" => to_value(edit_node(
            argument(&body, "node")?,
            argument(&body, "executionId")?,
            argument(&body, "oldText")?,
            argument(&body, "instruction")?,
            argument(&body, "runId")?,
            argument(&body, "images").ok(),
            argument(&body, "versionIndex").ok(),
            body.get("userTurnOffset").filter(|value| !value.is_null()).map(|_| argument(&body, "userTurnOffset")).transpose()?,
            service,
        )?),
        "repository_status" => {
            let repository: String = argument(&body, "repository")?;
            let path = std::path::Path::new(&repository);
            let error = crate::workspace::validate_binding(path).err();
            // Only a binding whose directory no longer exists is safe to forget
            // automatically. Permission/read failures and non-directories keep
            // their explicit error and stay visible for the user to repair.
            let missing = path.is_absolute() && path.metadata()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
            Ok(
                serde_json::json!({ "repository": repository, "valid": error.is_none(), "missing": missing, "error": error }),
            )
        }
        "detect_repository" => to_value(detect_repository(argument(&body, "path")?)?),
        "pick_repository" => to_value(crate::workspace::pick_repository()?),
        "list_files" => to_value(list_files(service, argument(&body, "repository").ok())?),
        // Versioned command names deliberately have no legacy fallback: older
        // backends must reject before touching a project basename.
        "write_workspace_attachment" => to_value(write_workspace_attachment(service, body)?),
        "delete_workspace_attachment" => to_value(delete_workspace_attachment(service, body)?),
        "list_skills" => to_value(list_skills(service, argument(&body, "repository").ok())?),
        "reset_workspace" => to_value(reset_workspace(service)?),
        "clear_history" => to_value(clear_history(service)?),
        "delete_run" => to_value(delete_run(argument(&body, "runId")?, service)?),
        "delete_workspace" => to_value(delete_workspace(argument(&body, "repository")?, service)?),
        "get_cleanup_status" => to_value(service.runtime.lock().map_err(|error| error.to_string())?.store.pending_cleanups()?),
        _ => return Err("Unknown command".into()),
    };
    let mut value = result.map_err(|error| error.to_string())?;
    // UI transcripts already live on executions/mergers. Avoid sending every
    // raw Output frame a second time on each poll; the durable event store and
    // default API responses retain the complete history for replay/export.
    if compact {
        let snapshot = if command == "bootstrap" {
            value.get_mut("snapshot")
        } else if matches!(
            command,
            "snapshot"
                | "history"
                | "load_run"
                | "save_graph"
                | "plan_goal"
                | "control"
                | "reset_workspace"
        ) {
            Some(&mut value)
        } else {
            None
        };
        if let Some(events) = snapshot
            .and_then(|snapshot| snapshot.get_mut("events"))
            .and_then(serde_json::Value::as_array_mut)
        {
            events.retain(|event| {
                event.get("type").and_then(serde_json::Value::as_str) != Some("output")
            });
        }
    }
    Ok(value)
}

enum RuntimeSignal {
    SnapshotChanged {
        run_id: String,
        version: String,
    },
    PlanningOutputAvailable { run_id: String, planning_id: String },
    OutputAvailable {
        run_id: String,
        execution_id: String,
        total_bytes: usize,
        settled: bool,
    },
}

const MAX_SSE_SUBSCRIBERS: usize = 8;
static ACTIVE_SSE_CLIENTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static NEXT_SSE_SUBSCRIBER_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static SSE_SUBSCRIBERS: OnceLock<Mutex<Vec<(u64, std::sync::mpsc::SyncSender<Vec<u8>>)>>> =
    OnceLock::new();
static SSE_SIGNAL_TX: OnceLock<std::sync::mpsc::Sender<RuntimeSignal>> = OnceLock::new();

fn sse_subscribers() -> &'static Mutex<Vec<(u64, std::sync::mpsc::SyncSender<Vec<u8>>)>> {
    SSE_SUBSCRIBERS.get_or_init(|| Mutex::new(Vec::new()))
}

fn sse_signal_sender() -> &'static std::sync::mpsc::Sender<RuntimeSignal> {
    SSE_SIGNAL_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<RuntimeSignal>();
        let _ = thread::Builder::new()
            .name("grapher-sse-coalescer".into())
            .spawn(move || run_sse_coalescer(rx));
        tx
    })
}

fn run_sse_coalescer(rx: std::sync::mpsc::Receiver<RuntimeSignal>) {
    let debounce = std::time::Duration::from_millis(45);
    while let Ok(first) = rx.recv() {
        let deadline = std::time::Instant::now() + debounce;
        let mut snapshots: BTreeMap<String, String> = BTreeMap::new();
        let mut outputs: BTreeMap<(String, String), (usize, bool)> = BTreeMap::new();
        let mut planning_outputs = BTreeSet::new();
        let mut current = Some(first);
        loop {
            if let Some(signal) = current.take() {
                match signal {
                    RuntimeSignal::SnapshotChanged { run_id, version } => {
                        let entry = snapshots.entry(run_id).or_default();
                        if !version.is_empty() {
                            *entry = version;
                        }
                    }
                    RuntimeSignal::PlanningOutputAvailable { run_id, planning_id } => {
                        planning_outputs.insert((run_id, planning_id));
                    }
                    RuntimeSignal::OutputAvailable {
                        run_id,
                        execution_id,
                        total_bytes,
                        settled,
                    } => {
                        let entry = outputs
                            .entry((run_id, execution_id))
                            .or_insert((total_bytes, settled));
                        entry.0 = entry.0.max(total_bytes);
                        entry.1 |= settled;
                    }
                }
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(next) => current = Some(next),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        let mut payload = Vec::new();
        for (run_id, version) in snapshots {
            let data = serde_json::json!({ "runId": run_id, "version": version });
            payload.extend_from_slice(
                format!("event: snapshot_changed\ndata: {data}\n\n").as_bytes(),
            );
        }
        for ((run_id, execution_id), (total_bytes, settled)) in outputs {
            let data = serde_json::json!({
                "runId": run_id,
                "executionId": execution_id,
                "totalBytes": total_bytes,
                "settled": settled,
            });
            payload.extend_from_slice(
                format!("event: output_available\ndata: {data}\n\n").as_bytes(),
            );
        }
        for (run_id, planning_id) in planning_outputs {
            let data = serde_json::json!({ "runId": run_id, "planningId": planning_id });
            payload.extend_from_slice(format!("event: planning_output_available\ndata: {data}\n\n").as_bytes());
        }
        if !payload.is_empty() {
            broadcast_sse_bytes(&payload);
        }
    }
}

fn notify_planning_output(run_id: &str, planning_id: &str) {
    if ACTIVE_SSE_CLIENTS.load(Ordering::Relaxed) == 0 { return; }
    let _ = sse_signal_sender().send(RuntimeSignal::PlanningOutputAvailable {
        run_id: run_id.into(), planning_id: planning_id.into(),
    });
}

fn broadcast_sse_bytes(bytes: &[u8]) {
    let Ok(mut subscribers) = sse_subscribers().lock() else {
        return;
    };
    subscribers.retain(|(_, tx)| match tx.try_send(bytes.to_vec()) {
        Ok(()) => true,
        // A full queue already missed this frame, which may be the only terminal
        // notification for a Run. Drop the subscriber so the browser reconnects
        // and re-reads durable state instead of silently staying stale.
        Err(std::sync::mpsc::TrySendError::Full(_))
        | Err(std::sync::mpsc::TrySendError::Disconnected(_)) => false,
    });
    ACTIVE_SSE_CLIENTS.store(subscribers.len(), Ordering::SeqCst);
}

pub(crate) fn notify_snapshot_changed(run_id: &str, version: &str) {
    if ACTIVE_SSE_CLIENTS.load(Ordering::Relaxed) == 0 {
        return;
    }
    let _ = sse_signal_sender().send(RuntimeSignal::SnapshotChanged {
        run_id: run_id.to_owned(),
        version: version.to_owned(),
    });
}

pub(crate) fn notify_output_available(
    run_id: &str,
    execution_id: &str,
    total_bytes: usize,
    settled: bool,
) {
    if ACTIVE_SSE_CLIENTS.load(Ordering::Relaxed) == 0 {
        return;
    }
    let _ = sse_signal_sender().send(RuntimeSignal::OutputAvailable {
        run_id: run_id.to_owned(),
        execution_id: execution_id.to_owned(),
        total_bytes,
        settled,
    });
}

fn subscribe_runtime_events() -> SseStreamReceiver {
    let _ = sse_signal_sender();
    let id = NEXT_SSE_SUBSCRIBER_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(256);
    let _ = tx.try_send(b": connected\n\n".to_vec());
    if let Ok(mut subscribers) = sse_subscribers().lock() {
        while subscribers.len() >= MAX_SSE_SUBSCRIBERS {
            let (_, oldest_tx) = subscribers.remove(0);
            let _ = oldest_tx.try_send(Vec::new());
        }
        subscribers.push((id, tx));
        ACTIVE_SSE_CLIENTS.store(subscribers.len(), Ordering::SeqCst);
    }
    SseStreamReceiver {
        rx,
        current: Vec::new(),
        pos: 0,
        subscriber_id: Some(id),
    }
}

fn close_all_sse_subscribers() {
    if let Ok(mut subscribers) = sse_subscribers().lock() {
        for (_, tx) in subscribers.drain(..) {
            let _ = tx.try_send(Vec::new());
        }
        ACTIVE_SSE_CLIENTS.store(0, Ordering::SeqCst);
    }
}

struct SseStreamReceiver {
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    current: Vec<u8>,
    pos: usize,
    subscriber_id: Option<u64>,
}

impl Drop for SseStreamReceiver {
    fn drop(&mut self) {
        if let Some(id) = self.subscriber_id {
            if let Ok(mut subscribers) = sse_subscribers().lock() {
                subscribers.retain(|(sub_id, _)| *sub_id != id);
                ACTIVE_SSE_CLIENTS.store(subscribers.len(), Ordering::SeqCst);
            }
        }
    }
}

impl std::io::Read for SseStreamReceiver {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos < self.current.len() {
            let n = (self.current.len() - self.pos).min(buf.len());
            buf[..n].copy_from_slice(&self.current[self.pos..self.pos + n]);
            self.pos += n;
            return Ok(n);
        }
        let next = match self.rx.recv_timeout(std::time::Duration::from_secs(15)) {
            Ok(bytes) => {
                if bytes.is_empty() {
                    return Ok(0);
                }
                bytes
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => b": keep-alive\n\n".to_vec(),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
        };
        let n = next.len().min(buf.len());
        buf[..n].copy_from_slice(&next[..n]);
        if n < next.len() {
            self.current = next;
            self.pos = n;
        } else {
            self.current.clear();
            self.pos = 0;
        }
        Ok(n)
    }
}

fn active_planning_service(primary: &Arc<Service>) -> Result<Arc<Service>, String> {
    let root = primary
        .runtime
        .lock()
        .map_err(|e| e.to_string())?
        .root
        .clone();
    let registry = RUN_SERVICES
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    let mut planners = registry
        .get(&root)
        .into_iter()
        .flat_map(|runs| runs.values())
        .filter_map(Weak::upgrade)
        .filter(|child| child.planning.load(Ordering::SeqCst));
    let first = if primary.planning.load(Ordering::SeqCst) {
        Some(primary.clone())
    } else {
        planners.next()
    };
    let first = first.ok_or("No active Planner for this conversation")?;
    if planners.next().is_some() {
        return Err("Multiple Planners are running; provide a Run ID".into());
    }
    Ok(first)
}

fn latest_service(primary: &Arc<Service>) -> Result<Arc<Service>, String> {
    let runtime = primary.runtime.lock().map_err(|e| e.to_string())?;
    let latest = runtime.store.selected_run()?;
    drop(runtime);
    if let Some(id) = latest {
        service_for_run(primary, &id, false)
    } else {
        Ok(primary.clone())
    }
}

fn api_service(
    primary: &Arc<Service>,
    command: &str,
    body: &serde_json::Value,
) -> Result<Arc<Service>, String> {
    match command {
        "snapshot"
        | "snapshot_if_changed"
        | "load_run"
        | "control"
        | "edit_node"
        | "edit_planner"
        | "save_graph"
        | "save_config"
        | "delete_run"
        | "get_execution_output"
        | "get_file_changes"
        | "get_merger_prompt"
        | "write_workspace_attachment"
        | "delete_workspace_attachment"
        | "result_descriptor"
        | "launch_result" => {
            if let Some(run_id) = body.get("runId").and_then(serde_json::Value::as_str) {
                // An empty runId means "the active Run" to the file-change
                // handler; keep that meaning instead of failing a Run lookup.
                if run_id.is_empty() && command == "get_file_changes" {
                    Ok(primary.clone())
                } else {
                    service_for_run(primary, run_id, false)
                }
            } else if command == "save_graph" {
                service_for_run(primary, &Uuid::new_v4().to_string(), true)
            } else if command == "control"
                && matches!(
                    body.get("action").and_then(serde_json::Value::as_str),
                    Some("stop" | "cancel" | "steer_planner")
                )
            {
                active_planning_service(primary)
            } else if matches!(
                command,
                "snapshot" | "snapshot_if_changed" | "control" | "load_run"
            ) {
                latest_service(primary)
            } else {
                Ok(primary.clone())
            }
        }
        "plan_goal" => service_for_run(primary, &Uuid::new_v4().to_string(), true),
        _ => Ok(primary.clone()),
    }
}

fn send_sse_event(tx: &std::sync::mpsc::Sender<Vec<u8>>, event: &str, data: &serde_json::Value) {
    let payload = format!("event: {event}\ndata: {}\n\n", data);
    let _ = tx.send(payload.into_bytes());
}

// Host is not an authentication mechanism, but an exact loopback authority
// check prevents DNS rebinding from using a remote hostname to reach this API.
fn is_trusted_host(host: &str, backend_port: u16) -> bool {
    host == format!("127.0.0.1:{backend_port}") || host == format!("localhost:{backend_port}")
}

fn is_trusted_origin(origin: &str, backend_port: u16) -> bool {
    let local = ["localhost", "127.0.0.1"];
    if local.iter().any(|host| {
        origin == format!("http://{host}:{backend_port}") || origin == format!("http://{host}:1420")
    }) {
        return true;
    }
    // Opt-in for nonstandard frontends only. Never use this to authorize Host.
    std::env::var("GRAPHER_ALLOWED_ORIGINS")
        .is_ok_and(|allowed| origin_matches_allowlist(origin, &allowed))
}

fn origin_matches_allowlist(origin: &str, allowed: &str) -> bool {
    allowed.split(',').any(|entry| {
        let entry = entry.trim();
        let authority = entry
            .strip_prefix("http://")
            .or_else(|| entry.strip_prefix("https://"));
        authority.is_some_and(|host| {
            !host.is_empty()
                && !host
                    .chars()
                    .any(|c| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '@'))
                && entry == origin
        })
    })
}

/// Offline per-execution log migration and physical compaction. The legacy
/// --compact flag is an alias. Refuse concurrent backends via the runtime lease.
pub fn compact_output_chunks() -> Result<(), String> {
    let root = crate::workspace::data_root();
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let _lock = crate::runtime_lock::acquire(&root)?;
    let path = root.join("events.sqlite");
    let before = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let store = crate::store::Store::open(&path)?;
    let report = store.migrate_legacy_logs()?;
    store.vacuum()?;
    let after = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    println!(
        "[migrate] backfilled {} rows, migrated {} executions, updated {} rows, deleted {} output chunks\n[migrate] events.sqlite: {:.1} MB -> {:.1} MB",
        report.backfilled_rows,
        report.migrated_executions,
        report.updated_rows,
        report.deleted_chunks,
        before as f64 / 1_048_576.0,
        after as f64 / 1_048_576.0
    );
    Ok(())
}

/// Preload only an explicitly configured project. Repository discovery/status
/// and large snapshot serialization are not prerequisites for warming engines.
#[cfg(any(not(feature = "fixture"), test))]
fn configured_prewarm_config(runtime: &Runtime) -> Option<Config> {
    fs::read(runtime.root.join("config.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok())
        .or_else(|| {
            let mut config = runtime.state.config.clone()?;
            // Match bootstrap's treatment of legacy, unqualified model names.
            if !config.model.is_empty() && !config.model.contains('/') {
                config.model.clear();
            }
            Some(config)
        })
        .filter(|config| !config.repository.trim().is_empty())
}

#[cfg(not(feature = "fixture"))]
fn warm_selected_engines(service: &Arc<Service>) {
    crate::provider_auth::warm();
    let config = {
        let Ok(runtime) = service.runtime.lock() else { return; };
        let config = configured_prewarm_config(&runtime);
        runtime.warm_completed_serial_node();
        config
    };
    if let Some(config) = config {
        crate::engine::warm_planning_engines(config);
    }
}

pub fn run() -> Result<(), String> {
    use tiny_http::{Response, Server};
    load_env_file();
    let root = crate::workspace::data_root();
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    // Planning/session paths must use the same real root as the execution
    // sandbox. In particular, CARGO_MANIFEST_DIR/../.grapher is not a
    // lexical child of the canonical .grapher directory.
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let extension = root.join("grapher-planner.ts");
    fs::write(&extension, include_str!("../resources/planner.ts"))
        .map_err(|error| error.to_string())?;
    // `npm run dev` restarts are dominated by replaying the selected Run's
    // streamed output. The browser only materializes a settled Run when it is
    // opened, so dev can start without replaying it.
    let lazy_primary = std::env::var_os("GRAPHER_DEV_LAZY_PRIMARY").is_some();
    let runtime = if lazy_primary {
        Runtime::open_lazy(&root)?
    } else {
        Runtime::open(&root)?
    };
    let service = Arc::new(Service {
        runtime: Mutex::new(runtime),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension,
    });
    #[cfg(not(feature = "fixture"))]
    crate::native::check_retired_leases(&root)?;
    recover_plannings(&service)?;
    recover_cleanup_tasks(&service)?;
    let port: u16 = std::env::var("GRAPHER_PORT")
        .unwrap_or_else(|_| "1421".into())
        .parse()
        .map_err(|_| "Invalid GRAPHER_PORT")?;
    let server = Arc::new(Server::http(("127.0.0.1", port)).map_err(|error| error.to_string())?);
    #[cfg(unix)]
    let mut signals = signal_hook::iterator::Signals::new([
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
    ])
    .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let shutdown_requested = {
        // signal-hook's iterator module is Unix-only; its flag API supports
        // the Windows CRT SIGINT handler without doing work in the handler.
        let requested = Arc::new(AtomicBool::new(false));
        signal_hook::flag::register(signal_hook::consts::SIGINT, requested.clone())
            .map_err(|error| error.to_string())?;
        requested
    };
    let cleanup_stopped = Arc::new(AtomicBool::new(false));
    let cleanup_stop = cleanup_stopped.clone();
    let cleanup_service = Arc::downgrade(&service);
    thread::spawn(move || {
        while !cleanup_stop.load(Ordering::SeqCst) {
            for _ in 0..300 {
                if cleanup_stop.load(Ordering::SeqCst) { return; }
                thread::sleep(std::time::Duration::from_millis(100));
            }
            if let Some(service) = cleanup_service.upgrade() {
                if let Err(error) = retry_cleanup_tasks(&service) { eprintln!("[Grapher] Cleanup retry failed: {error}"); }
            } else { break; }
        }
    });
    let shutdown_service = service.clone();
    let shutdown_server = server.clone();
    thread::spawn(move || {
        #[cfg(unix)]
        let stop = signals.forever().next().is_some();
        #[cfg(windows)]
        let stop = {
            while !shutdown_requested.load(Ordering::SeqCst) {
                thread::sleep(std::time::Duration::from_millis(50));
            }
            true
        };
        if stop {
            cleanup_stopped.store(true, Ordering::SeqCst);
            crate::provider_auth::begin_shutdown();
            crate::native::begin_shutdown();
            #[cfg(not(feature = "fixture"))]
            crate::engine::stop_partition_prewarm();
            crate::engine::stop_lingering();
            if let Ok(mut runtime) = shutdown_service.runtime.lock() {
                if matches!(runtime.state.phase.as_str(), "publishing" | "merging") {
                    let _ = runtime.emit(EventKind::PublicationFailed {
                        error: "Backend stopped during publication; inspect and retry publication."
                            .into(),
                    });
                } else if runtime.state.approved
                    && (runtime.active() || runtime.state.phase == "running")
                {
                    let _ = runtime.emit(EventKind::Paused { paused: true });
                }
            }
            crate::engine::terminate_all();
            crate::native::shutdown_runtime();
            crate::provider_auth::shutdown();
            close_all_sse_subscribers();
            shutdown_server.unblock();
        }
    });
    // Dev uses Vite's frontend URL; do not invite users into stale dist assets.
    if std::env::var_os("GRAPHER_DEV_HIDE_BACKEND_URL").is_none() {
        eprintln!(
            "Grapher backend: http://127.0.0.1:{port} (data: {})",
            root.display()
        );
    }
    let web_root = crate::native::installation_root().join("dist");
    // Bounded workers keep slow HTTP clients (including SSE streams) from
    // creating an unbounded number of OS threads.
    let (tx, rx) = std::sync::mpsc::sync_channel::<tiny_http::Request>(128);
    let rx = Arc::new(Mutex::new(rx));
    for _ in 0..32 {
        let rx = rx.clone();
        let service = service.clone();
        let web_root = web_root.clone();
        thread::spawn(move || loop {
            let next = rx.lock().unwrap().recv();
            match next {
                Ok(request) => handle_http_request(request, &service, &web_root, port),
                Err(_) => break,
            }
        });
    }
    // Warm the sidebar independently of engines. This read-only connection never
    // holds a runtime lock or loads full histories, and the cache is invalidated by
    // SQLite commits (including writes made by other Run services).
    let catalog_path = root.join("events.sqlite");
    if let Err(error) = thread::Builder::new().name("sidebar-prewarm".into()).spawn(move || {
        if let Err(error) = crate::store::conversation_summaries(&catalog_path) {
            eprintln!("[Grapher] Sidebar prewarm unavailable: {error}");
        }
    }) {
        eprintln!("[Grapher] Cannot start sidebar prewarm: {error}");
    }
    // HTTP workers and shutdown handling are ready before any speculative work.
    // Do not scan the installation cwd or serialize history just to choose a warm key.
    #[cfg(not(feature = "fixture"))]
    {
        // Credential-host imports need no configured project. Do not enumerate
        // providers or refresh tokens merely to make the first catalog fast.
        crate::provider_auth::warm();
        let warm_service = Arc::downgrade(&service);
        thread::spawn(move || {
            if let Some(service) = warm_service.upgrade() {
                warm_selected_engines(&service);
            }
        });
    }
    for request in server.incoming_requests() {
        match tx.try_send(request) {
            Ok(()) => {}
            Err(std::sync::mpsc::TrySendError::Full(request)) => {
                let _ = request.respond(Response::from_string("Server busy").with_status_code(503));
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => break,
        }
    }
    Ok(())
}

fn static_asset_path(web_root: &std::path::Path, url: &str) -> Option<PathBuf> {
    let root_metadata = fs::symlink_metadata(web_root).ok()?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return None;
    }
    let relative = url.trim_start_matches('/');
    // Reject Windows separators, drive/UNC/device paths and alternate streams
    // on every host, before filesystem access (including network shares).
    if relative.contains(['\\', ':']) || relative.chars().any(char::is_control)
        || relative.split('/').any(|part| part == "..") {
        return None;
    }
    let path = web_root.join(if relative.is_empty() { "index.html" } else { relative });
    crate::path_safety::real_child_path(web_root, &path, true).ok().flatten()
}

#[cfg(test)]
#[path = "http_file_tests.rs"]
mod http_file_tests;

fn handle_http_request(
    mut request: tiny_http::Request,
    service: &Arc<Service>,
    web_root: &std::path::Path,
    port: u16,
) {
    use tiny_http::{Header, Response};
    let req_origin = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Origin"))
        .map(|h| h.value.as_str().to_string());
    let hosts: Vec<_> = request
        .headers()
        .iter()
        .filter(|h| h.field.equiv("Host"))
        .collect();
    let origins: Vec<_> = request
        .headers()
        .iter()
        .filter(|h| h.field.equiv("Origin"))
        .collect();
    let trusted = hosts.len() == 1
        && is_trusted_host(hosts[0].value.as_str(), port)
        && origins.len() <= 1
        && origins
            .iter()
            .all(|h| is_trusted_origin(h.value.as_str(), port));
    if !trusted {
        let _ = request.respond(Response::from_string("Untrusted origin").with_status_code(403));
        return;
    }
    if request.method() == &tiny_http::Method::Options {
        let mut response = Response::empty(204)
            .with_header(
                tiny_http::Header::from_bytes(
                    &b"Access-Control-Allow-Methods"[..],
                    &b"POST, OPTIONS"[..],
                )
                .unwrap(),
            )
            .with_header(
                tiny_http::Header::from_bytes(
                    &b"Access-Control-Allow-Headers"[..],
                    &b"Content-Type"[..],
                )
                .unwrap(),
            );
        if let Some(ref origin) = req_origin {
            response = response.with_header(
                tiny_http::Header::from_bytes(
                    &b"Access-Control-Allow-Origin"[..],
                    origin.as_bytes(),
                )
                .unwrap(),
            );
        }
        let _ = request.respond(response);
        return;
    }
    let url = request.url().split('?').next().unwrap_or("/").to_string();
    if let Some(command) = url.strip_prefix("/api/") {
        if command == "events" && request.method() == &tiny_http::Method::Get {
            let cross_site = request.headers().iter().any(|h| {
                h.field.equiv("Sec-Fetch-Site")
                    && h.value.as_str().eq_ignore_ascii_case("cross-site")
            });
            if cross_site {
                let _ = request
                    .respond(Response::from_string("Cross-site SSE rejected").with_status_code(403));
                return;
            }
            let stream = subscribe_runtime_events();
            let mut response = Response::empty(200)
                .with_data(stream, None)
                .with_header(Header::from_bytes("Content-Type", "text/event-stream").unwrap())
                .with_header(Header::from_bytes("Cache-Control", "no-cache").unwrap())
                .with_header(Header::from_bytes("Connection", "keep-alive").unwrap())
                .with_header(Header::from_bytes("X-Accel-Buffering", "no").unwrap());
            if let Some(ref origin) = req_origin {
                if let Ok(hdr) = Header::from_bytes("Access-Control-Allow-Origin", origin.as_bytes())
                {
                    response = response.with_header(hdr);
                }
            }
            let _ = request.respond(response);
            return;
        }
        // JSON-only POST + exact Host/Origin checks limit browser access.
        // This is still an unauthenticated, trusted-user local API.
        let is_json = request.headers().iter().any(|h| {
            h.field.equiv("Content-Type")
                && h.value.as_str().split(';').next() == Some("application/json")
        });
        if request.method() != &tiny_http::Method::Post || !is_json {
            let _ =
                request.respond(Response::from_string("JSON POST required").with_status_code(415));
            return;
        }

        if command == "plan_goal_stream" {
            let mut input = String::new();
            let body_res = std::io::Read::read_to_string(
                &mut request.as_reader().take(10 * 1024 * 1024 + 1),
                &mut input,
            )
            .map_err(|e| e.to_string())
            .and_then(|_| {
                serde_json::from_str::<serde_json::Value>(&input).map_err(|e| e.to_string())
            });

            let (goal, config, plan_mode, images, revision_run_id): (
                String,
                Config,
                Option<String>,
                Option<Vec<crate::model::ImageAttachment>>,
                Option<String>,
            ) = match body_res.and_then(|body| {
                let goal: String = argument(&body, "goal")?;
                let config: Config = argument(&body, "config")?;
                let mode: Option<String> = argument(&body, "mode").ok();
                let images: Option<Vec<crate::model::ImageAttachment>> =
                    argument(&body, "images").ok();
                let revision_run_id: Option<String> = argument(&body, "revisionRunId").ok();
                Ok((goal, config, mode, images, revision_run_id))
            }) {
                Ok(tuple) => tuple,
                Err(err) => {
                    let mut resp =
                        Response::from_string(serde_json::json!({"error": err}).to_string())
                            .with_status_code(400)
                            .with_header(
                                Header::from_bytes("Content-Type", "application/json").unwrap(),
                            );
                    if let Some(ref origin) = req_origin {
                        if let Ok(hdr) =
                            Header::from_bytes("Access-Control-Allow-Origin", origin.as_bytes())
                        {
                            resp = resp.with_header(hdr);
                        }
                    }
                    let _ = request.respond(resp);
                    return;
                }
            };

            if let Err(err) = validate_planning_preflight(&config, plan_mode.as_deref()) {
                let mut resp = Response::from_string(serde_json::json!({"error": err}).to_string())
                    .with_status_code(400)
                    .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
                if let Some(ref origin) = req_origin {
                    if let Ok(hdr) =
                        Header::from_bytes("Access-Control-Allow-Origin", origin.as_bytes())
                    {
                        resp = resp.with_header(hdr);
                    }
                }
                let _ = request.respond(resp);
                return;
            }

            let (tx, rx) = std::sync::mpsc::channel();
            let service_clone = match revision_run_id.as_deref() {
                Some(run_id) => service_for_run(service, run_id, false),
                None => service_for_run(service, &Uuid::new_v4().to_string(), true),
            };
            let service_clone = match service_clone {
                Ok(service) => service,
                Err(error) => {
                    let _ = request.respond(
                        Response::from_string(serde_json::json!({"error": error}).to_string())
                            .with_status_code(400)
                            .with_header(
                                Header::from_bytes("Content-Type", "application/json").unwrap(),
                            ),
                    );
                    return;
                }
            };

            thread::spawn(move || {
                let tx_part = tx.clone();
                let tx_route = tx.clone();
                let tx_plan = tx.clone();
                let result = plan_goal_internal_with_started(
                    goal,
                    config,
                    plan_mode.as_deref(),
                    images,
                    revision_run_id,
                    &service_clone,
                    false,
                    |run_id| send_sse_event(&tx, "run_started", &serde_json::json!({"runId": run_id})),
                    |line| {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                            send_sse_event(
                                &tx_part,
                                "partitioner",
                                &serde_json::json!({ "raw": line, "event": parsed }),
                            );
                        } else {
                            send_sse_event(
                                &tx_part,
                                "partitioner",
                                &serde_json::json!({ "raw": line }),
                            );
                        }
                    },
                    |route| {
                        send_sse_event(
                            &tx_route,
                            "route_decision",
                            &serde_json::json!({ "planType": route.plan_type }),
                        );
                    },
                    |line| {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                            send_sse_event(
                                &tx_plan,
                                "planner",
                                &serde_json::json!({ "raw": line, "event": parsed }),
                            );
                        } else {
                            send_sse_event(
                                &tx_plan,
                                "planner",
                                &serde_json::json!({ "raw": line }),
                            );
                        }
                    },
                );

                match result {
                    Ok(snapshot) => {
                        send_sse_event(
                            &tx,
                            "complete",
                            &serde_json::json!({ "snapshot": snapshot }),
                        );
                    }
                    Err((err, summary)) => {
                        let mut err_payload = serde_json::json!({ "error": err });
                        if let Some(s) = summary {
                            err_payload["planningId"] = serde_json::json!(s.planning_id);
                            err_payload["summary"] = serde_json::json!(s);
                        }
                        send_sse_event(&tx, "error", &err_payload);
                    }
                }
                let _ = tx.send(Vec::new());
            });

            let stream = SseStreamReceiver {
                rx,
                current: Vec::new(),
                pos: 0,
                subscriber_id: None,
            };
            let mut response = Response::empty(200)
                .with_data(stream, None)
                .with_header(Header::from_bytes("Content-Type", "text/event-stream").unwrap())
                .with_header(Header::from_bytes("Cache-Control", "no-cache").unwrap())
                .with_header(Header::from_bytes("Connection", "keep-alive").unwrap())
                .with_header(Header::from_bytes("X-Accel-Buffering", "no").unwrap())
                .with_header(Header::from_bytes("X-Grapher-Events", "1").unwrap());
            if let Some(ref origin) = req_origin {
                if let Ok(hdr) =
                    Header::from_bytes("Access-Control-Allow-Origin", origin.as_bytes())
                {
                    response = response.with_header(hdr);
                }
                if let Ok(hdr) =
                    Header::from_bytes("Access-Control-Expose-Headers", "X-Grapher-Events")
                {
                    response = response.with_header(hdr);
                }
            }
            let _ = request.respond(response);
            return;
        }

        let mut input = String::new();
        let result = std::io::Read::read_to_string(
            &mut request.as_reader().take(10 * 1024 * 1024 + 1),
            &mut input,
        )
        .map_err(|e| e.to_string())
        .and_then(|_| {
            if input.len() > 10 * 1024 * 1024 {
                return Err("Request too large".into());
            }
            let body: serde_json::Value =
                serde_json::from_str(&input).map_err(|e| e.to_string())?;
            let scoped = api_service(service, command, &body)?;
            dispatch(&scoped, command, body)
        });
        let (status, body) = match result {
            Ok(value) => (200, serde_json::json!({"result": value})),
            Err(error) => match busy_snapshot_poll(command, &input, &error) {
                Some(result) => (200, serde_json::json!({"result": result})),
                None => (400, serde_json::json!({"error": error})),
            },
        };
        let mut response = Response::from_string(body.to_string())
            .with_status_code(status)
            .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
            .with_header(Header::from_bytes("X-Grapher-Events", "1").unwrap());
        if let Some(ref origin) = req_origin {
            if let Ok(hdr) = Header::from_bytes("Access-Control-Allow-Origin", origin.as_bytes()) {
                response = response.with_header(hdr);
            }
            if let Ok(hdr) = Header::from_bytes("Access-Control-Expose-Headers", "X-Grapher-Events")
            {
                response = response.with_header(hdr);
            }
        }
        let _ = request.respond(response);
    } else {
        let Some(path) = static_asset_path(web_root, &url) else {
            let _ = request.respond(Response::empty(404));
            return;
        };
        let mime = match path.extension().and_then(|s| s.to_str()) {
            Some("html") => "text/html; charset=utf-8",
            Some("js") => "text/javascript",
            Some("css") => "text/css",
            Some("svg") => "image/svg+xml",
            _ => "application/octet-stream",
        };
        match fs::read(path) {
            Ok(bytes) => {
                let _ = request.respond(
                    Response::from_data(bytes)
                        .with_header(Header::from_bytes("Content-Type", mime).unwrap()),
                );
            }
            Err(_) => {
                let _ = request.respond(
                    Response::from_string("Run npm run build to build the frontend")
                        .with_status_code(404),
                );
            }
        }
    }
}
