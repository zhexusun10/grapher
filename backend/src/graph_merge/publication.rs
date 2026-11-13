//! Git is an internal composition channel. Publication delivers files only:
//! never import an object, move a ref, or replace the user's Git index.
mod atomic_files;
mod repair;
pub(crate) use repair::repair_legacy_file;

use super::compose_graph_scoped;
use crate::workspace::{self, git, repository_git};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
struct Prepared {
    source_head: String,
    input: String,
    result: String,
}

/// A separate namespace prevents a new worker from resuming an older journal
/// whose delivery policy installed a commit into the user's repository.
pub fn publication_workspace(repository: &Path, heads: &[String]) -> Result<PathBuf, String> {
    let mut sorted = heads.to_vec();
    sorted.sort();
    sorted.dedup();
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    sorted.hash(&mut hash);
    let result = hash.finish();
    workspace::shadow_repo_dir(repository)?.hash(&mut hash);
    let owner = uuid::Uuid::from_u128(((hash.finish() as u128) << 64) | result as u128);
    Ok(workspace::workspaces_parent(&workspace::data_root())
        .join(".grapher-worktrees")
        .join(owner.to_string())
        .join(format!("publication-files-{result:016x}")))
}

fn validate_private_paths(repository: &Path, path: &Path) -> Result<(), String> {
    let root = path
        .parent()
        .and_then(Path::parent)
        .ok_or("Invalid publication workspace layout")?;
    if !path.is_absolute()
        || !root
            .file_name()
            .is_some_and(|name| name == ".grapher-worktrees" || name == ".grapher-workspaces")
    {
        return Err("Publication requires an isolated Graph workspace".into());
    }
    let mut ancestor = root;
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor
                    .parent()
                    .ok_or("Publication cache has no existing ancestor")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let candidate = ancestor
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join(root.strip_prefix(ancestor).map_err(|e| e.to_string())?);
    let source = repository.canonicalize().map_err(|e| e.to_string())?;
    if workspace::scope_contains(&candidate, &source)
        || workspace::scope_contains(&source, &candidate)
    {
        return Err("Publication workspace must not overlap the source directory".into());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    crate::path_safety::real_child_path(root, path, false)?;
    crate::path_safety::real_child_path(root, &path.with_extension("publication"), false)?;
    Ok(())
}

fn save_once(path: &Path, value: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Err(format!(
            "Publication record already exists: {}",
            path.display()
        ));
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(value)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn source_branch(repository: &Path) -> Result<String, String> {
    match git(repository, &["symbolic-ref", "-q", "HEAD"]) {
        Ok(branch) => Ok(branch),
        Err(_) => {
            git(repository, &["rev-parse", "--verify", "HEAD"])?;
            Ok("HEAD".into())
        }
    }
}

fn source_index(repository: &Path) -> Result<PathBuf, String> {
    Ok(PathBuf::from(git(
        repository,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )?))
}

fn original_index(journal: &Path) -> Result<Option<Vec<u8>>, String> {
    if journal.join("index-missing").is_file() {
        return Ok(None);
    }
    read_optional(&journal.join("original-index"))?
        .map(Some)
        .ok_or_else(|| "Publication source index evidence is missing".into())
}

fn verify_source(repository: &Path, journal: &Path, prepared: &Prepared) -> Result<(), String> {
    let branch = fs::read_to_string(journal.join("source-branch")).map_err(|e| e.to_string())?;
    if source_branch(repository)? != branch {
        return Err("Source branch changed during publication; retry before checkout, or restore the captured branch to finish an interrupted checkout".into());
    }
    if git(repository, &["rev-parse", "HEAD"])? != prepared.source_head {
        return Err("Source HEAD changed during publication; retry before checkout or inspect the retained recovery state".into());
    }
    if read_optional(&source_index(repository)?)? != original_index(journal)? {
        return Err("Source index changed during publication; refusing to overwrite or silently absorb staged work".into());
    }
    if git(repository, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok() {
        return Err(
            "An unrelated source merge is in progress; finish it before publication".into(),
        );
    }
    Ok(())
}

fn installed(journal: &Path, result: &str) -> Result<bool, String> {
    match read_optional(&journal.join("installed"))? {
        Some(record) if record == result.as_bytes() => Ok(true),
        Some(_) => Err("Publication installation record does not match the prepared result".into()),
        None => Ok(false),
    }
}

fn tree(repository: &Path, commit: &str) -> Result<String, String> {
    repository_git(repository, &["rev-parse", &format!("{commit}^{{tree}}")])
}

/// An in-flight result is not yet in Runtime state, so cleanup of another Run
/// cannot discover it from protected heads. A Run-owned ref keeps it reachable
/// across concurrent GC and process restarts until delivery is recorded.
fn publication_pin(path: &Path, head: &str) -> Result<String, String> {
    let parent = path.parent().ok_or("Invalid publication workspace")?;
    let owner = parent
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let owner = uuid::Uuid::parse_str(owner).unwrap_or_else(|_| {
        // Nonstandard callers can still use an isolated custom workspace. Its
        // deterministic owner is released on successful delivery as usual.
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        parent.hash(&mut hash);
        uuid::Uuid::from_u128(hash.finish() as u128)
    });
    Ok(format!("refs/grapher/runs/{owner}/publications/{head}"))
}

fn release_publication_pin(repository: &Path, pin: &str) -> Result<(), String> {
    repository_git(repository, &["update-ref", "-d", pin])?;
    Ok(())
}

fn record_delivery(
    repository: &Path,
    prepared: &Prepared,
    standard: bool,
    pin: &str,
) -> Result<(), String> {
    let index_lock = workspace::host_index_lock(repository)?;
    let _index_guard = index_lock.lock().map_err(|e| e.to_string())?;
    let lock = workspace::host_ref_lock(repository)?;
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    if let Ok(latest) = repository_git(
        repository,
        &["rev-parse", "--verify", "refs/grapher/published/result"],
    ) {
        if latest == prepared.result {
            if repository_git(repository, &["rev-parse", "HEAD"])? == prepared.result {
                repository_git(repository, &["read-tree", &prepared.result])?;
            }
            return release_publication_pin(repository, pin);
        }
        if repository_git(
            repository,
            &["merge-base", "--is-ancestor", &prepared.result, &latest],
        )
        .is_ok()
        {
            return release_publication_pin(repository, pin);
        }
    }
    // source is the unchanged user HEAD, not the internal result. A later
    // snapshot can bridge delivered ancestry even though user HEAD never moved.
    let source = if standard {
        &prepared.source_head
    } else {
        &prepared.input
    };
    let refs = format!("start\nupdate refs/grapher/published/source {source}\nupdate refs/grapher/published/composed {0}\nupdate refs/grapher/published/result {0}\nupdate HEAD {0}\nprepare\ncommit\n", prepared.result);
    let shadow = workspace::shadow_repo_dir(repository)?;
    workspace::git_bytes(
        repository,
        &[
            "--git-dir",
            shadow.to_str().ok_or("Invalid internal repository")?,
            "--work-tree",
            repository.to_str().ok_or("Invalid source path")?,
            "update-ref",
            "--stdin",
        ],
        None,
        Some(refs.as_bytes()),
    )?;
    repository_git(repository, &["read-tree", &prepared.result])?;
    release_publication_pin(repository, pin)
}

pub(super) fn publish(
    repository: &Path,
    heads: &[String],
    exclusions: &[String],
    target: Option<&Path>,
    mut resolve: impl FnMut(&Path) -> Result<(), String>,
) -> Result<String, String> {
    workspace::validate_binding(repository)?;
    let default_path = publication_workspace(repository, heads)?;
    let path = target.unwrap_or(&default_path).to_path_buf();
    validate_private_paths(repository, &path)?;
    let root = path.with_extension("publication");
    let standard = workspace::is_standard_git(repository);
    let journal = select_attempt(repository, &root, standard, exclusions)?;
    crate::path_safety::real_child_path(&root, &journal, false)?;
    let prepared_path = journal.join("prepared.json");
    if prepared_path.exists() {
        let prepared: Prepared =
            serde_json::from_slice(&fs::read(prepared_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        return deliver(repository, &path, &journal, &prepared, standard, exclusions);
    }
    fs::create_dir_all(&journal).map_err(|e| e.to_string())?;
    let input_path = journal.join("input.json");
    let (source_head, input): (String, String) = if input_path.exists() {
        serde_json::from_slice(&fs::read(&input_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        let branch = if standard {
            Some(source_branch(repository)?)
        } else {
            None
        };
        let source_head = if standard {
            git(repository, &["rev-parse", "HEAD"])?
        } else {
            String::new()
        };
        let index = if standard {
            read_optional(&source_index(repository)?)?
        } else {
            None
        };
        let input = workspace::snapshot_repository_scoped(repository, exclusions)?;
        if let Some(branch) = branch {
            if source_branch(repository)? != branch {
                return Err(
                    "Source branch changed while capturing publication; retry publication".into(),
                );
            }
            if git(repository, &["rev-parse", "HEAD"])? != source_head {
                return Err(
                    "Source HEAD changed while capturing publication; retry publication".into(),
                );
            }
            if read_optional(&source_index(repository)?)? != index {
                return Err(
                    "Source index changed while capturing publication; retry publication".into(),
                );
            }
            if let Some(bytes) = index {
                save_once(&journal.join("original-index"), &bytes)?;
            } else {
                save_once(&journal.join("index-missing"), b"absent\n")?;
            }
            save_once(&journal.join("source-branch"), branch.as_bytes())?;
        }
        save_once(
            &input_path,
            &serde_json::to_vec(&(source_head.clone(), input.clone()))
                .map_err(|e| e.to_string())?,
        )?;
        (source_head, input)
    };
    // Only a workspace created by this attempt is guaranteed to hold exactly
    // the collected base. A pre-existing directory (even one without private
    // Git yet) can still carry unrecorded files, so it stages as usual.
    let fresh = !path.exists() && !workspace::has_private_git(&path);
    let mut inputs = heads.to_vec();
    // Earlier inputs remain owned MERGE_HEAD candidates across rebaselines.
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
            .is_none()
        {
            continue;
        }
        crate::path_safety::real_child_path(&root, &entry.path(), false)?;
        if let Some(bytes) = read_optional(&entry.path().join("input.json"))? {
            let (_, owned): (String, String) =
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if !inputs.contains(&owned) {
                inputs.push(owned);
            }
        }
    }
    if !inputs.contains(&input) {
        inputs.push(input.clone());
    }
    // A clean composition needs no workspace at all: the merge is computed from
    // the recorded trees and only the composed project view is recorded. A
    // conflict or project state needing physical verification falls back to the
    // materialized path below, which also owns Merger repair.
    let virtual_result = if fresh {
        compose_virtual_publication(repository, &path, &input, &inputs, exclusions)?
    } else {
        None
    };
    let result = match virtual_result {
        Some(result) => {
            for head in heads {
                repository_git(repository, &["merge-base", "--is-ancestor", head, &result])?;
            }
            result
        }
        None => {
            if !workspace::has_private_git(&path) {
                // Composition prepares and seals the composed project view once
                // below; preparing it here first would repeat the evidence pass.
                workspace::prepare_composition(repository, &path, &input, &[])?;
            }
            let result =
                compose_graph_scoped(&path, repository, &inputs, exclusions, fresh, || {
                    resolve(&path)
                })?;
            for head in heads {
                git(&path, &["merge-base", "--is-ancestor", head, &result])?;
            }
            let metadata = workspace::private_git_dir(&path);
            let url = workspace::git_file_url(metadata.as_deref().unwrap_or(&path))?;
            let lock = workspace::host_ref_lock(repository)?;
            let _guard = lock.lock().map_err(|e| e.to_string())?;
            repository_git(
                repository,
                &[
                    "fetch",
                    "-q",
                    "--no-tags",
                    "--no-write-fetch-head",
                    "--no-auto-gc",
                    &url,
                    &format!("+{result}:{}", publication_pin(&path, &result)?),
                ],
            )?;
            repository_git(
                repository,
                &[
                    "update-ref",
                    &format!("refs/grapher/heads/{result}"),
                    &result,
                ],
            )?;
            result
        }
    };
    let prepared = Prepared {
        source_head,
        input,
        result,
    };
    save_once(
        &prepared_path,
        &serde_json::to_vec(&prepared).map_err(|e| e.to_string())?,
    )?;
    deliver(repository, &path, &journal, &prepared, standard, exclusions)
}

/// Directory that holds the composed project view of a workspace-free
/// publication. It stays a sibling of the composition workspace so it remains a
/// managed slot (private metadata and cleanup ownership), but it never receives
/// project files.
fn composition_view_path(workspace: &Path) -> Result<PathBuf, String> {
    let name = workspace
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid publication workspace")?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut hash);
    Ok(workspace.with_file_name(format!("publication-view-{:016x}", hash.finish())))
}

/// Compose and seal a publication that needs no workspace. Returns `None` when
/// the composition must be materialized after all.
fn compose_virtual_publication(
    repository: &Path,
    workspace: &Path,
    input: &str,
    parents: &[String],
    exclusions: &[String],
) -> Result<Option<String>, String> {
    let head = {
        // Merge-tree and commit-tree create unreachable objects. Keep cleanup's
        // ref lock throughout composition, not just while pinning the final
        // commit, so gc --prune=now cannot remove an intermediate merge.
        let lock = workspace::host_ref_lock(repository)?;
        let _guard = lock.lock().map_err(|error| error.to_string())?;
        let Some(head) = super::compose_graph_virtual(repository, input, parents)? else {
            return Ok(None);
        };
        repository_git(
            repository,
            &["update-ref", &publication_pin(workspace, &head)?, &head],
        )?;
        repository_git(
            repository,
            &["update-ref", &format!("refs/grapher/heads/{head}"), &head],
        )?;
        head
    };
    if !crate::workspace_view::has_record(repository, input) {
        // Host-only fixture checkouts record no project view.
        return Ok(Some(head));
    }
    let view = composition_view_path(workspace)?;
    validate_private_paths(repository, &view)?;
    fs::create_dir_all(&view).map_err(|e| e.to_string())?;
    let base = crate::workspace_view::composition_base(repository, input, parents)?;
    match crate::workspace_view::seal_composed_view(
        repository, &view, &base, parents, exclusions, &head,
    )? {
        Some(_) => Ok(Some(head)),
        None => {
            let lock = workspace::host_ref_lock(repository)?;
            let _guard = lock.lock().map_err(|error| error.to_string())?;
            release_publication_pin(repository, &publication_pin(workspace, &head)?)?;
            Ok(None)
        }
    }
}

fn select_attempt(
    repository: &Path,
    root: &Path,
    standard: bool,
    exclusions: &[String],
) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let latest = fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    let current = root.join(format!("{latest:08}"));
    crate::path_safety::real_child_path(root, &current, false)?;
    let next = || {
        latest
            .checked_add(1)
            .map(|id| root.join(format!("{id:08}")))
            .ok_or_else(|| "Too many publication attempts".to_string())
    };
    if !current.join("input.json").exists() {
        return if current.join("original-index").exists()
            || current.join("source-branch").exists()
            || current.join("index-missing").exists()
        {
            next()
        } else {
            Ok(current)
        };
    }
    if let Some(bytes) = read_optional(&current.join("prepared.json"))? {
        let prepared: Prepared = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if installed(&current, &prepared.result)? {
            return Ok(current);
        }
    }
    if current.join("applying").exists() {
        return Ok(current);
    }
    let (head, input): (String, String) =
        serde_json::from_slice(&fs::read(current.join("input.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let changed_git = if standard {
        source_branch(repository)?
            != fs::read_to_string(current.join("source-branch")).map_err(|e| e.to_string())?
            || git(repository, &["rev-parse", "HEAD"])? != head
            || read_optional(&source_index(repository)?)? != original_index(&current)?
    } else {
        false
    };
    let live = workspace::live_tree_scoped(repository, exclusions)?;
    if changed_git || live != tree(repository, &input)? {
        next()
    } else {
        Ok(current)
    }
}

fn private_index_git(repository: &Path, index: &Path, args: &[&str]) -> Result<String, String> {
    private_index_git_input(repository, index, args, None)
}

fn private_index_git_input(repository: &Path, index: &Path, args: &[&str], input: Option<&[u8]>) -> Result<String, String> {
    // Do not run source clean/smudge/EOL filters while delivering recorded
    // physical bytes, and do not mutate the shared snapshot repo's attributes.
    let metadata = index
        .parent()
        .ok_or("Missing checkout journal")?
        .join("raw-checkout.git");
    let metadata_text = metadata.to_str().ok_or("Invalid checkout Git path")?;
    let worktree = repository.to_str().ok_or("Invalid project path")?;
    if !metadata.join("HEAD").is_file() {
        fs::create_dir_all(&metadata).map_err(|e| e.to_string())?;
        let format = repository_git(repository, &["rev-parse", "--show-object-format=storage"])?;
        git(
            repository,
            &[
                "--git-dir",
                metadata_text,
                "--work-tree",
                worktree,
                "init",
                "-q",
                &format!("--object-format={format}"),
            ],
        )?;
        let objects = repository_git(
            repository,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "objects",
            ],
        )?;
        let objects = crate::native::host_path(Path::new(&objects))
            .to_string_lossy()
            .replace('\\', "/");
        fs::write(
            metadata.join("objects/info/alternates"),
            format!("{objects}\n"),
        )
        .map_err(|e| e.to_string())?;
        workspace::raw_checkout_attributes(&metadata)?;
    }
    let mut command = vec!["--git-dir", metadata_text, "--work-tree", worktree];
    command.extend_from_slice(args);
    let bytes = workspace::git_bytes(repository, &command, Some(index), input)?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn diff_paths(
    repository: &Path,
    before: &str,
    after: &str,
) -> Result<std::collections::BTreeSet<String>, String> {
    Ok(repository_git(
        repository,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "-z",
            before,
            after,
        ],
    )?
    .split('\0')
    .filter(|path| !path.is_empty())
    .map(str::to_owned)
    .collect())
}

fn valid_partial_checkout(
    repository: &Path,
    input: &str,
    result: &str,
    live: &str,
) -> Result<bool, String> {
    // A changed path must match exactly either its old or final tree entry.
    // Anything different from both is unrecorded user work, not host residue.
    let from_input = diff_paths(repository, input, live)?;
    let from_result = diff_paths(repository, result, live)?;
    Ok(from_input.is_disjoint(&from_result))
}

fn with_source_lease<T>(
    repository: &Path,
    journal: &Path,
    standard: bool,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let lock_path = if standard {
        source_index(repository)?.with_extension("lock")
    } else {
        workspace::shadow_repo_dir(repository)?.join("publication.lock")
    };
    let marker = format!("Grapher publication {}\n", journal.display());
    // Only this interrupted attempt's marker may be reclaimed.
    release_owned_lock(&lock_path, marker.as_bytes())?;
    let mut lease = OpenOptions::new().write(true).create_new(true).open(&lock_path)
        .map_err(|e| format!("Cannot acquire source Git index lease: {e}"))?;
    lease.write_all(marker.as_bytes()).and_then(|_| lease.sync_all()).map_err(|e| e.to_string())?;
    drop(lease);
    let outcome = operation();
    let released = release_owned_lock(&lock_path, marker.as_bytes());
    match outcome {
        Ok(result) => { released?; Ok(result) }
        Err(error) => Err(error),
    }
}

fn deliver(
    repository: &Path,
    path: &Path,
    journal: &Path,
    prepared: &Prepared,
    standard: bool,
    exclusions: &[String],
) -> Result<String, String> {
    let lock_path = if standard {
        source_index(repository)?.with_extension("lock")
    } else {
        workspace::shadow_repo_dir(repository)?.join("publication.lock")
    };
    let marker = format!("Grapher publication {}\n", journal.display());
    let pin = publication_pin(path, &prepared.result)?;
    if installed(journal, &prepared.result)? {
        release_owned_lock(&lock_path, marker.as_bytes())?;
        record_delivery(repository, prepared, standard, &pin)?;
        return Ok(prepared.result.clone());
    }
    if standard {
        verify_source(repository, journal, prepared)?;
    }
    with_source_lease(repository, journal, standard, || {
        if standard {
            verify_source(repository, journal, prepared)?;
        }
        atomic_files::cleanup_temporaries(repository, journal, &prepared.input, &prepared.result)?;
        let live = workspace::live_tree_scoped(repository, exclusions)?;
        let live_tree = live.clone();
        let input_tree = tree(repository, &prepared.input)?;
        let final_tree = tree(repository, &prepared.result)?;
        if live_tree != input_tree
            && !(journal.join("applying").exists()
                && valid_partial_checkout(repository, &prepared.input, &prepared.result, &live)?) {
            let from_input = diff_paths(repository, &prepared.input, &live)?;
            let from_result = diff_paths(repository, &prepared.result, &live)?;
            let paths = from_input.intersection(&from_result).take(8).cloned().collect::<Vec<_>>().join(", ");
            return Err(format!("Source files changed during publication; private results are preserved. These paths match neither the original nor the result: {paths}. This may be an interrupted legacy file write, not a user edit. Preserve the current files and reconcile them with the retained publication before retrying."));
        }
        if live_tree != final_tree {
            atomic_files::install(repository, journal, &prepared.input, &prepared.result)?;
            if workspace::live_tree_scoped(repository, exclusions)? != final_tree {
                return Err("Source files changed while applying publication; retained checkout requires explicit recovery".into());
            }
        }
        if standard {
            verify_source(repository, journal, prepared)?;
        }
        save_once(&journal.join("installed"), prepared.result.as_bytes())?;
        record_delivery(repository, prepared, standard, &pin)?;
        Ok(prepared.result.clone())
    })
}

fn release_owned_lock(path: &Path, marker: &[u8]) -> Result<(), String> {
    if read_optional(path)?.as_deref() == Some(marker) {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_rejects_a_private_workspace_redirected_to_source_before_composition() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("base.txt"), "base").unwrap();
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "-q", "-m", "base"]).unwrap();
        let source_head = git(&source, &["rev-parse", "HEAD"]).unwrap();
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = temp.path().join("node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("result.txt"), "node result").unwrap();
        let head = workspace::snapshot_node(&node, &source, "node").unwrap();
        let path = temp
            .path()
            .join(".grapher-worktrees")
            .join(uuid::Uuid::new_v4().to_string())
            .join("publication");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        crate::path_safety::directory_link(&source, &path);
        assert!(publish(&source, &[head], &[], Some(&path), |_| panic!()).is_err());
        assert!(!source.join("result.txt").exists());
        assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), source_head);
        crate::path_safety::remove_directory_link(&path);
    }

    #[test]
    fn interrupted_publication_survives_another_run_pruning_the_shadow() {
        interrupted_publication_survives_pruning(false);
    }

    #[test]
    fn interrupted_materialized_publication_survives_another_run_pruning_the_shadow() {
        interrupted_publication_survives_pruning(true);
    }

    fn interrupted_publication_survives_pruning(materialized: bool) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("base.txt"), "base").unwrap();
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "-qm", "base"]).unwrap();
        let original_head = git(&source, &["rev-parse", "HEAD"]).unwrap();
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = temp.path().join("node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("result.txt"), "result").unwrap();
        let head = workspace::snapshot_node(&node, &source, "node").unwrap();
        let run_id = uuid::Uuid::new_v4().to_string();
        let path = temp
            .path()
            .join(".grapher-worktrees")
            .join(&run_id)
            .join("publication");
        if materialized {
            fs::create_dir_all(&path).unwrap();
        }
        let lock_file = source_index(&source).unwrap().with_extension("lock");
        fs::write(&lock_file, "foreign lease").unwrap();
        assert!(publish(
            &source,
            std::slice::from_ref(&head),
            &[],
            Some(&path),
            |_| panic!("no conflict")
        )
        .is_err());
        let journal = path.with_extension("publication").join("00000000");
        let prepared: Prepared =
            serde_json::from_slice(&fs::read(journal.join("prepared.json")).unwrap()).unwrap();
        assert!(!journal.join("installed").exists());
        assert_eq!(workspace::has_private_git(&path), materialized);

        // Deleting another Run also prunes unreferenced generic head pins and
        // runs gc --prune=now. The prepared result is not yet in Runtime state.
        let other = uuid::Uuid::new_v4().to_string();
        repository_git(
            &source,
            &[
                "update-ref",
                &format!("refs/grapher/runs/{other}/test"),
                &base,
            ],
        )
        .unwrap();
        let shadow = workspace::shadow_repo_dir(&source).unwrap();
        {
            let lock = workspace::host_ref_lock(&source).unwrap();
            let _guard = lock.lock().unwrap();
            workspace::prune_shadow_run_refs(&shadow, &other, &Default::default(), true).unwrap();
        }
        repository_git(
            &source,
            &["cat-file", "-e", &format!("{}^{{commit}}", prepared.result)],
        )
        .unwrap();
        fs::remove_file(lock_file).unwrap();
        let delivered = publish(&source, &[head], &[], Some(&path), |_| {
            panic!("no conflict")
        })
        .unwrap();
        assert_eq!(delivered, prepared.result);
        assert_eq!(fs::read(source.join("result.txt")).unwrap(), b"result");
        assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), original_head);
        assert!(repository_git(
            &source,
            &[
                "for-each-ref",
                "--format=%(refname)",
                &format!("refs/grapher/runs/{run_id}/publications/")
            ]
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn publication_preserves_staged_paths_excluded_from_collection() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("base.txt"), "base").unwrap();
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "-q", "-m", "base"]).unwrap();
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = temp.path().join("node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("result.txt"), "result").unwrap();
        let head = workspace::snapshot_node(&node, &source, "node").unwrap();
        fs::create_dir(source.join("managed")).unwrap();
        fs::write(source.join("managed/user.txt"), "user-owned staged content").unwrap();
        git(&source, &["add", "managed/user.txt"]).unwrap();
        let index = source_index(&source).unwrap();
        let before = fs::read(&index).unwrap();
        publish(&source, &[head], &["managed".into()], None, |_| panic!()).unwrap();
        assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), base);
        assert_eq!(fs::read(index).unwrap(), before);
        assert!(source.join("result.txt").exists());
        assert!(git(&source, &["diff", "--cached", "--name-only"])
            .unwrap()
            .contains("managed/user.txt"));
    }
}
