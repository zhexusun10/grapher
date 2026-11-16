//! One NUL-delimited Git diff supplies both status and line counts. Paths are
//! literal Git paths, not quoted display strings or brace-expanded renames.
use super::FileChangeItem;
use std::collections::BTreeMap;

struct Change<'a> {
    status: &'static str,
    old_path: Option<&'a str>,
    counts: Option<(usize, usize)>,
}

fn counts(additions: &str, deletions: &str) -> Option<(usize, usize)> {
    if additions == "-" || deletions == "-" {
        return (additions == "-" && deletions == "-").then_some((0, 0));
    }
    let decimal =
        |value: &str| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
    if !decimal(additions) || !decimal(deletions) {
        return None;
    }
    Some((additions.parse().ok()?, deletions.parse().ok()?))
}

fn raw_status(header: &str) -> Option<(&'static str, bool)> {
    let mut metadata = header.strip_prefix(':')?.split_ascii_whitespace();
    for _ in 0..2 {
        let mode = metadata.next()?;
        if mode.len() != 6 || !mode.bytes().all(|byte| (b'0'..=b'7').contains(&byte)) {
            return None;
        }
    }
    // Object IDs may be abbreviated and use either SHA-1 or SHA-256.
    for _ in 0..2 {
        if !metadata
            .next()?
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        {
            return None;
        }
    }
    let code = metadata.next()?;
    if metadata.next().is_some() {
        return None;
    }
    let suffix = code.get(1..)?;
    let score = || {
        !suffix.is_empty()
            && suffix.len() <= 3
            && suffix.bytes().all(|byte| byte.is_ascii_digit())
            && suffix.parse::<u8>().ok().is_some_and(|value| value <= 100)
    };
    match code.as_bytes().first()? {
        b'A' if suffix.is_empty() => Some(("added", false)),
        b'D' if suffix.is_empty() => Some(("deleted", false)),
        b'R' if score() => Some(("renamed", true)),
        b'C' if score() => Some(("added", true)),
        b'M' if suffix.is_empty() || score() => Some(("modified", false)),
        b'T' | b'U' | b'X' | b'B' if suffix.is_empty() => Some(("modified", false)),
        _ => None,
    }
}

/// Parse `git diff --raw --numstat -z -M`. Git writes the raw records first,
/// then numstat records. Keep borrowed paths until both sections are validated;
/// a malformed/partial response is unavailable data, never a cached empty diff.
pub(super) fn parse(
    output: &str,
    node: &str,
    execution_id: &str,
) -> Option<BTreeMap<String, FileChangeItem>> {
    if !output.is_empty() && !output.ends_with('\0') {
        return None;
    }
    let mut fields = output.split_terminator('\0');
    let mut changes = BTreeMap::<&str, Change<'_>>::new();
    let mut reading_stats = false;
    while let Some(header) = fields.next() {
        if !reading_stats && header.starts_with(':') {
            let (status, two_paths) = raw_status(header)?;
            let first = fields.next().filter(|path| !path.is_empty())?;
            let (path, old_path) = if two_paths {
                (fields.next().filter(|path| !path.is_empty())?, Some(first))
            } else {
                (first, None)
            };
            changes.insert(
                path,
                Change {
                    status,
                    old_path,
                    counts: None,
                },
            );
        } else {
            reading_stats = true;
            let (additions, rest) = header.split_once('\t')?;
            let (deletions, path) = rest.split_once('\t')?;
            let (path, old_path) = if path.is_empty() {
                // With -z a rename/copy has an empty header path, followed by
                // two complete path fields; tabs/newlines inside them are data.
                let old = fields.next().filter(|path| !path.is_empty())?;
                (fields.next().filter(|path| !path.is_empty())?, Some(old))
            } else {
                (path, None)
            };
            let change = changes.get_mut(path)?;
            if change.old_path != old_path {
                return None;
            }
            change.counts = Some(counts(additions, deletions)?);
        }
    }
    changes
        .into_iter()
        .map(|(path, change)| {
            let (additions, deletions) = change.counts?;
            Some((
                path.to_string(),
                FileChangeItem {
                    path: path.to_string(),
                    old_path: change.old_path.map(str::to_string),
                    status: change.status.into(),
                    additions,
                    deletions,
                    is_running: false,
                    nodes: if node.is_empty() {
                        vec![]
                    } else {
                        vec![node.into()]
                    },
                    execution_ids: if execution_id.is_empty() {
                        vec![]
                    } else {
                        vec![execution_id.into()]
                    },
                    source: Some("git".into()),
                },
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn nul_diff_keeps_literal_paths_and_rename_counts() {
        let old = "old\tname\n文件.txt";
        let new = "new/{literal => name}\n\"quoted\"\\file.txt";
        let output = format!(
            ":100644 100644 a b R080\0{old}\0{new}\0\
             :100644 100644 a b M\0binary.bin\0\
             :000000 100644 a b A\0:tab\tfile.txt\0\
             3\t2\t\0{old}\0{new}\0-\t-\tbinary.bin\0\
             1\t0\t:tab\tfile.txt\0"
        );
        let parsed = parse(&output, "worker", "exec").unwrap();
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[new].old_path.as_deref(), Some(old));
        assert_eq!(parsed[new].status, "renamed");
        assert_eq!((parsed[new].additions, parsed[new].deletions), (3, 2));
        assert_eq!(parsed[new].nodes, ["worker"]);
        assert_eq!(parsed[new].execution_ids, ["exec"]);
        assert_eq!(
            (
                parsed["binary.bin"].additions,
                parsed["binary.bin"].deletions
            ),
            (0, 0)
        );
        assert_eq!(parsed[":tab\tfile.txt"].status, "added");
    }

    #[test]
    fn incomplete_diff_is_not_an_empty_or_partial_success() {
        assert!(parse("", "", "").unwrap().is_empty());
        for invalid in [
            ":100644 100644 a b M\0file",
            ":100644 100644 a b M\0file\0",
            ":100644 100644 a b R100\0old\0",
            "1\t0\tmissing-raw-record\0",
            ":100644 100644 a b M\0file\01\t0\tother\0",
            ":100644 100644 a b M\0file\0invalid\t0\tfile\0",
            ":100644 100644 a b R100\0old\0new\01\t0\t\0wrong-old\0new\0",
        ] {
            assert!(parse(invalid, "", "").is_none(), "{invalid:?}");
        }
    }

    #[test]
    fn combined_git_diff_reports_renames_binary_and_unicode_and_empty_results() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        let git = |args: &[&str]| crate::workspace::git(repo, args).unwrap();
        git(&["init", "-q"]);
        git(&["config", "core.autocrlf", "false"]);
        fs::write(
            repo.join("old name.txt"),
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
        )
        .unwrap();
        fs::write(repo.join("binary.bin"), b"\0old").unwrap();
        fs::write(repo.join("删除.txt"), "removed\n").unwrap();
        fs::write(repo.join("修改.txt"), "first\nunchanged\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "base"]);
        let before = git(&["rev-parse", "HEAD"]);
        fs::create_dir(repo.join("dir")).unwrap();
        fs::rename(repo.join("old name.txt"), repo.join("dir/new name.txt")).unwrap();
        fs::write(
            repo.join("dir/new name.txt"),
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nadded\n",
        )
        .unwrap();
        fs::write(repo.join("binary.bin"), b"\0new binary").unwrap();
        fs::remove_file(repo.join("删除.txt")).unwrap();
        fs::write(repo.join("修改.txt"), "last\nunchanged\n").unwrap();
        fs::write(repo.join("新增.txt"), "new1\nnew2\n").unwrap();
        fs::write(repo.join(".DS_Store"), "host metadata\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "result"]);
        let after = git(&["rev-parse", "HEAD"]);
        let summary =
            super::super::compute_git_changes(repo, &before, Some(&after), "node", "exec").unwrap();
        assert_eq!(summary.total_files, 5);
        assert_eq!(
            (
                summary.added_count,
                summary.deleted_count,
                summary.renamed_count,
                summary.modified_count
            ),
            (1, 1, 1, 2)
        );
        assert_eq!((summary.total_additions, summary.total_deletions), (4, 2));
        let renamed = summary
            .files
            .iter()
            .find(|file| file.status == "renamed")
            .unwrap();
        assert_eq!(renamed.path, "dir/new name.txt");
        assert_eq!(renamed.old_path.as_deref(), Some("old name.txt"));
        assert_eq!((renamed.additions, renamed.deletions), (1, 0));
        // Different commits with identical trees still yield a cached empty diff.
        git(&["commit", "--allow-empty", "-qm", "metadata only"]);
        let empty = git(&["rev-parse", "HEAD"]);
        assert!(
            super::super::compute_git_changes(repo, &after, Some(&empty), "", "")
                .unwrap()
                .is_empty()
        );
        assert!(
            super::super::compute_git_changes(repo, "missing-revision", Some(&after), "", "")
                .is_none()
        );
    }

    #[test]
    fn live_git_diff_keeps_literal_untracked_and_ignored_paths_after_staging() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        let git = |args: &[&str]| crate::workspace::git(repo, args).unwrap();
        git(&["init", "-q"]);
        git(&["config", "core.autocrlf", "false"]);
        fs::write(repo.join(".gitignore"), "ignored/\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "base"]);
        let base = git(&["rev-parse", "HEAD"]);
        fs::create_dir(repo.join("ignored")).unwrap();
        let mut paths = vec![
            " leading.txt",
            "ignored/ leading.txt",
            "literal {braces}.txt",
        ];
        if cfg!(unix) {
            paths.extend([
                "back\\slash.txt",
                "tab\tfile.txt",
                "line\nbreak.txt",
                "trailing.txt ",
            ]);
        }
        for path in &paths {
            fs::write(repo.join(path), "one\ntwo\n").unwrap();
        }
        let live = super::super::compute_git_changes(repo, &base, None, "node", "exec").unwrap();
        for path in &paths {
            let file = live
                .files
                .iter()
                .find(|file| file.path == *path)
                .unwrap_or_else(|| panic!("missing literal path {path:?}: {:?}", live.files));
            assert_eq!((file.additions, file.deletions), (2, 0), "{path:?}");
        }
        git(&["add", "-f", "."]);
        git(&["commit", "-qm", "files"]);
        let after = git(&["rev-parse", "HEAD"]);
        let committed =
            super::super::compute_git_changes(repo, &base, Some(&after), "node", "exec").unwrap();
        assert_eq!(
            live, committed,
            "staging must not change path spelling or file totals"
        );
    }

    #[test]
    fn live_untracked_counts_match_git_for_binary_and_non_utf8_text() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        let git = |args: &[&str]| crate::workspace::git(repo, args).unwrap();
        git(&["init", "-q"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["commit", "--allow-empty", "-qm", "base"]);
        let base = git(&["rev-parse", "HEAD"]);
        for (path, bytes) in [
            ("binary.bin", b"\0first\nsecond\n".as_slice()),
            ("legacy.txt", b"\xfffirst\nsecond".as_slice()),
            ("empty.txt", b"".as_slice()),
            ("crlf.txt", b"first\r\nsecond\r\n".as_slice()),
        ] {
            fs::write(repo.join(path), bytes).unwrap();
        }
        let live = super::super::compute_git_changes(repo, &base, None, "node", "exec").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "files"]);
        let after = git(&["rev-parse", "HEAD"]);
        let committed =
            super::super::compute_git_changes(repo, &base, Some(&after), "node", "exec").unwrap();
        assert_eq!(
            committed
                .files
                .iter()
                .map(|file| (file.path.as_str(), file.additions))
                .collect::<Vec<_>>(),
            [
                ("binary.bin", 0),
                ("crlf.txt", 2),
                ("empty.txt", 0),
                ("legacy.txt", 2)
            ]
        );
        assert_eq!(
            live, committed,
            "staging must not invent binary lines or lose non-UTF-8 text lines"
        );
    }

    #[test]
    fn live_untracked_counts_keep_the_read_budget_and_default_binary_probe() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("file");
        fs::write(&file, vec![b'\n'; 256 * 1024]).unwrap();
        assert_eq!(super::super::untracked_additions(&file), Some(256 * 1024));
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_len(256 * 1024 + 1)
            .unwrap();
        assert_eq!(super::super::untracked_additions(&file), None);

        let mut bytes = vec![b'x'; 8001];
        bytes[7999] = 0;
        fs::write(&file, &bytes).unwrap();
        assert_eq!(super::super::untracked_additions(&file), Some(0));
        bytes[7999] = b'x';
        bytes[8000] = 0;
        fs::write(&file, &bytes).unwrap();
        assert_eq!(super::super::untracked_additions(&file), Some(1));
        assert_eq!(
            super::super::untracked_additions(&temp.path().join("missing")),
            None
        );
        assert_eq!(super::super::untracked_additions(temp.path()), None);
    }

    #[cfg(unix)]
    #[test]
    fn live_untracked_symlinks_count_link_text_not_target_contents() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| crate::workspace::git(&repo, args).unwrap();
        git(&["init", "-q"]);
        git(&["commit", "--allow-empty", "-qm", "base"]);
        let base = git(&["rev-parse", "HEAD"]);
        fs::write(temp.path().join("outside.txt"), "one\ntwo\nthree\n").unwrap();
        std::os::unix::fs::symlink("../outside.txt", repo.join("link.txt")).unwrap();
        std::os::unix::fs::symlink("../missing.txt", repo.join("dangling.txt")).unwrap();
        let live = super::super::compute_git_changes(&repo, &base, None, "node", "exec").unwrap();
        assert!(live.files.iter().all(|file| file.additions == 1));
        fs::write(
            temp.path().join("outside.txt"),
            "different target contents\n",
        )
        .unwrap();
        assert_eq!(
            live,
            super::super::compute_git_changes(&repo, &base, None, "node", "exec").unwrap()
        );
        git(&["add", "."]);
        git(&["commit", "-qm", "links"]);
        let after = git(&["rev-parse", "HEAD"]);
        assert_eq!(
            live,
            super::super::compute_git_changes(&repo, &base, Some(&after), "node", "exec").unwrap()
        );
    }

    #[test]
    fn malformed_raw_headers_and_counts_are_not_accepted_as_git_records() {
        for header in [
            ":wrong 100644 a b M",
            ":100644 100644 not-an-oid b M",
            ":100644 100644 a b Modified",
            ":100644 100644 a b A20",
            ":100644 100644 a b M101",
        ] {
            let output = format!("{header}\0file\01\t0\tfile\0");
            assert!(parse(&output, "", "").is_none(), "{header}");
        }
        for counts in ["-\t2", "1\t-", "+1\t0", "0\t+1"] {
            let output = format!(":100644 100644 a b M\0file\0{counts}\tfile\0");
            assert!(parse(&output, "", "").is_none(), "{counts}");
        }
        for code in ["R", "Rxyz", "R101", "C-1"] {
            let output = format!(":100644 100644 a b {code}\0old\0new\00\t0\t\0old\0new\0");
            assert!(parse(&output, "", "").is_none(), "{code}");
        }
    }

    #[test]
    fn valid_status_scores_and_unmerged_duplicate_records_are_supported() {
        let long_oid = "abcdef01".repeat(8);
        for code in ["A", "D", "M", "M100", "T", "U", "X", "B"] {
            let output = format!(":100644 100755 a {long_oid} {code}\0file\00\t0\tfile\0");
            let files = parse(&output, "", "").unwrap_or_else(|| panic!("{code}"));
            assert_eq!(files.len(), 1);
        }
        for (code, status) in [("R097", "renamed"), ("C100", "added")] {
            let output = format!(":100644 100644 a b {code}\0old\0new\00\t0\t\0old\0new\0");
            let files = parse(&output, "", "").unwrap();
            assert_eq!(files["new"].status, status);
            assert_eq!(files["new"].old_path.as_deref(), Some("old"));
        }
        // Git can emit U then M for the same unmerged path, with a zero-count
        // row followed by the actual worktree counts. Keep the final result.
        let output = concat!(
            ":000000 100644 0000000 0000000 U\0file\0",
            ":100644 100644 5ceb74c 0000000 M\0file\0",
            "0\t0\tfile\0",
            "4\t0\tfile\0",
        );
        let files = parse(output, "", "").unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files["file"].status, "modified");
        assert_eq!((files["file"].additions, files["file"].deletions), (4, 0));
    }

    #[test]
    fn git_diff_keeps_live_conflicts_and_committed_mode_only_changes() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        let git = |args: &[&str]| crate::workspace::git(repo, args).unwrap();
        git(&["init", "-q"]);
        git(&["config", "core.autocrlf", "false"]);
        git(&["config", "merge.conflictStyle", "merge"]);
        fs::write(repo.join("conflict.txt"), "base\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "base"]);
        let base = git(&["rev-parse", "HEAD"]);
        git(&["checkout", "-qb", "theirs"]);
        fs::write(repo.join("conflict.txt"), "theirs\n").unwrap();
        git(&["commit", "-qam", "theirs"]);
        git(&["checkout", "-qb", "ours", &base]);
        fs::write(repo.join("conflict.txt"), "ours\n").unwrap();
        git(&["commit", "-qam", "ours"]);
        let before = git(&["rev-parse", "HEAD"]);
        assert!(crate::workspace::git(repo, &["merge", "--no-edit", "theirs"]).is_err());
        let live = super::super::compute_git_changes(repo, &before, None, "", "").unwrap();
        assert_eq!(live.total_files, 1);
        assert_eq!(live.files[0].status, "modified");
        let reference = git(&["diff", "--numstat", "-z", "-M", &before, "--"]);
        let mut parts = reference.split('\t');
        assert_eq!(
            live.total_additions,
            parts.next().unwrap().parse::<usize>().unwrap()
        );
        assert_eq!(
            live.total_deletions,
            parts.next().unwrap().parse::<usize>().unwrap()
        );
        git(&["reset", "--hard", &before]);
        git(&["update-index", "--chmod=+x", "conflict.txt"]);
        git(&["commit", "-qm", "mode only"]);
        let after = git(&["rev-parse", "HEAD"]);
        let mode = super::super::compute_git_changes(repo, &before, Some(&after), "", "").unwrap();
        assert_eq!(mode.total_files, 1);
        assert_eq!(mode.files[0].status, "modified");
        assert_eq!((mode.total_additions, mode.total_deletions), (0, 0));
    }

    #[test]
    fn private_snapshot_diff_uses_graph_git_not_project_history() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        crate::workspace::git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("task.txt"), "before\n").unwrap();
        crate::workspace::git(&source, &["add", "."]).unwrap();
        crate::workspace::git(&source, &["commit", "-qm", "project history"]).unwrap();
        let project_head = crate::workspace::project_git(&source, &["rev-parse", "HEAD"]).unwrap();
        let base = crate::workspace::snapshot_repository(&source).unwrap();
        let node = temp
            .path()
            .join(".grapher-worktrees")
            .join(uuid::Uuid::new_v4().to_string())
            .join("node");
        crate::workspace::prepare(&source, &node, &base, &[]).unwrap();
        fs::write(node.join("task.txt"), "after\nextra\n").unwrap();
        let head = crate::workspace::snapshot_node(&node, &source, "node").unwrap();
        let summary =
            super::super::compute_git_changes(&node, &base, Some(&head), "node", "exec").unwrap();
        assert_eq!(summary.total_files, 1);
        assert_eq!(summary.files[0].path, "task.txt");
        assert_eq!(summary.files[0].status, "modified");
        assert_eq!((summary.total_additions, summary.total_deletions), (2, 1));
        assert_eq!(
            crate::workspace::project_git(&node, &["rev-parse", "HEAD"]).unwrap(),
            project_head
        );
        assert!(crate::workspace::project_git(&node, &["cat-file", "-e", &head]).is_err());
    }
}
