//! Managed native-environment scopes use immutable, run-owned filesystem
//! snapshots, not Git objects or writable hardlinks. Versions record ancestry
//! for environment fan-in.
use crate::{path_safety::real_child_path, workspace};
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

mod rooted;
mod runtime_evidence;
mod runtime_paths;
pub(crate) use runtime_paths::{RuntimePath, RuntimePaths};
mod home_fork;
pub(crate) use rooted::RootScope;

fn canonical_host_path(path: &Path) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        Ok(crate::path_identity::actual_path(&resolved).unwrap_or(resolved))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(resolved)
    }
}

type Entries = BTreeMap<String, Entry>;

#[derive(Clone, Copy)]
enum Collection<'a> {
    Capture(&'a RefCell<BTreeSet<String>>),
    // Opt-in benchmark reference: pre-optimization per-file stored-byte reads.
    #[cfg(test)]
    CaptureUnbatched,
    Verify(&'a Entries, &'a RefCell<BTreeSet<String>>),
    // Track omitted live entries separately: they are not restorable evidence
    // or permission to delete them. Still hash every ordinary live file.
    Inspect(&'a RefCell<BTreeSet<String>>),
}

impl Collection<'_> {
    fn note_untouched(self, root: Option<&Path>, path: &Path) -> Result<(), String> {
        if let Self::Inspect(paths) = self {
            paths
                .borrow_mut()
                .insert(inspection_key_at(root, &path_name(path)?));
        }
        Ok(())
    }
}

// Match native volume aliases without normalizing any persisted manifest.
fn inspection_key_at(root: Option<&Path>, name: &str) -> String {
    if cfg!(windows) {
        name.to_lowercase()
    } else {
        #[cfg(target_os = "macos")]
        {
            let insensitive = root.is_some_and(crate::path_identity::case_insensitive_volume);
            name.split('/')
                .map(|part| crate::path_identity::macos_fold_component(part, insensitive))
                .collect::<Vec<_>>()
                .join("/")
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = root;
            name.into()
        }
    }
}

fn lookup_entry_alias<'a>(
    entries: &'a Entries,
    root: Option<&Path>,
    name: &str,
) -> Result<Option<(&'a String, &'a Entry)>, ()> {
    if let Some(exact) = entries.get_key_value(name) {
        return Ok(Some(exact));
    }
    #[cfg(any(windows, target_os = "macos"))]
    {
        let key = inspection_key_at(root, name);
        let mut aliases = entries
            .iter()
            .filter(|(candidate, _)| inspection_key_at(root, candidate) == key);
        let first = aliases.next();
        if aliases.next().is_some() {
            return Err(());
        }
        Ok(first)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = root;
        Ok(None)
    }
}

fn untouched_blocker<'a>(
    root: Option<&Path>,
    untouched: &'a BTreeSet<String>,
    name: &str,
    directory: bool,
) -> Option<&'a str> {
    if untouched.is_empty() {
        return None;
    }
    let key = inspection_key_at(root, name);
    let mut ancestor = key.as_str();
    loop {
        if let Some(path) = untouched.get(ancestor) {
            return Some(path.as_str());
        }
        let Some((parent, _)) = ancestor.rsplit_once('/') else {
            break;
        };
        ancestor = parent;
    }
    if !directory {
        // A file/link also cannot replace a directory containing retained
        // descendants. Sorted lookup avoids scanning every omission per file.
        let prefix = format!("{key}/");
        return untouched
            .range(prefix.clone()..)
            .next()
            .filter(|path| path.starts_with(&prefix))
            .map(String::as_str);
    }
    None
}

struct Materialization {
    root: PathBuf,
    desired: Entries,
    current: Entries,
    tracked: BTreeSet<String>,
    previous_paths: Vec<PathBuf>,
}

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
    schema: u32,
    head: String,
    parents: Vec<String>,
    entries: Entries,
    #[serde(default)]
    checksum: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rooted: Option<rooted::Snapshot>,
}

impl Version {
    fn checksum(&self) -> Result<String, String> {
        let bytes = serde_json::to_vec(&(
            self.schema,
            &self.head,
            &self.parents,
            &self.entries,
            &self.rooted,
        ))
        .map_err(|e| e.to_string())?;
        git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
            .map(|id| id.to_string())
            .map_err(|e| e.to_string())
    }
}

pub(crate) struct Files {
    directory: PathBuf,
    excluded_data: PathBuf,
    scopes: Option<Vec<PathBuf>>,
    caches: Vec<PathBuf>,
    project_index: bool,
}

fn excluded(path: &Path) -> bool {
    path.components().any(|part| match part {
        Component::Normal(name) => crate::path_identity::is_runtime_metadata_name(name),
        _ => false,
    })
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
    pub(crate) fn environment(
        directory: &Path,
        scopes: &[String],
        caches: &[String],
    ) -> Result<Self, String> {
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        for name in ["versions", "blobs"] {
            real_child_path(directory, &directory.join(name), false)?;
            fs::create_dir_all(directory.join(name)).map_err(|e| e.to_string())?;
        }
        Ok(Self {
            directory: directory.to_path_buf(),
            excluded_data: directory.to_path_buf(),
            scopes: Some(scopes.iter().map(PathBuf::from).collect()),
            caches: caches.iter().map(PathBuf::from).collect(),
            project_index: true,
        })
    }

    pub(crate) fn with_project_index(mut self, enabled: bool) -> Self {
        self.project_index = enabled;
        self
    }

    fn is_cache(&self, path: &Path) -> bool {
        self.caches
            .iter()
            .any(|cache| workspace::scope_contains(path, cache))
    }

    fn is_cache_at(&self, root: &Path, path: &Path) -> bool {
        self.caches
            .iter()
            .any(|cache| workspace::scope_contains_at(root, path, cache))
    }

    fn is_excluded(&self, root: &Path, path: &Path) -> bool {
        excluded(path) || self.is_cache_at(root, path)
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
                schema: 1,
                head: String::new(),
                parents: vec![],
                entries: Entries::new(),
                checksum: None,
                rooted: None,
            },
        )
    }

    pub(crate) fn descends_from(&self, version: &str, parent: &str) -> Result<bool, String> {
        Ok(self.ancestors(version)?.contains(parent))
    }

    fn version_path(&self, version: &str) -> Result<PathBuf, String> {
        Uuid::parse_str(version).map_err(|_| "Invalid workspace file version")?;
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
        if value.schema != 1 {
            return Err("Unsupported environment snapshot schema".into());
        }
        match &value.checksum {
            Some(checksum) if value.checksum()? != *checksum => {
                return Err(format!("Damaged workspace file manifest: {version}"))
            }
            None => {
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
        if let Some(rooted) = &value.rooted {
            if !value.head.is_empty() || !value.entries.is_empty() {
                return Err("Mixed single-root and root-qualified environment manifest".into());
            }
            self.validate_rooted_metadata(rooted)?;
        }
        Ok(value)
    }

    #[cfg(test)]
    pub(crate) fn same_contents(&self, left: &str, right: &str) -> Result<bool, String> {
        let left = self.load(left)?;
        let right = self.load(right)?;
        Ok(left.entries == right.entries && left.rooted == right.rooted)
    }

    /// Compare a business prefix independently of writer HOME/other scopes.
    /// This is a metadata optimization only; native use still validates bytes.
    pub(crate) fn same_scope_contents(
        &self,
        left: &str,
        right: &str,
        scope: &str,
        root: &str,
    ) -> Result<bool, String> {
        relative(scope)?;
        let entries = |version: &str| -> Result<Entries, String> {
            let value = self.load(version)?;
            let entries = if let Some(rooted) = value.rooted {
                rooted
                    .roots
                    .get(root)
                    .ok_or("Missing environment snapshot root")?
                    .entries
                    .clone()
            } else {
                value.entries
            };
            Ok(entries
                .into_iter()
                .filter(|(name, _)| workspace::scope_contains(Path::new(name), Path::new(scope)))
                .collect())
        };
        Ok(entries(left)? == entries(right)?)
    }

    fn blob_path(&self, blob: &str) -> Result<PathBuf, String> {
        if blob.len() != 40 || !blob.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid workspace file blob".into());
        }
        Ok(self.directory.join("blobs").join(blob))
    }

    // Proof is local to one operation on this immutable store. Never retain it
    // on Files, between writers, or across capture/verify/materialize calls.
    fn verify_blob(&self, blob: &str, checked: &RefCell<BTreeSet<String>>) -> Result<(), String> {
        if checked.borrow().contains(blob) {
            return Ok(());
        }
        let path = self.blob_path(blob)?;
        real_child_path(&self.directory, &path, true)?.ok_or("Missing workspace file blob")?;
        if hash(&path)? != blob {
            return Err(format!("Damaged workspace file blob: {blob}"));
        }
        checked.borrow_mut().insert(blob.into());
        Ok(())
    }

    fn save_blob(
        &self,
        source: &Path,
        checked: Option<&RefCell<BTreeSet<String>>>,
    ) -> Result<String, String> {
        // Every live file is read, even if another file has identical content.
        // Only the test-only unbatched reference omits operation-local proof.
        let blob = hash(source)?;
        if checked.is_some_and(|checked| checked.borrow().contains(&blob)) {
            return Ok(blob);
        }
        let destination = self.blob_path(&blob)?;
        if let Some(stored) = real_child_path(&self.directory, &destination, true)? {
            // The existing-blob branch already checked the real child path.
            // Do not repeat that traversal via verify_blob, particularly in the
            // unbatched reference: the original capture checked it only once.
            if hash(&stored)? != blob {
                return Err(format!("Damaged workspace file blob: {blob}"));
            }
            if let Some(checked) = checked {
                checked.borrow_mut().insert(blob.clone());
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
                let metadata = fs::metadata(&temporary).map_err(|e| e.to_string())?;
                crate::workspace_cleanup::clear_readonly_attribute(&temporary, &metadata)
                    .map_err(|e| e.to_string())?;
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
        if result.is_ok() {
            if let Some(checked) = checked {
                checked.borrow_mut().insert(blob);
            }
        }
        result
    }

    fn collect(
        &self,
        root: &Path,
        path: &Path,
        entries: &mut Entries,
        collection: Collection<'_>,
    ) -> Result<(), String> {
        let name = path.strip_prefix(root).map_err(|error| error.to_string())?;
        if self.scopes.is_some() && excluded(name) {
            return Err(format!(
                "Managed environment contains unsupported Git/Runtime metadata path: {}",
                path.display()
            ));
        }
        if self.is_excluded(root, name) || path == self.excluded_data {
            collection.note_untouched(Some(root), name)?;
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
            let Ok(target) = fs::read_link(path) else {
                // Some Windows reparse points expose no readable link target.
                // There is no content to inherit, so pass the live entry through
                // untouched instead of failing the whole environment snapshot.
                collection.note_untouched(Some(root), Path::new(&name))?;
                eprintln!(
                    "Skipping unreadable environment link (not inherited): {}",
                    path.display()
                );
                return Ok(());
            };
            let Ok(resolved) = canonical_host_path(path) else {
                // The system cannot resolve the target: a broken junction, a
                // link cycle, or inaccessible target (for example Chrome's
                // INetCache\Content.IE5 junction, whose malformed print name
                // makes Windows report path-not-found). Pass the live entry
                // through untouched instead of failing the snapshot.
                collection.note_untouched(Some(root), Path::new(&name))?;
                eprintln!(
                    "Skipping unresolvable environment link (not inherited): {}",
                    path.display()
                );
                return Ok(());
            };
            if let Ok(local) = resolved.strip_prefix(root) {
                let local = path_name(local)?;
                relative(&local)?;
                if self.is_excluded(root, Path::new(&local)) {
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
                    collection,
                )?;
            }
            return Ok(());
        } else if metadata.is_file() {
            let blob = match collection {
                Collection::Capture(checked) => self.save_blob(path, Some(checked))?,
                #[cfg(test)]
                Collection::CaptureUnbatched => self.save_blob(path, None)?,
                Collection::Inspect(_) => hash(path)?,
                Collection::Verify(expected, checked) => {
                    let Some(Entry::File { blob, .. }) = expected.get(&name) else {
                        return Err("Feedback workspace files changed after completion".into());
                    };
                    if hash(path)? != *blob {
                        return Err("Feedback workspace files changed after completion".into());
                    }
                    self.verify_blob(blob, checked)?;
                    blob.clone()
                }
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

    fn scoped_paths(&self, workspace: &Path) -> Result<Vec<PathBuf>, String> {
        let scopes = self
            .scopes
            .as_ref()
            .ok_or("Managed environment storage requires explicit scopes")?;
        workspace::validate_scope_layout_at(workspace, scopes, &self.caches)?;
        let mut paths = Vec::new();
        for scope in scopes {
            let path = workspace.join(scope);
            real_child_path(workspace, &path, false)?;
            match fs::symlink_metadata(&path) {
                Ok(_) => paths.push(path),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
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
        let value = self.capture_value(workspace, head, parents, &RefCell::default())?;
        self.save_version(version, value)
    }

    fn capture_value(
        &self,
        workspace: &Path,
        head: &str,
        parents: &[String],
        checked: &RefCell<BTreeSet<String>>,
    ) -> Result<Version, String> {
        let root = canonical_host_path(workspace)?;
        let mut entries = Entries::new();
        for path in self.scoped_paths(&root)? {
            self.collect(&root, &path, &mut entries, Collection::Capture(checked))?;
        }
        Ok(Version {
            schema: 1,
            head: head.into(),
            parents: parents.to_vec(),
            entries,
            checksum: None,
            rooted: None,
        })
    }

    /// Environment sealing only: preserve the parent's immutable reference when
    /// full live-byte/metadata collection proves no change, without writing an
    /// orphan manifest. Missing history must fail before any live bytes are saved.
    pub(crate) fn capture_reusing(&self, workspace: &Path, parent: &str) -> Result<String, String> {
        let previous = self.load(parent)?;
        if previous.rooted.is_some() {
            return Err("Root-qualified environment capture requires explicit root targets".into());
        }
        let checked = RefCell::default();
        self.validate_value(&previous, &checked)?;
        let value = self.capture_value(workspace, "", &[parent.into()], &checked)?;
        self.save_changed(value, parent, &previous)
    }

    fn save_changed(
        &self,
        value: Version,
        parent: &str,
        previous: &Version,
    ) -> Result<String, String> {
        if value.entries == previous.entries && value.rooted == previous.rooted {
            return Ok(parent.into());
        }
        let version = Uuid::new_v4().to_string();
        self.save_version(&version, value)?;
        Ok(version)
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
        for version in versions {
            if self.load(version)?.rooted.is_some() {
                return Err("Root-qualified environment snapshots require explicit root targets, not directory composition".into());
            }
        }
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
            return Err(
                "Managed environment scope composition blocked: ambiguous merge base".into(),
            );
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
                    "Managed environment scope composition blocked: conflicting file {path}"
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
                        "Managed environment scope composition blocked: conflicting directory {}",
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

    pub(crate) fn validate(&self, versions: &[String]) -> Result<(), String> {
        let checked = RefCell::default();
        if versions.len() == 1 {
            let value = self.load(&versions[0])?;
            if value.rooted.is_some() {
                return self.validate_value(&value, &checked);
            }
        }
        // Legacy composition still validates its recorded ancestry.
        self.validate_entries(&self.compose(versions)?, &checked)
    }

    fn validate_value(
        &self,
        value: &Version,
        checked: &RefCell<BTreeSet<String>>,
    ) -> Result<(), String> {
        self.validate_entries(&value.entries, checked)?;
        if let Some(rooted) = &value.rooted {
            for root in rooted.roots.values() {
                self.validate_entries(&root.entries, checked)?;
            }
        }
        Ok(())
    }

    fn validate_entries(
        &self,
        entries: &Entries,
        checked: &RefCell<BTreeSet<String>>,
    ) -> Result<(), String> {
        for entry in entries.values() {
            if let Entry::File { blob, .. } = entry {
                self.verify_blob(blob, checked)?;
            }
        }
        Ok(())
    }

    pub(crate) fn verify(&self, workspace: &Path, version: &str, head: &str) -> Result<(), String> {
        let value = self.load(version)?;
        if value.rooted.is_some() {
            return Err(
                "Root-qualified environment verification requires explicit root targets".into(),
            );
        }
        if value.head != head {
            return Err("Feedback file snapshot does not match its Git head".into());
        }
        let root = canonical_host_path(workspace)?;
        let mut entries = Entries::new();
        let checked = RefCell::default();
        for path in self.scoped_paths(&root)? {
            self.collect(
                &root,
                &path,
                &mut entries,
                Collection::Verify(&value.entries, &checked),
            )?;
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
        if let Some(plan) = self.plan_materialization(workspace, desired, previous, reuse)? {
            self.apply_materialization(plan)?;
        }
        Ok(())
    }

    fn plan_materialization(
        &self,
        workspace: &Path,
        desired: Entries,
        previous: Option<&str>,
        reuse: bool,
    ) -> Result<Option<Materialization>, String> {
        if let Some(scopes) = &self.scopes {
            workspace::validate_scope_layout_at(workspace, scopes, &self.caches)?;
        }
        if desired
            .keys()
            .any(|name| self.is_excluded(workspace, Path::new(name)))
        {
            return Err("Workspace file snapshot overlaps an excluded managed scope".into());
        }
        let tracked = if self.project_index {
            workspace::working_tree_git(workspace, &["ls-files", "-z", "--cached"])?
        } else {
            String::new()
        };
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
                return Err(format!(
                    "Managed environment scope conflicts with tracked path {name}"
                ));
            }
        }
        if reuse {
            if let Some(previous) = previous {
                let previous = self.load(previous)?;
                if previous.rooted.is_some() {
                    return Err("Root-qualified environment snapshot cannot be used as a single-root predecessor".into());
                }
                if previous.entries == desired {
                    return Ok(None);
                }
            }
        }
        let root = canonical_host_path(workspace)?;
        let mut current = Entries::new();
        let untouched = RefCell::new(BTreeSet::new());
        for path in self.scoped_paths(&root)? {
            self.collect(&root, &path, &mut current, Collection::Inspect(&untouched))?;
        }
        let untouched = untouched.into_inner();
        // Resolve all destination parents before changing even the first root.
        // A captured regular file that will be replaced by a directory is not
        // traversal: removal precedes creation. Links remain forbidden, even
        // when the snapshot would replace them with a directory.
        for (name, entry) in &desired {
            if let Some(blocker) = untouched_blocker(
                Some(&root),
                &untouched,
                name,
                matches!(entry, Entry::Directory { .. }),
            ) {
                return Err(format!(
                    "Cannot restore managed path {}: conflicts with untouched excluded cache or unreadable/unresolvable link at {blocker}; preserving live state",
                    root.join(name).display()
                ));
            }
            if let Some(parent) = Path::new(name)
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
            {
                let mut replaced = None;
                for ancestor in parent
                    .ancestors()
                    .filter(|path| !path.as_os_str().is_empty())
                {
                    let key = path_name(ancestor)?;
                    if matches!(current.get(&key), Some(Entry::File { .. }))
                        && matches!(desired.get(&key), Some(Entry::Directory { .. }))
                    {
                        replaced = Some(ancestor);
                        break;
                    }
                }
                real_child_path(
                    &root,
                    &root.join(replaced.unwrap_or(parent)),
                    replaced.is_some(),
                )?;
            }
        }
        let previous_paths = if let Some(previous) = previous.filter(|version| self.exists(version))
        {
            let previous = self.load(previous)?;
            if previous.rooted.is_some() {
                return Err("Root-qualified environment snapshot cannot be used as a single-root predecessor".into());
            }
            // A legacy predecessor cannot authorize deleting/traversing an
            // omitted live link. Ancestor directories are removed only if empty.
            previous
                .entries
                .keys()
                .filter(|name| untouched_blocker(Some(&root), &untouched, name, true).is_none())
                .map(|name| root.join(name))
                .collect()
        } else {
            Vec::new()
        };
        Ok(Some(Materialization {
            root,
            desired,
            current,
            tracked: tracked.into_iter().map(str::to_owned).collect(),
            previous_paths,
        }))
    }

    fn apply_materialization(&self, plan: Materialization) -> Result<(), String> {
        let Materialization {
            root,
            desired,
            current,
            tracked,
            previous_paths,
        } = plan;
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
        remove.extend(previous_paths);
        remove.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        remove.dedup();
        for path in remove {
            let name = path_name(
                path.strip_prefix(&root)
                    .map_err(|error| error.to_string())?,
            )?;
            if tracked.contains(name.as_str()) || self.is_excluded(&root, Path::new(&name)) {
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
                    // A managed scope may contain tracked descendants.
                    if !tracked
                        .iter()
                        .any(|tracked| tracked.starts_with(&(name.clone() + "/")))
                    {
                        // Deepest-first removal must not delete managed exclusions
                        // or tracked descendants nested inside a managed scope.
                        match fs::remove_dir(&path) {
                            Ok(()) => {}
                            Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                            Err(e) => return Err(e.to_string()),
                        }
                    }
                }
                Ok(metadata) => {
                    #[cfg(windows)]
                    crate::workspace_cleanup::clear_readonly_attribute(&path, &metadata)
                        .map_err(|e| e.to_string())?;
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
                link(&root, &target, &root.join(name), *directory)?;
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

fn link(root: &Path, target: &Path, path: &Path, directory: bool) -> Result<(), String> {
    let _ = root;
    #[cfg(unix)]
    {
        let _ = directory;
        std::os::unix::fs::symlink(target, path).map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        if directory {
            // Same native junction contract, without spawning a PATH-selected
            // Node or exposing backend work to business NODE_OPTIONS/NODE_PATH.
            crate::workspace_symlinks::materialize(
                root,
                path,
                &crate::workspace_symlinks::Link {
                    value: target
                        .to_str()
                        .ok_or("Environment junction target must be UTF-8")?
                        .into(),
                    project_absolute: false,
                    kind: crate::workspace_symlinks::Kind::Junction,
                },
            )
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
