use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

type FileWindows = BTreeMap<String, usize>;

/// Fallback for legacy sessions without an actual Pi context snapshot. Prefer
/// the latest Pi provider catalog, then installed/user model files; never guess
/// capacity from a model name. Active sessions report their own window directly.
pub(crate) fn context_window(model: &str) -> Option<usize> {
    dynamic_catalog().read().ok().and_then(|windows| windows.get(model).copied())
        .or_else(|| catalog().get(model).copied())
}

fn dynamic_catalog() -> &'static RwLock<BTreeMap<String, usize>> {
    static WINDOWS: OnceLock<RwLock<BTreeMap<String, usize>>> = OnceLock::new();
    WINDOWS.get_or_init(|| RwLock::new(BTreeMap::new()))
}

/// Provider/Auth already enumerates Pi's runtime models for preflight/settings.
/// Preserve that backend result for old sessions, including network models that
/// do not occur in the shipped files. This cache never overrides live snapshots.
pub(crate) fn remember_catalog(value: &serde_json::Value) {
    let Some(windows) = catalog_models(value) else { return };
    if let Ok(mut catalog) = dynamic_catalog().write() { *catalog = windows; }
}

fn catalog_models(value: &serde_json::Value) -> Option<BTreeMap<String, usize>> {
    let models = value.get("models").and_then(|models| models.as_array())?;
    let mut windows = BTreeMap::new();
    for model in models {
        let (Some(provider), Some(id), Some(window)) = (
            model.get("provider").and_then(|v| v.as_str()).filter(|v| !v.is_empty()),
            model.get("id").and_then(|v| v.as_str()).filter(|v| !v.is_empty()),
            model.get("contextWindow").and_then(|v| v.as_u64())
                .and_then(|v| usize::try_from(v).ok()).filter(|v| *v > 0),
        ) else { continue };
        windows.insert(format!("{provider}/{id}"), window);
    }
    Some(windows)
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
        let mut windows = flatten(files);
        // Pi's agent models.json carries user-defined providers and local model
        // aliases that the shipped catalog cannot know. Load it last so an
        // explicit user definition wins over a built-in model with the same id.
        for path in agent_model_files() {
            windows.extend(load_agent_models(&path));
        }
        windows
    })
}

fn agent_model_files() -> Vec<PathBuf> {
    if let Some(directory) = crate::native::environment_path("PI_CODING_AGENT_DIR") {
        return vec![directory.join("models.json")];
    }
    let Some(home) = crate::native::home_dir() else { return Vec::new() };
    // `.pi` is Pi's upstream location; Grapher's private agent copy is created
    // from it at startup and takes precedence when present.
    vec![
        home.join(".pi/agent/models.json"),
        home.join(".grapher/pi-agent/models.json"),
    ]
}

/// `models.json` stores providers as `{ providers: { id: { models: [...] } } }`.
/// A model id may itself contain a slash (`cline-pass/...`), so the provider key
/// is the prefix, not the first segment of the id.
fn load_agent_models(path: &Path) -> BTreeMap<String, usize> {
    let Ok(bytes) = std::fs::read(path) else { return BTreeMap::new() };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return BTreeMap::new() };
    let Some(providers) = value.get("providers").and_then(|value| value.as_object()) else {
        return BTreeMap::new();
    };
    let mut windows = BTreeMap::new();
    for (provider_key, provider) in providers {
        let Some(models) = provider.get("models").and_then(|models| models.as_array()) else {
            continue;
        };
        for model in models {
            let (Some(id), Some(window)) = (
                model.get("id").and_then(|value| value.as_str()),
                model.get("contextWindow").and_then(|value| value.as_u64()),
            ) else {
                continue;
            };
            let provider = model
                .get("provider")
                .and_then(|value| value.as_str())
                .filter(|provider| !provider.is_empty())
                .unwrap_or(provider_key);
            if id.is_empty() || window == 0 {
                continue;
            }
            windows.insert(format!("{provider}/{id}"), window as usize);
        }
    }
    windows
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
    fn custom_agent_models_supply_windows_the_shipped_catalog_cannot_know() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("models.json");
        let payload = serde_json::json!({
            "providers": {
                "cline": {
                    "models": [
                        // The model id itself contains a slash; the provider key
                        // must still be the prefix used by the configured model.
                        { "id": "cline-pass/deepseek-v4.1-flash", "contextWindow": 500_000 },
                        { "id": "explicit", "provider": "custom", "contextWindow": 128_000 },
                        { "id": "no-window" },
                        { "id": "zero", "contextWindow": 0 },
                    ]
                }
            }
        });
        std::fs::write(&path, payload.to_string()).unwrap();
        let windows = load_agent_models(&path);
        assert_eq!(windows.get("cline/cline-pass/deepseek-v4.1-flash"), Some(&500_000));
        assert_eq!(windows.get("custom/explicit"), Some(&128_000));
        assert_eq!(windows.len(), 2);
        assert!(load_agent_models(&temp.path().join("missing.json")).is_empty());
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
