//! Original native file selectors, not just their canonical target bytes.
//! Resolve owned prefix links while observing, so later preflight never needs
//! a recoverable W/S interpreter (or its links) to exist or execute.
use super::{canonical, text, RuntimeFile};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub(super) struct Selector {
    path: String,
    target: String,
}

fn absolute(path: &str) -> bool {
    Path::new(path).is_absolute() && !path.contains('\0')
}

fn without_trailing_separator(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path
    } else {
        trimmed
    }
}

pub(super) fn validate(
    selectors: &[Selector],
    files: &[RuntimeFile],
    roots: &BTreeMap<String, String>,
    complete: bool,
) -> Result<(), String> {
    let external: BTreeSet<_> = files
        .iter()
        .filter_map(|file| match file {
            RuntimeFile::External { path, .. } => Some(path.clone()),
            RuntimeFile::Root { root, path, .. } if complete => {
                Some(text(&Path::new(&roots[root]).join(path)))
            }
            _ => None,
        })
        .collect();
    let targets: BTreeSet<_> = selectors.iter().map(|item| item.target.clone()).collect();
    if selectors.len() > 128
        || targets != external
        || selectors
            .windows(2)
            .any(|pair| pair[0].path >= pair[1].path)
        || selectors
            .iter()
            .any(|item| !absolute(&item.path) || !absolute(&item.target))
    {
        return Err("Invalid or incomplete native runtime selector evidence".into());
    }
    Ok(())
}

// Choose the OUTERMOST trusted-root alias. An inner symlink that happens to
// return to W is still an owned link to traverse, not new root authority.
fn owned_path(path: &Path, roots: &BTreeMap<String, String>) -> Option<PathBuf> {
    let mut owned = None;
    for ancestor in path.ancestors() {
        for root in roots.values() {
            if crate::path_identity::same_path(ancestor, Path::new(root)) {
                owned = Some(Path::new(root).join(path.strip_prefix(ancestor).ok()?));
            }
        }
    }
    owned
}

fn external_continuation(path: &Path, roots: &BTreeMap<String, String>) -> Result<PathBuf, String> {
    let mut pending = path.to_path_buf();
    'links: for _ in 0..64 {
        let Some(owned) = owned_path(&pending, roots) else {
            return Ok(pending);
        };
        let root = roots
            .values()
            .filter(|root| owned.starts_with(root))
            .max_by_key(|root| root.len())
            .ok_or("Missing native selector root")?;
        let mut current = PathBuf::from(root);
        let mut tail = owned
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .components();
        while let Some(part) = tail.next() {
            match part {
                Component::Normal(name) => current.push(name),
                Component::CurDir => continue,
                Component::ParentDir => {
                    current.pop();
                    if !roots.values().any(|root| current.starts_with(root)) {
                        pending = current.join(tail.as_path());
                        continue 'links;
                    }
                    continue;
                }
                _ => return Err("Invalid native selector path component".into()),
            }
            if fs::symlink_metadata(&current)
                .map_err(|e| format!("Cannot observe native selector {}: {e}", current.display()))?
                .file_type()
                .is_symlink()
            {
                let target =
                    crate::native::host_path(&fs::read_link(&current).map_err(|e| e.to_string())?);
                pending = if target.is_absolute() {
                    target
                } else {
                    current
                        .parent()
                        .ok_or("Missing native selector parent")?
                        .join(target)
                }
                .join(tail.as_path());
                continue 'links;
            }
        }
        return Err(format!(
            "Native selector left its root without an observable link: {}",
            path.display()
        ));
    }
    Err("Native selector link chain exceeds its observation bound".into())
}

pub(super) fn observe(
    references: &BTreeMap<String, String>,
    files: &[RuntimeFile],
    roots: &BTreeMap<String, String>,
    complete: bool,
) -> Result<Vec<Selector>, String> {
    if references.is_empty() || references.len() > 128 {
        return Err("Native runtime reference inventory is empty or exceeds its bound".into());
    }
    let all_files: BTreeSet<_> = files
        .iter()
        .map(|file| match file {
            RuntimeFile::Root { root, path, .. } => text(&Path::new(&roots[root]).join(path)),
            RuntimeFile::External { path, .. } => path.clone(),
        })
        .collect();
    let external: BTreeSet<_> = files
        .iter()
        .filter_map(|file| match file {
            RuntimeFile::External { path, .. } => Some(path.as_str()),
            _ => None,
        })
        .collect();
    let mut observed = BTreeSet::new();
    let mut selectors = BTreeMap::new();
    for (requested, resolved) in references {
        if !absolute(requested) || !absolute(resolved) {
            return Err("Native runtime references must be absolute".into());
        }
        // This is the target observed by the interpreter, not a selector to
        // reinterpret through a possibly changed filesystem a second time.
        let resolved_target = canonical(Path::new(without_trailing_separator(requested)))?;
        #[cfg(target_os = "macos")]
        let valid_target =
            crate::path_identity::equivalent_no_symlink_change(&resolved_target, Path::new(resolved));
        #[cfg(not(target_os = "macos"))]
        let valid_target = text(&resolved_target) == text(Path::new(resolved));
        if !valid_target {
            return Err("Native runtime selector changed during observation".into());
        }
        let target = text(&resolved_target);
        observed.insert(target.clone());
        if complete || external.contains(target.as_str()) {
            let path = if complete {
                text(Path::new(requested))
            } else {
                text(&external_continuation(Path::new(requested), roots)?)
            };
            let selector = Selector {
                path: path.clone(),
                target: target.clone(),
            };
            selector.preflight()?;
            if selectors
                .insert(path, target.clone())
                .is_some_and(|old| old != target)
            {
                return Err("Native runtime selector has conflicting targets".into());
            }
        }
    }
    if observed != all_files {
        return Err("Native runtime references do not cover the observed files".into());
    }
    let selectors: Vec<_> = selectors
        .into_iter()
        .map(|(path, target)| Selector { path, target })
        .collect();
    validate(&selectors, files, roots, complete)?;
    Ok(selectors)
}

impl Selector {
    pub(super) fn preflight_projected(
        &self,
        roots: &BTreeMap<String, String>,
        snapshot: &crate::workspace_files::RuntimePaths,
        project_ready: bool,
    ) -> Result<(), String> {
        let actual = super::resolution::resolve(&self.path, roots, snapshot, project_ready)
            .map_err(|error| format!("{error}; preserving current workspace/state"))?;
        let Some(actual) = actual else {
            eprintln!("Native runtime selector {} crosses project code; checking is deferred until codeRef preparation, before E writes", self.path);
            return Ok(());
        };
        #[cfg(target_os = "macos")]
        let matches = crate::path_identity::equivalent_no_symlink_change(
            &crate::native::host_path(&actual),
            Path::new(&self.target),
        ) || actual.parent().is_some_and(|parent| {
            crate::path_identity::macos_equivalent_path(
                &actual,
                Path::new(&self.target),
                crate::path_identity::case_insensitive_volume(parent),
            )
        });
        #[cfg(not(target_os = "macos"))]
        let matches = text(&actual) == self.target;
        if !matches {
            return Err(format!("Native runtime selector was redirected: {} (recorded {}, projected {}); preserving current workspace/state", self.path, self.target, text(&actual)));
        }
        Ok(())
    }

    pub(super) fn preflight(&self) -> Result<(), String> {
        // A file selector may be reported with a trailing separator by a
        // native probe. Remove only that separator before canonicalization;
        // the selector's identity and recorded target remain unchanged.
        let path = without_trailing_separator(&self.path);
        // Do not canonicalize the recorded target through today's filesystem.
        // Equal bytes at a different target cannot authorize redirecting it.
        let actual = canonical(Path::new(path)).map_err(|error| format!(
            "External native runtime selector is unavailable: {}; preserving current workspace/state: {error}", self.path))?;
        #[cfg(target_os = "macos")]
        let matches =
            crate::path_identity::equivalent_no_symlink_change(&actual, Path::new(&self.target));
        #[cfg(not(target_os = "macos"))]
        let matches = text(&actual) == self.target;
        if !matches {
            return Err(format!("External native runtime selector was redirected: {} (recorded {}, current {}); preserving current workspace/state", self.path, self.target, text(&actual)));
        }
        Ok(())
    }
}
