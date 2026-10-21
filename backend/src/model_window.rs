use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

type FileWindows = BTreeMap<String, usize>;

/// Context window Pi reports for `provider/model`, read from the model catalog
/// the engine already ships. Session details compare the newest prompt against
/// it; an unknown, local-only or overridden model simply has no denominator, so
/// nothing is guessed from the model name.
pub(crate) fn context_window(model: &str) -> Option<usize> {
    catalog().get(model).copied()
}

fn catalog() -> &'static BTreeMap<String, usize> {
    static CATALOG: OnceLock<BTreeMap<String, usize>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let root = crate::native::installation_root();
        let mut files = load(&root.join("engine/model-data"));
        // The git-ignored overlay holds full-file provider overrides and wins,
        // exactly as the engine's own catalog staging applies it.
        for (name, windows) in load(&root.join("engine/model-data-local")) {
            files.insert(name, windows);
        }
        flatten(files)
    })
}

fn flatten(files: BTreeMap<String, FileWindows>) -> BTreeMap<String, usize> {
    let mut windows = BTreeMap::new();
    for models in files.into_values() {
        for (model, window) in models {
            windows.entry(model).or_insert(window);
        }
    }
    windows
}

/// Provider files are `api -> model key -> model record`; a file is the unit of
/// override, so this keeps them separate until the baseline and overlay merge.
fn load(directory: &Path) -> BTreeMap<String, FileWindows> {
    let mut files = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(directory) else { return files };
    let mut paths: Vec<_> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
        .collect();
    paths.sort();
    for path in paths {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else { continue };
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else { continue };
        let Some(apis) = value.as_object() else { continue };
        let mut windows = FileWindows::new();
        for provider_models in apis.values() {
            let Some(models) = provider_models.as_object() else { continue };
            for model in models.values() {
                let (Some(provider), Some(id), Some(window)) = (
                    model.get("provider").and_then(|value| value.as_str()),
                    model.get("id").and_then(|value| value.as_str()),
                    model.get("contextWindow").and_then(|value| value.as_u64()),
                ) else {
                    continue;
                };
                if provider.is_empty() || id.is_empty() || window == 0 {
                    continue;
                }
                windows
                    .entry(format!("{provider}/{id}"))
                    .or_insert(window as usize);
            }
        }
        files.insert(name.to_string(), windows);
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_provider(directory: &Path, name: &str, models: &[(&str, u64)]) {
        std::fs::create_dir_all(directory).unwrap();
        let mut api = serde_json::Map::new();
        for (model, window) in models {
            api.insert(
                format!("chat:{model}"),
                serde_json::json!({ "id": model, "provider": name, "contextWindow": window }),
            );
        }
        let data = serde_json::json!({ "sample-api": api });
        std::fs::write(directory.join(format!("{name}.json")), data.to_string()).unwrap();
    }

    #[test]
    fn the_installed_catalog_resolves_models_from_the_engine_directory() {
        // Packaged test layouts may not ship the checkout's generated catalog;
        // where it exists, `catalog()` must read the same directory the engine
        // installs beside its entrypoint.
        if !crate::native::installation_root().join("engine/model-data").is_dir() {
            return;
        }
        assert!(!catalog().is_empty(), "the installed model catalog must resolve models");
    }

    #[test]
    fn windows_are_keyed_by_provider_and_model_id() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("model-data");
        write_provider(&data, "openai", &[("gpt-6.1-sol", 272_000)]);
        std::fs::write(data.join("notes.txt"), "ignored").unwrap();
        std::fs::write(data.join("broken.json"), "{").unwrap();

        let windows = flatten(load(&data));
        assert_eq!(windows.get("openai/gpt-6.1-sol"), Some(&272_000));
        assert_eq!(windows.len(), 1);
        // Another provider reusing a model id must not inherit the window.
        assert_eq!(windows.get("azure/gpt-6.1-sol"), None);
    }

    #[test]
    fn records_without_a_usable_window_or_identity_are_skipped() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("model-data");
        std::fs::create_dir_all(&data).unwrap();
        let payload = serde_json::json!({
            "sample-api": {
                "chat:no-window": { "id": "no-window", "provider": "sample" },
                "chat:zero": { "id": "zero", "provider": "sample", "contextWindow": 0 },
                "chat:unlabelled": { "id": "", "provider": "sample", "contextWindow": 10 },
                "chat:anonymous": { "id": "anonymous", "contextWindow": 10 },
            }
        });
        std::fs::write(data.join("sample.json"), payload.to_string()).unwrap();
        assert!(flatten(load(&data)).is_empty());
        assert!(load(&temp.path().join("missing")).is_empty());
    }

    #[test]
    fn the_local_overlay_replaces_a_shipped_provider_file() {
        let temp = tempfile::tempdir().unwrap();
        let shipped = temp.path().join("model-data");
        let overlay = temp.path().join("model-data-local");
        write_provider(&shipped, "sample", &[("tuned", 1_000), ("dropped", 4_000)]);
        write_provider(&overlay, "sample", &[("tuned", 2_000)]);

        let mut files = load(&shipped);
        for (name, windows) in load(&overlay) {
            files.insert(name, windows);
        }
        let windows = flatten(files);
        // The override replaces the whole provider file: its window wins and a
        // model the developer removed locally does not survive.
        assert_eq!(windows.get("sample/tuned"), Some(&2_000));
        assert_eq!(windows.get("sample/dropped"), None);
    }
}
