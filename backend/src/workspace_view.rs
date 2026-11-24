//! A project Git view is not the graph repository. Immutable view records bind
//! project metadata and the user's Git state to the same internal code commit.
//! Project bytes remain Git blobs; no live-source copy is used on a retry/fork.
use crate::{graph_merge::ResolutionError, native_copy, path_safety::real_child_path, workspace};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

mod equality;
mod file_scan;
mod normalization;

mod runtime_inputs;
mod sha256_stage;
mod snapshot_recovery;
pub(crate) use runtime_inputs::verify_native_inputs;

pub(crate) use snapshot_recovery::recover_snapshot_readiness;

const VIEW_SCHEMA: u32 = 6;

#[cfg(test)]
#[path = "workspace_view/scan_bench.rs"]
mod scan_bench;

#[cfg(all(test, any(windows, target_os = "macos")))]
mod acl_tests;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Entry {
    Directory {
        mode: u32,
        extra: crate::workspace_metadata::Extra,
    },
    File {
        mode: u32,
        blob: String,
        extra: crate::workspace_metadata::Extra,
    },
    Special {
        special: String,
        mode: u32,
        device: u64,
        extra: crate::workspace_metadata::Extra,
    },
    Link {
        target: crate::workspace_symlinks::Link,
        extra: crate::workspace_metadata::Extra,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct View {
    schema: u32,
    source: String,
    root_mode: u32,
    root_extra: crate::workspace_metadata::Extra,
    entries: BTreeMap<String, Entry>,
    hardlinks: crate::workspace_links::Topology,
    repositories: BTreeMap<String, View>,
    git_entries: Option<BTreeMap<String, Entry>>,
    git_file: bool,
    git_file_metadata: Option<(u32, crate::workspace_metadata::Extra)>,
    #[serde(default)]
    git_link: bool,
    #[serde(default)]
    git_link_metadata: Option<(u32, crate::workspace_metadata::Extra)>,
    git_config: Vec<(String, String)>,
    git_files: BTreeMap<String, (String, bool)>,
    git_global: Vec<u8>,
}

// View equality follows the versioned checksum projection. Current views bind
// native ACLs and all project paths, excluding only the Git-index stat cache.
impl PartialEq for View {
    fn eq(&self, other: &Self) -> bool {
        equality::equal(self, other)
    }
}
impl Eq for View {}

fn strip_entry_system_managed(entry: &mut Entry) {
    match entry {
        Entry::Directory { extra, .. }
        | Entry::File { extra, .. }
        | Entry::Special { extra, .. }
        | Entry::Link { extra, .. } => extra.strip_system_managed(),
    }
}

impl View {
    fn validate_schema(&self) -> Result<(), String> {
        if self.schema != VIEW_SCHEMA {
            return Err("Unsupported project-view schema".into());
        }
        for repository in self.repositories.values() {
            repository.validate_schema()?;
        }
        Ok(())
    }

    /// Host-managed metadata never becomes portable project ownership.
    fn strip_system_managed(&mut self) {
        self.root_extra.strip_system_managed();
        for entry in self.entries.values_mut().chain(
            self.git_entries
                .iter_mut()
                .flat_map(|entries| entries.values_mut()),
        ) {
            strip_entry_system_managed(entry);
        }
        for extra in [&mut self.git_file_metadata, &mut self.git_link_metadata]
            .into_iter()
            .flatten()
            .map(|(_, extra)| extra)
        {
            extra.strip_system_managed();
        }
        for repository in self.repositories.values_mut() {
            repository.strip_system_managed();
        }
    }
}

fn mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o7777
    }
    #[cfg(windows)]
    {
        u32::from(metadata.permissions().readonly())
    }
}
fn set_mode(path: &Path, value: u32) -> Result<(), String> {
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        fs::Permissions::from_mode(value)
    };
    #[cfg(windows)]
    let permissions = {
        let mut permissions = fs::metadata(path).map_err(|e| e.to_string())?.permissions();
        permissions.set_readonly(value != 0);
        permissions
    };
    fs::set_permissions(path, permissions).map_err(|e| e.to_string())
}
fn name(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .ok_or("Project paths must be UTF-8; refusing an incomplete workspace")?;
    Ok(if cfg!(windows) {
        value.replace('\\', "/")
    } else {
        value.into()
    })
}
fn path_config(key: &str) -> bool {
    matches!(
        key,
        "include.path" | "core.excludesfile" | "core.attributesfile" | "core.hookspath"
    )
}
fn git_lock(path: &Path) -> bool {
    let value = path.to_string_lossy().replace('\\', "/");
    matches!(
        value.as_str(),
        "index.lock" | "HEAD.lock" | "config.lock" | "packed-refs.lock" | "shallow.lock"
    ) || value.starts_with("refs/") && value.ends_with(".lock")
}

/// Content identity of a project file. Small files are read once and hashed in
/// memory: libgit2's file stream re-opens the path and hashes small files about
/// six times slower, and every scan touches the whole project. Large files keep
/// the streaming path so a big artifact never lands in a buffer.
const IN_MEMORY_HASH_LIMIT: u64 = 8 * 1024 * 1024;

fn snapshot_changed_error(path: &str, disappeared: bool) -> String {
    if disappeared {
        format!(
            "Project changed while binding its byte snapshot ({path} disappeared); retry preparation"
        )
    } else {
        format!(
            "Project changed while binding its byte snapshot ({path}); retry preparation"
        )
    }
}

fn map_snapshot_io_error(error: std::io::Error, path: &str) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        snapshot_changed_error(path, true)
    } else {
        format!("{path}: {error}")
    }
}

fn file_blob(display_name: &str, path: &Path, len: u64) -> Result<git2::Oid, String> {
    if len <= IN_MEMORY_HASH_LIMIT {
        let bytes = fs::read(path).map_err(|e| map_snapshot_io_error(e, display_name))?;
        return git2::Oid::hash_object(git2::ObjectType::Blob, &bytes).map_err(|e| e.to_string());
    }
    git2::Oid::hash_file(git2::ObjectType::Blob, path).map_err(|e| {
        if e.code() == git2::ErrorCode::NotFound
            || fs::symlink_metadata(path)
                .is_err_and(|io_err| io_err.kind() == std::io::ErrorKind::NotFound)
        {
            snapshot_changed_error(display_name, true)
        } else {
            format!("{display_name}: {e}")
        }
    })
}

fn scan(
    root: &Path,
    relative: &Path,
    entries: &mut BTreeMap<String, Entry>,
    git: bool,
) -> Result<(), String> {
    // Git metadata is scanned verbatim (apart from volatile lock files), not
    // through project collection rules. Its walk never consults tracked paths.
    let tracked = if git {
        Default::default()
    } else {
        workspace::project_tracked_paths(root)
    };
    scan_scoped(root, relative, entries, git, root, &[], &tracked)
}
/// A regular file observed by the directory walk whose content identity is
/// computed afterwards. Hashing and supplemental metadata dominate a project
/// scan, so they are the only work spread over threads; directories, links and
/// special entries stay on the walking thread and keep their ordering.
struct PendingFile {
    name: String,
    absolute: PathBuf,
    metadata: fs::Metadata,
}

fn scan_scoped(
    root: &Path,
    relative: &Path,
    entries: &mut BTreeMap<String, Entry>,
    git: bool,
    owner: &Path,
    exclusions: &[String],
    tracked: &std::collections::BTreeSet<String>,
) -> Result<(), String> {
    let mut files = Vec::new();
    let tracked_index = workspace::TrackedPathIndex::new(root, tracked);
    walk_scoped_with_nested(
        root,
        relative,
        entries,
        &mut files,
        git,
        owner,
        exclusions,
        &tracked_index,
        None,
        false,
    )?;
    fill_file_entries(entries, files)
}

fn scan_tree_only(
    root: &Path,
    entries: &mut BTreeMap<String, Entry>,
    exclusions: &[String],
    tracked: &std::collections::BTreeSet<String>,
) -> Result<(), String> {
    let mut files = Vec::new();
    let tracked_index = workspace::TrackedPathIndex::new(root, tracked);
    walk_scoped_with_nested(
        root,
        Path::new(""),
        entries,
        &mut files,
        false,
        root,
        exclusions,
        &tracked_index,
        None,
        true,
    )?;
    fill_file_entries_tree_only(entries, files)
}

#[allow(clippy::too_many_arguments)]
fn scan_scoped_with_links(
    root: &Path,
    relative: &Path,
    entries: &mut BTreeMap<String, Entry>,
    git: bool,
    owner: &Path,
    exclusions: &[String],
    tracked: &std::collections::BTreeSet<String>,
    nested_git: Option<&mut std::collections::BTreeSet<String>>,
) -> Result<crate::workspace_links::Topology, String> {
    let mut files = Vec::new();
    let tracked_index = workspace::TrackedPathIndex::new(root, tracked);
    walk_scoped_with_nested(
        root,
        relative,
        entries,
        &mut files,
        git,
        owner,
        exclusions,
        &tracked_index,
        nested_git,
        false,
    )?;
    fill_file_entries_with_links(entries, files)
}

/// Identity of one regular file: bytes and the supplemental metadata a project
/// view records for it.
fn file_entry(display_name: &str, absolute: &Path, metadata: &fs::Metadata) -> Result<Entry, String> {
    Ok(Entry::File {
        mode: mode(metadata),
        blob: file_blob(display_name, absolute, metadata.len())?.to_string(),
        extra: crate::workspace_metadata::capture(absolute, metadata)?,
    })
}

/// Lightweight file observation for tree-only operations (`live_tree_scoped`)
/// that never inspect or persist supplemental OS metadata (ACLs/xattrs/flags).
fn file_tree_entry(
    display_name: &str,
    absolute: &Path,
    metadata: &fs::Metadata,
) -> Result<Entry, String> {
    Ok(Entry::File {
        mode: mode(metadata),
        blob: file_blob(display_name, absolute, metadata.len())?.to_string(),
        extra: crate::workspace_metadata::Extra::default(),
    })
}

fn file_entry_with_identity(
    display_name: &str,
    absolute: &Path,
    metadata: &fs::Metadata,
) -> Result<(Entry, (u128, u64)), String> {
    let blob = file_blob(display_name, absolute, metadata.len())?.to_string();
    let (extra, identity) = crate::workspace_metadata::capture_with_identity(absolute, metadata)?;
    Ok((
        Entry::File {
            mode: mode(metadata),
            blob,
            extra,
        },
        identity,
    ))
}

/// Resolve deferred regular files into entries. Files are independent, so a
/// large project is hashed on a few threads; insertion stays deterministic
/// because the resulting map is ordered by path.
fn fill_file_entries(
    entries: &mut BTreeMap<String, Entry>,
    files: Vec<PendingFile>,
) -> Result<(), String> {
    const PARALLEL_THRESHOLD: usize = 256;
    let threads = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .min(4);
    if threads <= 1 || files.len() < PARALLEL_THRESHOLD {
        for file in files {
            let entry = file_entry(&file.name, &file.absolute, &file.metadata)?;
            entries.insert(file.name, entry);
        }
        return Ok(());
    }
    file_scan::fill(entries, files, threads)
}

fn fill_file_entries_tree_only(
    entries: &mut BTreeMap<String, Entry>,
    files: Vec<PendingFile>,
) -> Result<(), String> {
    const PARALLEL_THRESHOLD: usize = 256;
    let threads = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .min(4);
    if threads <= 1 || files.len() < PARALLEL_THRESHOLD {
        for file in files {
            let entry = file_tree_entry(&file.name, &file.absolute, &file.metadata)?;
            entries.insert(file.name, entry);
        }
        return Ok(());
    }
    file_scan::fill_tree_only(entries, files, threads)
}

fn fill_file_entries_with_links(
    entries: &mut BTreeMap<String, Entry>,
    files: Vec<PendingFile>,
) -> Result<crate::workspace_links::Topology, String> {
    const PARALLEL_THRESHOLD: usize = 256;
    let threads = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .min(4);
    if threads <= 1 || files.len() < PARALLEL_THRESHOLD {
        let mut identities = BTreeMap::new();
        for file in files {
            let (entry, identity) =
                file_entry_with_identity(&file.name, &file.absolute, &file.metadata)?;
            entries.insert(file.name.clone(), entry);
            identities.insert(file.name, identity);
        }
        return crate::workspace_links::capture_from_identities(
            identities
                .into_iter()
                .filter(|(name, _)| matches!(entries.get(name), Some(Entry::File { .. }))),
        );
    }
    file_scan::fill_with_links(entries, files, threads)
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn walk_scoped(
    root: &Path,
    relative: &Path,
    entries: &mut BTreeMap<String, Entry>,
    files: &mut Vec<PendingFile>,
    git: bool,
    owner: &Path,
    exclusions: &[String],
    tracked: &std::collections::BTreeSet<String>,
) -> Result<(), String> {
    let tracked_index = workspace::TrackedPathIndex::new(root, tracked);
    walk_scoped_with_nested(
        root,
        relative,
        entries,
        files,
        git,
        owner,
        exclusions,
        &tracked_index,
        None,
        false,
    )
}

fn is_git_entry_name(root: &Path, name: &std::ffi::OsStr) -> bool {
    if name == ".git" {
        return true;
    }
    if name.len() != 4 || !name.to_string_lossy().eq_ignore_ascii_case(".git") {
        return false;
    }
    cfg!(windows)
        || (cfg!(target_os = "macos") && crate::path_identity::case_insensitive_volume(root))
}

#[allow(clippy::too_many_arguments)]
fn walk_scoped_with_nested(
    root: &Path,
    relative: &Path,
    entries: &mut BTreeMap<String, Entry>,
    files: &mut Vec<PendingFile>,
    git: bool,
    owner: &Path,
    exclusions: &[String],
    tracked: &workspace::TrackedPathIndex<'_>,
    mut nested_git: Option<&mut std::collections::BTreeSet<String>>,
    tree_only: bool,
) -> Result<(), String> {
    for item in fs::read_dir(root.join(relative)).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let path = relative.join(item.file_name());
        if !git && is_git_entry_name(root, &item.file_name()) {
            if !relative.as_os_str().is_empty() {
                if let Some(nested) = nested_git.as_deref_mut() {
                    nested.insert(name(relative)?);
                }
            }
            continue;
        }
        // Excluded scopes (managed environments/caches) and untracked generated
        // artifacts are not part of the project view, so a scoped capture never
        // inspects their contents.
        if !git && workspace::collection_excluded_with_index(root, &path, tracked, exclusions) {
            continue;
        }
        // Lock files are volatile Git storage, not the source's repository
        // view. Captured HEAD/refs/index/config must still match after copying.
        if git
            && (git_lock(&path)
                || relative.as_os_str().is_empty()
                    && matches!(
                        item.file_name().to_str(),
                        Some("worktrees" | "commondir" | "gitdir")
                    ))
        {
            continue;
        }
        let absolute = root.join(&path);
        let display_path = path.to_string_lossy().replace('\\', "/");
        let metadata = fs::symlink_metadata(&absolute)
            .map_err(|e| map_snapshot_io_error(e, &display_path))?;
        if metadata.is_file() && !crate::workspace_symlinks::is_link(&metadata) {
            files.push(PendingFile {
                name: name(&path)?,
                absolute,
                metadata,
            });
            continue;
        }
        if tree_only {
            if crate::workspace_symlinks::is_link(&metadata) {
                entries.insert(
                    name(&path)?,
                    Entry::Link {
                        target: crate::workspace_symlinks::capture(owner, &absolute, &metadata)?,
                        extra: crate::workspace_metadata::Extra::default(),
                    },
                );
            } else if metadata.is_dir() {
                walk_scoped_with_nested(
                    root,
                    &path,
                    entries,
                    files,
                    git,
                    owner,
                    exclusions,
                    tracked,
                    nested_git.as_deref_mut(),
                    true,
                )?;
            } else if let Some((special, _)) = special_entry(&metadata) {
                if special == "socket" {
                    return Err(format!("Workspace capability gap: live Unix socket {} cannot be reconstructed as an equivalent endpoint; remove it from the source before preparing a workspace", absolute.display()));
                }
            } else {
                return Err(format!(
                    "Workspace capability gap: special project entry {}",
                    absolute.display()
                ));
            }
            continue;
        }
        let extra = crate::workspace_metadata::capture(&absolute, &metadata)?;
        let entry = if crate::workspace_symlinks::is_link(&metadata) {
            Entry::Link {
                target: crate::workspace_symlinks::capture(owner, &absolute, &metadata)?,
                extra,
            }
        } else if let Some((special, device)) = special_entry(&metadata) {
            if special == "socket" {
                return Err(format!("Workspace capability gap: live Unix socket {} cannot be reconstructed as an equivalent endpoint; remove it from the source before preparing a workspace", absolute.display()));
            }
            Entry::Special {
                special: special.into(),
                mode: mode(&metadata),
                device,
                extra,
            }
        } else if metadata.is_dir() {
            walk_scoped_with_nested(
                root,
                &path,
                entries,
                files,
                git,
                owner,
                exclusions,
                tracked,
                nested_git.as_deref_mut(),
                false,
            )?;
            Entry::Directory {
                mode: mode(&metadata),
                extra,
            }
        } else {
            return Err(format!(
                "Workspace capability gap: special project entry {}",
                absolute.display()
            ));
        };
        entries.insert(name(&path)?, entry);
    }
    Ok(())
}
fn special_entry(_metadata: &fs::Metadata) -> Option<(&'static str, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        let kind = _metadata.file_type();
        if kind.is_fifo() {
            Some(("fifo", 0))
        } else if kind.is_char_device() {
            Some(("character", _metadata.rdev()))
        } else if kind.is_block_device() {
            Some(("block", _metadata.rdev()))
        } else if kind.is_socket() {
            Some(("socket", 0))
        } else {
            None
        }
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn create_special(path: &Path, special: &str, mode: u32, device: u64) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let value =
            std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let result = match special {
            "fifo" => unsafe { libc::mkfifo(value.as_ptr(), mode as libc::mode_t) },
            "character" => unsafe {
                libc::mknod(
                    value.as_ptr(),
                    (libc::S_IFCHR | mode as libc::mode_t) as libc::mode_t,
                    device as libc::dev_t,
                )
            },
            "block" => unsafe {
                libc::mknod(
                    value.as_ptr(),
                    (libc::S_IFBLK | mode as libc::mode_t) as libc::mode_t,
                    device as libc::dev_t,
                )
            },
            other => return Err(format!("Unknown special project entry type: {other}")),
        };
        if result != 0 {
            return Err(format!(
                "Native filesystem/privileges cannot reconstruct special project entry {} ({special}): {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, special, mode, device);
        Err("Special project entries are unavailable on this host filesystem".into())
    }
}
#[cfg(target_os = "macos")]
fn collect_untracked_host_metadata(
    root: &Path,
    dir: &Path,
    tracked: &std::collections::BTreeSet<String>,
    files: &mut Vec<PathBuf>,
    dirs: &mut Vec<PathBuf>,
) -> Result<bool, String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let child = entry.path();
        let meta = fs::symlink_metadata(&child).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Ok(false);
        }
        if meta.is_dir() {
            if entry.file_name() == ".git" {
                return Ok(false);
            }
            if !collect_untracked_host_metadata(root, &child, tracked, files, dirs)? {
                return Ok(false);
            }
            dirs.push(child);
            continue;
        }
        let rel = child
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if workspace::is_host_metadata(&rel)
            && !workspace::tracked_path_matches(Some(root), tracked, &rel)
        {
            files.push(child);
        } else {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(target_os = "macos")]
fn remove_empty_or_host_metadata_dir(
    root: &Path,
    path: &Path,
    tracked: &std::collections::BTreeSet<String>,
) -> Result<(), String> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(original) => {
            if path != root
                && real_child_path(root, path, false)
                    .ok()
                    .flatten()
                    .is_some()
            {
                let mut files = Vec::new();
                let mut dirs = Vec::new();
                if collect_untracked_host_metadata(root, path, tracked, &mut files, &mut dirs)
                    .unwrap_or(false)
                {
                    for file in files {
                        fs::remove_file(file).map_err(|e| e.to_string())?;
                    }
                    for subdir in dirs {
                        fs::remove_dir(subdir).map_err(|e| e.to_string())?;
                    }
                    return fs::remove_dir(path).map_err(|e| e.to_string());
                }
            }
            Err(original.to_string())
        }
    }
}

fn remove_entry(
    root: &Path,
    tracked: &std::collections::BTreeSet<String>,
    entry: &Entry,
    path: &Path,
) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if matches!(entry, Entry::Link { .. }) || crate::workspace_symlinks::is_link(&metadata) {
        return crate::workspace_symlinks::remove(path);
    }
    if metadata.is_dir() {
        #[cfg(target_os = "macos")]
        {
            let _ = crate::workspace_cleanup::clear_macos_immutable_flags(path, &metadata);
            return remove_empty_or_host_metadata_dir(root, path, tracked);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (root, tracked);
            return fs::remove_dir(path).map_err(|e| e.to_string());
        }
    }
    let _ = (root, tracked);
    #[cfg(windows)]
    let _ = crate::workspace_cleanup::clear_readonly_attribute(path, &metadata);
    #[cfg(target_os = "macos")]
    let _ = crate::workspace_cleanup::clear_macos_immutable_flags(path, &metadata);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn inspect(source: &Path) -> Result<View, String> {
    inspect_scoped(source, source, &[])
}

fn inspect_scoped(source: &Path, owner: &Path, exclusions: &[String]) -> Result<View, String> {
    let source = host_canonical(source)?;
    let data = workspace::data_root();
    if data.exists() && workspace::scope_contains(&data, &source) {
        return Err("Runtime data is inside the source project; configure an external GRAPHER_DATA_DIR before preparing an equivalent workspace".into());
    }
    let mut entries = BTreeMap::new();
    let mut nested_git = std::collections::BTreeSet::new();
    let tracked = workspace::project_tracked_paths(&source);
    let hardlinks = scan_scoped_with_links(
        &source,
        Path::new(""),
        &mut entries,
        false,
        owner,
        exclusions,
        &tracked,
        Some(&mut nested_git),
    )?;
    let mut repositories = BTreeMap::new();
    for relative in nested_git {
        if !matches!(entries.get(&relative), Some(Entry::Directory { .. })) {
            continue;
        }
        if repositories
            .keys()
            .any(|parent: &String| Path::new(&relative).starts_with(parent))
        {
            continue;
        }
        repositories.insert(
            relative.clone(),
            inspect_scoped(&source.join(relative), owner, exclusions)?,
        );
    }
    let (git_entries, git_file, git_link, git_config, git_files, git_global) =
        inspect_git(&source)?;
    let root = fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
    let git_file_metadata = if git_file {
        let file = source.join(".git");
        let metadata = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
        Some((
            mode(&metadata),
            crate::workspace_metadata::capture(&file, &metadata)?,
        ))
    } else {
        None
    };
    let git_link_metadata = if git_link {
        let file = source.join(".git");
        let metadata = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
        Some((
            mode(&metadata),
            crate::workspace_metadata::capture(&file, &metadata)?,
        ))
    } else {
        None
    };
    Ok(View {
        schema: VIEW_SCHEMA,
        source: crate::path_identity::path_key(&source),
        root_mode: mode(&root),
        root_extra: crate::workspace_metadata::capture(&source, &root)?,
        entries,
        hardlinks,
        repositories,
        git_entries,
        git_file,
        git_file_metadata,
        git_link,
        git_link_metadata,
        git_config,
        git_files,
        git_global,
    })
}
/// Resolve a path to its host canonical spelling so macOS case/Unicode variants
/// do not make equal directory references fail exact path comparisons.
fn host_canonical(path: &Path) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(|e| e.to_string())?;
    Ok(crate::path_identity::actual_path(&resolved).unwrap_or(resolved))
}

fn git_roots(project: &Path) -> Result<Option<(PathBuf, PathBuf, bool, bool)>, String> {
    let metadata = match fs::symlink_metadata(project.join(".git")) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if workspace::project_git(project, &["rev-parse", "--is-inside-work-tree"]).as_deref()
                == Ok("true")
            {
                return Err("Workspace capability gap: implicit ancestor Git requires an independently bound project view".into());
            }
            return Ok(None);
        }
        Err(e) => return Err(e.to_string()),
    };
    let link = crate::workspace_symlinks::is_link(&metadata);
    if link
        && !fs::metadata(project.join(".git")).is_ok_and(|meta| meta.is_dir())
    {
        return Err(
            "Workspace capability gap: symbolic .git must resolve to a repository directory".into(),
        );
    }
    // Both paths come from one repository discovery. Newlines are valid in
    // Unix paths, so ambiguous output must use the original separate queries.
    let combined = workspace::project_git(
        project,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--absolute-git-dir",
            "--git-common-dir",
        ],
    )
    .ok()
    .and_then(|output| {
        let mut lines = output.split('\n');
        let current = lines.next()?.trim_end_matches('\r');
        let common = lines.next()?.trim_end_matches('\r');
        (lines.next().is_none() && !current.is_empty() && !common.is_empty())
            .then(|| (current.to_string(), common.to_string()))
    });
    let (current, common) = match combined {
        Some(paths) => paths,
        None => (
            workspace::project_git(project, &["rev-parse", "--absolute-git-dir"])?,
            workspace::project_git(
                project,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )?,
        ),
    };
    let current = host_canonical(Path::new(&current))?;
    let common = host_canonical(Path::new(&common))?;
    Ok(Some((common, current, metadata.is_file(), link)))
}
type InspectedGit = (
    Option<BTreeMap<String, Entry>>,
    bool,
    bool,
    Vec<(String, String)>,
    BTreeMap<String, (String, bool)>,
    Vec<u8>,
);

fn inspect_git(project: &Path) -> Result<InspectedGit, String> {
    let Some((common, current, git_file, git_link)) = git_roots(project)? else {
        return Ok((None, false, false, vec![], BTreeMap::new(), vec![]));
    };
    let mut entries = BTreeMap::new();
    scan(&common, Path::new(""), &mut entries, true)?;
    let root = fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
    entries.insert(
        String::new(),
        Entry::Directory {
            mode: mode(&root),
            extra: crate::workspace_metadata::capture(&current, &root)?,
        },
    );
    if common != current {
        let mut local = BTreeMap::new();
        scan(&current, Path::new(""), &mut local, true)?;
        entries.extend(local);
    }
    // Conditional includes cannot be rebound by copying alone. Refuse only
    // includes that actually apply in the source context; an unmatched
    // includeIf directive (common in host global config) must not block every
    // project. Relative/HOME-relative unconditional includes also cannot be
    // guaranteed to resolve inside the private copy.
    let effective = workspace::project_git(
        project,
        &[
            "config",
            "--null",
            "--show-scope",
            "--show-origin",
            "--list",
            "--includes",
        ],
    )?;
    let mut records = Vec::new();
    let mut fields = effective.split('\0');
    while let Some(scope) = fields.next() {
        if scope.is_empty() {
            continue;
        }
        let (Some(origin), Some(record)) = (fields.next(), fields.next()) else {
            break;
        };
        let (key, value) = record.split_once('\n').unwrap_or((record, ""));
        records.push((
            scope.to_string(),
            origin.to_string(),
            key.to_string(),
            value.to_string(),
        ));
    }
    let origin_path = |origin: &str| -> Option<PathBuf> {
        let file = origin.strip_prefix("file:")?;
        let path = PathBuf::from(file);
        Some(if path.is_absolute() {
            path
        } else {
            project.join(path)
        })
    };
    let directive = |key: &str| key == "include.path" || key.starts_with("includeif.");
    for (_, origin, key, value) in &records {
        if !directive(key) {
            continue;
        }
        let include = Path::new(value);
        let home_relative = value == "~" || value.starts_with("~/") || value.starts_with("~\\");
        if key == "include.path" {
            if home_relative || include.is_relative() {
                return Err("Workspace capability gap: HOME-relative or relative Git include needs verified private rebinding; refusing to let the private Git silently ignore it".into());
            }
            continue;
        }
        let resolved = if home_relative {
            crate::native::home_dir().map(|home| {
                home.join(
                    value
                        .trim_start_matches('~')
                        .trim_start_matches(['/', '\\']),
                )
            })
        } else if include.is_absolute() {
            Some(include.to_path_buf())
        } else {
            origin_path(origin)
                .and_then(|origin| origin.parent().map(|parent| parent.join(include)))
        };
        let Some(resolved) = resolved else {
            continue;
        };
        let matched = records.iter().any(|(_, input_origin, input_key, _)| {
            !directive(input_key)
                && origin_path(input_origin)
                    .is_some_and(|path| crate::path_identity::same_path(&path, &resolved))
        });
        if matched {
            return Err("Workspace capability gap: matched conditional Git include needs verified private rebinding; host configuration is not copied or silently ignored".into());
        }
    }
    let config = workspace::project_git(
        project,
        &["config", "--local", "--null", "--list", "--no-includes"],
    )?;
    let root = crate::native::host_path(project)
        .to_string_lossy()
        .replace('\\', "/");
    let git_config = config
        .split('\0')
        .filter(|s| !s.is_empty())
        .filter_map(|item| {
            let (key, value) = item.split_once('\n').unwrap_or((item, ""));
            if key == "core.worktree" {
                None
            } else {
                Some((
                    key.into(),
                    if path_config(key) {
                        value.replace(&root, "{workspace}")
                    } else {
                        value.into()
                    },
                ))
            }
        })
        .collect();
    let home = if is_bound(project) {
        crate::workspace_state::process_root(project)?.join(".agent-home")
    } else {
        crate::native::environment_path("HOME")
            .or_else(crate::native::home_dir)
            .ok_or("Missing Git HOME binding")?
    };
    let xdg = if is_bound(project) {
        home.join(".config")
    } else {
        crate::native::environment_path("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"))
    };
    let mut git_files = BTreeMap::new();
    for (name, key, fallback) in [
        ("excludes", "core.excludesfile", "ignore"),
        ("attributes", "core.attributesfile", "attributes"),
    ] {
        let file = workspace::project_git(project, &["config", "--path", "--get", key])
            .map(PathBuf::from)
            .unwrap_or_else(|_| xdg.join("git").join(fallback));
        // Genuine project-relative configuration stays project-relative. Host
        // resources and defaults are frozen/rebound without changing file bytes.
        if !file.is_absolute() {
            continue;
        }
        let actual_file = crate::path_identity::actual_path(&file).ok();
        let actual_project = host_canonical(project).ok();
        let relative_to_project = file.strip_prefix(project).ok().or_else(|| {
            actual_file.as_deref().and_then(|actual| {
                actual.strip_prefix(project).ok().or_else(|| {
                    actual_project
                        .as_deref()
                        .and_then(|root| actual.strip_prefix(root).ok())
                })
            })
        });
        let reference = if let Some(relative) = relative_to_project {
            format!("{{workspace}}/{}", name_of(relative)?)
        } else {
            crate::native::host_path(&file)
                .to_string_lossy()
                .replace('\\', "/")
        };
        // `config --get` uses the last effective value. The includes-aware
        // listing already records its scope, so do not spawn Git again just
        // for local/worktree classification. Keep Git's --path query above:
        // HOME/prefix expansion is Git's job, not a string substitution here.
        let local = records
            .iter()
            .rev()
            .find(|(_, _, input_key, _)| input_key == key)
            .is_some_and(|(scope, _, _, _)| matches!(scope.as_str(), "local" | "worktree"));
        git_files.insert(name.into(), (reference, local));
    }
    let git_global = if is_bound(project) {
        let file = crate::workspace_state::process_root(project)?.join(".git-config/global");
        match fs::read(file) {
            Ok(bytes) => String::from_utf8(bytes)
                .map_err(|_| "Git configuration must be UTF-8")?
                .replace(&root, "{workspace}")
                .into_bytes(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(e) => return Err(e.to_string()),
        }
    } else {
        // Reference host configuration by filename, never serialize its auth
        // values into project Git, launch records or managed HOME snapshots.
        let mut text = String::new();
        for file in [xdg.join("git/config"), home.join(".gitconfig")] {
            let value = crate::native::host_path(&file)
                .to_string_lossy()
                .replace('\\', "/");
            let value = value
                .replace(&root, "{workspace}")
                .replace('\\', "\\\\")
                .replace('"', "\\\"");
            text.push_str(&format!("[include]\n\tpath = \"{value}\"\n"));
        }
        for (name, (reference, local)) in &git_files {
            if !local {
                let key = if name == "excludes" {
                    "excludesfile"
                } else {
                    "attributesfile"
                };
                let value = reference.replace('\\', "\\\\").replace('"', "\\\"");
                text.push_str(&format!("[core]\n\t{key} = \"{value}\"\n"));
            }
        }
        text.into_bytes()
    };
    Ok((
        Some(entries),
        git_file,
        git_link,
        git_config,
        git_files,
        git_global,
    ))
}
fn copy_project_git(
    project: &Path,
    target: &Path,
    git_entries: &BTreeMap<String, Entry>,
) -> Result<(), String> {
    let (common, current, _, _) = git_roots(project)?.ok_or("Missing project Git")?;
    fs::create_dir(target).map_err(|e| e.to_string())?;
    native_copy::copy_tree(&common, target, |relative| {
        git_lock(relative)
            || relative
                .components()
                .next()
                .is_some_and(|part| part.as_os_str() == "worktrees")
    })?;
    if common != current {
        // Worktree-specific HEAD/index/logs override common metadata. No gitdir
        // or commondir backlink to a source/sibling survives the private copy.
        for item in fs::read_dir(&current).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let name = item.file_name();
            if matches!(name.to_str(), Some("gitdir" | "commondir")) || git_lock(Path::new(&name)) {
                continue;
            }
            let destination = target.join(&name);
            if item.file_type().map_err(|e| e.to_string())?.is_dir() {
                // Common logs/refs coexist with worktree-specific logs/HEAD;
                // replacing the entire directory would lose user reflogs.
                if let Ok(meta) = fs::symlink_metadata(&destination) {
                    if crate::workspace_symlinks::is_link(&meta) || !meta.is_dir() {
                        crate::workspace_symlinks::remove(&destination)?;
                    }
                }
                fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
                clear_git_overlays(&item.path(), &destination)?;
                native_copy::copy_tree(&item.path(), &destination, |_| false)?;
            } else {
                if let Ok(meta) = fs::symlink_metadata(&destination) {
                    if meta.is_dir() && !crate::workspace_symlinks::is_link(&meta) {
                        crate::workspace_cleanup::remove_tree(&destination)
                            .map_err(|e| e.to_string())?;
                    } else {
                        crate::workspace_symlinks::remove(&destination)?;
                    }
                }
                native_copy::copy(&item.path(), &destination)?;
            }
        }
    }
    if common.join("objects/info/alternates").is_file() {
        // Import only objects reachable from genuine refs/reflogs/index, never
        // every dangling object in a possibly mixed borrowed object store.
        let objects = crate::native::host_path(&common.join("objects"))
            .to_string_lossy()
            .replace('\\', "/");
        fs::write(
            target.join("objects/info/alternates"),
            format!("{objects}\n"),
        )
        .map_err(|e| e.to_string())?;
        let metadata = target.to_str().ok_or("Invalid private project Git")?;
        workspace::project_git(
            target,
            &[
                "--git-dir",
                metadata,
                "--work-tree",
                metadata,
                "-c",
                "core.longpaths=true",
                "repack",
                "-a",
                "--no-write-bitmap-index",
            ],
        )?;
        fs::remove_file(target.join("objects/info/alternates")).map_err(|e| e.to_string())?;
        workspace::project_git(
            target,
            &[
                "--git-dir",
                metadata,
                "--work-tree",
                metadata,
                "fsck",
                "--full",
                "--no-dangling",
            ],
        )?;
    }
    restore_git_metadata(target, git_entries)
}
// Both trees are newly allocated private evidence, never source/user data.
// Remove only leaves that the worktree-specific copy will actually replace.
fn clear_git_overlays(source: &Path, target: &Path) -> Result<(), String> {
    for item in fs::read_dir(source).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let destination = target.join(item.file_name());
        let existing = match fs::symlink_metadata(&destination) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        if item.file_type().map_err(|e| e.to_string())?.is_dir()
            && existing.is_dir()
            && !crate::workspace_symlinks::is_link(&existing)
        {
            clear_git_overlays(&item.path(), &destination)?;
        } else if existing.is_dir() && !crate::workspace_symlinks::is_link(&existing) {
            crate::workspace_cleanup::remove_tree(&destination).map_err(|e| e.to_string())?;
        } else {
            crate::workspace_symlinks::remove(&destination)?;
        }
    }
    Ok(())
}
fn nested_record(record: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || !Path::new(relative)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Unsafe nested repository path".into());
    }
    Ok(record.join("repositories").join(
        git2::Oid::hash_object(git2::ObjectType::Blob, relative.as_bytes())
            .map_err(|e| e.to_string())?
            .to_string(),
    ))
}
fn copy_project_repositories(project: &Path, record: &Path, view: &View) -> Result<(), String> {
    if let Some(git_entries) = &view.git_entries {
        copy_project_git(project, &record.join("git"), git_entries)?;
    }
    for (relative, child) in &view.repositories {
        let destination = nested_record(record, relative)?;
        fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
        copy_project_repositories(&project.join(relative), &destination, child)?;
    }
    Ok(())
}
fn copy_recorded_repositories(
    source: &Path,
    destination: &Path,
    view: &View,
) -> Result<(), String> {
    if let Some(git_entries) = &view.git_entries {
        copy_git(
            &source.join("git"),
            &destination.join("git"),
            Some(git_entries),
        )?;
    }
    for (relative, child) in &view.repositories {
        let target = nested_record(destination, relative)?;
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        copy_recorded_repositories(&nested_record(source, relative)?, &target, child)?;
    }
    Ok(())
}
fn set_source_keys(view: &mut View, source: &Path) {
    view.source = crate::path_identity::path_key(source);
    for (relative, child) in &mut view.repositories {
        set_source_keys(child, &source.join(relative));
    }
}
fn prepare_repositories(
    owner: &Path,
    project: &Path,
    base_record: &Path,
    base: &View,
    inputs: &[(PathBuf, View)],
) -> Result<(), String> {
    let names = base
        .repositories
        .keys()
        .chain(inputs.iter().flat_map(|(_, view)| view.repositories.keys()))
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    for relative in names {
        let target = project.join(&relative);
        let baseline = base.repositories.get(&relative);
        let children = inputs
            .iter()
            .filter_map(|(record, view)| {
                view.repositories.get(&relative).map(|child| {
                    nested_record(record, &relative).map(|record| (record, child.clone()))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let removed = baseline.is_some()
            && inputs
                .iter()
                .any(|(_, view)| !view.repositories.contains_key(&relative));
        if removed {
            if children.iter().any(|(_, child)| {
                baseline.is_some_and(|base| child.git_entries != base.git_entries)
            }) {
                return Err(format!(
                    "Nested Git deletion conflicts with task history at {relative}"
                ));
            }
            if target.join(".git").exists() {
                let retained = crate::workspace_state::root(owner)?
                    .join(format!("retained-git-{}", uuid::Uuid::new_v4()));
                fs::rename(target.join(".git"), retained).map_err(|e| e.to_string())?;
            }
            continue;
        }
        let baseline_record = nested_record(base_record, &relative)?;
        let (record, selected) = children
            .last()
            .map(|(record, child)| (record.clone(), child))
            .or_else(|| baseline.map(|child| (baseline_record.clone(), child)))
            .ok_or("Missing nested Git input")?;
        real_child_path(owner, &target, false)?;
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        ensure_project_git(owner, &target, &record, selected)?;
        compose_project_history(&target, &children)?;
        let indices = children
            .iter()
            .map(|(record, _)| record.join("git"))
            .collect::<Vec<_>>();
        let index_base = if baseline.is_some() {
            baseline_record.join("git")
        } else {
            record.join("git")
        };
        crate::workspace_git_index::compose(&target, &index_base, &indices, &record.join("git"))?;
        let (common, current, _, _) =
            git_roots(&target)?.ok_or("Nested repository lost its Git view")?;
        let native = host_canonical(&target.join(".git"))?;
        let state = host_canonical(&crate::workspace_state::process_root(owner)?)?;
        if common != current || !(common == native || common.starts_with(state)) {
            return Err("Nested project Git points outside its private binding".into());
        }
        if !crate::path_identity::same_path(
            Path::new(&workspace::project_git(
                &target,
                &["rev-parse", "--show-toplevel"],
            )?),
            &target,
        ) {
            return Err("Nested Git worktree was redirected".into());
        }
        prepare_repositories(
            owner,
            &target,
            &baseline_record,
            baseline.unwrap_or(selected),
            &children,
        )?;
    }
    Ok(())
}
fn record_path(repository: &Path, head: &str) -> Result<PathBuf, String> {
    if !matches!(head.len(), 40 | 64) || !head.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid workspace-view code reference".into());
    }
    Ok(workspace::shadow_repo_dir(repository)?
        .join("agent-views")
        .join(head))
}
/// Versioned checksum/equality projection including ACLs and all project path names.
fn normalized_bytes(view: &View) -> Result<Vec<u8>, String> {
    normalization::bytes(view)
}

#[cfg(test)]
fn legacy_normalized_bytes(view: &View) -> Result<Vec<u8>, String> {
    encode_normalized_value(serde_json::to_value(view).map_err(|e| e.to_string())?)
}

#[cfg(test)]
fn encode_normalized_value(mut value: serde_json::Value) -> Result<Vec<u8>, String> {
    fn remove_git_index(value: &mut serde_json::Value) {
        if let serde_json::Value::Object(map) = value {
            if let Some(entries) = map.get_mut("git_entries").and_then(|v| v.as_object_mut()) {
                entries.remove("index");
            }
            if let Some(repos) = map.get_mut("repositories").and_then(|v| v.as_object_mut()) {
                for repo in repos.values_mut() {
                    remove_git_index(repo);
                }
            }
        }
    }
    remove_git_index(&mut value);
    serde_json::to_vec(&value).map_err(|e| e.to_string())
}

/// Bind the checksum to this immutable borrow, not to a path or cached scan.
/// Validation and persistence can share it without normalizing a large view
/// twice; the borrow prevents the evidence from changing before it is saved.
struct ViewRecord<'a> {
    view: &'a View,
    identity: String,
}
impl<'a> ViewRecord<'a> {
    fn new(view: &'a View) -> Result<Self, String> {
        Ok(Self {
            view,
            identity: node_view_identity(view)?,
        })
    }
    fn save(&self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec(self.view).map_err(|e| e.to_string())?;
        fs::write(path.join("view.json"), bytes).map_err(|e| e.to_string())?;
        fs::write(path.join("checksum"), &self.identity).map_err(|e| e.to_string())
    }
}
fn save(path: &Path, view: &View) -> Result<(), String> {
    ViewRecord::new(view)?.save(path)
}
fn load(path: &Path) -> Result<View, String> {
    let bytes = fs::read(path.join("view.json")).map_err(|e| format!("Missing complete project-view evidence: {e}; start a new Run (existing workspace retained)"))?;
    let expected = fs::read_to_string(path.join("checksum")).map_err(|e| e.to_string())?;
    let mut view: View = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    view.validate_schema()?;
    if git2::Oid::hash_object(git2::ObjectType::Blob, &normalized_bytes(&view)?)
        .map_err(|e| e.to_string())?
        .to_string()
        != expected
    {
        return Err("Damaged project-view evidence; refusing a partial reconstruction".into());
    }
    for key in view.entries.keys() {
        if !Path::new(key)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
            || Path::new(key)
                .components()
                .any(|part| part.as_os_str() == ".git")
        {
            return Err("Unsafe project-view entry".into());
        }
    }
    view.strip_system_managed();
    Ok(view)
}
fn restore_git_metadata(target: &Path, entries: &BTreeMap<String, Entry>) -> Result<(), String> {
    for (name, entry) in entries.iter().rev() {
        if name == "objects/info/alternates" && !target.join(name).exists() {
            continue;
        }
        restore_entry(&target.join(name), entry)?;
    }
    Ok(())
}
fn copy_git(
    source: &Path,
    target: &Path,
    recorded: Option<&BTreeMap<String, Entry>>,
) -> Result<(), String> {
    fs::create_dir(target).map_err(|e| e.to_string())?;
    native_copy::copy_tree(source, target, git_lock)?;
    if let Some(entries) =
        recorded.filter(|entries| !entries.contains_key("objects/info/alternates"))
    {
        return restore_git_metadata(target, entries);
    }
    let mut entries = BTreeMap::new();
    scan(source, Path::new(""), &mut entries, true)?;
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    entries.insert(
        String::new(),
        Entry::Directory {
            mode: mode(&metadata),
            extra: crate::workspace_metadata::capture(source, &metadata)?,
        },
    );
    restore_git_metadata(target, &entries)
}

/// Raw capture avoids clean/smudge/EOL filters changing the physical baseline.
/// The index belongs to graph Git, never the source or visible project Git.
pub(crate) fn stage_project(path: &Path, metadata: &Path) -> Result<String, String> {
    stage_project_scoped(path, metadata, &[])
}

pub(crate) fn stage_project_scoped(
    path: &Path,
    metadata: &Path,
    exclusions: &[String],
) -> Result<String, String> {
    let mut entries = BTreeMap::new();
    let tracked = workspace::project_tracked_paths(path);
    scan_tree_only(path, &mut entries, exclusions, &tracked)?;
    stage_project_entries_inner(path, metadata, &entries, true, None)
}

/// Compute the live project tree without inspecting supplemental OS metadata
/// (ACLs/xattrs/flags) and, for SHA-1 repositories, without mutating the shadow
/// index on disk or spawning `git read-tree`/`git write-tree`.
pub(crate) fn live_tree_scoped(
    path: &Path,
    metadata: &Path,
    exclusions: &[String],
    old_head: Option<&str>,
) -> Result<String, String> {
    let mut entries = BTreeMap::new();
    let tracked = workspace::project_tracked_paths(path);
    scan_tree_only(path, &mut entries, exclusions, &tracked)?;
    stage_project_entries_inner(path, metadata, &entries, false, old_head)
}

/// Stage using the fresh observation already inspected for this source snapshot,
/// avoiding a redundant full-tree scan.
pub(crate) fn stage_project_with_view(
    path: &Path,
    metadata: &Path,
    view: &View,
) -> Result<String, String> {
    stage_project_entries_inner(path, metadata, &view.entries, true, None)
}

/// Consume a fresh observation of this single-writer workspace. This is not a
/// cache: the caller discards it after staging, and node completion still makes
/// its independent post-import inspection before recording the result view.
fn stage_project_entries(
    path: &Path,
    metadata: &Path,
    entries: BTreeMap<String, Entry>,
) -> Result<String, String> {
    stage_project_entries_inner(path, metadata, &entries, true, None)
}

fn stage_project_entries_inner(
    path: &Path,
    metadata: &Path,
    entries: &BTreeMap<String, Entry>,
    update_index: bool,
    old_head: Option<&str>,
) -> Result<String, String> {
    // macOS host bookkeeping is not project output. Match the exact same
    // project-Git tracking boundary used by `walk_scoped_with_nested`, so a
    // newly staged (uncommitted) `.DS_Store` in the project `.git` stays
    // consistent between `view.json` and the graph Git tree.
    let macos_tracked = if cfg!(target_os = "macos")
        && entries.keys().any(|name| workspace::is_host_metadata(name))
    {
        Some(workspace::project_tracked_paths(path))
    } else {
        None
    };
    let macos_tracked_index = macos_tracked
        .as_ref()
        .map(|tracked| workspace::TrackedPathIndex::new(path, tracked));
    let repository = match git2::Repository::open(metadata) {
        Ok(repo)
            if repo
                .config()
                .and_then(|cfg| cfg.get_string("extensions.objectformat"))
                .ok()
                .as_deref()
                != Some("sha256") =>
        {
            repo
        }
        result => {
            let format = workspace::git(
                path,
                &[
                    "--git-dir",
                    metadata.to_str().ok_or("Invalid graph Git")?,
                    "rev-parse",
                    "--show-object-format=storage",
                ],
            )?;
            if format == "sha256" {
                #[cfg(windows)]
                if let Some(head) = old_head {
                    workspace::git(
                        path,
                        &[
                            "--git-dir",
                            metadata.to_str().ok_or("Invalid graph Git")?,
                            "--work-tree",
                            path.to_str().ok_or("Invalid project root")?,
                            "read-tree",
                            head,
                        ],
                    )?;
                }
                let mut filtered = entries.clone();
                if let Some(tracked) = &macos_tracked_index {
                    filtered.retain(|name, _| {
                        !workspace::is_host_metadata(name) || tracked.matches(name)
                    });
                }
                stage_sha256(path, metadata, filtered)?;
                return workspace::git(
                    path,
                    &[
                        "--git-dir",
                        metadata.to_str().ok_or("Invalid graph Git")?,
                        "--work-tree",
                        path.to_str().ok_or("Invalid project root")?,
                        "write-tree",
                    ],
                );
            }
            result.map_err(|e| e.to_string())?
        }
    };
    // Keep Git's index instead of duplicating every path/mode in another tree.
    // Only Windows needs an old mode (its filesystem has no executable bit).
    // When `old_head` is supplied (`live_tree_scoped`), inspect that commit's
    // tree directly instead of mutating the shadow index on disk.
    let old_tree = if cfg!(windows) {
        old_head
            .map(|head| {
                let oid = git2::Oid::from_str(head).map_err(|e| e.to_string())?;
                repository
                    .find_commit(oid)
                    .and_then(|commit| commit.tree())
                    .map_err(|e| e.to_string())
            })
            .transpose()?
    } else {
        None
    };
    let old_index = if update_index || (cfg!(windows) && old_tree.is_none()) {
        Some(repository.index().map_err(|e| e.to_string())?)
    } else {
        None
    };
    let mut index = git2::Index::new().map_err(|e| e.to_string())?;
    // Reuse the database handle throughout this staging pass. Entries came
    // from this capture's fresh byte scan, never a prior execution's cache;
    // stored objects still have their type and size checked below.
    let odb = repository.odb().map_err(|e| e.to_string())?;
    let mut verified_existing: BTreeMap<git2::Oid, u64> = BTreeMap::new();
    let mut missing_small: BTreeMap<git2::Oid, (String, PathBuf, u64, Vec<(String, PathBuf)>)> =
        BTreeMap::new();
    for (name, entry) in entries {
        if let Some(tracked) = &macos_tracked_index {
            if workspace::is_host_metadata(name) && !tracked.matches(name) {
                continue;
            }
        }
        let (oid, mode) = match entry {
            Entry::Directory { .. } => continue,
            Entry::Special { .. } => continue,
            Entry::File { mode, blob, .. } => {
                // `scan` already hashed these bytes. Reuse that object id and
                // only read the file when the object is not yet stored, instead
                // of reading and hashing every project file twice on each
                // snapshot. A stored object is re-checked by size so a truncated
                // or grown file is still refused; the slot is single-writer, so a
                // same-size rewrite cannot race the binding scan.
                let oid = git2::Oid::from_str(blob).map_err(|e| e.to_string())?;
                let file = path.join(name);
                let len = fs::metadata(&file)
                    .map_err(|e| map_snapshot_io_error(e, name))?
                    .len();
                if let Some(&expected_size) = verified_existing.get(&oid) {
                    if expected_size != len {
                        return Err(snapshot_changed_error(name, false));
                    }
                } else if let Some((_, _, expected_size, duplicates)) = missing_small.get_mut(&oid)
                {
                    if *expected_size != len {
                        return Err(snapshot_changed_error(name, false));
                    }
                    duplicates.push((name.clone(), file));
                } else if odb.exists(oid) {
                    let (size, kind) = odb.read_header(oid).map_err(|e| e.to_string())?;
                    if kind != git2::ObjectType::Blob || size as u64 != len {
                        return Err(snapshot_changed_error(name, false));
                    }
                    verified_existing.insert(oid, size as u64);
                } else if len <= 8 * 1024 * 1024 {
                    missing_small.insert(oid, (name.clone(), file, len, Vec::new()));
                } else {
                    let file_host = crate::native::host_path(&file);
                    let stored = workspace::git(
                        path,
                        &[
                            "--git-dir",
                            metadata.to_str().ok_or("Invalid graph metadata path")?,
                            "hash-object",
                            "-w",
                            "--no-filters",
                            "--",
                            file_host.to_str().ok_or("Invalid file path")?,
                        ],
                    )?;
                    let stored = git2::Oid::from_str(&stored).map_err(|e| e.to_string())?;
                    if stored != oid {
                        return Err(snapshot_changed_error(name, false));
                    }
                    verified_existing.insert(oid, len);
                }
                let executable = if cfg!(unix) {
                    mode & 0o111 != 0
                } else if let Some(tree) = &old_tree {
                    tree.get_path(Path::new(name))
                        .is_ok_and(|entry| entry.filemode() == 0o100755)
                } else if let Some(old_index) = &old_index {
                    old_index
                        .get_path(Path::new(name), 0)
                        .and_then(|entry| {
                            // Preserve the old byte-exact lookup even if libgit2's
                            // ignore-case index finds a differently spelled entry.
                            // Only that uncommon collision needs a linear search.
                            if entry.path == name.as_bytes() {
                                Some(entry)
                            } else {
                                old_index.iter().find(|entry| entry.path == name.as_bytes())
                            }
                        })
                        .is_some_and(|entry| entry.mode == 0o100755)
                } else {
                    false
                };
                (oid, if executable { 0o100755 } else { 0o100644 })
            }
            Entry::Link { target, .. } => (
                repository
                    .blob(target.value.as_bytes())
                    .map_err(|e| e.to_string())?,
                0o120000,
            ),
        };
        index
            .add(&git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: oid,
                flags: 0,
                flags_extended: 0,
                path: name.as_bytes().to_vec(),
            })
            .map_err(|e| e.to_string())?;
    }
    if !missing_small.is_empty() {
        write_missing_blobs(metadata, &repository, missing_small)?;
    }
    let tree = index
        .write_tree_to(&repository)
        .map_err(|e| e.to_string())?;
    let tree_hex = tree.to_string();
    if update_index {
        workspace::git(
            path,
            &[
                "--git-dir",
                metadata.to_str().ok_or("Invalid graph metadata path")?,
                "--work-tree",
                path.to_str().ok_or("Invalid project root")?,
                "read-tree",
                &tree_hex,
            ],
        )?;
    }
    Ok(tree_hex)
}

type MissingBlobEntry = (String, PathBuf, u64, Vec<(String, PathBuf)>);

fn write_missing_blobs_fast_import(
    metadata: &Path,
    missing: &BTreeMap<git2::Oid, MissingBlobEntry>,
) -> Result<(), String> {
    use std::io::Write;
    const BATCH_ENTRIES: usize = 512;
    const BATCH_BYTES: usize = 16 * 1024 * 1024;
    let metadata_text = metadata.to_str().ok_or("Invalid graph metadata path")?;
    let args = [
        "--git-dir",
        metadata_text,
        "fast-import",
        "--quiet",
        "--done",
    ];
    let mut input = Vec::new();
    let mut count = 0usize;
    let mut payload = 0usize;
    let flush = |input: &mut Vec<u8>, count: &mut usize, payload: &mut usize| -> Result<(), String> {
        if *count == 0 {
            return Ok(());
        }
        input.extend_from_slice(b"done\n");
        workspace::git_bytes(metadata, &args, None, Some(input))?;
        input.clear();
        *count = 0;
        *payload = 0;
        Ok(())
    };
    for (oid, (rel_name, file, expected_len, duplicates)) in missing {
        let bytes = fs::read(file).map_err(|e| map_snapshot_io_error(e, rel_name))?;
        if bytes.len() as u64 != *expected_len
            || git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
                .map_err(|e| e.to_string())?
                != *oid
        {
            return Err(snapshot_changed_error(rel_name, false));
        }
        for (dup_name, duplicate) in duplicates {
            let dup_bytes = fs::read(duplicate).map_err(|e| map_snapshot_io_error(e, dup_name))?;
            if dup_bytes.len() as u64 != *expected_len
                || git2::Oid::hash_object(git2::ObjectType::Blob, &dup_bytes)
                    .map_err(|e| e.to_string())?
                    != *oid
            {
                return Err(snapshot_changed_error(dup_name, false));
            }
        }
        if count >= BATCH_ENTRIES || (count > 0 && payload + bytes.len() > BATCH_BYTES) {
            flush(&mut input, &mut count, &mut payload)?;
        }
        write!(&mut input, "blob\ndata {}\n", bytes.len()).map_err(|e| e.to_string())?;
        input.extend_from_slice(&bytes);
        input.push(b'\n');
        count += 1;
        payload += bytes.len();
    }
    flush(&mut input, &mut count, &mut payload)
}

fn write_missing_blobs(
    metadata: &Path,
    repository: &git2::Repository,
    missing: BTreeMap<git2::Oid, MissingBlobEntry>,
) -> Result<(), String> {
    const PACK_IMPORT_THRESHOLD: usize = 512;
    if missing.len() >= PACK_IMPORT_THRESHOLD {
        return write_missing_blobs_fast_import(metadata, &missing);
    }
    const PARALLEL_BLOB_THRESHOLD: usize = 32;
    let threads = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .min(4);
    let write_one = |repo: &git2::Repository,
                     oid: git2::Oid,
                     rel_name: &str,
                     file: &Path,
                     expected_len: u64,
                     duplicates: &[(String, PathBuf)]|
     -> Result<(), String> {
        let bytes = fs::read(file).map_err(|e| map_snapshot_io_error(e, rel_name))?;
        if bytes.len() as u64 != expected_len {
            return Err(snapshot_changed_error(rel_name, false));
        }
        let stored = repo.blob(&bytes).map_err(|e| e.to_string())?;
        if stored != oid {
            return Err(snapshot_changed_error(rel_name, false));
        }
        for (dup_name, duplicate) in duplicates {
            let dup_bytes = fs::read(duplicate).map_err(|e| map_snapshot_io_error(e, dup_name))?;
            if dup_bytes.len() as u64 != expected_len
                || git2::Oid::hash_object(git2::ObjectType::Blob, &dup_bytes)
                    .map_err(|e| e.to_string())?
                    != oid
            {
                return Err(snapshot_changed_error(dup_name, false));
            }
        }
        Ok(())
    };
    if threads <= 1 || missing.len() < PARALLEL_BLOB_THRESHOLD {
        for (oid, (rel_name, file, expected_len, duplicates)) in missing {
            write_one(repository, oid, &rel_name, &file, expected_len, &duplicates)?;
        }
        return Ok(());
    }
    let objects_dir = metadata.join("objects");
    let mut fanouts = std::collections::BTreeSet::new();
    for oid in missing.keys() {
        let hex = oid.to_string();
        fanouts.insert(hex[..2].to_string());
    }
    for prefix in fanouts {
        fs::create_dir_all(objects_dir.join(prefix)).map_err(|e| e.to_string())?;
    }
    let items: Vec<(git2::Oid, String, PathBuf, u64, Vec<(String, PathBuf)>)> = missing
        .into_iter()
        .map(|(oid, (rel_name, file, len, duplicates))| (oid, rel_name, file, len, duplicates))
        .collect();
    let results: Vec<std::sync::OnceLock<Result<(), String>>> = (0..items.len())
        .map(|_| std::sync::OnceLock::new())
        .collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                let items = &items;
                let results = &results;
                let next = &next;
                scope.spawn(move || -> Result<(), String> {
                    let repo = git2::Repository::open(metadata).map_err(|e| e.to_string())?;
                    loop {
                        let idx = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some((oid, rel_name, file, expected_len, duplicates)) = items.get(idx)
                        else {
                            break;
                        };
                        let res = write_one(&repo, *oid, rel_name, file, *expected_len, duplicates);
                        let failed = res.is_err();
                        let _ = results[idx].set(res);
                        if failed {
                            break;
                        }
                    }
                    Ok(())
                })
            })
            .collect();
        let mut worker_err = None;
        for handle in handles {
            match handle.join() {
                Ok(Ok(())) => {}
                Ok(Err(err)) if worker_err.is_none() => worker_err = Some(err),
                Ok(Err(_)) => {}
                Err(_) if worker_err.is_none() => {
                    worker_err = Some("Project blob writer panicked".to_string());
                }
                Err(_) => {}
            }
        }
        if let Some(err) = worker_err {
            return Err(err);
        }
        Ok(())
    })?;
    for slot in &results {
        if let Some(Err(error)) = slot.get() {
            return Err(error.clone());
        }
    }
    if results.iter().any(|slot| slot.get().is_none()) {
        return Err("Project blob writer left an unwritten object".into());
    }
    Ok(())
}

fn stage_sha256(
    path: &Path,
    metadata: &Path,
    entries: BTreeMap<String, Entry>,
) -> Result<(), String> {
    sha256_stage::stage(path, metadata, entries)
}

pub(crate) fn has_record(source: &Path, head: &str) -> bool {
    record_path(source, head).is_ok_and(|path| path.join("view.json").is_file())
}

/// Inspect the project exactly as a full source snapshot would, so a caller can
/// derive the identity and the recorded view from one scan.
pub(crate) fn inspect_source_scoped(source: &Path, exclusions: &[String]) -> Result<View, String> {
    inspect_scoped(source, source, exclusions)
}
/// A Git tree can stay unchanged while project metadata or empty directories
/// change. Never reuse an existing code reference for a different source view.
pub(crate) fn source_record_changed(
    source: &Path,
    head: &str,
    view: &View,
) -> Result<bool, String> {
    if !has_record(source, head) {
        return Ok(false);
    }
    Ok(load(&record_path(source, head)?)? != *view)
}

/// Source edits and terminal heads can diverge after a node forks. Compare their
/// supplemental metadata against their recorded common ancestor; otherwise a
/// node that never saw a new source directory looks like it deleted it.
pub(crate) fn composition_base(
    source: &Path,
    base: &str,
    parents: &[String],
) -> Result<String, String> {
    let mut heads = vec![base];
    for parent in parents {
        if !heads.contains(&parent.as_str()) {
            heads.push(parent);
        }
    }
    if heads.len() < 2 {
        return Ok(base.into());
    }
    let mut args = vec!["merge-base", "--octopus", "--all"];
    args.extend(heads);
    let common = workspace::repository_git(source, &args)?;
    let mut candidates = common.lines();
    if let (Some(head), None) = (candidates.next(), candidates.next()) {
        if has_record(source, head) {
            return Ok(head.into());
        }
    }
    Err("Missing or ambiguous common project-view evidence; refusing to discard source or node metadata during publication".into())
}
/// Identity of an already inspected source view. The raw serialized view is the
/// snapshot identity; recorded node views compare normalized bytes instead.
pub(crate) fn view_identity(view: &View) -> Result<String, String> {
    let bytes = serde_json::to_vec(view).map_err(|e| e.to_string())?;
    Ok(git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
        .map_err(|e| e.to_string())?
        .to_string())
}
pub(crate) fn capture_source(source: &Path, head: &str, identity: &str) -> Result<(), String> {
    capture_source_view(source, head, identity, &[], None)
}
/// Capture evidence from a view the caller already inspected for this snapshot,
/// so recording a snapshot does not rescan the whole source tree.
pub(crate) fn capture_source_with_view(
    source: &Path,
    head: &str,
    identity: &str,
    exclusions: &[String],
    view: View,
) -> Result<(), String> {
    capture_source_view(source, head, identity, exclusions, Some(view))
}
/// Capture a source view that omits managed environment/cache scopes, so a
/// scoped snapshot (files-only publication) still has reconstructable evidence
/// without inspecting excluded contents.
pub(crate) fn capture_source_scoped(
    source: &Path,
    head: &str,
    exclusions: &[String],
) -> Result<(), String> {
    capture_source_view(source, head, "", exclusions, None)
}
struct PendingDirGuard(Option<PathBuf>);
impl PendingDirGuard {
    fn new(path: PathBuf) -> Self {
        Self(Some(path))
    }
    fn disarm(&mut self) {
        self.0 = None;
    }
}
impl Drop for PendingDirGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = crate::workspace_cleanup::remove_tree(&path);
        }
    }
}

fn capture_source_view(
    source: &Path,
    head: &str,
    identity: &str,
    exclusions: &[String],
    inspected: Option<View>,
) -> Result<(), String> {
    let view = match inspected {
        Some(view) => view,
        None => inspect_scoped(source, source, exclusions)?,
    };
    // Source snapshot identity uses raw bytes, not the normalized checksum of
    // a saved view. Keep those contracts separate (including legacy records).
    let observed_identity = view_identity(&view)?;
    if !identity.is_empty() && observed_identity != identity {
        return Err("Source changed while capturing its workspace; retry preparation".into());
    }
    let target = record_path(source, head)?;
    if target.exists() {
        if load(&target)? != view {
            return Err("Source view identity changed for an existing code snapshot".into());
        }
        return Ok(());
    }
    fs::create_dir_all(target.parent().ok_or("Missing view store")?).map_err(|e| e.to_string())?;
    let pending = target.with_extension(format!("pending-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&pending).map_err(|e| e.to_string())?;
    let mut pending_guard = PendingDirGuard::new(pending.clone());
    copy_project_repositories(source, &pending, &view)?;
    let after = inspect_scoped(source, source, exclusions)?;
    if after != view {
        return Err(match equality::first_diff_detail(&view, &after) {
            Some(detail) => format!(
                "Source changed while copying project Git ({detail}); original data retained, retry preparation"
            ),
            None => "Source changed while copying project Git; original data retained, retry preparation".into(),
        });
    }
    save(&pending, &view)?;
    if let Err(error) = fs::rename(&pending, &target) {
        // A concurrent writer may have published the same immutable record first.
        if target.exists() && load(&target).ok().as_ref() == Some(&view) {
            return Ok(());
        } else {
            return Err(format!(
                "Cannot publish project-view record {}: {error}",
                target.display()
            ));
        }
    }
    pending_guard.disarm();
    Ok(())
}

fn binding(path: &Path) -> Result<PathBuf, String> {
    Ok(crate::workspace_state::root(path)?.join("project-view"))
}
pub(crate) fn is_bound(path: &Path) -> bool {
    binding(path).is_ok_and(|file| {
        fs::symlink_metadata(file).is_ok_and(|metadata| {
            metadata.is_file() && !crate::workspace_symlinks::is_link(&metadata)
        })
    })
}
pub(crate) fn owner(path: &Path) -> Option<&Path> {
    path.ancestors().find(|path| is_bound(path))
}
pub(crate) fn validate_bound(path: &Path, source: &Path) -> Result<(), String> {
    let binding = binding(path)?;
    let root = crate::workspace_state::root(path)?;
    let missing = "Private workspace has no source-equivalent view; start a new Run (existing workspace retained)";
    // A missing process root is the same legacy/unbound state as a missing
    // binding file. Report it as such instead of an unrelated OS path error.
    crate::path_safety::real_child_path(&root, &binding, true)
        .map_err(|_| missing.to_string())?
        .ok_or_else(|| missing.to_string())?;
    let bytes = fs::read(binding).map_err(|_| missing.to_string())?;
    let key = crate::path_identity::path_key(source);
    if bytes != key.as_bytes() {
        return Err("Private workspace project binding changed".into());
    }
    Ok(())
}
/// The private copy of the project Git for `path`. Nested repositories and
/// gitfile/link layouts keep it beside the slot's external state instead of in
/// the worktree.
fn private_project_git(owner: &Path, path: &Path, view: &View) -> Result<Option<PathBuf>, String> {
    if view.git_entries.is_none() {
        return Ok(None);
    }
    let state = crate::workspace_state::process_root(owner)?;
    Ok(Some(if view.git_file || view.git_link {
        if owner == path {
            state.join(".project-git")
        } else {
            state.join(format!(
                ".project-git-{}",
                git2::Oid::hash_object(
                    git2::ObjectType::Blob,
                    name(path.strip_prefix(owner).map_err(|e| e.to_string())?)?.as_bytes()
                )
                .map_err(|e| e.to_string())?
            ))
        }
    } else {
        path.join(".git")
    }))
}
/// True when the slot's native project Git already sits on the recorded code
/// reference. A slot reused from another execution keeps the previous base in
/// its native history, while graph `checkout -f` already moved the working
/// files to this one; preparation is deterministic, so the native repository
/// must follow the record exactly as a fresh slot would.
fn project_git_follows_record(owner: &Path, path: &Path, record: &Path) -> Result<bool, String> {
    if !crate::workspace_state::process_root(owner)?
        .join(".git-config/global")
        .is_file()
    {
        return Ok(false);
    }
    if !workspace::project_git(path, &["rev-parse", "--show-toplevel"])
        .is_ok_and(|top| crate::path_identity::same_path(Path::new(&top), path))
    {
        return Ok(false);
    }
    let git = record.join("git");
    let dir = git.to_str().ok_or("Invalid recorded project Git path")?;
    let Ok(recorded) = workspace::project_git(
        &git,
        &[
            "--git-dir",
            dir,
            "--work-tree",
            dir,
            "rev-parse",
            "--verify",
            "HEAD",
        ],
    ) else {
        // An unborn recorded project has no reference to follow.
        return Ok(true);
    };
    let current = workspace::project_git(path, &["rev-parse", "--verify", "HEAD"]).ok();
    Ok(current == Some(recorded))
}
/// Materialize the recorded project Git into a slot that already carries one.
fn rebind_git_scoped(owner: &Path, path: &Path, record: &Path, view: &View) -> Result<(), String> {
    let git_dir =
        private_project_git(owner, path, view)?.ok_or("Missing recorded project Git view")?;
    let binding = path.join(".git");
    if let Ok(existing) = fs::symlink_metadata(&binding) {
        if existing.is_dir() && !crate::workspace_symlinks::is_link(&existing) {
            crate::path_safety::real_child_path(path, &binding, false)?
                .ok_or("Project Git binding disappeared during preparation")?;
            crate::workspace_cleanup::remove_tree(&binding).map_err(|e| e.to_string())?;
        } else {
            crate::workspace_symlinks::remove(&binding)?;
        }
    }
    if git_dir != binding {
        let state = crate::workspace_state::process_root(owner)?;
        if state.is_dir() {
            if let Some(external) = crate::path_safety::real_child_path(&state, &git_dir, false)? {
                crate::workspace_cleanup::remove_tree(&external).map_err(|e| e.to_string())?;
            }
        }
    }
    install_git_scoped(owner, path, record, view)
}
fn ensure_writable_target(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    #[cfg(target_os = "macos")]
    crate::workspace_cleanup::clear_macos_immutable_flags(path, &metadata)
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    crate::workspace_cleanup::clear_readonly_attribute(path, &metadata)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if !crate::workspace_symlinks::is_link(&metadata) {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        if mode & 0o200 == 0 {
            fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o600))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
/// Install or, for a reused slot, reinstall the recorded project Git so native
/// HEAD, index and objects follow the composed project view. Without this the
/// native history keeps the previous occupant's base, and staging composition
/// cannot even read the new reference.
fn ensure_project_git(owner: &Path, path: &Path, record: &Path, view: &View) -> Result<(), String> {
    if view.git_entries.is_none() {
        return Ok(());
    }
    if path.join(".git").exists() && project_git_follows_record(owner, path, record)? {
        return Ok(());
    }
    rebind_git_scoped(owner, path, record, view)
}
fn install_git_scoped(owner: &Path, path: &Path, record: &Path, view: &View) -> Result<(), String> {
    if path.join(".git").exists() {
        return Err("Refusing to replace an existing project Git view".into());
    }
    if view.git_entries.is_some() {
        let git_dir =
            private_project_git(owner, path, view)?.ok_or("Missing recorded project Git view")?;
        if git_dir != path.join(".git") {
            // Gitfile/link layouts keep their metadata beside the slot state.
            crate::workspace_state::prepare(owner)?;
        }
        copy_git(&record.join("git"), &git_dir, view.git_entries.as_ref())?;
        if view.git_link {
            // Recreate the source's own .git link kind, bound only to the
            // private copy; never leave it pointing at source metadata.
            crate::workspace_symlinks::materialize(
                owner,
                &path.join(".git"),
                &crate::workspace_symlinks::Link {
                    value: crate::native::host_path(&git_dir)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    project_absolute: false,
                    kind: crate::workspace_symlinks::Kind::Junction,
                },
            )?;
        }
        if view.git_file {
            fs::write(
                path.join(".git"),
                format!(
                    "gitdir: {}\n",
                    crate::native::host_path(&git_dir)
                        .to_string_lossy()
                        .replace('\\', "/")
                ),
            )
            .map_err(|e| e.to_string())?;
        }
        // Only repository-local settings belong in the project .git. Global
        // settings remain external references, without copying host secrets.
        let state = crate::workspace_state::prepare(owner)?;
        let config_root = state.join(".git-config");
        crate::path_safety::real_child_path(&state, &config_root, false)?;
        fs::create_dir_all(&config_root).map_err(|e| e.to_string())?;
        crate::path_safety::real_child_path(&state, &config_root, false)?;
        let global_path = config_root.join("global");
        if global_path.exists() {
            crate::path_safety::real_child_path(&config_root, &global_path, true)?;
        }
        let root = crate::native::host_path(path)
            .to_string_lossy()
            .replace('\\', "/");
        let global = String::from_utf8(view.git_global.clone())
            .map_err(|_| "Git configuration must be UTF-8")?
            .replace("{workspace}", &root);
        if owner == path || !global_path.exists() {
            fs::write(&global_path, global).map_err(|e| e.to_string())?;
        }
        // Deep slot paths can exceed Git's Windows config-lock path handling.
        // Build the file under the short system temp path, then copy the
        // finished bytes with Rust (which handles long destination paths).
        for name in view.git_files.keys() {
            if !matches!(name.as_str(), "excludes" | "attributes") {
                return Err("Unsafe captured Git resource".into());
            }
        }
        let short = std::env::temp_dir();
        let pending = short.join(format!("grapher-gitcfg-{}", uuid::Uuid::new_v4()));
        fs::write(&pending, b"").map_err(|e| e.to_string())?;
        let worktree_str = crate::native::host_path(path)
            .to_string_lossy()
            .replace('\\', "/");
        let write_fast = || -> Result<(), String> {
            let mut cfg = git2::Config::open(&pending).map_err(|e| e.to_string())?;
            for (key, value) in &view.git_config {
                let value = if path_config(key) {
                    value.replace("{workspace}", &root)
                } else {
                    value.clone()
                };
                // Use `a^` (valid POSIX ERE that never matches any value,
                // including `""`) so empty reset entries like
                // `credential.helper = ""` followed by a real helper are
                // appended like `git config --add`, not overwritten.
                cfg.set_multivar(key, "a^", &value)
                    .map_err(|e| e.to_string())?;
            }
            let replace = |cfg: &mut git2::Config, key: &str, value: &str| -> Result<(), String> {
                let mut count = 0usize;
                let mut single_matches = false;
                if let Ok(mut entries) = cfg.multivar(key, None) {
                    while let Some(entry) = entries.next() {
                        if let Ok(entry) = entry {
                            count += 1;
                            single_matches = count == 1 && entry.value().ok() == Some(value);
                        }
                    }
                }
                if single_matches {
                    return Ok(());
                }
                if count <= 1 {
                    return cfg.set_str(key, value).map_err(|e| e.to_string());
                }
                match cfg.remove_multivar(key, ".*") {
                    Ok(()) => {}
                    Err(e) if e.code() == git2::ErrorCode::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
                cfg.set_str(key, value).map_err(|e| e.to_string())
            };
            replace(&mut cfg, "core.bare", "false")?;
            if view.git_file {
                replace(&mut cfg, "core.worktree", &worktree_str)?;
            }
            for (name, (reference, local)) in &view.git_files {
                if !local {
                    continue;
                }
                let key = match name.as_str() {
                    "excludes" => "core.excludesfile",
                    "attributes" => "core.attributesfile",
                    _ => return Err("Unsafe captured Git resource".into()),
                };
                replace(&mut cfg, key, &reference.replace("{workspace}", &root))?;
            }
            Ok(())
        };
        let config = |args: &[&str]| workspace::project_git(&short, args);
        if write_fast().is_err() {
            fs::write(&pending, b"").map_err(|e| e.to_string())?;
            let pending_text = crate::native::host_path(&pending)
                .to_str()
                .ok_or("Invalid Git configuration path")?
                .to_string();
            for (key, value) in &view.git_config {
                config(&[
                    "config",
                    "--file",
                    &pending_text,
                    "--add",
                    key,
                    &if path_config(key) {
                        value.replace("{workspace}", &root)
                    } else {
                        value.clone()
                    },
                ])?;
            }
            config(&[
                "config",
                "--file",
                &pending_text,
                "--replace-all",
                "core.bare",
                "false",
            ])?;
            if view.git_file {
                config(&[
                    "config",
                    "--file",
                    &pending_text,
                    "--replace-all",
                    "core.worktree",
                    &worktree_str,
                ])?;
            }
            for (name, (reference, local)) in &view.git_files {
                if !local {
                    continue;
                }
                let key = match name.as_str() {
                    "excludes" => "core.excludesfile",
                    "attributes" => "core.attributesfile",
                    _ => return Err("Unsafe captured Git resource".into()),
                };
                config(&[
                    "config",
                    "--file",
                    &pending_text,
                    "--replace-all",
                    key,
                    &reference.replace("{workspace}", &root),
                ])?;
            }
        }
        let config_destination = git_dir.join("config");
        ensure_writable_target(&config_destination)?;
        fs::copy(&pending, &config_destination).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&pending);
        let worktree_config = git_dir.join("config.worktree");
        if worktree_config.is_file() {
            let scratch = short.join(format!("grapher-gitwt-{}", uuid::Uuid::new_v4()));
            fs::copy(&worktree_config, &scratch).map_err(|e| e.to_string())?;
            let updated_fast = (|| -> Result<bool, String> {
                let mut cfg = git2::Config::open(&scratch).map_err(|e| e.to_string())?;
                if cfg.get_string("core.worktree").is_err() {
                    return Ok(false);
                }
                let _ = cfg.remove_multivar("core.worktree", ".*");
                cfg.set_str("core.worktree", &worktree_str)
                    .map_err(|e| e.to_string())?;
                Ok(true)
            })();
            match updated_fast {
                Ok(true) => {
                    ensure_writable_target(&worktree_config)?;
                    fs::copy(&scratch, &worktree_config).map_err(|e| e.to_string())?;
                }
                Ok(false) => {}
                Err(_) => {
                    fs::copy(&worktree_config, &scratch).map_err(|e| e.to_string())?;
                    let scratch_text = crate::native::host_path(&scratch)
                        .to_str()
                        .ok_or("Invalid worktree Git configuration path")?
                        .to_string();
                    if config(&["config", "--file", &scratch_text, "--get", "core.worktree"])
                        .is_ok()
                    {
                        config(&[
                            "config",
                            "--file",
                            &scratch_text,
                            "--replace-all",
                            "core.worktree",
                            &worktree_str,
                        ])?;
                        ensure_writable_target(&worktree_config)?;
                        fs::copy(&scratch, &worktree_config).map_err(|e| e.to_string())?;
                    }
                }
            }
            let _ = fs::remove_file(&scratch);
        }
        if let Some((mode, extra)) = &view.git_file_metadata {
            crate::workspace_metadata::restore_with_mode(&path.join(".git"), extra, *mode)?;
        }
        if view.git_link {
            if let Some((_mode, extra)) = &view.git_link_metadata {
                crate::workspace_metadata::restore(&path.join(".git"), extra)?;
            }
        }
        for name in ["config", "config.worktree"] {
            if let Some(config) = view
                .git_entries
                .as_ref()
                .and_then(|entries| entries.get(name))
            {
                restore_entry(&git_dir.join(name), config)?;
            }
        }
    }
    Ok(())
}

fn metadata_only(entry: &Entry) -> Entry {
    match entry {
        Entry::File { mode, extra, .. } => Entry::File {
            mode: *mode,
            extra: extra.clone(),
            blob: String::new(),
        },
        Entry::Link { target, extra } => Entry::Link {
            extra: extra.clone(),
            target: target.metadata(),
        },
        entry => entry.clone(),
    }
}
fn kind(entry: &Entry) -> u8 {
    match entry {
        Entry::File { .. } => 0,
        Entry::Directory { .. } => 1,
        Entry::Link { .. } => 2,
        Entry::Special { .. } => 3,
    }
}
fn choose_metadata(
    base: Option<&Entry>,
    inputs: &[Option<&Entry>],
    name: &str,
) -> Result<Option<Entry>, String> {
    let base = base.map(metadata_only);
    let mut changes = Vec::new();
    for entry in inputs {
        let entry = entry.map(metadata_only);
        if entry != base && !changes.contains(&entry) {
            changes.push(entry);
        }
    }
    if changes.len() > 1 {
        return Err(format!("Project metadata composition conflict at {name}; refusing to discard an input's permissions, streams or directory state"));
    }
    Ok(changes.pop().unwrap_or(base))
}
/// True when the already-scanned entry carries exactly the metadata a
/// `restore_entry` call would materialize for `expected` (kind, mode and full
/// metadata including the Windows security descriptor). `expected` metadata for
/// written files and created directories is captured from disk, so this is the
/// common case; composed metadata from recorded views still triggers a restore.
fn metadata_materialized(current: Option<&Entry>, expected: &Entry) -> bool {
    let Some(current) = current else {
        return false;
    };
    match (current, expected) {
        (
            Entry::File {
                mode: a, extra: ae, ..
            },
            Entry::File {
                mode: b, extra: be, ..
            },
        )
        | (Entry::Directory { mode: a, extra: ae }, Entry::Directory { mode: b, extra: be }) => {
            a == b && ae.identical(be)
        }
        (Entry::Link { extra: ae, .. }, Entry::Link { extra: be, .. }) => ae.identical(be),
        (
            Entry::Special {
                mode: a, extra: ae, ..
            },
            Entry::Special {
                mode: b, extra: be, ..
            },
        ) => a == b && ae.identical(be),
        _ => false,
    }
}
fn restore_entry(path: &Path, entry: &Entry) -> Result<(), String> {
    match entry {
        Entry::File { mode, extra, .. } | Entry::Directory { mode, extra } => {
            crate::workspace_metadata::restore_with_mode(path, extra, *mode)?;
        }
        Entry::Link { extra, .. } => crate::workspace_metadata::restore(path, extra)?,
        Entry::Special { mode, extra, .. } => {
            crate::workspace_metadata::restore_with_mode(path, extra, *mode)?
        }
    }
    Ok(())
}
fn ready(path: &Path) -> Result<PathBuf, String> {
    Ok(crate::workspace_state::root(path)?.join("project-ready"))
}
pub(crate) fn clear_ready(path: &Path) -> Result<(), String> {
    let file = ready(path)?;
    if file.exists() {
        fs::remove_file(&file).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn mark_ready(path: &Path) -> Result<(), String> {
    mark_ready_at(path, &workspace::git(path, &["rev-parse", "HEAD"])?)
}
fn mark_ready_at(path: &Path, head: &str) -> Result<(), String> {
    use std::io::Write;
    if workspace::git(path, &["rev-parse", "HEAD"])? != head {
        return Err("Workspace HEAD changed before its complete-view gate was published".into());
    }
    let file = ready(path)?;
    let root = crate::workspace_state::root(path)?;
    crate::path_safety::real_child_path(&root, &file, true)?;
    // A stopped write must leave either the old complete gate or the new one,
    // never a truncated marker that loses the previous preparation evidence.
    let pending = file.with_extension(format!("pending-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|e| e.to_string())?;
        output
            .write_all(head.as_bytes())
            .map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        fs::rename(&pending, &file).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&pending);
    }
    result
}
fn read_ready(path: &Path, source: &Path) -> Result<String, String> {
    validate_bound(path, source)?;
    crate::workspace::private_git_dir(path)
        .ok_or("Private project view is missing its graph Git metadata; retry preparation")?;
    let file = ready(path)?;
    let root = crate::workspace_state::root(path)?;
    crate::path_safety::real_child_path(&root, &file, true)?
        .ok_or("Private project preparation did not pass its complete-view gate")?;
    fs::read_to_string(file)
        .map_err(|_| "Private project preparation did not pass its complete-view gate".into())
}
pub(crate) fn validate_ready(path: &Path, source: &Path) -> Result<(), String> {
    if read_ready(path, source)? != workspace::git(path, &["rev-parse", "HEAD"])? {
        return Err("Project view preparation is incomplete for the current graph input".into());
    }
    validate_git_bindings(path)
}
fn validate_git_bindings(path: &Path) -> Result<(), String> {
    if let Some((common, current, _, _)) = git_roots(path)? {
        let project = host_canonical(path)?;
        let state = crate::workspace_state::process_root(path)?;
        let state_root = host_canonical(&state)?;
        let external_path = state.join(".project-git");
        if external_path.exists() {
            crate::path_safety::real_child_path(&state, &external_path, false)?;
        }
        let local = host_canonical(&project.join(".git"))?;
        if !local.starts_with(&project) && !local.starts_with(&state_root) {
            return Err("Project Git metadata left its private binding".into());
        }
        let external = host_canonical(&external_path).ok();
        if common != current || !(common == local || external.as_ref() == Some(&common)) {
            return Err("Project Git was redirected outside its private binding".into());
        }
        let worktree = workspace::project_git(path, &["rev-parse", "--show-toplevel"])?;
        if !crate::path_identity::same_path(Path::new(&worktree), path) {
            return Err(
                "Project Git worktree was redirected outside the selected workspace".into(),
            );
        }
    }
    validate_nested_bindings(path, path)
}

fn validate_nested_bindings(owner: &Path, project: &Path) -> Result<(), String> {
    for item in fs::read_dir(project).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        if is_git_entry_name(project, &item.file_name()) {
            continue;
        }
        let path = item.path();
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || crate::workspace_symlinks::is_link(&metadata) {
            continue;
        }
        if fs::symlink_metadata(path.join(".git")).is_ok() {
            let (common, current, _, _) =
                git_roots(&path)?.ok_or("Nested project lost its Git binding")?;
            let project = host_canonical(&path)?;
            let state = crate::workspace_state::process_root(owner)?;
            let state_root = host_canonical(&state)?;
            let local = host_canonical(&project.join(".git"))?;
            if !local.starts_with(&project) && !local.starts_with(&state_root) {
                return Err("Nested Git metadata left its private binding".into());
            }
            let relative = name(path.strip_prefix(owner).map_err(|e| e.to_string())?)?;
            let key = git2::Oid::hash_object(git2::ObjectType::Blob, relative.as_bytes())
                .map_err(|e| e.to_string())?;
            let external_path = state.join(format!(".project-git-{key}"));
            if external_path.exists() {
                crate::path_safety::real_child_path(&state, &external_path, false)?;
            }
            let external = host_canonical(&external_path).ok();
            if common != current || !(common == local || external.as_ref() == Some(&common)) {
                return Err("Nested Git was redirected outside its private binding".into());
            }
            if !crate::path_identity::same_path(
                Path::new(&workspace::project_git(
                    &path,
                    &["rev-parse", "--show-toplevel"],
                )?),
                &path,
            ) {
                return Err("Nested Git worktree was redirected".into());
            }
        }
        validate_nested_bindings(owner, &path)?;
    }
    Ok(())
}

/// Pre-indexed alias lookup for a `BTreeMap<String, Entry>` so macOS/Windows
/// case/Unicode alias lookups run in O(1) instead of O(N) per entry.
struct EntryAliasIndex<'a> {
    entries: &'a BTreeMap<String, Entry>,
    #[cfg(any(target_os = "macos", windows))]
    case_insensitive: bool,
    #[cfg(any(target_os = "macos", windows))]
    by_folded: std::collections::HashMap<String, Vec<(&'a String, &'a Entry)>>,
}

impl<'a> EntryAliasIndex<'a> {
    fn new(entries: &'a BTreeMap<String, Entry>, case_insensitive: bool) -> Self {
        #[cfg(any(target_os = "macos", windows))]
        let by_folded = {
            let mut map: std::collections::HashMap<String, Vec<(&'a String, &'a Entry)>> =
                std::collections::HashMap::with_capacity(entries.len());
            for (key, entry) in entries {
                let folded = crate::path_identity::fold_relative_path(key, case_insensitive);
                map.entry(folded).or_default().push((key, entry));
            }
            map
        };
        #[cfg(not(any(target_os = "macos", windows)))]
        let _ = case_insensitive;
        Self {
            entries,
            #[cfg(any(target_os = "macos", windows))]
            case_insensitive,
            #[cfg(any(target_os = "macos", windows))]
            by_folded,
        }
    }

    fn key_entry(&self, name: &str, expected_kind: Option<u8>) -> Option<(&'a String, &'a Entry)> {
        if let Some((key, exact)) = self.entries.get_key_value(name) {
            return expected_kind
                .is_none_or(|wanted| kind(exact) == wanted)
                .then_some((key, exact));
        }
        #[cfg(any(target_os = "macos", windows))]
        {
            if cfg!(target_os = "macos") && !self.case_insensitive && name.is_ascii() {
                return None;
            }
            let folded = crate::path_identity::fold_relative_path(name, self.case_insensitive);
            let matches = self.by_folded.get(&folded)?;
            if matches.len() != 1 {
                return None;
            }
            let (key, entry) = matches[0];
            expected_kind
                .is_none_or(|wanted| kind(entry) == wanted)
                .then_some((key, entry))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = expected_kind;
            None
        }
    }

    fn entry(&self, name: &str, expected_kind: Option<u8>) -> Option<&'a Entry> {
        self.key_entry(name, expected_kind).map(|(_, entry)| entry)
    }
}

struct FoldedPathSet {
    exact: std::collections::HashSet<String>,
    #[cfg(any(target_os = "macos", windows))]
    case_insensitive: bool,
    #[cfg(any(target_os = "macos", windows))]
    folded: std::collections::HashMap<String, String>,
}

impl FoldedPathSet {
    fn new(case_insensitive: bool) -> Self {
        #[cfg(not(any(target_os = "macos", windows)))]
        let _ = case_insensitive;
        Self {
            exact: std::collections::HashSet::new(),
            #[cfg(any(target_os = "macos", windows))]
            case_insensitive,
            #[cfg(any(target_os = "macos", windows))]
            folded: std::collections::HashMap::new(),
        }
    }

    fn insert(&mut self, value: String) {
        #[cfg(any(target_os = "macos", windows))]
        {
            let folded = crate::path_identity::fold_relative_path(&value, self.case_insensitive);
            self.folded.entry(folded).or_insert_with(|| value.clone());
        }
        self.exact.insert(value);
    }

    fn contains_alias(&self, name: &str) -> bool {
        if self.exact.contains(name) {
            return true;
        }
        #[cfg(any(target_os = "macos", windows))]
        {
            if cfg!(target_os = "macos") && !self.case_insensitive && name.is_ascii() {
                return false;
            }
            let folded = crate::path_identity::fold_relative_path(name, self.case_insensitive);
            self.folded.contains_key(&folded)
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        false
    }

    fn canonical_alias(&self, name: &str) -> Option<&str> {
        if let Some(exact) = self.exact.get(name) {
            return Some(exact.as_str());
        }
        #[cfg(any(target_os = "macos", windows))]
        {
            if cfg!(target_os = "macos") && !self.case_insensitive && name.is_ascii() {
                return None;
            }
            let folded = crate::path_identity::fold_relative_path(name, self.case_insensitive);
            self.folded.get(&folded).map(String::as_str)
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        None
    }
}

fn choose_alias_spelling_indexed(
    base_index: &EntryAliasIndex<'_>,
    input_indices: &[EntryAliasIndex<'_>],
    name: &str,
    expected_kind: Option<u8>,
) -> Result<String, String> {
    let base_name = base_index
        .key_entry(name, expected_kind)
        .map(|(key, _)| key.as_str());
    let mut changed = Vec::new();
    for index in input_indices {
        if let Some((input_key, _)) = index.key_entry(name, expected_kind) {
            let input_key = input_key.as_str();
            if Some(input_key) != base_name && !changed.contains(&input_key) {
                changed.push(input_key);
            }
        }
    }
    if changed.len() > 1 {
        return Err(format!(
            "Project path spelling composition conflict at {name}; refusing to discard an input's rename"
        ));
    }
    if base_name.is_some()
        && !changed.is_empty()
        && input_indices
            .iter()
            .any(|index| index.key_entry(name, None).is_none())
    {
        return Err(format!(
            "Project path deletion conflicts with rename at {name}; refusing to discard an input's change"
        ));
    }
    Ok(changed.pop().or(base_name).unwrap_or(name).to_string())
}

fn sorted_candidate_names<'a>(
    base_view: &'a View,
    inputs: &'a [(PathBuf, View)],
    wanted_kind: Option<u8>,
) -> Vec<&'a str> {
    let mut seen = std::collections::BTreeSet::new();
    for (name, entry) in base_view
        .entries
        .iter()
        .chain(inputs.iter().flat_map(|(_, view)| view.entries.iter()))
    {
        if wanted_kind.is_none_or(|expected| kind(entry) == expected) {
            seen.insert((Path::new(name).components().count(), name.as_str()));
        }
    }
    seen.into_iter().map(|(_, name)| name).collect()
}

fn resolve_parent_alias_prefix_indexed(name: &str, canonical_dirs: &FoldedPathSet) -> String {
    let mut out = PathBuf::new();
    let mut changed = false;
    let parts: Vec<_> = Path::new(name).components().collect();
    for (index, part) in parts.iter().enumerate() {
        out.push(part.as_os_str());
        if index + 1 < parts.len() {
            if let Ok(prefix) = name_of(&out) {
                if let Some(canonical) = canonical_dirs.canonical_alias(&prefix) {
                    if canonical != prefix {
                        out = PathBuf::from(canonical);
                        changed = true;
                    }
                }
            }
        }
    }
    if changed {
        name_of(&out).unwrap_or_else(|_| name.to_string())
    } else {
        name.to_string()
    }
}

fn choose_directory_entry_indexed(
    base_index: &EntryAliasIndex<'_>,
    input_indices: &[EntryAliasIndex<'_>],
    name: &str,
) -> Result<Option<(String, Entry)>, String> {
    let base = base_index.entry(name, Some(1));
    let candidates: Vec<_> = input_indices
        .iter()
        .map(|index| index.entry(name, Some(1)))
        .collect();
    let metadata = choose_metadata(base, &candidates, name)?;
    let chosen_name = choose_alias_spelling_indexed(base_index, input_indices, name, Some(1))?;
    Ok(metadata.map(|entry| (chosen_name, entry)))
}

#[cfg(any(target_os = "macos", windows))]
fn reconcile_tree_aliases(
    root: &Path,
    targets: &std::collections::BTreeSet<String>,
    actual: &mut BTreeMap<String, Entry>,
    materialized: &mut std::collections::BTreeSet<String>,
    case_insensitive: bool,
) -> Result<(), String> {
    let mut ordered: Vec<(usize, String)> = targets
        .iter()
        .map(|entry| (Path::new(entry).components().count(), entry.clone()))
        .collect();
    ordered.sort();
    let mut by_folded: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::with_capacity(actual.len());
    for candidate in actual.keys() {
        let folded = crate::path_identity::fold_relative_path(candidate, case_insensitive);
        by_folded.entry(folded).or_default().push(candidate.clone());
    }
    for (_, wanted) in ordered {
        if actual.contains_key(&wanted) {
            continue;
        }
        let wanted_parent = Path::new(&wanted).parent();
        let wanted_depth = Path::new(&wanted).components().count();
        let folded_wanted = crate::path_identity::fold_relative_path(&wanted, case_insensitive);
        let Some(candidates) = by_folded.get(&folded_wanted) else {
            continue;
        };
        let mut alias: Option<String> = None;
        let mut ambiguous = false;
        for candidate in candidates {
            if Path::new(candidate).components().count() != wanted_depth {
                continue;
            }
            if Path::new(candidate).parent() == wanted_parent {
                if alias.is_some() {
                    ambiguous = true;
                    break;
                }
                alias = Some(candidate.clone());
            }
        }
        if ambiguous {
            continue;
        }
        let Some(alias_key) = alias else {
            continue;
        };
        if targets.contains(&alias_key) {
            continue;
        }
        if let Some(parent) = wanted_parent.filter(|p| !p.as_os_str().is_empty()) {
            real_child_path(root, &root.join(parent), false)?;
            let parent_path = root.join(parent);
            if let Ok(meta) = fs::metadata(&parent_path) {
                #[cfg(target_os = "macos")]
                if crate::workspace_cleanup::clear_macos_immutable_flags(&parent_path, &meta)
                    .is_ok()
                {
                    materialized.insert(name_of(parent)?);
                }
                if meta.permissions().readonly() || (cfg!(unix) && mode(&meta) & 0o200 == 0) {
                    set_mode(
                        &parent_path,
                        if cfg!(unix) { mode(&meta) | 0o700 } else { 0 },
                    )?;
                    materialized.insert(name_of(parent)?);
                }
            }
        }
        let from = root.join(&alias_key);
        #[cfg(target_os = "macos")]
        if let Ok(meta) = fs::symlink_metadata(&from) {
            if crate::workspace_cleanup::clear_macos_immutable_flags(&from, &meta).is_ok() {
                materialized.insert(wanted.clone());
            }
        }
        let to = root.join(&wanted);
        let mut hop = to.parent().unwrap_or(root).join(format!(
            ".grapher-rename-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        while fs::symlink_metadata(&hop).is_ok() {
            hop = to.parent().unwrap_or(root).join(format!(
                ".grapher-rename-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
        }
        // Two-step rename forces APFS (especially case-sensitive APFS on NFD<->NFC)
        // and HFS+/Windows filesystems to update the stored directory entry spelling.
        fs::rename(&from, &hop).map_err(|e| {
            format!("Cannot normalize project path spelling from {alias_key} to {wanted}: {e}")
        })?;
        if let Err(e) = fs::rename(&hop, &to) {
            let _ = fs::rename(&hop, &from);
            return Err(format!(
                "Cannot normalize project path spelling from {alias_key} to {wanted}: {e}"
            ));
        }
        let prefix = format!("{alias_key}/");
        let mut updated = BTreeMap::new();
        let old = std::mem::take(actual);
        for (key, value) in old {
            if key == alias_key {
                updated.insert(wanted.clone(), value);
            } else if let Some(rest) = key.strip_prefix(&prefix) {
                updated.insert(format!("{wanted}/{rest}"), value);
            } else {
                updated.insert(key, value);
            }
        }
        *actual = updated;
        by_folded.clear();
        for candidate in actual.keys() {
            let folded = crate::path_identity::fold_relative_path(candidate, case_insensitive);
            by_folded.entry(folded).or_default().push(candidate.clone());
        }
    }
    Ok(())
}

/// True when nothing below `relative` can appear in a project view: only
/// generated artifacts (agent caches such as `__pycache__` or `.pytest_cache`),
/// untracked host metadata, and directories that are themselves unobservable
/// remain. A slot reused from an earlier execution keeps such ignored
/// leftovers because graph `checkout -f` only rewrites tracked files, so their
/// enclosing directory is the one entry the scan records and no composed view can
/// ever carry.
fn view_unobservable(
    root: &Path,
    relative: &Path,
    tracked: &std::collections::BTreeSet<String>,
) -> Result<bool, String> {
    for item in fs::read_dir(root.join(relative)).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let child = relative.join(item.file_name());
        let child_name = name(&child)?;
        if (workspace::is_generated_artifact(&child) || workspace::is_host_metadata(&child_name))
            && !workspace::tracked_path_matches(Some(root), tracked, &child_name)
        {
            continue;
        }
        let metadata = fs::symlink_metadata(root.join(&child)).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || crate::workspace_symlinks::is_link(&metadata) {
            return Ok(false);
        }
        if !view_unobservable(root, &child, tracked)? {
            return Ok(false);
        }
    }
    Ok(true)
}
/// Serialize only the files referenced by `topology.aliases` (typically 0 or a
/// handful), instead of JSON-encoding every regular file in the repository.
fn hardlink_signatures(
    expected: &BTreeMap<String, Entry>,
    topology: &crate::workspace_links::Topology,
) -> Result<BTreeMap<String, String>, String> {
    let mut signatures = BTreeMap::new();
    for name in topology.aliased_paths() {
        if signatures.contains_key(name) {
            continue;
        }
        if let Some(entry @ Entry::File { .. }) = expected.get(name) {
            signatures.insert(
                name.to_string(),
                serde_json::to_string(entry).map_err(|e| e.to_string())?,
            );
        }
    }
    Ok(signatures)
}

/// Restore freshly checked-out entries. Regular-file/link/special leaves are
/// independent when no hardlinks share an inode, so large trees restore them in
/// parallel before restoring directories bottom-up (preserving read-only dirs).
fn restore_fresh_entries(
    path: &Path,
    expected: &BTreeMap<String, Entry>,
    no_hardlinks: bool,
) -> Result<(), String> {
    const PARALLEL_RESTORE_THRESHOLD: usize = 256;
    let threads = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .min(4);
    if !no_hardlinks || threads <= 1 || expected.len() < PARALLEL_RESTORE_THRESHOLD {
        for (name, entry) in expected.iter().rev() {
            restore_entry(&path.join(name), entry)
                .map_err(|error| format!("Cannot restore project metadata for {name}: {error}"))?;
        }
        return Ok(());
    }
    let mut leaves: Vec<(&String, &Entry)> = Vec::new();
    let mut dirs: Vec<(&String, &Entry)> = Vec::new();
    for (name, entry) in expected.iter().rev() {
        if matches!(entry, Entry::Directory { .. }) {
            dirs.push((name, entry));
        } else {
            leaves.push((name, entry));
        }
    }
    if leaves.len() < PARALLEL_RESTORE_THRESHOLD {
        for (name, entry) in leaves {
            restore_entry(&path.join(name), entry)
                .map_err(|error| format!("Cannot restore project metadata for {name}: {error}"))?;
        }
    } else {
        let errors: Vec<std::sync::OnceLock<Result<(), String>>> = (0..leaves.len())
            .map(|_| std::sync::OnceLock::new())
            .collect();
        let next = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..threads)
                .map(|_| {
                    let leaves = &leaves;
                    let errors = &errors;
                    let next = &next;
                    scope.spawn(move || loop {
                        let idx = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some((name, entry)) = leaves.get(idx) else {
                            break;
                        };
                        let res = restore_entry(&path.join(name), entry).map_err(|error| {
                            format!("Cannot restore project metadata for {name}: {error}")
                        });
                        let failed = res.is_err();
                        let _ = errors[idx].set(res);
                        if failed {
                            break;
                        }
                    })
                })
                .collect();
            let mut panicked = false;
            for handle in handles {
                if handle.join().is_err() {
                    panicked = true;
                }
            }
            if panicked {
                Err("Project metadata restore worker failed".to_string())
            } else {
                Ok(())
            }
        })?;
        for slot in &errors {
            if let Some(Err(error)) = slot.get() {
                return Err(error.clone());
            }
        }
        if errors.iter().any(|slot| slot.get().is_none()) {
            return Err("Project metadata restore worker left an entry unfinished".into());
        }
    }
    for (name, entry) in dirs {
        restore_entry(&path.join(name), entry)
            .map_err(|error| format!("Cannot restore project metadata for {name}: {error}"))?;
    }
    Ok(())
}

/// Read a Git blob in-process via libgit2 for SHA-1 repositories, avoiding
/// spawning one `git cat-file` subprocess per symlink or changed file.
fn read_blob_fast(
    odb: Option<&git2::Odb<'_>>,
    cwd: &Path,
    git_dir: Option<&Path>,
    oid: &str,
) -> Result<Vec<u8>, String> {
    if oid.len() == 40 {
        if let Some(odb) = odb {
            if let Ok(id) = git2::Oid::from_str(oid) {
                if let Ok(object) = odb.read(id) {
                    return Ok(object.data().to_vec());
                }
            }
        }
    }
    if let Some(dir) = git_dir {
        workspace::git_bytes(
            cwd,
            &[
                "--git-dir",
                dir.to_str().ok_or("Invalid Git metadata path")?,
                "cat-file",
                "blob",
                oid,
            ],
            None,
            None,
        )
    } else {
        workspace::git_bytes(cwd, &["cat-file", "blob", oid], None, None)
    }
}

/// Finish a brand-new base checkout from the already validated immutable view.
/// Git has just materialized the exact recorded tree into an empty private slot,
/// so hashing every regular file again only repeats the checkout proof. Native
/// metadata, links, hardlinks and nested repositories still need reconstruction.
fn prepare_fresh_base_checkout(
    source: &Path,
    path: &Path,
    record: &Path,
    view: &View,
    exclusions: &[String],
) -> Result<Option<View>, String> {
    let tracked = workspace::project_tracked_paths(path);
    let tracked_index = workspace::TrackedPathIndex::new(path, &tracked);
    for (name, entry) in view.entries.iter().rev() {
        if workspace::collection_excluded_with_index(path, Path::new(name), &tracked_index, exclusions) {
            let target = path.join(name);
            if fs::symlink_metadata(&target).is_ok() {
                remove_entry(path, &tracked, entry, &target)?;
            }
        }
    }
    let expected: BTreeMap<_, _> = view
        .entries
        .iter()
        .filter(|(name, _)| {
            !workspace::collection_excluded_with_index(path, Path::new(name), &tracked_index, exclusions)
        })
        .map(|(name, entry)| (name.clone(), entry.clone()))
        .collect();
    for (name, entry) in &expected {
        if let Entry::Link { target, .. } = entry {
            let target_path = path.join(name);
            // Git has already created this recorded leaf link. materialize checks
            // its real parent and safely replaces the leaf; real_child_path would
            // reject the valid symlink before it can be rebound into the workspace.
            crate::workspace_symlinks::materialize(path, &target_path, target)?;
        }
    }
    for (name, entry) in &expected {
        let target = path.join(name);
        match entry {
            Entry::Directory { .. } => {
                real_child_path(path, &target, false)?;
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            }
            Entry::Special {
                special,
                mode: special_mode,
                device,
                ..
            } => {
                real_child_path(path, &target, true)?;
                let same = fs::symlink_metadata(&target)
                    .ok()
                    .and_then(|metadata| special_entry(&metadata))
                    .is_some_and(|(kind, value)| kind == special && value == *device);
                if !same {
                    if fs::symlink_metadata(&target).is_ok() {
                        remove_entry(path, &tracked, entry, &target)?;
                    }
                    create_special(&target, special, *special_mode, *device)?;
                }
            }
            Entry::File { .. } | Entry::Link { .. } => {}
        }
    }
    let (topology, signatures) = if view.hardlinks.is_empty() {
        (crate::workspace_links::Topology::default(), BTreeMap::new())
    } else {
        let files: std::collections::BTreeSet<String> = expected
            .iter()
            .filter(|(_, entry)| matches!(entry, Entry::File { .. }))
            .map(|(name, _)| name.clone())
            .collect();
        let topology = crate::workspace_links::compose(&view.hardlinks, &[], &files)?;
        let signatures = hardlink_signatures(&expected, &topology)?;
        (topology, signatures)
    };
    crate::workspace_links::restore(path, &topology, &signatures)?;
    restore_fresh_entries(path, &expected, topology.is_empty())?;
    let root = Entry::Directory {
        mode: view.root_mode,
        extra: view.root_extra.clone(),
    };
    restore_entry(path, &root)?;
    prepare_repositories(path, path, record, view, &[])?;
    let observed = if view.repositories.is_empty() {
        assemble_view(path, source, &expected, &topology).ok()
    } else {
        None
    };
    mark_ready(path)?;
    Ok(observed)
}

/// Only project blobs and real user Git cross this boundary. The final recursive
/// comparison is a launch gate, not filtered tool output or an ignore policy.
/// Returns the verified project view of the prepared workspace when it could be
/// assembled from the comparison this pass already performed, so the caller's
/// seal does not rescan the same unchanged tree. `None` means the caller must
/// inspect the workspace itself (nested repositories need their own passes).
pub(crate) fn prepare(
    source: &Path,
    path: &Path,
    base: &str,
    parents: &[String],
    exclusions: &[String],
    fresh_base_checkout: bool,
) -> Result<Option<View>, String> {
    let base_view = load(&record_path(source, base)?)?;
    let mut inputs = Vec::new();
    for head in parents {
        let record = record_path(source, head)?;
        // A parent whose evidence was reclaimed (for example a stale snapshot
        // commit that only existed in a deleted shadow) has no project view to
        // compose and must not block the rebaseline; the base already carries
        // its published content.
        if !record.join("view.json").is_file() {
            continue;
        }
        inputs.push((record.clone(), load(&record)?));
    }
    let (record, view) = inputs
        .last()
        .cloned()
        .unwrap_or((record_path(source, base)?, base_view.clone()));
    if view.source != crate::path_identity::path_key(source)
        || inputs
            .iter()
            .any(|(_, view)| view.source != base_view.source)
    {
        return Err("Project view belongs to another source".into());
    }
    if inputs
        .iter()
        .any(|(_, input)| input.git_entries.is_some() != view.git_entries.is_some())
    {
        return Err("Conflicting inherited Git creation/deletion; refusing to silently choose a project view".into());
    }
    if !is_bound(path) {
        if path.join(".git").exists() {
            return Err("Refusing to replace an existing project Git view".into());
        }
        crate::workspace_state::prepare(path)?;
        fs::write(binding(path)?, &view.source).map_err(|e| e.to_string())?;
    } else {
        validate_bound(path, source)?;
    }
    clear_ready(path)?;
    ensure_project_git(path, path, &record, &view)?;
    compose_project_history(path, &inputs)?;
    if view.git_entries.is_some() && base_view.git_entries.is_some() {
        let indices: Vec<_> = inputs
            .iter()
            .map(|(record, _)| record.join("git"))
            .collect();
        crate::workspace_git_index::compose(
            path,
            &record_path(source, base)?.join("git"),
            &indices,
            &record.join("git"),
        )?;
    }
    if fresh_base_checkout {
        return prepare_fresh_base_checkout(source, path, &record, &base_view, exclusions)
            .map_err(|error| format!("Cannot prepare fresh Graph base checkout: {error}"));
    }
    let conflict = workspace::git(path, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok();
    let tracked = workspace::project_tracked_paths(path);
    let mut actual = BTreeMap::new();
    scan_scoped(
        path,
        Path::new(""),
        &mut actual,
        false,
        path,
        exclusions,
        &tracked,
    )?;
    let mut expected = BTreeMap::new();
    // Entries this pass writes, links or recreates get fresh OS metadata that
    // the scan above could not observe (for example writing clears a read-only
    // bit, and a recreated special/link starts from inherited metadata). Their
    // pre-change scan entry is not proof a restore is unnecessary, so they are
    // excluded from the skip below and always materialized.
    let volume_case_insensitive = if cfg!(target_os = "macos") {
        crate::path_identity::case_insensitive_volume(path)
    } else {
        cfg!(windows)
    };
    let tracked_index = workspace::TrackedPathIndex::new(path, &tracked);
    let base_index = EntryAliasIndex::new(&base_view.entries, volume_case_insensitive);
    let input_indices: Vec<EntryAliasIndex<'_>> = inputs
        .iter()
        .map(|(_, view)| EntryAliasIndex::new(&view.entries, volume_case_insensitive))
        .collect();
    let graph_repo = workspace::private_git_dir(path)
        .and_then(|dir| git2::Repository::open(dir).ok())
        .or_else(|| git2::Repository::open(path).ok());
    let graph_odb = graph_repo.as_ref().and_then(|repo| repo.odb().ok());
    let mut materialized = std::collections::BTreeSet::new();
    if conflict {
        // Conflict marker bytes are task composition state, not HEAD bytes.
        expected.extend(
            actual
                .iter()
                .filter(|(_, entry)| !matches!(entry, Entry::Directory { .. }))
                .map(|(name, entry)| (name.clone(), entry.clone())),
        );
    } else {
        let raw = workspace::git(path, &["ls-tree", "-r", "-z", "HEAD"])?;
        let mut parsed_entries = Vec::new();
        for item in raw.split('\0').filter(|s| !s.is_empty()) {
            let (header, name) = item.split_once('\t').ok_or("Invalid graph tree entry")?;
            let fields: Vec<_> = header.split_whitespace().collect();
            if fields.len() != 3 || fields[1] != "blob" {
                return Err("Workspace capability gap: Gitlink/submodule needs recursive private preparation".into());
            }
            if Path::new(name).components().any(|part| {
                !matches!(part, std::path::Component::Normal(_)) || part.as_os_str() == ".git"
            }) {
                return Err("Unsafe graph project path".into());
            }
            // A recorded tree may still carry generated artifacts from before
            // this policy; skip them here so the comparison matches the scan.
            if workspace::collection_excluded_with_index(
                path,
                Path::new(name),
                &tracked_index,
                exclusions,
            ) {
                continue;
            }
            parsed_entries.push((fields[0], fields[2], name));
        }
        #[cfg(any(target_os = "macos", windows))]
        {
            let mut reconcile_targets = std::collections::BTreeSet::new();
            for &(_, _, entry_name) in &parsed_entries {
                reconcile_targets.insert(entry_name.to_string());
                let mut parent = Path::new(entry_name).parent();
                while let Some(dir) = parent.filter(|dir| !dir.as_os_str().is_empty()) {
                    reconcile_targets.insert(name_of(dir)?);
                    parent = dir.parent();
                }
            }
            reconcile_tree_aliases(
                path,
                &reconcile_targets,
                &mut actual,
                &mut materialized,
                volume_case_insensitive,
            )?;
        }
        for (entry_mode, entry_oid, name) in parsed_entries {
            let target = path.join(name);
            if entry_mode == "120000" {
                let data = read_blob_fast(graph_odb.as_ref(), path, None, entry_oid)?;
                let target_name = String::from_utf8(data).map_err(|_| "Non-UTF-8 project link")?;
                let baseline = base_index.entry(name, Some(2));
                let candidates = input_indices
                    .iter()
                    .map(|index| index.entry(name, Some(2)))
                    .collect::<Vec<_>>();
                let template = choose_metadata(baseline, &candidates, name)?
                    .or_else(|| {
                        actual
                            .get(name)
                            .filter(|entry| matches!(entry, Entry::Link { .. }))
                            .cloned()
                    })
                    .ok_or("Missing recorded native project link metadata")?;
                let Entry::Link { mut target, extra } = template else {
                    return Err("Invalid project link evidence".into());
                };
                target.value = target_name;
                crate::workspace_symlinks::materialize(path, &path.join(name), &target)?;
                materialized.insert(name.to_string());
                expected.insert(name.into(), Entry::Link { target, extra });
            } else {
                // The view's blob identity is the SHA-1 content hash that
                // `scan_scoped` records, so a SHA-1 graph tree's `ls-tree` OID is
                // already that identity: reuse it and skip reading unchanged
                // bytes, which otherwise spawned one `git cat-file` per project
                // file on every preparation pass. A SHA-256 tree reports a
                // different OID, so its bytes are still read and hashed to keep
                // the recorded identity comparable.
                let mut cached = None;
                let blob = if entry_oid.len() == 40 {
                    entry_oid.to_string()
                } else {
                    let data = read_blob_fast(graph_odb.as_ref(), path, None, entry_oid)?;
                    let hash = git2::Oid::hash_object(git2::ObjectType::Blob, &data)
                        .map_err(|e| e.to_string())?
                        .to_string();
                    cached = Some(data);
                    hash
                };
                let unchanged = matches!(actual.get(name), Some(Entry::File { blob: current, .. }) if current == &blob);
                if !unchanged {
                    // Check parent chain first; a recorded directory/link at
                    // `target` itself is safely unlinked below before writing.
                    if let Some(parent) = target.parent().filter(|parent| *parent != path) {
                        real_child_path(path, parent, false)?;
                    }
                    let data = match cached {
                        Some(data) => data,
                        None => read_blob_fast(graph_odb.as_ref(), path, None, entry_oid)?,
                    };
                    if let Some(existing) = actual.get(name) {
                        if !matches!(existing, Entry::File { .. }) {
                            remove_entry(path, &tracked, existing, &target)?;
                        }
                    }
                    real_child_path(path, &target, true)?;
                    if let Ok(metadata) = fs::metadata(&target) {
                        #[cfg(target_os = "macos")]
                        crate::workspace_cleanup::clear_macos_immutable_flags(&target, &metadata)
                            .map_err(|e| e.to_string())?;
                        if metadata.permissions().readonly() {
                            set_mode(
                                &target,
                                if cfg!(unix) {
                                    mode(&metadata) | 0o600
                                } else {
                                    0
                                },
                            )?;
                        }
                    }
                    fs::write(&target, &data).map_err(|e| e.to_string())?;
                    materialized.insert(name.to_string());
                }
                // An unchanged file's bytes and OS metadata are exactly what the
                // scan above already recorded, so reuse that capture instead of
                // re-reading ACLs/extended attributes for every project file.
                // Rewritten entries are re-observed below, and the complete
                // comparison that gates readiness re-reads the whole workspace.
                if unchanged {
                    expected.insert(name.into(), actual[name].clone());
                    continue;
                }
                let metadata = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
                expected.insert(
                    name.into(),
                    Entry::File {
                        blob,
                        mode: mode(&metadata),
                        extra: crate::workspace_metadata::capture(&target, &metadata)?,
                    },
                );
            }
        }
    }
    let mut directory_names = std::collections::BTreeSet::new();
    let mut expected_aliases = FoldedPathSet::new(volume_case_insensitive);
    for name in expected.keys() {
        expected_aliases.insert(name.clone());
        let mut parent = Path::new(name).parent();
        while let Some(path) = parent.filter(|path| !path.as_os_str().is_empty()) {
            directory_names.insert(name_of(path)?);
            parent = path.parent();
        }
    }
    let mut canonical_dirs = FoldedPathSet::new(volume_case_insensitive);
    for dir in &directory_names {
        canonical_dirs.insert(dir.clone());
    }
    for name in sorted_candidate_names(&base_view, &inputs, Some(1)) {
        if canonical_dirs.contains_alias(name) || expected_aliases.contains_alias(name) {
            continue;
        }
        if let Some((chosen_name, directory)) =
            choose_directory_entry_indexed(&base_index, &input_indices, name)?
        {
            let resolved_name = resolve_parent_alias_prefix_indexed(&chosen_name, &canonical_dirs);
            canonical_dirs.insert(resolved_name.clone());
            expected_aliases.insert(resolved_name.clone());
            expected.entry(resolved_name).or_insert(directory);
        }
    }
    for name in &directory_names {
        if expected.contains_key(name) {
            continue;
        }
        let target = path.join(name);
        real_child_path(path, &target, false)?;
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        let metadata = fs::metadata(&target).map_err(|e| e.to_string())?;
        expected_aliases.insert(name.clone());
        expected.insert(
            name.clone(),
            Entry::Directory {
                mode: mode(&metadata),
                extra: crate::workspace_metadata::capture(&target, &metadata)?,
            },
        );
    }
    let special_names: std::collections::BTreeSet<String> = base_view
        .entries
        .iter()
        .chain(inputs.iter().flat_map(|(_, view)| view.entries.iter()))
        .filter(|(_, entry)| matches!(entry, Entry::Special { .. }))
        .map(|(name, _)| name.clone())
        .chain(
            inputs
                .last()
                .into_iter()
                .flat_map(|(_, view)| view.entries.iter())
                .filter(|(name, entry)| {
                    matches!(entry, Entry::Special { .. })
                        && base_index.entry(name, None).is_none()
                })
                .map(|(name, _)| name.clone()),
        )
        .collect();
    for name in special_names {
        if expected_aliases.contains_alias(&name) || canonical_dirs.contains_alias(&name) {
            continue;
        }
        let values: Vec<Option<Entry>> = input_indices
            .iter()
            .map(|index| index.entry(&name, Some(3)).cloned())
            .collect();
        if values.len() > 1 && values.iter().any(|value| *value != values[0]) {
            return Err(format!(
                "Project special-entry composition conflict at {name}; no task input's file type is discarded"
            ));
        }
        let selected = match values.last() {
            Some(value) => value.clone(),
            None => base_index.entry(&name, Some(3)).cloned(),
        };
        if let Some(entry) = selected {
            let chosen_name =
                choose_alias_spelling_indexed(&base_index, &input_indices, &name, Some(3))?;
            let resolved_name = resolve_parent_alias_prefix_indexed(&chosen_name, &canonical_dirs);
            expected_aliases.insert(resolved_name.clone());
            expected.insert(resolved_name, entry);
        }
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        let mut reconcile_targets = std::collections::BTreeSet::new();
        for entry_name in expected.keys() {
            reconcile_targets.insert(entry_name.clone());
            let mut parent = Path::new(entry_name).parent();
            while let Some(dir) = parent.filter(|dir| !dir.as_os_str().is_empty()) {
                reconcile_targets.insert(name_of(dir)?);
                parent = dir.parent();
            }
        }
        reconcile_tree_aliases(
            path,
            &reconcile_targets,
            &mut actual,
            &mut materialized,
            volume_case_insensitive,
        )?;
    }
    for (name, entry) in &mut expected {
        let wanted_kind = Some(kind(entry));
        let base = base_index.entry(name, wanted_kind);
        let candidates: Vec<_> = input_indices
            .iter()
            .map(|index| index.entry(name, wanted_kind))
            .collect();
        if let Some(metadata) = choose_metadata(base, &candidates, name)? {
            match (entry, metadata) {
                (
                    Entry::File { mode, extra, .. },
                    Entry::File {
                        mode: wanted_mode,
                        extra: wanted_extra,
                        ..
                    },
                )
                | (
                    Entry::Directory { mode, extra },
                    Entry::Directory {
                        mode: wanted_mode,
                        extra: wanted_extra,
                    },
                ) => {
                    *mode = wanted_mode;
                    *extra = wanted_extra;
                }
                (Entry::Link { extra, .. }, Entry::Link { extra: wanted, .. }) => *extra = wanted,
                (
                    Entry::Special { mode, extra, .. },
                    Entry::Special {
                        mode: wanted_mode,
                        extra: wanted_extra,
                        ..
                    },
                ) => {
                    // Keep the selected special entry's type/device; only its
                    // recorded metadata (mode, streams) is composed here.
                    *mode = wanted_mode;
                    *extra = wanted_extra;
                }
                _ => return Err("Project entry type changed during metadata composition".into()),
            }
        }
    }
    for (name, entry) in &expected {
        if matches!(entry, Entry::Directory { .. }) {
            real_child_path(path, &path.join(name), false)?;
            fs::create_dir_all(path.join(name)).map_err(|e| e.to_string())?;
        }
        if let Entry::Special {
            special,
            mode: special_mode,
            device,
            ..
        } = entry
        {
            let target = path.join(name);
            if let Some(parent) = target.parent().filter(|parent| *parent != path) {
                real_child_path(path, parent, false)?;
            }
            let same = fs::symlink_metadata(&target)
                .ok()
                .and_then(|metadata| special_entry(&metadata))
                .is_some_and(|(kind, value)| kind == special && value == *device);
            if !same {
                if fs::symlink_metadata(&target).is_ok() {
                    remove_entry(path, &tracked, entry, &target)?;
                }
                create_special(&target, special, *special_mode, *device)?;
                materialized.insert(name.clone());
            }
        }
    }
    let (topology, signatures) = if base_view.hardlinks.is_empty()
        && inputs.iter().all(|(_, view)| view.hardlinks.is_empty())
    {
        (crate::workspace_links::Topology::default(), BTreeMap::new())
    } else {
        let files: std::collections::BTreeSet<String> = expected
            .iter()
            .filter(|(_, entry)| matches!(entry, Entry::File { .. }))
            .map(|(name, _)| name.clone())
            .collect();
        let link_inputs = inputs
            .iter()
            .map(|(_, view)| &view.hardlinks)
            .collect::<Vec<_>>();
        let topology = crate::workspace_links::compose(&base_view.hardlinks, &link_inputs, &files)?;
        let signatures = hardlink_signatures(&expected, &topology)?;
        (topology, signatures)
    };
    crate::workspace_links::restore(path, &topology, &signatures)?;
    for (name, entry) in expected.iter().rev() {
        // Reuse the metadata captured by the scan above: an entry whose on-disk
        // metadata already matches what `restore` would write needs no ACL/
        // stream/attribute syscalls. Entries this pass rewrote are excluded so a
        // stale scan entry can never hide a needed restore. The complete
        // comparison below still gates readiness, so this only removes redundant
        // work, never verification.
        if !materialized.contains(name) && metadata_materialized(actual.get(name), entry) {
            continue;
        }
        restore_entry(&path.join(name), entry)?;
    }
    for (name, entry) in actual.iter().rev() {
        if matches!(entry, Entry::Special { .. }) && !expected.contains_key(name) {
            fs::remove_file(path.join(name)).map_err(|e| {
                format!("Cannot remove superseded special project entry at {name}: {e}")
            })?;
        }
        if matches!(entry, Entry::Directory { .. }) && !expected.contains_key(name) {
            let dir_path = path.join(name);
            let known_deleted = base_index.entry(name, None).is_some()
                || input_indices
                    .iter()
                    .any(|index| index.entry(name, None).is_some());
            if known_deleted {
                match fs::remove_dir(&dir_path) {
                    Ok(()) => {}
                    Err(_) if view_unobservable(path, Path::new(name), &tracked)? => {
                        crate::workspace_cleanup::remove_tree(&dir_path).map_err(|e| {
                            format!(
                                "Unrecorded files prevent project directory deletion at {name}: {e}"
                            )
                        })?;
                    }
                    Err(e) => {
                        return Err(format!(
                            "Unrecorded files prevent project directory deletion at {name}: {e}"
                        ));
                    }
                }
            } else if !expected
                .keys()
                .any(|key| workspace::scope_contains_at(path, Path::new(key), Path::new(name)))
                && view_unobservable(path, Path::new(name), &tracked)?
            {
                // Nothing this view could ever record is left inside, so the
                // directory is an ignored leftover of a reused slot rather than
                // unrecorded project content. Children are handled first (the
                // scan is iterated in reverse), so a nested leftover that hid
                // live entries was already refused above.
                crate::workspace_cleanup::remove_tree(&dir_path).map_err(|e| {
                    format!("Cannot remove unrecorded project directory at {name}: {e}")
                })?;
            }
        }
    }
    let base_root = Entry::Directory {
        mode: base_view.root_mode,
        extra: base_view.root_extra.clone(),
    };
    let root_inputs: Vec<_> = inputs
        .iter()
        .map(|(_, view)| Entry::Directory {
            mode: view.root_mode,
            extra: view.root_extra.clone(),
        })
        .collect();
    let root_inputs: Vec<_> = root_inputs.iter().map(Some).collect();
    let root = choose_metadata(Some(&base_root), &root_inputs, ".")?
        .ok_or("Missing project root metadata")?;
    restore_entry(path, &root)?;
    let mut verified = BTreeMap::new();
    let verified_links = scan_scoped_with_links(
        path,
        Path::new(""),
        &mut verified,
        false,
        path,
        exclusions,
        &tracked,
        None,
    )?;
    if verified != expected {
        let name = expected
            .keys()
            .chain(verified.keys())
            .find(|name| expected.get(*name) != verified.get(*name))
            .ok_or("Project view comparison could not identify the difference")?;
        let difference = match (expected.get(name), verified.get(name)) {
            (None, Some(_)) => "unexpected entry",
            (Some(_), None) => "missing entry",
            _ => "entry content, type, or metadata differs",
        };
        return Err(format!("Complete project-view comparison failed at {name:?} ({difference}); no agent may see the partially prepared workspace"));
    }
    if verified_links != topology {
        return Err("Complete project-view comparison failed (hardlink topology differs); no agent may see the partially prepared workspace".into());
    }
    prepare_repositories(path, path, &record_path(source, base)?, &base_view, &inputs)?;
    let nested = !base_view.repositories.is_empty()
        || inputs.iter().any(|(_, view)| !view.repositories.is_empty());
    let observed = if nested {
        None
    } else {
        assemble_view(path, source, &verified, &topology).ok()
    };
    mark_ready(path)?;
    Ok(observed)
}

/// Build a project view from an observation the caller just verified instead of
/// immediately rescanning the same unchanged workspace. Nested repositories are
/// excluded by the caller because each needs its own recursive inspection.
fn assemble_view(
    path: &Path,
    source: &Path,
    entries: &BTreeMap<String, Entry>,
    hardlinks: &crate::workspace_links::Topology,
) -> Result<View, String> {
    let (git_entries, git_file, git_link, git_config, git_files, git_global) = inspect_git(path)?;
    let root = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let git_file_metadata = if git_file {
        let file = path.join(".git");
        let metadata = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
        Some((
            mode(&metadata),
            crate::workspace_metadata::capture(&file, &metadata)?,
        ))
    } else {
        None
    };
    let git_link_metadata = if git_link {
        let file = path.join(".git");
        let metadata = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
        Some((
            mode(&metadata),
            crate::workspace_metadata::capture(&file, &metadata)?,
        ))
    } else {
        None
    };
    let mut view = View {
        schema: VIEW_SCHEMA,
        source: crate::path_identity::path_key(path),
        root_mode: mode(&root),
        root_extra: crate::workspace_metadata::capture(path, &root)?,
        entries: entries.clone(),
        hardlinks: hardlinks.clone(),
        repositories: BTreeMap::new(),
        git_entries,
        git_file,
        git_file_metadata,
        git_link,
        git_link_metadata,
        git_config,
        git_files,
        git_global,
    };
    set_source_keys(&mut view, source);
    Ok(view)
}

fn name_of(path: &Path) -> Result<String, String> {
    name(path)
}
fn compose_project_history(path: &Path, inputs: &[(PathBuf, View)]) -> Result<(), String> {
    if !path.join(".git").exists() {
        return Ok(());
    }
    for (record, view) in inputs {
        if view.git_entries.is_none() {
            continue;
        }
        let git = record.join("git");
        let args = [
            "--git-dir",
            git.to_str().ok_or("Invalid project Git record")?,
            "--work-tree",
            git.to_str().ok_or("Invalid project Git record")?,
            "rev-parse",
            "--verify",
            "HEAD",
        ];
        let incoming = match workspace::project_git(&git, &args) {
            Ok(head) => head,
            Err(_) => continue,
        };
        if workspace::project_git(path, &["cat-file", "-e", &incoming]).is_err() {
            let url = workspace::git_file_url(&git)?;
            workspace::project_git(
                path,
                &[
                    "fetch",
                    "--no-tags",
                    "--no-write-fetch-head",
                    "--no-auto-gc",
                    &url,
                    &incoming,
                ],
            )?;
        }
        if workspace::project_git(path, &["merge-base", "--is-ancestor", &incoming, "HEAD"]).is_ok()
        {
            continue;
        }
        let ours = workspace::project_git(path, &["rev-parse", "--verify", "HEAD"])
            .map_err(|_| "Cannot merge an unborn project index with committed task inputs without choosing away staged work")?;
        let next = if workspace::project_git(
            path,
            &["merge-base", "--is-ancestor", &ours, &incoming],
        )
        .is_ok()
        {
            incoming.clone()
        } else {
            // These are actual project commits, never graph snapshots. A clean
            // native merge tree can be represented as an ordinary task merge;
            // conflicting history cannot be replaced with internal ancestry.
            let tree = workspace::project_git(path, &["merge-tree", "--write-tree", "--no-messages", &ours, &incoming])
                .map_err(|error| format!("Project task-commit merge needs explicit resolution; project history was not replaced with graph snapshots: {error}"))?;
            if !matches!(tree.len(), 40 | 64) || !tree.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Invalid native project merge tree".into());
            }
            let name = workspace::project_git(path, &["show", "-s", "--format=%cn", &ours])?;
            let email = workspace::project_git(path, &["show", "-s", "--format=%ce", &ours])?;
            workspace::project_git(
                path,
                &[
                    "-c",
                    &format!("user.name={name}"),
                    "-c",
                    &format!("user.email={email}"),
                    "-c",
                    "commit.gpgsign=false",
                    "commit-tree",
                    &tree,
                    "-p",
                    &ours,
                    "-p",
                    &incoming,
                    "-m",
                    "Merge task changes",
                ],
            )?
        };
        // No -u: the graph-composed working files stay intact. read-tree's
        // two-way index merge refuses to discard unrelated staged user work.
        workspace::project_git(path, &["read-tree", "-m", &ours, &next])?;
        workspace::project_git(
            path,
            &[
                "update-ref",
                "-m",
                "merge task changes",
                "HEAD",
                &next,
                &ours,
            ],
        )?;
    }
    Ok(())
}

fn nested_repository_views(project: &Path) -> Result<BTreeMap<String, View>, String> {
    fn visit(
        project: &Path,
        relative: &Path,
        views: &mut BTreeMap<String, View>,
    ) -> Result<(), String> {
        for item in fs::read_dir(project.join(relative)).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            if is_git_entry_name(project, &item.file_name()) {
                continue;
            }
            let path = relative.join(item.file_name());
            let absolute = project.join(&path);
            let metadata = fs::symlink_metadata(&absolute).map_err(|e| e.to_string())?;
            if crate::workspace_symlinks::is_link(&metadata) || !metadata.is_dir() {
                continue;
            }
            if fs::symlink_metadata(absolute.join(".git")).is_ok() {
                views.insert(name(&path)?, inspect_scoped(&absolute, project, &[])?);
            } else {
                visit(project, &path, views)?;
            }
        }
        Ok(())
    }
    let mut views = BTreeMap::new();
    visit(project, Path::new(""), &mut views)?;
    Ok(views)
}

fn node_view(
    path: &Path,
    source: &Path,
    exclusions: &[String],
) -> Result<Option<(View, Option<PathBuf>)>, String> {
    if is_bound(path) {
        validate_bound(path, source)?;
        if path.join(".git").exists()
            && !workspace::git(path, &["diff", "--name-only", "--diff-filter=U"])?.is_empty()
        {
            return Err("Unresolved project Git conflicts remain".into());
        }
        let mut view = inspect_scoped(path, path, exclusions)?;
        set_source_keys(&mut view, source);
        return Ok(Some((view, None)));
    }
    // Host-only public API/fixture checkouts have graph Git, not agent Git.
    // Carry the recorded source project Git, never that internal database.
    let base = match workspace::git(path, &["rev-parse", "refs/grapher/base"]) {
        Ok(base) => base,
        Err(_) => return Ok(None),
    };
    if !has_record(source, &base) {
        return Ok(None);
    }
    let record = record_path(source, &base)?;
    let mut view = load(&record)?;
    view.entries.clear();
    let tracked = workspace::project_tracked_paths(path);
    view.hardlinks = scan_scoped_with_links(
        path,
        Path::new(""),
        &mut view.entries,
        false,
        path,
        exclusions,
        &tracked,
        None,
    )?;
    // Do not reuse nested repository evidence recorded from another state:
    // a host-only/fixture checkout can still advance its nested worktrees.
    view.repositories = nested_repository_views(path)?;
    set_source_keys(&mut view, source);
    Ok(Some((view, Some(record))))
}

fn reject_undeliverable_special_changes(
    path: &Path,
    source: &Path,
    observed: &View,
    observed_identity: &str,
) -> Result<Option<(String, bool)>, String> {
    if !is_bound(path) {
        return Ok(None);
    }
    let Ok(base) = workspace::git(path, &["rev-parse", "refs/grapher/base"]) else {
        return Ok(None);
    };
    if !has_record(source, &base) {
        return Ok(None);
    }
    let record = record_path(source, &base)?;
    let metadata = fs::symlink_metadata(&record).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || crate::workspace_symlinks::is_link(&metadata) {
        return Err("Invalid project-view record directory".into());
    }
    let recorded = load(&record)?;
    let is_special = |(_, entry): &(&String, &Entry)| matches!(entry, Entry::Special { .. });
    if !recorded
        .entries
        .iter()
        .filter(is_special)
        .eq(observed.entries.iter().filter(is_special))
    {
        return Err("Task changed special project entries (named pipe/device); files-only publication cannot deliver them, so this result is refused explicitly instead of dropping entries".into());
    }
    // This validation belongs only to this snapshot operation. Most nodes still
    // have their prepared base as HEAD; reuse the comparison while the slot is
    // leased instead of loading and normalizing that large record again.
    Ok(Some((
        base,
        node_view_identity(&recorded)? == observed_identity,
    )))
}

pub(crate) fn seal_prepared_scoped(
    path: &Path,
    source: &Path,
    exclusions: &[String],
    observed: Option<View>,
) -> Result<String, String> {
    let head = workspace::git(path, &["rev-parse", "HEAD"])?;
    // One inspection serves both the identity and the recorded view; the
    // worktree is unchanged by the bookkeeping below. A caller that just
    // verified this workspace hands its observation over instead of paying for
    // a second scan of the same tree.
    let observed = match observed {
        Some(view) => {
            validate_bound(path, source)?;
            if path.join(".git").exists()
                && !workspace::git(path, &["diff", "--name-only", "--diff-filter=U"])?.is_empty()
            {
                return Err("Unresolved project Git conflicts remain".into());
            }
            Some((view, None))
        }
        None => node_view(path, source, exclusions)?,
    };
    let Some((view, inherited)) = observed else {
        return Ok(head);
    };
    let record = ViewRecord::new(&view)?;
    if record_matches(source, &head, &record.identity)? {
        // Reusing immutable evidence still has to finish this slot's local
        // gate (a previous process may have stopped after publishing the view).
        if is_bound(path) {
            mark_ready_at(path, &head)?;
        }
        // Native Git index stat caches do not distinguish equivalent views;
        // ACLs do. Do not require byte-identical index evidence on reuse.
        return Ok(head);
    }
    if !has_record(source, &head) {
        // A composed publication head has no view record yet. Record the
        // current view for that head instead of manufacturing a per-entry
        // commit, so every entry of one publication keeps the same code
        // reference (`code_ref == head == workspace HEAD`).
        capture_node_view(path, source, &head, record, inherited.as_deref(), true)?;
        return Ok(head);
    }
    workspace::git(
        path,
        &[
            "commit",
            "--allow-empty",
            "-m",
            &format!("snapshot\n\nworkspace-view:{}", record.identity),
        ],
    )?;
    // The binding commit moved HEAD and a recorded view embeds the project Git
    // metadata, so inspect the new head instead of reusing the earlier view.
    let head = workspace::git(path, &["rev-parse", "HEAD"])?;
    capture_node_scoped(path, source, &head, exclusions, None)?;
    Ok(head)
}

/// Record the composed head's project view without materializing the project
/// files. Publication delivers a tree, so the composed view is the only thing a
/// workspace was needed for besides the merge itself; composing it from the
/// recorded views keeps evidence identical while skipping the checkout, the
/// workspace scans and their verification pass.
///
/// `Ok(None)` means this state needs a real checkout (for example a nested
/// repository, special entry, hardlink, or missing metadata), and the caller
/// falls back to the materialized composition and its complete-view gate.
pub(crate) fn seal_composed_view(
    source: &Path,
    path: &Path,
    base: &str,
    parents: &[String],
    exclusions: &[String],
    head: &str,
) -> Result<Option<View>, String> {
    let base_view = load(&record_path(source, base)?)?;
    let mut inputs = Vec::new();
    for parent in parents {
        let record = record_path(source, parent)?;
        if !record.join("view.json").is_file() {
            continue;
        }
        inputs.push((record.clone(), load(&record)?));
    }
    // Git trees cannot represent special entries or hardlink topology. The
    // materialized path reconstructs and verifies these, including whether
    // hardlinked paths still have compatible bytes and metadata.
    let needs_checkout = |view: &View| {
        !view.repositories.is_empty()
            || !view.hardlinks.is_empty()
            || view
                .entries
                .values()
                .any(|entry| matches!(entry, Entry::Special { .. }))
    };
    if needs_checkout(&base_view) || inputs.iter().any(|(_, view)| needs_checkout(view)) {
        return Ok(None);
    }
    let (record, view) = inputs
        .last()
        .cloned()
        .unwrap_or((record_path(source, base)?, base_view.clone()));
    if view.source != crate::path_identity::path_key(source)
        || inputs
            .iter()
            .any(|(_, input)| input.source != base_view.source)
    {
        return Err("Project view belongs to another source".into());
    }
    if inputs
        .iter()
        .any(|(_, input)| input.git_entries.is_some() != view.git_entries.is_some())
    {
        return Err("Conflicting inherited Git creation/deletion; refusing to silently choose a project view".into());
    }
    if !is_bound(path) {
        if path.join(".git").exists() {
            return Err("Refusing to replace an existing project Git view".into());
        }
        crate::workspace_state::prepare(path)?;
        fs::write(binding(path)?, &view.source).map_err(|e| e.to_string())?;
    } else {
        validate_bound(path, source)?;
    }
    clear_ready(path)?;
    ensure_project_git(path, path, &record, &view)?;
    compose_project_history(path, &inputs)?;
    if view.git_entries.is_some() && base_view.git_entries.is_some() {
        let indices: Vec<_> = inputs
            .iter()
            .map(|(record, _)| record.join("git"))
            .collect();
        crate::workspace_git_index::compose(
            path,
            &record_path(source, base)?.join("git"),
            &indices,
            &record.join("git"),
        )?;
    }
    let tracked = workspace::project_tracked_paths(path);
    // The composed tree lives in the internal result commit, not in the visible
    // project history this workspace only mirrors.
    let volume_case_insensitive = if cfg!(target_os = "macos") {
        crate::path_identity::case_insensitive_volume(source)
    } else {
        cfg!(windows)
    };
    let tracked_index = workspace::TrackedPathIndex::new(path, &tracked);
    let base_index = EntryAliasIndex::new(&base_view.entries, volume_case_insensitive);
    let input_indices: Vec<EntryAliasIndex<'_>> = inputs
        .iter()
        .map(|(_, view)| EntryAliasIndex::new(&view.entries, volume_case_insensitive))
        .collect();
    let shadow_path = workspace::shadow_repo_if_exists(source)?;
    let shadow_repo = shadow_path
        .as_deref()
        .and_then(|dir| git2::Repository::open(dir).ok());
    let shadow_odb = shadow_repo.as_ref().and_then(|repo| repo.odb().ok());
    let listed = workspace::repository_git(source, &["ls-tree", "-r", "-z", head])?;
    let mut entries: BTreeMap<String, Entry> = BTreeMap::new();
    for item in listed.split('\0').filter(|item| !item.is_empty()) {
        let (header, name) = item.split_once('\t').ok_or("Invalid graph tree entry")?;
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() != 3 {
            return Err("Invalid graph tree entry".into());
        }
        if fields[1] != "blob" {
            return Ok(None);
        }
        if Path::new(name).components().any(|part| {
            !matches!(part, std::path::Component::Normal(_)) || part.as_os_str() == ".git"
        }) {
            return Err("Unsafe graph project path".into());
        }
        if workspace::collection_excluded_with_index(
            path,
            Path::new(name),
            &tracked_index,
            exclusions,
        ) {
            continue;
        }
        if fields[2].len() != 40 {
            // A SHA-256 tree reports a storage id that is not the content hash
            // this view records; materialize instead of reading every blob.
            return Ok(None);
        }
        if fields[0] == "120000" {
            let shadow = shadow_path
                .as_deref()
                .ok_or("Missing internal repository for composed project link")?;
            let data = read_blob_fast(shadow_odb.as_ref(), source, Some(shadow), fields[2])?;
            // Link targets are raw blob bytes, not line-oriented Git output:
            // whitespace (including a trailing newline) is significant.
            let target_name = String::from_utf8(data).map_err(|_| "Non-UTF-8 project link")?;
            let baseline = base_index.entry(name, Some(2));
            let candidates = input_indices
                .iter()
                .map(|index| index.entry(name, Some(2)))
                .collect::<Vec<_>>();
            let Some(template) = choose_metadata(baseline, &candidates, name)? else {
                return Ok(None);
            };
            let Entry::Link { mut target, extra } = template else {
                return Ok(None);
            };
            target.value = target_name;
            entries.insert(name.into(), Entry::Link { target, extra });
            continue;
        }
        if !matches!(fields[0], "100644" | "100755") {
            return Ok(None);
        }
        // Metadata is composed independently of content, exactly as in the
        // materialized path. In particular, a changed blob must not lose its
        // permissions/xattrs, and divergent metadata changes must fail closed.
        let baseline = base_index.entry(name, Some(0));
        let candidates = input_indices
            .iter()
            .map(|index| index.entry(name, Some(0)))
            .collect::<Vec<_>>();
        let Some(Entry::File { mode, extra, .. }) = choose_metadata(baseline, &candidates, name)?
        else {
            // Without recorded metadata only a real checkout can establish it.
            return Ok(None);
        };
        entries.insert(
            name.into(),
            Entry::File {
                blob: fields[2].to_string(),
                mode,
                extra,
            },
        );
    }
    let mut directories = std::collections::BTreeSet::new();
    let mut entry_aliases = FoldedPathSet::new(volume_case_insensitive);
    for name in entries.keys() {
        entry_aliases.insert(name.clone());
        let mut parent = Path::new(name).parent();
        while let Some(path) = parent.filter(|path| !path.as_os_str().is_empty()) {
            directories.insert(name_of(path)?);
            parent = path.parent();
        }
    }
    let mut folded_keys = std::collections::HashSet::with_capacity(entries.len() + directories.len());
    for key in entries.keys().chain(directories.iter()) {
        let folded = crate::path_identity::fold_relative_path(key, volume_case_insensitive);
        if !folded_keys.insert(folded) {
            return Ok(None);
        }
    }
    // Git omits empty directories. Compose every recorded directory, not just
    // the ancestors of files present in the result tree.
    let mut canonical_dirs = FoldedPathSet::new(volume_case_insensitive);
    for dir in &directories {
        canonical_dirs.insert(dir.clone());
    }
    let mut recorded_directories = std::collections::BTreeSet::new();
    for name in sorted_candidate_names(&base_view, &inputs, Some(1)) {
        if !canonical_dirs.contains_alias(name) && !entry_aliases.contains_alias(name) {
            let chosen_name =
                choose_alias_spelling_indexed(&base_index, &input_indices, name, Some(1))?;
            let resolved_name = resolve_parent_alias_prefix_indexed(&chosen_name, &canonical_dirs);
            canonical_dirs.insert(resolved_name.clone());
            recorded_directories.insert(resolved_name);
        }
    }
    for name in directories.union(&recorded_directories) {
        if entry_aliases.contains_alias(name) {
            continue;
        }
        let baseline = base_index.entry(name, Some(1));
        let candidates = input_indices
            .iter()
            .map(|index| index.entry(name, Some(1)))
            .collect::<Vec<_>>();
        match choose_metadata(baseline, &candidates, name)? {
            Some(directory @ Entry::Directory { .. }) => {
                entry_aliases.insert(name.clone());
                entries.insert(name.clone(), directory);
            }
            Some(_) => return Err("Project entry type changed during metadata composition".into()),
            None if directories.contains(name) => {
                // A synthetic parent has no recorded mode/ACL; let the actual
                // checkout determine and verify its filesystem metadata.
                return Ok(None);
            }
            None => {}
        }
    }
    let hardlinks = crate::workspace_links::Topology::default();
    let base_root = Entry::Directory {
        mode: base_view.root_mode,
        extra: base_view.root_extra.clone(),
    };
    let root_inputs: Vec<_> = inputs
        .iter()
        .map(|(_, view)| Entry::Directory {
            mode: view.root_mode,
            extra: view.root_extra.clone(),
        })
        .collect();
    let root_inputs: Vec<_> = root_inputs.iter().map(Some).collect();
    let root = choose_metadata(Some(&base_root), &root_inputs, ".")?
        .ok_or("Missing project root metadata")?;
    let (root_mode, root_extra) = match root {
        Entry::Directory { mode, extra } => (mode, extra),
        _ => return Err("Invalid project root metadata".into()),
    };
    let (git_entries, git_file, git_link, git_config, git_files, git_global) = inspect_git(path)?;
    let git_file_metadata = if git_file {
        let file = path.join(".git");
        let metadata = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
        Some((
            mode(&metadata),
            crate::workspace_metadata::capture(&file, &metadata)?,
        ))
    } else {
        None
    };
    let git_link_metadata = if git_link {
        let file = path.join(".git");
        let metadata = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
        Some((
            mode(&metadata),
            crate::workspace_metadata::capture(&file, &metadata)?,
        ))
    } else {
        None
    };
    let mut composed = View {
        schema: VIEW_SCHEMA,
        source: crate::path_identity::path_key(path),
        root_mode,
        root_extra,
        entries,
        hardlinks,
        repositories: BTreeMap::new(),
        git_entries,
        git_file,
        git_file_metadata,
        git_link,
        git_link_metadata,
        git_config,
        git_files,
        git_global,
    };
    set_source_keys(&mut composed, source);
    capture_node_view(path, source, head, ViewRecord::new(&composed)?, None, false)?;
    Ok(Some(composed))
}

#[cfg(test)]
pub(crate) fn verify_result(path: &Path, source: &Path, head: &str) -> Result<(), String> {
    verify_result_scoped(path, source, head, &[])
}

/// Remove untracked generated artifacts from the caller-owned comparison view.
/// Older records may include them; tracked artifacts remain authored content.
/// Both verification views are freshly read and disposable, so filter in place
/// rather than deep-cloning the whole tree again at every nested repository.
/// No persisted evidence or shared/cached view is modified.
#[cfg(test)]
fn strip_generated(view: &mut View, tracked: &std::collections::BTreeSet<String>) {
    strip_generated_at(view, tracked, None);
}

fn strip_generated_at(
    view: &mut View,
    tracked: &std::collections::BTreeSet<String>,
    root: Option<&Path>,
) {
    let tracked_index = root.map(|r| workspace::TrackedPathIndex::new(r, tracked));
    let keep = |name: &str| {
        if !crate::workspace::is_generated_artifact(Path::new(name)) {
            return true;
        }
        if let Some(index) = &tracked_index {
            index.matches(name) || index.has_tracked_generated_descendant(name)
        } else {
            crate::workspace::tracked_path_matches(root, tracked, name)
        }
    };
    view.entries.retain(|name, _| keep(name));
    view.hardlinks.retain(keep);
    view.repositories.retain(|name, nested| {
        if !keep(name) {
            return false;
        }
        strip_generated_at(nested, tracked, root);
        true
    });
}

pub(crate) fn verify_result_scoped(
    path: &Path,
    source: &Path,
    head: &str,
    exclusions: &[String],
) -> Result<(), String> {
    if !is_bound(path) || !has_record(source, head) {
        // Without recorded evidence there is nothing to compare against; a
        // stale or reclaimed head must not block a rebaseline.
        return Ok(());
    }
    let (mut current, _) =
        node_view(path, source, exclusions)?.ok_or("Missing current project view")?;
    let mut recorded = load(&record_path(source, head)?)?;
    let tracked = workspace::project_tracked_paths(path);
    strip_generated_at(&mut current, &tracked, Some(path));
    strip_generated_at(&mut recorded, &tracked, Some(path));
    if current != recorded {
        return Err("Completed project/Git metadata changed outside its recorded execution".into());
    }
    Ok(())
}

pub(crate) fn preparation_guard(path: &Path, exclusions: &[String]) -> Result<String, String> {
    // Only recorded, root-qualified managed W scopes may change during E
    // restoration. All ordinary project/Git metadata stays in this guard.
    let view = if exclusions.is_empty() {
        inspect(path)?
    } else {
        inspect_scoped(path, path, exclusions)?
    };
    let bytes = serde_json::to_vec(&view).map_err(|e| e.to_string())?;
    Ok(git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
        .map_err(|e| e.to_string())?
        .to_string())
}

/// Staging evidence retained only until this leased snapshot finishes. The base
/// comparison is already checksum-validated; a different HEAD still reads its
/// own record. No observation survives into another snapshot attempt.
pub(crate) struct StagedNodeSnapshot {
    pub(crate) identity: Option<String>,
    base_match: Option<(String, bool)>,
}

impl StagedNodeSnapshot {
    pub(crate) fn record_matches(&self, source: &Path, head: &str) -> Result<bool, String> {
        if let Some((base, matches)) = &self.base_match {
            if base == head {
                return Ok(*matches);
            }
        }
        match self.identity.as_deref() {
            Some(identity) => record_matches(source, head, identity),
            None => Ok(true),
        }
    }
}

#[cfg(test)]
pub(crate) fn stage_node_snapshot(
    path: &Path,
    source: &Path,
    exclusions: &[String],
) -> Result<Option<String>, String> {
    Ok(stage_node_snapshot_with_record(path, source, exclusions)?.identity)
}

/// Inspect and stage one node snapshot while the caller holds its slot lease.
/// Unscoped staging uses the project entries just inspected for identity;
/// managed scopes retain the scoped Git collector. Post-import capture still
/// makes its independent fresh inspection.
pub(crate) fn stage_node_snapshot_with_record(
    path: &Path,
    source: &Path,
    exclusions: &[String],
) -> Result<StagedNodeSnapshot, String> {
    let observed = match node_view(path, source, exclusions)? {
        Some((view, _)) => {
            let identity = node_view_identity(&view)?;
            let base_match = reject_undeliverable_special_changes(path, source, &view, &identity)?;
            // Only project entries become staging inputs. Drop native Git
            // metadata and topology here, before building the graph index.
            Some((identity, view.entries, base_match))
        }
        None => None,
    };
    let Some((identity, entries, base_match)) = observed else {
        workspace::stage_scoped_local(path, exclusions)?;
        return Ok(StagedNodeSnapshot {
            identity: None,
            base_match: None,
        });
    };
    let metadata = workspace::private_git_dir(path).unwrap_or_else(|| path.join(".git"));
    stage_project_entries(path, &metadata, entries)?;
    Ok(StagedNodeSnapshot {
        identity: Some(identity),
        base_match,
    })
}

#[cfg(test)]
pub(crate) fn node_identity_scoped(
    path: &Path,
    source: &Path,
    exclusions: &[String],
) -> Result<Option<String>, String> {
    node_view(path, source, exclusions)?
        .map(|(view, _)| node_view_identity(&view))
        .transpose()
}
/// Recorded-view identity: host-managed metadata that does not change the
/// project is normalized away so equivalent workspaces compare equal.
fn node_view_identity(view: &View) -> Result<String, String> {
    let bytes = normalized_bytes(view)?;
    Ok(git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
        .map_err(|e| e.to_string())?
        .to_string())
}
pub(crate) fn record_matches(source: &Path, head: &str, identity: &str) -> Result<bool, String> {
    let path = record_path(source, head)?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if !metadata.is_dir() || crate::workspace_symlinks::is_link(&metadata) => {
            return Err("Invalid project-view record directory".into());
        }
        Ok(_) => {}
    }
    // A matching checksum file is only a claim: validate its view before
    // reusing the reference. Damaged/partial records must fail, not become
    // 'changed metadata' that a new snapshot silently replaces from live files.
    Ok(node_view_identity(&load(&path)?)? == identity)
}

/// Recheck the private node slot (`path`), not the live source directory.
/// `source` identifies the binding and immutable evidence store; edits to its
/// working files or native Git state must not invalidate a node's handoff.
pub(crate) fn capture_node_scoped(
    path: &Path,
    source: &Path,
    head: &str,
    exclusions: &[String],
    staged_identity: Option<&str>,
) -> Result<(), String> {
    let Some((view, inherited)) = node_view(path, source, exclusions)? else {
        return if staged_identity.is_some() {
            Err(
                "Node workspace view disappeared between staging and capture; retry snapshot"
                    .into(),
            )
        } else {
            Ok(())
        };
    };
    let record = ViewRecord::new(&view)?;
    // A fresh scan alone is not verification: a new record could otherwise
    // bind changed bytes/metadata to the already-staged (older) Git tree.
    if staged_identity.is_some_and(|identity| identity != record.identity) {
        return Err("Node workspace changed between staging and capture; retry snapshot".into());
    }
    capture_node_view(path, source, head, record, inherited.as_deref(), true)
}

/// Record an immutable project view that the caller already inspected, avoiding
/// a second scan of the whole workspace for the same state. `launchable` marks a
/// workspace that an agent may enter; a composition that only recorded a view
/// never launches there and has no graph checkout to compare against.
fn capture_node_view(
    path: &Path,
    source: &Path,
    head: &str,
    record: ViewRecord<'_>,
    inherited: Option<&Path>,
    launchable: bool,
) -> Result<(), String> {
    let view = record.view;
    let target = record_path(source, head)?;
    if target.exists() {
        if load(&target)? != *view {
            return Err(
                "Project metadata changed without a new immutable code/view reference".into(),
            );
        }
        // A sibling can win publication of the same commit/view after this
        // slot moved HEAD. Shared evidence does not update this slot's gate.
        if launchable && is_bound(path) {
            mark_ready_at(path, head)?;
        }
        return Ok(());
    }
    fs::create_dir_all(target.parent().ok_or("Missing project view store")?)
        .map_err(|e| e.to_string())?;
    let pending = target.with_extension(format!("pending-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&pending).map_err(|e| e.to_string())?;
    let mut pending_guard = PendingDirGuard::new(pending.clone());
    if let Some(record) = inherited {
        copy_recorded_repositories(record, &pending, view)?;
    } else {
        copy_project_repositories(path, &pending, view)?;
    }
    record.save(&pending)?;
    if let Err(error) = fs::rename(&pending, &target) {
        // A concurrent writer may have published the same immutable record first.
        if target.exists() && load(&target).ok().as_ref() == Some(view) {
            drop(pending_guard);
        } else {
            return Err(format!(
                "Cannot publish project-view record {}: {error}",
                target.display()
            ));
        }
    } else {
        pending_guard.disarm();
    }
    if launchable && is_bound(path) {
        mark_ready_at(path, head)?;
    }
    Ok(())
}

fn plain_fingerprint(path: &Path) -> Result<(Option<String>, Option<u128>), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let data = if metadata.is_file() {
                git2::Oid::hash_file(git2::ObjectType::Blob, path)
                    .map_err(|e| e.to_string())?
                    .to_string()
            } else if metadata.file_type().is_symlink() {
                name_of(&fs::read_link(path).map_err(|e| e.to_string())?)?
            } else {
                return Err("Conflict path is not a file/link".into());
            };
            let modified = metadata
                .modified()
                .map_err(|e| e.to_string())?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            Ok((Some(data), Some(modified)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((None, None)),
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn import_resolution(path: &Path) -> Result<(), ResolutionError> {
    accept_resolution_checked(path, false)
}
pub(crate) fn accept_resolution(path: &Path, explicit: bool) -> Result<(), String> {
    accept_resolution_checked(path, explicit).map_err(|error| error.to_string())
}
fn accept_resolution_checked(path: &Path, explicit: bool) -> Result<(), ResolutionError> {
    if !is_bound(path) {
        return Ok(());
    }
    // The Merger targets graph Git even for a plain source without .git.
    // Inspect that index before backend staging could erase unresolved entries.
    let unmerged = workspace::git(path, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
    if path.join(".git").exists() && !unmerged.is_empty() {
        return Err(ResolutionError::Repair(format!(
            "Merger left unresolved project conflicts: {}",
            unmerged.trim_end_matches('\0').replace('\0', ", ")
        )));
    }
    let mut checked_paths = Vec::new();
    if !path.join(".git").exists()
        && !explicit
        && workspace::git(path, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok()
    {
        let proof = crate::workspace_state::process_root(path)?.join(".merge-input.json");
        let before: BTreeMap<String, (Option<String>, Option<u128>)> = serde_json::from_slice(
            &fs::read(proof).map_err(|_| "Missing plain-project conflict evidence")?,
        )
        .map_err(|e| e.to_string())?;
        checked_paths = before.keys().cloned().collect();
        let mut args = vec![
            "--literal-pathspecs",
            "diff-files",
            "--name-only",
            "--no-ext-diff",
            "-z",
            "--",
        ];
        args.extend(checked_paths.iter().map(String::as_str));
        let unstaged = workspace::git(path, &args)?;
        for (name, original) in before {
            if Path::new(&name)
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err("Unsafe conflict evidence path".into());
            }
            if unmerged.split('\0').any(|entry| entry == name) {
                if plain_fingerprint(&path.join(&name))? == original {
                    return Err(ResolutionError::Repair(format!("Plain-project conflict {name} has no explicit resolution write/delete or staging; refusing synthetic completion")));
                }
            } else if unstaged.split('\0').any(|entry| entry == name) {
                // Removing conflict stages (e.g. git reset -- <path>) is not
                // proof that the remaining working file was resolved. Never
                // overwrite that index evidence with backend staging first.
                return Err(ResolutionError::Repair(format!(
                    "Plain-project conflict {name} does not match its staged resolution; resolve and stage the working file"
                )));
            }
        }
    }
    let metadata = workspace::private_git_dir(path).ok_or("Missing private graph Git")?;
    stage_project(path, &metadata)?;
    // Also reject explicitly staged markers or a mere touch of the original
    // conflict. Limit this check to the actual conflict paths, not unrelated
    // inherited files (which may legitimately contain fixture markers).
    if !checked_paths.is_empty() {
        if let Some(diagnostic) = workspace::check_staged_patch(path, &checked_paths)? {
            return Err(ResolutionError::Repair(format!(
                "Resolved project files failed git diff --cached --check:\n{diagnostic}"
            )));
        }
    }
    Ok(())
}

pub(crate) fn prepare_conflicts(source: &Path, path: &Path) -> Result<(), String> {
    let base = workspace::git(path, &["rev-parse", "refs/grapher/base"])?;
    let parents = workspace::git(
        path,
        &[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/grapher/parents/",
        ],
    )?;
    prepare(
        source,
        path,
        &base,
        &parents.lines().map(str::to_owned).collect::<Vec<_>>(),
        &[],
        false,
    )?;
    if !path.join(".git").exists() {
        let conflicts = workspace::git(path, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
        let before = conflicts
            .split('\0')
            .filter(|name| !name.is_empty())
            .map(|name| Ok((name.to_string(), plain_fingerprint(&path.join(name))?)))
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        fs::write(
            crate::workspace_state::process_root(path)?.join(".merge-input.json"),
            serde_json::to_vec(&before).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let entries = workspace::git(path, &["ls-files", "--unmerged", "--stage", "-z"])?;
    let mut input = Vec::new();
    let mut removed = std::collections::BTreeSet::new();
    for item in entries.split('\0').filter(|s| !s.is_empty()) {
        let (header, name) = item.split_once('\t').ok_or("Invalid conflict index")?;
        let oid = header
            .split_whitespace()
            .nth(1)
            .ok_or("Invalid conflict object")?;
        let bytes = workspace::git_bytes(path, &["cat-file", "blob", oid], None, None)?;
        workspace::project_git_bytes(
            path,
            &["hash-object", "-w", "--stdin", "--no-filters"],
            Some(&bytes),
        )?;
        if removed.insert(name) {
            crate::workspace_git_index::append_index_info(
                &mut input,
                "0",
                &"0".repeat(oid.len()),
                name,
            );
        }
        input.extend_from_slice(item.as_bytes());
        input.push(0);
    }
    // Keep the source/parent index distinctions on every non-conflicted path,
    // including native ignored files. Only actual conflict entries are replaced.
    workspace::project_git_bytes(path, &["update-index", "-z", "--index-info"], Some(&input))?;
    Ok(())
}

#[cfg(test)]
#[path = "workspace_view_tests.rs"]
mod tests;
