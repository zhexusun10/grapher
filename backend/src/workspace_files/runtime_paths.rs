//! Read-only pathname projection of the selected E, never of a damaged prefix.
//! Code and excluded caches keep their existing channels and are not supplied
//! by this metadata lookup. The caller separately verifies native file blobs.
use super::*;

pub(crate) enum RuntimePath {
    Directory(String),
    File(String),
    Link { target: String, internal: bool },
    Live,
    Project,
}

pub(crate) struct RuntimePaths {
    value: Version,
    legacy_root: String,
    scopes: Option<Vec<PathBuf>>,
    caches: Vec<PathBuf>,
}

impl Files {
    pub(crate) fn runtime_paths(
        &self,
        version: &str,
        legacy_root: &str,
    ) -> Result<RuntimePaths, String> {
        Ok(RuntimePaths {
            value: self.load(version)?,
            legacy_root: legacy_root.into(),
            scopes: self.scopes.clone(),
            caches: self.caches.clone(),
        })
    }
}

impl RuntimePaths {
    pub(crate) fn lookup(&self, root: &str, path: &str) -> Result<RuntimePath, String> {
        if !matches!(root, "workspace" | "state") {
            return Err("Unknown native selector root".into());
        }
        if path.is_empty() {
            return Ok(RuntimePath::Directory(String::new()));
        }
        let relative_path = relative(path)?;
        let outside = || {
            if root == "workspace" {
                Ok(RuntimePath::Project)
            } else {
                Err(format!(
                    "Native runtime selector has no captured state path: {root}:{path}"
                ))
            }
        };
        let covered = |scope: &Path| workspace::scope_contains(relative_path, scope);
        let ancestor = |scope: &Path| workspace::scope_contains(scope, relative_path);
        let entries = if let Some(snapshot) = &self.value.rooted {
            let Some(frame) = snapshot.roots.get(root) else {
                return outside();
            };
            if frame
                .layout
                .caches
                .iter()
                .any(|cache| covered(Path::new(cache)))
            {
                return Ok(RuntimePath::Live);
            }
            if !frame.layout.covers(path) {
                if frame
                    .layout
                    .scopes
                    .iter()
                    .any(|scope| ancestor(Path::new(scope)))
                {
                    return Ok(RuntimePath::Directory(path.into()));
                }
                return outside();
            }
            &frame.entries
        } else {
            if root != self.legacy_root {
                return outside();
            }
            if self.caches.iter().any(|cache| covered(cache)) {
                return Ok(RuntimePath::Live);
            }
            if let Some(scopes) = &self.scopes {
                if !scopes.iter().any(|scope| covered(scope)) {
                    if scopes.iter().any(|scope| ancestor(scope)) {
                        return Ok(RuntimePath::Directory(path.into()));
                    }
                    return outside();
                }
            }
            &self.value.entries
        };
        let found = if let Some(entry) = entries.get_key_value(path) {
            Some(entry)
        } else if cfg!(windows) {
            let key = inspection_key(path);
            let mut aliases = entries
                .iter()
                .filter(|(name, _)| inspection_key(name) == key);
            let first = aliases.next();
            if aliases.next().is_some() {
                return Err(format!(
                    "Ambiguous recorded native selector path: {root}:{path}"
                ));
            }
            first
        } else {
            None
        };
        let Some((name, entry)) = found else {
            return Err(format!("Native runtime selector lacks a captured entry: {root}:{path}; live entries cannot repair history"));
        };
        Ok(match entry {
            Entry::Directory { .. } => RuntimePath::Directory(name.clone()),
            Entry::File { .. } => RuntimePath::File(name.clone()),
            Entry::Link {
                target, internal, ..
            } => RuntimePath::Link {
                target: target.clone(),
                internal: *internal,
            },
        })
    }
}
