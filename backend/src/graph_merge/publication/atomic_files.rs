//! Stage away from source, then install complete files with same-directory
//! renames. A killed copy can only truncate an owned temporary, never a target.
use super::*;
use std::collections::BTreeMap;

#[derive(Debug, PartialEq, Eq)]
struct Entry {
    mode: String,
    blob: String,
}

pub(super) fn validate_relative(relative: &str) -> Result<(), String> {
    let path = Path::new(relative);
    // .grapher* can be authored project files. Only Git metadata is protected
    // here; host-owned graph metadata lives outside the project tree.
    if relative.is_empty()
        || path.components().any(|part| match part {
            std::path::Component::Normal(name) => {
                name.to_string_lossy().eq_ignore_ascii_case(".git")
            }
            _ => true,
        })
    {
        return Err("Publication tree contains a protected or unsafe path".into());
    }
    Ok(())
}

fn entries(repository: &Path, head: &str) -> Result<BTreeMap<String, Entry>, String> {
    let output = repository_git(repository, &["ls-tree", "-r", "-z", head])?;
    output
        .split('\0')
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (entry, path) = line
                .split_once('\t')
                .ok_or("Invalid publication tree entry")?;
            let mut fields = entry.split_whitespace();
            let mode = fields.next().ok_or("Missing publication file mode")?;
            let _kind = fields.next().ok_or("Missing publication entry type")?;
            let blob = fields.next().ok_or("Missing publication blob")?;
            validate_relative(path)?;
            Ok((
                path.to_string(),
                Entry {
                    mode: mode.into(),
                    blob: blob.into(),
                },
            ))
        })
        .collect()
}

// Check again immediately before replacing/removing a path. The source lease
// excludes other host writers, not editors; staging or copying can take minutes.
fn matches_entry(repository: &Path, relative: &str, entry: Option<&Entry>) -> Result<bool, String> {
    let path = repository.join(relative);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(entry.is_none())
        }
        Err(e) => return Err(e.to_string()),
    };
    if metadata.is_dir() && !crate::workspace_symlinks::is_link(&metadata) {
        return Ok(entry.is_none()); // Git represents directories through their children.
    }
    let Some(entry) = entry else { return Ok(false) };
    let blob = if crate::workspace_symlinks::is_link(&metadata) {
        if entry.mode != "120000" {
            return Ok(false);
        }
        let link = crate::workspace_symlinks::capture(repository, &path, &metadata)?;
        if entry.blob.len() == 40 {
            git2::Oid::hash_object(git2::ObjectType::Blob, link.value.as_bytes())
                .map_err(|e| e.to_string())?
                .to_string()
        } else {
            let shadow = workspace::shadow_repo_dir(repository)?;
            let bytes = workspace::git_bytes(
                repository,
                &[
                    "--git-dir",
                    shadow.to_str().ok_or("Invalid shadow path")?,
                    "hash-object",
                    "--no-filters",
                    "--stdin",
                ],
                None,
                Some(link.value.as_bytes()),
            )?;
            String::from_utf8(bytes)
                .map_err(|e| e.to_string())?
                .trim()
                .to_string()
        }
    } else {
        if !metadata.is_file() || !matches!(entry.mode.as_str(), "100644" | "100755") {
            return Ok(false);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if (metadata.permissions().mode() & 0o111 != 0) != (entry.mode == "100755") {
                return Ok(false);
            }
        }
        if entry.blob.len() == 40 {
            let oid = if metadata.len() <= 8 * 1024 * 1024 {
                git2::Oid::hash_object(
                    git2::ObjectType::Blob,
                    &fs::read(&path).map_err(|e| e.to_string())?,
                )
            } else {
                git2::Oid::hash_file(git2::ObjectType::Blob, &path)
            }
            .map_err(|e| e.to_string())?;
            oid.to_string()
        } else {
            repository_git(repository, &["hash-object", "--no-filters", "--", relative])?
        }
    };
    Ok(blob == entry.blob)
}

fn verify_target(
    repository: &Path,
    relative: &str,
    old: Option<&Entry>,
    new: Option<&Entry>,
) -> Result<(), String> {
    let parent = repository
        .join(relative)
        .parent()
        .ok_or("Missing publication parent")?
        .to_path_buf();
    if parent != repository {
        crate::path_safety::real_child_path(repository, &parent, false)?;
    }
    if matches_entry(repository, relative, old)? || matches_entry(repository, relative, new)? {
        Ok(())
    } else {
        Err(format!(
            "Source files changed before installing '{relative}'; preserved unrecorded edits"
        ))
    }
}

fn ensure_parent(repository: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut parent = repository.to_path_buf();
    if let Some(ancestors) = relative.parent() {
        for component in ancestors.components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return Err("Unsafe publication path".into());
            }
            parent.push(component);
            match fs::symlink_metadata(&parent) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&parent).map_err(|e| e.to_string())?
                }
                Err(error) => return Err(error.to_string()),
                Ok(_) => {}
            }
            crate::path_safety::real_child_path(repository, &parent, false)?
                .ok_or("Publication parent disappeared")?;
        }
    }
    Ok(parent)
}

fn temporary_path(parent: &Path, journal: &Path, relative: &str) -> PathBuf {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    journal
        .canonicalize()
        .unwrap_or_else(|_| journal.to_path_buf())
        .hash(&mut hash);
    relative.hash(&mut hash);
    parent.join(format!(".grapher-publish-{:016x}.tmp", hash.finish()))
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(super) fn install_file(
    repository: &Path,
    journal: &Path,
    staged: &Path,
    relative: &str,
    mode: &str,
    before_rename: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let parent = ensure_parent(repository, Path::new(relative))?;
    let target = repository.join(relative);
    let temporary = temporary_path(&parent, journal, relative);
    // Reserve ownership before creating a temporary. A predictable filename
    // alone is not evidence that an existing file belongs to this publication.
    let record = journal
        .join(temporary.file_name().ok_or("Missing temporary name")?)
        .with_extension("owner");
    match read_optional(&record)? {
        Some(bytes) if bytes == relative.as_bytes() => {}
        Some(_) => return Err("Publication temporary ownership does not match".into()),
        None => {
            match fs::symlink_metadata(&temporary) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
                Ok(_) => {
                    return Err(format!(
                        "Unowned publication temporary already exists: {}",
                        temporary.display()
                    ))
                }
            }
            save_once(&record, relative.as_bytes())?;
        }
    }
    // Never follow a temporary link; a stopped owned copy is disposable.
    if let Ok(metadata) = fs::symlink_metadata(&temporary) {
        if metadata.is_dir() && !crate::workspace_symlinks::is_link(&metadata) {
            return Err("Publication temporary was replaced by a directory".into());
        }
        crate::workspace_symlinks::remove(&temporary)?;
    }
    if mode == "120000" {
        let metadata = fs::symlink_metadata(staged).map_err(|e| e.to_string())?;
        let link = crate::workspace_symlinks::capture(repository, staged, &metadata)?;
        crate::workspace_symlinks::materialize(repository, &temporary, &link)?;
    } else if matches!(mode, "100644" | "100755") {
        let mut input = fs::File::open(staged).map_err(|e| e.to_string())?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output
            .set_permissions(input.metadata().map_err(|e| e.to_string())?.permissions())
            .and_then(|_| output.sync_all())
            .map_err(|e| e.to_string())?;
    } else {
        return Err(format!("Unsupported publication entry mode: {mode}"));
    }
    before_rename(&temporary)?;
    if parent != repository {
        crate::path_safety::real_child_path(repository, &parent, false)?
            .ok_or("Publication parent disappeared")?;
    }
    // A directory-to-file transition may remove only an empty directory.
    // Never recursively remove excluded environments or unrecorded user files.
    if fs::symlink_metadata(&target)
        .is_ok_and(|m| m.is_dir() && !crate::workspace_symlinks::is_link(&m))
    {
        fs::remove_dir(&target).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if crate::workspace_symlinks::is_link(&metadata)
            || mode == "120000"
                && fs::symlink_metadata(&temporary)
                    .is_ok_and(|temp| crate::workspace_symlinks::is_link(&temp) && temp.is_dir())
        {
            crate::workspace_symlinks::remove(&target)?;
        } else if metadata.permissions().readonly() {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(false);
            fs::set_permissions(&target, permissions).map_err(|e| e.to_string())?;
        }
    }
    fs::rename(&temporary, &target)
        .map_err(|e| format!("Cannot atomically install '{relative}': {e}"))?;
    sync_directory(&parent)
}

/// Remove only this journal's reserved adjacent temporaries before capturing
/// the live tree. Collection intentionally includes ordinary dotfiles, so a
/// stopped copy must not be mistaken for an unrelated source edit.
pub(super) fn cleanup_temporaries(
    repository: &Path,
    journal: &Path,
    input: &str,
    result: &str,
) -> Result<(), String> {
    if read_optional(&journal.join("applying"))?.as_deref() != Some(b"atomic-files-v1\n") {
        return Ok(());
    }
    for relative in diff_paths(repository, input, result)? {
        let target = repository.join(&relative);
        let parent = target.parent().ok_or("Missing publication parent")?;
        if parent != repository
            && !matches!(
                crate::path_safety::real_child_path(repository, parent, false),
                Ok(Some(_))
            )
        {
            // A prior input/result may still have a file or link in this
            // ancestor position; there cannot be an owned temp beneath it.
            continue;
        }
        let temporary = temporary_path(parent, journal, &relative);
        let record = journal
            .join(temporary.file_name().ok_or("Missing temporary name")?)
            .with_extension("owner");
        if read_optional(&record)?.as_deref() != Some(relative.as_bytes()) {
            continue;
        }
        if fs::symlink_metadata(&temporary).is_ok() {
            crate::workspace_symlinks::remove(&temporary)?;
        }
    }
    Ok(())
}

/// Git streams only requested blobs into private staging. Also used by the
/// offline repair so restoring a large binary never buffers it all in RAM.
pub(super) fn stage_files(
    repository: &Path,
    journal: &Path,
    result: &str,
    paths: &[&str],
) -> Result<PathBuf, String> {
    let staged = journal.join("staged-files");
    fs::create_dir_all(&staged).map_err(|e| e.to_string())?;
    crate::path_safety::real_child_path(journal, &staged, false)?;
    let index = journal.join("staging-index");
    let lock = index.with_extension("lock");
    // Called only under the source lease. This private index is disposable;
    // never remove the source's Git lock.
    if fs::symlink_metadata(&lock).is_ok() {
        crate::path_safety::real_child_path(journal, &lock, true)?;
        fs::remove_file(&lock).map_err(|e| e.to_string())?;
    }
    private_index_git(repository, &index, &["read-tree", result])?;
    let prefix = format!(
        "--prefix={}/",
        crate::native::host_path(&staged)
            .to_string_lossy()
            .replace('\\', "/")
    );
    let mut input = Vec::new();
    for path in paths {
        validate_relative(path)?;
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    // NUL-delimited stdin handles special filenames and Windows command-line
    // limits without checking out the whole tree or spawning Git per path.
    private_index_git_input(
        repository,
        &index,
        &[
            "-c",
            "core.symlinks=true",
            "checkout-index",
            "--force",
            "-z",
            "--stdin",
            &prefix,
        ],
        Some(&input),
    )?;
    Ok(staged)
}

pub(super) fn install(
    repository: &Path,
    journal: &Path,
    input: &str,
    result: &str,
) -> Result<(), String> {
    install_with(repository, journal, input, result, &mut |_| {
        crate::process_control::check_current_owner_stop()
    })
}

fn install_with(
    repository: &Path,
    journal: &Path,
    input: &str,
    result: &str,
    before_rename: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let _operation = crate::process_control::OperationControl::begin()?;
    let old = entries(repository, input)?;
    let new = entries(repository, result)?;
    let changed = diff_paths(repository, input, result)?;
    // Do not materialize unchanged project files (potentially gigabytes) just
    // to deliver a small delta. Explicit paths also avoid checkout of unrelated
    // native links on hosts where creating them requires privileges.
    let additions: Vec<_> = changed.iter().filter(|p| new.contains_key(*p)).collect();
    for relative in &additions {
        if !matches!(new[*relative].mode.as_str(), "100644" | "100755" | "120000") {
            return Err(format!(
                "Unsupported publication entry mode: {}",
                new[*relative].mode
            ));
        }
    }
    let paths: Vec<_> = additions.iter().map(|path| path.as_str()).collect();
    let staged = stage_files(repository, journal, result, &paths)?;
    if !journal.join("applying").exists() {
        save_once(&journal.join("applying"), b"atomic-files-v1\n")?;
    }
    let mut removed: Vec<_> = changed
        .iter()
        .filter(|p| old.contains_key(*p) && !new.contains_key(*p))
        .collect();
    removed.sort_by_key(|path| std::cmp::Reverse(path.len()));
    for relative in removed {
        crate::process_control::check_current_owner_stop()?;
        let target = repository.join(relative);
        let parent = target.parent().ok_or("Missing publication parent")?;
        // On retry a directory may already have become a result file/link.
        // Recognize that exact result before inspecting any former children;
        // never follow the installed link into a different tree.
        let mut replaced_ancestor = false;
        for ancestor in Path::new(relative).ancestors().skip(1) {
            if let Some(name) = ancestor.to_str().filter(|name| !name.is_empty()) {
                if let Some(entry) = new.get(name) {
                    if matches_entry(repository, name, Some(entry))? {
                        replaced_ancestor = true;
                        break;
                    }
                }
            }
        }
        if replaced_ancestor {
            continue;
        }
        if parent != repository
            && crate::path_safety::real_child_path(repository, parent, false)?.is_none()
        {
            continue;
        }
        verify_target(repository, relative, old.get(relative), None)?;
        match fs::symlink_metadata(&target) {
            Ok(metadata) if !metadata.is_dir() || crate::workspace_symlinks::is_link(&metadata) => {
                crate::workspace_symlinks::remove(&target)?;
                sync_directory(parent)?;
            }
            Ok(_) => {} // Already replaced by a directory in an earlier partial attempt.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        let mut empty = parent;
        while empty != repository && fs::remove_dir(empty).is_ok() {
            empty = empty.parent().ok_or("Missing publication ancestor")?;
        }
    }
    for relative in changed.iter().filter(|p| new.contains_key(*p)) {
        crate::process_control::check_current_owner_stop()?;
        // Validate before copying and again afterward, including files that
        // have already reached the result during an interrupted attempt.
        // A missing parent is created by install_file only after this check.
        verify_target(repository, relative, old.get(relative), new.get(relative))?;
        install_file(
            repository,
            journal,
            &staged.join(relative),
            relative,
            &new[relative].mode,
            &mut |temporary| {
                before_rename(temporary)?;
                verify_target(repository, relative, old.get(relative), new.get(relative))
            },
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf, String) {
        crate::ensure_test_data_root();
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("file.txt"), "original").unwrap();
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "-qm", "base"]).unwrap();
        let input = workspace::snapshot_repository(&source).unwrap();
        let node = temp.path().join("node");
        workspace::prepare(&source, &node, &input, &[]).unwrap();
        let journal = temp.path().join("journal");
        fs::create_dir(&journal).unwrap();
        (temp, source, node, journal, input)
    }

    #[test]
    fn edits_during_adjacent_copy_are_not_overwritten() {
        let (_temp, source, node, journal, input) = fixture();
        fs::write(node.join("file.txt"), "published").unwrap();
        let result = workspace::snapshot_node(&node, &source, "worker").unwrap();
        let outcome = install_with(&source, &journal, &input, &result, &mut |_| {
            fs::write(source.join("file.txt"), "new user work").unwrap();
            Ok(())
        });
        assert!(
            outcome.is_err(),
            "publication must detect edits made during the copy"
        );
        assert_eq!(
            fs::read_to_string(source.join("file.txt")).unwrap(),
            "new user work"
        );
    }

    #[test]
    fn authored_grapher_names_are_delivered_not_rejected_as_host_metadata() {
        let (_temp, source, _node, journal, _) = fixture();
        let paths = [
            ".grapher-project.json",
            ".grapher-publish-0000000000000000.tmp",
        ];
        for path in paths {
            fs::write(source.join(path), "original").unwrap();
        }
        git(&source, &["add", "--", paths[1]]).unwrap();
        let input = workspace::snapshot_repository(&source).unwrap();
        for path in paths {
            fs::write(source.join(path), "updated").unwrap();
        }
        let result = workspace::snapshot_repository(&source).unwrap();
        for path in paths {
            fs::write(source.join(path), "original").unwrap();
        }
        install(&source, &journal, &input, &result).unwrap();
        for path in paths {
            assert_eq!(fs::read_to_string(source.join(path)).unwrap(), "updated");
        }
        for path in ["../outside", ".git/config", "nested/.git/config"] {
            assert!(validate_relative(path).is_err());
        }
    }

    #[test]
    fn unowned_temporary_is_not_deleted_on_install_or_cleanup() {
        let (_temp, source, node, journal, input) = fixture();
        fs::write(node.join("file.txt"), "published").unwrap();
        let result = workspace::snapshot_node(&node, &source, "worker").unwrap();
        let temporary = temporary_path(&source, &journal, "file.txt");
        fs::write(&temporary, "unrecorded work").unwrap();
        let error = install(&source, &journal, &input, &result).unwrap_err();
        assert!(error.contains("Unowned publication temporary"), "{error}");
        cleanup_temporaries(&source, &journal, &input, &result).unwrap();
        assert_eq!(fs::read_to_string(&temporary).unwrap(), "unrecorded work");
        assert_eq!(
            fs::read_to_string(source.join("file.txt")).unwrap(),
            "original"
        );
    }

    #[test]
    fn staging_does_not_materialize_unchanged_files() {
        let (_temp, source, node, journal, input) = fixture();
        let paths = [
            "added.txt",
            "- [literal] 中文.txt",
            "nested/path with spaces.txt",
        ];
        fs::create_dir(node.join("nested")).unwrap();
        for path in paths {
            fs::write(node.join(path), "published").unwrap();
        }
        let result = workspace::snapshot_node(&node, &source, "worker").unwrap();
        install(&source, &journal, &input, &result).unwrap();
        assert!(
            !journal.join("staged-files/file.txt").exists(),
            "unchanged project bytes must not be copied on every publication"
        );
        for path in paths {
            assert_eq!(fs::read_to_string(source.join(path)).unwrap(), "published");
        }
    }

    #[cfg(unix)]
    #[test]
    fn retry_skips_deleted_children_below_an_already_installed_symlink() {
        let (temp, source, _node, journal, _) = fixture();
        let node = temp.path().join("link-node");
        fs::create_dir(source.join("dir")).unwrap();
        fs::write(source.join("dir/child"), "old child").unwrap();
        let input = workspace::snapshot_repository(&source).unwrap();
        workspace::prepare(&source, &node, &input, &[]).unwrap();
        fs::remove_dir_all(node.join("dir")).unwrap();
        std::os::unix::fs::symlink(".", node.join("dir")).unwrap();
        let result = workspace::snapshot_node(&node, &source, "worker").unwrap();
        install(&source, &journal, &input, &result).unwrap();
        // Installation can stop before the durable completion marker.
        install(&source, &journal, &input, &result).unwrap();
        assert_eq!(fs::read_link(source.join("dir")).unwrap(), Path::new("."));
        assert_eq!(
            fs::read_to_string(source.join("file.txt")).unwrap(),
            "original"
        );
    }

    #[test]
    fn stopped_file_copy_preserves_old_bytes_and_retry_ignores_partial_temporary() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let journal = temp.path().join("journal");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&journal).unwrap();
        let staged = journal.join("complete.bin");
        let bytes = vec![42u8; 1024 * 1024];
        fs::write(&staged, &bytes).unwrap();
        for existing in [false, true] {
            let relative = if existing {
                "existing.bin"
            } else {
                "added.bin"
            };
            let target = source.join(relative);
            if existing {
                fs::write(&target, b"original").unwrap();
            }
            let failed = install_file(
                &source,
                &journal,
                &staged,
                relative,
                "100644",
                &mut |temporary| {
                    // Simulate death during the adjacent temporary's copy.
                    fs::write(temporary, []).unwrap();
                    Err("interrupted".into())
                },
            );
            assert!(failed.is_err());
            if existing {
                assert_eq!(fs::read(&target).unwrap(), b"original");
            } else {
                assert!(!target.exists());
            }
            install_file(&source, &journal, &staged, relative, "100644", &mut |_| {
                Ok(())
            })
            .unwrap();
            assert_eq!(fs::read(&target).unwrap(), bytes);
        }
    }

    #[test]
    fn run_wide_cancel_stops_atomic_install_and_readonly_target_is_replaceable() {
        let (_temp, source, node, journal, _) = fixture();
        let target = source.join("file.txt");
        let mut perms = fs::metadata(&target).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&target, perms).unwrap();
        let input = workspace::snapshot_repository(&source).unwrap();
        let mut node_perms = fs::metadata(node.join("file.txt")).unwrap().permissions();
        node_perms.set_readonly(false);
        fs::set_permissions(node.join("file.txt"), node_perms).unwrap();
        fs::write(node.join("file.txt"), "published").unwrap();
        let result = workspace::snapshot_node(&node, &source, "worker").unwrap();
        let run = uuid::Uuid::new_v4().to_string();
        let cancelled = crate::process_control::with_owner(&run, || {
            install_with(&source, &journal, &input, &result, &mut |_| {
                crate::engine::terminate_run(&run);
                crate::process_control::check_current_owner_stop()
            })
        });
        assert!(cancelled.unwrap_err().contains("cancelled by user"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
        install(&source, &journal, &input, &result).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "published");
    }
}
