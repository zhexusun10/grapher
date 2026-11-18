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

/// Append Git's NUL-delimited `update-index --index-info` record without a
/// temporary formatted String. Callers still own path/mode/OID validation.
pub(crate) fn append_index_info(input: &mut Vec<u8>, mode: &str, oid: &str, path: &str) {
    input.extend_from_slice(mode.as_bytes());
    input.push(b' ');
    input.extend_from_slice(oid.as_bytes());
    input.push(b'\t');
    input.extend_from_slice(path.as_bytes());
    input.push(0);
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
/// Consume the five metadata lines of one `ls-files --debug -z` record.
/// Share the flag parser with the allocation-free fast-path probe, so intent
/// flags cannot be missed merely because `ls-files -v` reports an ordinary H.
fn read_index_flags(rest: &mut &str) -> Result<u32, String> {
    let mut flags = None;
    for _ in 0..5 {
        let (line, after) = rest
            .split_once('\n')
            .ok_or("Incomplete native index flags")?;
        if let Some((_, value)) = line.split_once("flags: ") {
            flags = Some(
                u32::from_str_radix(value.trim(), 16).map_err(|e| e.to_string())? & 0x6000_8000,
            );
        }
        *rest = after;
    }
    flags.ok_or_else(|| "Missing native index flags".into())
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
        let item = Item {
            mode: fields[0].into(),
            oid: fields[1].into(),
            flags: read_index_flags(&mut rest)?,
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

/// Content/mode comparisons cannot prove that index flags match HEAD. In
/// particular, intent-to-add on an already committed empty blob looks clean
/// to `diff-index` and is still tagged H by `ls-files -v`. Read debug flags in
/// that same probe, without allocating a complete path/item map.
fn index_has_flag_delta(root: &Path, workspace_root: bool) -> Result<bool, String> {
    let args = ["ls-files", "-v", "--debug", "-z"];
    let output = if workspace_root {
        workspace::project_git(root, &args)?
    } else {
        git(root, &args)?
    };
    let mut rest = output.as_str();
    while !rest.is_empty() {
        let (header, after) = rest
            .split_once('\0')
            .ok_or("Incomplete native index entry")?;
        rest = after;
        if header.as_bytes().first() != Some(&b'H') || read_index_flags(&mut rest)? != 0 {
            return Ok(true);
        }
    }
    Ok(false)
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

/// Keep filesystem aliases out of the same skeleton. Compare every prefix,
/// not just leaf names: Dir/a and dir/b can share a physical parent even when
/// the leaves differ. Isolate non-ASCII paths conservatively because host
/// case/Unicode equivalence is not defined by Rust's string case folding.
fn intent_batches<'a>(names: &[&'a str]) -> Vec<Vec<&'a str>> {
    let mut batches = Vec::new();
    let mut pending = Vec::new();
    let mut spellings = BTreeMap::<String, String>::new();
    for &name in names {
        let mut prefix = String::new();
        let prefixes: Vec<_> = name
            .split('/')
            .map(|part| {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                prefix.clone()
            })
            .collect();
        let isolated = !name.is_ascii();
        let conflict = prefixes.iter().any(|prefix| {
            spellings
                .get(&prefix.to_ascii_lowercase())
                .is_some_and(|prior| prior != prefix)
        });
        if isolated || conflict {
            if !pending.is_empty() {
                batches.push(std::mem::take(&mut pending));
            }
            spellings.clear();
        }
        if isolated {
            batches.push(vec![name]);
        } else {
            for prefix in prefixes {
                spellings.insert(prefix.to_ascii_lowercase(), prefix);
            }
            pending.push(name);
        }
    }
    if !pending.is_empty() {
        batches.push(pending);
    }
    batches
}

/// Restore intent-to-add from a disposable, metadata-owned worktree skeleton.
/// `add -N` needs a path on disk even though it records no file content. Never
/// depend on or recreate that path in the real (possibly unmaterialized) project.
fn restore_intent(path: &Path, names: &[&str]) -> Result<(), String> {
    let metadata = PathBuf::from(workspace::project_git(
        path,
        &["rev-parse", "--absolute-git-dir"],
    )?);
    let current = index(&metadata)?;
    let owner = crate::workspace_view::owner(path).unwrap_or(path);
    let storage = workspace::private_git_dir(owner).unwrap_or_else(|| metadata.clone());
    let scratch = storage.join(format!("intent-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&scratch).map_err(|e| e.to_string())?;
    struct Scratch(Option<PathBuf>);
    impl Drop for Scratch {
        fn drop(&mut self) {
            if let Some(path) = &self.0 {
                let _ = fs::remove_dir_all(path);
            }
        }
    }
    let mut lease = Scratch(Some(scratch.clone()));
    let mut remove = Vec::new();
    let mut batches = Vec::new();
    for (batch, names) in intent_batches(names).into_iter().enumerate() {
        let worktree = scratch.join(batch.to_string());
        fs::create_dir(&worktree).map_err(|e| e.to_string())?;
        let mut groups = [Vec::new(), Vec::new(), Vec::new()];
        for name in names {
            let relative = Path::new(name);
            if !relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
            {
                return Err("Unsafe intent-to-add path".into());
            }
            let item = current
                .get(name)
                .ok_or("Missing intent-to-add index entry")?;
            let target = worktree.join(relative);
            fs::create_dir_all(target.parent().ok_or("Missing intent-to-add parent")?)
                .map_err(|e| e.to_string())?;
            let group = match item.mode.as_str() {
                "100644" => 0,
                "100755" => 1,
                "120000" => 2,
                _ => return Err("Unsupported intent-to-add entry mode".into()),
            };
            if group == 2 {
                crate::workspace_symlinks::materialize(
                    &worktree,
                    &target,
                    &crate::workspace_symlinks::Link {
                        value: "intent-placeholder".into(),
                        project_absolute: false,
                        kind: crate::workspace_symlinks::Kind::SymbolicFile,
                    },
                )?;
            } else {
                fs::write(&target, []).map_err(|e| e.to_string())?;
            }
            remove.extend_from_slice(name.as_bytes());
            remove.push(0);
            groups[group].extend_from_slice(b":(literal)");
            groups[group].extend_from_slice(name.as_bytes());
            groups[group].push(0);
        }
        batches.push((worktree, groups));
    }
    // An existing ordinary cache entry is not made intent-to-add by `add -N`.
    workspace::project_git_bytes(
        path,
        &[
            "-c",
            "core.ignorecase=false",
            "-c",
            "core.precomposeunicode=false",
            "update-index",
            "--force-remove",
            "-z",
            "--stdin",
        ],
        Some(&remove),
    )?;
    for (worktree, groups) in batches {
        for (group, input) in groups
            .iter()
            .enumerate()
            .filter(|(_, input)| !input.is_empty())
        {
            let mut args = vec![
                "--git-dir",
                metadata.to_str().ok_or("Invalid native index path")?,
                "--work-tree",
                worktree.to_str().ok_or("Invalid intent worktree path")?,
                "-c",
                "core.ignorestat=false",
                "-c",
                "core.symlinks=true",
                // Recorded names/modes, not user checkout policies, define
                // this private skeleton. Stored configuration is untouched.
                "-c",
                "core.ignorecase=false",
                "-c",
                "core.precomposeunicode=false",
                "-c",
                "core.sparseCheckout=false",
                "add",
                "-f",
                "-N",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ];
            if group < 2 {
                args.push(if group == 1 {
                    "--chmod=+x"
                } else {
                    "--chmod=-x"
                });
            }
            workspace::project_git_bytes(path, &args, Some(input))?;
        }
    }
    fs::remove_dir_all(&scratch).map_err(|e| e.to_string())?;
    lease.0 = None;
    Ok(())
}

/// Restore flags only for entries just removed/reinserted by --index-info.
/// Insertions disable core.ignorestat so flags start at zero; unchanged entries never
/// enter this pass. NUL-delimited stdin keeps unusual paths literal and avoids
/// one (or two) Git processes and index rewrites per changed file.
fn restore_flags<'a>(
    path: &Path,
    entries: impl IntoIterator<Item = (&'a str, u32)>,
) -> Result<(), String> {
    let mut intent = Vec::new();
    let mut assume = Vec::new();
    let mut skip = Vec::new();
    for (name, flags) in entries {
        if flags & 0x2000_0000 != 0 {
            intent.push(name);
        }
        for (bit, input) in [(0x8000, &mut assume), (0x4000_0000, &mut skip)] {
            if flags & bit != 0 {
                input.extend_from_slice(name.as_bytes());
                input.push(0);
            }
        }
    }
    if !intent.is_empty() {
        restore_intent(path, &intent)?;
    }
    for (flag, input) in [("--assume-unchanged", assume), ("--skip-worktree", skip)] {
        if !input.is_empty() {
            workspace::project_git_bytes(
                path,
                &[
                    "-c",
                    "core.precomposeunicode=false",
                    "update-index",
                    flag,
                    "-z",
                    "--stdin",
                ],
                Some(&input),
            )?;
        }
    }
    Ok(())
}

/// Install the selected index with Git's own lock/rename protocol. Copying
/// directly onto `index` ignores foreign locks and can leave a truncated index
/// if preparation stops mid-copy. These disposable bytes can be rebuilt, but a
/// failed copy must not damage the previously retained native staging state.
fn install_selected_index(source: &Path, index: &Path) -> Result<(), String> {
    let mut lock_name = index.as_os_str().to_os_string();
    lock_name.push(".lock");
    let lock_path = PathBuf::from(lock_name);
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|e| {
            format!(
                "Cannot reserve native index lock {}: {e}",
                lock_path.display()
            )
        })?;
    struct IndexLock(Option<PathBuf>);
    impl Drop for IndexLock {
        fn drop(&mut self) {
            if let Some(path) = &self.0 {
                let _ = fs::remove_file(path);
            }
        }
    }
    let mut lease = IndexLock(Some(lock_path.clone()));
    let input = match fs::File::open(source) {
        Ok(file) => Some(file),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if let Some(mut input) = input {
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        fs::rename(&lock_path, index).map_err(|e| e.to_string())?;
        // A new Git writer may now acquire index.lock; never unlink its lease.
        lease.0 = None;
    } else {
        drop(output);
        match fs::remove_file(index) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
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
    install_selected_index(&selected.join("index"), &index_path)?;
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
    let mut wanted = tree(&metadata)?;
    let current = index(&metadata)?;
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
    // Both maps stay immutable below; keep borrowed paths through the flag
    // updates instead of cloning every path, including unchanged entries.
    let names: BTreeSet<_> = current.keys().chain(wanted.keys()).collect();
    let format = workspace::project_git(path, &["rev-parse", "--show-object-format=storage"])?;
    let zero = "0".repeat(if format == "sha256" { 64 } else { 40 });
    let mut updates = Vec::new();
    let mut changed = Vec::new();
    for name in names {
        if current.get(name) == wanted.get(name) {
            continue;
        }
        append_index_info(&mut updates, "0", &zero, name);
        if let Some(item) = wanted.get(name) {
            if item.mode != "160000"
                && workspace::project_git(path, &["cat-file", "-e", &item.oid]).is_err()
            {
                let origin = origins.get(name).copied().unwrap_or(selected);
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
            append_index_info(&mut updates, &item.mode, &item.oid, name);
        }
        changed.push(name);
    }
    // core.ignorestat otherwise adds CE_VALID to every inserted entry, even
    // when the recorded input explicitly did not assume it was unchanged.
    workspace::project_git_bytes(
        path,
        &[
            "-c",
            "core.ignorestat=false",
            "-c",
            "core.precomposeunicode=false",
            "update-index",
            "-z",
            "--index-info",
        ],
        Some(&updates),
    )?;
    restore_flags(
        path,
        changed
            .into_iter()
            .filter_map(|name| wanted.get(name).map(|item| (name.as_str(), item.flags))),
    )?;
    if index(&metadata)? != wanted {
        return Err("Native project index did not preserve the composed staging state".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "workspace_git_index_tests.rs"]
mod batching_tests;

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
    fn index_info_encoding_matches_legacy_bytes_for_modes_hashes_and_special_paths() {
        let mut actual = b"existing\0".to_vec();
        let mut expected = actual.clone();
        for size in [40, 64] {
            for mode in ["0", "100644", "100755", "120000", "160000"] {
                let oid = if mode == "0" { "0" } else { "a" }.repeat(size);
                for path in [
                    "file",
                    "- leading",
                    "tab\tand\nnewline",
                    "back\\slash",
                    "quote\"",
                    "résumé/中文",
                ] {
                    append_index_info(&mut actual, mode, &oid, path);
                    expected.extend_from_slice(format!("{mode} {oid}\t{path}\0").as_bytes());
                }
            }
        }
        assert_eq!(actual, expected);
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
