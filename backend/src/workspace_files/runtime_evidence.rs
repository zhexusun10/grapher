//! Resolve runtime file evidence only against its recorded root/scope frame.
use super::*;

#[derive(Debug, Default)]
pub(crate) struct RuntimeFileCoverage {
    pub(crate) caches: Vec<(String, String, String)>,
    pub(crate) project: Vec<(String, String, String)>,
}

impl Files {
    /// Verify native files captured in E. Explicit caches remain live inputs;
    /// ordinary W files remain on the existing codeRef channel, never a second
    /// environment delivery channel. Recorded absence INSIDE an E scope fails.
    #[cfg(test)]
    pub(crate) fn verify_recorded_runtime_files(
        &self,
        version: &str,
        single_root: &str,
        expected: &[(&str, &str, &str)],
    ) -> Result<RuntimeFileCoverage, String> {
        self.verify_recorded_runtime_files_at(version, single_root, &BTreeMap::new(), expected)
    }

    pub(crate) fn verify_recorded_runtime_files_at(
        &self,
        version: &str,
        single_root: &str,
        roots: &BTreeMap<String, PathBuf>,
        expected: &[(&str, &str, &str)],
    ) -> Result<RuntimeFileCoverage, String> {
        let value = self.load(version)?;
        let checked = RefCell::default();
        let mut coverage = RuntimeFileCoverage::default();
        for &(root, path, wanted_blob) in expected {
            if !matches!(root, "workspace" | "state") {
                return Err("Invalid native runtime input ownership root".into());
            }
            relative(path)?;
            self.blob_path(wanted_blob)?;
            let input = || (root.into(), path.into(), wanted_blob.into());
            let contains = |path: &Path, scope: &Path| {
                roots.get(root).map_or_else(
                    || workspace::scope_contains(path, scope),
                    |base| workspace::scope_contains_at(base, path, scope),
                )
            };
            let entries = if let Some(snapshot) = &value.rooted {
                let frame = match snapshot.roots.get(root) {
                    Some(frame) => frame,
                    None if root == "workspace" => {
                        coverage.project.push(input());
                        continue;
                    }
                    None => {
                        return Err(format!(
                        "Native runtime input has no recorded root byte evidence: {root}:{path}"
                    ))
                    }
                };
                if frame
                    .layout
                    .caches
                    .iter()
                    .any(|cache| contains(Path::new(path), Path::new(cache)))
                {
                    coverage.caches.push(input());
                    continue;
                }
                if !frame
                    .layout
                    .scopes
                    .iter()
                    .any(|scope| contains(Path::new(path), Path::new(scope)))
                {
                    if root == "workspace" {
                        coverage.project.push(input());
                        continue;
                    }
                    return Err(format!("Native runtime input is outside captured E scope coverage: {root}:{path}; ownership alone does not authorize environment restoration"));
                }
                &frame.entries
            } else {
                if root != single_root {
                    if root == "workspace" {
                        coverage.project.push(input());
                        continue;
                    }
                    return Err(format!("Single-root snapshot has no byte evidence for native input {root}:{path}; refusing another root's same-named file"));
                }
                if roots.get(root).map_or_else(
                    || self.is_cache(Path::new(path)),
                    |base| self.is_cache_at(base, Path::new(path)),
                ) {
                    coverage.caches.push(input());
                    continue;
                }
                if root == "workspace"
                    && self.scopes.as_ref().is_some_and(|scopes| {
                        !scopes.iter().any(|scope| contains(Path::new(path), scope))
                    })
                {
                    coverage.project.push(input());
                    continue;
                }
                &value.entries
            };
            let entry = lookup_entry_alias(entries, roots.get(root).map(PathBuf::as_path), path)
                .map_err(|()| format!("Ambiguous recorded native input path aliases: {root}:{path}"))?
                .map(|(_, entry)| entry);
            let Some(Entry::File { blob, .. }) = entry else {
                return Err(format!("Native runtime input lacks captured file bytes: {root}:{path}; live files or link targets cannot fill missing history"));
            };
            if blob != wanted_blob {
                return Err(format!(
                    "Native runtime input differs from its captured E bytes: {root}:{path}"
                ));
            }
            self.verify_blob(blob, &checked)?;
        }
        Ok(coverage)
    }
}
