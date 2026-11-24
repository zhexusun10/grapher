//! Allocation-free equality equivalent to the current normalized checksum.
use super::{Entry, View};
use crate::{workspace_metadata::Extra, workspace_symlinks::Link};
use std::collections::BTreeMap;

#[cfg(test)]
#[path = "equality_tests.rs"]
mod tests;

pub(super) fn equal(left: &View, right: &View) -> bool {
    let View {
        schema,
        source,
        root_mode,
        root_extra,
        entries,
        hardlinks,
        repositories,
        git_entries,
        git_file,
        git_file_metadata,
        git_link,
        git_link_metadata,
        git_config,
        git_files,
        git_global,
    } = left;
    *schema == super::VIEW_SCHEMA
        && *schema == right.schema
        && source == &right.source
        && *root_mode == right.root_mode
        && root_extra.eq_for_view_identity(&right.root_extra)
        && map_equal(entries, &right.entries, false, entry_equal)
        && hardlinks == &right.hardlinks
        && map_equal(repositories, &right.repositories, false, equal)
        && match (git_entries, &right.git_entries) {
            (None, None) => true,
            (Some(a), Some(b)) => map_equal(a, b, true, entry_equal),
            _ => false,
        }
        && *git_file == right.git_file
        && metadata_equal(git_file_metadata, &right.git_file_metadata)
        && *git_link == right.git_link
        && metadata_equal(git_link_metadata, &right.git_link_metadata)
        && git_config == &right.git_config
        && map_equal(git_files, &right.git_files, false, |a, b| a == b)
        && git_global == &right.git_global
}

fn map_equal<T>(
    left: &BTreeMap<String, T>,
    right: &BTreeMap<String, T>,
    git_index: bool,
    equal: impl Fn(&T, &T) -> bool,
) -> bool {
    let keep = |name: &str| !(git_index && name == "index");
    let mut left = left.iter().filter(|(name, _)| keep(name));
    let mut right = right.iter().filter(|(name, _)| keep(name));
    loop {
        match (left.next(), right.next()) {
            (None, None) => return true,
            (Some((a, av)), Some((b, bv))) if a == b && equal(av, bv) => {}
            _ => return false,
        }
    }
}

fn metadata_equal(left: &Option<(u32, Extra)>, right: &Option<(u32, Extra)>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some((am, a)), Some((bm, b))) => am == bm && a.eq_for_view_identity(b),
        _ => false,
    }
}

fn link_equal(left: &Link, right: &Link) -> bool {
    let Link {
        value,
        project_absolute,
        kind,
    } = left;
    value == &right.value && *project_absolute == right.project_absolute && kind == &right.kind
}

fn entry_equal(left: &Entry, right: &Entry) -> bool {
    match left {
        Entry::Directory { mode, extra } => matches!(right,
            Entry::Directory { mode: other_mode, extra: other_extra }
                if mode == other_mode && extra.eq_for_view_identity(other_extra)),
        Entry::File { mode, blob, extra } => matches!(right,
            Entry::File { mode: other_mode, blob: other_blob, extra: other_extra }
                if mode == other_mode && blob == other_blob && extra.eq_for_view_identity(other_extra)),
        Entry::Special {
            special,
            mode,
            device,
            extra,
        } => matches!(right,
            Entry::Special { special: other_special, mode: other_mode, device: other_device, extra: other_extra }
                if special == other_special && mode == other_mode && device == other_device
                    && extra.eq_for_view_identity(other_extra)),
        Entry::Link { target, extra } => matches!(right,
            Entry::Link { target: other_target, extra: other_extra }
                if link_equal(target, other_target) && extra.eq_for_view_identity(other_extra)),
    }
}

fn first_map_diff(
    prefix: &str,
    left: &BTreeMap<String, Entry>,
    right: &BTreeMap<String, Entry>,
    skip_git_index: bool,
) -> Option<String> {
    let keep = |name: &str| !(skip_git_index && name == "index");
    let mut left_iter = left.iter().filter(|(name, _)| keep(name)).peekable();
    let mut right_iter = right.iter().filter(|(name, _)| keep(name)).peekable();
    while let (Some(&(lk, lv)), Some(&(rk, rv))) = (left_iter.peek(), right_iter.peek()) {
        match lk.cmp(rk) {
            std::cmp::Ordering::Less => return Some(format!("{prefix}{lk} removed")),
            std::cmp::Ordering::Greater => return Some(format!("{prefix}{rk} added")),
            std::cmp::Ordering::Equal => {
                if !entry_equal(lv, rv) {
                    return Some(format!("{prefix}{lk} modified"));
                }
                left_iter.next();
                right_iter.next();
            }
        }
    }
    if let Some((lk, _)) = left_iter.next() {
        return Some(format!("{prefix}{lk} removed"));
    }
    if let Some((rk, _)) = right_iter.next() {
        return Some(format!("{prefix}{rk} added"));
    }
    None
}

/// Summarize the first observable difference between two `View` snapshots so
/// concurrent-change diagnostics point to the exact file or metadata that moved.
pub(super) fn first_diff_detail(left: &View, right: &View) -> Option<String> {
    if let Some(diff) = first_map_diff("", &left.entries, &right.entries, false) {
        return Some(diff);
    }
    match (&left.git_entries, &right.git_entries) {
        (Some(a), Some(b)) => {
            if let Some(diff) = first_map_diff(".git/", a, b, true) {
                return Some(diff);
            }
        }
        (Some(_), None) => return Some(".git removed".into()),
        (None, Some(_)) => return Some(".git added".into()),
        (None, None) => {}
    }
    if !map_equal(&left.repositories, &right.repositories, false, equal) {
        for (path, left_repo) in &left.repositories {
            match right.repositories.get(path) {
                None => return Some(format!("{path} repository removed")),
                Some(right_repo) if !equal(left_repo, right_repo) => {
                    if let Some(inner) = first_diff_detail(left_repo, right_repo) {
                        return Some(format!("{path}/{inner}"));
                    }
                    return Some(format!("{path} repository modified"));
                }
                _ => {}
            }
        }
        for path in right.repositories.keys() {
            if !left.repositories.contains_key(path) {
                return Some(format!("{path} repository added"));
            }
        }
    }
    if left.git_config != right.git_config {
        return Some(".git/config modified".into());
    }
    if left.git_files != right.git_files {
        return Some(".git metadata files modified".into());
    }
    if left.hardlinks != right.hardlinks {
        return Some("hardlink topology modified".into());
    }
    if left.root_mode != right.root_mode || !left.root_extra.eq_for_view_identity(&right.root_extra) {
        return Some("root metadata modified".into());
    }
    None
}
