//! Root-qualified managed byte evidence. Legacy Version tuples stay unchanged;
//! rooted manifests never alias same-named paths in different physical roots.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct RootScope {
    pub scopes: Vec<String>,
    pub caches: Vec<String>,
}

impl RootScope {
    pub(crate) fn normalized(scopes: Vec<String>, mut caches: Vec<String>) -> Self {
        let mut scopes = scopes;
        scopes.sort();
        scopes.dedup();
        let all = scopes.clone();
        scopes.retain(|path| {
            !all.iter().any(|other| {
                other != path && workspace::scope_contains(Path::new(path), Path::new(other))
                    // Case aliases on Windows cover each other. Retain one
                    // deterministic spelling instead of discarding both.
                    && (!workspace::scope_contains(Path::new(other), Path::new(path)) || other < path)
            })
        });
        caches.sort();
        caches.dedup();
        Self { scopes, caches }
    }

    pub(crate) fn covers(&self, path: &str) -> bool {
        self.scopes
            .iter()
            .any(|scope| workspace::scope_contains(Path::new(path), Path::new(scope)))
            && !self
                .caches
                .iter()
                .any(|cache| workspace::scope_contains(Path::new(path), Path::new(cache)))
    }

    fn validate(&self) -> Result<(), String> {
        if self.scopes.is_empty()
            || *self != Self::normalized(self.scopes.clone(), self.caches.clone())
        {
            return Err("Invalid or noncanonical root-qualified environment scope coverage".into());
        }
        for path in self.scopes.iter().chain(&self.caches) {
            relative(path)?;
        }
        for cache in &self.caches {
            if self
                .scopes
                .iter()
                .any(|scope| workspace::scope_contains(Path::new(scope), Path::new(cache)))
            {
                return Err("Environment cache contains a recorded scope".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Root {
    pub layout: RootScope,
    pub entries: Entries,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Snapshot {
    pub schema: u32,
    pub roots: BTreeMap<String, Root>,
}

impl Files {
    fn for_root(&self, layout: &RootScope) -> Self {
        Self {
            directory: self.directory.clone(),
            excluded_data: self.excluded_data.clone(),
            scopes: Some(layout.scopes.iter().map(PathBuf::from).collect()),
            caches: layout.caches.iter().map(PathBuf::from).collect(),
            // Project Git conflicts are preflighted against the actual native
            // project index, not the engine's force-collected graph index.
            project_index: false,
        }
    }

    pub(super) fn validate_rooted_metadata(&self, value: &Snapshot) -> Result<(), String> {
        if value.schema != 1 || value.roots.is_empty() {
            return Err("Unsupported root-qualified environment snapshot schema".into());
        }
        for (label, root) in &value.roots {
            if !matches!(label.as_str(), "workspace" | "state") {
                return Err("Invalid environment snapshot ownership root".into());
            }
            root.layout.validate()?;
            for (name, entry) in &root.entries {
                relative(name)?;
                if !root.layout.covers(name) {
                    return Err(format!(
                        "Environment entry outside recorded scope coverage: {label}:{name}"
                    ));
                }
                match entry {
                    Entry::File { blob, .. } => {
                        self.blob_path(blob)?;
                    }
                    Entry::Link {
                        target,
                        internal: true,
                        ..
                    } => {
                        relative(target)?;
                    }
                    _ => {}
                }
                let mut ancestor = Path::new(name).parent();
                while let Some(path) = ancestor.filter(|path| !path.as_os_str().is_empty()) {
                    if root
                        .entries
                        .get(&path_name(path)?)
                        .is_some_and(|entry| !matches!(entry, Entry::Directory { .. }))
                    {
                        return Err(format!(
                            "Conflicting root-qualified environment directory: {label}:{}",
                            path.display()
                        ));
                    }
                    ancestor = path.parent();
                }
            }
        }
        Ok(())
    }

    pub(crate) fn root_layouts(
        &self,
        version: &str,
    ) -> Result<Option<BTreeMap<String, RootScope>>, String> {
        Ok(self.load(version)?.rooted.map(|snapshot| {
            snapshot
                .roots
                .into_iter()
                .map(|(label, root)| (label, root.layout))
                .collect()
        }))
    }

    fn check_root_targets(
        &self,
        paths: &BTreeMap<String, PathBuf>,
        labels: impl Iterator<Item = String>,
    ) -> Result<(), String> {
        let labels: BTreeSet<_> = labels.collect();
        if paths.keys().cloned().collect::<BTreeSet<_>>() != labels {
            return Err(
                "Missing or extra physical environment root target; refusing partial restoration"
                    .into(),
            );
        }
        let roots = paths
            .values()
            .map(|path| path.canonicalize().map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        for (index, root) in roots.iter().enumerate() {
            if roots[..index].iter().any(|other| {
                crate::path_identity::same_path(root, other)
                    || workspace::scope_contains(root, other)
                    || workspace::scope_contains(other, root)
            }) {
                return Err(
                    "Environment roots alias or overlap; refusing cross-root restoration".into(),
                );
            }
        }
        Ok(())
    }

    fn check_native_project_scopes(
        &self,
        paths: &BTreeMap<String, PathBuf>,
        snapshot: &Snapshot,
    ) -> Result<(), String> {
        let (Some(path), Some(root)) = (paths.get("workspace"), snapshot.roots.get("workspace"))
        else {
            return Ok(());
        };
        if !path.join(".git").exists() {
            return Ok(());
        }
        let tracked = workspace::project_git(path, &["ls-files", "-z", "--cached"])?;
        for name in tracked.split('\0').filter(|name| !name.is_empty()) {
            if root.layout.scopes.iter().any(|scope| {
                workspace::scope_contains(Path::new(name), Path::new(scope))
                    || workspace::scope_contains(Path::new(scope), Path::new(name))
            }) {
                return Err(format!(
                    "Managed environment scope conflicts with tracked path {name}"
                ));
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn capture_roots(
        &self,
        paths: &BTreeMap<String, PathBuf>,
        layouts: &BTreeMap<String, RootScope>,
        version: &str,
        parents: &[String],
    ) -> Result<(), String> {
        for parent in parents {
            self.load(parent)?;
        }
        let checked = RefCell::default();
        let value =
            self.capture_roots_value(paths, layouts, parents, Collection::Capture(&checked))?;
        self.save_version(version, value)
    }

    pub(crate) fn capture_roots_reusing(
        &self,
        paths: &BTreeMap<String, PathBuf>,
        layouts: &BTreeMap<String, RootScope>,
        parent: &str,
    ) -> Result<String, String> {
        let previous = self.load(parent)?;
        let checked = RefCell::default();
        self.validate_value(&previous, &checked)?;
        let value = self.capture_roots_value(
            paths,
            layouts,
            &[parent.into()],
            Collection::Capture(&checked),
        )?;
        self.save_changed(value, parent, &previous)
    }

    #[cfg(test)]
    pub(crate) fn capture_roots_unbatched(
        &self,
        paths: &BTreeMap<String, PathBuf>,
        layouts: &BTreeMap<String, RootScope>,
        parent: &str,
    ) -> Result<String, String> {
        self.load(parent)?;
        let value = self.capture_roots_value(
            paths,
            layouts,
            &[parent.into()],
            Collection::CaptureUnbatched,
        )?;
        let version = Uuid::new_v4().to_string();
        self.save_version(&version, value)?;
        if self.same_contents(parent, &version)? {
            Ok(parent.into())
        } else {
            Ok(version)
        }
    }

    fn capture_roots_value(
        &self,
        paths: &BTreeMap<String, PathBuf>,
        layouts: &BTreeMap<String, RootScope>,
        parents: &[String],
        collection: Collection<'_>,
    ) -> Result<Version, String> {
        self.check_root_targets(paths, layouts.keys().cloned())?;
        let mut snapshot = Snapshot {
            schema: 1,
            roots: BTreeMap::new(),
        };
        for (label, layout) in layouts {
            layout.validate()?;
            let files = self.for_root(layout);
            let root = paths[label]
                .canonicalize()
                .map_err(|error| error.to_string())?;
            let mut entries = Entries::new();
            for path in files.scoped_paths(&root)? {
                files.collect(&root, &path, &mut entries, collection)?;
            }
            snapshot.roots.insert(
                label.clone(),
                Root {
                    layout: layout.clone(),
                    entries,
                },
            );
        }
        self.validate_rooted_metadata(&snapshot)?;
        self.check_native_project_scopes(paths, &snapshot)?;
        Ok(Version {
            schema: 1,
            head: String::new(),
            parents: parents.to_vec(),
            entries: Entries::new(),
            checksum: None,
            rooted: Some(snapshot),
        })
    }

    pub(crate) fn verify_roots(
        &self,
        paths: &BTreeMap<String, PathBuf>,
        version: &str,
    ) -> Result<(), String> {
        let value = self
            .load(version)?
            .rooted
            .ok_or("Missing root-qualified environment byte evidence")?;
        self.check_root_targets(paths, value.roots.keys().cloned())?;
        // Hash every live file and each distinct immutable stored blob in this
        // operation; exact entry equality below proves no live file was omitted.
        let checked = RefCell::default();
        for (label, root) in &value.roots {
            let files = self.for_root(&root.layout);
            let path = paths[label]
                .canonicalize()
                .map_err(|error| error.to_string())?;
            let mut current = Entries::new();
            for child in files.scoped_paths(&path)? {
                files.collect(
                    &path,
                    &child,
                    &mut current,
                    Collection::Verify(&root.entries, &checked),
                )?;
            }
            if current != root.entries {
                return Err(format!(
                    "Environment root changed after completion: {label}"
                ));
            }
        }
        Ok(())
    }

    fn root_materializations(
        &self,
        paths: &BTreeMap<String, PathBuf>,
        version: &str,
    ) -> Result<Vec<(Self, Materialization)>, String> {
        let snapshot = self
            .load(version)?
            .rooted
            .ok_or("Missing root-qualified environment byte evidence")?;
        self.check_root_targets(paths, snapshot.roots.keys().cloned())?;
        // All stored bytes and every target's scopes/metadata are preflighted
        // before applying a single plan. Current-tree inspection is read-only:
        // it neither saves discarded partial bytes nor repairs missing history.
        self.validate(&[version.into()])?;
        self.check_native_project_scopes(paths, &snapshot)?;
        let mut plans = Vec::new();
        for (label, root) in snapshot.roots {
            let files = self.for_root(&root.layout);
            let plan = files
                .plan_materialization(&paths[&label], root.entries, None, false)?
                .ok_or("Missing environment materialization plan")?;
            plans.push((files, plan));
        }
        Ok(plans)
    }

    pub(crate) fn preflight_roots(
        &self,
        paths: &BTreeMap<String, PathBuf>,
        version: &str,
    ) -> Result<(), String> {
        self.root_materializations(paths, version).map(|_| ())
    }

    pub(crate) fn materialize_roots(
        &self,
        paths: &BTreeMap<String, PathBuf>,
        version: &str,
    ) -> Result<(), String> {
        for (files, plan) in self.root_materializations(paths, version)? {
            files.apply_materialization(plan)?;
        }
        Ok(())
    }
}
