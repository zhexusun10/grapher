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
            // An explicit policy can use a current single-root L/E pair. Only
            // the target's captured coverage authorizes restoration.
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
        self.preflight_runtime_evidence(path, selected)?;
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

    /// Native worker only. This needs no live interpreter and can run before
    /// a missing W is reconstructed or project code is reset.
    /// Unbound launches have no file evidence.
    pub(crate) fn preflight_runtime_evidence(
        &self,
        path: &Path,
        selected: &CompositeResult,
    ) -> Result<(), String> {
        self.preflight_runtime_evidence_phase(path, selected, false)
    }

    /// Native worker only, with the exact project codeRef about to be restored.
    /// No user input declaration: both the files and the commit are already
    /// selected immutable execution evidence. Normal launches keep their rules.
    pub(crate) fn preflight_project_runtime_evidence(
        &self,
        source: &Path,
        code_ref: &str,
        selected: &CompositeResult,
    ) -> Result<(), String> {
        self.validate_result_metadata(selected)?;
        let launch = self.load_launch(&selected.launch_ref)?;
        if let Some(evidence) = launch
            .environment
            .as_ref()
            .and_then(|binding| binding.runtime_evidence.as_ref())
        {
            evidence.preflight_project_code(
                &self.scoped_files(&selected.launch_ref)?,
                &selected.environment_ref,
                self.scope_root(&launch),
                source,
                code_ref,
            )?;
        }
        Ok(())
    }

    /// Called only after Runtime's existing codeRef preparation, before E writes.
    pub(super) fn preflight_prepared_runtime_evidence(
        &self,
        path: &Path,
        selected: &CompositeResult,
    ) -> Result<(), String> {
        self.preflight_runtime_evidence_phase(path, selected, true)
    }

    fn preflight_runtime_evidence_phase(
        &self,
        path: &Path,
        selected: &CompositeResult,
        project_ready: bool,
    ) -> Result<(), String> {
        self.validate_result_metadata(selected)?;
        let launch = self.load_launch(&selected.launch_ref)?;
        let Some(evidence) = launch
            .environment
            .as_ref()
            .and_then(|binding| binding.runtime_evidence.as_ref())
        else {
            return Ok(());
        };
        if !selected
            .layout
            .as_deref()
            .is_some_and(|layout| crate::path_identity::same_path(path, Path::new(layout)))
        {
            return Err("Native runtime evidence belongs to another or missing physical layout; no cross-layout reconstruction is authorized".into());
        }
        let mut roots = BTreeMap::from([("workspace".into(), path.to_path_buf())]);
        if self.config.launch.state_bound() {
            // Derive the recorded slot's S without creating it or needing W to
            // exist. Do not use another slot/root to supply cache/native bytes.
            let state = crate::workspace_state::process_root(path)?;
            let run = path.parent().ok_or("Missing native workspace owner")?;
            if run.is_dir() {
                real_child_path(run, &state, false)?;
            }
            roots.insert("state".into(), state);
        }
        let files = self.scoped_files(&selected.launch_ref)?;
        if project_ready {
            evidence.preflight_prepared(
                &files,
                &selected.environment_ref,
                self.scope_root(&launch),
                &roots,
            )
        } else {
            evidence.preflight(
                &files,
                &selected.environment_ref,
                self.scope_root(&launch),
                &roots,
            )
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
