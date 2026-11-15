//! Multi-root E is a storage format, not a new execution/publication mode.
use super::*;
use crate::workspace_files::RootScope;

type Layouts = BTreeMap<String, RootScope>;

impl Environments {
    pub(super) fn root_layouts_for_launch(
        &self,
        launch: &LaunchConfig,
    ) -> Result<Option<Layouts>, String> {
        if !self.config.discovery
            || !self.config.launch.state_bound()
            || launch.owned_scopes.is_none()
        {
            return Ok(None);
        }
        let mut scopes = BTreeMap::from([("state".to_string(), self.config.scopes.clone())]);
        for scope in launch.owned_scopes.iter().flatten() {
            scopes
                .entry(scope.root.clone())
                .or_insert_with(Vec::new)
                .push(scope.path.clone());
        }
        if let Some(binding) = &launch.environment {
            scopes
                .entry(self.scope_root(launch).into())
                .or_insert_with(Vec::new)
                .push(binding.prefix.clone());
        }
        Ok(Some(
            scopes
                .into_iter()
                .map(|(label, scopes)| {
                    let caches = if label == "state" {
                        self.config.caches.clone()
                    } else {
                        Vec::new()
                    };
                    (label, RootScope::normalized(scopes, caches))
                })
                .collect(),
        ))
    }

    pub(super) fn snapshot_layouts(
        &self,
        launch: &str,
        version: &str,
    ) -> Result<Option<Layouts>, String> {
        let recorded = self.files.root_layouts(version)?;
        if let Some(recorded) = &recorded {
            let expected = self
                .root_layouts_for_launch(&self.load_launch(launch)?)?
                .ok_or("Root-qualified snapshot has no matching ownership contract")?;
            if *recorded != expected {
                return Err("Environment snapshot root/scope coverage differs from its recorded launch; refusing partial restoration".into());
            }
        }
        Ok(recorded)
    }

    pub(super) fn snapshot_targets(
        &self,
        path: &Path,
        layouts: &Layouts,
    ) -> Result<BTreeMap<String, PathBuf>, String> {
        layouts
            .keys()
            .map(|root| {
                let path = match root.as_str() {
                    "workspace" => path.to_path_buf(),
                    "state" => self.state_root(path)?,
                    _ => return Err("Unsupported environment snapshot root".into()),
                };
                Ok((root.clone(), path))
            })
            .collect()
    }

    /// A launch alone is not recovery evidence. New manifests can restore both
    /// roots only if their recorded coverage contains all previous ownership.
    pub(crate) fn validate_history_result(
        &self,
        selected: &CompositeResult,
        previous: &str,
    ) -> Result<(), String> {
        self.validate_result_metadata(selected)?;
        let Some(target) =
            self.snapshot_layouts(&selected.launch_ref, &selected.environment_ref)?
        else {
            return self.validate_history_scopes(&selected.launch_ref, previous);
        };
        let before = self.load_launch(previous)?;
        let Some(before) = self.root_layouts_for_launch(&before)? else {
            // A legacy L can still describe its single root. Only the target's
            // byte evidence, never its directory names, authorizes restoration.
            let label = self.scope_root(&before);
            for scope in self.scope_paths(previous)? {
                if self.config.caches.contains(&scope) {
                    continue;
                }
                if !target
                    .get(label)
                    .is_some_and(|layout| layout.covers(&scope))
                {
                    return Err(format!("Historical rollback lacks captured coverage for {label}:{scope}; refusing partial restoration"));
                }
            }
            return Ok(());
        };
        for (label, layout) in before {
            for scope in layout.scopes {
                if !target
                    .get(&label)
                    .is_some_and(|target| target.covers(&scope))
                {
                    return Err(format!("Historical rollback lacks captured coverage for {label}:{scope}; refusing partial restoration"));
                }
            }
        }
        Ok(())
    }

    /// Native worker preflight, before Runtime resets project code. Actor-side
    /// checks remain manifest-only; this validates every stored byte and target.
    pub(crate) fn preflight_history_result(
        &self,
        path: &Path,
        selected: &CompositeResult,
        previous: &str,
    ) -> Result<(), String> {
        self.validate_history_result(selected, previous)?;
        if let Some(layouts) =
            self.snapshot_layouts(&selected.launch_ref, &selected.environment_ref)?
        {
            if self.baseline()? != selected.domain {
                return Err("Native baseline/domain changed; refusing unsafe historical environment restoration".into());
            }
            self.files.preflight_roots(
                &self.snapshot_targets(path, &layouts)?,
                &selected.environment_ref,
            )
        } else {
            self.validate_result(selected)
        }
    }

    pub(crate) fn same_business_prefix_contents(
        &self,
        left: &CompositeResult,
        right: &CompositeResult,
        prefix: &str,
    ) -> Result<bool, String> {
        let launch = self.load_launch(&left.launch_ref)?;
        self.files.same_scope_contents(
            &left.environment_ref,
            &right.environment_ref,
            prefix,
            self.scope_root(&launch),
        )
    }
}
