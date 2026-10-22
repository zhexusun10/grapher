//! A project Git view is not the graph repository. Immutable view records bind
//! project metadata and the user's Git state to the same internal code commit.
//! Project bytes remain Git blobs; no live-source copy is used on a retry/fork.
use crate::{native_copy, path_safety::real_child_path, workspace};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

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
struct View {
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

// View equality follows the source-equivalent identity: per-path storage
// history (`security`) and the per-workspace `.git/index` stat cache are
// excluded, so two otherwise-equal project views compare equal.
impl PartialEq for View {
    fn eq(&self, other: &Self) -> bool {
        normalized_bytes(self).ok() == normalized_bytes(other).ok()
    }
}
impl Eq for View {}

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
fn scan(
    root: &Path,
    relative: &Path,
    entries: &mut BTreeMap<String, Entry>,
    git: bool,
) -> Result<(), String> {
    scan_scoped(root, relative, entries, git, root)
}
fn scan_scoped(
    root: &Path,
    relative: &Path,
    entries: &mut BTreeMap<String, Entry>,
    git: bool,
    owner: &Path,
) -> Result<(), String> {
    for item in fs::read_dir(root.join(relative)).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let path = relative.join(item.file_name());
        if !git && item.file_name() == ".git" {
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
        let metadata = fs::symlink_metadata(&absolute).map_err(|e| e.to_string())?;
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
            scan_scoped(root, &path, entries, git, owner)?;
            Entry::Directory {
                mode: mode(&metadata),
                extra,
            }
        } else if metadata.is_file() {
            Entry::File {
                mode: mode(&metadata),
                blob: git2::Oid::hash_file(git2::ObjectType::Blob, &absolute)
                    .map_err(|e| e.to_string())?
                    .to_string(),
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
/// Only special entries for the undeliverable-change gate; do not hash project
/// bytes a second time just to discover that no pipe/device changed.
fn special_signature(root: &Path) -> Result<BTreeMap<String, Entry>, String> {
    fn visit(
        root: &Path,
        relative: &Path,
        entries: &mut BTreeMap<String, Entry>,
    ) -> Result<(), String> {
        for item in fs::read_dir(root.join(relative)).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            if item.file_name() == ".git" {
                continue;
            }
            let path = relative.join(item.file_name());
            let absolute = root.join(&path);
            let metadata = fs::symlink_metadata(&absolute).map_err(|e| e.to_string())?;
            if crate::workspace_symlinks::is_link(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                visit(root, &path, entries)?;
            } else if let Some((special, device)) = special_entry(&metadata) {
                entries.insert(
                    name(&path)?,
                    Entry::Special {
                        special: special.into(),
                        mode: mode(&metadata),
                        device,
                        extra: crate::workspace_metadata::capture(&absolute, &metadata)?,
                    },
                );
            }
        }
        Ok(())
    }
    let mut entries = BTreeMap::new();
    visit(root, Path::new(""), &mut entries)?;
    Ok(entries)
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
fn remove_entry(entry: &Entry, path: &Path) -> Result<(), String> {
    match entry {
        Entry::Link { .. } => crate::workspace_symlinks::remove(path),
        Entry::Directory { .. }
            if path.is_dir()
                && !crate::workspace_symlinks::is_link(
                    &fs::symlink_metadata(path).map_err(|e| e.to_string())?,
                ) =>
        {
            fs::remove_dir(path).map_err(|e| e.to_string())
        }
        _ => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}
fn inspect(source: &Path) -> Result<View, String> {
    inspect_scoped(source, source)
}
fn inspect_scoped(source: &Path, owner: &Path) -> Result<View, String> {
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    let data = workspace::data_root();
    if data.exists() && workspace::scope_contains(&data, &source) {
        return Err("Runtime data is inside the source project; configure an external GRAPHER_DATA_DIR before preparing an equivalent workspace".into());
    }
    let mut entries = BTreeMap::new();
    scan_scoped(&source, Path::new(""), &mut entries, false, owner)?;
    let mut repositories = BTreeMap::new();
    for (relative, entry) in &entries {
        if !matches!(entry, Entry::Directory { .. })
            || fs::symlink_metadata(source.join(relative).join(".git")).is_err()
        {
            continue;
        }
        if repositories
            .keys()
            .any(|parent: &String| Path::new(relative).starts_with(parent))
        {
            continue;
        }
        repositories.insert(
            relative.clone(),
            inspect_scoped(&source.join(relative), owner)?,
        );
    }
    let hardlinks = capture_links(&source, &entries)?;
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
        schema: 5,
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
fn capture_links(
    root: &Path,
    entries: &BTreeMap<String, Entry>,
) -> Result<crate::workspace_links::Topology, String> {
    crate::workspace_links::capture(
        root,
        entries
            .iter()
            .filter(|(_, entry)| matches!(entry, Entry::File { .. }))
            .map(|(name, _)| name.clone()),
    )
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
        && !fs::metadata(project.join(".git"))
            .map_err(|e| e.to_string())?
            .is_dir()
    {
        return Err(
            "Workspace capability gap: symbolic .git must resolve to a repository directory".into(),
        );
    }
    let current = PathBuf::from(workspace::project_git(
        project,
        &["rev-parse", "--absolute-git-dir"],
    )?)
    .canonicalize()
    .map_err(|e| e.to_string())?;
    let common = PathBuf::from(workspace::project_git(
        project,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?)
    .canonicalize()
    .map_err(|e| e.to_string())?;
    Ok(Some((common, current, metadata.is_file(), link)))
}
fn inspect_git(
    project: &Path,
) -> Result<
    (
        Option<BTreeMap<String, Entry>>,
        bool,
        bool,
        Vec<(String, String)>,
        BTreeMap<String, (String, bool)>,
        Vec<u8>,
    ),
    String,
> {
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
        &["config", "--null", "--show-origin", "--list", "--includes"],
    )?;
    let mut records = Vec::new();
    let mut fields = effective.split('\0');
    while let Some(origin) = fields.next() {
        if origin.is_empty() {
            continue;
        }
        let Some(record) = fields.next() else {
            break;
        };
        let (key, value) = record.split_once('\n').unwrap_or((record, ""));
        records.push((origin.to_string(), key.to_string(), value.to_string()));
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
    for (origin, key, value) in &records {
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
        let resolved = resolved.canonicalize().unwrap_or(resolved);
        let matched = records.iter().any(|(input_origin, input_key, _)| {
            !directive(input_key)
                && origin_path(input_origin)
                    .map(|path| path.canonicalize().unwrap_or(path))
                    .is_some_and(|path| path == resolved)
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
        let reference = if let Ok(relative) = file.strip_prefix(project) {
            format!("{{workspace}}/{}", name_of(relative)?)
        } else {
            crate::native::host_path(&file)
                .to_string_lossy()
                .replace('\\', "/")
        };
        let scope =
            workspace::project_git(project, &["config", "--null", "--show-scope", "--get", key])
                .unwrap_or_default();
        let local = matches!(scope.split('\0').next(), Some("local" | "worktree"));
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
fn copy_project_git(project: &Path, target: &Path) -> Result<(), String> {
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
                if destination.exists() && !destination.is_dir() {
                    fs::remove_file(&destination).map_err(|e| e.to_string())?;
                }
                fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
                clear_git_overlays(&item.path(), &destination)?;
                native_copy::copy_tree(&item.path(), &destination, |_| false)?;
            } else {
                if destination.is_dir() {
                    fs::remove_dir_all(&destination).map_err(|e| e.to_string())?;
                } else if destination.exists() {
                    fs::remove_file(&destination).map_err(|e| e.to_string())?;
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
    let mut entries = inspect_git(project)?
        .0
        .ok_or("Missing project Git metadata")?;
    entries.remove("objects/info/alternates");
    restore_git_metadata(target, &entries)
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
        if item.file_type().map_err(|e| e.to_string())?.is_dir() && existing.is_dir() {
            clear_git_overlays(&item.path(), &destination)?;
        } else if existing.is_dir() {
            fs::remove_dir_all(&destination).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(&destination).map_err(|e| e.to_string())?;
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
    if view.git_entries.is_some() {
        copy_project_git(project, &record.join("git"))?;
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
    if view.git_entries.is_some() {
        copy_git(&source.join("git"), &destination.join("git"))?;
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
        if !target.join(".git").exists() {
            install_git_scoped(owner, &target, &record, selected)?;
        }
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
        let native = target
            .join(".git")
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let state = crate::workspace_state::process_root(owner)?
            .canonicalize()
            .map_err(|e| e.to_string())?;
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
/// Serialize a view for identity/equality purposes with every `security`
/// field removed. The SDDL is path/inheritance-specific storage history that
/// Windows re-derives on restore, so it must not distinguish otherwise-equal
/// project views (for example the independent entries of one publication).
fn normalized_bytes(view: &View) -> Result<Vec<u8>, String> {
    fn strip(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                map.remove("security");
                for item in map.values_mut() {
                    strip(item);
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    strip(item);
                }
            }
            _ => {}
        }
    }
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
    let mut value = serde_json::to_value(view).map_err(|e| e.to_string())?;
    remove_git_index(&mut value);
    strip(&mut value);
    serde_json::to_vec(&value).map_err(|e| e.to_string())
}

fn save(path: &Path, view: &View) -> Result<(), String> {
    let bytes = serde_json::to_vec(view).map_err(|e| e.to_string())?;
    let checksum = git2::Oid::hash_object(git2::ObjectType::Blob, &normalized_bytes(view)?)
        .map_err(|e| e.to_string())?
        .to_string();
    fs::write(path.join("view.json"), bytes).map_err(|e| e.to_string())?;
    fs::write(path.join("checksum"), checksum).map_err(|e| e.to_string())
}
fn load(path: &Path) -> Result<View, String> {
    let bytes = fs::read(path.join("view.json")).map_err(|e| format!("Missing complete project-view evidence: {e}; start a new Run (existing workspace retained)"))?;
    let expected = fs::read_to_string(path.join("checksum")).map_err(|e| e.to_string())?;
    let view: View = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if git2::Oid::hash_object(git2::ObjectType::Blob, &normalized_bytes(&view)?)
        .map_err(|e| e.to_string())?
        .to_string()
        != expected
    {
        return Err("Damaged project-view evidence; refusing a partial reconstruction".into());
    }
    if view.schema != 5 {
        return Err("Unsupported project-view schema".into());
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
    Ok(view)
}
fn restore_git_metadata(target: &Path, entries: &BTreeMap<String, Entry>) -> Result<(), String> {
    for (name, entry) in entries.iter().rev() {
        restore_entry(&target.join(name), entry)?;
    }
    Ok(())
}
fn copy_git(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target).map_err(|e| e.to_string())?;
    native_copy::copy_tree(source, target, git_lock)?;
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
pub(crate) fn stage_project(path: &Path, metadata: &Path) -> Result<(), String> {
    let mut entries = BTreeMap::new();
    scan(path, Path::new(""), &mut entries, false)?;
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
        return stage_sha256(path, metadata, entries);
    }
    let repository = git2::Repository::open(metadata).map_err(|e| e.to_string())?;
    let old_modes: BTreeMap<Vec<u8>, u32> = repository
        .index()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|entry| (entry.path, entry.mode))
        .collect();
    let mut index = git2::Index::new().map_err(|e| e.to_string())?;
    for (name, entry) in entries {
        let (oid, mode) = match entry {
            Entry::Directory { .. } => continue,
            Entry::Special { .. } => continue,
            Entry::File { mode, blob, .. } => {
                let file = path.join(&name);
                let oid =
                    if fs::metadata(&file).map_err(|e| e.to_string())?.len() <= 8 * 1024 * 1024 {
                        repository
                            .blob(&fs::read(&file).map_err(|e| e.to_string())?)
                            .map_err(|e| e.to_string())?
                    } else {
                        let file = crate::native::host_path(&file);
                        let oid = workspace::git(
                            path,
                            &[
                                "--git-dir",
                                metadata.to_str().ok_or("Invalid graph metadata path")?,
                                "hash-object",
                                "-w",
                                "--no-filters",
                                "--",
                                file.to_str().ok_or("Invalid file path")?,
                            ],
                        )?;
                        git2::Oid::from_str(&oid).map_err(|e| e.to_string())?
                    };
                if oid.to_string() != blob {
                    return Err(
                        "Project changed while binding its byte snapshot; retry preparation".into(),
                    );
                }
                let executable = if cfg!(unix) {
                    mode & 0o111 != 0
                } else {
                    old_modes.get(name.as_bytes()) == Some(&0o100755)
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
                path: name.into_bytes(),
            })
            .map_err(|e| e.to_string())?;
    }
    let tree = index
        .write_tree_to(&repository)
        .map_err(|e| e.to_string())?;
    workspace::git(
        path,
        &[
            "--git-dir",
            metadata.to_str().ok_or("Invalid graph metadata path")?,
            "--work-tree",
            path.to_str().ok_or("Invalid project root")?,
            "read-tree",
            &tree.to_string(),
        ],
    )?;
    Ok(())
}

fn stage_sha256(
    path: &Path,
    metadata: &Path,
    entries: BTreeMap<String, Entry>,
) -> Result<(), String> {
    let mut input = Vec::new();
    let prefix = [
        "--git-dir",
        metadata.to_str().ok_or("Invalid graph Git")?,
        "--work-tree",
        path.to_str().ok_or("Invalid project path")?,
    ];
    for (name, entry) in entries {
        let (oid, mode) = match entry {
            Entry::Directory { .. } => continue,
            Entry::Special { .. } => continue,
            Entry::File { mode, blob, .. } => {
                let file = crate::native::host_path(&path.join(&name));
                let mut args = prefix.to_vec();
                args.extend([
                    "hash-object",
                    "-w",
                    "--no-filters",
                    "--",
                    file.to_str().ok_or("Invalid file path")?,
                ]);
                let oid = workspace::git(path, &args)?;
                if git2::Oid::hash_file(git2::ObjectType::Blob, &file)
                    .map_err(|e| e.to_string())?
                    .to_string()
                    != blob
                {
                    return Err("Project changed while capturing SHA-256 bytes".into());
                }
                (
                    oid,
                    if cfg!(unix) && mode & 0o111 != 0 {
                        "100755"
                    } else {
                        "100644"
                    },
                )
            }
            Entry::Link { target, .. } => {
                let mut args = prefix.to_vec();
                args.extend(["hash-object", "-w", "--no-filters", "--stdin"]);
                let oid = workspace::git_bytes(path, &args, None, Some(target.value.as_bytes()))?;
                (
                    String::from_utf8(oid)
                        .map_err(|e| e.to_string())?
                        .trim()
                        .into(),
                    "120000",
                )
            }
        };
        input.extend_from_slice(format!("{mode} {oid}\t{name}\0").as_bytes());
    }
    let mut args = prefix.to_vec();
    args.extend(["read-tree", "--empty"]);
    workspace::git(path, &args)?;
    let mut args = prefix.to_vec();
    args.extend(["update-index", "-z", "--index-info"]);
    workspace::git_bytes(path, &args, None, Some(&input))?;
    Ok(())
}

pub(crate) fn has_record(source: &Path, head: &str) -> bool {
    record_path(source, head).is_ok_and(|path| path.join("view.json").is_file())
}

pub(crate) fn source_identity(source: &Path) -> Result<String, String> {
    let bytes = serde_json::to_vec(&inspect(source)?).map_err(|e| e.to_string())?;
    Ok(git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
        .map_err(|e| e.to_string())?
        .to_string())
}
pub(crate) fn capture_source(source: &Path, head: &str, identity: &str) -> Result<(), String> {
    let view = inspect(source)?;
    if source_identity(source)? != identity {
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
    copy_project_repositories(source, &pending, &view)?;
    if inspect(source)? != view {
        return Err(
            "Source changed while copying project Git; original data retained, retry preparation"
                .into(),
        );
    }
    save(&pending, &view)?;
    if let Err(error) = fs::rename(&pending, &target) {
        // A concurrent writer may have published the same immutable record first.
        if target.exists() && load(&target).ok().as_ref() == Some(&view) {
            let _ = fs::remove_dir_all(&pending);
        } else {
            return Err(format!(
                "Cannot publish project-view record {}: {error}",
                target.display()
            ));
        }
    }
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
fn install_git(path: &Path, record: &Path, view: &View) -> Result<(), String> {
    install_git_scoped(path, path, record, view)
}
fn install_git_scoped(owner: &Path, path: &Path, record: &Path, view: &View) -> Result<(), String> {
    if path.join(".git").exists() {
        return Err("Refusing to replace an existing project Git view".into());
    }
    if view.git_entries.is_some() {
        let git_dir = if view.git_file || view.git_link {
            let state = crate::workspace_state::prepare(owner)?;
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
        };
        copy_git(&record.join("git"), &git_dir)?;
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
        let short = std::env::temp_dir();
        let pending = short.join(format!("grapher-gitcfg-{}", uuid::Uuid::new_v4()));
        fs::write(&pending, b"").map_err(|e| e.to_string())?;
        let pending_text = crate::native::host_path(&pending)
            .to_str()
            .ok_or("Invalid Git configuration path")?
            .to_string();
        let config = |args: &[&str]| workspace::project_git(&short, args);
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
                &crate::native::host_path(path)
                    .to_string_lossy()
                    .replace('\\', "/"),
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
        fs::copy(&pending, git_dir.join("config")).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&pending);
        let worktree_config = git_dir.join("config.worktree");
        if worktree_config.is_file() {
            let scratch = short.join(format!("grapher-gitwt-{}", uuid::Uuid::new_v4()));
            fs::copy(&worktree_config, &scratch).map_err(|e| e.to_string())?;
            let scratch_text = crate::native::host_path(&scratch)
                .to_str()
                .ok_or("Invalid worktree Git configuration path")?
                .to_string();
            if config(&["config", "--file", &scratch_text, "--get", "core.worktree"]).is_ok() {
                config(&[
                    "config",
                    "--file",
                    &scratch_text,
                    "--replace-all",
                    "core.worktree",
                    &crate::native::host_path(path)
                        .to_string_lossy()
                        .replace('\\', "/"),
                ])?;
                fs::copy(&scratch, &worktree_config).map_err(|e| e.to_string())?;
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
fn mark_ready(path: &Path) -> Result<(), String> {
    let file = ready(path)?;
    let root = crate::workspace_state::root(path)?;
    crate::path_safety::real_child_path(&root, &file, true)?;
    fs::write(file, workspace::git(path, &["rev-parse", "HEAD"])?).map_err(|e| e.to_string())
}
pub(crate) fn validate_ready(path: &Path, source: &Path) -> Result<(), String> {
    validate_bound(path, source)?;
    crate::workspace::private_git_dir(path).ok_or(
        "Private project view is missing its graph Git metadata; retry preparation",
    )?;
    let file = ready(path)?;
    let root = crate::workspace_state::root(path)?;
    crate::path_safety::real_child_path(&root, &file, true)?
        .ok_or("Private project preparation did not pass its complete-view gate")?;
    let recorded = fs::read_to_string(file)
        .map_err(|_| "Private project preparation did not pass its complete-view gate")?;
    if recorded != workspace::git(path, &["rev-parse", "HEAD"])? {
        return Err("Project view preparation is incomplete for the current graph input".into());
    }
    if let Some((common, current, _, _)) = git_roots(path)? {
        let project = path.canonicalize().map_err(|e| e.to_string())?;
        let state = crate::workspace_state::process_root(path)?;
        let state_root = state.canonicalize().map_err(|e| e.to_string())?;
        let external_path = state.join(".project-git");
        if external_path.exists() {
            crate::path_safety::real_child_path(&state, &external_path, false)?;
        }
        let local = project
            .join(".git")
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !local.starts_with(&project) && !local.starts_with(&state_root) {
            return Err("Project Git metadata left its private binding".into());
        }
        let external = external_path.canonicalize().ok();
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
        if item.file_name() == ".git" {
            continue;
        }
        let path = item.path();
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || crate::workspace_symlinks::is_link(&metadata) {
            continue;
        }
        if path.join(".git").exists() {
            let (common, current, _, _) =
                git_roots(&path)?.ok_or("Nested project lost its Git binding")?;
            let project = path.canonicalize().map_err(|e| e.to_string())?;
            let state = crate::workspace_state::process_root(owner)?;
            let state_root = state.canonicalize().map_err(|e| e.to_string())?;
            let local = project
                .join(".git")
                .canonicalize()
                .map_err(|e| e.to_string())?;
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
            let external = external_path.canonicalize().ok();
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

/// Only project blobs and real user Git cross this boundary. The final recursive
/// comparison is a launch gate, not filtered tool output or an ignore policy.
pub(crate) fn prepare(
    source: &Path,
    path: &Path,
    base: &str,
    parents: &[String],
) -> Result<(), String> {
    let base_view = load(&record_path(source, base)?)?;
    let mut inputs = Vec::new();
    for head in parents {
        let record = record_path(source, head)?;
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
    if is_bound(path) {
        validate_bound(path, source)?;
        if view.git_entries.is_some() && !path.join(".git").exists() {
            install_git(path, &record, &view)?;
        }
    } else {
        install_git(path, &record, &view)?;
        crate::workspace_state::prepare(path)?;
        fs::write(binding(path)?, &view.source).map_err(|e| e.to_string())?;
    }
    let ready = ready(path)?;
    if ready.exists() {
        fs::remove_file(&ready).map_err(|e| e.to_string())?;
    }
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
    let conflict = workspace::git(path, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok();
    let mut actual = BTreeMap::new();
    scan(path, Path::new(""), &mut actual, false)?;
    let mut expected = BTreeMap::new();
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
            let data = workspace::git_bytes(path, &["cat-file", "blob", fields[2]], None, None)?;
            let target = path.join(name);
            if fields[0] == "120000" {
                let target_name = String::from_utf8(data).map_err(|_| "Non-UTF-8 project link")?;
                let baseline = base_view
                    .entries
                    .get(name)
                    .filter(|entry| matches!(entry, Entry::Link { .. }));
                let candidates = inputs
                    .iter()
                    .map(|(_, view)| {
                        view.entries
                            .get(name)
                            .filter(|entry| matches!(entry, Entry::Link { .. }))
                    })
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
                expected.insert(name.into(), Entry::Link { target, extra });
            } else {
                real_child_path(path, &target, true)?;
                let blob = git2::Oid::hash_object(git2::ObjectType::Blob, &data)
                    .map_err(|e| e.to_string())?
                    .to_string();
                if !matches!(actual.get(name), Some(Entry::File { blob: actual, .. }) if actual == &blob)
                {
                    if let Some(existing) = actual.get(name) {
                        if !matches!(existing, Entry::File { .. }) {
                            remove_entry(existing, &target)?;
                        }
                    }
                    if let Ok(metadata) = fs::metadata(&target) {
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
    for name in expected.keys() {
        let mut parent = Path::new(name).parent();
        while let Some(path) = parent.filter(|path| !path.as_os_str().is_empty()) {
            directory_names.insert(name_of(path)?);
            parent = path.parent();
        }
    }
    for name in base_view
        .entries
        .keys()
        .chain(inputs.iter().flat_map(|(_, view)| view.entries.keys()))
    {
        if directory_names.contains(name) {
            continue;
        }
        let base = base_view
            .entries
            .get(name)
            .filter(|entry| matches!(entry, Entry::Directory { .. }));
        let candidates: Vec<_> = inputs
            .iter()
            .map(|(_, view)| {
                view.entries
                    .get(name)
                    .filter(|entry| matches!(entry, Entry::Directory { .. }))
            })
            .collect();
        if let Some(directory) = choose_metadata(base, &candidates, name)? {
            expected.entry(name.clone()).or_insert(directory);
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
                    matches!(entry, Entry::Special { .. }) && !base_view.entries.contains_key(*name)
                })
                .map(|(name, _)| name.clone()),
        )
        .collect();
    for name in special_names {
        if expected.contains_key(&name) || directory_names.contains(&name) {
            continue;
        }
        let values: Vec<Option<Entry>> = inputs
            .iter()
            .map(|(_, view)| {
                view.entries
                    .get(&name)
                    .filter(|entry| matches!(entry, Entry::Special { .. }))
                    .cloned()
            })
            .collect();
        if values.len() > 1 && values.iter().any(|value| *value != values[0]) {
            return Err(format!(
                "Project special-entry composition conflict at {name}; no task input's file type is discarded"
            ));
        }
        let selected = match values.last() {
            Some(value) => value.clone(),
            None => base_view
                .entries
                .get(&name)
                .filter(|entry| matches!(entry, Entry::Special { .. }))
                .cloned(),
        };
        if let Some(entry) = selected {
            expected.insert(name, entry);
        }
    }
    for (name, entry) in &mut expected {
        let base = base_view
            .entries
            .get(name)
            .filter(|base| kind(base) == kind(entry));
        let candidates: Vec<_> = inputs
            .iter()
            .map(|(_, view)| {
                view.entries
                    .get(name)
                    .filter(|input| kind(input) == kind(entry))
            })
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
            real_child_path(path, &target, true)?;
            let same = fs::symlink_metadata(&target)
                .ok()
                .and_then(|metadata| special_entry(&metadata))
                .is_some_and(|(kind, value)| kind == special && value == *device);
            if !same {
                if fs::symlink_metadata(&target).is_ok() {
                    remove_entry(entry, &target)?;
                }
                create_special(&target, special, *special_mode, *device)?;
            }
        }
    }
    let signatures = expected
        .iter()
        .filter(|(_, entry)| matches!(entry, Entry::File { .. }))
        .map(|(name, entry)| {
            Ok((
                name.clone(),
                serde_json::to_string(entry).map_err(|e| e.to_string())?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let link_inputs = inputs
        .iter()
        .map(|(_, view)| &view.hardlinks)
        .collect::<Vec<_>>();
    let topology = crate::workspace_links::compose(
        &base_view.hardlinks,
        &link_inputs,
        &signatures.keys().cloned().collect(),
    )?;
    crate::workspace_links::restore(path, &topology, &signatures)?;
    for (name, entry) in expected.iter().rev() {
        restore_entry(&path.join(name), entry)?;
    }
    for (name, entry) in actual.iter().rev() {
        if matches!(entry, Entry::Special { .. }) && !expected.contains_key(name) {
            fs::remove_file(path.join(name)).map_err(|e| {
                format!("Cannot remove superseded special project entry at {name}: {e}")
            })?;
        }
        if matches!(entry, Entry::Directory { .. }) && !expected.contains_key(name) {
            if base_view.entries.contains_key(name)
                || inputs
                    .iter()
                    .any(|(_, view)| view.entries.contains_key(name))
            {
                fs::remove_dir(path.join(name)).map_err(|e| {
                    format!("Unrecorded files prevent project directory deletion at {name}: {e}")
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
    scan(path, Path::new(""), &mut verified, false)?;
    if verified != expected || capture_links(path, &verified)? != topology {
        return Err("Complete project-view comparison failed; no agent may see the partially prepared workspace".into());
    }
    prepare_repositories(path, path, &record_path(source, base)?, &base_view, &inputs)?;
    mark_ready(path)
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
            if item.file_name() == ".git" {
                continue;
            }
            let path = relative.join(item.file_name());
            let absolute = project.join(&path);
            let metadata = fs::symlink_metadata(&absolute).map_err(|e| e.to_string())?;
            if crate::workspace_symlinks::is_link(&metadata) || !metadata.is_dir() {
                continue;
            }
            if fs::symlink_metadata(absolute.join(".git")).is_ok() {
                views.insert(name(&path)?, inspect_scoped(&absolute, project)?);
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

fn node_view(path: &Path, source: &Path) -> Result<Option<(View, Option<PathBuf>)>, String> {
    if is_bound(path) {
        validate_bound(path, source)?;
        if path.join(".git").exists()
            && !workspace::git(path, &["diff", "--name-only", "--diff-filter=U"])?
                .is_empty()
        {
            return Err("Unresolved project Git conflicts remain".into());
        }
        let mut view = inspect(path)?;
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
    scan(path, Path::new(""), &mut view.entries, false)?;
    view.hardlinks = capture_links(path, &view.entries)?;
    // Do not reuse nested repository evidence recorded from another state:
    // a host-only/fixture checkout can still advance its nested worktrees.
    view.repositories = nested_repository_views(path)?;
    set_source_keys(&mut view, source);
    Ok(Some((view, Some(record))))
}

pub(crate) fn reject_undeliverable_special_changes(
    path: &Path,
    source: &Path,
) -> Result<(), String> {
    if !is_bound(path) {
        return Ok(());
    }
    let Ok(base) = workspace::git(path, &["rev-parse", "refs/grapher/base"]) else {
        return Ok(());
    };
    if !has_record(source, &base) {
        return Ok(());
    }
    let base = load(&record_path(source, &base)?)?;
    let specials = |view: &View| {
        view.entries
            .iter()
            .filter(|(_, entry)| matches!(entry, Entry::Special { .. }))
            .map(|(name, entry)| (name.clone(), entry.clone()))
            .collect::<BTreeMap<_, _>>()
    };
    if specials(&base) == special_signature(path)? {
        return Ok(());
    }
    Err("Task changed special project entries (named pipe/device); files-only publication cannot deliver them, so this result is refused explicitly instead of dropping entries".into())
}

pub(crate) fn seal_prepared(path: &Path, source: &Path) -> Result<String, String> {
    let head = workspace::git(path, &["rev-parse", "HEAD"])?;
    let Some(identity) = node_identity(path, source)? else {
        return Ok(head);
    };
    if !record_matches(source, &head, &identity) {
        if !has_record(source, &head) {
            // A composed publication head has no view record yet. Record the
            // current view for that head instead of manufacturing a per-entry
            // commit, so every entry of one publication keeps the same code
            // reference (`code_ref == head == workspace HEAD`).
            capture_node(path, source, &head)?;
            return Ok(head);
        }
        workspace::git(
            path,
            &[
                "commit",
                "--allow-empty",
                "-m",
                &format!("snapshot\n\nworkspace-view:{identity}"),
            ],
        )?;
    }
    let head = workspace::git(path, &["rev-parse", "HEAD"])?;
    capture_node(path, source, &head)?;
    Ok(head)
}

pub(crate) fn verify_result(path: &Path, source: &Path, head: &str) -> Result<(), String> {
    if !is_bound(path) {
        return Ok(());
    }
    let (current, _) = node_view(path, source)?.ok_or("Missing current project view")?;
    if current != load(&record_path(source, head)?)? {
        return Err("Completed project/Git metadata changed outside its recorded execution".into());
    }
    Ok(())
}

pub(crate) fn preparation_guard(path: &Path) -> Result<String, String> {
    let bytes = serde_json::to_vec(&inspect(path)?).map_err(|e| e.to_string())?;
    Ok(git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
        .map_err(|e| e.to_string())?
        .to_string())
}

pub(crate) fn node_identity(path: &Path, source: &Path) -> Result<Option<String>, String> {
    node_view(path, source)?
        .map(|(view, _)| {
            let bytes = normalized_bytes(&view)?;
            Ok(git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
                .map_err(|e| e.to_string())?
                .to_string())
        })
        .transpose()
}
pub(crate) fn record_matches(source: &Path, head: &str, identity: &str) -> bool {
    record_path(source, head)
        .ok()
        .and_then(|path| fs::read_to_string(path.join("checksum")).ok())
        .as_deref()
        == Some(identity)
}

pub(crate) fn capture_node(path: &Path, source: &Path, head: &str) -> Result<(), String> {
    let Some((view, inherited)) = node_view(path, source)? else {
        return Ok(());
    };
    let target = record_path(source, head)?;
    if target.exists() {
        if load(&target)? != view {
            return Err(
                "Project metadata changed without a new immutable code/view reference".into(),
            );
        }
        return Ok(());
    }
    fs::create_dir_all(target.parent().ok_or("Missing project view store")?)
        .map_err(|e| e.to_string())?;
    let pending = target.with_extension(format!("pending-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&pending).map_err(|e| e.to_string())?;
    if let Some(record) = inherited {
        copy_recorded_repositories(&record, &pending, &view)?;
    } else {
        copy_project_repositories(path, &pending, &view)?;
    }
    save(&pending, &view)?;
    if let Err(error) = fs::rename(&pending, &target) {
        // A concurrent writer may have published the same immutable record first.
        if target.exists() && load(&target).ok().as_ref() == Some(&view) {
            let _ = fs::remove_dir_all(&pending);
        } else {
            return Err(format!(
                "Cannot publish project-view record {}: {error}",
                target.display()
            ));
        }
    }
    if is_bound(path) {
        mark_ready(path)?;
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

pub(crate) fn import_resolution(path: &Path) -> Result<(), String> {
    accept_resolution(path, false)
}
pub(crate) fn accept_resolution(path: &Path, explicit: bool) -> Result<(), String> {
    if !is_bound(path) {
        return Ok(());
    }
    if path.join(".git").exists() {
        // The Merger resolves the composition in the graph Git; the visible
        // project view is a mirror. Inspect the same repository the merge lives
        // in, not the project view's own index.
        let unmerged = workspace::git(path, &["diff", "--name-only", "--diff-filter=U"])?;
        if !unmerged.is_empty() {
            return Err(format!(
                "Merger left unresolved project conflicts: {}",
                unmerged.replace('\n', ", ")
            ));
        }
    }
    if !path.join(".git").exists()
        && !explicit
        && workspace::git(path, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok()
    {
        let proof = crate::workspace_state::process_root(path)?.join(".merge-input.json");
        let before: BTreeMap<String, (Option<String>, Option<u128>)> = serde_json::from_slice(
            &fs::read(proof).map_err(|_| "Missing plain-project conflict evidence")?,
        )
        .map_err(|e| e.to_string())?;
        for (name, original) in before {
            if Path::new(&name)
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err("Unsafe conflict evidence path".into());
            }
            if plain_fingerprint(&path.join(&name))? == original {
                return Err(format!("Plain-project conflict {name} has no explicit resolution write/delete; refusing synthetic completion"));
            }
        }
    }
    let metadata = workspace::private_git_dir(path).ok_or("Missing private graph Git")?;
    stage_project(path, &metadata)
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
            input.extend_from_slice(format!("0 {}\t{name}\0", "0".repeat(oid.len())).as_bytes());
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
