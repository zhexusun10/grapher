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
    if header.get("type").and_then(Value::as_str) != Some("session")
        || header.get("id").and_then(Value::as_str) != Some(session_id)
        || header.get("cwd").and_then(Value::as_str).and_then(|s| Path::new(s).canonicalize().ok())
            != Some(cwd.canonicalize().map_err(|error| error.to_string())?)
    { return Err("Pi session belongs to another workspace or execution".into()); }
    let entries: HashMap<&str, &Value> = values.iter().skip(1).map(|entry| {
        entry.get("id").and_then(Value::as_str).map(|id| (id, entry))
            .ok_or("Pi session entry has no identity".to_string())
    }).collect::<Result<_, _>>()?;
    let leaf = values.last().and_then(|entry| entry.get("id")).and_then(Value::as_str)
        .ok_or("Pi session has no conversation")?;
    let mut cursor = Some(leaf);
    let mut visited = HashSet::new();
    let mut parent = None;
    while let Some(id) = cursor {
        if !visited.insert(id) { return Err("Pi session contains a cycle".into()); }
        let entry = entries.get(id).ok_or("Pi session contains a missing parent")?;
        let content = user_text(entry);
        let matches = content.as_deref().is_some_and(|text| text == old_text ||
            (planner && text.ends_with(&format!("\n{old_text}")) &&
                (text.starts_with("Current graph node status:\n") || text.starts_with("User query:\n"))));
        if matches {
            let time = entry.get("message").and_then(|message| message.get("timestamp"))
                .and_then(Value::as_u64).unwrap_or(0);
            if time >= started_at && time <= completed_at {
                if parent.is_some() {
                    return Err("Multiple identical user turns in this execution; cannot safely select one to edit".into());
                }
                parent = Some(entry.get("parentId").and_then(Value::as_str).map(str::to_owned));
            }
        }
        cursor = entry.get("parentId").and_then(Value::as_str);
    }
    let parent = parent.ok_or("Cannot locate that user turn in the active Pi conversation")?;
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
