//! Branch a settled Pi JSONL session before a previous user turn. Keep the
//! abandoned branch in the same file, as Pi's /tree does; never truncate it.
use std::{collections::{HashMap, HashSet}, fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}};
use serde_json::{json, Value};
use uuid::Uuid;

pub struct PreparedBranch {
    path: PathBuf,
    old_len: u64,
}

impl PreparedBranch {
    pub fn rollback(self) -> Result<(), String> {
        OpenOptions::new().write(true).open(&self.path)
            .and_then(|file| file.set_len(self.old_len))
            .map_err(|error| format!("Cannot restore Pi session after failed edit: {error}"))
    }
}

fn open_session(source_dir: &Path, source_id: &str, source_cwd: &Path)
    -> Result<(PathBuf, std::io::BufReader<fs::File>, Value), String>
{
    use std::io::{BufRead, BufReader, Read, Seek};
    Uuid::parse_str(source_id).map_err(|_| "Invalid source session ID")?;
    let suffix = format!("_{source_id}.jsonl");
    let files: Vec<_> = fs::read_dir(source_dir).map_err(|error| format!("Cannot open node session: {error}"))?
        .filter_map(Result::ok).filter(|entry| entry.file_name().to_string_lossy().ends_with(&suffix) && entry.path().is_file()).collect();
    if files.len() != 1 { return Err("Persisted node conversation is missing or ambiguous".into()); }
    let source = files[0].path();
    let mut file = fs::File::open(&source).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() == 0 { return Err("Empty node session".into()); }
    file.seek(std::io::SeekFrom::End(-1)).map_err(|error| error.to_string())?;
    let mut last = [0];
    file.read_exact(&mut last).map_err(|error| error.to_string())?;
    if last != [b'\n'] { return Err("Node session has an incomplete last entry".into()); }
    file.seek(std::io::SeekFrom::Start(0)).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    reader.read_line(&mut first).map_err(|error| error.to_string())?;
    let header: Value = serde_json::from_str(&first).map_err(|error| error.to_string())?;
    let expected = crate::native::host_path(source_cwd);
    let matches_cwd = header.get("cwd").and_then(Value::as_str).is_some_and(|cwd| {
        let actual = crate::native::host_path(Path::new(cwd));
        actual == expected || actual.canonicalize().ok().zip(expected.canonicalize().ok()).is_some_and(|(actual, expected)| actual == expected)
    });
    if header["type"] != "session" || header["id"] != source_id || !matches_cwd {
        return Err("Node session history belongs to another workspace or identity".into());
    }
    Ok((source, reader, header))
}

pub(crate) fn validate_session(directory: &Path, id: &str, cwd: &Path) -> Result<(), String> {
    open_session(directory, id, cwd).map(|_| ())
}

/// Move a node's own conversation to a new cwd without rewriting the original
/// history or loading its transcript into memory. Pi discovers this new binding
/// by its new session ID and cwd; parentSession keeps the lineage inspectable.
pub fn fork_session(
    source_dir: &Path, source_id: &str, source_cwd: &Path,
    target_dir: &Path, target_id: &str, target_cwd: &Path,
) -> Result<(), String> {
    Uuid::parse_str(target_id).map_err(|_| "Invalid target session ID")?;
    if target_id == source_id { return Err("A forked node session needs a new identity".into()); }
    let (source, mut reader, mut header) = open_session(source_dir, source_id, source_cwd)?;
    header["id"] = json!(target_id);
    header["cwd"] = json!(crate::native::host_path(target_cwd));
    header["parentSession"] = json!(crate::native::host_path(&source));
    fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;
    let target = target_dir.join(format!("grapher_{target_id}.jsonl"));
    if target.exists() { return Err("Cannot overwrite an existing forked node session".into()); }
    let temporary = target_dir.join(format!("fork-{}.pending", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| error.to_string())?;
        writeln!(file, "{header}").map_err(|error| error.to_string())?;
        std::io::copy(&mut reader, &mut file).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, &target).map_err(|error| error.to_string())
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn user_text(value: &Value) -> Option<String> {
    let message = value.get("message")?;
    if value.get("type")?.as_str()? != "message" || message.get("role")?.as_str()? != "user" {
        return None;
    }
    let content = message.get("content")?;
    if let Some(text) = content.as_str() { return Some(text.to_owned()); }
    content.as_array().map(|parts| parts.iter().filter_map(|part| {
        (part.get("type")?.as_str()? == "text").then(|| part.get("text")?.as_str()).flatten()
    }).collect::<Vec<_>>().join(""))
}

pub fn branch_before_user(
    session_dir: &Path, session_id: &str, cwd: &Path,
    old_text: &str, started_at: u64, completed_at: u64,
) -> Result<PreparedBranch, String> {
    branch_before_user_matching(session_dir, session_id, cwd, old_text, started_at, completed_at, false)
}

pub fn branch_before_planner_user(
    session_dir: &Path, session_id: &str, cwd: &Path, old_text: &str,
) -> Result<PreparedBranch, String> {
    branch_before_user_matching(session_dir, session_id, cwd, old_text, 0, u64::MAX, true)
}

fn branch_before_user_matching(
    session_dir: &Path, session_id: &str, cwd: &Path,
    old_text: &str, started_at: u64, completed_at: u64, planner: bool,
) -> Result<PreparedBranch, String> {
    Uuid::parse_str(session_id).map_err(|_| "Invalid Pi session identity")?;
    let suffix = format!("_{session_id}.jsonl");
    let files: Vec<_> = fs::read_dir(session_dir).map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(&suffix) && entry.path().is_file())
        .collect();
    if files.len() != 1 { return Err("Expected exactly one persisted Pi session for this execution".into()); }
    let path = files[0].path();
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if !contents.ends_with('\n') { return Err("Pi session has an incomplete last entry".into()); }
    let values: Vec<Value> = contents.lines().map(|line| serde_json::from_str(line)
        .map_err(|_| "Invalid Pi session entry".to_string())).collect::<Result<_, _>>()?;
    let header = values.first().ok_or("Empty Pi session")?;
    let actual_cwd = header.get("cwd").and_then(Value::as_str).map(Path::new);
    let cwd_matches = actual_cwd.is_some_and(|actual| {
        let actual = crate::native::host_path(actual);
        let expected = crate::native::host_path(cwd);
        actual == expected || actual.canonicalize().ok().zip(expected.canonicalize().ok()).is_some_and(|(a, b)| a == b)
    });
    if header.get("type").and_then(Value::as_str) != Some("session")
        || header.get("id").and_then(Value::as_str) != Some(session_id)
        || !cwd_matches
    { return Err("Pi session belongs to another workspace or execution".into()); }
    let entries: HashMap<&str, &Value> = values.iter().skip(1).map(|entry| {
        entry.get("id").and_then(Value::as_str).map(|id| (id, entry))
            .ok_or("Pi session entry has no identity".to_string())
    }).collect::<Result<_, _>>()?;
    let leaf = values.last().and_then(|entry| entry.get("id")).and_then(Value::as_str)
        .ok_or("Pi session has no conversation")?;
    let mut active_ids = HashSet::new();
    let mut cursor = Some(leaf);
    while let Some(id) = cursor {
        if !active_ids.insert(id) { return Err("Pi session contains a cycle".into()); }
        let entry = entries.get(id).ok_or("Pi session contains a missing parent")?;
        cursor = entry.get("parentId").and_then(Value::as_str);
    }

    // /tree can select a node from an abandoned branch, so search the whole
    // durable tree instead of following only the current leaf's parent chain.
    let mut matches = Vec::new();
    for entry in values.iter().skip(1) {
        let content = user_text(entry);
        let matches_text = content.as_deref().is_some_and(|text| text == old_text ||
            (!planner && text.strip_suffix(crate::engine::FEEDBACK_INSTRUCTIONS) == Some(old_text)) ||
            (planner && text.ends_with(&format!("\n{old_text}")) &&
                (text.starts_with("Current graph node status:\n") || text.starts_with("User query:\n"))));
        if !matches_text { continue; }
        let time = entry.get("message").and_then(|message| message.get("timestamp"))
            .and_then(Value::as_u64).unwrap_or(0);
        if time < started_at || time > completed_at { continue; }
        let id = entry.get("id").and_then(Value::as_str).ok_or("Pi session entry has no identity")?;
        let parent = entry.get("parentId").and_then(Value::as_str).map(str::to_owned);
        matches.push((id, parent, active_ids.contains(id)));
    }
    let candidate = match matches.as_slice() {
        [] => return Err("Cannot locate that user turn in the Pi conversation tree".into()),
        [single] => single,
        many => {
            let active: Vec<_> = many.iter().filter(|(_, _, active)| *active).collect();
            if active.len() == 1 { active[0] }
            else { return Err("Multiple identical user turns match this Pi conversation".into()); }
        }
    };
    let parent = candidate.1.clone();
    // Pi loads the last entry as the active leaf. A context-free custom entry
    // rooted at the previous parent selects a new branch without injecting an
    // abandoned summary into the model's next prompt.
    let marker = json!({
        "type": "custom", "id": Uuid::new_v4().to_string(), "parentId": parent,
        "timestamp": values.last().and_then(|v| v.get("timestamp")).and_then(Value::as_str)
            .unwrap_or("2025-01-01T00:00:00.000Z"),
        "customType": "grapher-edit", "data": {"fromId": leaf},
    });
    let old_len = contents.len() as u64;
    let mut file = OpenOptions::new().append(true).open(&path).map_err(|error| error.to_string())?;
    let branch = PreparedBranch { path, old_len };
    if let Err(error) = file.write_all(format!("{marker}\n").as_bytes()).and_then(|()| file.sync_data()) {
        drop(file);
        return Err(match branch.rollback() {
            Ok(()) => error.to_string(),
            Err(rollback) => format!("{error}; {rollback}"),
        });
    }
    Ok(branch)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_transfer_forks_only_the_owners_history_and_preserves_original_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("owner");
        let new = temp.path().join("review");
        let source = temp.path().join("source-session");
        let target = temp.path().join("target-session");
        for path in [&old, &new, &source] { fs::create_dir(path).unwrap(); }
        let id = Uuid::new_v4().to_string();
        let next = Uuid::new_v4().to_string();
        let body = "{\"type\":\"message\",\"id\":\"turn\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"OWNER HISTORY\"}}\n";
        let bytes = format!("{}\n{body}", json!({"type":"session", "version":3, "id":id, "cwd":old}));
        let path = source.join(format!("test_{id}.jsonl"));
        fs::write(&path, &bytes).unwrap();
        fork_session(&source, &id, &old, &target, &next, &new).unwrap();
        let result = fs::read_to_string(target.join(format!("grapher_{next}.jsonl"))).unwrap();
        let (header, preserved) = result.split_once('\n').unwrap();
        let header: Value = serde_json::from_str(header).unwrap();
        assert_eq!(header["id"], next);
        assert_eq!(header["cwd"], json!(crate::native::host_path(&new)));
        assert_eq!(header["parentSession"], json!(crate::native::host_path(&path)));
        assert_eq!(preserved, body);
        assert_eq!(fs::read_to_string(path).unwrap(), bytes);
        assert!(fork_session(&source, &id, &new, &target, &Uuid::new_v4().to_string(), &old).is_err());
    }

    #[test]
    fn feedback_source_history_edits_match_the_original_task_without_protocol_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let path = dir.path().join(format!("test_{id}.jsonl"));
        fs::write(&path, [
            json!({"type":"session", "id":id, "cwd":dir.path()}),
            json!({"type":"message", "id":"task", "parentId":null,
                "message":{"role":"user", "content":format!("Review code{}", crate::engine::FEEDBACK_INSTRUCTIONS), "timestamp":1}}),
        ].iter().map(|entry| format!("{entry}\n")).collect::<String>()).unwrap();
        let branch = branch_before_user(dir.path(), &id, dir.path(), "Review code", 0, 2).unwrap();
        let marker: Value = serde_json::from_str(fs::read_to_string(&path).unwrap().lines().last().unwrap()).unwrap();
        assert_eq!(marker["parentId"], Value::Null);
        branch.rollback().unwrap();
    }

    #[test]
    fn planner_turn_with_dynamic_status_can_branch_without_matching_a_node_turn() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let path = dir.path().join(format!("test_{id}.jsonl"));
        fs::write(&path, [
            json!({"type":"session", "id":id, "cwd":dir.path()}),
            json!({"type":"message", "id":"root", "parentId":null,
                "message":{"role":"user", "content":"original", "timestamp":1}}),
            json!({"type":"message", "id":"next", "parentId":"root",
                "message":{"role":"user", "content":"Current graph node status:\n- task: done\n\nlater", "timestamp":2}}),
        ].iter().map(|entry| format!("{entry}\n")).collect::<String>()).unwrap();
        let branch = branch_before_planner_user(dir.path(), &id, dir.path(), "later").unwrap();
        let value: Value = serde_json::from_str(fs::read_to_string(&path).unwrap().lines().last().unwrap()).unwrap();
        assert_eq!(value["parentId"], "root");
        branch.rollback().unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 3);
    }

    #[test]
    fn editing_a_turn_from_an_abandoned_tree_branch_keeps_the_old_path() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let path = dir.path().join(format!("test_{id}.jsonl"));
        let entries = [
            json!({"type":"session","id":id,"cwd":dir.path()}),
            json!({"type":"message","id":"root","parentId":null,"message":{"role":"system","content":"system"}}),
            json!({"type":"message","id":"target","parentId":"root","message":{"role":"user","content":"edit me","timestamp":100}}),
            json!({"type":"message","id":"old-answer","parentId":"target","message":{"role":"assistant","content":[]}}),
            json!({"type":"custom","id":"branch","parentId":"root","customType":"grapher-edit"}),
            json!({"type":"message","id":"new-target","parentId":"branch","message":{"role":"user","content":"replacement","timestamp":300}}),
        ];
        fs::write(&path, entries.iter().map(|entry| format!("{entry}\n")).collect::<String>()).unwrap();
        let branch = branch_before_user(dir.path(), &id, dir.path(), "edit me", 90, 150).unwrap();
        let marker: Value = serde_json::from_str(fs::read_to_string(&path).unwrap().lines().last().unwrap()).unwrap();
        assert_eq!(marker["parentId"], "root");
        branch.rollback().unwrap();
    }
    #[test]
    fn editing_a_turn_branches_without_deleting_the_abandoned_path() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let path = dir.path().join(format!("test_{id}.jsonl"));
        let entries = [
            json!({"type":"session","id":id,"cwd":dir.path()}),
            json!({"type":"message","id":"root","parentId":null,"message":{"role":"system","content":"system"}}),
            json!({"type":"message","id":"a","parentId":"root","message":{"role":"user","content":"first","timestamp":100}}),
            json!({"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":[]}}),
            json!({"type":"message","id":"c","parentId":"b","message":{"role":"user","content":"edit me","timestamp":200}}),
            json!({"type":"message","id":"d","parentId":"c","message":{"role":"assistant","content":[]}}),
            json!({"type":"message","id":"e","parentId":"d","message":{"role":"user","content":"later","timestamp":300}}),
        ];
        fs::write(&path, entries.iter().map(|entry| format!("{entry}\n")).collect::<String>()).unwrap();
        assert!(branch_before_user(dir.path(), &id, dir.path(), "edit me", 300, 400).is_err());
        let branch = branch_before_user(dir.path(), &id, dir.path(), "edit me", 180, 240).unwrap();
        let data = fs::read_to_string(&path).unwrap();
        let marker: Value = serde_json::from_str(data.lines().last().unwrap()).unwrap();
        assert_eq!(marker["parentId"], "b");
        assert!(data.contains("\"id\":\"e\""));
        branch.rollback().unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), entries.len());
    }
}
