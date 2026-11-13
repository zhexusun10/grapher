//! Explicit, backed-up reconciliation of one legacy in-place write. Never
//! infer that an empty/prefix file is safe to overwrite during ordinary retry.
use super::*;

pub(crate) fn repair_legacy_file(
    repository: &Path,
    journal: &Path,
    relative: &str,
    apply: Option<(&str, &Path)>,
) -> Result<serde_json::Value, String> {
    atomic_files::validate_relative(relative)?;
    workspace::validate_binding(repository)?;
    if read_optional(&journal.join("applying"))?.as_deref() != Some(b"checkout\n")
        || journal.join("installed").exists()
    {
        return Err("Only an unfinished legacy checkout can be explicitly reconciled".into());
    }
    let prepared: Prepared = serde_json::from_slice(
        &fs::read(journal.join("prepared.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let standard = workspace::is_standard_git(repository);
    if standard {
        verify_source(repository, journal, &prepared)?;
    }
    if !diff_paths(repository, &prepared.input, &prepared.result)?.contains(relative) {
        return Err("File was not modified by this publication".into());
    }
    let target = repository.join(relative);
    crate::path_safety::real_child_path(repository, &target, true)?
        .ok_or("Current file is missing")?;
    let current_blob =
        repository_git(repository, &["hash-object", "--no-filters", "--", relative])?;
    let entry = repository_git(
        repository,
        &[
            "--literal-pathspecs",
            "ls-tree",
            "-z",
            &prepared.result,
            "--",
            relative,
        ],
    )?;
    let (metadata, name) = entry
        .trim_end_matches('\0')
        .split_once('\t')
        .ok_or("File is absent from the recorded result")?;
    let fields: Vec<_> = metadata.split_whitespace().collect();
    if name != relative
        || fields.len() != 3
        || fields[1] != "blob"
        || !matches!(fields[0], "100644" | "100755")
    {
        return Err("The recorded result is not a regular file".into());
    }
    let result_blob = fields[2];
    let mut report = serde_json::json!({"path":relative, "currentBlob":current_blob,
        "resultBlob":result_blob, "resultBytes":repository_git(repository, &["cat-file", "-s", result_blob])?,
        "publicationResult":prepared.result, "journal":journal, "phase":"preview"});
    let Some((expected, backup)) = apply else {
        return Ok(report);
    };
    if expected != current_blob || current_blob == result_blob {
        return Err("Current bytes changed or already match the result; preview again".into());
    }
    with_source_lease(repository, journal, standard, || {
        if standard {
            verify_source(repository, journal, &prepared)?;
        }
        // Reserve all backup records before writing a single project byte.
        let current_backup = backup.join("publication-current.bin");
        let result_backup = backup.join("publication-result.bin");
        let receipt = backup.join("publication-file-repair.json");
        let completed = backup.join("publication-file-repair.completed.json");
        if [&current_backup, &result_backup, &receipt, &completed]
            .iter()
            .any(|path| fs::symlink_metadata(path).is_ok())
        {
            return Err("Publication repair backup files already exist".into());
        }
        let mut input = fs::File::open(&target).map_err(|e| e.to_string())?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&current_backup)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output)
            .and_then(|_| output.sync_all())
            .map_err(|e| e.to_string())?;
        drop(output);
        drop(input);
        let current_backup_host = crate::native::host_path(&current_backup);
        if repository_git(
            repository,
            &[
                "hash-object",
                "--no-filters",
                "--",
                current_backup_host.to_str().ok_or("Invalid backup path")?,
            ],
        )? != expected
        {
            return Err("Source changed during backup; nothing installed".into());
        }
        let staged = atomic_files::stage_files(repository, journal, &prepared.result, &[relative])?;
        let staged_file = staged.join(relative);
        crate::path_safety::real_child_path(&staged, &staged_file, true)?
            .ok_or("Missing staged repair file")?;
        let mut input = fs::File::open(&staged_file).map_err(|e| e.to_string())?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&result_backup)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output
            .set_permissions(input.metadata().map_err(|e| e.to_string())?.permissions())
            .and_then(|_| output.sync_all())
            .map_err(|e| e.to_string())?;
        drop(output);
        drop(input);
        report["phase"] = serde_json::json!("prepared");
        save_once(
            &receipt,
            &serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
        )?;
        atomic_files::install_file(
            repository,
            journal,
            &result_backup,
            relative,
            fields[0],
            &mut |_| {
                if standard {
                    verify_source(repository, journal, &prepared)?;
                }
                crate::path_safety::real_child_path(repository, &target, true)?
                    .ok_or("Current file disappeared")?;
                if repository_git(repository, &["hash-object", "--no-filters", "--", relative])?
                    != expected
                {
                    return Err(
                        "Source changed before installation; preserved the current file".into(),
                    );
                }
                Ok(())
            },
        )?;
        if repository_git(repository, &["hash-object", "--no-filters", "--", relative])?
            != result_blob
        {
            return Err(
                "File was installed but changed again; inspect the retained backups".into(),
            );
        }
        report["phase"] = serde_json::json!("completed");
        save_once(
            &completed,
            &serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
        )?;
        Ok(report)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_legacy_repair_backs_up_exact_bytes_and_leaves_publication_unfinished() {
        crate::ensure_test_data_root();
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-q"]).unwrap();
        fs::write(source.join("base.txt"), "base").unwrap();
        git(&source, &["add", "-A"]).unwrap();
        git(&source, &["commit", "-qm", "base"]).unwrap();
        let head = git(&source, &["rev-parse", "HEAD"]).unwrap();
        let index = fs::read(source.join(".git/index")).unwrap();
        let base = workspace::snapshot_repository(&source).unwrap();
        let node = temp.path().join("node");
        workspace::prepare(&source, &node, &base, &[]).unwrap();
        let bytes = vec![57u8; 1024 * 1024];
        fs::write(node.join("large.exe"), &bytes).unwrap();
        let result = workspace::snapshot_node(&node, &source, "worker").unwrap();
        let heads = [result];
        let published = publish(&source, &heads, &[], None, |_| panic!()).unwrap();
        let journal = publication_workspace(&source, &heads)
            .unwrap()
            .with_extension("publication")
            .join("00000000");
        fs::remove_file(journal.join("installed")).unwrap();
        fs::write(journal.join("applying"), "checkout\n").unwrap();
        fs::write(source.join("large.exe"), []).unwrap();
        let preview = repair_legacy_file(&source, &journal, "large.exe", None).unwrap();
        let expected = preview["currentBlob"].as_str().unwrap();
        let backup = temp.path().join("backup");
        fs::create_dir(&backup).unwrap();
        assert!(
            repair_legacy_file(&source, &journal, "large.exe", Some(("stale", &backup))).is_err()
        );
        assert_eq!(fs::read_dir(&backup).unwrap().count(), 0);
        fs::write(source.join("large.exe"), "user edit").unwrap();
        assert!(
            repair_legacy_file(&source, &journal, "large.exe", Some((expected, &backup))).is_err()
        );
        assert_eq!(
            fs::read_to_string(source.join("large.exe")).unwrap(),
            "user edit"
        );
        fs::write(source.join("large.exe"), []).unwrap();
        let lock = source_index(&source).unwrap().with_extension("lock");
        fs::write(&lock, "foreign Git writer").unwrap();
        let error = repair_legacy_file(&source, &journal, "large.exe", Some((expected, &backup)))
            .unwrap_err();
        assert!(error.contains("lease"), "{error}");
        assert_eq!(fs::read_to_string(&lock).unwrap(), "foreign Git writer");
        assert_eq!(fs::read_dir(&backup).unwrap().count(), 0);
        fs::remove_file(&lock).unwrap();
        let completed = backup.join("publication-file-repair.completed.json");
        fs::write(&completed, "earlier receipt").unwrap();
        assert!(
            repair_legacy_file(&source, &journal, "large.exe", Some((expected, &backup))).is_err()
        );
        assert_eq!(fs::metadata(source.join("large.exe")).unwrap().len(), 0);
        assert_eq!(fs::read_to_string(&completed).unwrap(), "earlier receipt");
        assert!(!lock.exists(), "failed repair releases its own lease");
        fs::remove_file(completed).unwrap();
        fs::write(
            &lock,
            format!("Grapher publication {}\n", journal.display()),
        )
        .unwrap();
        fs::write(
            journal.join("staging-index.lock"),
            "interrupted private staging",
        )
        .unwrap();
        let report =
            repair_legacy_file(&source, &journal, "large.exe", Some((expected, &backup))).unwrap();
        assert!(!journal.join("staging-index.lock").exists());
        assert!(
            !lock.exists(),
            "completed repair releases its recovered lease"
        );
        assert_eq!(report["phase"], "completed");
        assert_eq!(
            fs::metadata(backup.join("publication-current.bin"))
                .unwrap()
                .len(),
            0
        );
        assert_eq!(fs::read(source.join("large.exe")).unwrap(), bytes);
        assert_eq!(
            fs::read(backup.join("publication-result.bin")).unwrap(),
            bytes
        );
        assert!(
            !journal.join("installed").exists(),
            "repair never claims completed publication"
        );
        assert_eq!(git(&source, &["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(fs::read(source.join(".git/index")).unwrap(), index);
        assert!(repair_legacy_file(&source, &journal, "base.txt", None).is_err());
        assert!(repair_legacy_file(&source, &journal, "../outside", None).is_err());
        assert!(repair_legacy_file(&source, &journal, ".git/config", None).is_err());
        // A fresh retry reads only durable journal state, completes delivery,
        // and never reapplies the explicitly repaired file.
        assert_eq!(
            publish(&source, &heads, &[], None, |_| panic!()).unwrap(),
            published
        );
        assert!(journal.join("installed").exists());
        assert_eq!(fs::read(source.join("large.exe")).unwrap(), bytes);
        assert_eq!(fs::read(source.join(".git/index")).unwrap(), index);
    }
}
