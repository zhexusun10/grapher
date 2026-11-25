//! Immutable external attachment inputs stored under Grapher's data directory.
//! Attachments are never written into the user's project directory or any
//! private Run worktree; sandboxed executions receive read-only access to the
//! Run's attachment directories instead.
use crate::{cleanup::Target, path_safety::real_child_path, store::Store};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use uuid::Uuid;

pub(crate) const BUCKET: &str = "attachment-inputs";

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !matches!(name, "." | "..")
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
}

fn ensure_directory(root: &Path, path: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Attachment path is outside its root")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("Invalid attachment child path".into());
        }
        current.push(component);
        if real_child_path(root, &current, false)?.is_none() {
            match fs::create_dir(&current) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        real_child_path(root, &current, false)?.ok_or("Attachment directory disappeared")?;
    }
    Ok(())
}

fn compare_existing(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    const CHANGED: &str = "Attachment contents changed; select the file again before sending";
    let actual = real_child_path(root, path, true)?.ok_or("Attachment disappeared")?;
    let mut file = fs::File::open(actual).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() != bytes.len() as u64 {
        return Err(CHANGED.into());
    }
    let mut buffer = [0; 8192];
    for expected in bytes.chunks(buffer.len()) {
        let actual = &mut buffer[..expected.len()];
        file.read_exact(actual).map_err(|error| error.to_string())?;
        if actual != expected {
            return Err(CHANGED.into());
        }
    }
    // Also reject growth after the metadata check, without reading it all.
    if file
        .read(&mut buffer[..1])
        .map_err(|error| error.to_string())?
        != 0
    {
        return Err(CHANGED.into());
    }
    Ok(())
}

fn immutable_file(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    if real_child_path(root, path, true)?.is_some() {
        return compare_existing(root, path, bytes);
    }
    // Publish only a complete, synced file. A failed write removes its staging
    // file, so a retry cannot mistake partial bytes for immutable evidence.
    let mut staged = tempfile::Builder::new()
        .prefix(".grapher-attachment-")
        .tempfile_in(path.parent().ok_or("Missing attachment directory")?)
        .map_err(|error| error.to_string())?;
    staged.write_all(bytes).map_err(|error| error.to_string())?;
    staged
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    match staged.persist_noclobber(path) {
        Ok(_) => Ok(()),
        // A concurrent retry may have published first. Never overwrite it.
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            compare_existing(root, path, bytes)
        }
        Err(error) => Err(error.error.to_string()),
    }
}

fn attachment_directory(root: &Path, run: Option<&str>, id: &str) -> Result<PathBuf, String> {
    let id = Uuid::parse_str(id).map_err(|_| "Invalid attachment ID")?;
    let bucket = root.join(BUCKET);
    if let Some(run) = run {
        let run = Uuid::parse_str(run).map_err(|_| "Invalid attachment Run ID")?;
        Ok(bucket.join(run.to_string()).join(id.to_string()))
    } else {
        Ok(bucket.join(id.to_string()))
    }
}

/// Format an external attachment path using host drive spellings and `/`
/// separators so it works uniformly in file tools and Bash on every platform.
pub(crate) fn display_path(path: &Path) -> String {
    crate::native::host_path(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Format an external attachment path as an `@<path>` (or `@"<path>"` when
/// containing whitespace, quotes, or backslashes) prompt mention.
pub(crate) fn format_mention(path: &Path) -> String {
    let display = display_path(path);
    if display
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '"' | '\\'))
    {
        format!("@{}", serde_json::to_string(&display).unwrap_or(display))
    } else {
        format!("@{display}")
    }
}

/// Prepend `@<path>` mentions directly ahead of `prompt` without adding extra
/// wrapper text or instructions.
pub(crate) fn prepend_mentions(paths: &[PathBuf], prompt: &str) -> String {
    if paths.is_empty() {
        return prompt.to_string();
    }
    let mentions = paths
        .iter()
        .map(|path| format_mention(path))
        .collect::<Vec<_>>()
        .join(" ");
    if prompt.trim().is_empty() {
        mentions
    } else {
        format!("{mentions} {prompt}")
    }
}

fn canonical_image_ext(mime_type: &str) -> (&'static str, &'static [&'static str]) {
    match mime_type.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => ("jpg", &["jpg", "jpeg"]),
        "image/gif" => ("gif", &["gif"]),
        "image/webp" => ("webp", &["webp"]),
        _ => ("png", &["png"]),
    }
}

/// Produce a safe filename whose extension matches the actual image MIME type
/// (for example when client-side compression converts a large PNG into JPEG).
pub(crate) fn safe_image_filename(
    image: &crate::model::ImageAttachment,
    index: usize,
) -> String {
    let (default_ext, valid_exts) = canonical_image_ext(&image.mime_type);
    if let Some(raw) = image.name.as_deref() {
        let base = raw.rsplit(['/', '\\']).next().unwrap_or_default().trim();
        if valid_name(base) {
            if let Some((stem, ext)) = base.rsplit_once('.') {
                let lower = ext.to_ascii_lowercase();
                if valid_exts.contains(&lower.as_str()) {
                    return base.to_string();
                }
                if !stem.is_empty()
                    && matches!(lower.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp")
                {
                    let aligned = format!("{stem}.{default_ext}");
                    if valid_name(&aligned) {
                        return aligned;
                    }
                }
            }
            let aligned = format!("{base}.{default_ext}");
            if valid_name(&aligned) {
                return aligned;
            }
        }
    }
    format!("image-{}.{default_ext}", index + 1)
}

/// Persist inline RPC images under `<root>/attachment-inputs/<run_id>/<uuid>/<file>`
/// so Graph Planner can forward readable paths to any node that needs them.
pub(crate) fn store_run_images(
    root: &Path,
    run_id: &str,
    images: &[crate::model::ImageAttachment],
) -> Result<Vec<PathBuf>, String> {
    if images.is_empty() || Uuid::parse_str(run_id).is_err() {
        return Ok(Vec::new());
    }
    let mut stored = Vec::with_capacity(images.len());
    for (index, image) in images.iter().enumerate() {
        let data = image
            .data
            .split_once(',')
            .map_or(image.data.as_str(), |(_, rest)| rest);
        let Some(bytes) = crate::server::decode_base64(data) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        let id = Uuid::new_v4().to_string();
        let name = safe_image_filename(image, index);
        stored.push(store(root, Some(run_id), &id, &name, &bytes)?);
    }
    Ok(stored)
}

fn is_managed_attachment_path(path: &str) -> bool {
    if path.contains('\0') || path.contains('\r') || path.contains('\n') {
        return false;
    }
    let marker = format!("/{BUCKET}/");
    let Some((_, suffix)) = path.rsplit_once(&marker) else {
        return false;
    };
    let parts: Vec<&str> = suffix.split('/').collect();
    match parts.as_slice() {
        [run_id, attachment_id, filename] => {
            Uuid::parse_str(run_id).is_ok()
                && Uuid::parse_str(attachment_id).is_ok()
                && valid_name(filename)
        }
        [attachment_id, filename] => Uuid::parse_str(attachment_id).is_ok() && valid_name(filename),
        _ => false,
    }
}

/// Strip leading `@<path>` / `@"<path>"` mentions that point into Grapher's
/// external `attachment-inputs/` store, leaving the user's message text intact.
pub(crate) fn strip_leading_managed_mentions(mut text: &str) -> &str {
    loop {
        let trimmed = text.trim_start_matches([' ', '\t']);
        let Some(after_at) = trimmed.strip_prefix('@') else {
            return text;
        };
        let (candidate, rest) = if after_at.starts_with('"') {
            let bytes = after_at.as_bytes();
            let mut idx = 1;
            let mut escaped = false;
            let mut closed = None;
            while idx < bytes.len() {
                match bytes[idx] {
                    b'\\' if !escaped => escaped = true,
                    b'"' if !escaped => {
                        closed = Some(idx);
                        break;
                    }
                    b'\r' | b'\n' => break,
                    _ => escaped = false,
                }
                idx += 1;
            }
            let Some(end) = closed else {
                return text;
            };
            let Ok(decoded) = serde_json::from_str::<String>(&after_at[..=end]) else {
                return text;
            };
            (decoded, &after_at[end + 1..])
        } else {
            let end = after_at
                .find(char::is_whitespace)
                .unwrap_or(after_at.len());
            (after_at[..end].to_string(), &after_at[end..])
        };
        if !is_managed_attachment_path(&candidate) {
            return text;
        }
        text = rest.trim_start_matches([' ', '\t']);
    }
}

/// Persist an attachment immutably under `<root>/attachment-inputs/`.
/// Retries with the same `(run, id, name)` succeed only if the bytes match.
pub(crate) fn store(
    root: &Path,
    run: Option<&str>,
    id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("Invalid attachment filename".into());
    }
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let directory = attachment_directory(root, run, id)?;
    ensure_directory(root, &directory)?;
    let path = directory.join(name);
    immutable_file(root, &path, bytes)?;
    crate::path_identity::actual_path(&path).or_else(|_| path.canonicalize().map_err(|e| e.to_string()))
}

/// Delete a managed attachment returned by `store`. Rejects any path outside
/// `<root>/attachment-inputs/` or outside the requested Run scope.
pub(crate) fn remove(
    root: &Path,
    run: Option<&str>,
    target_path: &str,
) -> Result<String, String> {
    if target_path.trim().is_empty() || target_path.contains('\0') {
        return Err("Only managed attachment paths can be deleted".into());
    }
    let candidate = Path::new(target_path);
    if !candidate.is_absolute() {
        return Err("Only managed attachment paths can be deleted".into());
    }
    let normalized = target_path.replace('\\', "/");
    let marker = format!("/{BUCKET}/");
    let Some((_, suffix)) = normalized.rsplit_once(&marker) else {
        return Err("Only managed attachment paths can be deleted".into());
    };
    let parts: Vec<&str> = suffix.split('/').collect();
    let (scope_run, id, name) = match parts.as_slice() {
        [run_id, attachment_id, filename]
            if Uuid::parse_str(run_id).is_ok()
                && Uuid::parse_str(attachment_id).is_ok()
                && valid_name(filename) =>
        {
            (Some(*run_id), *attachment_id, *filename)
        }
        [attachment_id, filename]
            if Uuid::parse_str(attachment_id).is_ok() && valid_name(filename) =>
        {
            (None, *attachment_id, *filename)
        }
        _ => return Err("Only managed attachment paths can be deleted".into()),
    };
    if scope_run != run {
        return Err("Only managed attachment paths can be deleted".into());
    }
    let directory = attachment_directory(root, scope_run, id)?;
    let expected = directory.join(name);
    // Verify the supplied absolute path points at the exact managed location
    // under `root` rather than another directory sharing an `attachment-inputs/` suffix.
    let actual_root = crate::path_identity::actual_path(root).unwrap_or_else(|_| root.to_path_buf());
    let expected_display = display_path(&actual_root.join(BUCKET).join(suffix));
    let candidate_display = display_path(candidate);
    let root_insensitive = crate::path_identity::case_insensitive_volume(&actual_root);
    let matches = if root_insensitive {
        expected_display.eq_ignore_ascii_case(&candidate_display)
    } else {
        expected_display == candidate_display
    };
    if !matches {
        return Err("Only managed attachment paths can be deleted".into());
    }
    if let Some(actual) = real_child_path(root, &expected, true)? {
        fs::remove_file(actual).map_err(|error| format!("Cannot delete attachment: {error}"))?;
        let _ = fs::remove_dir(&directory);
    }
    Ok(name.to_string())
}

/// Ensure `<root>/attachment-inputs/<run>` exists so sandboxed executions can
/// bind it read-only at launch and immediately see live-steer uploads.
#[cfg(any(
    all(not(feature = "fixture"), any(target_os = "macos", target_os = "linux")),
    test
))]
pub(crate) fn ensure_run_directory(root: &Path, run: &str) -> Result<PathBuf, String> {
    let run = Uuid::parse_str(run).map_err(|_| "Invalid attachment Run ID")?;
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let directory = root.join(BUCKET).join(run.to_string());
    ensure_directory(root, &directory)?;
    crate::path_identity::actual_path(&directory)
        .or_else(|_| directory.canonicalize().map_err(|e| e.to_string()))
}

/// Find unscoped pre-run attachment IDs (`attachment-inputs/<uuid>/<file>`)
/// referenced in `text` whose directories exist directly under `<root>/attachment-inputs/`.
/// Run-scoped references (`attachment-inputs/<run_uuid>/<id>/<file>`) are ignored.
pub(crate) fn referenced_unscoped_ids(
    root: &Path,
    run_id: &str,
    text: &str,
) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    let normalized = text.replace('\\', "/");
    let prefix = format!("{BUCKET}/");
    for (offset, _) in normalized.match_indices(&prefix) {
        let suffix = &normalized[offset + prefix.len()..];
        if suffix.as_bytes().get(36) != Some(&b'/') {
            continue;
        }
        let Some(first) = suffix.get(..36).and_then(|value| Uuid::parse_str(value).ok()) else {
            continue;
        };
        let first_str = first.to_string();
        if first_str == run_id {
            continue;
        }
        let after_first = &suffix[37..];
        // A run-scoped path has a second UUID segment followed by `/`.
        if after_first.as_bytes().get(36) == Some(&b'/')
            && after_first
                .get(..36)
                .and_then(|value| Uuid::parse_str(value).ok())
                .is_some()
        {
            continue;
        }
        let dir = root.join(BUCKET).join(&first_str);
        if real_child_path(root, &dir, false)
            .ok()
            .flatten()
            .is_some_and(|resolved| resolved.is_dir())
        {
            ids.insert(first_str);
        }
    }
    ids
}

/// Record cleanup ownership for any unscoped pre-run attachments referenced by
/// a newly created Run's goal or tasks, plus the Run's own attachment directory.
pub(crate) fn adopt_for_run(
    root: &Path,
    store: &Store,
    run_id: &str,
    texts: &[&str],
) -> Result<(), String> {
    if Uuid::parse_str(run_id).is_err() {
        return Ok(());
    }
    let mut targets = BTreeSet::new();
    for text in texts {
        for id in referenced_unscoped_ids(root, run_id, text) {
            targets.insert(Target::data(BUCKET, &id));
        }
    }
    if !targets.is_empty() {
        store.remember_cleanup_targets(run_id, &targets)?;
    }
    Ok(())
}

/// Collect all read-only attachment directories authorized for a Run's
/// sandboxed executions: `<root>/attachment-inputs/<run>` (created if absent so
/// live steers become readable immediately) plus any adopted pre-run attachment
/// directories owned by this Run in the cleanup manifest.
#[cfg(any(
    all(not(feature = "fixture"), any(target_os = "macos", target_os = "linux")),
    test
))]
pub(crate) fn read_only_directories_for_run(
    root: &Path,
    run_id: &str,
    store: Option<&Store>,
) -> Result<Vec<PathBuf>, String> {
    if Uuid::parse_str(run_id).is_err() {
        return Ok(Vec::new());
    }
    let mut directories = vec![ensure_run_directory(root, run_id)?];
    if let Some(store) = store {
        for target in store.owned_cleanup_targets(run_id)? {
            if let Target::Data { bucket, id } = target {
                if bucket != BUCKET || Uuid::parse_str(&id).is_err() {
                    continue;
                }
                let candidate = root.join(BUCKET).join(&id);
                if let Some(resolved) = real_child_path(root, &candidate, false)? {
                    if resolved.is_dir() {
                        let canonical = crate::path_identity::actual_path(&resolved)
                            .or_else(|_| resolved.canonicalize().map_err(|e| e.to_string()))?;
                        directories.push(canonical);
                    }
                }
            }
        }
    }
    directories.sort();
    directories.dedup();
    Ok(directories)
}

fn newest_entry_modified(dir: &Path) -> Option<SystemTime> {
    let mut newest = fs::symlink_metadata(dir).ok()?.modified().ok()?;
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries {
        let entry = entry.ok()?;
        let modified = entry.metadata().ok()?.modified().ok()?;
        if modified > newest {
            newest = modified;
        }
    }
    Some(newest)
}

/// Remove stale unscoped pre-run attachment directories under
/// `<root>/attachment-inputs/<uuid>` that are not owned by any Run or pending
/// cleanup task and have not been modified within `max_age`.
pub(crate) fn prune_orphaned_unscoped(
    root: &Path,
    store: &Store,
    max_age: Duration,
) -> Result<usize, String> {
    let Some(bucket) = real_child_path(root, &root.join(BUCKET), false)? else {
        return Ok(0);
    };
    if !bucket.is_dir() {
        return Ok(0);
    }
    let now = SystemTime::now();
    let entries = fs::read_dir(&bucket).map_err(|error| error.to_string())?;
    let mut stale = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if Uuid::parse_str(&name).is_err() {
            continue;
        }
        if store.is_attachment_input_referenced(&name)? {
            continue;
        }
        let path = entry.path();
        let Some(resolved) = real_child_path(root, &path, false)? else {
            continue;
        };
        let Some(newest) = newest_entry_modified(&resolved) else {
            continue;
        };
        let Ok(age) = now.duration_since(newest) else {
            continue;
        };
        if age < max_age {
            continue;
        }
        stale.push(resolved);
    }
    let count = stale.len();
    if !stale.is_empty() {
        crate::workspace_cleanup::remove_paths(stale)?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_retries_compare_all_bytes_and_accept_empty_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for bytes in [Vec::new(), vec![b'x'; 8193]] {
            let id = Uuid::new_v4().to_string();
            let stored = store(root, None, &id, "upload.bin", &bytes).unwrap();
            assert_eq!(
                store(root, None, &id, "upload.bin", &bytes).unwrap(),
                stored
            );
            let mut longer = bytes.clone();
            longer.push(b'x');
            let mut changed = vec![longer];
            if !bytes.is_empty() {
                changed.push(bytes[..bytes.len() - 1].to_vec());
                let mut last_byte = bytes.clone();
                *last_byte.last_mut().unwrap() = b'y';
                changed.push(last_byte);
            }
            for different in changed {
                assert!(store(root, None, &id, "upload.bin", &different)
                    .unwrap_err()
                    .contains("contents changed"));
                assert_eq!(
                    fs::read(&stored).unwrap(),
                    bytes,
                    "retries must never overwrite the winner"
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_attachment_write_does_not_publish_partial_data_and_retry_succeeds() {
        const FIXTURE_ROOT: &str = "GRAPHER_TEST_ATTACHMENT_WRITE_ROOT";
        if let Some(root) = std::env::var_os(FIXTURE_ROOT) {
            let root = PathBuf::from(root);
            let id = Uuid::new_v4().to_string();
            let payload = vec![b'x'; 8192];
            let mut original = std::mem::MaybeUninit::<libc::rlimit>::uninit();
            assert_eq!(
                unsafe { libc::getrlimit(libc::RLIMIT_FSIZE, original.as_mut_ptr()) },
                0
            );
            let original = unsafe { original.assume_init() };
            let limit = libc::rlimit {
                rlim_cur: 1024,
                rlim_max: original.rlim_max,
            };
            let signal = unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_IGN) };
            assert_ne!(signal, libc::SIG_ERR);
            assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &limit) }, 0);
            let failed = store(&root, None, &id, "upload.bin", &payload);
            assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &original) }, 0);
            unsafe { libc::signal(libc::SIGXFSZ, signal) };

            assert!(failed.is_err(), "the fixture must hit the OS write limit");
            let directory = root.join(BUCKET).join(&id);
            assert!(
                !directory.join("upload.bin").exists(),
                "a failed upload published partial bytes"
            );
            assert_eq!(
                fs::read_dir(&directory).unwrap().count(),
                0,
                "temporary bytes must be cleaned up"
            );
            let retried = store(&root, None, &id, "upload.bin", &payload).unwrap();
            assert_eq!(fs::read(retried).unwrap(), payload);
            return;
        }

        // Resource limits and signals are process-wide; never change the parent test runner.
        let temp = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "attachment_inputs::tests::failed_attachment_write_does_not_publish_partial_data_and_retry_succeeds",
            ])
            .env(FIXTURE_ROOT, temp.path())
            .status()
            .unwrap();
        assert!(status.success(), "attachment write-failure fixture failed");
    }

    #[test]
    fn concurrent_attachment_retries_publish_one_complete_immutable_file() {
        use std::sync::{Arc, Barrier};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        let id = Uuid::new_v4().to_string();
        let start = Arc::new(Barrier::new(8));
        let mut workers = Vec::new();
        for i in 0..8 {
            let (root, id, start) = (root.clone(), id.clone(), Arc::clone(&start));
            workers.push(std::thread::spawn(move || {
                let bytes = vec![if i % 2 == 0 { b'a' } else { b'b' }; 1024 * 1024];
                start.wait();
                let result = store(&root, None, &id, "upload.bin", &bytes);
                (bytes, result)
            }));
        }
        let outcomes: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let directory = root.join(BUCKET).join(&id);
        let published = fs::read(directory.join("upload.bin")).unwrap();
        for (bytes, result) in outcomes {
            if bytes == published {
                assert!(
                    result.is_ok(),
                    "identical concurrent retry failed: {result:?}"
                );
            } else {
                assert!(result.unwrap_err().contains("contents changed"));
            }
        }
        assert_eq!(
            fs::read_dir(directory).unwrap().count(),
            1,
            "only the published file remains"
        );
    }
}
