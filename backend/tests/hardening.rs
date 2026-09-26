use grapher::{
    compiler::{compile, compile_legacy},
    model::{Edge, Graph, Node},
    workspace,
};
use tempfile::TempDir;

#[test]
fn graphs_larger_than_64_nodes_compile() {
    let graph = Graph {
        original_goal: "Large graph".into(),
        nodes: (0..128)
            .map(|i| Node {
                name: format!("node_{i}"),
                task: "Execute task".into(),
            })
            .collect(),
        edges: (1..128)
            .map(|i| Edge {
                from: format!("node_{}", i - 1),
                to: format!("node_{i}"),
                relation: "dependency".into(),
                feedback: false,
            })
            .collect(),
    };
    assert!(compile(&graph, true).is_ok());
    assert!(compile_legacy(&graph, true).is_ok());
}

#[test]
fn shadow_identity_requires_an_existing_path() {
    let temp = TempDir::new().unwrap();
    let missing = temp.path().join("missing");
    let error = workspace::shadow_repo_dir(&missing).unwrap_err();
    assert!(error.contains("Cannot resolve workspace path"));
    assert!(workspace::ensure_shadow_repo(&missing).is_err());
    assert!(!missing.exists());
}

#[cfg(target_os = "macos")]
#[test]
fn sandbox_rejects_symlinked_exceptions() {
    use grapher::sandbox;
    use std::{fs, os::unix::fs::symlink};
    let temp = TempDir::new().unwrap();
    let base = temp.path();
    let source = base.join("source");
    let root = base.join("worktrees");
    let current = root.join("run/current");
    let data = base.join("data");
    let session = data.join("session");
    let engine = base.join("engine");
    for dir in [&source, &current, &session, &engine] {
        fs::create_dir_all(dir).unwrap();
    }
    let profile = base.join("profile.sb");
    sandbox::write_execution_profile(&profile, &source, &root, &current, &data, &session, &engine)
        .unwrap();
    let alias = root.join("alias");
    symlink(root.join("run"), &alias).unwrap();
    assert!(
        sandbox::write_graph_profile(&profile, &source, &root, &alias.join("current")).is_err()
    );
    let session_alias = data.join("session-alias");
    symlink(&session, &session_alias).unwrap();
    assert!(sandbox::write_execution_profile(
        &profile,
        &source,
        &root,
        &current,
        &data,
        &session_alias,
        &engine
    )
    .is_err());
    assert!(sandbox::write_graph_profile(
        &profile,
        &source,
        &root,
        &root.join("run/../run/current")
    )
    .is_err());
}
