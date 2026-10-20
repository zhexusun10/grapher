//! Git is an internal composition channel. Publication delivers files only:
//! never import an object, move a ref, or replace the user's Git index.
use super::compose_graph_scoped;
use crate::workspace::{self, git, repository_git};
use serde::{Deserialize, Serialize};
use std::{fs::{self, OpenOptions}, hash::{Hash, Hasher}, io::Write, path::{Path, PathBuf}};

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
    Ok(workspace::workspaces_parent(&workspace::data_root()).join(".grapher-worktrees")
        .join(owner.to_string()).join(format!("publication-files-{result:016x}")))
}

fn validate_private_paths(repository: &Path, path: &Path) -> Result<(), String> {
    let root = path.parent().and_then(Path::parent).ok_or("Invalid publication workspace layout")?;
    if !path.is_absolute() || !root.file_name().is_some_and(|name| name == ".grapher-worktrees" || name == ".grapher-workspaces") {
        return Err("Publication requires an isolated Graph workspace".into());
    }
    let mut ancestor = root;
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor.parent().ok_or("Publication cache has no existing ancestor")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let candidate = ancestor.canonicalize().map_err(|e| e.to_string())?.join(root.strip_prefix(ancestor).map_err(|e| e.to_string())?);
    let source = repository.canonicalize().map_err(|e| e.to_string())?;
    if workspace::scope_contains(&candidate, &source) || workspace::scope_contains(&source, &candidate) {
        return Err("Publication workspace must not overlap the source directory".into());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    crate::path_safety::real_child_path(root, path, false)?;
    crate::path_safety::real_child_path(root, &path.with_extension("publication"), false)?;
    Ok(())
}

fn save_once(path: &Path, value: &[u8]) -> Result<(), String> {
    if path.exists() { return Err(format!("Publication record already exists: {}", path.display())); }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
    file.write_all(value).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
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
    Ok(PathBuf::from(git(repository, &["rev-parse", "--path-format=absolute", "--git-path", "index"])?))
}

fn original_index(journal: &Path) -> Result<Option<Vec<u8>>, String> {
    if journal.join("index-missing").is_file() { return Ok(None); }
    read_optional(&journal.join("original-index"))?.map(Some)
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
        return Err("An unrelated source merge is in progress; finish it before publication".into());
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

fn record_delivery(repository: &Path, prepared: &Prepared, standard: bool) -> Result<(), String> {
    let index_lock = workspace::host_index_lock(repository)?;
    let _index_guard = index_lock.lock().map_err(|e| e.to_string())?;
    let lock = workspace::host_ref_lock(repository)?;
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    if let Ok(latest) = repository_git(repository, &["rev-parse", "--verify", "refs/grapher/published/result"]) {
        if latest == prepared.result {
            if repository_git(repository, &["rev-parse", "HEAD"])? == prepared.result {
                repository_git(repository, &["read-tree", &prepared.result])?;
            }
            return Ok(());
        }
        if repository_git(repository, &["merge-base", "--is-ancestor", &prepared.result, &latest]).is_ok() { return Ok(()); }
    }
    // source is the unchanged user HEAD, not the internal result. A later
    // snapshot can bridge delivered ancestry even though user HEAD never moved.
    let source = if standard { &prepared.source_head } else { &prepared.input };
    let refs = format!("start\nupdate refs/grapher/published/source {source}\nupdate refs/grapher/published/composed {0}\nupdate refs/grapher/published/result {0}\nupdate HEAD {0}\nprepare\ncommit\n", prepared.result);
    let shadow = workspace::shadow_repo_dir(repository)?;
    workspace::git_bytes(repository, &["--git-dir", shadow.to_str().ok_or("Invalid internal repository")?,
        "--work-tree", repository.to_str().ok_or("Invalid source path")?, "update-ref", "--stdin"], None, Some(refs.as_bytes()))?;
    repository_git(repository, &["read-tree", &prepared.result])?;
    Ok(())
}

pub(super) fn publish(repository: &Path, heads: &[String], exclusions: &[String], target: Option<&Path>, mut resolve: impl FnMut(&Path) -> Result<(), String>) -> Result<String, String> {
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
        let prepared: Prepared = serde_json::from_slice(&fs::read(prepared_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        return deliver(repository, &journal, &prepared, standard, exclusions);
    }
    fs::create_dir_all(&journal).map_err(|e| e.to_string())?;
    let input_path = journal.join("input.json");
    let (source_head, input): (String, String) = if input_path.exists() {
        serde_json::from_slice(&fs::read(&input_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?
    } else {
        let branch = if standard { Some(source_branch(repository)?) } else { None };
        let source_head = if standard { git(repository, &["rev-parse", "HEAD"])? } else { String::new() };
        let index = if standard { read_optional(&source_index(repository)?)? } else { None };
        let input = workspace::snapshot_repository_scoped(repository, exclusions)?;
        if let Some(branch) = branch {
            if source_branch(repository)? != branch { return Err("Source branch changed while capturing publication; retry publication".into()); }
            if git(repository, &["rev-parse", "HEAD"])? != source_head { return Err("Source HEAD changed while capturing publication; retry publication".into()); }
            if read_optional(&source_index(repository)?)? != index { return Err("Source index changed while capturing publication; retry publication".into()); }
            if let Some(bytes) = index { save_once(&journal.join("original-index"), &bytes)?; }
            else { save_once(&journal.join("index-missing"), b"absent\n")?; }
            save_once(&journal.join("source-branch"), branch.as_bytes())?;
        }
        save_once(&input_path, &serde_json::to_vec(&(source_head.clone(), input.clone())).map_err(|e| e.to_string())?)?;
        (source_head, input)
    };
    if !workspace::has_private_git(&path) { workspace::prepare(repository, &path, &input, &[])?; }
    let mut inputs = heads.to_vec();
    // Earlier inputs remain owned MERGE_HEAD candidates across rebaselines.
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()).is_none() { continue; }
        crate::path_safety::real_child_path(&root, &entry.path(), false)?;
        if let Some(bytes) = read_optional(&entry.path().join("input.json"))? {
            let (_, owned): (String, String) = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if !inputs.contains(&owned) { inputs.push(owned); }
        }
    }
    if !inputs.contains(&input) { inputs.push(input.clone()); }
    let result = compose_graph_scoped(&path, &inputs, exclusions, || resolve(&path))?;
    for head in heads { git(&path, &["merge-base", "--is-ancestor", head, &result])?; }
    let metadata = workspace::private_git_dir(&path);
    let url = workspace::git_file_url(metadata.as_deref().unwrap_or(&path))?;
    {
        let lock = workspace::host_ref_lock(repository)?;
        let _guard = lock.lock().map_err(|e| e.to_string())?;
        repository_git(repository, &["fetch", "-q", "--no-tags", "--no-write-fetch-head", "--no-auto-gc", &url,
            &format!("+{result}:refs/grapher/heads/{result}")])?;
    }
    let prepared = Prepared { source_head, input, result };
    save_once(&prepared_path, &serde_json::to_vec(&prepared).map_err(|e| e.to_string())?)?;
    deliver(repository, &journal, &prepared, standard, exclusions)
}

fn select_attempt(repository: &Path, root: &Path, standard: bool, exclusions: &[String]) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let latest = fs::read_dir(root).map_err(|e| e.to_string())?.filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok()).max().unwrap_or(0);
    let current = root.join(format!("{latest:08}"));
    crate::path_safety::real_child_path(root, &current, false)?;
    let next = || latest.checked_add(1).map(|id| root.join(format!("{id:08}"))).ok_or_else(|| "Too many publication attempts".to_string());
    if !current.join("input.json").exists() {
        return if current.join("original-index").exists() || current.join("source-branch").exists() || current.join("index-missing").exists() { next() } else { Ok(current) };
    }
    if let Some(bytes) = read_optional(&current.join("prepared.json"))? {
        let prepared: Prepared = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if installed(&current, &prepared.result)? { return Ok(current); }
    }
    if current.join("applying").exists() { return Ok(current); }
    let (head, input): (String, String) = serde_json::from_slice(&fs::read(current.join("input.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let changed_git = if standard {
        source_branch(repository)? != fs::read_to_string(current.join("source-branch")).map_err(|e| e.to_string())?
            || git(repository, &["rev-parse", "HEAD"])? != head
            || read_optional(&source_index(repository)?)? != original_index(&current)?
    } else { false };
    let live = workspace::snapshot_repository_scoped(repository, exclusions)?;
    if changed_git || tree(repository, &live)? != tree(repository, &input)? { next() } else { Ok(current) }
}

fn private_index_git(repository: &Path, index: &Path, args: &[&str]) -> Result<String, String> {
    let shadow = workspace::shadow_repo_dir(repository)?;
    let mut command = vec!["--git-dir", shadow.to_str().ok_or("Invalid internal Git path")?,
        "--work-tree", repository.to_str().ok_or("Invalid project path")?];
    command.extend_from_slice(args);
    let bytes = workspace::git_bytes(repository, &command, Some(index), None)?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn diff_paths(repository: &Path, before: &str, after: &str) -> Result<std::collections::BTreeSet<String>, String> {
    Ok(repository_git(repository, &["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", before, after])?
        .split('\0').filter(|path| !path.is_empty()).map(str::to_owned).collect())
}

fn valid_partial_checkout(repository: &Path, input: &str, result: &str, live: &str) -> Result<bool, String> {
    // A changed path must match exactly either its old or final tree entry.
    // Anything different from both is unrecorded user work, not host residue.
    let from_input = diff_paths(repository, input, live)?;
    let from_result = diff_paths(repository, result, live)?;
    Ok(from_input.is_disjoint(&from_result))
}

fn deliver(repository: &Path, journal: &Path, prepared: &Prepared, standard: bool, exclusions: &[String]) -> Result<String, String> {
    let lock_path = if standard { source_index(repository)?.with_extension("lock") }
        else { workspace::shadow_repo_dir(repository)?.join("publication.lock") };
    let marker = format!("Grapher publication {}\n", journal.display());
    if installed(journal, &prepared.result)? {
        release_owned_lock(&lock_path, marker.as_bytes())?;
        record_delivery(repository, prepared, standard)?;
        return Ok(prepared.result.clone());
    }
    if standard { verify_source(repository, journal, prepared)?; }
    let live = workspace::snapshot_repository_scoped(repository, exclusions)?;
    let live_tree = tree(repository, &live)?;
    let input_tree = tree(repository, &prepared.input)?;
    let final_tree = tree(repository, &prepared.result)?;
    let applying = journal.join("applying");
    if live_tree != input_tree && !(applying.exists() && valid_partial_checkout(repository, &prepared.input, &prepared.result, &live)?) {
        return Err("Source files changed during publication; private results are preserved. Retry before checkout, or reconcile unrecorded edits with the retained recovery state".into());
    }
    // A matching marker belongs to this interrupted attempt. Runtime's data
    // lease and single-driver rule ensure another active worker cannot own it.
    release_owned_lock(&lock_path, marker.as_bytes())?;
    let mut lease = OpenOptions::new().write(true).create_new(true).open(&lock_path)
        .map_err(|e| format!("Cannot acquire source Git index lease: {e}"))?;
    lease.write_all(marker.as_bytes()).and_then(|_| lease.sync_all()).map_err(|e| e.to_string())?;
    drop(lease);
    let outcome = (|| -> Result<String, String> {
        if standard { verify_source(repository, journal, prepared)?; }
        if live_tree != final_tree {
            let next_index = journal.join("checkout-index");
            private_index_git(repository, &next_index, &["read-tree", &live])?;
            if let Err(error) = private_index_git(repository, &next_index, &["update-index", "--refresh"]) {
                let dirty = private_index_git(repository, &next_index, &["diff", "--name-only", "--no-ext-diff", "--no-textconv", "-z"])?;
                if dirty.split('\0').filter(|path| !path.is_empty()).any(|path| !workspace::collection_path_excluded(repository, path, exclusions)) {
                    return Err(error);
                }
            }
            if !applying.exists() { save_once(&applying, b"checkout\n")?; }
            private_index_git(repository, &next_index, &["read-tree", "-m", "-u", &live, &prepared.result])?;
        }
        if standard { verify_source(repository, journal, prepared)?; }
        let checked = workspace::snapshot_repository_scoped(repository, exclusions)?;
        if tree(repository, &checked)? != final_tree {
            return Err("Source files changed while applying publication; retained checkout requires explicit recovery".into());
        }
        if standard { verify_source(repository, journal, prepared)?; }
        save_once(&journal.join("installed"), prepared.result.as_bytes())?;
        record_delivery(repository, prepared, standard)?;
        Ok(prepared.result.clone())
    })();
    let released = release_owned_lock(&lock_path, marker.as_bytes());
    match outcome { Ok(result) => { released?; Ok(result) }, Err(error) => { let _ = released; Err(error) } }
}

fn release_owned_lock(path: &Path, marker: &[u8]) -> Result<(), String> {
    if read_optional(path)?.as_deref() == Some(marker) { fs::remove_file(path).map_err(|e| e.to_string())?; }
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
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = temp.path().join("node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("result.txt"), "node result").unwrap();
        let head = workspace::snapshot_node(&node, &source, "node").unwrap();
        let path = temp.path().join(".grapher-worktrees").join(uuid::Uuid::new_v4().to_string()).join("publication");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        crate::path_safety::directory_link(&source, &path);
        assert!(publish(&source, &[head], &[], Some(&path), |_| panic!()).is_err());
        assert!(!source.join("result.txt").exists());
        assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), base);
        crate::path_safety::remove_directory_link(&path);
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
        assert!(git(&source, &["diff", "--cached", "--name-only"]).unwrap().contains("managed/user.txt"));
    }
}
