//! Compose actual project staging separately from graph Git's forced index.
//! Cache-stat bytes are not staging changes; flags and staged blobs are.
use crate::workspace;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

type Index = BTreeMap<String, Item>;
type Delta = BTreeMap<String, Option<Item>>;
#[derive(Clone, Debug, PartialEq, Eq)]
struct Item {
    mode: String,
    oid: String,
    flags: u32,
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = vec![
        "--git-dir",
        root.to_str().ok_or("Invalid project Git path")?,
        "--work-tree",
        root.to_str().ok_or("Invalid project Git path")?,
    ];
    command.extend_from_slice(args);
    workspace::project_git(root, &command)
}
fn index(root: &Path) -> Result<Index, String> {
    let output = git(root, &["ls-files", "--stage", "--debug", "-z"])?;
    let mut rest = output.as_str();
    let mut entries = Index::new();
    // An input may still carry a conflict in its index (its graph merge was
    // resolved, but the project view's index was captured unmerged). Compose its
    // "ours" side (stage 2) rather than refusing the whole composition.
    let mut unmerged: BTreeMap<String, (u8, Item)> = BTreeMap::new();
    while !rest.is_empty() {
        let (header, after) = rest
            .split_once('\0')
            .ok_or("Incomplete native index entry")?;
        let (fields, name) = header
            .split_once('\t')
            .ok_or("Invalid native index entry")?;
        let fields: Vec<_> = fields.split_whitespace().collect();
        if fields.len() != 3 {
            return Err("Invalid native index entry".into());
        }
        rest = after;
        let mut flags = None;
        // Git's --debug record has five metadata lines after each NUL path.
        for _ in 0..5 {
            let (line, after) = rest
                .split_once('\n')
                .ok_or("Incomplete native index flags")?;
            if let Some((_, value)) = line.split_once("flags: ") {
                flags = Some(
                    u32::from_str_radix(value.trim(), 16).map_err(|e| e.to_string())? & 0x6000_8000,
                );
            }
            rest = after;
        }
        let item = Item {
            mode: fields[0].into(),
            oid: fields[1].into(),
            flags: flags.ok_or("Missing native index flags")?,
        };
        match fields[2] {
            "0" => {
                entries.insert(name.into(), item);
            }
            stage => {
                let rank: u8 = match stage {
                    "2" => 2,
                    "3" => 1,
                    _ => 0,
                };
                if unmerged
                    .get(name)
                    .is_none_or(|(current, _)| rank > *current)
                {
                    unmerged.insert(name.into(), (rank, item));
                }
            }
        }
    }
    for (name, (_, item)) in unmerged {
        entries.insert(name, item);
    }
    Ok(entries)
}
fn tree(root: &Path) -> Result<Index, String> {
    if git(root, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return Ok(Index::new());
    }
    let mut entries = Index::new();
    for item in git(root, &["ls-tree", "-r", "-z", "HEAD"])?
        .split('\0')
        .filter(|s| !s.is_empty())
    {
        let (fields, name) = item.split_once('\t').ok_or("Invalid project HEAD tree")?;
        let fields: Vec<_> = fields.split_whitespace().collect();
        if fields.len() != 3 {
            return Err("Invalid project HEAD entry".into());
        }
        entries.insert(
            name.into(),
            Item {
                mode: fields[0].into(),
                oid: fields[2].into(),
                flags: 0,
            },
        );
    }
    Ok(entries)
}
fn delta(root: &Path) -> Result<Delta, String> {
    let index = index(root)?;
    let head = tree(root)?;
    let names: BTreeSet<_> = index.keys().chain(head.keys()).cloned().collect();
    Ok(names
        .into_iter()
        .filter_map(|name| {
            (index.get(&name) != head.get(&name)).then(|| (name.clone(), index.get(&name).cloned()))
        })
        .collect())
}

/// `diff-index` only compares content and modes, so an index whose entries
/// differ solely by `assume-unchanged`/`skip-worktree` flags looks clean while
/// `compose` must still carry those flags. `ls-files -v` tags every ordinary
/// cached entry with `H`; any other tag (lowercase assume-unchanged, `S`
/// skip-worktree, unmerged, ...) needs the full composition.
fn index_has_flag_delta(root: &Path, workspace_root: bool) -> Result<bool, String> {
    let args = ["ls-files", "-v", "-z"];
    let output = if workspace_root {
        workspace::project_git(root, &args)?
    } else {
        git(root, &args)?
    };
    Ok(output
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .any(|entry| entry.as_bytes().first() != Some(&b'H')))
}

/// No record has a staged delta and the workspace index already follows its own
/// project HEAD, so composing native indexes cannot change any staged entry.
/// This is the ordinary publication case: reading every index twice per record
/// only to apply zero changes is the expensive part of preparation.
fn nothing_staged(
    workspace: &Path,
    base: &Path,
    inputs: &[PathBuf],
    selected: &Path,
) -> Result<bool, String> {
    // An index that matches its own HEAD tree has no staged work. A missing
    // repository or an unborn HEAD is not proof, so it falls through to the full
    // composition instead.
    let args = ["diff-index", "--cached", "--quiet", "HEAD", "--"];
    for record in std::iter::once(base)
        .chain(inputs.iter().map(PathBuf::as_path))
        .chain(std::iter::once(selected))
    {
        if git(record, &args).is_err() {
            return Ok(false);
        }
        // A failed flag probe is not proof of a clean index. Fall back to the
        // full composition instead of aborting publication early.
        match index_has_flag_delta(record, false) {
            Ok(false) => {}
            Ok(true) | Err(_) => return Ok(false),
        }
    }
    // A record addresses its own Git database by directory; the workspace keeps
    // its project Git view in `.git` or in private metadata.
    if workspace::project_git(workspace, &args).is_err() {
        return Ok(false);
    }
    Ok(matches!(index_has_flag_delta(workspace, true), Ok(false)))
}

/// Each record is an immutable project Git database, never graph Git. Merge
/// staged deltas against their own real HEADs, including staged deletions and
/// assume-unchanged/skip-worktree/intent-to-add flags.
pub(crate) fn compose(
    path: &Path,
    base: &Path,
    inputs: &[PathBuf],
    selected: &Path,
) -> Result<(), String> {
    if !path.join(".git").exists() {
        return Ok(());
    }
    if nothing_staged(path, base, inputs, selected)? {
        return Ok(());
    }
    let baseline = delta(base)?;
    let inputs = inputs
        .iter()
        .map(|root| delta(root).map(|delta| (root, delta)))
        .collect::<Result<Vec<_>, _>>()?;
    let names: BTreeSet<_> = baseline
        .keys()
        .chain(inputs.iter().flat_map(|(_, delta)| delta.keys()))
        .cloned()
        .collect();
    let mut desired = Delta::new();
    let mut origins = BTreeMap::new();
    for name in names {
        let original = baseline.get(&name).cloned();
        let mut changes = Vec::new();
        for (root, delta) in &inputs {
            let candidate = delta.get(&name).cloned();
            if candidate != original && !changes.iter().any(|(_, value)| value == &candidate) {
                changes.push((root.as_path(), candidate));
            }
        }
        if changes.len() > 1 {
            return Err(format!("Project staging composition conflict at {name}; no input's staged work is discarded"));
        }
        let (origin, value) = changes.pop().unwrap_or((base, original));
        if let Some(value) = value {
            desired.insert(name.clone(), value);
            origins.insert(name, origin);
        }
    }
    let metadata = PathBuf::from(workspace::project_git(
        path,
        &["rev-parse", "--absolute-git-dir"],
    )?);
    let index_path = PathBuf::from(workspace::project_git(
        path,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )?);
    // Preserve the selected input's native index extensions and cache flags.
    let source_index = selected.join("index");
    if source_index.is_file() {
        fs::copy(source_index, &index_path).map_err(|e| e.to_string())?;
    } else if index_path.exists() {
        fs::remove_file(&index_path).map_err(|e| e.to_string())?;
    }
    let selected_head = git(selected, &["rev-parse", "--verify", "HEAD"]).ok();
    let current_head = workspace::project_git(path, &["rev-parse", "--verify", "HEAD"]).ok();
    if selected_head != current_head {
        match (selected_head.as_deref(), current_head.as_deref()) {
            (Some(old), Some(new)) => {
                workspace::project_git(path, &["read-tree", "-m", old, new])?;
            }
            (None, Some(_)) => {
                return Err(
                    "Cannot discard an unborn staged index while composing committed task history"
                        .into(),
                )
            }
            _ => return Err("Incompatible project HEAD/index inputs".into()),
        }
    }
    let head = tree(&metadata)?;
    let current = index(&metadata)?;
    let mut wanted = head.clone();
    for (name, value) in &desired {
        match value {
            Some(value) => {
                wanted.insert(name.clone(), value.clone());
            }
            None => {
                wanted.remove(name);
            }
        }
    }
    let names: BTreeSet<_> = current.keys().chain(wanted.keys()).cloned().collect();
    let format = workspace::project_git(path, &["rev-parse", "--show-object-format=storage"])?;
    let zero = "0".repeat(if format == "sha256" { 64 } else { 40 });
    let mut updates = Vec::new();
    let mut changed = Vec::new();
    for name in names {
        if current.get(&name) == wanted.get(&name) {
            continue;
        }
        updates.extend_from_slice(format!("0 {zero}\t{name}\0").as_bytes());
        if let Some(item) = wanted.get(&name) {
            if item.mode != "160000"
                && workspace::project_git(path, &["cat-file", "-e", &item.oid]).is_err()
            {
                let origin = origins.get(&name).copied().unwrap_or(selected);
                let bytes = workspace::project_git_bytes(
                    origin,
                    &[
                        "--git-dir",
                        origin.to_str().ok_or("Invalid index origin")?,
                        "--work-tree",
                        origin.to_str().ok_or("Invalid index origin")?,
                        "cat-file",
                        "blob",
                        &item.oid,
                    ],
                    None,
                )?;
                workspace::project_git_bytes(
                    path,
                    &["hash-object", "-w", "--no-filters", "--stdin"],
                    Some(&bytes),
                )?;
            }
            updates.extend_from_slice(format!("{} {}\t{name}\0", item.mode, item.oid).as_bytes());
        }
        changed.push(name);
    }
    workspace::project_git_bytes(
        path,
        &["update-index", "-z", "--index-info"],
        Some(&updates),
    )?;
    for name in changed {
        if let Some(item) = wanted.get(&name) {
            if item.flags & 0x2000_0000 != 0 {
                workspace::project_git(
                    path,
                    &["add", "-f", "-N", "--", &format!(":(literal){name}")],
                )?;
            }
            workspace::project_git(
                path,
                &[
                    "update-index",
                    if item.flags & 0x8000 != 0 {
                        "--assume-unchanged"
                    } else {
                        "--no-assume-unchanged"
                    },
                    "--",
                    &name,
                ],
            )?;
            workspace::project_git(
                path,
                &[
                    "update-index",
                    if item.flags & 0x4000_0000 != 0 {
                        "--skip-worktree"
                    } else {
                        "--no-skip-worktree"
                    },
                    "--",
                    &name,
                ],
            )?;
        }
    }
    if index(&metadata)? != wanted {
        return Err("Native project index did not preserve the composed staging state".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository(temp: &tempfile::TempDir) -> PathBuf {
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        workspace::git(&root, &["init", "-q"]).unwrap();
        workspace::project_git(&root, &["config", "user.name", "Index Test"]).unwrap();
        workspace::project_git(&root, &["config", "user.email", "index@example.invalid"]).unwrap();
        fs::write(root.join("tracked.txt"), "committed\n").unwrap();
        workspace::git(&root, &["add", "tracked.txt"]).unwrap();
        workspace::git(&root, &["commit", "-qm", "base"]).unwrap();
        root
    }

    #[test]
    fn fast_path_rejects_flag_only_index_deltas() {
        let temp = tempfile::tempdir().unwrap();
        let root = repository(&temp);
        let git_dir = root.join(".git");
        assert!(
            nothing_staged(&root, &git_dir, &[], &git_dir).unwrap(),
            "an index that matches its own HEAD has no work to compose"
        );
        workspace::project_git(
            &root,
            &["update-index", "--assume-unchanged", "tracked.txt"],
        )
        .unwrap();
        assert!(
            !nothing_staged(&root, &git_dir, &[], &git_dir).unwrap(),
            "assume-unchanged is a staged flag even when content matches HEAD"
        );
        workspace::project_git(
            &root,
            &["update-index", "--no-assume-unchanged", "tracked.txt"],
        )
        .unwrap();
        workspace::project_git(&root, &["update-index", "--skip-worktree", "tracked.txt"]).unwrap();
        assert!(
            !nothing_staged(&root, &git_dir, &[], &git_dir).unwrap(),
            "skip-worktree is a staged flag even when content matches HEAD"
        );
    }
}
