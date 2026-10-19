//! Authoritative file-change tracking across Git snapshots, live working trees,
//! and execution/planning tool-call transcripts (`write`, `edit`, `bash`).

use crate::model::{Execution, Snapshot};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};


#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeItem {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// "added" | "modified" | "deleted" | "renamed"
    pub status: String,
    #[serde(default)]
    pub additions: usize,
    #[serde(default)]
    pub deletions: usize,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_running: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nodes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub execution_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeSummary {
    pub files: Vec<FileChangeItem>,
    pub total_files: usize,
    pub added_count: usize,
    pub modified_count: usize,
    pub deleted_count: usize,
    pub renamed_count: usize,
    pub total_additions: usize,
    pub total_deletions: usize,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_file_path: Option<String>,
}

impl FileChangeSummary {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && !self.is_running && self.active_file_path.is_none()
    }

    pub fn from_files(
        files: Vec<FileChangeItem>,
        is_running: bool,
        active_file_path: Option<String>,
    ) -> Self {
        let mut added_count = 0;
        let mut modified_count = 0;
        let mut deleted_count = 0;
        let mut renamed_count = 0;
        let mut total_additions = 0;
        let mut total_deletions = 0;
        for item in &files {
            match item.status.as_str() {
                "added" => added_count += 1,
                "deleted" => deleted_count += 1,
                "renamed" => renamed_count += 1,
                _ => modified_count += 1,
            }
            total_additions += item.additions;
            total_deletions += item.deletions;
        }
        let total_files = files.len();
        Self {
            files,
            total_files,
            added_count,
            modified_count,
            deleted_count,
            renamed_count,
            total_additions,
            total_deletions,
            is_running,
            active_file_path,
        }
    }
}

#[derive(Default)]
struct FileChangesCache {
    /// Keyed by `(run_id, execution_id)` -> log-derived summary
    log_changes: HashMap<(String, String), FileChangeSummary>,
    /// Keyed by `(run_id, execution_id)` -> git-derived summary
    git_changes: HashMap<(String, String), FileChangeSummary>,
    /// Keyed by `run_id` -> publication git diff summary (`base..publication.head`)
    publication_changes: HashMap<String, FileChangeSummary>,
    /// Keyed by `(run_id, planning_id)` -> planner log-derived summary
    planning_changes: HashMap<(String, String), FileChangeSummary>,
    /// Live incremental parse state for streaming execution logs.
    live: HashMap<(String, String), ChangeAccumulator>,
    /// Same, for streaming Planner turns (writes before any node runs).
    planning_live: HashMap<(String, String), ChangeAccumulator>,
}

static CACHE: OnceLock<Mutex<FileChangesCache>> = OnceLock::new();

fn cache() -> &'static Mutex<FileChangesCache> {
    CACHE.get_or_init(|| Mutex::new(FileChangesCache::default()))
}

pub fn invalidate_run(run_id: &str) {
    if let Ok(mut guard) = cache().lock() {
        guard.log_changes.retain(|(r, _), _| r != run_id);
        guard.git_changes.retain(|(r, _), _| r != run_id);
        guard.publication_changes.remove(run_id);
        guard.planning_changes.retain(|(r, _), _| r != run_id);
        guard.live.retain(|(r, _), _| r != run_id);
        guard.planning_live.retain(|(r, _), _| r != run_id);
    }
}

pub fn clear_all() {
    if let Ok(mut guard) = cache().lock() {
        guard.log_changes.clear();
        guard.git_changes.clear();
        guard.publication_changes.clear();
        guard.planning_changes.clear();
        guard.live.clear();
        guard.planning_live.clear();
    }
}

fn normalize_slashes(input: &str) -> String {
    let mut s = input.trim().replace('\\', "/");
    // Strip Windows extended-length prefix if present
    if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    while s.ends_with('/') && s.len() > 1 {
        s.pop();
    }
    s
}

fn strip_root_prefix(path: &str, root: &str) -> Option<String> {
    if root.is_empty() {
        return None;
    }
    let norm_root = normalize_slashes(root);
    if norm_root.is_empty() {
        return None;
    }
    if cfg!(windows) || cfg!(target_os = "macos") {
        let path_lower = path.to_lowercase();
        let root_lower = norm_root.to_lowercase();
        if path_lower == root_lower {
            return Some(String::new());
        }
        let prefix = format!("{root_lower}/");
        if path_lower.starts_with(&prefix) {
            return Some(path[prefix.len()..].to_string());
        }
    } else {
        if path == norm_root {
            return Some(String::new());
        }
        let prefix = format!("{norm_root}/");
        if let Some(rest) = path.strip_prefix(&prefix) {
            return Some(rest.to_string());
        }
    }
    None
}

/// Normalize a raw path from a tool call or Git output into a clean workspace-relative path.
pub fn normalize_workspace_path(raw: &str, worktree: &str, repository: &str) -> Option<String> {
    let mut cleaned = raw.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
    if cleaned.is_empty() {
        return None;
    }
    cleaned = normalize_slashes(&cleaned);

    for root in [worktree, repository] {
        if let Some(rel) = strip_root_prefix(&cleaned, root) {
            cleaned = rel;
            break;
        }
    }

    // Also strip `.grapher-worktrees/<run>/<slot>/` if embedded in an absolute path
    if let Some(idx) = cleaned.find(".grapher-worktrees/") {
        let after = &cleaned[idx + ".grapher-worktrees/".len()..];
        let mut parts = after.splitn(3, '/');
        let _run = parts.next();
        let _slot = parts.next();
        if let Some(rest) = parts.next() {
            cleaned = rest.to_string();
        }
    }

    while let Some(rest) = cleaned.strip_prefix("./") {
        cleaned = rest.to_string();
    }
    cleaned = cleaned.trim_start_matches('/').to_string();

    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return None;
    }
    // Reject absolute system paths that escaped workspace stripping (e.g. /dev/null, /tmp/...)
    if cleaned.starts_with("dev/")
        || cleaned.starts_with("tmp/")
        || cleaned.starts_with("proc/")
        || cleaned.contains(":/")
    {
        return None;
    }
    if crate::path_identity::is_runtime_metadata_path(Path::new(&cleaned)) {
        return None;
    }
    let leaf = cleaned.rsplit('/').next().unwrap_or(&cleaned);
    if leaf == ".DS_Store" || leaf.starts_with("._") || cleaned == ".git" || cleaned.starts_with(".git/") {
        return None;
    }
    Some(cleaned)
}

/// Line-level added/removed counts only. Patches are never stored or shown,
/// so this avoids building unified-diff text and its allocations.
pub fn count_line_changes(old_text: &str, new_text: &str) -> (usize, usize) {
    let old_lines: Vec<&str> = if old_text.is_empty() {
        Vec::new()
    } else {
        old_text.lines().collect()
    };
    let new_lines: Vec<&str> = if new_text.is_empty() {
        Vec::new()
    } else {
        new_text.lines().collect()
    };
    if old_lines.is_empty() {
        return (new_lines.len(), 0);
    }
    if new_lines.is_empty() {
        return (0, old_lines.len());
    }
    // Trim the unchanged head and tail first; edits usually touch a small span.
    let mut prefix = 0;
    while prefix < old_lines.len()
        && prefix < new_lines.len()
        && old_lines[prefix] == new_lines[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < (old_lines.len() - prefix)
        && suffix < (new_lines.len() - prefix)
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let mid_old = &old_lines[prefix..old_lines.len() - suffix];
    let mid_new = &new_lines[prefix..new_lines.len() - suffix];
    // Huge replacements would need a quadratic table; report them as a block.
    if mid_old.len().saturating_mul(mid_new.len()) > 16_000 {
        return (mid_new.len(), mid_old.len());
    }
    if mid_old.is_empty() {
        return (mid_new.len(), 0);
    }
    if mid_new.is_empty() {
        return (0, mid_old.len());
    }
    let (m, n) = (mid_old.len(), mid_new.len());
    let mut dp = vec![vec![0u16; n + 1]; m + 1];
    for i in (0..m).rev() {
        for j in (0..n).rev() {
            dp[i][j] = if mid_old[i] == mid_new[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let lcs = dp[0][0] as usize;
    (n - lcs, m - lcs)
}

fn parse_bash_command_changes(
    command: &str,
    worktree: &str,
    repository: &str,
    node: &str,
    execution_id: &str,
) -> Vec<FileChangeItem> {
    let mut items = Vec::new();
    for segment in command.split(|c| c == ';' || c == '\n') {
        for sub in segment.split("&&") {
            let trimmed = sub.trim();
            if trimmed.is_empty() {
                continue;
            }
            let tokens: Vec<&str> = trimmed.split_whitespace().collect();
            if tokens.is_empty() {
                continue;
            }
            let (cmd, args_slice) = if tokens[0] == "git" && tokens.len() >= 2 {
                (tokens[1], &tokens[2..])
            } else {
                (tokens[0], &tokens[1..])
            };
            match cmd {
                "rm" | "unlink" | "del" | "Remove-Item" => {
                    for arg in args_slice {
                        if arg.starts_with('-') {
                            continue;
                        }
                        if let Some(path) = normalize_workspace_path(arg, worktree, repository) {
                            items.push(FileChangeItem {
                                path,
                                old_path: None,
                                status: "deleted".into(),
                                additions: 0,
                                deletions: 0,
                                is_running: false,
                                nodes: if node.is_empty() { vec![] } else { vec![node.into()] },
                                execution_ids: if execution_id.is_empty() {
                                    vec![]
                                } else {
                                    vec![execution_id.into()]
                                },
                                source: Some("bash".into()),
                            });
                        }
                    }
                }
                "mv" => {
                    let non_flags: Vec<&str> = args_slice
                        .iter()
                        .copied()
                        .filter(|a| !a.starts_with('-'))
                        .collect();
                    if non_flags.len() == 2 {
                        if let (Some(old_path), Some(new_path)) = (
                            normalize_workspace_path(non_flags[0], worktree, repository),
                            normalize_workspace_path(non_flags[1], worktree, repository),
                        ) {
                            items.push(FileChangeItem {
                                path: new_path,
                                old_path: Some(old_path),
                                status: "renamed".into(),
                                additions: 0,
                                deletions: 0,
                                is_running: false,
                                nodes: if node.is_empty() { vec![] } else { vec![node.into()] },
                                execution_ids: if execution_id.is_empty() {
                                    vec![]
                                } else {
                                    vec![execution_id.into()]
                                },
                                source: Some("bash".into()),
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }
    items
}

fn build_tool_change_items(
    tool_name: &str,
    args: &serde_json::Value,
    known_existing: &HashSet<String>,
    worktree: &str,
    repository: &str,
    node: &str,
    execution_id: &str,
) -> Vec<FileChangeItem> {
    match tool_name {
        "write" => {
            let raw_path = args["path"]
                .as_str()
                .or_else(|| args["file"].as_str())
                .unwrap_or_default();
            let Some(path) = normalize_workspace_path(raw_path, worktree, repository) else {
                return Vec::new();
            };
            let content = args["content"].as_str().unwrap_or_default();
            let (additions, _) = count_line_changes("", content);
            let status = if known_existing.contains(&path) {
                "modified"
            } else {
                "added"
            };
            vec![FileChangeItem {
                path,
                old_path: None,
                status: status.into(),
                additions,
                deletions: 0,
                is_running: false,
                nodes: if node.is_empty() { vec![] } else { vec![node.into()] },
                execution_ids: if execution_id.is_empty() {
                    vec![]
                } else {
                    vec![execution_id.into()]
                },
                source: Some("write".into()),
            }]
        }
        "edit" => {
            let raw_path = args["path"]
                .as_str()
                .or_else(|| args["file"].as_str())
                .unwrap_or_default();
            let Some(path) = normalize_workspace_path(raw_path, worktree, repository) else {
                return Vec::new();
            };
            let mut total_add = 0usize;
            let mut total_del = 0usize;
            if let Some(edits) = args["edits"].as_array() {
                for edit in edits {
                    let old_t = edit["oldText"].as_str().unwrap_or_default();
                    let new_t = edit["newText"].as_str().unwrap_or_default();
                    let (add, del) = count_line_changes(old_t, new_t);
                    total_add += add;
                    total_del += del;
                }
            } else if args.get("oldText").is_some() || args.get("newText").is_some() {
                let old_t = args["oldText"].as_str().unwrap_or_default();
                let new_t = args["newText"].as_str().unwrap_or_default();
                let (add, del) = count_line_changes(old_t, new_t);
                total_add += add;
                total_del += del;
            }
            vec![FileChangeItem {
                path,
                old_path: None,
                status: "modified".into(),
                additions: total_add,
                deletions: total_del,
                is_running: false,
                nodes: if node.is_empty() { vec![] } else { vec![node.into()] },
                execution_ids: if execution_id.is_empty() {
                    vec![]
                } else {
                    vec![execution_id.into()]
                },
                source: Some("edit".into()),
            }]
        }
        "bash" => {
            let cmd = args["command"].as_str().unwrap_or_default();
            parse_bash_command_changes(cmd, worktree, repository, node, execution_id)
        }
        _ => Vec::new(),
    }
}

fn merge_file_item_into(map: &mut BTreeMap<String, FileChangeItem>, incoming: FileChangeItem) {
    if let Some(old_path) = &incoming.old_path {
        if incoming.status == "renamed" {
            map.remove(old_path);
        }
    }
    if let Some(existing) = map.get_mut(&incoming.path) {
        let next_status = match (existing.status.as_str(), incoming.status.as_str()) {
            ("added", "modified") => "added",
            ("added", "deleted") => "deleted",
            ("deleted", "added") | ("deleted", "modified") => "modified",
            (_, "deleted") => "deleted",
            (_, "renamed") => "renamed",
            _ => existing.status.as_str(),
        };
        existing.status = next_status.to_string();
        if incoming.old_path.is_some() {
            existing.old_path = incoming.old_path;
        }
        if incoming.source.as_deref() == Some("git") {
            existing.additions = incoming.additions;
            existing.deletions = incoming.deletions;
            existing.source = incoming.source;
        } else if existing.source.as_deref() != Some("git") {
            if incoming.source.as_deref() == Some("write") {
                existing.additions = incoming.additions;
                existing.deletions = incoming.deletions;
            } else {
                existing.additions += incoming.additions;
                existing.deletions += incoming.deletions;
            }
            if incoming.source.is_some() {
                existing.source = incoming.source;
            }
        }
        existing.is_running |= incoming.is_running;
        for n in incoming.nodes {
            if !existing.nodes.contains(&n) {
                existing.nodes.push(n);
            }
        }
        for id in incoming.execution_ids {
            if !existing.execution_ids.contains(&id) {
                existing.execution_ids.push(id);
            }
        }
    } else {
        map.insert(incoming.path.clone(), incoming);
    }
}

/// Extract file changes from an execution or planning JSONL transcript.
#[derive(Default, Clone)]
struct ChangeAccumulator {
    known_existing: HashSet<String>,
    settled_ids: HashSet<String>,
    pending: HashMap<String, Vec<FileChangeItem>>,
    pending_reads: HashMap<String, String>,
    committed: BTreeMap<String, FileChangeItem>,
    process_alive: bool,
}

impl ChangeAccumulator {
    fn settled(&mut self) {
        self.process_alive = false;
        self.pending.clear();
    }
}

/// Incremental parser state: callers feed whole transcripts or just the bytes
/// appended since the previous call without re-reading earlier output.
fn apply_jsonl(
    acc: &mut ChangeAccumulator,
    jsonl: &str,
    node: &str,
    execution_id: &str,
    worktree: &str,
    repository: &str,
    is_execution_running: bool,
) {
    for raw_line in jsonl.lines() {
        let line = raw_line.trim();
        if line.is_empty()
            || (!line.contains("\"tool") && !line.contains("\"grapher_process"))
        {
            continue;
        }
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(event_type) = event["type"].as_str() else {
            continue;
        };

        match event_type {
            "tool_execution_start" | "tool_execution_update" => {
                let id = event["toolCallId"].as_str().unwrap_or_default().to_string();
                let tool_name = event["toolName"].as_str().unwrap_or_default();
                let args = &event["args"];
                if tool_name == "read" {
                    if let Some(raw_p) = args["path"].as_str().or_else(|| args["file"].as_str()) {
                        if let Some(norm) = normalize_workspace_path(raw_p, worktree, repository) {
                            if !id.is_empty() {
                                acc.pending_reads.insert(id, norm);
                            }
                        }
                    }
                    continue;
                }
                let items = build_tool_change_items(
                    tool_name,
                    args,
                    &acc.known_existing,
                    worktree,
                    repository,
                    node,
                    execution_id,
                );
                if !items.is_empty() && !id.is_empty() {
                    acc.pending.insert(id, items);
                }
            }
            "message_update" => {
                let sub = &event["assistantMessageEvent"];
                if sub["type"] == "toolcall_end" {
                    let tc = &sub["toolCall"];
                    let id = tc["id"].as_str().unwrap_or_default().to_string();
                    let tool_name = tc["name"].as_str().unwrap_or_default();
                    let args = &tc["arguments"];
                    if tool_name == "read" {
                        if let Some(raw_p) = args["path"].as_str().or_else(|| args["file"].as_str()) {
                            if let Some(norm) = normalize_workspace_path(raw_p, worktree, repository) {
                                if !id.is_empty() {
                                    acc.pending_reads.insert(id, norm);
                                }
                            }
                        }
                        continue;
                    }
                    let items = build_tool_change_items(
                        tool_name,
                        args,
                        &acc.known_existing,
                        worktree,
                        repository,
                        node,
                        execution_id,
                    );
                    if !items.is_empty() && !id.is_empty() {
                        acc.pending.insert(id, items);
                    }
                }
            }
            "tool_execution_end" => {
                let id = event["toolCallId"].as_str().unwrap_or_default();
                if !id.is_empty() {
                    acc.settled_ids.insert(id.to_string());
                }
                let exit_code = event["result"]["details"]["exitCode"].as_i64();
                let is_error = event["isError"].as_bool().unwrap_or(false)
                    || event["result"]["isError"].as_bool().unwrap_or(false)
                    || exit_code.is_some_and(|code| code != 0);
                if let Some(read_path) = acc.pending_reads.remove(id) {
                    if !is_error {
                        acc.known_existing.insert(read_path);
                    }
                }
                if let Some(items) = acc.pending.remove(id) {
                    if !is_error {
                        for item in items {
                            acc.known_existing.insert(item.path.clone());
                            merge_file_item_into(&mut acc.committed, item);
                        }
                    }
                } else if !is_error {
                    let tool_name = event["toolName"].as_str().unwrap_or_default();
                    let items = build_tool_change_items(
                        tool_name,
                        &event["args"],
                        &acc.known_existing,
                        worktree,
                        repository,
                        node,
                        execution_id,
                    );
                    for item in items {
                        acc.known_existing.insert(item.path.clone());
                        merge_file_item_into(&mut acc.committed, item);
                    }
                }
            }
            "message" | "message_end" => {
                let msg = &event["message"];
                if msg["role"] == "assistant" {
                    if let Some(parts) = msg["content"].as_array() {
                        for part in parts {
                            if part["type"] == "toolCall" {
                                let id = part["id"].as_str().unwrap_or_default().to_string();
                                if !id.is_empty() && acc.settled_ids.contains(&id) {
                                    continue;
                                }
                                let tool_name = part["name"].as_str().unwrap_or_default();
                                let args = &part["arguments"];
                                if tool_name == "read" {
                                    if let Some(raw_p) = args["path"].as_str().or_else(|| args["file"].as_str()) {
                                        if let Some(norm) = normalize_workspace_path(raw_p, worktree, repository) {
                                            if !id.is_empty() {
                                                acc.pending_reads.insert(id, norm);
                                            }
                                        }
                                    }
                                    continue;
                                }
                                let items = build_tool_change_items(
                                    tool_name,
                                    args,
                                    &acc.known_existing,
                                    worktree,
                                    repository,
                                    node,
                                    execution_id,
                                );
                                if !items.is_empty() && !id.is_empty() {
                                    acc.pending.insert(id, items);
                                }
                            }
                        }
                    }
                } else if msg["role"] == "toolResult" {
                    let id = msg["toolCallId"].as_str().unwrap_or_default();
                    if !id.is_empty() {
                        acc.settled_ids.insert(id.to_string());
                    }
                    let exit_code = msg["details"]["exitCode"].as_i64();
                    let is_error = msg["isError"].as_bool().unwrap_or(false)
                        || exit_code.is_some_and(|code| code != 0);
                    if let Some(read_path) = acc.pending_reads.remove(id) {
                        if !is_error {
                            acc.known_existing.insert(read_path);
                        }
                    }
                    if let Some(items) = acc.pending.remove(id) {
                        if !is_error {
                            for item in items {
                                acc.known_existing.insert(item.path.clone());
                                merge_file_item_into(&mut acc.committed, item);
                            }
                        }
                    }
                }
            }
            "grapher_process_exited" => {
                acc.process_alive = false;
                acc.pending.clear();
            }
            "grapher_process_started" => {
                acc.process_alive = is_execution_running;
            }
            _ => {}
        }
    }

}

fn accumulator_summary(acc: &ChangeAccumulator) -> FileChangeSummary {
    // In-flight tool calls stay pending in the accumulator; only this view
    // marks them running so a later tool result can settle them normally.
    let mut files = acc.committed.clone();
    let mut active_file_path = None;
    if acc.process_alive {
        for items in acc.pending.values() {
            for mut item in items.clone() {
                item.is_running = true;
                active_file_path = Some(item.path.clone());
                merge_file_item_into(&mut files, item);
            }
        }
    }
    let is_running = acc.process_alive && active_file_path.is_some();
    FileChangeSummary::from_files(files.into_values().collect(), is_running, active_file_path)
}

pub fn parse_jsonl_file_changes(
    jsonl: &str,
    node: &str,
    execution_id: &str,
    worktree: &str,
    repository: &str,
    is_execution_running: bool,
) -> FileChangeSummary {
    let mut acc = ChangeAccumulator {
        process_alive: is_execution_running,
        ..Default::default()
    };
    apply_jsonl(&mut acc, jsonl, node, execution_id, worktree, repository, is_execution_running);
    accumulator_summary(&acc)
}

/// Parse `git diff --name-status` and `git diff --numstat` between two commits or working tree.
pub fn compute_git_changes(
    repo_or_worktree: &Path,
    before: &str,
    after: Option<&str>,
    node: &str,
    execution_id: &str,
) -> Option<FileChangeSummary> {
    if before.is_empty() || !repo_or_worktree.exists() {
        return None;
    }

    let run_git = |args: &[&str]| -> Result<String, String> {
        crate::workspace::repository_git(repo_or_worktree, args)
            .or_else(|_| crate::workspace::git(repo_or_worktree, args))
    };

    let status_args: Vec<&str> = match after {
        Some(after_sha) if !after_sha.is_empty() => {
            if before == after_sha {
                return Some(FileChangeSummary::default());
            }
            vec!["diff", "--name-status", "-M", before, after_sha]
        }
        _ => vec!["diff", "--name-status", "-M", before],
    };
    let numstat_args: Vec<&str> = match after {
        Some(after_sha) if !after_sha.is_empty() => {
            vec!["diff", "--numstat", "-M", before, after_sha]
        }
        _ => vec!["diff", "--numstat", "-M", before],
    };

    let status_out = run_git(&status_args).ok()?;
    let numstat_out = run_git(&numstat_args).unwrap_or_default();

    let mut numstats: HashMap<String, (usize, usize)> = HashMap::new();
    for line in numstat_out.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            let add = parts[0].parse::<usize>().unwrap_or(0);
            let del = parts[1].parse::<usize>().unwrap_or(0);
            let raw_path = parts.last().copied().unwrap_or_default();
            // Handle rename numstat format if any
            let clean_path = normalize_slashes(raw_path);
            numstats.insert(clean_path, (add, del));
        }
    }

    let mut items_map: BTreeMap<String, FileChangeItem> = BTreeMap::new();
    for line in status_out.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let code = parts[0].trim();
        let (status, path, old_path) = if code.starts_with('R') && parts.len() >= 3 {
            (
                "renamed",
                normalize_slashes(parts[2]),
                Some(normalize_slashes(parts[1])),
            )
        } else if code.starts_with('A') {
            ("added", normalize_slashes(parts[1]), None)
        } else if code.starts_with('D') {
            ("deleted", normalize_slashes(parts[1]), None)
        } else {
            ("modified", normalize_slashes(parts[1]), None)
        };

        if crate::path_identity::is_runtime_metadata_path(Path::new(&path))
            || path == ".git"
            || path.starts_with(".git/")
            || path.ends_with("/.DS_Store")
            || path == ".DS_Store"
        {
            continue;
        }
        let (additions, deletions) = numstats.get(&path).copied().unwrap_or((0, 0));
        items_map.insert(
            path.clone(),
            FileChangeItem {
                path,
                old_path,
                status: status.into(),
                additions,
                deletions,
                is_running: false,
                nodes: if node.is_empty() { vec![] } else { vec![node.into()] },
                execution_ids: if execution_id.is_empty() {
                    vec![]
                } else {
                    vec![execution_id.into()]
                },
                source: Some("git".into()),
            },
        );
    }

    // If comparing against live working tree (`after` is None), also collect untracked files
    if after.is_none() {
        if let Ok(untracked) = run_git(&["ls-files", "--others", "-z"]) {
            for raw in untracked.split('\0') {
                if raw.is_empty() {
                    continue;
                }
                let path = normalize_slashes(raw);
                if crate::path_identity::is_runtime_metadata_path(Path::new(&path))
                    || path == ".git"
                    || path.starts_with(".git/")
                    || path.ends_with("/.DS_Store")
                    || path == ".DS_Store"
                {
                    continue;
                }
                if !items_map.contains_key(&path) {
                    let full = repo_or_worktree.join(&path);
                    let additions = fs::metadata(&full)
                        .ok()
                        .filter(|m| m.is_file() && m.len() <= 256 * 1024)
                        .and_then(|_| fs::read_to_string(&full).ok())
                        .map(|content| content.lines().count())
                        .unwrap_or(0);
                    items_map.insert(
                        path.clone(),
                        FileChangeItem {
                            path,
                            old_path: None,
                            status: "added".into(),
                            additions,
                            deletions: 0,
                            is_running: false,
                            nodes: if node.is_empty() { vec![] } else { vec![node.into()] },
                            execution_ids: if execution_id.is_empty() {
                                vec![]
                            } else {
                                vec![execution_id.into()]
                            },
                            source: Some("git".into()),
                        },
                    );
                }
            }
        }
    }

    Some(FileChangeSummary::from_files(
        items_map.into_values().collect(),
        false,
        None,
    ))
}

pub fn merge_summaries(summaries: &[FileChangeSummary], is_running: bool) -> FileChangeSummary {
    let mut map: BTreeMap<String, FileChangeItem> = BTreeMap::new();
    let mut active_file_path = None;
    let mut any_running = is_running;
    for summary in summaries {
        if summary.is_running {
            any_running = true;
        }
        if summary.active_file_path.is_some() {
            active_file_path = summary.active_file_path.clone();
        }
        for item in &summary.files {
            merge_file_item_into(&mut map, item.clone());
        }
    }
    FileChangeSummary::from_files(map.into_values().collect(), any_running, active_file_path)
}

pub fn update_from_log_text(
    run_id: &str,
    execution_id: &str,
    node: &str,
    worktree: &str,
    repository: &str,
    text: &str,
    is_running: bool,
    replace: bool,
) {
    if run_id.is_empty() || execution_id.is_empty() {
        return;
    }
    if text.is_empty() {
        if replace {
            if let Ok(mut guard) = cache().lock() {
                let key = (run_id.to_string(), execution_id.to_string());
                guard.log_changes.remove(&key);
                guard.live.remove(&key);
            }
        }
        return;
    }
    let mut acc = ChangeAccumulator {
        process_alive: is_running,
        ..Default::default()
    };
    apply_jsonl(&mut acc, text, node, execution_id, worktree, repository, is_running);
    let summary = accumulator_summary(&acc);
    let key = (run_id.to_string(), execution_id.to_string());
    if !summary.is_empty() {
        if let Ok(mut guard) = cache().lock() {
            if replace {
                guard.live.insert(key.clone(), acc);
                guard.log_changes.insert(key, summary);
            } else if let Some(existing) = guard.log_changes.get(&key).cloned() {
                let merged = merge_summaries(&[existing, summary], is_running);
                guard.log_changes.insert(key, merged);
            } else {
                guard.log_changes.insert(key, summary);
            }
        }
    } else if replace {
        if let Ok(mut guard) = cache().lock() {
            guard.log_changes.remove(&key);
            guard.live.remove(&key);
        }
    } else if !is_running {
        if let Ok(mut guard) = cache().lock() {
            if let Some(entry) = guard.log_changes.get_mut(&key) {
                entry.is_running = false;
                entry.active_file_path = None;
                for f in &mut entry.files {
                    f.is_running = false;
                }
            }
        }
    }
}

/// Parse only freshly appended log bytes. Streaming writers call this per
/// flush, so a long-running execution never re-reads megabytes of transcript.
pub fn update_from_log_chunk(
    run_id: &str,
    execution_id: &str,
    node: &str,
    worktree: &str,
    repository: &str,
    chunk: &str,
    is_running: bool,
) {
    if run_id.is_empty() || execution_id.is_empty() || chunk.is_empty() {
        return;
    }
    let key = (run_id.to_string(), execution_id.to_string());
    let Ok(mut guard) = cache().lock() else { return; };
    let acc = guard.live.entry(key.clone()).or_insert_with(|| ChangeAccumulator {
        process_alive: is_running,
        ..Default::default()
    });
    apply_jsonl(acc, chunk, node, execution_id, worktree, repository, is_running);
    let summary = accumulator_summary(acc);
    if summary.is_empty() {
        if !is_running {
            guard.log_changes.remove(&key);
            guard.live.remove(&key);
        }
        return;
    }
    guard.log_changes.insert(key, summary);
}

/// A terminal event settles every in-flight tool call of that execution.
pub fn settle(run_id: &str, execution_id: &str) {
    if run_id.is_empty() || execution_id.is_empty() {
        return;
    }
    let key = (run_id.to_string(), execution_id.to_string());
    let Ok(mut guard) = cache().lock() else { return; };
    let Some(acc) = guard.live.get_mut(&key) else { return; };
    acc.settled();
    let summary = accumulator_summary(acc);
    if summary.is_empty() {
        guard.log_changes.remove(&key);
        guard.live.remove(&key);
    } else {
        guard.log_changes.insert(key, summary);
    }
}

pub fn reset_planning(run_id: &str, planning_id: &str) {
    if run_id.is_empty() || planning_id.is_empty() {
        return;
    }
    if let Ok(mut guard) = cache().lock() {
        let key = (run_id.to_string(), planning_id.to_string());
        guard.live.remove(&key);
        guard.planning_changes.remove(&key);
        guard.planning_live.remove(&key);
    }
}

/// Planner turns stream line by line; keep the same incremental accounting so
/// pre-execution writes appear without re-reading the whole planning log.
pub fn update_planning_from_log_chunk(
    run_id: &str,
    planning_id: &str,
    worktree: &str,
    repository: &str,
    chunk: &str,
) {
    if run_id.is_empty() || planning_id.is_empty() || chunk.is_empty() {
        return;
    }
    if !chunk.contains("\"tool") && !chunk.contains("\"grapher_process") {
        return;
    }
    let key = (run_id.to_string(), planning_id.to_string());
    let Ok(mut guard) = cache().lock() else { return; };
    let acc = guard.planning_live.entry(key.clone()).or_insert_with(|| ChangeAccumulator {
        process_alive: true,
        ..Default::default()
    });
    apply_jsonl(acc, chunk, "planner", planning_id, worktree, repository, true);
    let summary = accumulator_summary(acc);
    if summary.is_empty() {
        guard.planning_changes.remove(&key);
    } else {
        guard.planning_changes.insert(key, summary);
    }
}

pub fn settle_planning(run_id: &str, planning_id: &str) {
    if run_id.is_empty() || planning_id.is_empty() {
        return;
    }
    let key = (run_id.to_string(), planning_id.to_string());
    let Ok(mut guard) = cache().lock() else { return; };
    let Some(acc) = guard.planning_live.get_mut(&key) else { return; };
    acc.settled();
    let summary = accumulator_summary(acc);
    if summary.is_empty() {
        guard.planning_changes.remove(&key);
        guard.planning_live.remove(&key);
    } else {
        guard.planning_changes.insert(key, summary);
    }
}

pub fn record_git_commit_changes(
    run_id: &str,
    execution_id: &str,
    node: &str,
    worktree: &Path,
    repository: &Path,
    before: &str,
    after: &str,
) {
    if run_id.is_empty() || execution_id.is_empty() || before.is_empty() || after.is_empty() {
        return;
    }
    let target = if worktree.exists() { worktree } else { repository };
    if let Some(summary) = compute_git_changes(target, before, Some(after), node, execution_id) {
        if !summary.is_empty() {
            if let Ok(mut guard) = cache().lock() {
                guard
                    .git_changes
                    .insert((run_id.to_string(), execution_id.to_string()), summary);
            }
        }
    }
}

pub fn record_publication_git_changes(run_id: &str, repository: &Path, base: &str, head: &str) {
    if run_id.is_empty() || base.is_empty() || head.is_empty() {
        return;
    }
    if let Some(summary) = compute_git_changes(repository, base, Some(head), "", "") {
        if !summary.is_empty() {
            if let Ok(mut guard) = cache().lock() {
                guard.publication_changes.insert(run_id.to_string(), summary);
            }
        }
    }
}

pub fn get_cached_execution_changes(
    run_id: &str,
    execution: &Execution,
) -> Option<FileChangeSummary> {
    let guard = cache().lock().ok()?;
    let key = (run_id.to_string(), execution.id.clone());
    let log_part = guard.log_changes.get(&key);
    let git_part = guard.git_changes.get(&key);
    let is_running = execution.status == "running";

    let mut combined = match (log_part, git_part) {
        (Some(l), Some(g)) => merge_summaries(&[l.clone(), g.clone()], is_running),
        (Some(l), None) => l.clone(),
        (None, Some(g)) => g.clone(),
        (None, None) => return None,
    };

    if !is_running {
        combined.is_running = false;
        combined.active_file_path = None;
        for f in &mut combined.files {
            f.is_running = false;
        }
    }
    (!combined.is_empty()).then_some(combined)
}

pub fn get_cached_run_changes(state: &Snapshot) -> Option<FileChangeSummary> {
    if state.run_id.is_empty() {
        return None;
    }
    let guard = cache().lock().ok()?;
    let mut parts = Vec::new();

    if let Some(planning_id) = &state.planning_id {
        if let Some(p) = guard
            .planning_changes
            .get(&(state.run_id.clone(), planning_id.clone()))
        {
            parts.push(p.clone());
        }
    }

    for exec in state.executions.iter().chain(state.mergers.iter()) {
        if state.superseded_execution_ids.contains(&exec.id) {
            continue;
        }
        let key = (state.run_id.clone(), exec.id.clone());
        if let Some(l) = guard.log_changes.get(&key) {
            parts.push(l.clone());
        }
        if let Some(g) = guard.git_changes.get(&key) {
            parts.push(g.clone());
        }
    }

    if let Some(pub_changes) = guard.publication_changes.get(&state.run_id) {
        parts.push(pub_changes.clone());
    }

    if parts.is_empty() {
        return None;
    }
    let any_running = state
        .executions
        .iter()
        .chain(state.mergers.iter())
        .any(|e| e.status == "running" && !state.superseded_execution_ids.contains(&e.id));
    let merged = merge_summaries(&parts, any_running);
    if !any_running {
        let mut settled = merged;
        settled.is_running = false;
        settled.active_file_path = None;
        for f in &mut settled.files {
            f.is_running = false;
        }
        return (!settled.is_empty()).then_some(settled);
    }
    (!merged.is_empty()).then_some(merged)
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRunChanges {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    executions: BTreeMap<String, FileChangeSummary>,
    #[serde(default)]
    planning: BTreeMap<String, FileChangeSummary>,
    #[serde(default)]
    publication: Option<FileChangeSummary>,
}

fn safe_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
}

fn persisted_path(root: &Path, run_id: &str) -> Option<PathBuf> {
    safe_run_id(run_id).then(|| root.join("file-changes").join(run_id).join("changes.json"))
}

/// Counts are tiny (paths, status and two integers), so a sidecar per Run
/// removes the cold-start log replay without touching the event schema.
pub fn persist_run(root: &Path, run_id: &str) -> Result<(), String> {
    let Some(path) = persisted_path(root, run_id) else {
        return Ok(());
    };
    let mut persisted = PersistedRunChanges { version: 1, ..Default::default() };
    {
        let Ok(guard) = cache().lock() else { return Ok(()); };
        let mut per_execution: BTreeMap<String, Vec<&FileChangeSummary>> = BTreeMap::new();
        for ((run, execution_id), summary) in guard.log_changes.iter().chain(guard.git_changes.iter()) {
            if run == run_id {
                per_execution.entry(execution_id.clone()).or_default().push(summary);
            }
        }
        for (execution_id, parts) in per_execution {
            let merged = merge_summaries(
                &parts.into_iter().cloned().collect::<Vec<_>>(),
                false,
            );
            persisted.executions.insert(execution_id, merged);
        }
        for ((run, planning_id), summary) in &guard.planning_changes {
            if run == run_id {
                persisted.planning.insert(planning_id.clone(), summary.clone());
            }
        }
        persisted.publication = guard.publication_changes.get(run_id).cloned();
    }
    if persisted.executions.is_empty()
        && persisted.planning.is_empty()
        && persisted.publication.is_none()
    {
        return Ok(());
    }
    let bytes = serde_json::to_vec(&persisted).map_err(|error| error.to_string())?;
    let directory = path.parent().ok_or("Invalid file-change path")?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let temporary = path.with_file_name("changes.json.tmp");
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    Ok(())
}

/// Restore a persisted Run before any log replay, so loading a conversation
/// after a restart does not re-read megabytes of execution logs.
pub fn hydrate_run(root: &Path, run_id: &str) {
    let Some(path) = persisted_path(root, run_id) else { return; };
    let Ok(text) = fs::read_to_string(&path) else { return; };
    let Ok(saved) = serde_json::from_str::<PersistedRunChanges>(&text) else { return; };
    let Ok(mut guard) = cache().lock() else { return; };
    let key_run = run_id.to_string();
    for (execution_id, summary) in saved.executions {
        guard
            .log_changes
            .entry((key_run.clone(), execution_id))
            .or_insert(summary);
    }
    for (planning_id, summary) in saved.planning {
        guard
            .planning_changes
            .entry((key_run.clone(), planning_id))
            .or_insert(summary);
    }
    if let Some(publication) = saved.publication {
        guard
            .publication_changes
            .entry(key_run)
            .or_insert(publication);
    }
}

/// Warm cache for a Run (called on load/history and by the summary endpoint).
pub fn warm_run_changes(state: &Snapshot, store: &crate::store::Store, root: Option<&Path>) {
    if state.run_id.is_empty() {
        return;
    }
    if let Some(root) = root {
        hydrate_run(root, &state.run_id);
    }
    let repo_str = state
        .config
        .as_ref()
        .map(|c| c.repository.as_str())
        .unwrap_or_default();
    let repo_path = Path::new(repo_str);

    // Planner writes precede every node snapshot, so a reloaded run re-reads
    // its persisted planner log once (bounded) instead of losing those files.
    if let (Some(root), Some(planning_id)) = (root, state.planning_id.as_deref()) {
        let cached = cache().lock().ok()
            .is_some_and(|g| g.planning_changes.contains_key(&(state.run_id.clone(), planning_id.to_string())));
        let log = root.join("planning").join(planning_id).join("planner.jsonl");
        if !cached && std::fs::metadata(&log).ok().is_some_and(|meta| meta.len() <= 4 * 1024 * 1024) {
            if let Ok(text) = std::fs::read_to_string(&log) {
                let worktree = state.planning.as_ref()
                    .and_then(|planning| planning.worktree.as_deref())
                    .unwrap_or(repo_str);
                let summary = parse_jsonl_file_changes(
                    &text, "planner", planning_id, worktree, repo_str, false,
                );
                if !summary.is_empty() {
                    if let Ok(mut guard) = cache().lock() {
                        guard.planning_changes.insert(
                            (state.run_id.clone(), planning_id.to_string()), summary,
                        );
                    }
                }
            }
        }
    }

    for exec in state.executions.iter().chain(state.mergers.iter()) {
        if state.superseded_execution_ids.contains(&exec.id) {
            continue;
        }
        let key = (state.run_id.clone(), exec.id.clone());
        let already_cached = cache()
            .lock()
            .ok()
            .is_some_and(|g| g.log_changes.contains_key(&key) || g.git_changes.contains_key(&key));

        if !already_cached && exec.output_bytes > 0 && exec.output_bytes <= 4 * 1024 * 1024 {
            if let Ok(page) = store.execution_log_page(&state.run_id, &exec.id, 0, 4 * 1024 * 1024)
            {
                update_from_log_text(
                    &state.run_id,
                    &exec.id,
                    &exec.node,
                    &exec.worktree,
                    repo_str,
                    &page.content,
                    exec.status == "running",
                    true,
                );
            }
        }

        if let Some(after) = &exec.after {
            if !exec.before.is_empty() && !after.is_empty() {
                let has_git = cache()
                    .lock()
                    .ok()
                    .is_some_and(|g| g.git_changes.contains_key(&key));
                if !has_git && !repo_str.is_empty() {
                    record_git_commit_changes(
                        &state.run_id,
                        &exec.id,
                        &exec.node,
                        Path::new(&exec.worktree),
                        repo_path,
                        &exec.before,
                        after,
                    );
                }
            }
        }
    }

    if let Some(pub_state) = &state.publication {
        if let Some(head) = &pub_state.head {
            if !state.base.is_empty() && !head.is_empty() && !pub_state.repository.is_empty() {
                let has_pub = cache()
                    .lock()
                    .ok()
                    .is_some_and(|g| g.publication_changes.contains_key(&state.run_id));
                if !has_pub {
                    record_publication_git_changes(
                        &state.run_id,
                        Path::new(&pub_state.repository),
                        &state.base,
                        head,
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_paths_and_strips_worktrees() {
        assert_eq!(
            normalize_workspace_path(
                "/Users/test/repo/src/App.tsx",
                "/Users/test/repo",
                "/Users/test/repo"
            ),
            Some("src/App.tsx".into())
        );
        assert_eq!(
            normalize_workspace_path(
                "C:\\Users\\test\\ cache\\.grapher-worktrees\\run-1\\node-1\\src\\lib\\util.ts",
                "",
                "C:\\Users\\test\\repo"
            ),
            Some("src/lib/util.ts".into())
        );
        assert_eq!(
            normalize_workspace_path(".git/config", "/repo", "/repo"),
            None
        );
        assert_eq!(
            normalize_workspace_path(".grapher/events.sqlite", "/repo", "/repo"),
            None
        );
    }

    #[test]
    fn parses_write_edit_and_bash_tool_calls_from_jsonl() {
        let jsonl = [
            r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"read","args":{"path":"existing.ts"}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t1","toolName":"read","isError":false,"result":{"content":"const a = 1;\n"}}"#,
            r#"{"type":"tool_execution_start","toolCallId":"t2","toolName":"write","args":{"path":"new_file.ts","content":"export const x = 1;\nexport const y = 2;\n"}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t2","toolName":"write","isError":false}"#,
            r#"{"type":"tool_execution_start","toolCallId":"t3","toolName":"edit","args":{"path":"existing.ts","edits":[{"oldText":"const a = 1;","newText":"const a = 2;\nconst b = 3;"}]}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t3","toolName":"edit","isError":false}"#,
            r#"{"type":"tool_execution_start","toolCallId":"t4","toolName":"bash","args":{"command":"rm old_unused.ts"}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t4","toolName":"bash","isError":false,"result":{"details":{"exitCode":0}}}"#,
        ]
        .join("\n");

        let summary = parse_jsonl_file_changes(&jsonl, "frontend", "exec-1", "/repo", "/repo", false);
        assert_eq!(summary.total_files, 3);
        assert_eq!(summary.added_count, 1);
        assert_eq!(summary.modified_count, 1);
        assert_eq!(summary.deleted_count, 1);

        let added = summary.files.iter().find(|f| f.path == "new_file.ts").unwrap();
        assert_eq!(added.status, "added");
        assert_eq!(added.additions, 2);

        let modified = summary.files.iter().find(|f| f.path == "existing.ts").unwrap();
        assert_eq!(modified.status, "modified");
        assert_eq!(modified.additions, 2);
        assert_eq!(modified.deletions, 1);
        assert_eq!(modified.additions, 2);
        assert_eq!(modified.deletions, 1);

        let deleted = summary.files.iter().find(|f| f.path == "old_unused.ts").unwrap();
        assert_eq!(deleted.status, "deleted");
    }

    #[test]
    fn tracks_in_flight_tool_calls_while_running() {
        let jsonl = r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"edit","args":{"path":"src/live.ts","edits":[{"oldText":"a","newText":"b"}]}}"#;
        let running = parse_jsonl_file_changes(jsonl, "task", "exec-1", "/repo", "/repo", true);
        assert!(running.is_running);
        assert_eq!(running.active_file_path.as_deref(), Some("src/live.ts"));
        assert_eq!(running.files[0].is_running, true);

        let settled = parse_jsonl_file_changes(jsonl, "task", "exec-1", "/repo", "/repo", false);
        assert!(!settled.is_running);
        assert_eq!(settled.active_file_path, None);
    }

    #[test]
    fn chunked_stream_keeps_pending_calls_and_settles_on_the_next_chunk() {
        let start = r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"edit","args":{"path":"src/a.ts","edits":[{"oldText":"old line","newText":"new line"}]}}"#;
        let end = r#"{"type":"tool_execution_end","toolCallId":"t1","toolName":"edit","isError":false}"#;
        let mut acc = ChangeAccumulator { process_alive: true, ..Default::default() };
        apply_jsonl(&mut acc, start, "worker", "exec-1", "/repo", "/repo", true);
        let live = accumulator_summary(&acc);
        assert!(live.is_running, "a started tool is in flight");
        assert_eq!(live.active_file_path.as_deref(), Some("src/a.ts"));

        apply_jsonl(&mut acc, end, "worker", "exec-1", "/repo", "/repo", true);
        let settled = accumulator_summary(&acc);
        assert!(!settled.is_running, "the completion chunk settles the call");
        assert_eq!(settled.active_file_path, None);
        assert_eq!(settled.total_files, 1);
        assert_eq!(settled.files[0].status, "modified");
        assert_eq!(settled.files[0].additions, 1);
        assert_eq!(settled.files[0].deletions, 1);
    }

    #[test]
    fn finishing_an_execution_drops_an_unfinished_tool_call() {
        let start = r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"write","args":{"path":"src/new.ts","content":"export const x = 1;"}}"#;
        let mut acc = ChangeAccumulator { process_alive: true, ..Default::default() };
        apply_jsonl(&mut acc, start, "worker", "exec-1", "/repo", "/repo", true);
        assert_eq!(accumulator_summary(&acc).files[0].is_running, true);
        acc.settled();
        let done = accumulator_summary(&acc);
        assert!(!done.is_running);
        assert!(done.files.is_empty());
    }

    #[test]
    fn planning_chunks_reach_the_run_summary() {
        invalidate_run("planning-run");
        reset_planning("planning-run", "planning-1");
        let start = r##"{"type":"tool_execution_start","toolCallId":"p1","toolName":"write","args":{"path":"docs/plan.md","content":"# Plan"}}"##;
        let end = r#"{"type":"tool_execution_end","toolCallId":"p1","toolName":"write","isError":false}"#;
        update_planning_from_log_chunk("planning-run", "planning-1", "/repo", "/repo", start);
        update_planning_from_log_chunk("planning-run", "planning-1", "/repo", "/repo", end);
        settle_planning("planning-run", "planning-1");
        let mut state = Snapshot::default();
        state.run_id = "planning-run".into();
        state.planning_id = Some("planning-1".into());
        let summary = get_cached_run_changes(&state).expect("planner writes are part of the run summary");
        assert_eq!(summary.files[0].path, "docs/plan.md");
        assert_eq!(summary.files[0].nodes, vec!["planner".to_string()]);
        invalidate_run("planning-run");
    }

    #[test]
    fn persisted_summary_survives_a_cache_reset() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let run = "persisted-run";
        invalidate_run(run);
        let jsonl = [
            r#"{"type":"tool_execution_start","toolCallId":"t","toolName":"edit","args":{"path":"src/a.ts","edits":[{"oldText":"old","newText":"new"}]}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"t","toolName":"edit","isError":false}"#,
        ].join("
");
        update_from_log_text(run, "exec", "worker", "/repo", "/repo", &jsonl, false, true);
        persist_run(root, run).unwrap();

        let path = root.join("file-changes").join(run).join("changes.json");
        assert!(path.is_file(), "counts are persisted next to runtime data");
        assert!(std::fs::metadata(&path).unwrap().len() < 4096, "summary stays tiny");

        clear_all();
        hydrate_run(root, run);
        let state = Snapshot { run_id: run.into(), ..Default::default() };
        let execution = Execution {
            id: "exec".into(), node: "worker".into(), revision: 0, attempt: 1,
            session_id: "session".into(), worktree: "/repo".into(), before: String::new(),
            workspace_lineage: vec![], after: None, input: None, result: None,
            status: "completed".into(), output: String::new(), output_bytes: 0, pid: None,
            started_at: 1, completed_at: Some(2), metrics: None,
        };
        let summary = get_cached_execution_changes(&state.run_id, &execution)
            .expect("hydrated summary is available without reading logs");
        assert_eq!(summary.total_files, 1);
        assert_eq!(summary.files[0].path, "src/a.ts");
        assert_eq!(summary.files[0].additions, 1);
        invalidate_run(run);
    }

    #[test]
    fn computes_git_commit_and_working_tree_file_changes_and_diffs() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        crate::workspace::git(&repo, &["init", "-q"]).unwrap();
        crate::workspace::git(&repo, &["config", "user.email", "test@example.com"]).unwrap();
        crate::workspace::git(&repo, &["config", "user.name", "Test"]).unwrap();

        fs::write(repo.join("keep.txt"), "line1\nline2\n").unwrap();
        fs::write(repo.join("remove.txt"), "bye\n").unwrap();
        crate::workspace::git(&repo, &["add", "-A"]).unwrap();
        crate::workspace::git(&repo, &["commit", "-q", "-m", "base"]).unwrap();
        let before = crate::workspace::git(&repo, &["rev-parse", "HEAD"]).unwrap();

        // Modify keep.txt, delete remove.txt, add added.txt
        fs::write(repo.join("keep.txt"), "line1\nline2_modified\nline3\n").unwrap();
        fs::remove_file(repo.join("remove.txt")).unwrap();
        fs::write(repo.join("added.txt"), "new1\nnew2\n").unwrap();

        // Working tree changes (before commit)
        let live_summary = compute_git_changes(&repo, &before, None, "worker", "exec-live").unwrap();
        assert_eq!(live_summary.total_files, 3);
        assert_eq!(live_summary.added_count, 1);
        assert_eq!(live_summary.modified_count, 1);
        assert_eq!(live_summary.deleted_count, 1);

        // Commit and check before..after
        crate::workspace::git(&repo, &["add", "-A"]).unwrap();
        crate::workspace::git(&repo, &["commit", "-q", "-m", "after"]).unwrap();
        let after = crate::workspace::git(&repo, &["rev-parse", "HEAD"]).unwrap();

        let committed_summary =
            compute_git_changes(&repo, &before, Some(&after), "worker", "exec-1").unwrap();
        assert_eq!(committed_summary.total_files, 3);
        assert_eq!(committed_summary.added_count, 1);
        assert_eq!(committed_summary.modified_count, 1);
        assert_eq!(committed_summary.deleted_count, 1);

    }
}
