use grapher::workspace;
use std::{env, fs};
use tempfile::TempDir;

#[test]
fn data_root_resolves_parent_traversal_before_building_session_paths() {
    let temp = TempDir::new().unwrap();
    let base = temp.path().canonicalize().unwrap();
    fs::create_dir_all(base.join("backend")).unwrap();
    let alias = base.join("backend/../.grapher");
    fs::create_dir_all(&alias).unwrap();
    let previous = env::var_os("GRAPHER_DATA_DIR");
    env::set_var("GRAPHER_DATA_DIR", &alias);
    let data = workspace::data_root();
    if let Some(value) = previous {
        env::set_var("GRAPHER_DATA_DIR", value);
    } else {
        env::remove_var("GRAPHER_DATA_DIR");
    }
    assert_eq!(data, base.join(".grapher"));

    #[cfg(target_os = "macos")]
    {
        use grapher::sandbox;
        let source = base.join("source");
        let worktrees = base.join(".grapher-workspaces");
        let current = worktrees.join("run/planner");
        let session = data.join("planning/attempt/planner-session");
        let engine = base.join("engine");
        for dir in [&source, &current, &session, &engine] {
            fs::create_dir_all(dir).unwrap();
        }
        let profile = base.join("profile.sb");
        sandbox::write_execution_profile(
            &profile, &source, &worktrees, &current, &data, &session, &engine,
        ).unwrap();
        // Do not relax the sandbox's rejection of unnormalized exception paths.
        assert!(sandbox::write_execution_profile(
            &profile, &source, &worktrees, &current, &data,
            &alias.join("planning/attempt/planner-session"), &engine,
        ).is_err());
    }
}
