use crate::workspace;
use std::path::Path;

/// Merge completed graph heads into the user's repository. The caller invokes
/// this only after the graph reaches completed; serial runs never call it.
pub fn merge_graph(repository: &Path, heads: &[String]) -> Result<(), String> {
    if heads.is_empty() { return Ok(()); }
    for head in heads {
        if let Err(error) = workspace::git(repository, &["merge", "--no-edit", "--no-ff", head]) {
            return Err(format!("Graph merge conflict: {error}"));
        }
    }
    Ok(())
}

pub fn abort(repository: &Path) { let _ = workspace::git(repository, &["merge", "--abort"]); }
