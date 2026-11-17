// Full-byte sealing reuse, not package reconstruction or a new inheritance path.
use super::rooted_tests::fixture;
use super::*;

fn targets(parent: &Path, name: &str) -> BTreeMap<String, PathBuf> {
    ["workspace", "state"]
        .into_iter()
        .map(|label| {
            let path = parent.join(name).join(label);
            fs::create_dir_all(&path).unwrap();
            (label.into(), path)
        })
        .collect()
}

#[test]
fn rooted_sealing_noop_keeps_store_constant_but_records_patch_mode_and_coverage_changes() {
    let (_temp, files, paths, mut layouts) = fixture();
    let base = Uuid::new_v4().to_string();
    files.capture_roots(&paths, &layouts, &base, &[]).unwrap();
    let stored = stored_files(&files);
    for _ in 0..4 {
        assert_eq!(
            files
                .capture_roots_reusing(&paths, &layouts, &base)
                .unwrap(),
            base
        );
    }
    fs::write(
        paths["state"].join(".agent-home/cache/value"),
        "new excluded cache",
    )
    .unwrap();
    assert_eq!(
        files
            .capture_roots_reusing(&paths, &layouts, &base)
            .unwrap(),
        base
    );
    assert_eq!(stored_files(&files), stored);
    assert!(
        files.capture_reusing(&paths["workspace"], &base).is_err(),
        "cannot collapse W/S into a single root"
    );

    // Mode-only edits remain evidence even when bytes are identical.
    let file = paths["workspace"].join("env/value");
    let original = fs::metadata(&file).unwrap().permissions();
    let mut changed_mode = original.clone();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        changed_mode.set_mode(original.mode() ^ 0o100);
    }
    #[cfg(windows)]
    changed_mode.set_readonly(!original.readonly());
    fs::set_permissions(&file, changed_mode).unwrap();
    let mode_ref = files
        .capture_roots_reusing(&paths, &layouts, &base)
        .unwrap();
    assert_ne!(mode_ref, base);
    files.verify_roots(&paths, &mode_ref).unwrap();
    fs::set_permissions(&file, original).unwrap();

    let modified = fs::metadata(&file).unwrap().modified().unwrap();
    fs::write(&file, "node-edit").unwrap(); // same length as "workspace"
    fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let edited = files
        .capture_roots_reusing(&paths, &layouts, &base)
        .unwrap();
    assert_ne!(
        edited, base,
        "same size/mtime cannot authorize live-byte reuse"
    );
    files.verify_roots(&paths, &edited).unwrap();
    fs::write(&file, "workspace").unwrap();
    fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(modified)
        .unwrap();

    // No manifest or package manager is needed to preserve installed local edits.
    fs::write(
        paths["workspace"].join("env/local-patch"),
        "offline dependency patch",
    )
    .unwrap();
    let patched = files
        .capture_roots_reusing(&paths, &layouts, &base)
        .unwrap();
    assert_ne!(patched, base);
    assert_eq!(files.load(&patched).unwrap().parents, std::slice::from_ref(&base));
    files.verify_roots(&paths, &patched).unwrap();
    let before_scope = stored_files(&files);
    layouts
        .get_mut("workspace")
        .unwrap()
        .scopes
        .push("new-owned-absent".into());
    layouts.insert(
        "workspace".into(),
        RootScope::normalized(layouts["workspace"].scopes.clone(), vec![]),
    );
    let scoped = files
        .capture_roots_reusing(&paths, &layouts, &patched)
        .unwrap();
    assert_ne!(
        scoped, patched,
        "recorded absence/root coverage is not byte equality alone"
    );
    for (path, bytes) in &before_scope {
        assert_eq!(&fs::read(path).unwrap(), bytes);
    }
    for (path, bytes) in &stored {
        assert_eq!(&fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn rooted_sealing_never_reuses_cross_operation_proof_or_repairs_parent_from_live_bytes() {
    for missing in [false, true] {
        let (_temp, files, paths, layouts) = fixture();
        let base = Uuid::new_v4().to_string();
        files.capture_roots(&paths, &layouts, &base, &[]).unwrap();
        // Warm all code paths before damage. Proof must not survive any call.
        files.validate(std::slice::from_ref(&base)).unwrap();
        files.verify_roots(&paths, &base).unwrap();
        assert_eq!(
            files
                .capture_roots_reusing(&paths, &layouts, &base)
                .unwrap(),
            base
        );
        let value = files.load(&base).unwrap();
        let Entry::File { blob, .. } =
            &value.rooted.unwrap().roots["workspace"].entries["env/value"]
        else {
            panic!()
        };
        let blob = files.blob_path(blob).unwrap();
        if missing {
            fs::remove_file(&blob).unwrap();
        } else {
            let modified = fs::metadata(&blob).unwrap().modified().unwrap();
            fs::write(&blob, "damaged!!").unwrap(); // same length as "workspace"
            fs::File::options()
                .write(true)
                .open(&blob)
                .unwrap()
                .set_modified(modified)
                .unwrap();
        }
        let stored = stored_files(&files);
        assert!(files.validate(std::slice::from_ref(&base)).is_err());
        assert!(files.verify_roots(&paths, &base).is_err());
        let error = files
            .capture_roots_reusing(&paths, &layouts, &base)
            .unwrap_err();
        assert!(
            error.contains(if missing {
                "Missing workspace file blob"
            } else {
                "Damaged workspace file blob"
            }),
            "{error}"
        );
        assert_eq!(stored_files(&files), stored);
        assert_eq!(
            fs::read_to_string(paths["workspace"].join("env/value")).unwrap(),
            "workspace"
        );
    }
}

#[test]
fn rooted_sealing_checks_existing_blobs_not_referenced_by_the_parent() {
    for redirected in [false, true] {
        let (_temp, files, paths, layouts) = fixture();
        let base = Uuid::new_v4().to_string();
        files.capture_roots(&paths, &layouts, &base, &[]).unwrap();
        let parent = Uuid::new_v4().to_string();
        files.capture_empty(&parent).unwrap();
        // Parent preflight cannot establish proof for these existing blobs.
        // Both the production and unbatched capture must check path and bytes.
        let blob_directory = files.directory.join("blobs");
        let backup = files.directory.join("saved-blobs");
        if redirected {
            fs::rename(&blob_directory, &backup).unwrap();
            crate::path_safety::directory_link(&backup, &blob_directory);
        } else {
            let value = files.load(&base).unwrap();
            let Entry::File { blob, .. } =
                &value.rooted.as_ref().unwrap().roots["workspace"].entries["env/value"]
            else {
                panic!()
            };
            fs::write(files.blob_path(blob).unwrap(), "damaged!!").unwrap();
        }
        let stored = stored_files(&files);
        for optimized in [false, true] {
            let error = if optimized {
                files.capture_roots_reusing(&paths, &layouts, &parent)
            } else {
                files.capture_roots_unbatched(&paths, &layouts, &parent)
            }.unwrap_err();
            assert!(
                error.contains(if redirected { "Refusing" } else { "Damaged workspace file blob" }),
                "{error}"
            );
            assert_eq!(stored_files(&files), stored);
        }
        if redirected {
            crate::path_safety::remove_directory_link(&blob_directory);
            fs::rename(backup, blob_directory).unwrap();
        }
    }
}

#[test]
fn rooted_sealing_concurrent_writers_keep_independent_views_and_append_only_parent_evidence() {
    let (temp, files, paths, layouts) = fixture();
    let base = Uuid::new_v4().to_string();
    files.capture_roots(&paths, &layouts, &base, &[]).unwrap();
    let original = stored_files(&files);
    let branches: Vec<_> = ["a", "b"]
        .into_iter()
        .map(|name| {
            let branch = targets(temp.path(), name);
            files.materialize_roots(&branch, &base).unwrap();
            (name, branch)
        })
        .collect();
    fs::write(
        paths["workspace"].join("env/value"),
        "source changed after snapshot",
    )
    .unwrap();
    let barrier = std::sync::Barrier::new(2);
    let refs = std::thread::scope(|scope| {
        branches
            .iter()
            .map(|(name, branch)| {
                let (files, layouts, base, barrier) = (&files, &layouts, &base, &barrier);
                scope.spawn(move || {
                    fs::write(
                        branch["workspace"].join("env/value"),
                        format!("patch {name}"),
                    )
                    .unwrap();
                    fs::write(branch["state"].join(".agent-home/config"), name).unwrap();
                    barrier.wait();
                    files.capture_roots_reusing(branch, layouts, base).unwrap()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_ne!(refs[0], refs[1]);
    for ((_, branch), reference) in branches.iter().zip(&refs) {
        assert_eq!(
            files.load(reference).unwrap().parents,
            std::slice::from_ref(&base)
        );
        files.verify_roots(branch, reference).unwrap();
        assert_eq!(
            files
                .capture_roots_reusing(branch, &layouts, reference)
                .unwrap(),
            *reference
        );
    }
    for (path, bytes) in original {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    fs::write(
        branches[0].1["workspace"].join("env/value"),
        "mutable A only",
    )
    .unwrap();
    assert!(files.verify_roots(&branches[0].1, &refs[0]).is_err());
    files.verify_roots(&branches[1].1, &refs[1]).unwrap();
    let restored = targets(temp.path(), "restored");
    files.materialize_roots(&restored, &base).unwrap();
    files.verify_roots(&restored, &base).unwrap();
    assert_eq!(
        fs::read_to_string(restored["workspace"].join("env/value")).unwrap(),
        "workspace"
    );
}

fn store_size(files: &Files) -> serde_json::Value {
    let mut count = 0u64;
    let mut bytes = 0u64;
    for directory in ["blobs", "versions"] {
        for entry in fs::read_dir(files.directory.join(directory)).unwrap() {
            count += 1;
            bytes += entry.unwrap().metadata().unwrap().len();
        }
    }
    serde_json::json!({"files":count,"logicalBytes":bytes})
}

#[test]
#[ignore = "opt-in dependency sealing cost comparison; not native sandbox acceptance"]
fn environment_dependency_sealing_benchmark() {
    use std::time::Instant;
    let mut samples = Vec::new();
    for (count, unique, bytes, shared) in [
        (128, 128, 4096, false),
        (512, 16, 4096, true),
        (64, 8, 1024 * 1024, true),
    ] {
        for sample in 0..3 {
            let order = if sample % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            };
            for optimized in order {
                let (temp, files, paths, layouts) = fixture();
                for (label, path) in &paths {
                    fs::create_dir(path.join("env/dependencies")).unwrap();
                    for index in 0..count {
                        let mut data = vec![b'x'; bytes];
                        let owner = if shared { "" } else { label.as_str() };
                        let identity =
                            format!("offline installed dependency {owner} {:04}", index % unique);
                        data[..identity.len()].copy_from_slice(identity.as_bytes());
                        fs::write(path.join(format!("env/dependencies/{index:04}")), data).unwrap();
                    }
                }
                let base = Uuid::new_v4().to_string();
                files.capture_roots(&paths, &layouts, &base, &[]).unwrap();
                let manifest = fs::read(files.version_path(&base).unwrap()).unwrap();
                let before = store_size(&files);
                let seal = |roots: &BTreeMap<String, PathBuf>, parent: &str| {
                    if optimized {
                        files
                            .capture_roots_reusing(roots, &layouts, parent)
                            .unwrap()
                    } else {
                        files
                            .capture_roots_unbatched(roots, &layouts, parent)
                            .unwrap()
                    }
                };
                let mut unchanged_ms = Vec::new();
                for _ in 0..3 {
                    let start = Instant::now();
                    assert_eq!(seal(&paths, &base), base);
                    unchanged_ms.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                let after_noop = store_size(&files);
                if optimized {
                    assert_eq!(after_noop, before);
                }
                fs::write(paths["workspace"].join("env/value"), "explicit local patch").unwrap();
                let start = Instant::now();
                let changed = seal(&paths, &base);
                let changed_ms = start.elapsed().as_secs_f64() * 1000.0;
                assert_ne!(changed, base);
                files.verify_roots(&paths, &changed).unwrap();
                // Include a replacement-heavy case: full parent validation can
                // add work when old dependency blobs are no longer in the live
                // candidate. Do not report only favorable no-op/local-edit data.
                let before_rewrite = store_size(&files);
                for (label, path) in &paths {
                    for index in 0..count {
                        let mut data = vec![b'y'; bytes];
                        let owner = if shared { "" } else { label.as_str() };
                        let identity = format!(
                            "rewritten installed dependency {owner} {:04}",
                            index % unique
                        );
                        data[..identity.len()].copy_from_slice(identity.as_bytes());
                        fs::write(path.join(format!("env/dependencies/{index:04}")), data).unwrap();
                    }
                }
                let start = Instant::now();
                let rewritten = seal(&paths, &base);
                let rewritten_ms = start.elapsed().as_secs_f64() * 1000.0;
                assert_ne!(rewritten, changed);
                files.verify_roots(&paths, &rewritten).unwrap();
                let after_rewrite = store_size(&files);
                let restored = targets(temp.path(), "byte-restore");
                let start = Instant::now();
                files.materialize_roots(&restored, &base).unwrap();
                let restore_ms = start.elapsed().as_secs_f64() * 1000.0;
                files.verify_roots(&restored, &base).unwrap();
                let concurrent = if count == 512 {
                    let branches: Vec<_> = ["a", "b"]
                        .into_iter()
                        .map(|name| {
                            let branch = targets(temp.path(), name);
                            files.materialize_roots(&branch, &base).unwrap();
                            (name, branch)
                        })
                        .collect();
                    let start = Instant::now();
                    let workers = std::thread::scope(|scope| {
                        branches
                            .iter()
                            .map(|(name, branch)| {
                                let seal = &seal;
                                let base = &base;
                                scope.spawn(move || {
                                    fs::write(branch["workspace"].join("env/value"), name).unwrap();
                                    let start = Instant::now();
                                    (seal(branch, base), start.elapsed().as_secs_f64() * 1000.0)
                                })
                            })
                            .collect::<Vec<_>>()
                            .into_iter()
                            .map(|worker| worker.join().unwrap())
                            .collect::<Vec<_>>()
                    });
                    let wall_ms = start.elapsed().as_secs_f64() * 1000.0;
                    assert_ne!(workers[0].0, workers[1].0);
                    for ((_, branch), (reference, _)) in branches.iter().zip(&workers) {
                        files.verify_roots(branch, reference).unwrap();
                    }
                    serde_json::json!({"writers":2,"wallMs":wall_ms,"workerMs":workers.iter().map(|(_, ms)| ms).collect::<Vec<_>>()})
                } else {
                    serde_json::json!({"status":"NOT RUN for this distribution"})
                };
                assert_eq!(
                    fs::read(files.version_path(&base).unwrap()).unwrap(),
                    manifest
                );
                samples.push(serde_json::json!({"strategy":if optimized {"deduplicated"} else {"unbatched-write-compare"},
                    "filesPerRoot":count,"uniquePayloads":if shared {unique} else {2*unique},
                    "sharedPayloadsAcrossRoots":shared,"bytesPerFile":bytes,"sample":sample,
                    "unchangedSealMs":unchanged_ms,"changedSealMs":changed_ms,"fullyRewrittenSealMs":rewritten_ms,
                    "storeBeforeRewrite":before_rewrite,"storeAfterRewrite":after_rewrite,"materializeMs":restore_ms,
                    "storeBefore":before,"storeAfterUnchangedSeals":after_noop,"storeFinal":store_size(&files),"concurrentCapture":concurrent}));
            }
        }
    }
    let report = serde_json::json!({"schema":1,"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"samples":samples,
        "referenceStrategy":"per-file single-path-check; no checked-set lookup/insertion; write-then-compare",
        "limits":"warm filesystem cache; test profile; logical bytes, not allocated blocks; synthetic retained dependency distributions; no whole-process-tree CPU/RSS or sandbox acceptance claim"});
    if let Some(path) = std::env::var_os("GRAPHER_ENV_SEAL_PROBE_REPORT") {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
            .unwrap();
        file.write_all(serde_json::to_string_pretty(&report).unwrap().as_bytes())
            .unwrap();
    }
    println!("GRAPHER_DEPENDENCY_SEALING_PROBE {report}");
}
