//! Ignored project files use immutable, run-owned filesystem snapshots, not Git
//! objects or writable hardlinks. Versions record their ancestry for fan-in.
use crate::{path_safety::real_child_path, workspace};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

type Entries = BTreeMap<String, Entry>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Entry {
    Directory {
        #[serde(default)]
        mode: u32,
    },
    File {
        blob: String,
        mode: u32,
    },
    Link {
        target: String,
        internal: bool,
        directory: bool,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Version {
    head: String,
    parents: Vec<String>,
    entries: Entries,
    #[serde(default)]
    checksum: Option<String>,
}

impl Version {
    fn checksum(&self) -> Result<String, String> {
        let bytes = serde_json::to_vec(&(&self.head, &self.parents, &self.entries))
            .map_err(|e| e.to_string())?;
        git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
            .map(|id| id.to_string())
            .map_err(|e| e.to_string())
    }
}

pub(crate) struct Files {
    directory: PathBuf,
    excluded_data: PathBuf,
    exclusions: Vec<PathBuf>,
    scopes: Option<Vec<PathBuf>>,
}

fn excluded(path: &Path) -> bool {
    path.components().any(|part| matches!(part, Component::Normal(name) if
        name == ".git" || name == ".grapher" || name == ".grapher-worktrees" || name == ".grapher-workspaces"))
}

fn relative(value: &str) -> Result<&Path, String> {
    let path = Path::new(value);
    if value.is_empty()
        || !path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        || excluded(path)
    {
        return Err(format!("Unsafe workspace file path: {value}"));
    }
    Ok(path)
}

fn path_name(path: &Path) -> Result<String, String> {
    let name = path.to_str().ok_or("Workspace file paths must be UTF-8")?;
    Ok(if cfg!(windows) {
        name.replace('\\', "/")
    } else {
        name.into()
    })
}

fn hash(path: &Path) -> Result<String, String> {
    // Always verify bytes: size/mtime can be restored after corruption, so they
    // cannot safely authorize skipping integrity checks on a live view or blob.
    git2::Oid::hash_file(git2::ObjectType::Blob, path)
        .map(|id| id.to_string())
        .map_err(|error| error.to_string())
}

fn mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        u32::from(metadata.permissions().readonly())
    }
}

impl Files {
    pub(crate) fn new(data: &Path, run: &str) -> Result<Self, String> {
        Uuid::parse_str(run).map_err(|_| "Invalid Run ID for workspace files")?;
        let parent = workspace::workspaces_parent(data);
        fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
        let directory = parent.join(".grapher-worktrees").join(run).join(".files");
        real_child_path(&parent, &directory, false)?;
        fs::create_dir_all(directory.join("versions")).map_err(|error| error.to_string())?;
        fs::create_dir_all(directory.join("blobs")).map_err(|error| error.to_string())?;
        real_child_path(&parent, &directory.join("versions"), false)?;
        real_child_path(&parent, &directory.join("blobs"), false)?;
        Ok(Self {
            directory,
            excluded_data: data.canonicalize().unwrap_or_else(|_| data.to_path_buf()),
            exclusions: vec![],
            scopes: None,
        })
    }

    pub(crate) fn with_exclusions(mut self, paths: &[String]) -> Self {
        self.exclusions = paths.iter().map(PathBuf::from).collect();
        self
    }

    pub(crate) fn environment(directory: &Path, scopes: &[String]) -> Result<Self, String> {
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        for name in ["versions", "blobs"] {
            real_child_path(directory, &directory.join(name), false)?;
            fs::create_dir_all(directory.join(name)).map_err(|e| e.to_string())?;
        }
        Ok(Self {
            directory: directory.to_path_buf(),
            excluded_data: directory.to_path_buf(),
            exclusions: vec![],
            scopes: Some(scopes.iter().map(PathBuf::from).collect()),
        })
    }

    fn is_excluded(&self, path: &Path) -> bool {
        excluded(path)
            || self
                .exclusions
                .iter()
                .any(|scope| workspace::scope_contains(path, scope))
    }

    fn save_version(&self, version: &str, mut value: Version) -> Result<(), String> {
        value.checksum = Some(value.checksum()?);
        let path = self.version_path(version)?;
        if self.exists(version) {
            return Err(format!("Workspace file version already exists: {version}"));
        }
        let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        let temporary = self
            .directory
            .join("versions")
            .join(format!("pending-{}", Uuid::new_v4()));
        let result = (|| {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|e| e.to_string())?;
            fs::rename(&temporary, path).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            fs::File::open(self.directory.join("versions"))
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        let _ = fs::remove_file(temporary);
        result
    }

    pub(crate) fn capture_empty(&self, version: &str) -> Result<(), String> {
        self.save_version(
            version,
            Version {
                head: String::new(),
                parents: vec![],
                entries: Entries::new(),
                checksum: None,
            },
        )
    }

    pub(crate) fn descends_from(&self, version: &str, parent: &str) -> Result<bool, String> {
        Ok(self.ancestors(version)?.contains(parent))
    }

    fn version_path(&self, version: &str) -> Result<PathBuf, String> {
        let id = version
            .strip_prefix("before-")
            .or_else(|| version.strip_prefix("after-"))
            .unwrap_or(version);
        Uuid::parse_str(id).map_err(|_| "Invalid workspace file version")?;
        Ok(self
            .directory
            .join("versions")
            .join(format!("{version}.json")))
    }

    pub(crate) fn exists(&self, version: &str) -> bool {
        self.version_path(version)
            .ok()
            .is_some_and(|path| path.is_file())
    }

    fn load(&self, version: &str) -> Result<Version, String> {
        let path = self.version_path(version)?;
        let path = real_child_path(&self.directory, &path, true)?
            .ok_or_else(|| format!("Missing workspace file version {version}"))?;
        let value: Version =
            serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        match &value.checksum {
            Some(checksum) if value.checksum()? != *checksum => {
                return Err(format!("Damaged workspace file manifest: {version}"))
            }
            None if self.scopes.is_some() => {
                return Err(format!(
                    "Managed environment manifest lacks integrity evidence: {version}"
                ))
            }
            _ => {}
        }
        for (name, entry) in &value.entries {
            relative(name)?;
            if let Entry::File { blob, .. } = entry {
                self.blob_path(blob)?;
            }
            if let Entry::Link {
                target,
                internal: true,
                ..
            } = entry
            {
                relative(target)?;
            }
        }
        Ok(value)
    }

    pub(crate) fn same_contents(&self, left: &str, right: &str) -> Result<bool, String> {
        Ok(self.load(left)?.entries == self.load(right)?.entries)
    }

    fn blob_path(&self, blob: &str) -> Result<PathBuf, String> {
        if blob.len() != 40 || !blob.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid workspace file blob".into());
        }
        Ok(self.directory.join("blobs").join(blob))
    }

    fn save_blob(&self, source: &Path) -> Result<String, String> {
        let blob = hash(source)?;
        let destination = self.blob_path(&blob)?;
        if real_child_path(&self.directory, &destination, true)?.is_some() {
            if hash(&destination)? != blob {
                return Err(format!("Damaged workspace file blob: {blob}"));
            }
            return Ok(blob);
        }
        let temporary = self
            .directory
            .join("blobs")
            .join(format!("pending-{}", Uuid::new_v4()));
        let result = (|| {
            crate::native_copy::copy(source, &temporary)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
            }
            #[cfg(windows)]
            {
                let mut permissions = fs::metadata(&temporary)
                    .map_err(|e| e.to_string())?
                    .permissions();
                permissions.set_readonly(false);
                fs::set_permissions(&temporary, permissions).map_err(|e| e.to_string())?;
            }
            fs::OpenOptions::new()
                .write(true)
                .open(&temporary)
                .and_then(|f| f.sync_all())
                .map_err(|error| error.to_string())?;
            if hash(&temporary)? != blob {
                return Err(format!(
                    "Workspace file changed while snapshotting: {}",
                    source.display()
                ));
            }
            match fs::rename(&temporary, &destination) {
                Ok(()) => {
                    #[cfg(unix)]
                    fs::File::open(self.directory.join("blobs"))
                        .and_then(|f| f.sync_all())
                        .map_err(|e| e.to_string())?;
                    Ok(blob.clone())
                }
                Err(_)
                    if real_child_path(&self.directory, &destination, true)?.is_some()
                        && hash(&destination)? == blob =>
                {
                    Ok(blob.clone())
                }
                Err(error) => Err(error.to_string()),
            }
        })();
        let _ = fs::remove_file(temporary);
        result
    }

    fn collect(
        &self,
        root: &Path,
        path: &Path,
        entries: &mut Entries,
        expected: Option<&Entries>,
    ) -> Result<(), String> {
        let name = path.strip_prefix(root).map_err(|error| error.to_string())?;
        if self.scopes.is_some() && excluded(name) {
            return Err(format!(
                "Managed environment contains unsupported Git/Runtime metadata path: {}",
                path.display()
            ));
        }
        if self.is_excluded(name) || path == self.excluded_data {
            return Ok(());
        }
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("Cannot inherit {}: {error}", path.display()))?;
        #[cfg(unix)]
        if self.scopes.is_some() && !metadata.file_type().is_symlink() {
            use std::os::unix::fs::MetadataExt;
            if metadata.mode() & 0o7000 != 0 || metadata.is_file() && metadata.nlink() > 1 {
                return Err(format!(
                    "Environment needs unsupported special permissions/hardlink metadata: {}",
                    path.display()
                ));
            }
        }
        let name = path_name(name)?;
        relative(&name)?;
        let entry = if metadata.file_type().is_symlink() {
            let target = fs::read_link(path).map_err(|error| error.to_string())?;
            let resolved = path.canonicalize().map_err(|error| {
                format!("Cannot inherit broken link {}: {error}", path.display())
            })?;
            if let Ok(local) = resolved.strip_prefix(root) {
                let local = path_name(local)?;
                relative(&local)?;
                if self.is_excluded(Path::new(&local)) {
                    return Err(format!("Workspace link crosses a managed scope: {name}"));
                }
                Entry::Link {
                    target: local,
                    internal: true,
                    directory: resolved.is_dir(),
                }
            } else {
                if resolved.is_dir() {
                    return Err(format!(
                        "Ignored directory link leaves its workspace: {}",
                        path.display()
                    ));
                }
                Entry::Link {
                    target: target
                        .to_str()
                        .ok_or("Invalid workspace link target")?
                        .into(),
                    internal: false,
                    directory: false,
                }
            }
        } else if metadata.is_dir() {
            entries.insert(
                name.clone(),
                Entry::Directory {
                    mode: mode(&metadata),
                },
            );
            for child in fs::read_dir(path).map_err(|error| error.to_string())? {
                self.collect(
                    root,
                    &child.map_err(|error| error.to_string())?.path(),
                    entries,
                    expected,
                )?;
            }
            return Ok(());
        } else if metadata.is_file() {
            let blob = if let Some(expected) = expected {
                let Some(Entry::File { blob, .. }) = expected.get(&name) else {
                    return Err("Feedback workspace files changed after completion".into());
                };
                if hash(path)? != *blob {
                    return Err("Feedback workspace files changed after completion".into());
                }
                let stored = self.blob_path(blob)?;
                real_child_path(&self.directory, &stored, true)?
                    .ok_or("Missing workspace file blob")?;
                if hash(&stored)? != *blob {
                    return Err(format!("Damaged workspace file blob: {blob}"));
                }
                blob.clone()
            } else {
                self.save_blob(path)?
            };
            Entry::File {
                blob,
                mode: mode(&metadata),
            }
        } else {
            return Err(format!(
                "Cannot inherit special workspace file: {}",
                path.display()
            ));
        };
        entries.insert(name, entry);
        Ok(())
    }

    fn ignored(&self, workspace: &Path) -> Result<Vec<PathBuf>, String> {
        if let Some(scopes) = &self.scopes {
            let mut paths = Vec::new();
            for scope in scopes {
                let path = workspace.join(scope);
                real_child_path(workspace, &path, false)?;
                match fs::symlink_metadata(&path) {
                    Ok(_) => paths.push(path),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            return Ok(paths);
        }
        let names = workspace::repository_git(
            workspace,
            &[
                "ls-files",
                "-z",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
            ],
        )?;
        let mut paths = Vec::new();
        for name in names.split('\0').filter(|name| !name.is_empty()) {
            let name = name.trim_end_matches('/');
            if self.is_excluded(Path::new(name)) {
                continue;
            }
            paths.push(workspace.join(relative(name)?));
        }
        Ok(paths)
    }

    pub(crate) fn capture(
        &self,
        workspace: &Path,
        version: &str,
        head: &str,
        parents: &[String],
    ) -> Result<(), String> {
        for parent in parents {
            self.load(parent)?;
        }
        let root = workspace
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut entries = Entries::new();
        for path in self.ignored(&root)? {
            self.collect(&root, &path, &mut entries, None)?;
        }
        self.save_version(
            version,
            Version {
                head: head.into(),
                parents: parents.to_vec(),
                entries,
                checksum: None,
            },
        )
    }

    fn ancestors(&self, version: &str) -> Result<BTreeSet<String>, String> {
        let mut found = BTreeSet::new();
        let mut pending = vec![version.to_owned()];
        while let Some(next) = pending.pop() {
            if !found.insert(next.clone()) {
                continue;
            }
            if found.len() > 10_000 {
                return Err("Workspace file ancestry limit exceeded".into());
            }
            pending.extend(self.load(&next)?.parents);
        }
        Ok(found)
    }

    fn compose(&self, versions: &[String]) -> Result<Entries, String> {
        let versions: BTreeSet<_> = versions.iter().cloned().collect();
        let ancestry = versions
            .iter()
            .map(|version| Ok((version.clone(), self.ancestors(version)?)))
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        let independent: Vec<_> = versions
            .iter()
            .filter(|version| {
                !ancestry
                    .iter()
                    .any(|(other, parents)| other != *version && parents.contains(*version))
            })
            .collect();
        if independent.len() == 1 {
            return Ok(self.load(independent[0])?.entries);
        }
        let mut common = independent
            .first()
            .map(|version| ancestry[*version].clone())
            .unwrap_or_default();
        for version in independent.iter().skip(1) {
            common = common.intersection(&ancestry[*version]).cloned().collect();
        }
        let mut bases = common.clone();
        for version in &common {
            for parent in self
                .ancestors(version)?
                .into_iter()
                .filter(|parent| parent != version)
            {
                bases.remove(&parent);
            }
        }
        if bases.len() > 1 {
            return Err("Workspace composition blocked: ambiguous ignored-file merge base".into());
        }
        let base = bases
            .iter()
            .next()
            .map(|version| self.load(version).map(|value| value.entries))
            .transpose()?
            .unwrap_or_default();
        let inputs = independent
            .iter()
            .map(|version| self.load(version).map(|value| value.entries))
            .collect::<Result<Vec<_>, _>>()?;
        let paths: BTreeSet<_> = base
            .keys()
            .chain(inputs.iter().flat_map(BTreeMap::keys))
            .cloned()
            .collect();
        let mut result = Entries::new();
        for path in paths {
            let original = base.get(&path);
            let mut changes = inputs
                .iter()
                .map(|entries| entries.get(&path))
                .filter(|value| *value != original);
            let chosen = changes.next().unwrap_or(original);
            if changes.any(|value| value != chosen) {
                return Err(format!(
                    "Workspace composition blocked: conflicting ignored file {path}"
                ));
            }
            if let Some(entry) = chosen {
                result.insert(path, entry.clone());
            }
        }
        for path in result.keys() {
            let mut parent = Path::new(path).parent();
            while let Some(dir) = parent.filter(|dir| !dir.as_os_str().is_empty()) {
                if result
                    .get(&path_name(dir)?)
                    .is_some_and(|entry| !matches!(entry, Entry::Directory { .. }))
                {
                    return Err(format!(
                        "Workspace composition blocked: conflicting ignored directory {}",
                        dir.display()
                    ));
                }
                parent = dir.parent();
            }
        }
        Ok(result)
    }

    /// Event-actor metadata check only. Byte integrity is checked by the writer
    /// outside the Run mutex before preparation/materialization and sealing.
    pub(crate) fn validate_manifest(&self, version: &str) -> Result<(), String> {
        self.load(version).map(|_| ())
    }

    pub(crate) fn validate_manifest_refs(&self, versions: &[String]) -> Result<(), String> {
        for version in versions {
            self.validate_manifest(version)?;
        }
        Ok(())
    }

    pub(crate) fn validate(&self, versions: &[String]) -> Result<(), String> {
        let entries = self.compose(versions)?;
        for entry in entries.values() {
            if let Entry::File { blob, .. } = entry {
                let path = self.blob_path(blob)?;
                real_child_path(&self.directory, &path, true)?
                    .ok_or("Missing workspace file blob")?;
                if hash(&path)? != *blob {
                    return Err(format!("Damaged workspace file blob: {blob}"));
                }
            }
        }
        Ok(())
    }

    pub(crate) fn verify(&self, workspace: &Path, version: &str, head: &str) -> Result<(), String> {
        let value = self.load(version)?;
        if value.head != head {
            return Err("Feedback file snapshot does not match its Git head".into());
        }
        let root = workspace
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut entries = Entries::new();
        for path in self.ignored(&root)? {
            self.collect(&root, &path, &mut entries, Some(&value.entries))?;
        }
        if entries != value.entries {
            return Err("Feedback workspace files changed after completion".into());
        }
        Ok(())
    }

    pub(crate) fn materialize(
        &self,
        workspace: &Path,
        versions: &[String],
        previous: Option<&str>,
        reuse: bool,
    ) -> Result<(), String> {
        self.validate(versions)?;
        let desired = self.compose(versions)?;
        if desired.keys().any(|name| self.is_excluded(Path::new(name))) {
            return Err("Workspace file snapshot overlaps an excluded managed scope".into());
        }
        let tracked = workspace::repository_git(workspace, &["ls-files", "-z", "--cached"])?;
        let tracked: BTreeSet<_> = tracked
            .split('\0')
            .filter(|name| !name.is_empty())
            .collect();
        // Validate every conflict before changing any destination files.
        for (name, entry) in &desired {
            if tracked.contains(name.as_str()) {
                if let Entry::File { blob, .. } = entry {
                    if workspace.join(name).is_file() && hash(&workspace.join(name))? == *blob {
                        continue;
                    }
                }
                return Err(format!("Workspace composition blocked: ignored input conflicts with tracked path {name}"));
            }
        }
        if reuse {
            if let Some(previous) = previous {
                if self.load(previous)?.entries == desired {
                    return Ok(());
                }
            }
        }
        let root = workspace
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut current = Entries::new();
        for path in self.ignored(&root)? {
            self.collect(&root, &path, &mut current, None)?;
        }
        #[cfg(unix)]
        for (name, entry) in &current {
            if matches!(entry, Entry::Directory { .. }) {
                use std::os::unix::fs::PermissionsExt;
                let path = root.join(name);
                let mode = fs::metadata(&path)
                    .map_err(|e| e.to_string())?
                    .permissions()
                    .mode();
                if mode & 0o700 != 0o700 {
                    fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o700))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        let mut remove: Vec<_> = current.keys().map(|name| root.join(name)).collect();
        if let Some(previous) = previous.filter(|version| self.exists(version)) {
            remove.extend(
                self.load(previous)?
                    .entries
                    .keys()
                    .map(|name| root.join(name)),
            );
        }
        remove.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        remove.dedup();
        for path in remove {
            let name = path_name(
                path.strip_prefix(&root)
                    .map_err(|error| error.to_string())?,
            )?;
            if tracked.contains(name.as_str()) || self.is_excluded(Path::new(&name)) {
                continue;
            }
            // Never traverse a destination junction/link to delete another tree.
            if let Some(parent) = path.parent().filter(|parent| *parent != root) {
                real_child_path(&root, parent, false)?;
            }
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    unlink(&path, metadata.is_dir() || path.is_dir())?
                }
                Ok(metadata) if metadata.is_dir() => {
                    // An ignored directory may contain tracked descendants.
                    if !tracked
                        .iter()
                        .any(|tracked| tracked.starts_with(&(name.clone() + "/")))
                    {
                        // Deepest-first removal must not delete managed exclusions
                        // or tracked descendants nested inside an ignored directory.
                        match fs::remove_dir(&path) {
                            Ok(()) => {}
                            Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                            Err(e) => return Err(e.to_string()),
                        }
                    }
                }
                Ok(metadata) => {
                    #[cfg(windows)]
                    if metadata.permissions().readonly() {
                        let mut permissions = metadata.permissions();
                        permissions.set_readonly(false);
                        fs::set_permissions(&path, permissions).map_err(|e| e.to_string())?;
                    }
                    #[cfg(not(windows))]
                    let _ = metadata;
                    fs::remove_file(&path).map_err(|error| error.to_string())?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        for (name, entry) in &desired {
            if tracked.contains(name.as_str()) {
                continue;
            }
            let path = root.join(relative(name)?);
            if let Some(parent) = path.parent().filter(|parent| *parent != root) {
                real_child_path(&root, parent, false)?;
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            match entry {
                Entry::Directory { .. } => {
                    real_child_path(&root, &path, false)?;
                    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
                }
                Entry::File { blob, mode } => {
                    real_child_path(&root, &path, false)?;
                    let source = self.blob_path(blob)?;
                    let source = real_child_path(&self.directory, &source, true)?
                        .ok_or("Missing workspace file blob")?;
                    crate::native_copy::copy(&source, &path)?;
                    if hash(&path)? != *blob {
                        return Err(format!("Damaged workspace file blob: {blob}"));
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(&path, fs::Permissions::from_mode(*mode))
                            .map_err(|error| error.to_string())?;
                    }
                    #[cfg(windows)]
                    {
                        let mut permissions = fs::metadata(&path)
                            .map_err(|e| e.to_string())?
                            .permissions();
                        permissions.set_readonly(*mode != 0);
                        fs::set_permissions(&path, permissions).map_err(|e| e.to_string())?;
                    }
                    #[cfg(not(any(unix, windows)))]
                    let _ = mode;
                }
                Entry::Link { .. } => {}
            }
        }
        // Link targets may be later in lexical order, so create links last.
        for (name, entry) in &desired {
            if tracked.contains(name.as_str()) {
                continue;
            }
            if let Entry::Link {
                target,
                internal,
                directory,
            } = entry
            {
                let target = if *internal {
                    root.join(relative(target)?)
                } else {
                    PathBuf::from(target)
                };
                link(&target, &root.join(name), *directory)?;
            }
        }
        // Restore directory metadata only AFTER creating files and links.
        for (name, entry) in desired.iter().rev() {
            if let Entry::Directory { mode } = entry {
                #[cfg(unix)]
                if *mode != 0 {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(root.join(name), fs::Permissions::from_mode(*mode))
                        .map_err(|e| e.to_string())?;
                }
                #[cfg(windows)]
                {
                    let path = root.join(name);
                    let mut permissions = fs::metadata(&path)
                        .map_err(|e| e.to_string())?
                        .permissions();
                    permissions.set_readonly(*mode != 0);
                    fs::set_permissions(path, permissions).map_err(|e| e.to_string())?;
                }
                #[cfg(not(any(unix, windows)))]
                let _ = (name, mode);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "workspace_files_tests.rs"]
mod tests;

fn unlink(path: &Path, directory: bool) -> Result<(), String> {
    #[cfg(windows)]
    if directory {
        return fs::remove_dir(path).map_err(|error| error.to_string());
    }
    let _ = directory;
    fs::remove_file(path).map_err(|error| error.to_string())
}

fn link(target: &Path, path: &Path, directory: bool) -> Result<(), String> {
    #[cfg(unix)]
    {
        let _ = directory;
        std::os::unix::fs::symlink(target, path).map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        if directory {
            let output = std::process::Command::new("node")
                .args([
                    "-e",
                    "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
                ])
                .arg(crate::native::host_path(target))
                .arg(crate::native::host_path(path))
                .output()
                .map_err(|error| error.to_string())?;
            if output.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).into())
            }
        } else {
            std::os::windows::fs::symlink_file(target, path).map_err(|error| {
                format!(
                    "Cannot inherit file symlink {} (enable Windows Developer Mode): {error}",
                    path.display()
                )
            })
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, path, directory);
        Err("Workspace links are unsupported on this platform".into())
    }
}
