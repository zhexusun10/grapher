use super::*;
use std::time::{Duration, Instant};

fn repository(root: &Path, format: &str) {
    fs::create_dir_all(root).unwrap();
    workspace::git(root, &["init", "-q", &format!("--object-format={format}")]).unwrap();
    workspace::project_git(root, &["config", "user.name", "Index Test"]).unwrap();
    workspace::project_git(root, &["config", "user.email", "index@example.invalid"]).unwrap();
    workspace::project_git(root, &["config", "core.autocrlf", "false"]).unwrap();
    fs::write(root.join("tracked.txt"), "committed\n").unwrap();
    workspace::project_git(root, &["add", "tracked.txt"]).unwrap();
    workspace::project_git(root, &["commit", "-qm", "base"]).unwrap();
}

fn empty_flags_index(root: &Path, wanted: &Index) {
    workspace::project_git(root, &["read-tree", "--empty"]).unwrap();
    let mut input = Vec::new();
    for (name, item) in wanted {
        append_index_info(&mut input, &item.mode, &item.oid, name);
    }
    workspace::project_git_bytes(root, &["update-index", "-z", "--index-info"], Some(&input)).unwrap();
}

fn per_path_flags(root: &Path, wanted: &Index) {
    for (name, item) in wanted {
        workspace::project_git(root, &["update-index", if item.flags & 0x8000 != 0 {
            "--assume-unchanged"
        } else { "--no-assume-unchanged" }, "--", name]).unwrap();
        workspace::project_git(root, &["update-index", if item.flags & 0x4000_0000 != 0 {
            "--skip-worktree"
        } else { "--no-skip-worktree" }, "--", name]).unwrap();
    }
}

#[test]
fn batched_flags_preserve_literal_paths_and_all_flag_combinations() {
    for format in ["sha1", "sha256"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        repository(&root, format);
        // Force-add also keeps intent-to-add files beneath ignored paths.
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir(root.join("ignored")).unwrap();
        let names = vec![
            "- leading file".to_string(), "wild[1].txt".into(), "中文.txt".into(),
            "both flags".into(), "ignored/intent.txt".into(), "intent assume".into(),
            "intent skip".into(), "intent both".into(),
        ];
        #[cfg(unix)]
        let names: Vec<_> = names.into_iter().chain(
            ["colon:literal", "tab\tand\nnewline", "back\\slash", ":(glob)*"].map(str::to_string),
        ).collect();
        for (i, name) in names.iter().enumerate() {
            fs::write(root.join(name), format!("data {i}\n")).unwrap();
            let literal = format!(":(literal){name}");
            let args = if i & 4 != 0 { vec!["add", "-f", "-N", "--", &literal] }
                else { vec!["add", "-f", "--", &literal] };
            workspace::project_git(&root, &args).unwrap();
            if i & 1 != 0 {
                workspace::project_git(&root, &["update-index", "--assume-unchanged", "--", name]).unwrap();
            }
            if i & 2 != 0 {
                workspace::project_git(&root, &["update-index", "--skip-worktree", "--", name]).unwrap();
            }
        }
        let wanted = index(&root.join(".git")).unwrap();
        empty_flags_index(&root, &wanted);
        restore_flags(&root, wanted.iter().map(|(name, item)| (name.as_str(), item.flags))).unwrap();
        assert_eq!(index(&root.join(".git")).unwrap(), wanted, "{format}");

        // The retained per-file implementation is an independent oracle for
        // ordinary/assume/skip/both flags, including clearing selected flags.
        let ordinary: Index = wanted.into_iter().filter(|(_, item)| item.flags & 0x2000_0000 == 0).collect();
        empty_flags_index(&root, &ordinary);
        per_path_flags(&root, &ordinary);
        assert_eq!(index(&root.join(".git")).unwrap(), ordinary);
        empty_flags_index(&root, &ordinary);
        restore_flags(&root, ordinary.iter().map(|(name, item)| (name.as_str(), item.flags))).unwrap();
        assert_eq!(index(&root.join(".git")).unwrap(), ordinary);

        // A foreign index lock must fail the batch without being adopted or
        // removed, and without claiming that the requested flags survived.
        let before = fs::read(root.join(".git/index")).unwrap();
        let lock = root.join(".git/index.lock");
        fs::write(&lock, "foreign lock").unwrap();
        let error = restore_flags(&root, [("tracked.txt", 0x8000)]).unwrap_err();
        assert!(error.contains("git"), "{error}");
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), before);
        assert_eq!(fs::read_to_string(&lock).unwrap(), "foreign lock");
        fs::remove_file(lock).unwrap();
    }
}

#[test]
fn batched_intent_flags_preserve_missing_worktree_files_and_index_modes() {
    for format in ["sha1", "sha256"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        repository(&root, format);
        let names = ["missing [literal]", "missing executable"];
        for name in names {
            fs::write(root.join(name), "uncommitted\n").unwrap();
            workspace::project_git(&root, &[
                "add", "-N", if name == "missing executable" { "--chmod=+x" } else { "--chmod=-x" },
                "--", &format!(":(literal){name}"),
            ]).unwrap();
            fs::remove_file(root.join(name)).unwrap();
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("not present", root.join("missing link")).unwrap();
            workspace::project_git(&root, &["add", "-N", "missing link"]).unwrap();
            fs::remove_file(root.join("missing link")).unwrap();
        }
        let wanted = index(&root.join(".git")).unwrap();
        assert!(names.iter().all(|name| wanted[*name].flags & 0x2000_0000 != 0));
        assert_eq!(wanted["missing executable"].mode, "100755");
        empty_flags_index(&root, &wanted);
        let head = workspace::project_git(&root, &["rev-parse", "HEAD"]).unwrap();
        let metadata_names = || fs::read_dir(root.join(".git")).unwrap()
            .map(|item| item.unwrap().file_name()).collect::<BTreeSet<_>>();
        let before_names = metadata_names();
        let before_index = fs::read(root.join(".git/index")).unwrap();
        fs::write(root.join(".git/index.lock"), "foreign lock").unwrap();
        assert!(restore_flags(&root, wanted.iter().map(|(name, item)| (name.as_str(), item.flags))).is_err());
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), before_index);
        assert_eq!(fs::read_to_string(root.join(".git/index.lock")).unwrap(), "foreign lock");
        fs::remove_file(root.join(".git/index.lock")).unwrap();
        assert_eq!(metadata_names(), before_names, "failed restoration must retire its scratch");
        restore_flags(&root, wanted.iter().map(|(name, item)| (name.as_str(), item.flags))).unwrap();
        assert_eq!(metadata_names(), before_names, "successful restoration must retire its scratch");
        assert_eq!(index(&root.join(".git")).unwrap(), wanted, "{format}");
        assert!(names.iter().all(|name| !root.join(name).exists()));
        assert!(fs::symlink_metadata(root.join("missing link")).is_err());
        assert_eq!(workspace::project_git(&root, &["rev-parse", "HEAD"]).unwrap(), head);
        assert!(!root.join(".git/ORIG_HEAD").exists());
    }
}

#[test]
fn composition_preserves_staging_deletions_and_clears_selected_flags() {
    for format in ["sha1", "sha256"] {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("base");
        repository(&base, format);
        for name in ["clear flags", "delete.txt", "unchanged"] {
            fs::write(base.join(name), name).unwrap();
        }
        workspace::project_git(&base, &["add", "-A"]).unwrap();
        workspace::project_git(&base, &["commit", "-qm", "more paths"]).unwrap();
        workspace::project_git(&base, &["update-index", "--assume-unchanged", "clear flags"]).unwrap();
        workspace::project_git(&base, &["update-index", "--skip-worktree", "clear flags"]).unwrap();
        let input = temp.path().join("input");
        let target = temp.path().join("target");
        for path in [&input, &target] {
            workspace::project_git(temp.path(), &["clone", "-q", base.to_str().unwrap(), path.to_str().unwrap()]).unwrap();
            fs::write(path.join("new [literal]"), b"staged\0binary\xff\r\n").unwrap();
            fs::write(path.join("intent"), "not staged yet").unwrap();
        }
        // --index-info inherits core.ignorestat when creating cache entries.
        // The target's configuration must not invent flags absent from inputs.
        workspace::project_git(&target, &["config", "core.ignorestat", "true"]).unwrap();
        workspace::project_git(&input, &["add", "new [literal]"]).unwrap();
        workspace::project_git(&input, &["add", "-N", "intent"]).unwrap();
        workspace::project_git(&input, &["update-index", "--assume-unchanged", "new [literal]"]).unwrap();
        workspace::project_git(&input, &["update-index", "--skip-worktree", "new [literal]"]).unwrap();
        workspace::project_git(&input, &["rm", "-q", "delete.txt"]).unwrap();
        let baseline_bytes = fs::read(base.join(".git/index")).unwrap();
        let input_bytes = fs::read(input.join(".git/index")).unwrap();
        let target_bytes = fs::read(target.join(".git/index")).unwrap();
        let foreign_lock = target.join(".git/index.lock");
        fs::write(&foreign_lock, "foreign lock").unwrap();
        assert!(compose(&target, &base.join(".git"), &[input.join(".git")], &base.join(".git")).is_err());
        assert_eq!(fs::read(target.join(".git/index")).unwrap(), target_bytes,
            "even the initial selected-index copy must respect a foreign lock");
        assert_eq!(fs::read_to_string(&foreign_lock).unwrap(), "foreign lock");
        fs::remove_file(foreign_lock).unwrap();
        compose(&target, &base.join(".git"), &[input.join(".git")], &base.join(".git")).unwrap();
        assert_eq!(index(&target.join(".git")).unwrap(), index(&input.join(".git")).unwrap());
        assert_eq!(workspace::project_git_bytes(&target, &["show", ":new [literal]"], None).unwrap(), b"staged\0binary\xff\r\n");
        assert_eq!(fs::read(base.join(".git/index")).unwrap(), baseline_bytes);
        assert_eq!(fs::read(input.join(".git/index")).unwrap(), input_bytes);
        // Retrying preserves the same logical state and does not consume inputs.
        compose(&target, &base.join(".git"), &[input.join(".git")], &base.join(".git")).unwrap();
        assert_eq!(index(&target.join(".git")).unwrap(), index(&input.join(".git")).unwrap());
        assert_eq!(workspace::project_git(&target, &["config", "core.ignorestat"]).unwrap(), "true");
    }
}

#[test]
fn selected_index_install_preserves_retained_bytes_on_error_and_handles_absence() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo");
    repository(&root, "sha1");
    let index = root.join(".git/index");
    let lock = root.join(".git/index.lock");
    let original = fs::read(&index).unwrap();
    let backup = temp.path().join("selected-index");
    fs::write(&backup, &original).unwrap();
    let invalid = temp.path().join("invalid-index-directory");
    fs::create_dir(&invalid).unwrap();
    assert!(install_selected_index(&invalid, &index).is_err());
    assert_eq!(fs::read(&index).unwrap(), original);
    assert!(!lock.exists(), "failed copies must release only their own lock");

    let missing = temp.path().join("unborn-index");
    fs::write(&lock, "foreign lock").unwrap();
    assert!(install_selected_index(&missing, &index).is_err());
    assert_eq!(fs::read(&index).unwrap(), original);
    assert_eq!(fs::read_to_string(&lock).unwrap(), "foreign lock");
    fs::remove_file(&lock).unwrap();
    for _ in 0..2 { install_selected_index(&missing, &index).unwrap(); }
    assert!(!index.exists());
    assert!(!lock.exists());
    install_selected_index(&backup, &index).unwrap();
    assert_eq!(fs::read(&index).unwrap(), original);
    assert_eq!(fs::read(backup).unwrap(), original);
    assert!(!lock.exists());
}

#[test]
fn fast_path_keeps_intent_on_a_committed_empty_file() {
    for format in ["sha1", "sha256"] {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("base");
        repository(&base, format);
        fs::write(base.join("empty [literal]"), []).unwrap();
        workspace::project_git(&base, &["add", "--", ":(literal)empty [literal]"]).unwrap();
        workspace::project_git(&base, &["commit", "-qm", "empty file"]).unwrap();
        let input = temp.path().join("input");
        let target = temp.path().join("target");
        for path in [&input, &target] {
            workspace::project_git(temp.path(), &["clone", "-q", base.to_str().unwrap(), path.to_str().unwrap()]).unwrap();
        }
        workspace::project_git(&input, &["rm", "--cached", "--", ":(literal)empty [literal]"]).unwrap();
        workspace::project_git(&input, &["add", "-N", "--", ":(literal)empty [literal]"]).unwrap();
        // Contents/mode still match HEAD and `ls-files -v` tags this with H,
        // but the intent-to-add bit remains meaningful staged state.
        let wanted = index(&input.join(".git")).unwrap();
        assert_ne!(wanted["empty [literal]"].flags & 0x2000_0000, 0);
        let original_base = fs::read(base.join(".git/index")).unwrap();
        let original_input = fs::read(input.join(".git/index")).unwrap();
        for _ in 0..2 {
            compose(&target, &base.join(".git"), &[input.join(".git")], &base.join(".git")).unwrap();
            assert_eq!(index(&target.join(".git")).unwrap(), wanted, "{format}");
        }
        assert_eq!(fs::read(base.join(".git/index")).unwrap(), original_base);
        assert_eq!(fs::read(input.join(".git/index")).unwrap(), original_input);
        assert_eq!(fs::read(target.join("empty [literal]")).unwrap(), b"");
    }
}

#[test]
fn intent_restoration_ignores_sparse_checkout_selection() {
    for format in ["sha1", "sha256"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        repository(&root, format);
        fs::create_dir(root.join("excluded")).unwrap();
        fs::write(root.join("excluded/intent"), "unfinished\n").unwrap();
        workspace::project_git(&root, &["add", "-N", "excluded/intent"]).unwrap();
        fs::remove_file(root.join("excluded/intent")).unwrap();
        let wanted = index(&root.join(".git")).unwrap();
        workspace::project_git(&root, &["config", "core.sparseCheckout", "true"]).unwrap();
        workspace::project_git(&root, &["config", "core.sparseCheckoutCone", "false"]).unwrap();
        let patterns = root.join(".git/info/sparse-checkout");
        fs::write(&patterns, "/included/\n").unwrap();
        let config = fs::read(root.join(".git/config")).unwrap();
        for _ in 0..2 {
            empty_flags_index(&root, &wanted);
            restore_flags(&root, wanted.iter().map(|(name, item)| (name.as_str(), item.flags))).unwrap();
            assert_eq!(index(&root.join(".git")).unwrap(), wanted, "{format}");
        }
        assert!(!root.join("excluded/intent").exists());
        assert_eq!(fs::read(root.join(".git/config")).unwrap(), config);
        assert_eq!(fs::read_to_string(patterns).unwrap(), "/included/\n");
    }
}

#[test]
fn intent_restoration_preserves_byte_exact_case_aliases() {
    for format in ["sha1", "sha256"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        repository(&root, format);
        workspace::project_git(&root, &["config", "core.ignorecase", "false"]).unwrap();
        let names = [
            ("Case", false), ("case", true),
            ("Dir/left", false), ("dir/right", true),
            ("nested/A/one", true), ("nested/a/two", false),
            ("Ä/left", false), ("ä/right", true),
        ];
        // Git can retain both spellings even on a case-folding filesystem:
        // each path is added, then removed from disk before adding its alias.
        for (i, (name, executable)) in names.into_iter().enumerate() {
            let file = root.join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, "unfinished\n").unwrap();
            workspace::project_git(&root, &[
                "add", "-N", if executable { "--chmod=+x" } else { "--chmod=-x" },
                "--", &format!(":(literal){name}"),
            ]).unwrap();
            if i & 1 != 0 {
                workspace::project_git(&root, &["update-index", "--assume-unchanged", "--", name]).unwrap();
            }
            if i & 2 != 0 {
                workspace::project_git(&root, &["update-index", "--skip-worktree", "--", name]).unwrap();
            }
            fs::remove_file(&file).unwrap();
            let mut parent = file.parent().unwrap();
            while parent != root {
                fs::remove_dir(parent).unwrap();
                parent = parent.parent().unwrap();
            }
        }
        let wanted = index(&root.join(".git")).unwrap();
        assert_eq!(wanted.len(), names.len() + 1);
        workspace::project_git(&root, &["config", "core.ignorecase", "true"]).unwrap();
        let config = fs::read(root.join(".git/config")).unwrap();
        for _ in 0..2 {
            empty_flags_index(&root, &wanted);
            restore_flags(&root, wanted.iter().map(|(name, item)| (name.as_str(), item.flags))).unwrap();
            assert_eq!(index(&root.join(".git")).unwrap(), wanted, "{format}");
            assert!(names.iter().all(|(name, _)| fs::symlink_metadata(root.join(name)).is_err()));
        }
        assert_eq!(fs::read(root.join(".git/config")).unwrap(), config);
        assert_eq!(fs::read(root.join("tracked.txt")).unwrap(), b"committed\n");
    }
}

#[test]
#[ignore = "local index-flag batching probe; run explicitly with --ignored --nocapture"]
fn index_flag_batching_benchmark() {
    fn median(mut times: Vec<Duration>) -> Duration {
        times.sort();
        times[times.len() / 2]
    }
    for (label, count, flagged) in [("ordinary", 64, false), ("flagged", 64, true), ("larger_flagged", 256, true)] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        repository(&root, "sha1");
        for i in 0..count {
            fs::write(root.join(format!("file-{i:04}")), "data\n").unwrap();
        }
        workspace::project_git(&root, &["add", "-A"]).unwrap();
        let mut wanted = index(&root.join(".git")).unwrap();
        if flagged {
            for (i, item) in wanted.values_mut().enumerate() {
                item.flags = [0, 0x8000, 0x4000_0000, 0x4000_8000][i % 4];
            }
        }
        let mut times = [Vec::new(), Vec::new()];
        for round in 0..3 {
            for strategy in if round % 2 == 0 { [0, 1] } else { [1, 0] } {
                empty_flags_index(&root, &wanted);
                let start = Instant::now();
                if strategy == 0 { per_path_flags(&root, &wanted); } else {
                    restore_flags(&root, wanted.iter().map(|(name, item)| (name.as_str(), item.flags))).unwrap();
                }
                times[strategy].push(start.elapsed());
                assert_eq!(index(&root.join(".git")).unwrap(), wanted);
            }
        }
        let [old, batched] = times.map(median);
        println!("index flags {label}: paths={}, per_path={old:?}, batched={batched:?}", wanted.len());
    }
}
