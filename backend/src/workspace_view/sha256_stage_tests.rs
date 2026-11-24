use super::*;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    metadata: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        crate::ensure_test_data_root();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let metadata = temp.path().join("private-git");
        fs::create_dir(&root).unwrap();
        workspace::git(&root, &["init", "-q", "--object-format=sha256"]).unwrap();
        fs::write(root.join("a.txt"), "before").unwrap();
        fs::write(root.join("b.txt"), "second").unwrap();
        workspace::git(&root, &["add", "a.txt", "b.txt"]).unwrap();
        workspace::git(&root, &["commit", "-qm", "user history"]).unwrap();
        workspace::git(
            &root,
            &[
                "--git-dir",
                metadata.to_str().unwrap(),
                "--work-tree",
                root.to_str().unwrap(),
                "init",
                "-q",
                "--object-format=sha256",
            ],
        )
        .unwrap();
        let fixture = Self {
            _temp: temp,
            root,
            metadata,
        };
        bench::legacy_stage(&fixture.root, &fixture.metadata, fixture.entries()).unwrap();
        let tree = fixture.git(&["write-tree"]);
        let commit = fixture.git(&["commit-tree", &tree, "-m", "private baseline"]);
        fixture.git(&["update-ref", "HEAD", &commit]);
        fixture
    }
    fn entries(&self) -> BTreeMap<String, Entry> {
        let mut entries = BTreeMap::new();
        super::super::scan(&self.root, Path::new(""), &mut entries, false).unwrap();
        entries
    }
    fn git(&self, args: &[&str]) -> String {
        let mut command = vec![
            "--git-dir",
            self.metadata.to_str().unwrap(),
            "--work-tree",
            self.root.to_str().unwrap(),
        ];
        command.extend_from_slice(args);
        workspace::git(&self.root, &command).unwrap()
    }
    fn import(&self, input: &[u8]) -> Result<Vec<u8>, String> {
        workspace::git_bytes(
            &self.root,
            &[
                "--git-dir",
                self.metadata.to_str().unwrap(),
                "--work-tree",
                self.root.to_str().unwrap(),
                "fast-import",
                "--quiet",
                "--done",
            ],
            None,
            Some(input),
        )
    }
    fn evidence(&self) -> Vec<Vec<u8>> {
        vec![
            fs::read(self.root.join(".git/index")).unwrap(),
            fs::read(self.root.join(".git/HEAD")).unwrap(),
            workspace::project_git(&self.root, &["for-each-ref"])
                .unwrap()
                .into_bytes(),
            fs::read(self.metadata.join("HEAD")).unwrap(),
            self.git(&["for-each-ref"]).into_bytes(),
        ]
    }
}

#[test]
fn batching_matches_legacy_tree_raw_bytes_paths_modes_and_links() {
    let f = Fixture::new();
    let raw: &[u8] = b"first\r\n\0\xff\nblob\nmark :99\ndata 0\n\nget-mark :99\ndone\n";
    for name in ["- 中文 [literal].txt", "empty"] {
        fs::write(f.root.join(name), if name == "empty" { b"" } else { raw }).unwrap();
    }
    fs::write(
        f.root.join(".gitattributes"),
        "*.txt text eol=crlf filter=reject\n",
    )
    .unwrap();
    workspace::project_git(&f.root, &["config", "filter.reject.clean", "false"]).unwrap();
    workspace::project_git(&f.root, &["config", "filter.reject.required", "true"]).unwrap();
    f.git(&["config", "filter.reject.clean", "false"]);
    f.git(&["config", "filter.reject.required", "true"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in [
            "trailing space ",
            "tab\tand\nnewline",
            "back\\slash",
            "quote\"",
        ] {
            fs::write(f.root.join(name), raw).unwrap();
        }
        fs::set_permissions(f.root.join("a.txt"), fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("trailing space ", f.root.join("link")).unwrap();
    }
    let before = f.evidence();
    bench::legacy_stage(&f.root, &f.metadata, f.entries()).unwrap();
    let expected = f.git(&["write-tree"]);
    let mut imports = 0;
    stage_with(&f.root, &f.metadata, f.entries(), |input| {
        imports += 1;
        f.import(input)
    })
    .unwrap();
    assert_eq!(imports, 1);
    assert_eq!(f.git(&["write-tree"]), expected);
    let actual = workspace::git_bytes(
        &f.root,
        &[
            "--git-dir",
            f.metadata.to_str().unwrap(),
            "show",
            &format!("{expected}:- 中文 [literal].txt"),
        ],
        None,
        None,
    )
    .unwrap();
    assert_eq!(actual, raw);
    assert_eq!(f.evidence(), before);
}

#[test]
fn null_import_oids_are_rejected_before_index_replacement() {
    let f = Fixture::new();
    let before = f.evidence();
    let index = fs::read(f.metadata.join("index")).unwrap();
    let response = format!("{}\n{}\n", "0".repeat(64), "0".repeat(64)).into_bytes();
    let result = stage_with(&f.root, &f.metadata, f.entries(), |_| Ok(response.clone()));
    assert_eq!(
        fs::read(f.metadata.join("index")).unwrap(),
        index,
        "an invalid importer response must not clear the retained private index"
    );
    assert_eq!(result.unwrap_err(), "Invalid SHA-256 blob import response");
    assert_eq!(f.evidence(), before);
}

#[cfg(windows)]
#[test]
fn sha256_staging_retains_exact_index_executable_bits_on_windows() {
    for (singleton, large) in [(false, false), (true, false), (false, true)] {
        let f = Fixture::new();
        if large {
            fs::write(
                f.root.join("a.txt"),
                vec![b'x'; SMALL_BLOB_LIMIT as usize + 1],
            )
            .unwrap();
        }
        f.git(&["config", "core.ignorecase", "true"]);
        f.git(&["update-index", "--chmod=+x", "a.txt"]);
        let before = f.evidence();
        let mut entries = f.entries();
        if singleton {
            entries.retain(|name, _| name == "a.txt");
        }
        stage(&f.root, &f.metadata, entries).unwrap();
        assert!(f
            .git(&["ls-files", "--stage", "--", "a.txt"])
            .starts_with("100755 "));
        // A case-only new spelling must not inherit the old path's bit.
        fs::rename(f.root.join("a.txt"), f.root.join("rename-hop")).unwrap();
        fs::rename(f.root.join("rename-hop"), f.root.join("A.txt")).unwrap();
        stage(&f.root, &f.metadata, f.entries()).unwrap();
        assert!(f
            .git(&["ls-files", "--stage", "--", "A.txt"])
            .starts_with("100644 "));
        assert_eq!(f.evidence(), before);
    }
}

#[cfg(windows)]
#[test]
fn executable_mode_lookup_ignores_conflict_stages_and_keeps_literal_paths() {
    let f = Fixture::new();
    let name = "- 中文 [literal].sh";
    fs::write(f.root.join(name), "script bytes").unwrap();
    stage(&f.root, &f.metadata, f.entries()).unwrap();
    f.git(&["update-index", "--chmod=+x", "--", name]);
    let oid = f.git(&["rev-parse", ":a.txt"]);
    let input = format!(
        "0 {}\ta.txt\0{mode} {oid} 2\ta.txt\0{mode} {oid} 3\ta.txt\0",
        "0".repeat(64),
        mode = "100755"
    );
    workspace::git_bytes(
        &f.root,
        &[
            "--git-dir",
            f.metadata.to_str().unwrap(),
            "--work-tree",
            f.root.to_str().unwrap(),
            "update-index",
            "-z",
            "--index-info",
        ],
        None,
        Some(input.as_bytes()),
    )
    .unwrap();
    assert!(!f.git(&["ls-files", "--unmerged"]).is_empty());
    let before = f.evidence();
    stage(&f.root, &f.metadata, f.entries()).unwrap();
    let records = f.git(&["ls-files", "--stage", "-z"]);
    let modes: BTreeMap<_, _> = records
        .split('\0')
        .filter(|record| !record.is_empty())
        .map(|record| {
            let (header, path) = record.split_once('\t').unwrap();
            (path, header.split_whitespace().next().unwrap())
        })
        .collect();
    assert_eq!(
        modes["a.txt"], "100644",
        "nonzero conflict stages cannot supply the bit"
    );
    assert_eq!(modes[name], "100755");
    assert_eq!(f.evidence(), before);
}

#[cfg(windows)]
#[test]
fn executable_mode_lookup_handles_missing_index_and_refuses_corrupt_index() {
    let f = Fixture::new();
    let before = f.evidence();
    let index = f.metadata.join("index");
    fs::remove_file(&index).unwrap();
    stage(&f.root, &f.metadata, f.entries()).unwrap();
    assert!(f
        .git(&["ls-files", "--stage", "--", "a.txt"])
        .starts_with("100644 "));
    fs::write(&index, b"corrupt graph index").unwrap();
    assert!(stage_with(&f.root, &f.metadata, f.entries(), |_| {
        panic!("an unreadable old index must fail before importing blobs")
    })
    .is_err());
    assert_eq!(fs::read(&index).unwrap(), b"corrupt graph index");
    assert_eq!(f.evidence(), before);
}

#[test]
fn staged_bytes_buffered_across_a_batch_flush_are_revalidated() {
    let f = Fixture::new();
    for index in 0..BATCH_ENTRIES {
        fs::write(
            f.root.join(format!("small-{index:04}")),
            format!("{index:04}"),
        )
        .unwrap();
    }
    // a.txt/b.txt and 126 small files fill the first batch. The next file
    // has already been read into its bounded buffer when that batch flushes.
    let changed = format!("small-{:04}", BATCH_ENTRIES - 2);
    let before = f.evidence();
    let old_index = fs::read(f.metadata.join("index")).unwrap();
    let mut calls = 0;
    let error = stage_with(&f.root, &f.metadata, f.entries(), |input| {
        calls += 1;
        let output = f.import(input)?;
        if calls == 1 {
            fs::write(f.root.join(&changed), "edit").unwrap();
        }
        Ok(output)
    })
    .unwrap_err();
    assert_eq!(calls, 2);
    assert_eq!(error, CHANGED);
    assert_eq!(fs::read(f.metadata.join("index")).unwrap(), old_index);
    assert_eq!(f.evidence(), before);
    stage(&f.root, &f.metadata, f.entries()).unwrap();
    assert_eq!(f.git(&["show", &format!(":{changed}")]), "edit");
    assert_eq!(f.evidence(), before);
}

#[test]
fn changed_buffered_bytes_fail_before_import_and_preserve_indices() {
    let f = Fixture::new();
    let entries = f.entries();
    let before = f.evidence();
    let index = fs::read(f.metadata.join("index")).unwrap();
    fs::write(f.root.join("a.txt"), "after!").unwrap();
    let error = stage_with(&f.root, &f.metadata, entries, |_| {
        panic!("must validate bytes before import")
    })
    .unwrap_err();
    assert_eq!(error, CHANGED);
    assert_eq!(fs::read(f.metadata.join("index")).unwrap(), index);
    assert_eq!(f.evidence(), before);
}

#[test]
fn mutation_after_import_is_reread_before_index_replacement_and_retry_succeeds() {
    let f = Fixture::new();
    let before = f.evidence();
    let index = fs::read(f.metadata.join("index")).unwrap();
    let error = stage_with(&f.root, &f.metadata, f.entries(), |input| {
        let output = f.import(input)?;
        fs::write(f.root.join("a.txt"), "after!").unwrap();
        Ok(output)
    })
    .unwrap_err();
    assert_eq!(error, CHANGED);
    assert_eq!(fs::read(f.metadata.join("index")).unwrap(), index);
    assert_eq!(f.evidence(), before);
    stage(&f.root, &f.metadata, f.entries()).unwrap();
    let actual = f.git(&["write-tree"]);
    bench::legacy_stage(&f.root, &f.metadata, f.entries()).unwrap();
    assert_eq!(f.git(&["write-tree"]), actual);
    assert_eq!(f.evidence(), before);
}

#[test]
fn importer_failure_and_malformed_responses_leave_index_and_refs_untouched() {
    let f = Fixture::new();
    let before = f.evidence();
    let index = fs::read(f.metadata.join("index")).unwrap();
    for output in [
        Err("injected importer failure".to_string()),
        Ok(Vec::new()),
        Ok(vec![0xff]),
        Ok(format!("{}\n", "a".repeat(64)).into_bytes()),
        Ok(format!("{}\n{}\n", "a".repeat(40), "b".repeat(40)).into_bytes()),
        Ok(format!("{}\n{}\n", "x".repeat(64), "b".repeat(64)).into_bytes()),
    ] {
        assert!(stage_with(&f.root, &f.metadata, f.entries(), |_| output.clone()).is_err());
        assert_eq!(fs::read(f.metadata.join("index")).unwrap(), index);
        assert_eq!(f.evidence(), before);
    }
    // Exercise a real child failure too: --done must reject truncated input,
    // even if that process already wrote some private, unreferenced objects.
    assert!(stage_with(&f.root, &f.metadata, f.entries(), |input| {
        f.import(&input[..input.len() - b"done\n".len()])
    })
    .is_err());
    assert_eq!(fs::read(f.metadata.join("index")).unwrap(), index);
    assert_eq!(f.evidence(), before);
    stage(&f.root, &f.metadata, f.entries()).unwrap();
    assert_eq!(f.evidence(), before);
}

#[test]
fn bounded_batches_survive_count_and_byte_limits_and_a_late_failure() {
    let f = Fixture::new();
    for index in 0..BATCH_ENTRIES + 1 {
        fs::write(f.root.join(format!("small-{index:04}")), index.to_string()).unwrap();
    }
    let before = f.evidence();
    let old_index = fs::read(f.metadata.join("index")).unwrap();
    let mut calls = 0;
    let error = stage_with(&f.root, &f.metadata, f.entries(), |input| {
        calls += 1;
        if calls == 2 {
            return Err("second batch failed".into());
        }
        f.import(input)
    })
    .unwrap_err();
    assert_eq!(error, "second batch failed");
    assert_eq!(calls, 2);
    assert_eq!(fs::read(f.metadata.join("index")).unwrap(), old_index);
    assert_eq!(f.evidence(), before);
    // Also exercise the byte cap, not only the record-count cap.
    for index in 0..9 {
        let mut bytes = vec![b'x'; SMALL_BLOB_LIMIT as usize];
        bytes[..4].copy_from_slice(&(index as u32).to_le_bytes());
        fs::write(f.root.join(format!("medium-{index:04}")), bytes).unwrap();
    }
    calls = 0;
    stage_with(&f.root, &f.metadata, f.entries(), |input| {
        calls += 1;
        assert!(input.len() <= BATCH_BYTES + BATCH_ENTRIES * 100 + 5);
        f.import(input)
    })
    .unwrap();
    assert!(calls >= 3);
    assert_eq!(
        f.git(&["ls-files", "-z"])
            .split('\0')
            .filter(|s| !s.is_empty())
            .count(),
        BATCH_ENTRIES + 12
    );
    assert_eq!(f.evidence(), before);
}

#[test]
fn empty_and_singleton_staging_do_not_start_an_importer() {
    let f = Fixture::new();
    let before = f.evidence();
    let mut entries = f.entries();
    entries.retain(|name, _| name == "a.txt");
    stage_with(&f.root, &f.metadata, entries, |_| {
        panic!("singleton should stream normally")
    })
    .unwrap();
    assert_eq!(f.git(&["ls-files"]), "a.txt");
    stage_with(&f.root, &f.metadata, BTreeMap::new(), |_| {
        panic!("empty staging needs no blobs")
    })
    .unwrap();
    assert!(f.git(&["ls-files"]).is_empty());
    assert_eq!(f.evidence(), before);
}

#[test]
fn large_files_keep_streaming_and_bounded_reads_do_not_grow_without_limit() {
    let f = Fixture::new();
    let large = f.root.join("large");
    fs::write(&large, vec![b'z'; SMALL_BLOB_LIMIT as usize + 1]).unwrap();
    let entries = f.entries();
    let Entry::File { blob, .. } = &entries["large"] else {
        panic!("file observation")
    };
    assert!(read_small("large", &large, blob).unwrap().is_none());
    bench::legacy_stage(&f.root, &f.metadata, entries.clone()).unwrap();
    let expected = f.git(&["write-tree"]);
    stage(&f.root, &f.metadata, entries).unwrap();
    assert_eq!(f.git(&["write-tree"]), expected);
}
