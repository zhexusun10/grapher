//! Select a current-format data directory before any startup recovery.
//! Store/Runtime opens used by maintenance remain strict: only server startup
//! may create a separate store, and the incompatible data is never imported.
use crate::{runtime::Runtime, runtime_lock, store};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

pub(crate) struct DataDirectory {
    pub(crate) root: PathBuf,
    lease: Arc<runtime_lock::RuntimeLock>,
    redirect: Option<Redirect>,
}

struct Redirect {
    configured: PathBuf,
    incompatible: Option<(PathBuf, i64)>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    format_version: u32,
    database_format: i64,
    directory: String,
}

impl DataDirectory {
    pub(crate) fn open(self, load_selected: bool) -> Result<Runtime, String> {
        let runtime = Runtime::open_primary_with_lease(&self.root, load_selected, self.lease)?;
        if let Some(redirect) = self.redirect {
            if let Some((original, version)) = redirect.incompatible {
                write_selection(&redirect.configured, &self.root)?;
                eprintln!(
                    "[Grapher] Database format {version} at {} is incompatible with format {}. Using {}; previous data is preserved.",
                    original.display(), store::FORMAT_VERSION, self.root.join("events.sqlite").display()
                );
            } else {
                eprintln!(
                    "[Grapher] Reusing current-format database {} (configured data directory: {}).",
                    self.root.join("events.sqlite").display(),
                    redirect.configured.display()
                );
            }
        }
        Ok(runtime)
    }
}

pub(crate) fn select(requested: &Path) -> Result<DataDirectory, String> {
    fs::create_dir_all(requested).map_err(|error| error.to_string())?;
    let requested = requested
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let original_lock = Arc::new(runtime_lock::acquire(&requested)?);
    let (incompatible_database, version) = if let Some(selection) = read_selection(&requested)? {
        let candidate = crate::path_safety::real_child_path(
            &requested,
            &requested.join(selection.directory),
            false,
        )?
        .ok_or("Selected startup data directory is missing")?;
        let lock = runtime_lock::acquire(&candidate)?;
        let database = crate::path_safety::real_child_path(
            &candidate,
            &candidate.join("events.sqlite"),
            true,
        )?
        .ok_or("Selected startup database is missing")?;
        if let Some(version) = store::incompatible_database_version(&database)? {
            (database, version)
        } else {
            // A recorded selection is an initialized store, never an empty file
            // to initialize again after accidental deletion/truncation.
            store::Store::open_reader(&database)?;
            return Ok(DataDirectory {
                root: candidate,
                lease: Arc::new(lock.retain_parent(original_lock)),
                redirect: Some(Redirect {
                    configured: requested,
                    incompatible: None,
                }),
            });
        }
    } else {
        let database = requested.join("events.sqlite");
        let Some(version) = store::incompatible_database_version(&database)? else {
            return Ok(DataDirectory {
                root: requested,
                lease: original_lock,
                redirect: None,
            });
        };
        (database, version)
    };

    // A stable name lets restarts find the same new store without changing .env
    // or a user's GRAPHER_DATA_DIR. Occupied incompatible/unknown slots survive.
    let mut index = 1u64;
    loop {
        let name = if index == 1 {
            format!("format-{}", store::FORMAT_VERSION)
        } else {
            format!("format-{}-{index}", store::FORMAT_VERSION)
        };
        index = index
            .checked_add(1)
            .ok_or("Data directory suffix exhausted")?;
        let candidate = requested.join(name);
        match fs::create_dir(&candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let metadata =
                    fs::symlink_metadata(&candidate).map_err(|error| error.to_string())?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    continue;
                }
                // A directory name alone proves nothing about its contents.
                if !candidate
                    .join("events.sqlite")
                    .try_exists()
                    .map_err(|error| error.to_string())?
                {
                    continue;
                }
            }
            Err(error) => return Err(error.to_string()),
        }
        let candidate = crate::path_safety::real_child_path(&requested, &candidate, false)?
            .ok_or("Startup data directory disappeared")?;
        let lock = runtime_lock::acquire(&candidate)?;
        let database = candidate.join("events.sqlite");
        crate::path_safety::real_child_path(&candidate, &database, true)?;
        if store::incompatible_database_version(&database)?.is_some() {
            continue;
        }
        // Retain both leases, including in child Run services: another startup
        // cannot race this selection, and direct opens cannot share the store.
        return Ok(DataDirectory {
            root: candidate,
            lease: Arc::new(lock.retain_parent(original_lock)),
            redirect: Some(Redirect {
                configured: requested,
                incompatible: Some((incompatible_database, version)),
            }),
        });
    }
}

fn selection_path(root: &Path) -> PathBuf {
    root.join(format!("startup-format-{}.json", store::FORMAT_VERSION))
}

fn read_selection(root: &Path) -> Result<Option<Selection>, String> {
    let Some(path) = crate::path_safety::real_child_path(root, &selection_path(root), true)? else {
        return Ok(None);
    };
    let selection: Selection =
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Invalid startup data directory selection: {error}"))?;
    let prefix = format!("format-{}", store::FORMAT_VERSION);
    let valid_directory = selection.directory == prefix
        || selection
            .directory
            .strip_prefix(&format!("{prefix}-"))
            .and_then(|suffix| {
                suffix
                    .parse::<u64>()
                    .ok()
                    .map(|number| number >= 2 && suffix == number.to_string())
            })
            .unwrap_or(false);
    if selection.format_version != 1
        || selection.database_format != store::FORMAT_VERSION
        || !valid_directory
    {
        return Err("Unsupported startup data directory selection".into());
    }
    Ok(Some(selection))
}

fn write_selection(configured: &Path, selected: &Path) -> Result<(), String> {
    let selection = Selection {
        format_version: 1,
        database_format: store::FORMAT_VERSION,
        directory: selected
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid startup data directory name")?
            .to_ascii_lowercase(),
    };
    let path = selection_path(configured);
    crate::path_safety::real_child_path(configured, &path, true)?;
    let temporary = path.with_extension(format!("{}.pending", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut file, &selection).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        fs::File::open(configured)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Config, EventKind, Graph};
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn open(root: &Path, load_selected: bool) -> Result<Runtime, String> {
        select(root)?.open(load_selected)
    }

    fn unsupported(root: &Path, version: i64) -> Vec<u8> {
        fs::create_dir_all(root).unwrap();
        let path = root.join("events.sqlite");
        let database = Connection::open(&path).unwrap();
        database.execute_batch(&format!(
            "PRAGMA user_version={version}; CREATE TABLE original(payload TEXT); INSERT INTO original VALUES('keep');"
        )).unwrap();
        drop(database);
        fs::read(path).unwrap()
    }

    fn save(runtime: &mut Runtime) {
        runtime.state.run_id = "retained".into();
        runtime
            .emit(EventKind::Created {
                graph: Graph {
                    original_goal: "Retained current Run".into(),
                    nodes: vec![],
                    edges: vec![],
                },
                config: serde_json::from_value::<Config>(
                    serde_json::json!({"repository":"", "model":"test/model"}),
                )
                .unwrap(),
                planning_id: None,
                planning: None,
            })
            .unwrap();
        runtime
            .emit(EventKind::Routed {
                plan_type: "graph".into(),
                images: None,
            })
            .unwrap();
        runtime.store.select_run(Some("retained")).unwrap();
    }

    #[test]
    fn selection_finishes_before_initialization_or_recovery() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let before = unsupported(&root, 0);
        let selected = select(&root).unwrap();
        assert_eq!(selected.root, root.join("format-1"));
        assert!(!selected.root.join("events.sqlite").exists());
        assert!(runtime_lock::acquire(&root).is_err());
        assert!(runtime_lock::acquire(&selected.root).is_err());
        assert_eq!(fs::read(root.join("events.sqlite")).unwrap(), before);
        let runtime = selected.open(false).unwrap();
        assert!(runtime.root.join("events.sqlite").is_file());
    }

    #[test]
    fn startup_keeps_current_database_and_selected_run() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let mut runtime = open(&root, true).unwrap();
        assert_eq!(runtime.root, root);
        save(&mut runtime);
        drop(runtime);
        let runtime = open(&root, true).unwrap();
        assert_eq!(runtime.root, root);
        assert_eq!(runtime.state.run_id, "retained");
        assert!(!root.join("format-1").exists());
    }

    #[test]
    fn startup_preserves_incompatible_data_and_reuses_its_new_store() {
        for version in [0, 999] {
            let temp = TempDir::new().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let before = unsupported(&root, version);
            fs::write(root.join("config.json"), "incompatible config").unwrap();
            fs::create_dir(root.join("planning")).unwrap();
            fs::write(
                root.join("planning/old-summary.json"),
                "incompatible summary",
            )
            .unwrap();
            let mut runtime = open(&root, false).unwrap();
            let selected = root.join("format-1");
            assert_eq!(runtime.root, selected);
            assert!(runtime.store.runs().unwrap().is_empty());
            assert!(!selected.join("config.json").exists());
            assert!(!selected.join("planning").exists());
            assert_eq!(fs::read(root.join("events.sqlite")).unwrap(), before);
            assert!(runtime_lock::acquire(&root).is_err());
            assert!(runtime_lock::acquire(&selected).is_err());
            save(&mut runtime);
            let child = runtime.open_run("retained").unwrap();
            drop(runtime);
            assert!(runtime_lock::acquire(&root).is_err());
            assert!(runtime_lock::acquire(&selected).is_err());
            drop(child);
            let runtime = open(&root, true).unwrap();
            assert_eq!(runtime.root, selected);
            assert_eq!(runtime.state.run_id, "retained");
            assert_eq!(fs::read(root.join("events.sqlite")).unwrap(), before);
            assert_eq!(
                fs::read_to_string(root.join("config.json")).unwrap(),
                "incompatible config"
            );
            assert!(!root.join("format-1-2").exists());
        }
    }

    #[test]
    fn startup_reads_current_format_from_an_open_wal() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let store = crate::store::Store::open(&root.join("events.sqlite")).unwrap();
        assert!(root.join("events.sqlite-wal").exists());
        let runtime = open(&root, false).unwrap();
        assert_eq!(runtime.root, root);
        assert!(!root.join("format-1").exists());
        drop(runtime);
        drop(store);
    }

    #[test]
    fn startup_reuses_selected_history_after_the_original_database_is_archived() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let before = unsupported(&root, 0);
        let mut runtime = open(&root, false).unwrap();
        save(&mut runtime);
        drop(runtime);
        fs::rename(
            root.join("events.sqlite"),
            root.join("original.sqlite.saved"),
        )
        .unwrap();
        let runtime = open(&root, true).unwrap();
        assert_eq!(runtime.root, root.join("format-1"));
        assert_eq!(runtime.state.run_id, "retained");
        assert!(!root.join("events.sqlite").exists());
        assert_eq!(
            fs::read(root.join("original.sqlite.saved")).unwrap(),
            before
        );
    }

    #[test]
    fn startup_does_not_replace_a_missing_selection_or_follow_foreign_metadata() {
        for invalid_metadata in [false, true] {
            let temp = TempDir::new().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let before = unsupported(&root, 0);
            let runtime = open(&root, false).unwrap();
            drop(runtime);
            if invalid_metadata {
                fs::write(
                    selection_path(&root),
                    r#"{"formatVersion":1,"databaseFormat":1,"directory":"../foreign"}"#,
                )
                .unwrap();
            } else {
                fs::rename(
                    root.join("format-1/events.sqlite"),
                    root.join("format-1/saved.sqlite"),
                )
                .unwrap();
            }
            assert!(open(&root, false).is_err());
            assert!(!root.join("format-1-2").exists());
            assert_eq!(fs::read(root.join("events.sqlite")).unwrap(), before);
        }
    }

    #[test]
    fn startup_initializes_an_empty_unversioned_database_in_place() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        drop(Connection::open(root.join("events.sqlite")).unwrap());
        let runtime = open(&root, false).unwrap();
        assert_eq!(runtime.root, root);
        let database = Connection::open(root.join("events.sqlite")).unwrap();
        assert_eq!(
            database
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn startup_preserves_occupied_slots_and_reuses_the_first_compatible_one() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        unsupported(&root, 0);
        fs::create_dir(root.join("format-1")).unwrap();
        fs::write(root.join("format-1/keep.txt"), "unowned").unwrap();
        let incompatible = root.join("format-1-2");
        let before = unsupported(&incompatible, 999);
        let selected = root.join("format-1-3");
        let runtime = open(&root, false).unwrap();
        assert_eq!(runtime.root, selected);
        assert_eq!(
            fs::read(incompatible.join("events.sqlite")).unwrap(),
            before
        );
        assert_eq!(
            fs::read_to_string(root.join("format-1/keep.txt")).unwrap(),
            "unowned"
        );
        drop(runtime);
        assert_eq!(open(&root, false).unwrap().root, selected);
        assert!(!root.join("format-1-4").exists());
    }

    #[test]
    fn startup_never_bypasses_a_runtime_lease() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        unsupported(&root, 0);
        let original = runtime_lock::acquire(&root).unwrap();
        assert!(open(&root, false).is_err());
        assert!(!root.join("format-1").exists());
        drop(original);
        let candidate = root.join("format-1");
        let active = Runtime::open(&candidate).unwrap();
        assert!(open(&root, false).is_err());
        assert!(!root.join("format-1-2").exists());
        drop(active);
    }

    #[test]
    fn startup_reports_corruption_and_invalid_current_schema_without_switching() {
        for invalid_schema in [false, true] {
            let temp = TempDir::new().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let path = root.join("events.sqlite");
            if invalid_schema {
                let database = Connection::open(&path).unwrap();
                database
                    .execute_batch("PRAGMA user_version=1; CREATE TABLE unexpected(payload TEXT);")
                    .unwrap();
            } else {
                fs::write(&path, "not a SQLite database").unwrap();
            }
            let before = fs::read(&path).unwrap();
            assert!(open(&root, false).is_err());
            assert_eq!(fs::read(&path).unwrap(), before);
            assert!(!root.join("format-1").exists());
        }
    }

    #[test]
    fn startup_refuses_redirected_candidate_directories() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("data");
        unsupported(&root, 0);
        let target = temp.path().join("other");
        let runtime = Runtime::open(&target).unwrap();
        drop(runtime);
        let link = root.join("format-1");
        crate::path_safety::directory_link(&target, &link);
        let result = open(&root, false);
        assert!(
            result.is_err()
                || result.unwrap().root == root.canonicalize().unwrap().join("format-1-2")
        );
        assert!(fs::read_dir(&target)
            .unwrap()
            .all(|entry| entry.unwrap().file_name() != "format-1-2"));
        crate::path_safety::remove_directory_link(&link);
    }
}
