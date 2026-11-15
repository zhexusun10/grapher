//! Allocation-free equality equivalent to `normalized_bytes`.
//! Schema 5 preserves its historical `security` omissions. Schema 6 compares
//! native ACL evidence and all project paths, retaining only the Git-index
//! stat-cache omission. Legacy records are upgraded in memory after validation.
use super::{Entry, View};
use crate::{workspace_metadata::Extra, workspace_symlinks::Link};
use std::collections::BTreeMap;

pub(super) fn equal(left: &View, right: &View) -> bool {
    equal_with_security(left, right, left.schema >= 6)
}

fn equal_with_security(left: &View, right: &View, security: bool) -> bool {
    // Exhaustive destructuring makes new View fields a compile-time reminder
    // to update this projection, rather than silently ignoring new evidence.
    let View {
        schema, source, root_mode, root_extra, entries, hardlinks, repositories,
        git_entries, git_file, git_file_metadata, git_link, git_link_metadata,
        git_config, git_files, git_global,
    } = left;
    *schema == right.schema
        && source == &right.source
        && *root_mode == right.root_mode
        && root_extra.eq_for_view_identity(&right.root_extra, security)
        && map_equal(entries, &right.entries, false, security, |a, b| entry_equal(a, b, security))
        && if security { hardlinks == &right.hardlinks } else { hardlinks.eq_for_view_identity(&right.hardlinks) }
        && map_equal(repositories, &right.repositories, false, security, |a, b| equal_with_security(a, b, security))
        && match (git_entries, &right.git_entries) {
            (None, None) => true,
            (Some(a), Some(b)) => map_equal(a, b, true, security, |a, b| entry_equal(a, b, security)),
            _ => false,
        }
        && *git_file == right.git_file
        && metadata_equal(git_file_metadata, &right.git_file_metadata, security)
        && *git_link == right.git_link
        && metadata_equal(git_link_metadata, &right.git_link_metadata, security)
        && git_config == &right.git_config
        && map_equal(git_files, &right.git_files, false, security, |a, b| a == b)
        && git_global == &right.git_global
}

fn map_equal<T>(
    left: &BTreeMap<String, T>,
    right: &BTreeMap<String, T>,
    git_index: bool,
    security: bool,
    equal: impl Fn(&T, &T) -> bool,
) -> bool {
    let keep = |name: &str| (security || name != "security") && !(git_index && name == "index");
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

fn metadata_equal(left: &Option<(u32, Extra)>, right: &Option<(u32, Extra)>, security: bool) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some((am, a)), Some((bm, b))) => am == bm && a.eq_for_view_identity(b, security),
        _ => false,
    }
}

fn link_equal(left: &Link, right: &Link) -> bool {
    let Link { value, project_absolute, kind } = left;
    value == &right.value && *project_absolute == right.project_absolute && kind == &right.kind
}

fn entry_equal(left: &Entry, right: &Entry, security: bool) -> bool {
    // Do not use Entry/Extra's portable equality: it intentionally ignores
    // Unix ownership before legacy evidence has undergone normalization.
    match left {
        Entry::Directory { mode, extra } => matches!(right,
            Entry::Directory { mode: other_mode, extra: other_extra }
                if mode == other_mode && extra.eq_for_view_identity(other_extra, security)),
        Entry::File { mode, blob, extra } => matches!(right,
            Entry::File { mode: other_mode, blob: other_blob, extra: other_extra }
                if mode == other_mode && blob == other_blob && extra.eq_for_view_identity(other_extra, security)),
        Entry::Special { special, mode, device, extra } => matches!(right,
            Entry::Special { special: other_special, mode: other_mode, device: other_device, extra: other_extra }
                if special == other_special && mode == other_mode && device == other_device
                    && extra.eq_for_view_identity(other_extra, security)),
        Entry::Link { target, extra } => matches!(right,
            Entry::Link { target: other_target, extra: other_extra }
                if link_equal(target, other_target) && extra.eq_for_view_identity(other_extra, security)),
    }
}

#[cfg(test)]
#[path = "equality_tests.rs"]
mod tests;
