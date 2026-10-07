use super::*;
use tempfile::TempDir;

fn setup() -> (TempDir, PathBuf, Files, String, String) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join(".gitignore"), ".cache/\n.venv/\n.grapher/\n*.cache\n").unwrap();
    fs::write(source.join("code.txt"), "code").unwrap();
    workspace::git(&source, &["init", "-q"]).unwrap();
    let head = workspace::snapshot_repository(&source).unwrap();
    fs::create_dir(source.join(".cache")).unwrap();
    fs::write(source.join(".cache/base"), "base").unwrap();
    let files = Files::new(&temp.path().join("data"), &Uuid::new_v4().to_string()).unwrap();
    let base = Uuid::new_v4().to_string();
    files.capture(&source, &base, &head, &[]).unwrap();
    (temp, source, files, base, head)
}

fn child(source: &Path, destination: &Path, head: &str, files: &Files, inputs: &[String]) {
    workspace::prepare(source, destination, head, &[]).unwrap();
    files.materialize(destination, inputs, None, false).unwrap();
}

#[test]
fn ignored_files_are_frozen_and_materialized_without_writable_aliases() {
    let (temp, source, files, base, head) = setup();
    fs::write(source.join(".cache/base"), "late source edit").unwrap();
    let left = temp.path().join("left");
    let right = temp.path().join("right");
    child(&source, &left, &head, &files, &[base.clone()]);
    child(&source, &right, &head, &files, &[base.clone()]);
    assert_eq!(fs::read_to_string(left.join(".cache/base")).unwrap(), "base");
    fs::write(left.join(".cache/base"), "left edit").unwrap();
    assert_eq!(fs::read_to_string(right.join(".cache/base")).unwrap(), "base");
    assert_eq!(fs::read_to_string(source.join(".cache/base")).unwrap(), "late source edit");
    assert!(!workspace::git(&left, &["ls-files"]).unwrap().contains(".cache/base"));
    assert_eq!(fs::read_to_string(left.join(".gitignore")).unwrap().replace("\r\n", "\n"), ".cache/\n.venv/\n.grapher/\n*.cache\n");
}

#[test]
fn fan_in_merges_independent_ignored_changes_and_deletions() {
    let (temp, source, files, base, head) = setup();
    let mut inputs = Vec::new();
    for name in ["left", "right"] {
        let path = temp.path().join(name);
        child(&source, &path, &head, &files, &[base.clone()]);
        fs::write(path.join(format!(".cache/{name}")), name).unwrap();
        if name == "left" { fs::remove_file(path.join(".cache/base")).unwrap(); }
        let version = Uuid::new_v4().to_string();
        files.capture(&path, &version, &head, &[base.clone()]).unwrap();
        inputs.push(version);
    }
    let target = temp.path().join("target");
    child(&source, &target, &head, &files, &inputs);
    assert_eq!(fs::read_to_string(target.join(".cache/left")).unwrap(), "left");
    assert_eq!(fs::read_to_string(target.join(".cache/right")).unwrap(), "right");
    assert!(!target.join(".cache/base").exists());
}

#[test]
fn ignored_conflicts_fail_before_any_destination_change() {
    let (temp, source, files, base, head) = setup();
    let mut inputs = Vec::new();
    for name in ["left", "right"] {
        let path = temp.path().join(name);
        child(&source, &path, &head, &files, &[base.clone()]);
        fs::write(path.join(".cache/base"), name).unwrap();
        let version = Uuid::new_v4().to_string();
        files.capture(&path, &version, &head, &[base.clone()]).unwrap();
        inputs.push(version);
    }
    let target = temp.path().join("target");
    child(&source, &target, &head, &files, &[base]);
    assert!(files.materialize(&target, &inputs, None, false).unwrap_err().contains("conflicting ignored file .cache/base"));
    assert_eq!(fs::read_to_string(target.join(".cache/base")).unwrap(), "base");
    let descendant = Uuid::new_v4().to_string();
    files.capture(&temp.path().join("left"), &descendant, &head, &[inputs[0].clone()]).unwrap();
    files.materialize(&target, &[inputs[0].clone(), descendant], None, false).unwrap();
    assert_eq!(fs::read_to_string(target.join(".cache/base")).unwrap(), "left");
}

#[test]
fn ignored_snapshot_preserves_whitespace_paths_and_excludes_runtime_data() {
    let (temp, source, files, _, head) = setup();
    fs::write(source.join(" leading.cache"), "space").unwrap();
    fs::create_dir_all(source.join(".grapher/private")).unwrap();
    fs::write(source.join(".grapher/private/secret"), "not an artifact").unwrap();
    let version = Uuid::new_v4().to_string();
    files.capture(&source, &version, &head, &[]).unwrap();
    let target = temp.path().join("target");
    child(&source, &target, &head, &files, &[version]);
    assert_eq!(fs::read_to_string(target.join(" leading.cache")).unwrap(), "space");
    assert!(!target.join(".grapher").exists());
    assert!(target.join(".git").is_dir());
}

#[test]
fn directory_links_are_rebased_without_following_outside_directories() {
    let (temp, source, files, _, head) = setup();
    fs::create_dir(source.join(".cache/library")).unwrap();
    fs::write(source.join(".cache/library/file"), "local").unwrap();
    crate::path_safety::directory_link(&source.join(".cache/library"), &source.join(".cache/alias"));
    let version = Uuid::new_v4().to_string();
    files.capture(&source, &version, &head, &[]).unwrap();
    let target = temp.path().join("target");
    child(&source, &target, &head, &files, &[version]);
    fs::write(target.join(".cache/alias/file"), "private").unwrap();
    assert_eq!(fs::read_to_string(target.join(".cache/library/file")).unwrap(), "private");
    assert_eq!(fs::read_to_string(source.join(".cache/library/file")).unwrap(), "local");
    let external = temp.path().join("external");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("secret"), "external").unwrap();
    crate::path_safety::directory_link(&external, &source.join(".cache/outside"));
    assert!(files.capture(&source, &Uuid::new_v4().to_string(), &head, &[]).unwrap_err().contains("leaves its workspace"));
    assert_eq!(fs::read_to_string(external.join("secret")).unwrap(), "external");
}

#[test]
fn damaged_blobs_and_modified_feedback_workspaces_are_rejected() {
    let (temp, source, files, base, head) = setup();
    files.verify(&source, &base, &head).unwrap();
    fs::write(source.join(".cache/base"), "changed").unwrap();
    assert!(files.verify(&source, &base, &head).unwrap_err().contains("changed after completion"));
    let blob = match &files.load(&base).unwrap().entries[".cache/base"] {
        Entry::File { blob, .. } => blob.clone(), _ => panic!("expected file"),
    };
    fs::write(files.blob_path(&blob).unwrap(), "damaged").unwrap();
    let target = temp.path().join("target");
    workspace::prepare(&source, &target, &head, &[]).unwrap();
    assert!(files.materialize(&target, &[base], None, false).unwrap_err().contains("Damaged workspace file blob"));
}

#[test]
fn ignored_inputs_never_overwrite_conflicting_tracked_files() {
    let (temp, source, files, base, head) = setup();
    let target = temp.path().join("target");
    child(&source, &target, &head, &files, &[base.clone()]);
    fs::write(target.join(".cache/base"), "tracked result").unwrap();
    workspace::git(&target, &["add", "-f", ".cache/base"]).unwrap();
    let error = files.materialize(&target, &[base], None, false).unwrap_err();
    assert!(error.contains("ignored input conflicts with tracked path .cache/base"));
    assert_eq!(fs::read_to_string(target.join(".cache/base")).unwrap(), "tracked result");
    let version = Uuid::new_v4().to_string();
    files.capture(&target, &version, &head, &[]).unwrap();
    assert!(!files.load(&version).unwrap().entries.contains_key(".cache/base"));
}

#[cfg(unix)]
#[test]
fn unix_backslash_paths_and_executable_permissions_are_preserved() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, source, files, base, head) = setup();
    let name = ".cache/back\\slash";
    fs::write(source.join(name), "native path").unwrap();
    fs::set_permissions(source.join(name), fs::Permissions::from_mode(0o750)).unwrap();
    let version = Uuid::new_v4().to_string();
    files.capture(&source, &version, &head, &[base]).unwrap();
    let target = temp.path().join("target");
    child(&source, &target, &head, &files, &[version]);
    assert_eq!(fs::read_to_string(target.join(name)).unwrap(), "native path");
    assert_eq!(fs::metadata(target.join(name)).unwrap().permissions().mode() & 0o777, 0o750);
}

#[cfg(unix)]
#[test]
fn unix_non_utf8_paths_are_rejected_without_lossy_decoding() {
    use std::os::unix::ffi::OsStringExt;
    let name = PathBuf::from(std::ffi::OsString::from_vec(b"bad\xff.cache".to_vec()));
    // Validate rejection even on filesystems that cannot store these names.
    assert_eq!(path_name(&name).unwrap_err(), "Workspace file paths must be UTF-8");
    let (_temp, source, files, _, head) = setup();
    match fs::write(source.join(&name), "unsupported") {
        Ok(()) => {},
        // macOS filesystems such as APFS reject invalid UTF-8 with EILSEQ.
        Err(error) if error.raw_os_error() == Some(libc::EILSEQ) => {
            eprintln!("Filesystem rejects non-UTF-8 names; skipping the Git capture probe: {error}");
            return;
        }
        Err(error) => panic!("Cannot create non-UTF-8 filename for Git capture probe: {error}"),
    }
    let version = Uuid::new_v4().to_string();
    assert!(files.capture(&source, &version, &head, &[]).unwrap_err().contains("Non-UTF-8 Git paths"));
    assert!(!files.exists(&version));
    assert_eq!(fs::read_to_string(source.join(name)).unwrap(), "unsupported");
}

#[test]
fn python_environment_files_are_inherited_without_reinstallation() {
    let (temp, source, files, base, head) = setup();
    let mut python = std::process::Command::new(if cfg!(windows) { "py" } else { "python3" });
    if cfg!(windows) { python.arg("-3"); }
    let output = python.args(["-m", "venv", "--without-pip"]).arg(source.join(".venv")).output();
    let Ok(output) = output else { eprintln!("Python unavailable; skipping native venv probe"); return; };
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let interpreter = if cfg!(windows) { ".venv/Scripts/python.exe" } else { ".venv/bin/python" };
    let output = std::process::Command::new(source.join(interpreter)).env("PYTHONIOENCODING", "utf-8")
        .args(["-c", "import pathlib,sysconfig; p=pathlib.Path(sysconfig.get_path('purelib'))/'grapher_inherited_probe'; p.mkdir(); (p/'__init__.py').write_text('VALUE = 41\\n'); (p/'weights.bin').write_bytes(b'preinstalled-state'); print(p)"])
        .output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let package = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let version = Uuid::new_v4().to_string();
    files.capture(&source, &version, &head, &[base]).unwrap();
    let target = temp.path().join("target");
    child(&source, &target, &head, &files, &[version]);
    fs::remove_dir_all(package).unwrap();
    let output = std::process::Command::new(target.join(interpreter)).env("PYTHONIOENCODING", "utf-8")
        .args(["-c", "import sys,pathlib,grapher_inherited_probe as probe; assert probe.VALUE == 41; assert (pathlib.Path(probe.__file__).parent/'weights.bin').read_bytes() == b'preinstalled-state'; print(sys.prefix)"]).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let prefix = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    assert_eq!(prefix.canonicalize().unwrap(), target.join(".venv").canonicalize().unwrap());
}
