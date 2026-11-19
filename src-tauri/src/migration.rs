//! Preserve-first legacy-data migration into Tauri's `app_data_dir()/data`.
//!
//! Safety invariants:
//! - Runs ONLY when `app_data_dir()/data` does not exist yet (even an empty
//!   existing directory skips migration completely).
//! - Acquires the destination migration guard lock AND the existing legacy
//!   `runtime.lock` before reading any bytes.
//! - Rejects symlinks, junctions/reparse points, special files, unsafe entry
//!   names, and overlapping source/destination trees.
//! - Copies all source files (preserving exact bytes and unrelated files,
//!   excluding only `runtime.lock`) into a sibling staging directory, fsyncs,
//!   and publishes atomically via `fs::rename`.
//! - Never modifies or deletes the legacy source store, and on any failure
//!   cleans up only the temporary staging directory so both stores stay intact.
use crate::runtime_lock;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, ErrorKind},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MigrationOutcome {
    SkippedDestinationExists,
    SkippedNoLegacySource,
    Migrated {
        source: PathBuf,
        destination: PathBuf,
        files_copied: usize,
        bytes_copied: u64,
    },
}

struct StagingGuard {
    path: PathBuf,
    committed: bool,
}

impl StagingGuard {
    fn create(parent: &Path) -> Result<Self, String> {
        let name = format!("data.migrating-{}", Uuid::new_v4());
        let path = parent.join(name);
        fs::create_dir(&path).map_err(|error| {
            format!(
                "Cannot create migration staging directory {}: {error}",
                path.display()
            )
        })?;
        Ok(Self {
            path,
            committed: false,
        })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

/// Discover default legacy `.grapher` store candidates for desktop first launch.
pub fn default_legacy_candidates(
    current_exe: Option<&Path>,
    installation_root: &Path,
) -> (Option<PathBuf>, Vec<PathBuf>) {
    let explicit = crate::paths::non_empty_env_path("GRAPHER_LEGACY_DATA_DIR");
    let mut implicit = Vec::new();
    if let Some(exe_dir) = current_exe.and_then(Path::parent) {
        implicit.push(exe_dir.join(".grapher"));
    }
    let install_legacy = installation_root.join(".grapher");
    if !implicit.contains(&install_legacy) {
        implicit.push(install_legacy);
    }
    (explicit, implicit)
}

/// Migrate an eligible legacy store into `app_data_dir/data` if and only if
/// `app_data_dir/data` is absent.
///
/// - `explicit_source`: when `Some`, must be a valid safe directory if present
///   (invalid/symlink explicit sources fail loudly rather than silently skipping).
/// - `implicit_candidates`: probed in order; only eligible directories that
///   exist and contain a Grapher SQLite store are selected.
pub fn migrate_legacy_data_if_needed(
    app_data_dir: &Path,
    explicit_source: Option<&Path>,
    implicit_candidates: &[PathBuf],
) -> Result<MigrationOutcome, String> {
    let destination = app_data_dir.join("data");

    // Fast path: destination already exists (file, dir, or symlink) -> skip.
    if path_exists_no_follow(&destination)? {
        return Ok(MigrationOutcome::SkippedDestinationExists);
    }

    // Ensure parent exists before acquiring the migration guard lock.
    fs::create_dir_all(app_data_dir).map_err(|error| {
        format!(
            "Cannot create desktop app data directory {}: {error}",
            app_data_dir.display()
        )
    })?;
    let _migration_guard = runtime_lock::acquire_migration_guard(app_data_dir)?;

    // Double-check destination absence after acquiring the migration lock.
    if path_exists_no_follow(&destination)? {
        return Ok(MigrationOutcome::SkippedDestinationExists);
    }

    let source = match select_legacy_source(explicit_source, implicit_candidates, &destination)? {
        Some(source) => source,
        None => return Ok(MigrationOutcome::SkippedNoLegacySource),
    };

    migrate_from_source(app_data_dir, &source, &destination)
}

fn path_exists_no_follow(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Cannot inspect destination path {}: {error}",
            path.display()
        )),
    }
}

fn is_reparse_or_symlink(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn validate_safe_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "Refusing {label} path containing parent traversal: {}",
            path.display()
        ));
    }
    let meta = fs::symlink_metadata(path).map_err(|error| {
        format!("Cannot inspect {label} {}: {error}", path.display())
    })?;
    if is_reparse_or_symlink(&meta) {
        return Err(format!(
            "Refusing symlink/reparse-point {label}: {}",
            path.display()
        ));
    }
    if !meta.file_type().is_dir() {
        return Err(format!(
            "Expected {label} to be a regular directory: {}",
            path.display()
        ));
    }
    path.canonicalize().map_err(|error| {
        format!("Cannot resolve {label} {}: {error}", path.display())
    })
}

fn has_legacy_sqlite_store(source: &Path) -> Result<bool, String> {
    let direct = source.join("events.sqlite");
    if let Ok(meta) = fs::symlink_metadata(&direct) {
        if is_reparse_or_symlink(&meta) {
            return Err(format!(
                "Refusing symlink database in legacy store: {}",
                direct.display()
            ));
        }
        if meta.file_type().is_file() {
            return Ok(true);
        }
    }
    // Also detect stores that previously redirected to `format-N/events.sqlite`.
    let entries = fs::read_dir(source)
        .map_err(|error| format!("Cannot read legacy directory {}: {error}", source.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("format-") {
            continue;
        }
        let child = entry.path();
        let meta = fs::symlink_metadata(&child).map_err(|error| error.to_string())?;
        if is_reparse_or_symlink(&meta) || !meta.file_type().is_dir() {
            continue;
        }
        let nested_db = child.join("events.sqlite");
        if let Ok(db_meta) = fs::symlink_metadata(&nested_db) {
            if !is_reparse_or_symlink(&db_meta) && db_meta.file_type().is_file() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn select_legacy_source(
    explicit_source: Option<&Path>,
    implicit_candidates: &[PathBuf],
    destination: &Path,
) -> Result<Option<PathBuf>, String> {
    let canonical_dest_parent = destination
        .parent()
        .ok_or("Invalid desktop data destination path")?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let expected_dest = canonical_dest_parent.join(
        destination
            .file_name()
            .ok_or("Invalid desktop data destination file name")?,
    );

    if let Some(explicit) = explicit_source {
        match fs::symlink_metadata(explicit) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "Cannot inspect configured legacy data directory {}: {error}",
                    explicit.display()
                ));
            }
            Ok(_) => {}
        }
        let canonical = validate_safe_directory(explicit, "legacy data directory")?;
        reject_overlapping_paths(&canonical, &expected_dest)?;
        if !has_legacy_sqlite_store(&canonical)? {
            return Ok(None);
        }
        return Ok(Some(canonical));
    }

    for candidate in implicit_candidates {
        let meta = match fs::symlink_metadata(candidate) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if is_reparse_or_symlink(&meta) || !meta.file_type().is_dir() {
            continue;
        }
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if reject_overlapping_paths(&canonical, &expected_dest).is_err() {
            continue;
        }
        if has_legacy_sqlite_store(&canonical)? {
            return Ok(Some(canonical));
        }
    }
    Ok(None)
}

fn reject_overlapping_paths(source: &Path, destination: &Path) -> Result<(), String> {
    if source == destination
        || destination.starts_with(source)
        || source.starts_with(destination)
    {
        return Err(format!(
            "Refusing migration between overlapping paths: source {} and destination {}",
            source.display(),
            destination.display()
        ));
    }
    Ok(())
}

fn validate_entry_name(name: &std::ffi::OsStr) -> Result<(), String> {
    let text = name.to_string_lossy();
    if text.is_empty()
        || text == "."
        || text == ".."
        || text.contains('/')
        || text.contains('\\')
        || text.contains('\0')
    {
        return Err(format!("Refusing unsafe path component during migration: {text:?}"));
    }
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err(format!(
            "Refusing non-normal path component during migration: {text:?}"
        )),
    }
}

fn acquire_nested_format_locks(source: &Path) -> Result<Vec<runtime_lock::RuntimeLock>, String> {
    let mut locks = Vec::new();
    let entries = fs::read_dir(source)
        .map_err(|error| format!("Cannot read legacy directory {}: {error}", source.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("format-") {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if is_reparse_or_symlink(&meta) || !meta.file_type().is_dir() {
            continue;
        }
        if path.join("runtime.lock").exists() || path.join("events.sqlite").exists() {
            locks.push(runtime_lock::acquire_runtime(&path)?);
        }
    }
    Ok(locks)
}

fn migrate_from_source(
    app_data_dir: &Path,
    source: &Path,
    destination: &Path,
) -> Result<MigrationOutcome, String> {
    // 1. Acquire the existing runtime.lock on the legacy store (and any nested
    //    format-* slot) so a live Grapher process cannot mutate SQLite/WAL files.
    let _source_lock = runtime_lock::acquire_runtime(source)?;
    let _nested_locks = acquire_nested_format_locks(source)?;

    // 2. Create a sibling staging directory under app_data_dir (same filesystem
    //    as destination, enabling atomic rename) guarded by automatic cleanup.
    let mut staging = StagingGuard::create(app_data_dir)?;
    let canonical_staging = staging
        .path()
        .canonicalize()
        .map_err(|error| format!("Cannot resolve staging directory: {error}"))?;

    // 3. Copy the full directory tree strictly without following links,
    //    preserving all bytes and unrelated files while skipping runtime.lock.
    let mut stats = CopyStats::default();
    copy_tree_strict(source, &canonical_staging, &canonical_staging, 0, &mut stats)?;
    sync_dir(&canonical_staging)?;

    // 4. Re-verify destination is still absent right before atomic publish.
    if path_exists_no_follow(destination)? {
        return Ok(MigrationOutcome::SkippedDestinationExists);
    }

    // 5. Publish atomically by renaming the sibling staging directory into place.
    fs::rename(staging.path(), destination).map_err(|error| {
        format!(
            "Failed to publish migrated data directory to {}: {error}",
            destination.display()
        )
    })?;
    staging.commit();
    sync_dir(app_data_dir)?;

    Ok(MigrationOutcome::Migrated {
        source: source.to_path_buf(),
        destination: destination.to_path_buf(),
        files_copied: stats.files_copied,
        bytes_copied: stats.bytes_copied,
    })
}

#[derive(Default)]
struct CopyStats {
    files_copied: usize,
    bytes_copied: u64,
}

fn copy_tree_strict(
    src_dir: &Path,
    dst_dir: &Path,
    staging_root: &Path,
    depth: usize,
    stats: &mut CopyStats,
) -> Result<(), String> {
    if depth > 64 {
        return Err(format!(
            "Refusing migration of excessively deep directory tree at {}",
            src_dir.display()
        ));
    }
    let mut entries: Vec<_> = fs::read_dir(src_dir)
        .map_err(|error| format!("Cannot read directory {}: {error}", src_dir.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot enumerate directory {}: {error}", src_dir.display()))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let name = entry.file_name();
        validate_entry_name(&name)?;

        let src_path = entry.path();
        let meta = fs::symlink_metadata(&src_path).map_err(|error| {
            format!("Cannot inspect legacy entry {}: {error}", src_path.display())
        })?;

        if is_reparse_or_symlink(&meta) {
            return Err(format!(
                "Refusing to migrate symbolic link or reparse point: {}",
                src_path.display()
            ));
        }

        // Skip transient runtime.lock files at the root or format-* subdirectories.
        if name == "runtime.lock" && meta.file_type().is_file() && depth <= 1 {
            continue;
        }

        let dst_path = dst_dir.join(&name);
        if !dst_path.starts_with(staging_root) {
            return Err(format!(
                "Refusing unsafe destination path escaping staging root: {}",
                dst_path.display()
            ));
        }

        if meta.file_type().is_dir() {
            fs::create_dir(&dst_path).map_err(|error| {
                format!(
                    "Cannot create staged directory {}: {error}",
                    dst_path.display()
                )
            })?;
            copy_tree_strict(&src_path, &dst_path, staging_root, depth + 1, stats)?;
            sync_dir(&dst_path)?;
        } else if meta.file_type().is_file() {
            let copied = copy_file_exact(&src_path, &dst_path, &meta)?;
            stats.files_copied += 1;
            stats.bytes_copied += copied;
        } else {
            return Err(format!(
                "Refusing to migrate special/non-regular file: {}",
                src_path.display()
            ));
        }
    }
    Ok(())
}

fn copy_file_exact(src: &Path, dst: &Path, src_meta: &fs::Metadata) -> Result<u64, String> {
    let mut reader = File::open(src)
        .map_err(|error| format!("Cannot open legacy file {}: {error}", src.display()))?;
    let mut writer = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)
        .map_err(|error| format!("Cannot create staged file {}: {error}", dst.display()))?;
    let copied = io::copy(&mut reader, &mut writer).map_err(|error| {
        format!(
            "Failed copying {} to {}: {error}",
            src.display(),
            dst.display()
        )
    })?;
    if copied != src_meta.len() {
        return Err(format!(
            "Byte count mismatch while copying {} (expected {} bytes, copied {} bytes)",
            src.display(),
            src_meta.len(),
            copied
        ));
    }
    writer
        .sync_all()
        .map_err(|error| format!("Failed syncing staged file {}: {error}", dst.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = src_meta.permissions().mode() & 0o777;
        let _ = fs::set_permissions(dst, fs::Permissions::from_mode(mode));
    }
    Ok(copied)
}

fn sync_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let handle = File::open(dir)
            .map_err(|error| format!("Cannot open directory {} for sync: {error}", dir.display()))?;
        handle
            .sync_all()
            .map_err(|error| format!("Cannot sync directory {}: {error}", dir.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_legacy_store(dir: &Path) {
        fs::create_dir_all(dir.join("sessions/run-1")).unwrap();
        fs::create_dir_all(dir.join("prompts")).unwrap();
        fs::write(dir.join("events.sqlite"), b"SQLite format 3\0legacy-db-bytes").unwrap();
        fs::write(dir.join("events.sqlite-wal"), b"wal-bytes-exact").unwrap();
        fs::write(dir.join("config.json"), br#"{"repository":"/tmp/demo"}"#).unwrap();
        fs::write(dir.join("sessions/run-1/log.jsonl"), b"{\"event\":1}\n").unwrap();
        fs::write(dir.join("prompts/custom.md"), b"user prompt untouched").unwrap();
        fs::write(dir.join("unrelated-notes.txt"), b"preserve unrelated files").unwrap();
        fs::write(dir.join("runtime.lock"), b"").unwrap();
    }

    #[test]
    fn migrates_legacy_store_preserving_exact_bytes_and_unrelated_files() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy-grapher");
        let app_data = temp.path().join("app-data");
        seed_legacy_store(&legacy);

        let outcome =
            migrate_legacy_data_if_needed(&app_data, Some(&legacy), &[]).unwrap();

        match outcome {
            MigrationOutcome::Migrated {
                source,
                destination,
                files_copied,
                bytes_copied,
            } => {
                assert_eq!(source, legacy.canonicalize().unwrap());
                assert_eq!(destination, app_data.join("data"));
                assert_eq!(files_copied, 6);
                assert!(bytes_copied > 0);
            }
            other => panic!("expected Migrated outcome, got {other:?}"),
        }

        let dest = app_data.join("data");
        assert_eq!(
            fs::read(dest.join("events.sqlite")).unwrap(),
            b"SQLite format 3\0legacy-db-bytes"
        );
        assert_eq!(
            fs::read(dest.join("events.sqlite-wal")).unwrap(),
            b"wal-bytes-exact"
        );
        assert_eq!(
            fs::read(dest.join("config.json")).unwrap(),
            br#"{"repository":"/tmp/demo"}"#
        );
        assert_eq!(
            fs::read(dest.join("sessions/run-1/log.jsonl")).unwrap(),
            b"{\"event\":1}\n"
        );
        assert_eq!(
            fs::read(dest.join("prompts/custom.md")).unwrap(),
            b"user prompt untouched"
        );
        assert_eq!(
            fs::read(dest.join("unrelated-notes.txt")).unwrap(),
            b"preserve unrelated files"
        );
        // Transient runtime.lock is excluded from the migrated destination.
        assert!(!dest.join("runtime.lock").exists());
        // Source store remains completely intact.
        assert_eq!(
            fs::read(legacy.join("events.sqlite")).unwrap(),
            b"SQLite format 3\0legacy-db-bytes"
        );
        assert_eq!(
            fs::read(legacy.join("unrelated-notes.txt")).unwrap(),
            b"preserve unrelated files"
        );
        // No staging leftovers remain.
        let leftovers: Vec<_> = fs::read_dir(&app_data)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("data.migrating-"))
            .collect();
        assert!(leftovers.is_empty(), "leftover staging dirs: {leftovers:?}");
    }

    #[test]
    fn skips_migration_when_destination_already_exists_even_if_empty() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy-grapher");
        let app_data = temp.path().join("app-data");
        seed_legacy_store(&legacy);
        fs::create_dir_all(app_data.join("data")).unwrap();

        let outcome =
            migrate_legacy_data_if_needed(&app_data, Some(&legacy), &[]).unwrap();
        assert_eq!(outcome, MigrationOutcome::SkippedDestinationExists);
        assert!(!app_data.join("data/events.sqlite").exists());
        assert!(legacy.join("events.sqlite").exists());
    }

    #[test]
    fn fails_cleanly_when_legacy_runtime_lock_is_held_leaving_both_stores_intact() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy-grapher");
        let app_data = temp.path().join("app-data");
        seed_legacy_store(&legacy);

        let _held_lock = runtime_lock::acquire_runtime(&legacy).unwrap();
        let err = migrate_legacy_data_if_needed(&app_data, Some(&legacy), &[]).unwrap_err();
        assert!(err.contains("Another Grapher instance owns this runtime"), "{err}");

        // Destination was never created, source is untouched, no staging dir left behind.
        assert!(!app_data.join("data").exists());
        assert_eq!(
            fs::read(legacy.join("events.sqlite")).unwrap(),
            b"SQLite format 3\0legacy-db-bytes"
        );
        let leftovers: Vec<_> = fs::read_dir(&app_data)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("data.migrating-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_inside_legacy_store_and_cleans_up_staging() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy-grapher");
        let app_data = temp.path().join("app-data");
        let outside = temp.path().join("outside-secret.txt");
        fs::write(&outside, b"do-not-copy").unwrap();
        seed_legacy_store(&legacy);
        std::os::unix::fs::symlink(&outside, legacy.join("escape-link")).unwrap();

        let err = migrate_legacy_data_if_needed(&app_data, Some(&legacy), &[]).unwrap_err();
        assert!(err.contains("symbolic link"), "{err}");

        // Neither destination nor staging leftovers exist; source is untouched.
        assert!(!app_data.join("data").exists());
        assert!(legacy.join("events.sqlite").exists());
        assert!(legacy.join("escape-link").symlink_metadata().is_ok());
        let leftovers: Vec<_> = fs::read_dir(&app_data)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("data.migrating-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_legacy_root() {
        let temp = tempfile::tempdir().unwrap();
        let real_legacy = temp.path().join("real-legacy");
        let link_legacy = temp.path().join("link-legacy");
        let app_data = temp.path().join("app-data");
        seed_legacy_store(&real_legacy);
        std::os::unix::fs::symlink(&real_legacy, &link_legacy).unwrap();

        let err = migrate_legacy_data_if_needed(&app_data, Some(&link_legacy), &[]).unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        assert!(!app_data.join("data").exists());
    }

    #[test]
    fn rejects_parent_traversal_in_explicit_legacy_path() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("a").join("..").join("legacy");
        fs::create_dir_all(temp.path().join("a")).unwrap();
        seed_legacy_store(&temp.path().join("legacy"));
        let app_data = temp.path().join("app-data");

        let err = migrate_legacy_data_if_needed(&app_data, Some(&legacy), &[]).unwrap_err();
        assert!(err.contains("parent traversal"), "{err}");
        assert!(!app_data.join("data").exists());
    }
}
