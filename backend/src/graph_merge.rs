use crate::{
    engine::{run_pi, PiModelConfig, PiRequest, PiRole},
    model::{now, Config, EventKind, Execution, ImageAttachment},
    workspace::{self, repository_git as git},
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};
use uuid::Uuid;

mod publication;
pub use publication::publication_workspace;

/// Git composition is the only Merger responsibility. Environment differences
/// are handled by Runtime as reuse-or-unbound and never enter this prompt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct MergerConflicts {
    pub(crate) git: bool,
}

impl MergerConflicts {
    pub(crate) const GIT: Self = Self { git: true };
}

pub(crate) fn merger_prompt(query: &str, _conflicts: MergerConflicts) -> String {
    format!(
        "The Workspace Objective below is ONLY to help you decide how conflicting changes should be integrated.\nDo NOT attempt to execute or fulfill this task in this session. Your sole responsibility is Git conflict repair using the available file and Bash tools.\n\nWorkspace Objective:\n<workspace_objective>\n{query}\n</workspace_objective>\n\n{MERGER_GIT_INSTRUCTIONS}"
    )
}

const MERGER_GIT_INSTRUCTIONS: &str = "Resolve the current Git merge conflicts. Preserve valid changes. Do not modify unrelated files. Stage the resolved files and verify that no unresolved conflicts remain. Do not discard the incoming commit.\nProject snapshots include project files ignored by .gitignore. Stage resolved or changed project paths with git add -f -- <paths>, even when they match .gitignore. Do not stage Git/Grapher internals or managed environment/cache scopes.";

/// Git conflict repair is a single Merger execution; environment differences
/// never create a Merger session.
fn pending(repository: &Path) -> Option<String> {
    git(repository, &["rev-parse", "--verify", "MERGE_HEAD"]).ok()
}

fn finish_merge(repository: &Path, head: &str, exclusions: &[String]) -> Result<(), String> {
    if !git(repository, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
        return Err("Merger left unresolved conflicts".into());
    }
    if pending(repository).is_some() {
        workspace::stage_scoped_local(repository, exclusions)?;
        // A Merger may have staged a managed environment/cache scope itself;
        // never let a runtime-owned path enter the merge commit.
        workspace::unstage_scoped(repository, exclusions)?;
        git(repository, &["commit", "--no-edit"])?;
    } else if git(repository, &["diff", "--cached", "--name-only"])?.is_empty()
        && workspace::has_tracked_scoped(repository, exclusions)?
    {
        // A Merger that committed the merge itself still must not carry a
        // managed scope. Amend its commit; the live files stay in place.
        workspace::unstage_scoped(repository, exclusions)?;
        git(repository, &["commit", "--amend", "--no-edit"])?;
    }
    git(repository, &["merge-base", "--is-ancestor", head, "HEAD"])
        .map_err(|_| "Merger did not preserve the incoming commit".to_string())?;
    if !workspace::repository_status(repository, exclusions)?.is_empty() {
        return Err("Merge left uncommitted changes; inspect the affected workspace".into());
    }
    Ok(())
}

/// Deliver project files only, keeping every commit, snapshot and conflict
/// repair private. The user's Git HEAD, index and object database stay unchanged.
/// Use `merge_graph_with_workspace` when conflict repair needs the private cwd.
pub fn merge_graph(
    repository: &Path,
    heads: &[String],
    mut resolve: impl FnMut() -> Result<(), String>,
) -> Result<String, String> {
    merge_graph_scoped(repository, heads, &[], |_| resolve())
}

pub fn merge_graph_with_workspace(repository: &Path, heads: &[String], resolve: impl FnMut(&Path) -> Result<(), String>) -> Result<String, String> {
    merge_graph_scoped(repository, heads, &[], resolve)
}

pub(crate) fn merge_graph_scoped(repository: &Path, heads: &[String], exclusions: &[String], resolve: impl FnMut(&Path) -> Result<(), String>) -> Result<String, String> {
    publication::publish(repository, heads, exclusions, None, resolve)
}

pub(crate) fn merge_graph_scoped_at(repository: &Path, heads: &[String], exclusions: &[String], path: &Path, resolve: impl FnMut(&Path) -> Result<(), String>) -> Result<String, String> {
    publication::publish(repository, heads, exclusions, Some(path), resolve)
}

fn compose_graph_scoped(repository: &Path, heads: &[String], exclusions: &[String], mut resolve: impl FnMut() -> Result<(), String>) -> Result<String, String> {
    workspace::validate_binding(repository)?;
    if let Some(head) = pending(repository) {
        if !heads.contains(&head) {
            return Err(
                "An unrelated merge is in progress; finish it before retrying publication".into(),
            );
        }
        if !git(repository, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
            resolve()?;
        }
        finish_merge(repository, &head, exclusions)?;
    }
    // Commit pending user edits as the base before node results merge on top.
    // The user's work is always accepted; a real conflict with node results is
    // handled by the ordinary merge/Merger path below, not by refusing here.
    workspace::stage_scoped_local(repository, exclusions)?;
    if !git(repository, &["diff", "--cached", "--name-only"])?.is_empty() {
        git(repository, &["commit", "-m", workspace::SNAPSHOT_COMMIT_MESSAGE])?;
    }
    // Complete a pending merge above before pruning, so publication retries
    // retain their original incoming commit even if it is now redundant.
    for head in &workspace::independent_heads(repository, heads)? {
        if git(repository, &["merge-base", "--is-ancestor", head, "HEAD"]).is_ok() {
            continue;
        }
        if let Err(error) = git(repository, &["merge", "--no-edit", "--no-ff", head]) {
            if pending(repository).as_deref() != Some(head.as_str())
                || git(repository, &["diff", "--name-only", "--diff-filter=U"])?.is_empty()
            {
                return Err(format!("Graph publication failed: {error}"));
            }
            resolve()?;
        }
        finish_merge(repository, head, exclusions)?;
    }
    git(repository, &["rev-parse", "HEAD"])
}

pub fn resolve_with_merger(
    repository: &Path,
    query: &str,
    config: &Config,
    root: &Path,
    attempt: usize,
    emit: impl FnMut(EventKind) -> Result<(), String>,
) -> Result<(), String> {
    resolve_with_merger_for_node(
        repository,
        query,
        config,
        root,
        attempt,
        "merger",
        MergerConflicts::GIT,
        emit,
    )
    .map(|_| ())
}

/// Resolve an in-progress Git merge in either the publication checkout or a DAG node checkout.
pub(crate) fn resolve_with_merger_for_node(
    repository: &Path,
    query: &str,
    config: &Config,
    root: &Path,
    attempt: usize,
    node: &str,
    conflicts: MergerConflicts,
    mut emit: impl FnMut(EventKind) -> Result<(), String>,
) -> Result<(), String> {
    let canonical = repository.canonicalize().map_err(|e| e.to_string())?;
    let repository = canonical.as_path();
    let _git_view = if crate::path_identity::same_path(repository, Path::new(&config.repository)) { None }
        else { Some(workspace::MergerGitView::open(repository)?) };
    let id = Uuid::new_v4().to_string();
    let incoming = pending(repository).ok_or("No pending merge to resolve")?;
    let before_head = git(repository, &["rev-parse", "HEAD"])?;
    let prompt = merger_prompt(query, conflicts);
    let directory = root.join("mergers").join(&id);
    // Commit ownership before allocation; even a failed mkdir/open belongs to
    // this Run and can be reclaimed when the conversation is deleted.
    emit(EventKind::MergerStarted {
        execution: Execution {
            id: id.clone(),
            node: node.into(),
            revision: 1,
            attempt,
            session_id: id.clone(),
            worktree: repository.to_string_lossy().into(),
            before: before_head,
            workspace_lineage: vec![],
            after: None,
            input: None, result: None,
            status: "running".into(),
            output: String::new(), output_bytes: 0, pid: None,
            started_at: now(),
            completed_at: None,
            metrics: None,
        },
    })?;
    let mut log = match (|| -> Result<_, String> {
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        OpenOptions::new().create_new(true).write(true).open(directory.join("output.jsonl"))
            .map_err(|error| error.to_string())
    })() {
        Ok(log) => log,
        Err(error) => {
            emit(EventKind::MergerFailed { execution_id: id, error: error.clone(), output_bytes: 0, metrics: None })?;
            return Err(error);
        }
    };
    // Make native Git commands work in a plain folder without adding a .git
    // entry there. This environment is scoped to the merger process tree;
    // stock Git/Bash must receive host paths, not Windows device prefixes.
    let environment_vars: Vec<(&str, String)> = if workspace::is_standard_git(repository) {
        Vec::new()
    } else {
        vec![
            (
                "GIT_DIR",
                crate::native::host_path(&workspace::shadow_repo_dir(repository)?)
                    .to_string_lossy()
                    .into(),
            ),
            ("GIT_WORK_TREE", crate::native::host_path(repository).to_string_lossy().into()),
        ]
    };
    let mut output_error = None;
    let merger_model_cfg = PiModelConfig::resolve(PiRole::Merger, config);
    let merger_config = merger_model_cfg.effective_config(config);
    let mut extra_args = vec!["--no-context-files"];
    if let Some(thinking) = &merger_model_cfg.thinking {
        extra_args.push("--thinking");
        extra_args.push(thinking.as_str());
    }
    let result = run_pi(
        PiRequest {
            role: PiRole::Merger,
            config: &merger_config,
            cwd: repository,
            task: "Resolve the current merge conflicts.",
            session_dir: &directory,
            extension: None,
            tools: Some("read,write,bash,edit"),
            session_id: Some(&id),
            extra_args,
            environment: environment_vars,
            system_prompt: Some(&prompt),
            images: None,
        },
        |text| {
            if let Err(error) = log.write_all(text.as_bytes()) {
                output_error = Some(error.to_string());
            }
            if let Err(error) = emit(EventKind::Output {
                execution_id: id.clone(),
                text,
            }) {
                output_error = Some(error);
            }
        },
    )
    .and_then(|_| {
        if let Some(error) = output_error {
            return Err(format!("Cannot persist merger output: {error}"));
        }
        // Node composition must exclude the managed environment/cache scopes
        // exactly like publication does; otherwise Grapher's own staging would
        // commit `.agent-home`/`.venv` and the next preparation would reject the
        // merge as a tracked-file conflict.
        let exclusions = config
            .environment
            .as_ref()
            .map(|environment| environment.exclusions())
            .unwrap_or_default();
        finish_merge(repository, &incoming, &exclusions)
    });
    match &result {
        Ok(()) => {
            let head = git(repository, &["rev-parse", "HEAD"])?;
            eprintln!("[Grapher] [Merger] Finished resolving conflicts for '{node}' (HEAD: {head})");
            emit(EventKind::MergerFinished {
                execution_id: id.clone(),
                head, output_bytes: 0, metrics: None,
            })?
        }
        Err(error) => {
            eprintln!("[Grapher] [Merger] Failed resolving conflicts for '{node}': {error}");
            emit(EventKind::MergerFailed {
                execution_id: id.clone(),
                error: error.clone(), output_bytes: 0, metrics: None,
            })?
        }
    }
    fs::write(directory.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "id": id, "name": "merger", "node": node, "cwd": repository,
        "status": if result.is_ok() { "completed" } else { "failed" }, "error": result.as_ref().err(),
    })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    result
}

/// Continue a settled publication Merger conversation. The new execution keeps
/// previous Pi history and the selected workspace: private repair before
/// delivery, source-direct afterward. No new Merger-specific system prompt is
/// appended, and it does not
/// re-enter the publication state machine.
///
/// The caller has already emitted `MergerStarted` for `execution` under the Run
/// lock and verified that no other execution owns the workspace. This function
/// only drives the model turn and records its terminal event.
pub fn continue_merger_for_node(
    previous: &Execution,
    execution: &Execution,
    instruction: &str,
    images: Option<&[ImageAttachment]>,
    config: &Config,
    session_dir: &Path,
    mut emit: impl FnMut(EventKind) -> Result<(), String>,
) -> Result<(), String> {
    let canonical = Path::new(&execution.worktree)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let repository = canonical.as_path();
    let _git_view = if crate::path_identity::same_path(repository, Path::new(&config.repository)) { None }
        else { Some(workspace::MergerGitView::open(repository)?) };
    let id = execution.id.clone();
    // Continue Pi's session file in the original Merger directory. The native
    // process identity is the new execution so it stays steerable in its own right.
    // A successful publication reclaims the temporary shadow snapshot of an
    // ordinary folder, so that continuation edits the source directly with no
    // Git (there is nothing left to commit or merge into); a retained
    // failed-publication snapshot keeps the previous Git-backed behavior. The
    // caller's recorded `before` commit is authoritative for an ordinary
    // folder: reclaiming may race this worker, and only a retained snapshot
    // has a `before` commit.
    let standard_git = workspace::is_standard_git(repository);
    let shadow = if standard_git || execution.before.is_empty() {
        None
    } else {
        workspace::shadow_repo_if_exists(repository)?
    };
    let git_backed = !execution.before.is_empty() && (standard_git || shadow.is_some());
    if !crate::path_identity::same_path(Path::new(&previous.worktree), repository) {
        crate::session_branch::rebind_session_cwd_by_header(session_dir, &previous.session_id, repository)?;
    }
    let environment = if standard_git {
        vec![("GRAPHER_NODE_EXECUTION_ID", id.clone())]
    } else if let Some(shadow) = &shadow {
        vec![
            (
                "GIT_DIR",
                crate::native::host_path(shadow)
                    .to_string_lossy()
                    .into(),
            ),
            ("GIT_WORK_TREE", crate::native::host_path(repository).to_string_lossy().into()),
            ("GRAPHER_NODE_EXECUTION_ID", id.clone()),
        ]
    } else {
        vec![("GRAPHER_NODE_EXECUTION_ID", id.clone())]
    };
    let mut output_error = None;
    let merger_model_cfg = PiModelConfig::resolve(PiRole::Merger, config);
    let merger_config = merger_model_cfg.effective_config(config);
    let mut extra_args = vec!["--no-context-files"];
    if let Some(thinking) = &merger_model_cfg.thinking {
        extra_args.push("--thinking");
        extra_args.push(thinking.as_str());
    }
    let result = run_pi(
        PiRequest {
            role: PiRole::Merger,
            config: &merger_config,
            cwd: repository,
            task: instruction,
            session_dir,
            extension: None,
            tools: Some("read,write,bash,edit"),
            session_id: Some(&previous.session_id),
            extra_args,
            environment,
            system_prompt: None,
            images,
        },
        |text| {
            if let Err(error) = emit(EventKind::Output {
                execution_id: id.clone(),
                text,
            }) {
                output_error = Some(error);
            }
        },
    )
    .and_then(|_| {
        if let Some(error) = output_error {
            return Err(format!("Cannot persist merger output: {error}"));
        }
        if !git_backed {
            return Ok(());
        }
        let exclusions = config.environment.as_ref().map(|e| e.exclusions()).unwrap_or_default();
        if let Some(head) = pending(repository) {
            // The user asked the Merger to continue an unresolved merge.
            if !git(repository, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
                return Err("Merger left unresolved conflicts".into());
            }
            finish_merge(repository, &head, &exclusions)
        } else if !workspace::repository_status(repository, &exclusions)?.is_empty() {
            Err("Merger left uncommitted changes; commit or discard them".into())
        } else {
            Ok(())
        }
    });
    match &result {
        Ok(()) => {
            let head = if git_backed {
                git(repository, &["rev-parse", "HEAD"])?
            } else {
                // No Git snapshot exists for this source-direct continuation.
                String::new()
            };
            eprintln!("[Grapher] [Merger] Continued publication repair (HEAD: {head})");
            emit(EventKind::MergerFinished {
                execution_id: id,
                head, output_bytes: 0, metrics: None,
            })?;
        }
        Err(error) => {
            eprintln!("[Grapher] [Merger] Publication continuation failed: {error}");
            emit(EventKind::MergerFailed {
                execution_id: id,
                error: error.clone(), output_bytes: 0, metrics: None,
            })?;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{merger_prompt, MergerConflicts};

    #[test]
    fn git_merger_prompt_preserves_task_context_without_graph_specific_terminology() {
        assert_eq!(
            merger_prompt("Combine results", MergerConflicts::GIT),
            format!("The Workspace Objective below is ONLY to help you decide how conflicting changes should be integrated.\nDo NOT attempt to execute or fulfill this task in this session. Your sole responsibility is Git conflict repair using the available file and Bash tools.\n\nWorkspace Objective:\n<workspace_objective>\nCombine results\n</workspace_objective>\n\n{}", super::MERGER_GIT_INSTRUCTIONS)
        );
    }

    #[test]
    fn merger_treats_original_planning_request_as_context_not_its_current_task() {
        let query = "Create two nodes with the node tool, then stop planning.";
        let prompt = merger_prompt(query, MergerConflicts::GIT);
        assert!(prompt.starts_with("The Workspace Objective below is ONLY to help you decide"));
        assert!(prompt.contains(&format!("Workspace Objective:\n<workspace_objective>\n{query}\n</workspace_objective>")));
        assert!(prompt.contains("Do NOT attempt to execute or fulfill this task in this session"));
        assert!(prompt.contains("Your sole responsibility is Git conflict repair using the available file and Bash tools"));
        assert!(prompt.ends_with(super::MERGER_GIT_INSTRUCTIONS));
    }

    #[test]
    fn merger_prompt_force_stages_ignored_project_paths_without_collecting_internal_scopes() {
        let prompt = merger_prompt("resolve", MergerConflicts::GIT);
        assert!(prompt.contains("project files ignored by .gitignore"));
        assert!(prompt.contains("git add -f -- <paths>"));
        assert!(prompt.contains("Do not stage Git/Grapher internals or managed environment/cache scopes"));
        assert!(!prompt.contains("git add -f -A"), "Merger must stage explicit project paths, not all environment files");
        assert!(!prompt.contains("environment reconciliation"));
    }

    #[test]
    fn finish_merge_never_commits_a_managed_environment_scope() {
        use std::fs;
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| crate::workspace::git(&repo, args).unwrap();
        git(&["init", "-q"]);
        git(&["config", "user.email", "graph@test"]);
        git(&["config", "user.name", "Graph"]);
        fs::write(repo.join("f.txt"), "base\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "base"]);
        let base = git(&["rev-parse", "HEAD"]);
        git(&["checkout", "-qb", "incoming"]);
        fs::write(repo.join("f.txt"), "incoming\n").unwrap();
        git(&["commit", "-qam", "incoming"]);
        let incoming = git(&["rev-parse", "HEAD"]);
        git(&["checkout", "-q", "-B", "main", &base]);
        fs::write(repo.join("f.txt"), "main\n").unwrap();
        git(&["commit", "-qam", "main"]);
        // The Merger resolves the conflict and (incorrectly) stages a scope.
        fs::create_dir_all(repo.join(".agent-home/AppData")).unwrap();
        fs::write(repo.join(".agent-home/AppData/config.json"), "junk\n").unwrap();
        let _ = crate::workspace::git(&repo, &["merge", "--no-edit", "--no-ff", &incoming]);
        fs::write(repo.join("f.txt"), "resolved\n").unwrap();
        git(&["add", "f.txt"]);
        git(&["add", "-f", ".agent-home"]);
        assert!(git(&["diff", "--cached", "--name-only"]).contains(".agent-home"));

        super::finish_merge(&repo, &incoming, &[".agent-home".to_string()]).unwrap();

        let tree = git(&["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(
            !tree.contains(".agent-home"),
            "merge commit carried a managed scope: {tree}"
        );
        assert!(repo.join(".agent-home/AppData/config.json").is_file());
    }

    #[test]
    fn finish_merge_amends_a_merger_commit_that_carried_a_managed_scope() {
        use std::fs;
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| crate::workspace::git(&repo, args).unwrap();
        git(&["init", "-q"]);
        git(&["config", "user.email", "graph@test"]);
        git(&["config", "user.name", "Graph"]);
        fs::write(repo.join("f.txt"), "base\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "base"]);
        let base = git(&["rev-parse", "HEAD"]);
        git(&["checkout", "-qb", "incoming"]);
        fs::write(repo.join("f.txt"), "incoming\n").unwrap();
        git(&["commit", "-qam", "incoming"]);
        let incoming = git(&["rev-parse", "HEAD"]);
        git(&["checkout", "-q", "-B", "main", &base]);
        fs::write(repo.join("f.txt"), "main\n").unwrap();
        git(&["commit", "-qam", "main"]);
        fs::create_dir_all(repo.join(".agent-home/AppData")).unwrap();
        fs::write(repo.join(".agent-home/AppData/config.json"), "junk\n").unwrap();
        let _ = crate::workspace::git(&repo, &["merge", "--no-edit", "--no-ff", &incoming]);
        fs::write(repo.join("f.txt"), "resolved\n").unwrap();
        git(&["add", "f.txt"]);
        git(&["add", "-f", ".agent-home"]);
        // A Merger that commits the merge itself leaves no MERGE_HEAD behind.
        git(&["commit", "--no-edit"]);
        assert!(git(&["ls-tree", "-r", "--name-only", "HEAD"]).contains(".agent-home"));
        assert!(crate::workspace::git(&repo, &["rev-parse", "--verify", "-q", "MERGE_HEAD"]).is_err());

        super::finish_merge(&repo, &incoming, &[".agent-home".to_string()]).unwrap();

        let tree = git(&["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(
            !tree.contains(".agent-home"),
            "amended commit carried a managed scope: {tree}"
        );
        assert!(repo.join(".agent-home/AppData/config.json").is_file());
        let parents = git(&["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert_eq!(
            parents.split_whitespace().count(),
            3,
            "amended merge must keep both parents: {parents}"
        );
    }
}
