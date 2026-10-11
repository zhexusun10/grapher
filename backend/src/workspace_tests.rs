use crate::workspace;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

fn source(temp: &TempDir) -> (PathBuf, String) {
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    fs::write(
        repository.join(".gitignore"),
        ".cache/\npackages/\n*.large\n",
    )
    .unwrap();
    fs::write(repository.join("tracked.txt"), "from Git history").unwrap();
    let head = workspace::snapshot_repository(&repository).unwrap();
    (repository, head)
}

fn prepared_copy(
    source: &Path,
    destination: &Path,
    head: &str,
    exclusions: &[String],
    runtime_data: &Path,
) {
    workspace::prepare(source, destination, head, &[]).unwrap();
    workspace::copy_ordinary_files(source, destination, exclusions, runtime_data).unwrap();
}

#[test]
fn ordinary_copy_ignores_gitignore_and_keeps_tracked_files_from_the_git_commit() {
    let temp = tempfile::tempdir().unwrap();
    let (source, head) = source(&temp);
    fs::create_dir(source.join(".cache")).unwrap();
    fs::write(source.join(".cache/input"), "ordinary bytes").unwrap();
    fs::write(source.join("tracked.txt"), "late source edit").unwrap();
    let a = temp.path().join("a");
    let b = temp.path().join("b");

    prepared_copy(&source, &a, &head, &[], &temp.path().join("runtime"));
    prepared_copy(&source, &b, &head, &[], &temp.path().join("runtime"));

    assert_eq!(fs::read_to_string(a.join(".cache/input")).unwrap(), "ordinary bytes");
    assert_eq!(fs::read_to_string(a.join("tracked.txt")).unwrap(), "from Git history");
    fs::write(a.join(".cache/input"), "changed in A").unwrap();
    assert_eq!(fs::read_to_string(b.join(".cache/input")).unwrap(), "ordinary bytes");
    assert_eq!(fs::read_to_string(source.join(".cache/input")).unwrap(), "ordinary bytes");
    assert!(a.join(".git").is_dir());
}

#[test]
fn ordinary_copy_excludes_runtime_data_environment_scopes_and_grapher_internals() {
    let temp = tempfile::tempdir().unwrap();
    let (source, head) = source(&temp);
    fs::create_dir_all(source.join("packages/wheels")).unwrap();
    fs::write(source.join("packages/wheels/big.whl"), "environment data").unwrap();
    fs::create_dir_all(source.join("local-data")).unwrap();
    fs::write(source.join("local-data/runtime.db"), "runtime data").unwrap();
    fs::create_dir_all(source.join(".grapher-private")).unwrap();
    fs::write(source.join(".grapher-private/secret"), "internal").unwrap();
    let destination = temp.path().join("target");
    prepared_copy(
        &source,
        &destination,
        &head,
        &["packages".into()],
        &source.join("local-data"),
    );

    assert!(!destination.join("packages").exists());
    assert!(!destination.join("local-data").exists());
    assert!(!destination.join(".grapher-private").exists());
}

#[cfg(unix)]
#[test]
fn ordinary_copy_preserves_symbolic_links_and_permissions_without_following_targets() {
    use std::os::unix::{fs::PermissionsExt, fs::symlink};
    let temp = tempfile::tempdir().unwrap();
    let (source, head) = source(&temp);
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), "external").unwrap();
    fs::create_dir(source.join(".cache")).unwrap();
    fs::write(source.join(".cache/tool"), "tool").unwrap();
    fs::set_permissions(source.join(".cache/tool"), fs::Permissions::from_mode(0o750)).unwrap();
    symlink(&outside, source.join(".cache/external")).unwrap();
    let destination = temp.path().join("target");
    prepared_copy(&source, &destination, &head, &[], &temp.path().join("runtime"));

    let link = destination.join(".cache/external");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_link(link).unwrap(), outside);
    assert_eq!(fs::metadata(destination.join(".cache/tool")).unwrap().permissions().mode() & 0o777, 0o750);
}

#[cfg(unix)]
#[test]
fn ordinary_copy_rejects_unsupported_special_files_explicitly() {
    let temp = tempfile::tempdir().unwrap();
    let (source, head) = source(&temp);
    let special = source.join(".cache/pipe");
    fs::create_dir(source.join(".cache")).unwrap();
    let name = std::ffi::CString::new(special.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let destination = temp.path().join("target");
    workspace::prepare(&source, &destination, &head, &[]).unwrap();
    let error = workspace::copy_ordinary_files(
        &source,
        &destination,
        &[],
        &temp.path().join("runtime"),
    )
    .unwrap_err();
    assert!(error.contains("Unsupported special workspace file"));
}

#[test]
fn git_snapshots_collect_gitignored_project_files_without_a_large_file_gate() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    fs::write(repository.join(".gitignore"), "packages/\n").unwrap();
    fs::write(repository.join("tracked.txt"), "tracked").unwrap();
    workspace::snapshot_repository(&repository).unwrap();

    fs::create_dir_all(repository.join("packages")) .unwrap();
    fs::write(repository.join("packages/data.bin"), vec![7; 2 * 1024 * 1024]).unwrap();
    workspace::snapshot_repository(&repository).unwrap();

    let tracked = workspace::git(&repository, &["ls-files"]).unwrap();
    assert!(tracked.lines().any(|name| name == "packages/data.bin"));
}
