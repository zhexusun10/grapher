//! A Prepared workspace or a copied session is not proof that Pi read a turn.
//! Pin the session's append boundary before launch, then reconcile delivery from
//! Pi's durable user entry. This also covers a crash before output was flushed.
use super::*;
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};

#[derive(serde::Serialize, serde::Deserialize)]
struct InputBoundary {
    execution_id: String,
    session_execution_id: String,
    session_id: String,
    cursor: u64,
    /// Absent on older boundaries, which retain their conservative text check.
    #[serde(default)]
    delivery_marker: Option<String>,
}

fn session_path(
    root: &Path,
    execution_id: &str,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    Uuid::parse_str(execution_id).map_err(|_| "Invalid feedback session execution ID")?;
    Uuid::parse_str(session_id).map_err(|_| "Invalid feedback session ID")?;
    let entries = match fs::read_dir(root.join("sessions").join(execution_id)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read feedback session: {error}")),
    };
    let suffix = format!("_{session_id}.jsonl");
    let mut found = None;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name().to_string_lossy().ends_with(&suffix) {
            if found.is_some() || !entry.path().is_file() {
                return Err("Feedback session is missing or ambiguous".into());
            }
            found = Some(entry.path());
        }
    }
    Ok(found)
}

fn receipt_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(id).map_err(|_| "Invalid feedback delivery ID")?;
    Ok(root.join("sessions").join(id).join("feedback-input.json"))
}

pub(in crate::runtime) fn record_feedback_input(root: &Path, job: &Job) -> Result<(), String> {
    let Some(id) = &job.feedback_delivery_id else {
        return Ok(());
    };
    let path = receipt_path(root, id)?;
    if path.exists() {
        return Err(
            "Feedback input boundary already exists; refusing to overwrite delivery evidence"
                .into(),
        );
    }
    let origin = job
        .resume_execution_id
        .as_deref()
        .unwrap_or(&job.execution.id);
    let session = session_path(root, origin, &job.execution.session_id)?;
    if session.is_some() {
        // execute() performs the same cwd normalization. Do it before pinning
        // bytes so a spelling-only header rewrite cannot move our boundary.
        let directory = root.join("sessions").join(origin);
        crate::session_branch::validate_session(
            &directory,
            &job.execution.session_id,
            Path::new(&job.execution.worktree),
        )?;
        crate::session_branch::rebind_session_cwd(
            &directory,
            &job.execution.session_id,
            Path::new(&job.execution.worktree),
        )?;
    }
    let cursor = session
        .as_ref()
        .map(|path| fs::metadata(path).map(|info| info.len()))
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or(0);
    if cursor > 0 {
        let mut file =
            fs::File::open(session.as_ref().unwrap()).map_err(|error| error.to_string())?;
        file.seek(SeekFrom::End(-1))
            .map_err(|error| error.to_string())?;
        let mut last = [0];
        std::io::Read::read_exact(&mut file, &mut last).map_err(|error| error.to_string())?;
        if last != *b"\n" {
            return Err("Feedback session has an incomplete last entry".into());
        }
    }
    let boundary = InputBoundary {
        execution_id: job.execution.id.clone(),
        session_execution_id: origin.into(),
        session_id: job.execution.session_id.clone(),
        cursor,
        delivery_marker: Some(id.clone()),
    };
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("{}.pending", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut output, &boundary).map_err(|error| error.to_string())?;
        output.write_all(b"\n").map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        drop(output);
        fs::rename(&temporary, &path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn feedback_input_delivered(
    runtime: &Runtime,
    input: &FeedbackContinuation,
) -> Result<bool, String> {
    let id = input
        .delivery_id
        .as_deref()
        .ok_or("Missing feedback delivery identity")?;
    let started = runtime
        .state
        .executions
        .iter()
        .find(|execution| execution.id == id)
        .ok_or("Missing feedback delivery execution")?;
    let bytes = match fs::read(receipt_path(&runtime.root, id)?) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // No boundary means no launch, unless evidence has been lost after
            // activity. Never turn that uncertainty into a duplicate user turn.
            if runtime
                .state
                .executions
                .iter()
                .skip_while(|execution| execution.id != id)
                .any(|execution| {
                    execution.node == started.node
                        && execution.session_id == started.session_id
                        && (execution.status == "completed"
                            || execution.pid.is_some()
                            || execution.output_bytes > 0)
                })
            {
                return Err(
                    "Feedback delivery evidence is missing after execution activity".into(),
                );
            }
            // A saved user entry can outlive unflushed Output. If preparation
            // completed and a session exists, a missing boundary is ambiguous,
            // not proof that the model never received this turn.
            if runtime.state.events.iter().any(|event| {
                matches!(&event.kind,
                EventKind::Prepared { execution_id, .. } if execution_id == id)
            }) {
                let origin = runtime
                    .state
                    .executions
                    .iter()
                    .find(|execution| {
                        execution.node == started.node && execution.session_id == started.session_id
                    })
                    .ok_or("Missing feedback session origin")?;
                if session_path(&runtime.root, &origin.id, &started.session_id)?.is_some() {
                    return Err("Feedback delivery evidence is missing for a prepared session; refusing to guess consumption".into());
                }
            }
            return Ok(false);
        }
        Err(error) => return Err(format!("Cannot read feedback delivery evidence: {error}")),
    };
    let boundary: InputBoundary = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid feedback delivery evidence: {error}"))?;
    if boundary.execution_id != id || boundary.session_id != started.session_id
        || boundary.delivery_marker.as_deref().is_some_and(|marker| marker != id) {
        return Err("Feedback delivery evidence belongs to another execution".into());
    }
    let origin = runtime
        .state
        .executions
        .iter()
        .find(|execution| execution.id == boundary.session_execution_id)
        .ok_or("Missing feedback session origin")?;
    if origin.node != started.node || origin.session_id != started.session_id {
        return Err("Feedback delivery evidence belongs to another conversation".into());
    }
    let Some(path) = session_path(
        &runtime.root,
        &boundary.session_execution_id,
        &boundary.session_id,
    )?
    else {
        if boundary.cursor == 0 && started.pid.is_none() && started.output_bytes == 0 {
            return Ok(false);
        }
        return Err(
            "Feedback session is missing; refusing to guess whether its turn was delivered".into(),
        );
    };
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() < boundary.cursor {
        return Err("Feedback session was truncated before its delivery boundary".into());
    }
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    let header: serde_json::Value =
        serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if header["type"] != "session" || header["id"] != boundary.session_id {
        return Err("Feedback session belongs to another identity".into());
    }
    reader
        .seek(SeekFrom::Start(boundary.cursor))
        .map_err(|error| error.to_string())?;
    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?
            == 0
        {
            return Ok(false);
        }
        if !line.ends_with('\n') {
            return Err("Incomplete feedback delivery entry".into());
        }
        let entry: serde_json::Value = serde_json::from_str(&line)
            .map_err(|error| format!("Incomplete feedback delivery entry: {error}"))?;
        if entry["type"] != "message" {
            continue;
        }
        if matches!(
            entry["message"]["role"].as_str(),
            Some("assistant" | "toolResult")
        ) {
            return Err(
                "Feedback turn has activity without a recorded user input; refusing to resend"
                    .into(),
            );
        }
        if entry["message"]["role"] != "user" {
            continue;
        }
        let content = &entry["message"]["content"];
        let text = content.as_str().map(str::to_owned).or_else(|| {
            content.as_array().map(|parts| {
                parts
                    .iter()
                    .filter(|part| part["type"] == "text")
                    .filter_map(|part| part["text"].as_str())
                    .collect::<String>()
            })
        });
        let delivered = match boundary.delivery_marker.as_deref() {
            // Pi may resize/convert attachments and append hints to the stored
            // user text. Correlate the turn itself, not its pre-normalized text.
            Some(marker) => text.as_deref().is_some_and(|text| {
                engine::feedback_input::identifies(text, marker)
            }),
            None => text.as_deref() == input.instruction.as_deref(),
        };
        if delivered {
            return Ok(true);
        }
        return Err("Feedback input differs from the recorded turn; refusing to resend an ambiguous message".into());
    }
}
