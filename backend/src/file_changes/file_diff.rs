//! Unified per-file diff extraction for the Changes panel.
//! Mirrors `pi-gpui`'s read-only diff model (`hunk`, `context`, `added`, `removed`,
//! binary detection, and bounded line rendering) while honoring Grapher's shadow
//! repositories, isolated worktrees, and path-safety boundaries.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path},
};

/// Lines returned per file; the rest is summarized so huge generated files
/// stay responsive in the browser.
pub const MAX_DIFF_LINES_PER_FILE: usize = 1_500;
/// Untracked/newly added files larger than this are marked binary/unpreviewable
/// without reading megabytes into memory.
pub const MAX_UNTRACKED_DIFF_BYTES: u64 = 512 * 1024;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineKind {
    Hunk,
    Context,
    Added,
    Removed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffLine {
    pub kind: DiffLineKind,
    pub text: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffResult {
    pub run_id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub hidden_lines: usize,
    pub lines: Vec<FileDiffLine>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedFileDiff {
    pub old_path: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub hidden_lines: usize,
    pub lines: Vec<FileDiffLine>,
}

pub fn validate_relative_diff_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("必须提供有效的文件路径。".into());
    }
    let normalized = trimmed.replace('\\', "/");
    if normalized.starts_with('/') || normalized == ".git" || normalized.starts_with(".git/") {
        return Err("文件路径不合法。".into());
    }
    let rel = Path::new(&normalized);
    if rel.is_absolute() {
        return Err("文件路径不合法。".into());
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir | Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("文件路径包含非法路径片段。".into());
            }
        }
    }
    if crate::path_identity::is_runtime_metadata_path(rel) {
        return Err("不允许读取内部元数据路径。".into());
    }
    Ok(normalized)
}

/// Parse `git diff --no-color --no-ext-diff` output for a single file.
pub fn parse_unified_diff(output: &str, max_lines: usize) -> ParsedFileDiff {
    let mut parsed = ParsedFileDiff::default();
    let mut in_hunk = false;
    let mut saw_header = false;

    for line in output.lines() {
        if line.starts_with("diff --git ") {
            saw_header = true;
            in_hunk = false;
            continue;
        }
        if !saw_header {
            continue;
        }
        if line.starts_with("@@") {
            in_hunk = true;
            push_bounded_line(&mut parsed, DiffLineKind::Hunk, line, max_lines);
            continue;
        }
        if !in_hunk {
            if let Some(from) = line.strip_prefix("rename from ") {
                parsed.old_path = Some(from.to_string());
            } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
                parsed.binary = true;
            }
            continue;
        }
        let Some(first) = line.as_bytes().first().copied() else {
            continue;
        };
        let (kind, text) = match first {
            b'+' => (DiffLineKind::Added, &line[1..]),
            b'-' => (DiffLineKind::Removed, &line[1..]),
            b' ' => (DiffLineKind::Context, &line[1..]),
            // "\ No newline at end of file" or unexpected metadata
            _ => continue,
        };
        push_bounded_line(&mut parsed, kind, text, max_lines);
    }

    parsed
}

fn push_bounded_line(
    parsed: &mut ParsedFileDiff,
    kind: DiffLineKind,
    text: &str,
    max_lines: usize,
) {
    if parsed.lines.len() < max_lines {
        parsed.lines.push(FileDiffLine {
            kind,
            text: text.to_string(),
        });
    } else {
        parsed.truncated = true;
        parsed.hidden_lines += 1;
    }
}

fn run_git(repo_or_worktree: &Path, args: &[&str]) -> Result<String, String> {
    crate::workspace::repository_git(repo_or_worktree, args)
        .or_else(|_| crate::workspace::git(repo_or_worktree, args))
}

/// Compute unified diff for `path` (and optional `old_path`) between `before`
/// and optional `after` (or live working tree when `after` is `None`).
pub fn compute_git_file_diff(
    repo_or_worktree: &Path,
    before: &str,
    after: Option<&str>,
    path: &str,
    old_path: Option<&str>,
) -> Option<ParsedFileDiff> {
    if before.is_empty() || !repo_or_worktree.exists() {
        return None;
    }
    let after = after.filter(|sha| !sha.is_empty());
    if after == Some(before) {
        return None;
    }

    let mut args = vec![
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        before,
    ];
    if let Some(after_sha) = after {
        args.push(after_sha);
    }
    args.push("--");
    if let Some(old) = old_path.filter(|old| !old.is_empty() && *old != path) {
        args.push(old);
    }
    args.push(path);

    let output = run_git(repo_or_worktree, &args).ok()?;
    if output.trim().is_empty() {
        return None;
    }
    let parsed = parse_unified_diff(&output, MAX_DIFF_LINES_PER_FILE);
    if parsed.binary || !parsed.lines.is_empty() || output.contains("rename from ") {
        Some(parsed)
    } else {
        None
    }
}

/// Compute working-tree diff against `HEAD` (or the empty tree on an unborn repo).
pub fn compute_head_file_diff(
    repo_or_worktree: &Path,
    path: &str,
    old_path: Option<&str>,
) -> Option<ParsedFileDiff> {
    if !repo_or_worktree.exists() {
        return None;
    }
    let base = match run_git(repo_or_worktree, &["rev-parse", "--verify", "--quiet", "HEAD"]) {
        Ok(_) => "HEAD".to_string(),
        Err(_) => run_git(
            repo_or_worktree,
            &["hash-object", "-t", "tree", "/dev/null"],
        )
        .ok()?
        .trim()
        .to_string(),
    };
    compute_git_file_diff(repo_or_worktree, &base, None, path, old_path)
}

/// Read an untracked or newly added file safely within `root` and format all
/// its lines as additions (or mark it binary when NUL bytes / >512 KiB).
pub fn read_added_file_diff(root: &Path, path: &str) -> Option<ParsedFileDiff> {
    let target = crate::path_safety::real_child_path(root, &root.join(path), true).ok()??;
    let metadata = fs::metadata(&target).ok()?;
    if !metadata.is_file() {
        return None;
    }
    if metadata.len() > MAX_UNTRACKED_DIFF_BYTES {
        return Some(ParsedFileDiff {
            binary: true,
            ..Default::default()
        });
    }
    let bytes = fs::read(&target).ok()?;
    if bytes.iter().take(8_000).any(|byte| *byte == 0) {
        return Some(ParsedFileDiff {
            binary: true,
            ..Default::default()
        });
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut parsed = ParsedFileDiff::default();
    for line in text.lines() {
        push_bounded_line(&mut parsed, DiffLineKind::Added, line, MAX_DIFF_LINES_PER_FILE);
    }
    Some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hunks_additions_removals_and_truncation() {
        let raw = "\
diff --git a/src/ledger.rs b/src/ledger.rs
index 1111111..2222222 100644
--- a/src/ledger.rs
+++ b/src/ledger.rs
@@ -1,3 +1,4 @@ fn apply() {
 keep
-old
+new1
+new2
\\ No newline at end of file
";
        let full = parse_unified_diff(raw, 100);
        assert!(!full.binary);
        assert!(!full.truncated);
        assert_eq!(full.hidden_lines, 0);
        assert_eq!(full.lines.len(), 5);
        assert_eq!(full.lines[0].kind, DiffLineKind::Hunk);
        assert_eq!(full.lines[1], FileDiffLine { kind: DiffLineKind::Context, text: "keep".into() });
        assert_eq!(full.lines[2], FileDiffLine { kind: DiffLineKind::Removed, text: "old".into() });
        assert_eq!(full.lines[3], FileDiffLine { kind: DiffLineKind::Added, text: "new1".into() });
        assert_eq!(full.lines[4], FileDiffLine { kind: DiffLineKind::Added, text: "new2".into() });

        let capped = parse_unified_diff(raw, 3);
        assert!(capped.truncated);
        assert_eq!(capped.hidden_lines, 2);
        assert_eq!(capped.lines.len(), 3);
    }

    #[test]
    fn detects_binary_and_rename_headers() {
        let bin = "\
diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
";
        let parsed = parse_unified_diff(bin, 100);
        assert!(parsed.binary);
        assert!(parsed.lines.is_empty());

        let ren = "\
diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
";
        let renamed = parse_unified_diff(ren, 100);
        assert!(!renamed.binary);
        assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
        assert!(renamed.lines.is_empty());
    }

    #[test]
    fn rejects_invalid_and_traversal_paths() {
        assert!(validate_relative_diff_path("").is_err());
        assert!(validate_relative_diff_path("../secret.txt").is_err());
        assert!(validate_relative_diff_path("a/../b.txt").is_err());
        assert!(validate_relative_diff_path("/etc/passwd").is_err());
        assert!(validate_relative_diff_path(".git/config").is_err());
        assert!(validate_relative_diff_path(".grapher/state.json").is_err());
        assert_eq!(validate_relative_diff_path("src/ledger.rs").unwrap(), "src/ledger.rs");
    }
}
