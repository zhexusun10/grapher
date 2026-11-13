//! Explicit offline reconciliation; ordinary retry never overwrites unknown bytes.
use crate::{graph_merge, store::Store, workspace};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn repair_publication_file(args: Vec<String>) -> Result<(), String> {
    let mut args = args.into_iter();
    let run = args.next().ok_or("Specify a Run ID")?;
    uuid::Uuid::parse_str(&run).map_err(|_| "Invalid Run ID")?;
    let relative = args.next().ok_or("Specify one project-relative file")?;
    let mut apply = false;
    let mut expected = None;
    let mut sequence = None;
    let mut backup = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--apply" => apply = true,
            "--expected-blob" => expected = Some(args.next().ok_or("Missing expected blob")?),
            "--expect-sequence" => {
                sequence = Some(
                    args.next()
                        .ok_or("Missing sequence")?
                        .parse::<i64>()
                        .map_err(|e| e.to_string())?,
                )
            }
            "--backup" => backup = Some(PathBuf::from(args.next().ok_or("Missing backup path")?)),
            _ => return Err(format!("Unknown repair argument: {arg}")),
        }
    }
    let root = workspace::data_root()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let _lease = crate::runtime_lock::acquire(&root)?;
    crate::native::check_retired_leases(&root)?;
    let store = Store::open_reader(&root.join("events.sqlite"))?;
    let state = store.load(&run)?;
    if state.phase != "publication_failed"
        || !state.paused
        || state
            .executions
            .iter()
            .chain(&state.mergers)
            .any(|e| e.status == "running")
        || state
            .result_execution
            .as_ref()
            .is_some_and(|e| e.status == "running")
        || state
            .planning
            .as_ref()
            .is_some_and(|p| p.status.as_deref() == Some("running"))
    {
        return Err(
            "Stop the backend; only a failed, paused publication with no writers can be repaired"
                .into(),
        );
    }
    let publication = state.publication.as_ref().ok_or("Missing publication")?;
    let source = Path::new(&publication.repository);
    let default = graph_merge::publication_workspace(source, &publication.heads)?;
    let run_root = PathBuf::from(workspace::normalize_workspace_display_path(
        &workspace::workspaces_parent(&root)
            .join(".grapher-worktrees")
            .join(&run),
    ));
    let directory = run_root
        .join(default.file_name().ok_or("Invalid publication path")?)
        .with_extension("publication");
    crate::path_safety::real_child_path(&run_root, &directory, false)?
        .ok_or("Missing publication journal")?;
    let attempt = fs::read_dir(&directory)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
        .max()
        .ok_or("Missing publication attempt")?;
    let journal = directory.join(format!("{attempt:08}"));
    crate::path_safety::real_child_path(&directory, &journal, false)?
        .ok_or("Missing publication attempt")?;
    let current_sequence = state
        .events
        .last()
        .ok_or("Missing event sequence")?
        .sequence;
    let report = graph_merge::repair_legacy_file(source, &journal, &relative, None)?;
    println!(
        "Run: {run}\nSequence: {current_sequence}\n{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    if !apply {
        println!("Preview only; source files and task state unchanged.");
        return Ok(());
    }
    if sequence != Some(current_sequence) {
        return Err("Run changed or --expect-sequence is missing; preview again".into());
    }
    let expected = expected.ok_or("--apply requires --expected-blob from the preview")?;
    if report["currentBlob"].as_str() != Some(expected.as_str()) {
        return Err("Current file changed; preview again".into());
    }
    let backup = super::paused_batch::prepare_backup_directory(
        &backup.ok_or("--apply requires --backup DIRECTORY")?,
        &root,
        source,
    )?;
    let report =
        graph_merge::repair_legacy_file(source, &journal, &relative, Some((&expected, &backup)))?;
    println!("{}\nFile restored from recorded result. Run remains paused; no publication or Agent started.", serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?);
    Ok(())
}
