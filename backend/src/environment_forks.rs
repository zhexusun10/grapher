//! Narrow cross-slot inheritance of already private HOME bytes. No interpreter
//! relocation, host HOME import, directory merge, or new selection authority.
use super::*;

impl Environments {
    fn home_fork_candidate(&self, input: &CompositeResult) -> Result<bool, String> {
        let base = &self.config.launch;
        if !self.config.best_effort
            || !self.config.discovery
            || self.config.import_source
            || self.config.launch_file.is_some()
            || !self.config.initialize.is_empty()
            || !base.inherit_ambient
            || base.unbound_path.is_none()
            || base.environment.is_some()
            || base.hook.is_some()
            || base
                .owned_scopes
                .as_ref()
                .is_none_or(|scopes| !scopes.is_empty())
        {
            return Ok(false);
        }
        let Some(home) = base
            .variables
            .get("HOME")
            .and_then(|path| path.strip_prefix("{state}/"))
        else {
            return Ok(false);
        };
        safe_relative(home)?;
        // Only the automatic unbound launch is eligible. An inactive prefix is
        // still owned and must not acquire relocation permission via unbinding.
        let mut launch = self.load_launch(&input.launch_ref)?;
        let mut expected = base.clone();
        launch.ambient_hints.clear();
        expected.ambient_hints.clear();
        if launch != expected || input.layout.is_none() {
            return Ok(false);
        }
        self.files.home_only_snapshot(&input.environment_ref, home)
    }

    pub(super) fn retain_existing_home_target(
        &self,
        path: &Path,
        selected: &CompositeResult,
    ) -> Result<Option<CompositeResult>, String> {
        if !self.home_fork_candidate(selected)?
            || self
                .scoped_files_at(Some(path), &selected.launch_ref)?
                .home_target_is_empty(&self.state_root(path)?)?
        {
            return Ok(None);
        }
        // The current bytes win over an optional fresh-slot copy. This is the
        // existing best-effort unbound behavior, not a new execution gate or a
        // claim that parent bytes were inherited. The caller still validates
        // the selected stored bytes before capturing the retained live state.
        let mut retained = selected.clone();
        retained
            .inheritance
            .get_or_insert_with(|| InheritanceDecision {
                reason: String::new(),
                inputs: vec![],
            })
            .reason = "unbound-home-target-preserved".into();
        Ok(Some(retained))
    }

    pub(super) fn select_home_fork(
        &self,
        inputs: &[(String, CompositeResult)],
    ) -> Result<Option<CompositeResult>, String> {
        if inputs.is_empty() {
            return Ok(None);
        }
        let eligible = inputs
            .iter()
            .map(|(_, input)| self.home_fork_candidate(input))
            .collect::<Result<Vec<_>, _>>()?;
        // Only the selected frame is copied. Older non-HOME/legacy frames do
        // not disqualify a proven newer frame whose ownership/bytes are safe.
        // Equal E refs cannot order different launches, however: all launches
        // on that same head must meet the unbound contract (hints may differ).
        for (index, (_, candidate)) in inputs.iter().enumerate() {
            if !eligible[index] {
                continue;
            }
            let mut latest = true;
            for (other_index, (_, other)) in inputs.iter().enumerate() {
                let covered = if candidate.environment_ref == other.environment_ref {
                    eligible[other_index]
                } else {
                    self.config.allow_descendant
                        && self
                            .files
                            .descends_from(&candidate.environment_ref, &other.environment_ref)?
                };
                if !covered {
                    latest = false;
                    break;
                }
            }
            if latest {
                return Ok(Some(candidate.clone()));
            }
        }
        Ok(None)
    }
}
