//! Branch a settled Pi JSONL session before a previous user turn. Keep the
//! abandoned branch in the same file, as Pi's /tree does; never truncate it.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub struct PreparedBranch {
    path: PathBuf,
    old_len: u64,
    pub first_user_turn: bool,
}

impl PreparedBranch {
    pub fn rollback(self) -> Result<(), String> {
        OpenOptions::new()
            .write(true)
            .open(&self.path)
            .and_then(|file| file.set_len(self.old_len))
            .map_err(|error| format!("Cannot restore Pi session after failed edit: {error}"))
    }
}

fn validate_session_header(header: &Value, directory: &Path, id: &str) -> Result<(), String> {
    if header["type"] != "session"
        || header["id"] != id
        || header["version"] != 3
        || header["grapherFormat"] != 1
    {
        return Err("Unsupported Grapher Pi session format or identity".into());
    }
    let run = header["grapherRunId"]
        .as_str()
        .ok_or("Missing Pi session Run identity")?;
    Uuid::parse_str(run).map_err(|_| "Invalid Pi session Run identity")?;
    let parent = directory
        .parent()
        .ok_or("Missing session owner directory")?;
    match parent.file_name().and_then(|name| name.to_str()) {
        Some("planner-sessions")
            if directory.file_name().and_then(|name| name.to_str()) != Some(run) =>
        {
            return Err("Planner session belongs to another Run".into());
        }
        Some("sessions" | "mergers") => {
            let root = parent.parent().ok_or("Missing session data directory")?;
            let store = crate::store::Store::open_reader(&root.join("events.sqlite"))?;
            let execution_id = directory
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("Missing session execution identity")?;
            if store.run_for_execution(execution_id)?.as_deref() != Some(run) {
                return Err("Pi session belongs to another Run".into());
            }
        }
        _ => {}
    }
    Ok(())
}

fn session_file(
    source_dir: &Path,
    source_id: &str,
) -> Result<(PathBuf, std::io::BufReader<fs::File>, Value), String> {
    use std::io::{BufRead, BufReader, Read, Seek};
    Uuid::parse_str(source_id).map_err(|_| "Invalid source session ID")?;
    let suffix = format!("_{source_id}.jsonl");
    let files: Vec<_> = fs::read_dir(source_dir)
        .map_err(|error| format!("Cannot open node session: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_name().to_string_lossy().ends_with(&suffix) && entry.path().is_file()
        })
        .collect();
    if files.len() != 1 {
        return Err("Persisted node conversation is missing or ambiguous".into());
    }
    let source = files[0].path();
    let mut file = fs::File::open(&source).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() == 0 {
        return Err("Empty node session".into());
    }
    file.seek(std::io::SeekFrom::End(-1))
        .map_err(|error| error.to_string())?;
    let mut last = [0];
    file.read_exact(&mut last)
        .map_err(|error| error.to_string())?;
    if last != *b"\n" {
        return Err("Node session has an incomplete last entry".into());
    }
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut first = String::new();
    reader
        .read_line(&mut first)
        .map_err(|error| error.to_string())?;
    let header: Value = serde_json::from_str(&first).map_err(|error| error.to_string())?;
    validate_session_header(&header, source_dir, source_id)?;
    Ok((source, reader, header))
}

#[cfg(any(test, not(feature = "fixture")))]
pub(crate) fn validate_session_format(directory: &Path, id: &str) -> Result<(), String> {
    session_file(directory, id).map(|_| ())
}

fn open_session(
    source_dir: &Path,
    source_id: &str,
    source_cwd: &Path,
) -> Result<(PathBuf, std::io::BufReader<fs::File>, Value), String> {
    let (source, reader, header) = session_file(source_dir, source_id)?;
    let expected =
        crate::path_identity::actual_path(source_cwd).unwrap_or_else(|_| source_cwd.to_path_buf());
    let matches_cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .is_some_and(|cwd| crate::path_identity::same_path(Path::new(cwd), &expected));
    if !matches_cwd {
        return Err("Node session history belongs to another workspace or identity".into());
    }
    Ok((source, reader, header))
}

/// The spelling Pi will report from `process.cwd()`. Windows preserves the
/// launched spelling (including 8.3 aliases), while Unix resolves symlinks and
/// reports the filesystem spelling.
pub(crate) fn session_cwd(cwd: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        Ok(crate::native::host_path(cwd))
    }
    #[cfg(not(windows))]
    {
        Ok(crate::native::host_path(
            &crate::path_identity::actual_path(cwd)?,
        ))
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn validate_session(directory: &Path, id: &str, cwd: &Path) -> Result<(), String> {
    open_session(directory, id, cwd).map(|_| ())
}

fn rewrite_session_header(
    path: &Path,
    mut input: std::io::BufReader<fs::File>,
    mut header: Value,
    actual: &Path,
) -> Result<(), String> {
    header["cwd"] = json!(actual);
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut output, &header).map_err(|error| error.to_string())?;
        output.write_all(b"\n").map_err(|error| error.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        drop(output);
        drop(input);
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Pi resumes a custom session directory by comparing the literal header cwd
/// with the child's actual `process.cwd()`. Rewrite only the first JSON line
/// when the workspace resolves to a different case/Unicode spelling.
pub(crate) fn rebind_session_cwd(directory: &Path, id: &str, cwd: &Path) -> Result<(), String> {
    let (path, input, header) = session_file(directory, id)?;
    let actual = session_cwd(cwd)?;
    let current = header.get("cwd").and_then(Value::as_str);
    if current.is_some_and(|current| current == actual.to_string_lossy().as_ref()) {
        return Ok(());
    }
    rewrite_session_header(&path, input, header, &actual)
}

/// Rebind a current Run's session after validating format, identity and tail.
pub(crate) fn rebind_session_cwd_by_header(
    directory: &Path,
    id: &str,
    cwd: &Path,
) -> Result<(), String> {
    if !directory.is_dir() {
        return Ok(());
    }
    let has_session = fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .any(|entry| {
            entry.is_ok_and(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
        });
    if !has_session {
        return Ok(());
    }
    rebind_session_cwd(directory, id, cwd)
}

/// Move a node's own conversation to a new cwd without rewriting the original
/// history or loading its transcript into memory. Pi discovers this new binding
/// by its new session ID and cwd; parentSession keeps the lineage inspectable.
pub fn fork_session(
    source_dir: &Path,
    source_id: &str,
    source_cwd: &Path,
    target_dir: &Path,
    target_id: &str,
    target_cwd: &Path,
) -> Result<(), String> {
    Uuid::parse_str(target_id).map_err(|_| "Invalid target session ID")?;
    if target_id == source_id {
        return Err("A forked node session needs a new identity".into());
    }
    let (source, mut reader, mut header) = open_session(source_dir, source_id, source_cwd)?;
    header["id"] = json!(target_id);
    header["cwd"] = json!(session_cwd(target_cwd)?);
    header["parentSession"] = json!(crate::native::host_path(&source));
    fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;
    let target = target_dir.join(format!("grapher_{target_id}.jsonl"));
    if target.exists() {
        return Err("Cannot overwrite an existing forked node session".into());
    }
    let temporary = target_dir.join(format!("fork-{}.pending", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
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
    if let Some(text) = content.as_str() {
        return Some(crate::engine::feedback_input::strip(text));
    }
    content
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    (part.get("type")?.as_str()? == "text")
                        .then(|| part.get("text")?.as_str())
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .map(|text| crate::engine::feedback_input::strip(&text))
}

pub fn branch_before_user(
    session_dir: &Path,
    session_id: &str,
    cwd: &Path,
    old_text: &str,
    started_at: u64,
    completed_at: u64,
) -> Result<PreparedBranch, String> {
    prepare_user_branch(
        session_dir,
        session_id,
        cwd,
        old_text,
        started_at,
        completed_at,
        false,
        None,
    )?
    .commit()
}

fn without_planner_steer_marker(text: &str) -> &str {
    let Some((prefix, tail)) = text.rsplit_once("\n\n<grapher-steer-id>") else {
        return text;
    };
    let Some(id) = tail.strip_suffix("</grapher-steer-id>") else {
        return text;
    };
    if Uuid::parse_str(id).is_ok() {
        prefix
    } else {
        text
    }
}

fn without_image_dimension_hints(mut text: &str) -> &str {
    loop {
        let Some((prefix, hint)) = text.rsplit_once("[Image: original ") else {
            return text;
        };
        if !hint.ends_with(']') {
            return text;
        }
        let inner = &hint[..hint.len() - 1];
        let Some((orig, rest)) = inner.split_once(", displayed at ") else {
            return text;
        };
        let is_dims = |dims: &str| {
            dims.split_once('x').is_some_and(|(w, h)| {
                !w.is_empty()
                    && !h.is_empty()
                    && w.bytes().all(|b| b.is_ascii_digit())
                    && h.bytes().all(|b| b.is_ascii_digit())
            })
        };
        let valid_rest = rest
            .strip_suffix('.')
            .map(is_dims)
            .or_else(|| {
                rest.strip_suffix(" to map to original image.")
                    .and_then(|value| value.split_once(". Multiply coordinates by "))
                    .map(|(dims, scale)| {
                        is_dims(dims)
                            && !scale.is_empty()
                            && scale.bytes().all(|b| b.is_ascii_digit() || b == b'.')
                    })
            })
            .unwrap_or(false);
        if !is_dims(orig) || !valid_rest {
            return text;
        }
        let Some(trimmed) = prefix
            .strip_suffix("\r\n\r\n")
            .or_else(|| prefix.strip_suffix("\n\n"))
            .or_else(|| prefix.strip_suffix("\r\n"))
            .or_else(|| prefix.strip_suffix('\n'))
        else {
            return text;
        };
        text = trimmed;
    }
}

pub fn branch_before_planner_user(
    session_dir: &Path,
    session_id: &str,
    cwd: &Path,
    old_text: &str,
) -> Result<PreparedBranch, String> {
    prepare_user_branch(
        session_dir,
        session_id,
        cwd,
        old_text,
        0,
        u64::MAX,
        true,
        None,
    )?
    .commit()
}

/// The absolute execution-log cursor identifies a row even when its text is
/// repeated or only a tail of the transcript is mounted in the browser.
pub struct OutputUserTurn {
    occurrence: usize,
    total_occurrences: usize,
    timestamp: Option<u64>,
    entry_id: Option<String>,
}

fn output_user_turns(output: &str, old_text: &str) -> Vec<(usize, Option<u64>, Option<String>)> {
    let normalized = |text: &str| text.trim().to_string();
    let expected = normalized(old_text);
    let mut cursor = 0;
    let mut turns = Vec::new();
    let mut pending_start = false;
    for line in output.split_inclusive('\n') {
        let at = cursor;
        cursor += line.len();
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = event["type"].as_str().unwrap_or_default();
        if !matches!(kind, "message_start" | "message_end" | "message")
            || event["message"]["role"] != "user"
        {
            continue;
        }
        if kind == "message_end" && pending_start {
            pending_start = false;
            continue;
        }
        pending_start = kind == "message_start";
        let mut wrapped = event.clone();
        wrapped["type"] = json!("message");
        let text = user_text(&wrapped).unwrap_or_default();
        if normalized(&text) != expected && normalized(without_image_dimension_hints(&text)) != expected {
            continue;
        }
        let id = if kind == "message" {
            event["id"].as_str()
        } else {
            event["message"]["id"].as_str()
        };
        turns.push((
            at,
            event["message"]["timestamp"].as_u64(),
            id.map(str::to_owned),
        ));
    }
    turns
}

pub fn unique_output_user_turn_offset(output: &str, old_text: &str) -> Option<usize> {
    let turns = output_user_turns(output, old_text);
    (turns.len() == 1).then(|| turns[0].0)
}

/// Truncate a live in-memory transcript to a byte cursor, never splitting a
/// UTF-8 scalar. `None` keeps the whole output.
pub fn truncate_output(output: &str, end: Option<usize>) -> String {
    match end {
        Some(end) if end < output.len() => {
            let mut boundary = end;
            while boundary > 0 && !output.is_char_boundary(boundary) {
                boundary -= 1;
            }
            output[..boundary].to_string()
        }
        _ => output.to_string(),
    }
}

pub fn output_user_turn(
    output: &str,
    offset: usize,
    old_text: &str,
) -> Result<OutputUserTurn, String> {
    let turns = output_user_turns(output, old_text);
    let total_occurrences = turns.len();
    turns
        .into_iter()
        .enumerate()
        .find(|(_, (at, _, _))| *at == offset)
        .map(|(occurrence, (_, timestamp, entry_id))| OutputUserTurn {
            occurrence,
            total_occurrences,
            timestamp,
            entry_id,
        })
        .ok_or_else(|| "The selected output row is not that user turn".into())
}

/// Read-only validation happens before stopping a writer. Only commit mutates
/// the session, and it rechecks membership after the writer has stopped.
pub struct UserBranch {
    path: PathBuf,
    validated_len: usize,
    validated_hash: git2::Oid,
    selected_id: String,
    parent: Option<String>,
    pub first_user_turn: bool,
    pub first_in_execution: bool,
    require_active: bool,
}

pub fn prepare_node_user_branch(
    session_dir: &Path,
    session_id: &str,
    cwd: &Path,
    old_text: &str,
    started_at: u64,
    completed_at: u64,
    selector: Option<&OutputUserTurn>,
) -> Result<UserBranch, String> {
    prepare_user_branch(
        session_dir,
        session_id,
        cwd,
        old_text,
        started_at,
        completed_at,
        false,
        selector,
    )
}

fn session_entries(values: &[Value]) -> Result<HashMap<&str, &Value>, String> {
    let mut entries = HashMap::new();
    for entry in values.iter().skip(1) {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("Pi session entry has no identity")?;
        if entries.insert(id, entry).is_some() {
            return Err("Pi session contains duplicate entry identities".into());
        }
    }
    Ok(entries)
}

#[allow(clippy::too_many_arguments)]
fn prepare_user_branch(
    session_dir: &Path,
    session_id: &str,
    cwd: &Path,
    old_text: &str,
    started_at: u64,
    completed_at: u64,
    planner: bool,
    selector: Option<&OutputUserTurn>,
) -> Result<UserBranch, String> {
    Uuid::parse_str(session_id).map_err(|_| "Invalid Pi session identity")?;
    let suffix = format!("_{session_id}.jsonl");
    let files: Vec<_> = fs::read_dir(session_dir)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_name().to_string_lossy().ends_with(&suffix) && entry.path().is_file()
        })
        .collect();
    if files.len() != 1 {
        return Err("Expected exactly one persisted Pi session for this execution".into());
    }
    let path = files[0].path();
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if !contents.ends_with('\n') {
        return Err("Pi session has an incomplete last entry".into());
    }
    let values: Vec<Value> = contents
        .lines()
        .map(|line| serde_json::from_str(line).map_err(|_| "Invalid Pi session entry".to_string()))
        .collect::<Result<_, _>>()?;
    let header = values.first().ok_or("Empty Pi session")?;
    let actual_cwd = header.get("cwd").and_then(Value::as_str).map(Path::new);
    let cwd_matches = actual_cwd.is_some_and(|actual| crate::path_identity::same_path(actual, cwd));
    if header.get("type").and_then(Value::as_str) != Some("session")
        || header.get("id").and_then(Value::as_str) != Some(session_id)
        || !cwd_matches
    {
        return Err("Pi session belongs to another workspace or execution".into());
    }
    let entries = session_entries(&values)?;
    let leaf = values
        .last()
        .and_then(|entry| entry.get("id"))
        .and_then(Value::as_str)
        .ok_or("Pi session has no conversation")?;
    let mut active_ids = HashSet::new();
    let mut cursor = Some(leaf);
    while let Some(id) = cursor {
        if !active_ids.insert(id) {
            return Err("Pi session contains a cycle".into());
        }
        let entry = entries
            .get(id)
            .ok_or("Pi session contains a missing parent")?;
        cursor = entry.get("parentId").and_then(Value::as_str);
    }

    // /tree can select a node from an abandoned branch, so search the whole
    // durable tree instead of following only the current leaf's parent chain.
    let mut matches = Vec::new();
    for entry in values.iter().skip(1) {
        let content = user_text(entry);
        let matches_text = content.as_deref().is_some_and(|text| {
            let text = if planner {
                without_planner_steer_marker(text)
            } else {
                text
            };
            let normalized = without_image_dimension_hints(text);
            let direct = text == old_text
                || normalized == old_text
                || (planner
                    && crate::attachment_inputs::strip_leading_managed_mentions(normalized)
                        == old_text);
            if direct {
                return true;
            }
            if planner
                && (normalized.starts_with("Current graph node status:\n")
                    || normalized.starts_with("User query:\n")
                    || normalized.starts_with("You are now at "))
            {
                if normalized.ends_with(&format!("\n{old_text}")) {
                    return true;
                }
                return normalized.match_indices('\n').any(|(idx, _)| {
                    crate::attachment_inputs::strip_leading_managed_mentions(
                        &normalized[idx + 1..],
                    ) == old_text
                });
            }
            false
        });
        if !matches_text {
            continue;
        }
        let time = entry
            .get("message")
            .and_then(|message| message.get("timestamp"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if time < started_at || time > completed_at {
            continue;
        }
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Pi session entry has no identity")?;
        let parent = entry
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        matches.push((id, parent, active_ids.contains(id)));
    }
    let candidate = if let Some(selector) = selector {
        let active: Vec<_> = matches.iter().filter(|(_, _, active)| *active).collect();
        // An explicit identity is authoritative. Falling back to time or
        // occurrence could edit an equal-text turn on a different branch.
        let by_id = selector
            .entry_id
            .as_deref()
            .map(|id| {
                active
                    .iter()
                    .copied()
                    .find(|candidate| candidate.0 == id)
                    .ok_or("The selected Pi user turn is no longer in the active branch")
            })
            .transpose()?;
        let by_time: Vec<_> = active
            .iter()
            .copied()
            .filter(|candidate| {
                selector.timestamp.is_some_and(|time| {
                    entries
                        .get(candidate.0)
                        .is_some_and(|entry| entry["message"]["timestamp"].as_u64() == Some(time))
                })
            })
            .collect();
        let candidate = if let Some(candidate) = by_id {
            candidate
        } else if by_time.len() == 1 {
            by_time[0]
        } else if active.len() == selector.total_occurrences {
            *active
                .get(selector.occurrence)
                .ok_or("The selected user turn is no longer in the active Pi branch")?
        } else {
            return Err(
                "Cannot unambiguously align this output row with the active Pi user turns".into(),
            );
        };
        let entry = entries
            .get(candidate.0)
            .ok_or("Missing selected Pi entry")?;
        if selector
            .timestamp
            .is_some_and(|time| entry["message"]["timestamp"].as_u64() != Some(time))
        {
            return Err("The output row does not match the persisted Pi user turn".into());
        }
        candidate
    } else {
        match matches.as_slice() {
            [] => return Err("Cannot locate that user turn in the Pi conversation tree".into()),
            [single] => single,
            many => {
                let active: Vec<_> = many.iter().filter(|(_, _, active)| *active).collect();
                if active.len() == 1 {
                    active[0]
                } else {
                    return Err("Multiple identical user turns match this Pi conversation".into());
                }
            }
        }
    };
    let parent = candidate.1.clone();
    // One execution can contain the opening prompt and many consumed steers.
    // Only a turn with no user ancestor may replace the node's original task.
    let mut first_user_turn = true;
    let mut cursor = parent.as_deref();
    let mut ancestors = HashSet::new();
    while let Some(id) = cursor {
        if !ancestors.insert(id) {
            return Err("Pi session contains a cycle".into());
        }
        let entry = entries
            .get(id)
            .ok_or("Pi session contains a missing parent")?;
        if user_text(entry).is_some() {
            first_user_turn = false;
            break;
        }
        cursor = entry.get("parentId").and_then(Value::as_str);
    }
    let first_in_execution = values
        .iter()
        .skip(1)
        .find(|entry| {
            let time = entry["message"]["timestamp"].as_u64().unwrap_or(0);
            user_text(entry).is_some()
                && entry["id"]
                    .as_str()
                    .is_some_and(|id| active_ids.contains(id))
                && time >= started_at
                && time <= completed_at
        })
        .is_some_and(|entry| entry["id"].as_str() == Some(candidate.0));
    Ok(UserBranch {
        path,
        validated_len: contents.len(),
        validated_hash: git2::Oid::hash_object(git2::ObjectType::Blob, contents.as_bytes())
            .map_err(|error| error.to_string())?,
        selected_id: candidate.0.into(),
        parent,
        first_user_turn,
        first_in_execution,
        require_active: selector.is_some(),
    })
}

impl UserBranch {
    pub fn commit(self) -> Result<PreparedBranch, String> {
        let contents = fs::read_to_string(&self.path).map_err(|error| error.to_string())?;
        // Stopping a live writer may append legitimate output, but must not
        // authorize a rewritten session, selected turn or ancestry. Pin only
        // the validated prefix so ordinary append-only progress remains valid.
        let prefix = contents
            .get(..self.validated_len)
            .ok_or("Pi session history changed after edit validation")?;
        if git2::Oid::hash_object(git2::ObjectType::Blob, prefix.as_bytes())
            .map_err(|error| error.to_string())?
            != self.validated_hash
        {
            return Err("Pi session history changed after edit validation".into());
        }
        if !contents.ends_with('\n') {
            return Err("Pi session has an incomplete last entry".into());
        }
        let values: Vec<Value> = contents
            .lines()
            .map(|line| {
                serde_json::from_str(line).map_err(|_| "Invalid Pi session entry".to_string())
            })
            .collect::<Result<_, _>>()?;
        let leaf = values
            .last()
            .and_then(|entry| entry["id"].as_str())
            .ok_or("Missing Pi leaf")?;
        let entries = session_entries(&values)?;
        let mut cursor = Some(leaf);
        let mut seen = HashSet::new();
        let mut found = false;
        while let Some(id) = cursor {
            if !seen.insert(id) {
                return Err("Pi session contains a cycle".into());
            }
            found |= id == self.selected_id;
            cursor = entries.get(id).ok_or("Missing Pi parent")?["parentId"].as_str();
        }
        if self.require_active && !found {
            return Err("The selected user turn is no longer active".into());
        }
        let marker = json!({
            "type": "custom", "id": Uuid::new_v4().to_string(), "parentId": self.parent,
            "timestamp": values.last().and_then(|v| v["timestamp"].as_str()).unwrap_or("2025-01-01T00:00:00.000Z"),
            "customType": "grapher-edit", "data": {"fromId": leaf},
        });
        let old_len = contents.len() as u64;
        let mut file = OpenOptions::new()
            .append(true)
            .open(&self.path)
            .map_err(|error| error.to_string())?;
        let branch = PreparedBranch {
            path: self.path,
            old_len,
            first_user_turn: self.first_user_turn,
        };
        if let Err(error) = file
            .write_all(format!("{marker}\n").as_bytes())
            .and_then(|()| file.sync_data())
        {
            drop(file);
            return Err(match branch.rollback() {
                Ok(()) => error.to_string(),
                Err(rollback) => format!("{error}; {rollback}"),
            });
        }
        Ok(branch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // All positive fixtures model sessions written by the current Pi binding.
    macro_rules! json {
        ($($value:tt)+) => {{
            let mut value = serde_json::json!($($value)+);
            if value.get("type").and_then(Value::as_str) == Some("session") {
                value["version"] = serde_json::json!(3);
                value["grapherFormat"] = serde_json::json!(1);
                value["grapherRunId"] = value["id"].clone();
            }
            value
        }};
    }

    #[test]
    fn retired_session_headers_are_rejected_before_rebind_fork_or_branch() {
        for (version, format) in [
            (None, None),
            (Some(2), Some(1)),
            (Some(3), None),
            (Some(4), Some(1)),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let id = Uuid::new_v4().to_string();
            let file = temp.path().join(format!("test_{id}.jsonl"));
            let header = serde_json::json!({"type":"session","id":id,"cwd":temp.path(),
                "version":version,"grapherFormat":format,"grapherRunId":id});
            let original = format!("{header}\n");
            fs::write(&file, &original).unwrap();
            assert!(validate_session_format(temp.path(), &id).is_err());
            assert!(rebind_session_cwd_by_header(temp.path(), &id, temp.path()).is_err());
            let target = temp.path().join("fork");
            assert!(fork_session(
                temp.path(),
                &id,
                temp.path(),
                &target,
                &Uuid::new_v4().to_string(),
                temp.path()
            )
            .is_err());
            assert!(branch_before_user(temp.path(), &id, temp.path(), "old", 0, 1).is_err());
            assert_eq!(fs::read_to_string(&file).unwrap(), original);
            assert!(!target.exists());
        }
    }

    #[test]
    fn a_foreign_run_header_is_rejected_before_planner_rebinding() {
        let temp = tempfile::tempdir().unwrap();
        let run = Uuid::new_v4().to_string();
        let directory = temp.path().join("planner-sessions").join(&run);
        fs::create_dir_all(&directory).unwrap();
        let header = serde_json::json!({"type":"session","version":3,"grapherFormat":1,
            "grapherRunId":Uuid::new_v4().to_string(),"id":run,"cwd":temp.path()});
        let original = format!("{header}\n");
        let file = directory.join(format!("test_{run}.jsonl"));
        fs::write(&file, &original).unwrap();
        assert!(rebind_session_cwd_by_header(&directory, &run, temp.path())
            .unwrap_err()
            .contains("another Run"));
        assert_eq!(fs::read_to_string(file).unwrap(), original);
    }

    #[test]
    fn planner_steer_marker_does_not_break_editing_the_recorded_turn() {
        let temp = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let steer = Uuid::new_v4().to_string();
        let path = temp.path().join(format!("test_{id}.jsonl"));
        let entries = [
            json!({"type":"session", "id":id, "cwd":temp.path()}),
            json!({"type":"message", "id":"goal", "parentId":null, "message":{"role":"user","content":"goal"}}),
            json!({"type":"message", "id":"steer", "parentId":"goal", "message":{"role":"user",
                "content":format!("inspect\n\n<grapher-steer-id>{steer}</grapher-steer-id>")}}),
        ];
        fs::write(
            &path,
            entries
                .iter()
                .map(|entry| format!("{entry}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let branch = branch_before_planner_user(temp.path(), &id, temp.path(), "inspect").unwrap();
        assert!(!branch.first_user_turn);
        let marker: Value =
            serde_json::from_str(fs::read_to_string(path).unwrap().lines().last().unwrap())
                .unwrap();
        assert_eq!(marker["parentId"], "goal");
    }

    #[test]
    fn feedback_delivery_marker_does_not_break_editing_normalized_user_turns() {
        let temp = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let delivery = Uuid::new_v4().to_string();
        let path = temp.path().join(format!("test_{id}.jsonl"));
        let hint = "\n\n[Image: original 3000x2000, displayed at 2000x1333.]";
        let marked = format!(
            "{}{hint}",
            crate::engine::feedback_input::prompt("inspect", Some(&delivery))
        );
        let entries = [
            json!({"type":"session", "id":id, "cwd":temp.path()}),
            json!({"type":"message", "id":"goal", "parentId":null, "message":{"role":"user","content":"goal","timestamp":1}}),
            json!({"type":"message", "id":"feedback", "parentId":"goal", "message":{"role":"user",
                "content":[{"type":"text","text":marked}],"timestamp":2}}),
        ];
        let original = entries
            .iter()
            .map(|entry| format!("{entry}\n"))
            .collect::<String>();
        fs::write(&path, &original).unwrap();
        let branch = branch_before_user(
            temp.path(),
            &id,
            temp.path(),
            &format!("inspect{hint}"),
            0,
            10,
        )
        .unwrap();
        assert!(!branch.first_user_turn);
        let stripped = branch_before_user(temp.path(), &id, temp.path(), "inspect", 0, 10).unwrap();
        assert!(!stripped.first_user_turn);
        assert_eq!(stripped.path, path);
        let contents = fs::read_to_string(&path).unwrap();
        assert!(
            contents.starts_with(&original),
            "branching must not rewrite receipt evidence"
        );
        let marker: Value = serde_json::from_str(contents.lines().last().unwrap()).unwrap();
        assert_eq!(marker["parentId"], "goal");
    }

    #[test]
    fn explicit_output_identity_never_falls_back_to_another_equal_user_turn() {
        for selected_id in [Some("old"), Some("missing"), None] {
            let temp = tempfile::tempdir().unwrap();
            let id = Uuid::new_v4().to_string();
            let path = temp.path().join(format!("test_{id}.jsonl"));
            let entries = [
                json!({"type":"session", "id":id, "cwd":temp.path()}),
                json!({"type":"message", "id":"root", "parentId":null, "message":{"role":"system", "content":"system"}}),
                json!({"type":"message", "id":"old", "parentId":"root", "message":{"role":"user", "content":"again", "timestamp":10}}),
                json!({"type":"custom", "id":"branch", "parentId":"root", "customType":"grapher-edit"}),
                json!({"type":"message", "id":"current", "parentId":"branch", "message":{"role":"user", "content":"again", "timestamp":10}}),
            ];
            let original = entries
                .iter()
                .map(|entry| format!("{entry}\n"))
                .collect::<String>();
            fs::write(&path, &original).unwrap();
            let mut row = json!({"type":"message_start", "message":{"role":"user", "content":"again", "timestamp":10}});
            if let Some(selected_id) = selected_id {
                row["message"]["id"] = json!(selected_id);
            }
            let selector = output_user_turn(&format!("{row}\n"), 0, "again").unwrap();
            let pending = prepare_node_user_branch(
                temp.path(),
                &id,
                temp.path(),
                "again",
                0,
                20,
                Some(&selector),
            );
            if selected_id.is_some() {
                assert!(
                    pending.is_err(),
                    "an absent or abandoned identity must not select the current equal-text turn"
                );
            } else {
                assert!(
                    pending.is_ok(),
                    "legacy rows without an ID retain unambiguous timestamp matching"
                );
            }
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
    }

    #[test]
    fn session_edit_commit_rejects_rewritten_history_but_allows_append_only_progress() {
        for change in [
            "identity",
            "workspace",
            "parent",
            "text",
            "truncate",
            "append",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let id = Uuid::new_v4().to_string();
            let path = temp.path().join(format!("test_{id}.jsonl"));
            let mut entries = vec![
                json!({"type":"session", "id":id, "cwd":temp.path()}),
                json!({"type":"message", "id":"root", "parentId":null, "message":{"role":"system", "content":"system"}}),
                json!({"type":"message", "id":"target", "parentId":"root", "message":{"role":"user", "content":"edit me", "timestamp":10}}),
            ];
            let encode = |entries: &[Value]| {
                entries
                    .iter()
                    .map(|entry| format!("{entry}\n"))
                    .collect::<String>()
            };
            fs::write(&path, encode(&entries)).unwrap();
            let pending =
                prepare_node_user_branch(temp.path(), &id, temp.path(), "edit me", 0, 20, None)
                    .unwrap();
            match change {
                "identity" => entries[0]["id"] = json!(Uuid::new_v4().to_string()),
                "workspace" => entries[0]["cwd"] = json!(temp.path().join("another-workspace")),
                "parent" => entries[2]["parentId"] = Value::Null,
                "text" => entries[2]["message"]["content"] = json!("different input"),
                "truncate" => { entries.pop(); },
                _ => entries.push(json!({"type":"message", "id":"answer", "parentId":"target", "message":{"role":"assistant", "content":[]}})),
            }
            let current = encode(&entries);
            fs::write(&path, &current).unwrap();
            let result = pending.commit();
            if change == "append" {
                let branch = result.expect("a live writer may append before it is drained");
                assert!(fs::read_to_string(&path).unwrap().starts_with(&current));
                branch.rollback().unwrap();
            } else {
                assert!(
                    result.is_err(),
                    "changed {change} must not receive a branch marker"
                );
            }
            assert_eq!(fs::read_to_string(&path).unwrap(), current);
        }
    }

    #[test]
    fn duplicate_pi_entry_ids_are_rejected_before_and_after_edit_preparation() {
        for after_prepare in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let id = Uuid::new_v4().to_string();
            let path = temp.path().join(format!("test_{id}.jsonl"));
            let history = [
                json!({"type":"session", "id":id, "cwd":temp.path()}),
                json!({"type":"message", "id":"root", "parentId":null, "message":{"role":"system", "content":"system"}}),
                json!({"type":"message", "id":"target", "parentId":"root", "message":{"role":"user", "content":"edit me", "timestamp":10}}),
            ].iter().map(|entry| format!("{entry}\n")).collect::<String>();
            fs::write(&path, &history).unwrap();
            let pending = if after_prepare {
                Some(
                    prepare_node_user_branch(temp.path(), &id, temp.path(), "edit me", 0, 20, None)
                        .unwrap(),
                )
            } else {
                None
            };
            let current = format!(
                "{history}{}\n",
                json!({"type":"message", "id":"target", "parentId":"root", "message":{"role":"assistant", "content":[]}})
            );
            fs::write(&path, &current).unwrap();
            if let Some(pending) = pending {
                assert!(
                    pending.commit().is_err(),
                    "an appended duplicate ID must not pass commit validation"
                );
            } else {
                assert!(
                    prepare_node_user_branch(temp.path(), &id, temp.path(), "edit me", 0, 20, None)
                        .is_err(),
                    "ambiguous Pi identities must fail before a writer is stopped"
                );
            }
            assert_eq!(fs::read_to_string(&path).unwrap(), current);
        }
    }

    #[test]
    fn truncating_a_live_transcript_keeps_utf8_scalars_intact() {
        let text = "a中文🚀z";
        assert_eq!(truncate_output(text, None), text);
        assert_eq!(truncate_output(text, Some(text.len())), text);
        assert_eq!(truncate_output(text, Some(1)), "a");
        assert_eq!(truncate_output(text, Some(4)), "a中");
        assert_eq!(
            truncate_output(text, Some(2)),
            "a",
            "a cursor inside a scalar floors to the previous boundary"
        );
    }

    #[test]
    fn cursor_alignment_rejects_missing_identical_rows_unless_the_pi_identity_is_known() {
        for identified in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let id = Uuid::new_v4().to_string();
            let file = temp.path().join(format!("test_{id}.jsonl"));
            let history = [
                json!({"type":"session", "id":id,"cwd":temp.path()}),
                json!({"type":"message", "id":"opening","parentId":null,"message":{"role":"user","content":"again","timestamp":10}}),
                json!({"type":"message", "id":"steer","parentId":"opening","message":{"role":"user","content":"again","timestamp":10}}),
            ].iter().map(|entry| format!("{entry}\n")).collect::<String>();
            fs::write(&file, &history).unwrap();
            let mut row = json!({"type":"message_start","message":{"role":"user","content":"again","timestamp":10}});
            if identified {
                row["message"]["id"] = json!("steer");
            }
            let selector = output_user_turn(&format!("{row}\n"), 0, "again").unwrap();
            let pending = prepare_node_user_branch(
                temp.path(),
                &id,
                temp.path(),
                "again",
                0,
                20,
                Some(&selector),
            );
            if identified {
                let pending = pending.unwrap();
                assert!(!pending.first_user_turn);
                pending.commit().unwrap();
                let marker: Value = serde_json::from_str(
                    fs::read_to_string(&file).unwrap().lines().last().unwrap(),
                )
                .unwrap();
                assert_eq!(marker["parentId"], "opening");
            } else {
                assert!(pending.is_err(), "a missing opening row must not shift an ambiguous occurrence onto the wrong turn");
                assert_eq!(fs::read_to_string(&file).unwrap(), history);
            }
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn session_header_is_rebound_to_the_filesystem_case_spelling() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("MixedCaseWorkspace");
        let sessions = temp.path().join("sessions");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&sessions).unwrap();
        let id = Uuid::new_v4().to_string();
        let path = sessions.join(format!("test_{id}.jsonl"));
        let lower = workspace.to_string_lossy().to_lowercase();
        fs::write(
            &path,
            format!("{}\n", json!({"type":"session","id":id,"cwd":lower})),
        )
        .unwrap();
        rebind_session_cwd(&sessions, &id, &workspace).unwrap();
        let first = fs::read_to_string(&path).unwrap();
        let header: Value = serde_json::from_str(first.lines().next().unwrap()).unwrap();
        assert_eq!(
            Path::new(header["cwd"].as_str().unwrap()),
            crate::path_identity::actual_path(&workspace).unwrap()
        );
        validate_session(&sessions, &id, &workspace).unwrap();
    }

    #[test]
    fn workspace_transfer_forks_only_the_owners_history_and_preserves_original_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("owner");
        let new = temp.path().join("review");
        let source = temp.path().join("source-session");
        let target = temp.path().join("target-session");
        for path in [&old, &new, &source] {
            fs::create_dir(path).unwrap();
        }
        let id = Uuid::new_v4().to_string();
        let next = Uuid::new_v4().to_string();
        let body = "{\"type\":\"message\",\"id\":\"turn\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"OWNER HISTORY\"}}\n";
        let bytes = format!(
            "{}\n{body}",
            json!({"type":"session", "version":3, "id":id, "cwd":old})
        );
        let path = source.join(format!("test_{id}.jsonl"));
        fs::write(&path, &bytes).unwrap();
        fork_session(&source, &id, &old, &target, &next, &new).unwrap();
        let result = fs::read_to_string(target.join(format!("grapher_{next}.jsonl"))).unwrap();
        let (header, preserved) = result.split_once('\n').unwrap();
        let header: Value = serde_json::from_str(header).unwrap();
        assert_eq!(header["id"], next);
        // Windows deliberately keeps the launched 8.3 spelling Pi reports from
        // process.cwd(); Unix resolves the filesystem spelling. Assert the
        // platform policy independently of the fork implementation's helper.
        #[cfg(windows)]
        let expected_cwd = crate::native::host_path(&new);
        #[cfg(not(windows))]
        let expected_cwd =
            crate::native::host_path(&crate::path_identity::actual_path(&new).unwrap());
        assert_eq!(header["cwd"], json!(expected_cwd));
        assert_eq!(
            header["parentSession"],
            json!(crate::native::host_path(&path))
        );
        assert_eq!(preserved, body);
        assert_eq!(fs::read_to_string(path).unwrap(), bytes);
        assert!(fork_session(
            &source,
            &id,
            &new,
            &target,
            &Uuid::new_v4().to_string(),
            &old
        )
        .is_err());
    }

    #[test]
    fn feedback_source_history_edits_match_the_original_task() {
        let dir = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4().to_string();
        let path = dir.path().join(format!("test_{id}.jsonl"));
        fs::write(
            &path,
            [
                json!({"type":"session", "id":id, "cwd":dir.path()}),
                json!({"type":"message", "id":"task", "parentId":null,
                "message":{"role":"user", "content":"Review code", "timestamp":1}}),
            ]
            .iter()
            .map(|entry| format!("{entry}\n"))
            .collect::<String>(),
        )
        .unwrap();
        let branch = branch_before_user(dir.path(), &id, dir.path(), "Review code", 0, 2).unwrap();
        let marker: Value =
            serde_json::from_str(fs::read_to_string(&path).unwrap().lines().last().unwrap())
                .unwrap();
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
                "message":{"role":"user", "content":"Current graph node status:\n- task: completed\n\nlater", "timestamp":2}}),
        ].iter().map(|entry| format!("{entry}\n")).collect::<String>()).unwrap();
        let branch = branch_before_planner_user(dir.path(), &id, dir.path(), "later").unwrap();
        let value: Value =
            serde_json::from_str(fs::read_to_string(&path).unwrap().lines().last().unwrap())
                .unwrap();
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
        fs::write(
            &path,
            entries
                .iter()
                .map(|entry| format!("{entry}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let branch = branch_before_user(dir.path(), &id, dir.path(), "edit me", 90, 150).unwrap();
        let marker: Value =
            serde_json::from_str(fs::read_to_string(&path).unwrap().lines().last().unwrap())
                .unwrap();
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
        fs::write(
            &path,
            entries
                .iter()
                .map(|entry| format!("{entry}\n"))
                .collect::<String>(),
        )
        .unwrap();
        assert!(branch_before_user(dir.path(), &id, dir.path(), "edit me", 300, 400).is_err());
        let branch = branch_before_user(dir.path(), &id, dir.path(), "edit me", 180, 240).unwrap();
        let data = fs::read_to_string(&path).unwrap();
        let marker: Value = serde_json::from_str(data.lines().last().unwrap()).unwrap();
        assert_eq!(marker["parentId"], "b");
        assert!(data.contains("\"id\":\"e\""));
        branch.rollback().unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap().lines().count(),
            entries.len()
        );
    }
}
