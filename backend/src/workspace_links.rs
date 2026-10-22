//! Project hardlink topology, independent of source/slot inode identities.
//! Aliases outside the project are represented by owned private witnesses, never
//! by linking a writable workspace inode to source, evidence or another slot.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Topology {
    aliases: BTreeMap<String, String>,
    outside: BTreeMap<String, u64>,
}

fn safe(name: &str) -> Result<(), String> {
    if name.is_empty()
        || !Path::new(name)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Unsafe project hardlink path".into());
    }
    Ok(())
}

pub(crate) fn capture(
    root: &Path,
    files: impl IntoIterator<Item = String>,
) -> Result<Topology, String> {
    let mut groups: BTreeMap<u128, (Vec<String>, u64)> = BTreeMap::new();
    for name in files {
        safe(&name)?;
        let path = root.join(&name);
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("Hardlink evidence must identify regular files".into());
        }
        let (identity, count) = crate::workspace_metadata::file_identity(&path, &metadata)?;
        if count <= 1 {
            continue;
        }
        let group = groups
            .entry(identity)
            .or_insert_with(|| (Vec::new(), count));
        if group.1 != count {
            return Err("Project hardlinks changed during capture".into());
        }
        group.0.push(name);
    }
    let mut result = Topology::default();
    for (_, (mut names, count)) in groups {
        names.sort();
        let outside = count
            .checked_sub(names.len() as u64)
            .ok_or("Project hardlink capture is inconsistent")?;
        let canonical = names.first().ok_or("Empty hardlink class")?.clone();
        for name in names.into_iter().skip(1) {
            result.aliases.insert(name, canonical.clone());
        }
        result.outside.insert(canonical, outside);
    }
    Ok(result)
}

fn merge<T: Clone + Eq>(
    base: &BTreeMap<String, T>,
    inputs: &[&BTreeMap<String, T>],
) -> Result<BTreeMap<String, T>, String> {
    let names: BTreeSet<_> = base
        .keys()
        .chain(inputs.iter().flat_map(|map| map.keys()))
        .collect();
    let mut result = BTreeMap::new();
    for name in names {
        let original = base.get(name);
        let mut changes = Vec::new();
        for input in inputs {
            let candidate = input.get(name);
            if candidate != original && !changes.contains(&candidate) {
                changes.push(candidate);
            }
        }
        if changes.len() > 1 {
            return Err(format!("Project hardlink composition conflict at {name}"));
        }
        if let Some(value) = changes.first().copied().unwrap_or(original) {
            result.insert(name.clone(), value.clone());
        }
    }
    Ok(result)
}

fn canonical(aliases: &BTreeMap<String, String>, name: &str) -> Result<String, String> {
    let mut current = name;
    let mut seen = BTreeSet::new();
    while let Some(next) = aliases.get(current) {
        safe(current)?;
        if !seen.insert(current) {
            return Err("Cyclic project hardlink evidence".into());
        }
        current = next;
    }
    safe(current)?;
    Ok(current.into())
}

pub(crate) fn compose(
    base: &Topology,
    inputs: &[&Topology],
    files: &BTreeSet<String>,
) -> Result<Topology, String> {
    let aliases = merge(
        &base.aliases,
        &inputs
            .iter()
            .map(|input| &input.aliases)
            .collect::<Vec<_>>(),
    )?;
    let outside = merge(
        &base.outside,
        &inputs
            .iter()
            .map(|input| &input.outside)
            .collect::<Vec<_>>(),
    )?;
    let mut result = Topology::default();
    for name in aliases.keys().filter(|name| files.contains(*name)) {
        let target = canonical(&aliases, name)?;
        if !files.contains(&target) {
            return Err(format!(
                "Hardlink target {target} was deleted by incompatible task changes"
            ));
        }
        result.aliases.insert(name.clone(), target.clone());
        result.outside.entry(target).or_insert(0);
    }
    for (name, count) in outside {
        if !files.contains(&name) {
            continue;
        }
        let target = canonical(&aliases, &name)?;
        let previous = result.outside.insert(target, count);
        if previous.is_some_and(|previous| previous != 0 && previous != count) {
            return Err("Conflicting external hardlink counts".into());
        }
    }
    result
        .outside
        .retain(|target, count| *count > 0 || result.aliases.values().any(|alias| alias == target));
    Ok(result)
}

fn unlink(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Project hardlink replacement is not a regular file".into());
    }
    #[cfg(windows)]
    if metadata.permissions().readonly() {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions).map_err(|e| e.to_string())?;
    }
    fs::remove_file(path).map_err(|e| e.to_string())
}

pub(crate) fn restore(
    root: &Path,
    topology: &Topology,
    signatures: &BTreeMap<String, String>,
) -> Result<(), String> {
    // This control root is deliberately not part of writable process HOME/E.
    let owner = crate::workspace_state::root(root)?;
    let witnesses = owner.join("project-links");
    crate::path_safety::real_child_path(&owner, &witnesses, false)?;
    if witnesses.exists() {
        if fs::read(witnesses.join("owner")).map_err(|e| e.to_string())?
            != b"private-project-links-v1\n"
        {
            return Err("Unrecognized project hardlink witness owner".into());
        }
        for item in fs::read_dir(&witnesses).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            if item.file_name() == "owner" {
                continue;
            }
            unlink(&item.path())?;
        }
    } else {
        fs::create_dir(&witnesses).map_err(|e| e.to_string())?;
        fs::write(witnesses.join("owner"), b"private-project-links-v1\n")
            .map_err(|e| e.to_string())?;
    }
    for (name, target) in &topology.aliases {
        safe(name)?;
        safe(target)?;
        if signatures.get(name).is_none() || signatures.get(name) != signatures.get(target) {
            return Err(format!(
                "Hardlinked task paths {name} and {target} have incompatible content/metadata"
            ));
        }
        let alias = root.join(name);
        let target = root.join(target);
        crate::path_safety::real_child_path(root, &alias, true)?;
        crate::path_safety::real_child_path(root, &target, true)?;
        let am = fs::symlink_metadata(&alias).map_err(|e| e.to_string())?;
        let tm = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
        if crate::workspace_metadata::file_identity(&alias, &am)?.0
            != crate::workspace_metadata::file_identity(&target, &tm)?.0
        {
            unlink(&alias)?;
            fs::hard_link(&target, &alias)
                .map_err(|e| format!("Cannot reconstruct private project hardlink: {e}"))?;
        }
    }
    for (name, count) in &topology.outside {
        safe(name)?;
        let target = root.join(name);
        crate::path_safety::real_child_path(root, &target, true)?;
        let key = git2::Oid::hash_object(git2::ObjectType::Blob, name.as_bytes())
            .map_err(|e| e.to_string())?;
        for index in 0..*count {
            let witness: PathBuf = witnesses.join(format!("{key}-{index}"));
            fs::hard_link(&target, witness)
                .map_err(|e| format!("Cannot retain external hardlink count privately: {e}"))?;
        }
    }
    Ok(())
}
