pub mod cleanup;
#[cfg(test)]
mod cleanup_tests;
pub mod compiler;
pub mod engine;
pub mod environment;
mod environment_automatic;
pub mod environment_discovery;
pub mod environment_resources;
pub mod file_changes;
#[cfg(feature = "fixture")]
pub mod fixture;
pub mod graph_merge;
#[cfg(target_os = "linux")]
pub mod linux_sandbox;
pub mod maintenance;
pub mod model;
pub mod native;
mod native_copy;
mod native_runtime_storage;
mod path_identity;
mod path_safety;
pub mod pi_extensions;
pub mod process_control;
pub mod provider_auth;
pub mod runtime;
pub mod runtime_lock;
pub mod sandbox;
pub mod server;
pub mod session_branch;
pub mod snapshot_view;
pub mod store;
pub mod workspace;
mod workspace_cleanup;
mod workspace_files;

/// Process-wide disposable data root for tests. Fixtures that create or
/// materialize shadow Git metadata must call this first so no test writes into
/// the checkout's `.grapher`. Unit tests resolve it automatically through
/// [`workspace::data_root`].
#[cfg(any(test, feature = "fixture"))]
#[doc(hidden)]
pub fn ensure_test_data_root() -> std::path::PathBuf {
    static ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        let base = std::env::temp_dir().join(format!("grapher-tests-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&base);
        std::env::set_var("GRAPHER_DATA_DIR", &base);
        base
    })
    .clone()
}
