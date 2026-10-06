use super::configured_prewarm_config;
use crate::{model::Config, runtime::Runtime};
use std::fs;

fn config(repository: &str, model: &str) -> Config {
    serde_json::from_value(serde_json::json!({
        "repository": repository, "model": model, "maxParallel": 1
    }))
    .unwrap()
}

#[test]
fn unconfigured_startup_does_not_discover_or_snapshot_the_installation() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::open_lazy(temp.path()).unwrap();
    assert!(configured_prewarm_config(&runtime).is_none());
    assert!(!temp.path().join("shadow_repos").exists());
}

#[test]
fn saved_settings_choose_the_next_warm_project_without_rebinding_history() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = Runtime::open_lazy(temp.path()).unwrap();
    runtime.state.config = Some(config("historical-project", "history/model"));
    fs::write(
        temp.path().join("config.json"),
        serde_json::to_vec(&config("selected-project", "selected/model")).unwrap(),
    )
    .unwrap();
    let warm = configured_prewarm_config(&runtime).unwrap();
    assert_eq!(warm.repository, "selected-project");
    assert_eq!(warm.model, "selected/model");
    assert_eq!(
        runtime.state.config.as_ref().unwrap().repository,
        "historical-project"
    );
}

#[test]
fn missing_or_invalid_settings_fall_back_to_event_config_and_normalize_legacy_models() {
    let temp = tempfile::tempdir().unwrap();
    let mut runtime = Runtime::open_lazy(temp.path()).unwrap();
    runtime.state.config = Some(config("selected-project", "legacy-model"));
    for saved in [None, Some("not JSON")] {
        if let Some(saved) = saved {
            fs::write(temp.path().join("config.json"), saved).unwrap();
        }
        let warm = configured_prewarm_config(&runtime).unwrap();
        assert_eq!(warm.repository, "selected-project");
        assert!(warm.model.is_empty());
        assert_eq!(runtime.state.config.as_ref().unwrap().model, "legacy-model");
    }
    runtime.state.config = Some(config(" ", "provider/model"));
    assert!(configured_prewarm_config(&runtime).is_none());
}
