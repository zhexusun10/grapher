use crate::workspace;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

#[test]
fn git_line_ending_warnings_do_not_fail_snapshots() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path();
    workspace::git(repository, &["init", "-q"]).unwrap();
    workspace::git(repository, &["config", "core.autocrlf", "true"]).unwrap();
    workspace::git(repository, &["config", "core.safecrlf", "warn"]).unwrap();
    fs::write(repository.join(".gitattributes"), "*.txt text\n").unwrap();
    fs::write(repository.join("input.txt"), "first\nsecond\n").unwrap();

    // Confirm this repository really produces a successful add with warnings.
    let mut command = std::process::Command::new("git");
    crate::native::clear_git_environment(&mut command);
    let output = command.args(["add", "--", "input.txt"])
        .env("LC_ALL", "C")
        .current_dir(repository).output().unwrap();
    assert!(output.status.success(), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("LF will be replaced by CRLF"), "{stderr}");

    fs::write(repository.join("input.txt"), "updated\nsecond\n").unwrap();
    let head = workspace::snapshot_repository(repository).unwrap();
    assert!(!head.is_empty());
    assert_eq!(workspace::git(repository, &["show", "HEAD:input.txt"]).unwrap(), "updated\nsecond");
    assert_eq!(workspace::snapshot_repository(repository).unwrap(), head);
}

#[test]
fn git_strict_line_ending_failure_is_not_treated_as_a_warning() {
    let temp = tempfile::tempdir().unwrap();
    workspace::git(temp.path(), &["init", "-q"]).unwrap();
    workspace::git(temp.path(), &["config", "core.autocrlf", "true"]).unwrap();
    workspace::git(temp.path(), &["config", "core.safecrlf", "true"]).unwrap();
    fs::write(temp.path().join(".gitattributes"), "*.txt text\n.gitattributes -text\n").unwrap();
    fs::write(temp.path().join("input.txt"), "first\nsecond\n").unwrap();
    let error = workspace::snapshot_repository(temp.path()).unwrap_err();
    assert!(error.contains("exit code: 128") || error.contains("exit status: 128"), "{error}");
    assert!(error.contains("fatal:"), "{error}");
    assert!(error.contains("input.txt"), "{error}");
}

#[test]
fn git_failure_keeps_exit_status_command_directory_and_both_streams() {
    let temp = tempfile::tempdir().unwrap();
    let error = workspace::git(temp.path(), &[
        "-c",
        "alias.grapher-fail=!printf 'failure detail on stdout\\n'; printf 'warning: line endings\\n' >&2; exit 23",
        "grapher-fail",
    ]).unwrap_err();
    assert!(error.contains("exit code: 23") || error.contains("exit status: 23"), "{error}");
    assert!(error.contains("grapher-fail"), "{error}");
    assert!(error.contains(&temp.path().display().to_string()), "{error}");
    assert!(error.contains("stderr:\nwarning: line endings"), "{error}");
    assert!(error.contains("stdout:\nfailure detail on stdout"), "{error}");
}

#[test]
fn git_failure_without_output_still_explains_which_command_failed() {
    let temp = tempfile::tempdir().unwrap();
    let error = workspace::git(temp.path(), &[
        "-c", "alias.grapher-fail=!exit 19", "grapher-fail",
    ]).unwrap_err();
    assert!(error.contains("exit code: 19") || error.contains("exit status: 19"), "{error}");
    assert!(error.contains("grapher-fail"), "{error}");
    assert!(error.contains(&temp.path().display().to_string()), "{error}");
}

#[cfg(windows)]
#[test]
fn git_crash_with_only_warnings_keeps_windows_exception_status() {
    use std::os::windows::process::ExitStatusExt;
    let output = std::process::Output {
        status: std::process::ExitStatus::from_raw(0xC0000005),
        stdout: Vec::new(),
        stderr: b"warning: LF will be replaced by CRLF\n".to_vec(),
    };
    let error = workspace::git_command_failure(Path::new("C:/project"), &["add", "-f", "-A"], &output);
    assert!(error.contains("0xC0000005"), "{error}");
    assert!(error.contains("add"), "{error}");
    assert!(error.contains("warning: LF will be replaced by CRLF"), "{error}");
}

#[cfg(windows)]
#[test]
fn git_control_c_exit_is_reported_as_console_interruption() {
    use std::os::windows::process::ExitStatusExt;
    let output = std::process::Output {
        status: std::process::ExitStatus::from_raw(0xC000013A),
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    let error = workspace::git_command_failure(Path::new("C:/project"), &["commit", "-m", "snapshot"], &output);
    assert!(error.contains("0xC000013A"), "{error}");
    assert!(error.contains("console control event"), "{error}");
    assert!(error.contains("Ctrl+C/Ctrl+Break"), "{error}");
}

#[cfg(unix)]
#[test]
fn git_killed_with_only_warnings_keeps_signal_status() {
    use std::os::unix::process::ExitStatusExt;
    let output = std::process::Output {
        status: std::process::ExitStatus::from_raw(9),
        stdout: Vec::new(),
        stderr: b"warning: line endings\n".to_vec(),
    };
    let error = workspace::git_command_failure(Path::new("/project"), &["add", "-f", "-A"], &output);
    assert!(error.contains(&output.status.to_string()), "{error}");
    assert!(error.contains("warning: line endings"), "{error}");
}

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
fn host_metadata_is_excluded_from_forced_snapshots_unless_already_tracked() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    fs::write(repository.join(".gitignore"), ".DS_Store\n._*\n").unwrap();
    fs::write(repository.join("keep.txt"), "keep").unwrap();
    fs::write(repository.join(".DS_Store"), "tracked metadata").unwrap();
    workspace::git(&repository, &["add", "-f", ".gitignore", "keep.txt", ".DS_Store"]).unwrap();
    workspace::git(&repository, &["commit", "-qm", "base"]).unwrap();

    fs::create_dir(repository.join("nested")).unwrap();
    fs::write(repository.join("nested/.DS_Store"), "untracked nested").unwrap();
    fs::write(repository.join("._xattr"), "untracked apple double").unwrap();
    fs::write(repository.join(".DS_Store"), "tracked metadata updated").unwrap();
    fs::write(repository.join("keep.txt"), "keep updated").unwrap();
    let head = workspace::snapshot_repository(&repository).unwrap();
    let tree = workspace::git(&repository, &["ls-tree", "-r", "--name-only", "HEAD"]).unwrap();
    let names: Vec<&str> = tree.lines().collect();

    if cfg!(target_os = "macos") {
        assert!(names.contains(&".DS_Store"), "explicitly tracked metadata remains: {names:?}");
        assert_eq!(
            workspace::git(&repository, &["show", "HEAD:.DS_Store"]).unwrap(),
            "tracked metadata updated"
        );
        assert!(!names.contains(&"nested/.DS_Store"), "Finder metadata entered the snapshot: {names:?}");
        assert!(!names.contains(&"._xattr"), "AppleDouble metadata entered the snapshot: {names:?}");
    } else {
        // Keep the Windows/Linux collection contract unchanged.
        assert!(names.contains(&"nested/.DS_Store"), "non-macOS metadata collection changed: {names:?}");
        assert!(names.contains(&"._xattr"), "non-macOS metadata collection changed: {names:?}");
    }

    // Untracked Finder metadata created after a snapshot must not keep the
    // workspace permanently dirty, while tracked metadata edits stay visible.
    fs::write(repository.join("._late"), "late apple double").unwrap();
    fs::write(repository.join("._space file"), "quoted apple double").unwrap();
    assert_eq!(
        workspace::repository_status(&repository, &[]).unwrap().is_empty(),
        cfg!(target_os = "macos")
    );
    assert_eq!(
        workspace::repository_status(&repository, &["managed".into()]).unwrap().is_empty(),
        cfg!(target_os = "macos")
    );
    fs::write(repository.join(".DS_Store"), "pending tracked edit").unwrap();
    assert!(!workspace::repository_status(&repository, &[]).unwrap().is_empty());
    assert!(!workspace::repository_status(&repository, &["managed".into()]).unwrap().is_empty());
    fs::write(repository.join(".DS_Store"), "tracked metadata updated").unwrap();

    let destination = temp.path().join("target");
    prepared_copy(&repository, &destination, &head, &[], &temp.path().join("runtime"));
    assert_eq!(
        fs::read_to_string(destination.join(".DS_Store")).unwrap(),
        "tracked metadata updated"
    );
    if cfg!(target_os = "macos") {
        assert!(!destination.join("nested/.DS_Store").exists());
        assert!(!destination.join("._xattr").exists());
        assert!(!destination.join("._space file").exists());
    } else {
        assert_eq!(
            fs::read_to_string(destination.join("nested/.DS_Store")).unwrap(),
            "untracked nested"
        );
        assert_eq!(
            fs::read_to_string(destination.join("._xattr")).unwrap(),
            "untracked apple double"
        );
    }
}

#[test]
fn host_metadata_does_not_dirty_a_shadow_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    fs::write(project.join("main.py"), "print('hello')\n").unwrap();
    workspace::materialize_shadow_repo(&project, &[]).unwrap();
    fs::write(project.join("._late"), "metadata").unwrap();
    assert_eq!(
        workspace::repository_status(&project, &[]).unwrap().is_empty(),
        cfg!(target_os = "macos")
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_filtered_status_preserves_tracked_and_rename_entries() {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("source");
    fs::create_dir(&repository).unwrap();
    workspace::git(&repository, &["init", "-q"]).unwrap();
    fs::write(repository.join("a.txt"), "a").unwrap();
    workspace::git(&repository, &["add", "-A"]).unwrap();
    workspace::git(&repository, &["commit", "-qm", "base"]).unwrap();
    workspace::git(&repository, &["mv", "a.txt", "b.txt"]).unwrap();
    workspace::repository_status(&repository, &["managed".into()]).unwrap();
    fs::write(repository.join("._late"), "metadata").unwrap();
    let status = workspace::repository_status(&repository, &["managed".into()]).unwrap();
    assert!(status.contains("R  b.txt -> a.txt"), "rename status lost: {status}");
    assert!(!status.contains("._late"), "host metadata leaked into status: {status}");
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
