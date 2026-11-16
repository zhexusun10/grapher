//! Stage away from source, then install complete files with same-directory
//! renames. A killed copy can only truncate an owned temporary, never a target.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

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

fn entries(
    repository: &Path,
    head: &str,
    changed: &BTreeSet<String>,
) -> Result<BTreeMap<String, Entry>, String> {
    let output = repository_git(repository, &["ls-tree", "-r", "-z", head])?;
    let mut entries = BTreeMap::new();
    for line in output.split('\0').filter(|line| !line.is_empty()) {
        let (entry, path) = line
            .split_once('\t')
            .ok_or("Invalid publication tree entry")?;
        let mut fields = entry.split_whitespace();
        let mode = fields.next().ok_or("Missing publication file mode")?;
        let _kind = fields.next().ok_or("Missing publication entry type")?;
        let blob = fields.next().ok_or("Missing publication blob")?;
        // Validate the entire tree, including unchanged paths. Only the delta
        // needs owned map entries; a small edit must not allocate two complete
        // project maps. A file/link replacing a deleted path's ancestor is
        // itself changed, so retry's ancestor lookup retains that entry too.
        validate_relative(path)?;
        if changed.contains(path) {
            entries.insert(
                path.to_string(),
                Entry {
                    mode: mode.into(),
                    blob: blob.into(),
                },
            );
        }
    }
    Ok(entries)
}

// One fresh observation can match either the input or the installed result.
// Do not hash the same file again just because it did not match the first OID.
// Entries come from the same repository and therefore use one object format.
// Never reuse this observation across checks: the source lease does not stop
// editors, so installation still checks separately before and after copying.
fn matches_entries(
    repository: &Path,
    relative: &str,
    entries: &[Option<&Entry>],
) -> Result<bool, String> {
    let path = repository.join(relative);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(entries.iter().any(Option::is_none))
        }
        Err(e) => return Err(e.to_string()),
    };
    let is_link = crate::workspace_symlinks::is_link(&metadata);
    if metadata.is_dir() && !is_link {
        // Git represents directories through their children.
        return Ok(entries.iter().any(Option::is_none));
    }
    let mut candidates = entries.iter().flatten().copied().filter(|entry| {
        if is_link {
            return entry.mode == "120000";
        }
        if !metadata.is_file() || !matches!(entry.mode.as_str(), "100644" | "100755") {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            (metadata.permissions().mode() & 0o111 != 0) == (entry.mode == "100755")
        }
        #[cfg(not(unix))]
        {
            true
        }
    });
    let Some(entry) = candidates.next() else {
        return Ok(false);
    };
    let blob = if is_link {
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
    } else if entry.blob.len() == 40 {
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
    };
    Ok(blob == entry.blob || candidates.any(|candidate| blob == candidate.blob))
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
    if matches_entries(repository, relative, &[old, new])? {
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
    // Offline legacy repair still accepts arbitrary paths from a pinned tree.
    stage_files_with_index(repository, journal, paths, |index| {
        private_index_git(repository, index, &["read-tree", result]).map(|_| ())
    })
}

/// Normal delivery already has validated mode/OID entries for its delta. Build
/// the disposable checkout index from those entries, not the full result tree.
/// Git remains responsible for index encoding and raw blob checkout (SHA-1/256).
fn stage_entries(
    repository: &Path,
    journal: &Path,
    entries: &BTreeMap<String, Entry>,
) -> Result<PathBuf, String> {
    let mut index_info = Vec::new();
    let mut paths = Vec::with_capacity(entries.len());
    for (path, entry) in entries {
        validate_relative(path)?;
        if !matches!(entry.mode.as_str(), "100644" | "100755" | "120000") {
            return Err(format!(
                "Unsupported publication entry mode: {}",
                entry.mode
            ));
        }
        crate::workspace_git_index::append_index_info(
            &mut index_info,
            &entry.mode,
            &entry.blob,
            path,
        );
        paths.push(path.as_str());
    }
    stage_files_with_index(repository, journal, &paths, |index| {
        // The source lease excludes concurrent users of this journal. Discard
        // only its private staging index: an older/full or interrupted index
        // must not add unrelated entries to this attempt's delta. A crash here
        // is recoverable by rebuilding from the same pinned result next time.
        if crate::path_safety::real_child_path(journal, index, true)?.is_some() {
            fs::remove_file(index).map_err(|e| e.to_string())?;
        }
        private_index_git_input(
            repository,
            index,
            &["update-index", "-z", "--index-info"],
            Some(&index_info),
        )
        .map(|_| ())
    })
}

fn stage_files_with_index(
    repository: &Path,
    journal: &Path,
    paths: &[&str],
    prepare_index: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    let staged = journal.join("staged-files");
    fs::create_dir_all(&staged).map_err(|e| e.to_string())?;
    crate::path_safety::real_child_path(journal, &staged, false)?;
    // Deletion-only delivery needs no checkout repository, index or blobs.
    // Keep path validation above and the normal deletion/recovery checks below.
    if paths.is_empty() {
        return Ok(staged);
    }
    let index = journal.join("staging-index");
    let lock = index.with_extension("lock");
    // Called only under the source lease. This private index is disposable;
    // never remove the source's Git lock.
    if fs::symlink_metadata(&lock).is_ok() {
        crate::path_safety::real_child_path(journal, &lock, true)?;
        fs::remove_file(&lock).map_err(|e| e.to_string())?;
    }
    prepare_index(&index)?;
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
    let changed = diff_paths(repository, input, result)?;
    let old = entries(repository, input, &changed)?;
    let new = entries(repository, result, &changed)?;
    // `new` contains only changed result entries; deleted paths have no entry.
    // Neither the staging index nor checkout needs unrelated project files.
    let staged = stage_entries(repository, journal, &new)?;
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
                    if matches_entries(repository, name, &[Some(entry)])? {
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
#[path = "staging_bench.rs"]
mod staging_bench;

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
    fn verification_accepts_either_tree_but_rechecks_same_size_edits() {
        crate::ensure_test_data_root();
        for format in ["sha1", "sha256"] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("source");
            fs::create_dir(&source).unwrap();
            git(
                &source,
                &["init", "-q", &format!("--object-format={format}")],
            )
            .unwrap();
            let file = source.join("file.txt");
            fs::write(&file, b"original").unwrap();
            let input = workspace::snapshot_repository(&source).unwrap();
            fs::write(&file, b"replaced").unwrap();
            let result = workspace::snapshot_repository(&source).unwrap();
            let changed = diff_paths(&source, &input, &result).unwrap();
            let old = entries(&source, &input, &changed).unwrap();
            let new = entries(&source, &result, &changed).unwrap();
            let candidates = [old.get("file.txt"), new.get("file.txt")];
            for (bytes, accepted) in [
                (b"original", true),
                (b"replaced", true),
                (b"intruder", false),
            ] {
                fs::write(&file, bytes).unwrap();
                assert_eq!(
                    matches_entries(&source, "file.txt", &candidates).unwrap(),
                    accepted
                );
                assert_eq!(
                    verify_target(&source, "file.txt", candidates[0], candidates[1]).is_ok(),
                    accepted
                );
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::write(&file, b"original").unwrap();
                fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
                assert!(!matches_entries(&source, "file.txt", &candidates).unwrap());
                let executable = Entry {
                    mode: "100755".into(),
                    blob: old["file.txt"].blob.clone(),
                };
                assert!(
                    matches_entries(&source, "file.txt", &[candidates[0], Some(&executable)],)
                        .unwrap()
                );
            }
            fs::remove_file(&file).unwrap();
            assert!(!matches_entries(&source, "file.txt", &candidates).unwrap());
            assert!(matches_entries(&source, "file.txt", &[candidates[0], None]).unwrap());
            fs::create_dir(&file).unwrap();
            assert!(!matches_entries(&source, "file.txt", &candidates).unwrap());
            assert!(matches_entries(&source, "file.txt", &[None, candidates[1]]).unwrap());
        }
    }

    #[cfg(unix)]
    #[test]
    fn verification_distinguishes_links_from_files_with_the_same_blob() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path();
        let blob = git2::Oid::hash_object(git2::ObjectType::Blob, b"target")
            .unwrap()
            .to_string();
        let regular = Entry {
            mode: "100644".into(),
            blob: blob.clone(),
        };
        let link = Entry {
            mode: "120000".into(),
            blob,
        };
        std::os::unix::fs::symlink("target", source.join("entry")).unwrap();
        assert!(!matches_entries(source, "entry", &[Some(&regular)]).unwrap());
        assert!(matches_entries(source, "entry", &[Some(&regular), Some(&link)]).unwrap());
        fs::remove_file(source.join("entry")).unwrap();
        fs::write(source.join("entry"), b"target").unwrap();
        assert!(!matches_entries(source, "entry", &[Some(&link)]).unwrap());
        assert!(matches_entries(source, "entry", &[Some(&link), Some(&regular)]).unwrap());
    }

    #[test]
    fn delta_entries_still_validate_unchanged_tree_paths() {
        let (_temp, source, _node, _journal, _) = fixture();
        let repository =
            git2::Repository::open(workspace::shadow_repo_dir(&source).unwrap()).unwrap();
        let blob = repository.blob(b"project bytes").unwrap();
        let mut builder = repository.treebuilder(None).unwrap();
        for path in ["unchanged.txt", "changed.txt"] {
            builder.insert(path, blob, 0o100644).unwrap();
        }
        let tree = builder.write().unwrap();
        let changed = BTreeSet::from(["changed.txt".to_string()]);
        let selected = entries(&source, &tree.to_string(), &changed).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected["changed.txt"].blob, blob.to_string());
        assert!(entries(&source, &tree.to_string(), &BTreeSet::new())
            .unwrap()
            .is_empty());

        // Even an unselected path must pass the old whole-tree safety gate.
        // Build the unsafe tree only in disposable host Git, never on disk.
        let mut raw = b"100644 .git\0".to_vec();
        raw.extend_from_slice(blob.as_bytes());
        let unsafe_tree = repository
            .odb()
            .unwrap()
            .write(git2::ObjectType::Tree, &raw)
            .unwrap();
        let error = entries(&source, &unsafe_tree.to_string(), &BTreeSet::new()).unwrap_err();
        assert!(error.contains("protected or unsafe path"), "{error}");
    }

    #[test]
    fn deletion_only_delivery_skips_checkout_and_retains_recovery_checks() {
        let (_temp, source, node, journal, input) = fixture();
        fs::remove_file(node.join("file.txt")).unwrap();
        let result = workspace::snapshot_node(&node, &source, "worker").unwrap();
        let index = fs::read(source.join(".git/index")).unwrap();
        fs::write(source.join("file.txt"), "user edit").unwrap();
        assert!(install(&source, &journal, &input, &result)
            .unwrap_err()
            .contains("Source files changed"));
        assert_eq!(
            fs::read_to_string(source.join("file.txt")).unwrap(),
            "user edit"
        );
        fs::write(source.join("file.txt"), "original").unwrap();
        install(&source, &journal, &input, &result).unwrap();
        // An interrupted deletion can be replayed without rebuilding an index.
        install(&source, &journal, &input, &result).unwrap();
        assert!(!source.join("file.txt").exists());
        assert!(!journal.join("staging-index").exists());
        assert!(!journal.join("raw-checkout.git").exists());
        assert!(journal.join("applying").is_file());
        assert_eq!(fs::read(source.join(".git/index")).unwrap(), index);
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
        let indexed =
            private_index_git(&source, &journal.join("staging-index"), &["ls-files", "-z"])
                .unwrap();
        let indexed: BTreeSet<_> = indexed
            .split('\0')
            .filter(|name| !name.is_empty())
            .collect();
        assert_eq!(indexed, paths.into_iter().collect());
    }

    #[test]
    fn delta_staging_rebuilds_full_or_partial_indices_without_touching_source_evidence() {
        let (_temp, source, node, journal, _) = fixture();
        for name in ["a.txt", "b.txt"] {
            fs::write(node.join(name), name).unwrap();
        }
        let result = workspace::snapshot_node(&node, &source, "worker").unwrap();
        let index = journal.join("staging-index");
        let original = fs::read(source.join(".git/index")).unwrap();
        fs::write(journal.join("original-index"), &original).unwrap();
        let source_lock = source.join(".git/index.lock");
        fs::write(&source_lock, "source lease").unwrap();
        // A legacy/repair checkout may have populated a full cached index.
        stage_files(&source, &journal, &result, &["a.txt"]).unwrap();
        assert!(private_index_git(&source, &index, &["ls-files", "-z"])
            .unwrap()
            .split('\0')
            .any(|name| name == "file.txt"));
        let selected = entries(&source, &result, &BTreeSet::from(["b.txt".into()])).unwrap();
        for corrupt in [false, true] {
            if corrupt {
                fs::write(&index, "partial disposable index").unwrap();
            }
            fs::write(index.with_extension("lock"), "stopped index update").unwrap();
            let staged = stage_entries(&source, &journal, &selected).unwrap();
            assert_eq!(
                private_index_git(&source, &index, &["ls-files", "-z"]).unwrap(),
                "b.txt\0"
            );
            assert_eq!(fs::read(staged.join("b.txt")).unwrap(), b"b.txt");
            assert!(!index.with_extension("lock").exists());
            assert_eq!(fs::read(source.join(".git/index")).unwrap(), original);
            assert_eq!(fs::read(journal.join("original-index")).unwrap(), original);
            assert_eq!(fs::read_to_string(&source_lock).unwrap(), "source lease");
        }
    }

    #[test]
    fn delta_staging_refuses_a_redirected_index_without_deleting_foreign_data() {
        let (temp, source, _node, journal, result) = fixture();
        let foreign = temp.path().join("foreign");
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("marker"), "keep").unwrap();
        let index = journal.join("staging-index");
        crate::path_safety::directory_link(&foreign, &index);
        let selected = entries(&source, &result, &BTreeSet::from(["file.txt".into()])).unwrap();
        assert!(stage_entries(&source, &journal, &selected).is_err());
        assert_eq!(fs::read(foreign.join("marker")).unwrap(), b"keep");
        assert_eq!(fs::read(source.join("file.txt")).unwrap(), b"original");
        crate::path_safety::remove_directory_link(&index);
    }

    #[test]
    fn delta_staging_preserves_raw_bytes_modes_and_both_object_formats() {
        crate::ensure_test_data_root();
        for format in ["sha1", "sha256"] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join("source");
            let journal = temp.path().join("journal");
            fs::create_dir_all(source.join("nested")).unwrap();
            fs::create_dir(&journal).unwrap();
            git(
                &source,
                &["init", "-q", &format!("--object-format={format}")],
            )
            .unwrap();
            fs::write(source.join(".gitattributes"), "*.txt text eol=crlf\n").unwrap();
            fs::write(source.join("unchanged.txt"), "unchanged\n").unwrap();
            let name = "nested/- [literal] 中文.txt";
            let bytes = b"first\nsecond\r\n\0binary\xff";
            fs::write(source.join(name), bytes).unwrap();
            let paths = BTreeSet::from([name.to_string()]);
            #[cfg(unix)]
            let paths = {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(source.join(name), fs::Permissions::from_mode(0o755)).unwrap();
                std::os::unix::fs::symlink(name, source.join("link")).unwrap();
                let mut paths = paths;
                paths.insert("link".into());
                for special in ["tab\tand\nnewline", "back\\slash"] {
                    fs::write(source.join(special), bytes).unwrap();
                    paths.insert(special.into());
                }
                paths
            };
            let result = workspace::snapshot_repository(&source).unwrap();
            let selected = entries(&source, &result, &paths).unwrap();
            assert_eq!(
                selected[name].blob.len(),
                if format == "sha1" { 40 } else { 64 }
            );
            let original_index = fs::read(source.join(".git/index")).ok();
            let staged = stage_entries(&source, &journal, &selected).unwrap();
            assert_eq!(fs::read(staged.join(name)).unwrap(), bytes);
            let indexed =
                private_index_git(&source, &journal.join("staging-index"), &["ls-files", "-z"])
                    .unwrap();
            let indexed: BTreeSet<_> = indexed
                .split('\0')
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect();
            assert_eq!(indexed, paths);
            assert!(!staged.join(".gitattributes").exists());
            assert!(!staged.join("unchanged.txt").exists());
            assert_eq!(fs::read(source.join(".git/index")).ok(), original_index);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_ne!(
                    fs::metadata(staged.join(name))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o111,
                    0
                );
                assert_eq!(
                    fs::read_link(staged.join("link")).unwrap(),
                    PathBuf::from(name)
                );
                for special in ["tab\tand\nnewline", "back\\slash"] {
                    assert_eq!(fs::read(staged.join(special)).unwrap(), bytes);
                }
            }
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
