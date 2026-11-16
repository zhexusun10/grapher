//! Bounded native inputs already observed by the interpreter/ABI probe.
//! This is recovery evidence, never an environment import or relocation claim.
use super::canonical;
use crate::{native, workspace_files::Files};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

#[path = "environment_runtime_resolution.rs"]
mod resolution;
#[path = "environment_runtime_selectors.rs"]
mod selectors;

pub(super) const MARKER: &[u8] = b"\0GRAPHER_NATIVE_FILES\0";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectorProbe {
    schema: u32,
    files: BTreeMap<String, String>,
    references: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Probe {
    Selectors(SelectorProbe),
    Files(BTreeMap<String, String>),
}

fn text(path: &Path) -> String {
    let path = native::host_path(path).to_string_lossy().into_owned();
    if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path
    }
}

// Resolve existing trusted-root aliases, but never resolve the recorded string
// through today's filesystem: a redirected old root must not authorize another
// root. Missing W/S may be recreated only at their recorded canonical location.
fn target_layout(path: &Path) -> Result<String, String> {
    let path = native::host_path(path);
    if !path.is_absolute() {
        return Err("Native runtime root target must be absolute".into());
    }
    let mut ancestor = path.as_path();
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let base = canonical(ancestor)?;
                if !base.is_dir() {
                    return Err("Native runtime root ancestor is not a directory".into());
                }
                let tail = path.strip_prefix(ancestor).map_err(|e| e.to_string())?;
                if !tail
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
                {
                    return Err("Native runtime root target contains traversal".into());
                }
                let tail: PathBuf = tail.components().collect();
                return Ok(if tail.as_os_str().is_empty() {
                    text(&base)
                } else {
                    text(&base.join(tail))
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor
                    .parent()
                    .ok_or("Missing native runtime root ancestor")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "location", rename_all = "snake_case", deny_unknown_fields)]
enum RuntimeFile {
    Root {
        root: String,
        path: String,
        blob: String,
    },
    External {
        path: String,
        blob: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEvidence {
    schema: u32,
    roots: BTreeMap<String, String>,
    files: Vec<RuntimeFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selectors: Option<Vec<selectors::Selector>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    external_selectors: Option<Vec<selectors::Selector>>,
}

fn valid_blob(blob: &str) -> bool {
    blob.len() == 40 && blob.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn valid_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\0')
        && !(cfg!(windows) && path.contains('\\'))
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        && !Path::new(path).components().any(|part| match part {
            Component::Normal(name) => crate::path_identity::is_runtime_metadata_name(name),
            _ => false,
        })
}

impl RuntimeEvidence {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !matches!(
            (self.schema, &self.selectors, &self.external_selectors),
            (1, None, None) | (2, Some(_), None) | (3, Some(_), Some(_))
        ) || self.files.is_empty()
            || self.files.len() > 128
            || self.files.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err("Invalid or noncanonical native runtime evidence".into());
        }
        for (root, path) in &self.roots {
            if !matches!(root.as_str(), "workspace" | "state")
                || !Path::new(path).is_absolute()
                || path.contains('\0')
            {
                return Err("Invalid native runtime root layout evidence".into());
            }
        }
        let mut seen = BTreeSet::new();
        for file in &self.files {
            let (root, path, blob) = match file {
                RuntimeFile::Root { root, path, blob } => {
                    if !self.roots.contains_key(root) || !valid_relative(path) {
                        return Err("Invalid root-qualified native runtime input".into());
                    }
                    (root.as_str(), path, blob)
                }
                RuntimeFile::External { path, blob } => {
                    if !Path::new(path).is_absolute() || path.contains('\0') {
                        return Err("External native runtime input must be absolute".into());
                    }
                    ("external", path, blob)
                }
            };
            let key = if cfg!(windows) {
                path.to_lowercase()
            } else {
                path.clone()
            };
            if !valid_blob(blob) || !seen.insert((root, key)) {
                return Err("Invalid or duplicate native runtime byte evidence".into());
            }
        }
        if let Some(selectors) = &self.selectors {
            selectors::validate(selectors, &self.files, &self.roots, self.schema == 3)?;
        }
        if let Some(selectors) = &self.external_selectors {
            selectors::validate(selectors, &self.files, &self.roots, false)?;
        }
        Ok(())
    }

    pub(super) fn schema(&self) -> u32 {
        self.schema
    }

    // Recovery selectors are not an extra business-launch compatibility gate.
    // Actual startup still remeasures the original ABI and all recorded files.
    pub(super) fn same_runtime_files(&self, other: &Self) -> bool {
        self.schema == other.schema
            && self.files == other.files
            && self.roots.len() == other.roots.len()
            && self.roots.iter().all(|(label, path)| {
                other.roots.get(label).is_some_and(|other_path| {
                    crate::path_identity::same_path(Path::new(path), Path::new(other_path))
                })
            })
    }

    pub(super) fn from_probe(
        output: &[u8],
        roots: &[(&str, &Path)],
    ) -> Result<(Self, Vec<u8>), String> {
        let start = output
            .windows(MARKER.len())
            .rposition(|bytes| bytes == MARKER)
            .ok_or("Native probe omitted its runtime byte evidence")?;
        let proof_start = start + MARKER.len();
        let end = output[proof_start..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| proof_start + offset)
            .ok_or("Incomplete native runtime byte evidence")?;
        let probe: Probe = serde_json::from_slice(&output[proof_start..end])
            .map_err(|error| format!("Invalid native runtime byte evidence: {error}"))?;
        let (raw, references, schema) = match probe {
            Probe::Files(files) => (files, None, 1),
            Probe::Selectors(probe) if matches!(probe.schema, 2 | 3) => {
                (probe.files, Some(probe.references), probe.schema)
            }
            _ => return Err("Unsupported native runtime probe schema".into()),
        };
        if raw.is_empty() || raw.len() > 128 {
            return Err("Native runtime input inventory is empty or exceeds its bound".into());
        }
        let supplied_workspace = roots
            .iter()
            .find(|(label, _)| *label == "workspace")
            .map(|(_, path)| *path);
        let roots = roots
            .iter()
            .map(|(label, path)| Ok((*label, canonical(path)?)))
            .collect::<Result<Vec<_>, String>>()?;
        let mut workspace_bucket = None;
        if let Some((_, workspace)) = roots.iter().find(|(label, _)| *label == "workspace") {
            // W itself or its enclosing bucket may be a trusted root alias.
            // Use a recognizable allocator layout only if its real bucket
            // contains physical W; an unrelated alias parent is not authority.
            for path in supplied_workspace
                .into_iter()
                .chain(std::iter::once(workspace.as_path()))
            {
                if crate::workspace_state::process_root(path).is_ok() {
                    let bucket = canonical(
                        path.parent()
                            .and_then(Path::parent)
                            .ok_or("Missing workspace bucket")?,
                    )?;
                    if crate::workspace::scope_contains(workspace, &bucket) {
                        workspace_bucket = Some(bucket);
                        break;
                    }
                }
            }
            // If both spellings conceal the bucket name, the backend-supplied
            // S still identifies its owner Run. Require the same physical Run
            // as W, not merely a directory named .grapher-state elsewhere.
            if workspace_bucket.is_none() {
                if let Some((_, state)) = roots.iter().find(|(label, _)| *label == "state") {
                    let state_container = state.parent().and_then(Path::parent);
                    let owner = state_container.and_then(Path::parent);
                    if state.file_name().is_some_and(|name| name == "process")
                        && state_container.is_some_and(|path| {
                            path.file_name()
                                .is_some_and(|name| name == ".grapher-state")
                        })
                        && workspace
                            .parent()
                            .zip(owner)
                            .is_some_and(|(work_run, state_run)| {
                                crate::path_identity::same_path(work_run, state_run)
                            })
                    {
                        workspace_bucket =
                            owner.and_then(Path::parent).map(canonical).transpose()?;
                    }
                }
            }
        }
        let mut files = Vec::new();
        for (path, blob) in raw {
            let recorded = Path::new(&path);
            let path = canonical(recorded)?;
            if references.is_some() && text(&path) != text(recorded) {
                return Err("Native runtime file target changed during observation".into());
            }
            let local = roots.iter().find_map(|(label, root)| {
                path.strip_prefix(root)
                    .ok()
                    .filter(|relative| !relative.as_os_str().is_empty())
                    .map(|relative| ((*label).to_owned(), text(relative)))
            });
            files.push(match local {
                Some((root, path)) => RuntimeFile::Root { root, path, blob },
                None => {
                    if workspace_bucket.as_ref().is_some_and(|bucket| crate::workspace::scope_contains(&path, bucket)) {
                        let error = format!("Native runtime input belongs to another managed slot, not a host toolchain: {}; mutable sibling environments cannot be bound", path.display());
                        eprintln!("{error}");
                        return Err(error);
                    }
                    RuntimeFile::External { path: text(&path), blob }
                },
            });
        }
        files.sort();
        let layouts = roots
            .iter()
            .map(|(label, path)| ((*label).into(), text(path)))
            .collect();
        // Validate file ownership independently before processing selectors.
        // Schema 1 is kept byte-for-byte compatible, with no invented paths.
        let mut evidence = Self {
            schema: 1,
            roots: layouts,
            files,
            selectors: None,
            external_selectors: None,
        };
        evidence.validate()?;
        if let Some(references) = references {
            evidence.selectors = Some(selectors::observe(
                &references,
                &evidence.files,
                &evidence.roots,
                schema == 3,
            )?);
            evidence.schema = schema;
            if schema == 3 {
                // Keep the previously proven early external continuations even
                // if an original reference now defers while crossing codeRef.
                evidence.external_selectors = Some(selectors::observe(
                    &references,
                    &evidence.files,
                    &evidence.roots,
                    false,
                )?);
            }
            evidence.validate()?;
        }
        // Preserve the EXACT legacy ABI stdout (including startup output and
        // its trailing newline). Old Binding.abi and L hashes are not rewritten.
        let mut abi_output = output[..start].to_vec();
        abi_output.extend_from_slice(&output[end + 1..]);
        Ok((evidence, abi_output))
    }

    /// The recovery worker already knows the exact codeRef it will prepare.
    /// Check only observed project native bytes through graph Git, without
    /// promoting them into E or inferring new evidence for old bindings.
    pub(crate) fn preflight_project_code(
        &self,
        files: &Files,
        version: &str,
        single_root: &str,
        source: &Path,
        code_ref: &str,
    ) -> Result<(), String> {
        self.validate()?;
        if self.schema < 3 {
            return Ok(());
        }
        let rooted: Vec<_> = self
            .files
            .iter()
            .filter_map(|file| match file {
                RuntimeFile::Root { root, path, blob } => {
                    Some((root.as_str(), path.as_str(), blob.as_str()))
                }
                _ => None,
            })
            .collect();
        let coverage = files.verify_recorded_runtime_files(version, single_root, &rooted)?;
        crate::workspace_view::verify_native_inputs(source, code_ref, &coverage.project)
    }

    pub(crate) fn preflight(
        &self,
        files: &Files,
        version: &str,
        single_root: &str,
        roots: &BTreeMap<String, PathBuf>,
    ) -> Result<(), String> {
        self.preflight_phase(files, version, single_root, roots, false)
    }

    /// The caller prepared project code through the immutable codeRef path.
    /// Check its native inputs before E writes; never deliver code through E
    /// or treat live files as a substitute for missing historical code records.
    pub(crate) fn preflight_prepared(
        &self,
        files: &Files,
        version: &str,
        single_root: &str,
        roots: &BTreeMap<String, PathBuf>,
    ) -> Result<(), String> {
        self.preflight_phase(files, version, single_root, roots, true)
    }

    fn preflight_phase(
        &self,
        files: &Files,
        version: &str,
        single_root: &str,
        roots: &BTreeMap<String, PathBuf>,
        project_ready: bool,
    ) -> Result<(), String> {
        self.validate()?;
        for (label, recorded) in &self.roots {
            let target = roots
                .get(label)
                .ok_or("Recorded native runtime root is unavailable")?;
            if target_layout(target)? != *recorded {
                return Err(format!("Native runtime root layout differs for {label}: recorded {recorded}, current {}; no cross-root reconstruction is authorized; preserving current workspace/state", target.display()));
            }
        }
        if let Some(selectors) = &self.selectors {
            if self.schema == 3 {
                let snapshot = files.runtime_paths(version, single_root)?;
                for selector in selectors
                    .iter()
                    .chain(self.external_selectors.iter().flatten())
                {
                    selector.preflight_projected(&self.roots, &snapshot, project_ready)?;
                }
            } else {
                for selector in selectors {
                    selector.preflight()?;
                }
            }
        }
        let rooted: Vec<_> = self
            .files
            .iter()
            .filter_map(|file| match file {
                RuntimeFile::Root { root, path, blob } => {
                    Some((root.as_str(), path.as_str(), blob.as_str()))
                }
                _ => None,
            })
            .collect();
        // Owned bytes come from E, not from a possibly broken current prefix.
        // Explicitly excluded private caches are checked live, never restored.
        let coverage = files.verify_recorded_runtime_files(version, single_root, &rooted)?;
        for (root, relative, blob) in coverage.caches {
            let root = roots
                .get(&root)
                .ok_or("Native runtime cache root is unavailable")?;
            let root = canonical(root).map_err(|error| {
                format!(
                    "Native runtime cache is not restorable and its live root is missing: {error}"
                )
            })?;
            let path = root.join(&relative);
            crate::path_safety::real_child_path(&root, &path, true)?.ok_or_else(|| {
                format!(
                    "Native runtime cache input is missing and has no captured bytes: {}",
                    path.display()
                )
            })?;
            check_external(&path, &blob)?;
        }
        for file in &self.files {
            if let RuntimeFile::External { path, blob } = file {
                check_external(Path::new(path), blob)?;
            }
        }
        for (label, relative, blob) in coverage.project {
            if !project_ready {
                eprintln!("Native runtime project input {label}:{relative} follows codeRef, not E; verification is deferred until code preparation, before managed environment writes");
                continue;
            }
            let root = canonical(
                roots
                    .get(&label)
                    .ok_or("Native runtime project root is unavailable")?,
            )?;
            let path = root.join(relative);
            crate::path_safety::real_child_path(&root, &path, true)?.ok_or_else(|| format!("Native runtime project input is missing after codeRef preparation: {}; E cannot supply project code bytes", path.display()))?;
            check_input(&path, &blob, "Project-code")?;
        }
        Ok(())
    }
}

fn check_external(path: &Path, expected: &str) -> Result<(), String> {
    check_input(path, expected, "External or cache")
}

fn check_input(path: &Path, expected: &str, category: &str) -> Result<(), String> {
    let current = canonical(path).map_err(|error| format!("{category} native runtime input is unavailable; preserving current managed environment state: {error}"))?;
    if text(&current) != text(&native::host_path(path))
        || !fs::symlink_metadata(&current)
            .map_err(|e| e.to_string())?
            .is_file()
    {
        return Err(format!("Native runtime input was redirected or is not a regular file: {}; preserving current workspace/state", path.display()));
    }
    let actual = git2::Oid::hash_file(git2::ObjectType::Blob, &current)
        .map_err(|e| e.to_string())?
        .to_string();
    if actual != expected {
        return Err(format!("{category} native runtime input bytes changed: {}; these bytes are not restored from E; preserving current managed environment state", path.display()));
    }
    Ok(())
}

#[cfg(test)]
#[path = "environment_runtime_evidence_tests.rs"]
mod tests;
