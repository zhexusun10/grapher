//! Finish a stopped host snapshot, never a partially prepared checkout.
use super::*;

/// The caller holds the slot's Git lease and has proved its current physical
/// owner, Prepared evidence and absence of writers. No project files, HEAD,
/// index or existing immutable record are changed here.
pub(crate) fn recover_snapshot_readiness(
    path: &Path,
    source: &Path,
    expected: &str,
    exclusions: &[String],
) -> Result<(), String> {
    let previous = read_ready(path, source)?;
    let head = workspace::git(path, &["rev-parse", "HEAD"])?;
    if previous == head {
        return validate_git_bindings(path);
    }
    // A missing/cleared or malformed gate is not evidence of a previously
    // completed preparation. In particular, do not adopt a half-checkout.
    if !matches!(previous.len(), 40 | 64) || !previous.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Missing valid previous complete-view gate; refusing snapshot recovery".into());
    }
    workspace::verify_prepared_ancestor(path, expected)?;
    workspace::verify_prepared_ancestor(path, &previous)?;
    validate_git_bindings(path)?;
    if workspace::git(path, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok() {
        return Err("Unfinished graph merge cannot recover a snapshot gate".into());
    }
    let (view, _) = node_view(path, source, exclusions)?
        .ok_or("Missing current project view for snapshot recovery")?;
    let identity = node_view_identity(&view)?;
    let target = record_path(source, &head)?;
    match fs::symlink_metadata(&target) {
        Ok(_) => {
            // Load validates both checksum and schema. Never overwrite corrupt
            // or incomplete evidence with a fresh observation of live files.
            if !record_matches(source, &head, &identity)? {
                return Err("Current workspace differs from its immutable snapshot view".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A host snapshot binds the complete staged view in its commit.
            // This permits finishing capture after commit/import stopped, but
            // not adopting an arbitrary descendant commit or newer dirty work.
            let message = workspace::git(path, &["show", "-s", "--format=%B", &head])?;
            if message != format!("snapshot\n\nworkspace-view:{identity}") {
                return Err(
                    "No matching complete snapshot evidence for the current workspace".into(),
                );
            }
        }
        Err(error) => return Err(error.to_string()),
    }
    verify_snapshot_tree(path, &head, &view)?;
    // Reinspect before capture, then publish the gate only after the complete
    // view is durable. Repeating recovery reuses evidence instead of rewriting
    // history or creating a new commit.
    capture_node_scoped(path, source, &head, exclusions, Some(&identity))?;
    validate_ready(path, source)
}

fn verify_snapshot_tree(path: &Path, head: &str, view: &View) -> Result<(), String> {
    let tree = workspace::git(path, &["ls-tree", "-r", "-z", head])?;
    let mut remaining: std::collections::BTreeSet<_> = view
        .entries
        .iter()
        .filter(|(_, entry)| matches!(entry, Entry::File { .. } | Entry::Link { .. }))
        .map(|(name, _)| name.as_str())
        .collect();
    for item in tree.split('\0').filter(|item| !item.is_empty()) {
        let (header, name) = item.split_once('\t').ok_or("Invalid snapshot tree entry")?;
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() != 3 || fields[1] != "blob" || !remaining.remove(name) {
            return Err("Snapshot tree does not match the complete project view".into());
        }
        let blob = if fields[2].len() == 40 {
            fields[2].to_string()
        } else {
            // Views use SHA-1 content identities even for SHA-256 graph Git.
            let bytes = workspace::git_bytes(path, &["cat-file", "blob", fields[2]], None, None)?;
            git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
                .map_err(|e| e.to_string())?
                .to_string()
        };
        let matches = match view.entries.get(name) {
            Some(Entry::File {
                mode,
                blob: expected,
                ..
            }) => {
                matches!(fields[0], "100644" | "100755")
                    && *expected == blob
                    && (!cfg!(unix) || (mode & 0o111 != 0) == (fields[0] == "100755"))
            }
            Some(Entry::Link { target, .. }) => {
                fields[0] == "120000"
                    && git2::Oid::hash_object(git2::ObjectType::Blob, target.value.as_bytes())
                        .map_err(|e| e.to_string())?
                        .to_string()
                        == blob
            }
            _ => false,
        };
        if !matches {
            return Err(format!(
                "Snapshot tree differs from the complete project view at {name:?}"
            ));
        }
    }
    if !remaining.is_empty() {
        return Err("Snapshot tree omits current project files".into());
    }
    Ok(())
}
