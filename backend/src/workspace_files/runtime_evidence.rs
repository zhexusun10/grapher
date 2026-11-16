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
    pub(crate) fn verify_recorded_runtime_files(
        &self,
        version: &str,
        legacy_root: &str,
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
                    .any(|cache| workspace::scope_contains(Path::new(path), Path::new(cache)))
                {
                    coverage.caches.push(input());
                    continue;
                }
                if !frame.layout.covers(path) {
                    if root == "workspace" {
                        coverage.project.push(input());
                        continue;
                    }
                    return Err(format!("Native runtime input is outside captured E scope coverage: {root}:{path}; ownership alone does not authorize environment restoration"));
                }
                &frame.entries
            } else {
                if root != legacy_root {
                    if root == "workspace" {
                        coverage.project.push(input());
                        continue;
                    }
                    return Err(format!("Legacy environment has no byte evidence for native input {root}:{path}; refusing another root's same-named file"));
                }
                if self.is_cache(Path::new(path)) {
                    coverage.caches.push(input());
                    continue;
                }
                if root == "workspace"
                    && self.scopes.as_ref().is_some_and(|scopes| {
                        !scopes
                            .iter()
                            .any(|scope| workspace::scope_contains(Path::new(path), scope))
                    })
                {
                    coverage.project.push(input());
                    continue;
                }
                &value.entries
            };
            let entry = if let Some(entry) = entries.get(path) {
                Some(entry)
            } else if cfg!(windows) {
                let key = inspection_key(path);
                let mut aliases = entries
                    .iter()
                    .filter(|(name, _)| inspection_key(name) == key);
                let found = aliases.next().map(|(_, entry)| entry);
                if aliases.next().is_some() {
                    return Err(format!(
                        "Ambiguous recorded native input path aliases: {root}:{path}"
                    ));
                }
                found
            } else {
                None
            };
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
