use super::*;

fn service(root: &std::path::Path) -> Arc<Service> {
    Arc::new(Service {
        runtime: Mutex::new(Runtime::open_lazy(root).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), Condvar::new()),
        planning: AtomicBool::new(false),
        extension: root.join("unused.ts"),
    })
}

#[test]
fn planning_history_and_snapshot_accept_resolved_aliases_without_crossing_bindings() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("中文 project");
    let other = temp.path().join("中文 project-other");
    fs::create_dir_all(project.join("child")).unwrap();
    fs::create_dir(&other).unwrap();
    let saved = project.canonicalize().unwrap().to_string_lossy().into_owned();
    let ordinary = crate::workspace::normalize_workspace_display_path(&project);
    let alias = project.join("child").join("..").to_string_lossy().into_owned();
    let service = service(&temp.path().join("data"));
    let summary = PlanningSummary {
        planning_id: "alias-history".into(), status: Some("failed".into()),
        repository: Some(saved.clone()), ..Default::default()
    };
    {
        let config: Config = serde_json::from_value(serde_json::json!({
            "repository": saved, "model": "mock/model", "maxParallel": 1
        })).unwrap();
        let mut runtime = service.runtime.lock().unwrap();
        runtime.emit(EventKind::PlanningStarted {
            goal: "failed planning".into(), config, planning: summary.clone(), plan_type: Some("graph".into()),
        }).unwrap();
        runtime.emit(EventKind::PlanningFailed { planning: summary.clone() }).unwrap();
    }
    for (id, repository) in [
        ("alias-history", Some(saved.clone())),
        ("other-history", Some(other.to_string_lossy().into_owned())),
        ("unattributed-history", None),
    ] {
        let directory = temp.path().join("data/planning").join(id);
        fs::create_dir_all(&directory).unwrap();
        write_planning_summary(&directory, &PlanningSummary {
            planning_id: id.into(), repository, ..summary.clone()
        }).unwrap();
    }
    for repository in [ordinary.clone(), alias, saved.clone()] {
        let histories = list_plannings(&service, Some(repository.clone())).unwrap();
        assert_eq!(histories.len(), 1, "query {repository:?}");
        assert_eq!(histories[0].planning_id, summary.planning_id);
        assert_eq!(histories[0].repository.as_deref(), Some(saved.as_str()), "do not rewrite saved bindings");
        let snapshot = dispatch(&service, "get_planning_snapshot", serde_json::json!({
            "planningId": summary.planning_id, "repository": repository,
        })).unwrap();
        assert_eq!(snapshot["phase"], "planning_failed");
    }
    assert_eq!(list_plannings(&service, None).unwrap().len(), 3);
    for repository in ["".to_owned(), "  ".to_owned(), "relative-project".to_owned(),
        temp.path().join("missing").to_string_lossy().into_owned()] {
        assert!(list_plannings(&service, Some(repository)).unwrap().is_empty());
    }
    let foreign = list_plannings(&service, Some(other.to_string_lossy().into_owned())).unwrap();
    assert_eq!(foreign.len(), 1);
    assert_eq!(foreign[0].planning_id, "other-history");
    assert!(dispatch(&service, "get_planning_snapshot", serde_json::json!({
        "planningId": summary.planning_id, "repository": other,
    })).unwrap_err().contains("repository mismatch"));
    let directory = temp.path().join("data/planning/alias-history");
    let persisted: PlanningSummary = serde_json::from_slice(&fs::read(directory.join("summary.json")).unwrap()).unwrap();
    assert_eq!(persisted.repository.as_deref(), Some(saved.as_str()));
    invalidate_service_cache(&temp.path().join("data"), None);
}

#[test]
fn nonexistent_repository_paths_never_match_just_because_resolution_failed() {
    let temp = tempfile::tempdir().unwrap();
    let left = temp.path().join("missing-left").to_string_lossy().into_owned();
    let right = temp.path().join("missing-right").to_string_lossy().into_owned();
    assert!(!same_repository_binding(&left, &right));
    assert!(same_repository_binding(&left, &left), "exact archived bindings remain readable");
    assert!(!same_repository_binding("", ""));
    assert!(!same_repository_binding("relative", &left));
    assert!(!same_repository_binding(&left, "  "));
}

#[cfg(windows)]
#[test]
fn archived_windows_planning_history_accepts_drive_prefix_case_and_separator_aliases() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("中文 archived project");
    fs::create_dir(&project).unwrap();
    let saved = project.canonicalize().unwrap().to_string_lossy().into_owned();
    let ordinary = crate::workspace::normalize_workspace_display_path(&project);
    fs::remove_dir(&project).unwrap();
    let service = service(&temp.path().join("data"));
    let directory = temp.path().join("data/planning/archived");
    fs::create_dir_all(&directory).unwrap();
    write_planning_summary(&directory, &PlanningSummary {
        planning_id: "archived".into(), status: Some("failed".into()),
        repository: Some(saved.clone()), ..Default::default()
    }).unwrap();
    for alias in [ordinary.clone(), ordinary.to_uppercase(), ordinary.replace('\\', "/"), format!("{ordinary}\\")] {
        assert!(same_repository_binding(&saved, &alias), "archived alias {alias:?}");
        assert_eq!(list_plannings(&service, Some(alias)).unwrap().len(), 1);
    }
    assert!(!same_repository_binding(&saved, &format!("{ordinary}-other")));
    assert!(!same_repository_binding(&saved, &format!("{ordinary}\\..\\中文 archived project")),
        "unresolvable parent traversal must not guess an identity");
}

#[cfg(windows)]
#[test]
fn unc_repository_keys_preserve_share_boundaries_without_network_access() {
    let key = |value: &str| windows_repository_key(std::path::Path::new(value));
    assert_eq!(key(r"\\?\UNC\HOST\Share\中文 Project"), key(r"\\host\share\中文 project"));
    assert_eq!(key(r"\\?\unc\host\share\project\"), key("//host/share/project"));
    assert_ne!(key(r"\\host\share\project"), key(r"\\host\other-share\project"));
    assert_ne!(key(r"\\host\share\project"), key(r"\\other-host\share\project"));
    assert_eq!(key(r"\\host\share\project\..\project"), None);
    assert_eq!(key("relative-project"), None);
}
