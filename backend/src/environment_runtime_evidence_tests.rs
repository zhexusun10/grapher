use super::*;
use crate::workspace_files::RootScope;

#[path = "environment_runtime_selectors_tests.rs"]
mod selector_tests;

#[path = "environment_runtime_return_tests.rs"]
mod return_tests;

fn blob(path: &Path) -> String {
    git2::Oid::hash_file(git2::ObjectType::Blob, path)
        .unwrap()
        .to_string()
}
fn observed(paths: &[&Path], roots: &[(&str, &Path)]) -> RuntimeEvidence {
    let raw: BTreeMap<_, _> = paths.iter().map(|path| (text(path), blob(path))).collect();
    let mut framed = MARKER.to_vec();
    framed.extend_from_slice(&serde_json::to_vec(&raw).unwrap());
    framed.extend_from_slice(b"\0legacy ABI\n");
    RuntimeEvidence::from_probe(&framed, roots).unwrap().0
}

#[test]
fn native_module_carriers_remain_required_byte_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    fs::create_dir(&work).unwrap();
    git2::Repository::init(&work).unwrap();
    let prefix = work.join("env");
    let mut create = std::process::Command::new(if cfg!(windows) { "python" } else { "python3" });
    create.args(["-m", "venv", "--without-pip"]).arg(&prefix);
    crate::environment::controlled_output(create).unwrap();
    let roots = [("workspace", work.as_path())];
    let binding =
        super::super::verify(&work, "workspace", "env", "venv", false, &roots, Some(3)).unwrap();
    let mut launch = crate::environment_automatic::resolve(&work, false)
        .unwrap()
        .0
        .unwrap()
        .launch;
    let python = super::super::interpreter(&prefix, "venv");
    launch.entry = text(&python);
    launch.path.insert(0, text(python.parent().unwrap()));
    launch.environment = Some(binding.clone());
    super::super::validate_launch(&work, &launch, false).unwrap();
    let evidence = binding.runtime_evidence.as_ref().unwrap();
    let mut query = std::process::Command::new(&python);
    query.args([
        "-I",
        "-B",
        "-c",
        r#"import _ssl,_hashlib,ctypes,json,pathlib,sys
files=[m.__file__ for m in [_ssl,_hashlib] if getattr(m,'__file__',None)]
if sys.platform.startswith('linux') and len(files)<2:
 address=ctypes.cast(ctypes.pythonapi.Py_GetVersion,ctypes.c_void_p).value
 for line in pathlib.Path('/proc/self/maps').read_text().splitlines():
  parts=line.split(None,5); start,end=[int(n,16) for n in parts[0].split('-')]
  if start<=address<end: files.append(parts[5]); break
if not files: files.append(getattr(sys,'_base_executable',sys.executable))
print(json.dumps([str(pathlib.Path(p).resolve()) for p in files]))"#,
    ]);
    let carriers: Vec<String> =
        serde_json::from_slice(&crate::environment::controlled_output(query).unwrap()).unwrap();
    for carrier in &carriers {
        assert!(evidence.files.iter().any(|file|
            matches!(file, RuntimeFile::External { path, .. } if crate::path_identity::same_path(Path::new(path), Path::new(carrier)))
        ), "actual native carrier missing from byte evidence: {carrier}");
    }
    let carrier = evidence.files.iter().find(|file|
        matches!(file, RuntimeFile::External { path, .. } if crate::path_identity::same_path(Path::new(path), Path::new(&carriers[0])))
    ).unwrap().clone();
    let mut corrupted = binding;
    let files = &mut corrupted.runtime_evidence.as_mut().unwrap().files;
    let file = files.iter_mut().find(|file| **file == carrier).unwrap();
    match file {
        RuntimeFile::External { blob, .. } | RuntimeFile::Root { blob, .. } => {
            *blob = "0".repeat(40)
        }
    }
    launch.environment = Some(corrupted);
    assert!(super::super::validate_launch(&work, &launch, false).is_err());
}

#[test]
fn native_runtime_protocol_preserves_abi_bytes_and_rejects_missing_binding_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("native-input");
    fs::write(&file, "native bytes").unwrap();
    let mut output = b"startup output\n\xff".to_vec();
    output.extend_from_slice(MARKER);
    let proof = BTreeMap::from([(text(&file), blob(&file))]);
    output.extend_from_slice(&serde_json::to_vec(&proof).unwrap());
    output.push(0);
    output.extend_from_slice(b"{\"abi\":\"old-output\"}\n");
    let (_, old) = RuntimeEvidence::from_probe(&output, &[]).unwrap();
    let expected = b"startup output\n\xff{\"abi\":\"old-output\"}\n";
    assert_eq!(old, expected);
    assert_eq!(
        git2::Oid::hash_object(git2::ObjectType::Blob, &old).unwrap(),
        git2::Oid::hash_object(git2::ObjectType::Blob, expected).unwrap()
    );
    let legacy = r#"{"kind":"venv","prefix":"env","abi":"0000000000000000000000000000000000000000","root":"workspace"}"#;
    let binding: crate::environment_discovery::Binding = serde_json::from_str(legacy).unwrap();
    assert!(binding.validate().is_err());
    assert!(binding.runtime_evidence.is_none());
    assert_eq!(serde_json::to_string(&binding).unwrap(), legacy);
    assert!(RuntimeEvidence::from_probe(b"no framed evidence", &[]).is_err());
}

#[test]
fn native_runtime_metadata_rejects_invalid_root_traversal_schema_and_duplicates_without_reading_files(
) {
    for mut value in [
        serde_json::json!({"schema":2,"files":[{"location":"external","path":"/not-read","blob":"0".repeat(40)}]}),
        serde_json::json!({"schema":1,"files":[{"location":"root","root":"other","path":"env/x","blob":"0".repeat(40)}]}),
        serde_json::json!({"schema":1,"files":[{"location":"root","root":"workspace","path":"../x","blob":"0".repeat(40)}]}),
        serde_json::json!({"schema":1,"files":[{"location":"external","path":"relative-input","blob":"0".repeat(40)}]}),
        serde_json::json!({"schema":1,"files":[{"location":"root","root":"state","path":"env/x","blob":"0".repeat(40)},
            {"location":"root","root":"state","path":"env/x","blob":"0".repeat(40)}]}),
    ] {
        value["roots"] = serde_json::json!({
            "workspace":text(&std::env::temp_dir().join("not-read-W")),
            "state":text(&std::env::temp_dir().join("not-read-S"))});
        assert!(serde_json::from_value::<RuntimeEvidence>(value)
            .unwrap()
            .validate()
            .is_err());
    }
}

#[test]
fn native_runtime_project_inputs_follow_coderef_and_are_checked_before_e_writes() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    fs::create_dir(&work).unwrap();
    let project = work.join("project-native-input");
    fs::write(&project, "recorded code bytes").unwrap();
    let evidence = observed(&[&project], &[("workspace", &work)]);
    let files = Files::environment(&temp.path().join("store"), &[], &[]).unwrap();
    let version = uuid::Uuid::new_v4().to_string();
    files.capture_empty(&version).unwrap();
    let roots = BTreeMap::from([("workspace".into(), work)]);
    evidence
        .preflight_prepared(&files, &version, "state", &roots)
        .unwrap();
    fs::remove_file(&project).unwrap();
    // Early preflight must not reject recoverable code or read the partial W.
    // Only the existing codeRef path may reconstruct it; E supplies no bytes.
    evidence
        .preflight(&files, &version, "state", &roots)
        .unwrap();
    assert!(evidence
        .preflight_prepared(&files, &version, "state", &roots)
        .unwrap_err()
        .contains("missing after codeRef preparation"));
    fs::write(&project, "different code bytes").unwrap();
    assert!(evidence
        .preflight_prepared(&files, &version, "state", &roots)
        .unwrap_err()
        .contains("Project-code native runtime input bytes changed"));
    fs::write(&project, "recorded code bytes").unwrap();
    evidence
        .preflight_prepared(&files, &version, "state", &roots)
        .unwrap();
}

#[test]
fn native_runtime_external_input_changes_fail_without_modifying_host_tools_or_recorded_state() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    fs::create_dir(&work).unwrap();
    fs::write(work.join("partial"), "keep current bytes").unwrap();
    let external = temp.path().join("disposable-runtime-input");
    fs::write(&external, "original").unwrap();
    let evidence = observed(&[&external], &[("workspace", &work)]);
    let files = Files::environment(&temp.path().join("store"), &[], &[]).unwrap();
    let version = uuid::Uuid::new_v4().to_string();
    files.capture_empty(&version).unwrap();
    let roots = BTreeMap::from([("workspace".into(), work.clone())]);
    evidence
        .preflight(&files, &version, "workspace", &roots)
        .unwrap();
    let modified = fs::metadata(&external).unwrap().modified().unwrap();
    fs::write(&external, "modified").unwrap();
    fs::File::options()
        .write(true)
        .open(&external)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let error = evidence
        .preflight(&files, &version, "workspace", &roots)
        .unwrap_err();
    assert!(
        error.contains("bytes changed") && error.contains("not restored from E"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(work.join("partial")).unwrap(),
        "keep current bytes"
    );
    assert_eq!(fs::read_to_string(&external).unwrap(), "modified");
    fs::remove_file(&external).unwrap();
    assert!(evidence
        .preflight(&files, &version, "workspace", &roots)
        .unwrap_err()
        .contains("unavailable"));
}

#[test]
fn native_runtime_owned_bytes_come_from_e_while_excluded_cache_requires_matching_live_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    let state = temp.path().join("S");
    fs::create_dir_all(work.join("env")).unwrap();
    fs::create_dir_all(state.join("home/cache")).unwrap();
    let owned = work.join("env/native");
    let cache = state.join("home/cache/native");
    fs::write(&owned, "owned native input").unwrap();
    fs::write(&cache, "private cache native input").unwrap();
    let roots = BTreeMap::from([
        ("workspace".into(), work.clone()),
        ("state".into(), state.clone()),
    ]);
    let layouts = BTreeMap::from([
        (
            "workspace".into(),
            RootScope::normalized(vec!["env".into()], vec![]),
        ),
        (
            "state".into(),
            RootScope::normalized(vec!["home".into()], vec!["home/cache".into()]),
        ),
    ]);
    let evidence = observed(
        &[&owned, &cache],
        &[("workspace", &work), ("state", &state)],
    );
    let files = Files::environment(&temp.path().join("store"), &[], &[])
        .unwrap()
        .with_project_index(false);
    let version = uuid::Uuid::new_v4().to_string();
    files
        .capture_roots(&roots, &layouts, &version, &[])
        .unwrap();
    let other_state = temp.path().join("other-owner/S");
    fs::create_dir_all(other_state.join("home/cache")).unwrap();
    fs::write(
        other_state.join("home/cache/native"),
        "private cache native input",
    )
    .unwrap();
    let mut wrong = roots.clone();
    wrong.insert("state".into(), other_state);
    assert!(evidence
        .preflight(&files, &version, "workspace", &wrong)
        .unwrap_err()
        .contains("root layout differs for state"));
    fs::remove_file(&owned).unwrap();
    evidence
        .preflight(&files, &version, "workspace", &roots)
        .unwrap();
    assert!(
        !owned.exists(),
        "preflight does not repair the current interpreter"
    );
    fs::remove_file(&cache).unwrap();
    let error = evidence
        .preflight(&files, &version, "workspace", &roots)
        .unwrap_err();
    assert!(
        error.contains("cache input is missing") && error.contains("no captured bytes"),
        "{error}"
    );
    assert!(!owned.exists());
    assert!(!cache.exists());
}

#[test]
fn native_runtime_evidence_does_not_label_sibling_slot_files_as_external_host_tools() {
    let temp = tempfile::tempdir().unwrap();
    let run = temp
        .path()
        .join(".grapher-worktrees")
        .join(uuid::Uuid::new_v4().to_string());
    let work = run.join("a");
    let other = run.join("b/env/native");
    let state = crate::workspace_state::process_root(&work).unwrap();
    fs::create_dir_all(work.join("env")).unwrap();
    fs::create_dir_all(state.join("env")).unwrap();
    fs::create_dir_all(other.parent().unwrap()).unwrap();
    let w_native = work.join("env/native");
    let s_native = state.join("env/native");
    for path in [&w_native, &s_native, &other] {
        fs::write(path, "identical input bytes").unwrap();
    }
    let roots = [("workspace", work.as_path()), ("state", state.as_path())];
    observed(&[&w_native, &s_native], &roots)
        .validate()
        .unwrap();
    let raw = BTreeMap::from([(text(&other), blob(&other))]);
    let mut framed = MARKER.to_vec();
    framed.extend_from_slice(&serde_json::to_vec(&raw).unwrap());
    framed.extend_from_slice(b"\0legacy ABI\n");
    let error = RuntimeEvidence::from_probe(&framed, &roots).unwrap_err();
    assert!(
        error.contains("another managed slot") && error.contains("cannot be bound"),
        "{error}"
    );
    assert_eq!(fs::read_to_string(&other).unwrap(), "identical input bytes");
    // A trusted alias of the current W cannot turn a sibling's mutable native
    // files into host toolchain inputs merely by changing the root spelling.
    for alias in [
        temp.path().join("current-workspace-alias"),
        temp.path().join("decoy/.grapher-worktrees/run/a-alias"),
    ] {
        fs::create_dir_all(alias.parent().unwrap()).unwrap();
        crate::path_safety::directory_link(&work, &alias);
        let aliased_roots = [("workspace", alias.as_path()), ("state", state.as_path())];
        observed(&[&w_native, &s_native], &aliased_roots)
            .validate()
            .unwrap();
        let aliased = RuntimeEvidence::from_probe(&framed, &aliased_roots);
        crate::path_safety::remove_directory_link(&alias);
        assert!(
            aliased.is_err(),
            "root alias bypassed sibling-input ownership: {aliased:?}"
        );
    }
    // Conversely the managed bucket itself may be a trusted root alias. Its
    // physical target need not repeat the allocator's .grapher-worktrees name.
    let logical_bucket = run.parent().unwrap();
    let physical_bucket = temp.path().join("physical-slots");
    fs::rename(logical_bucket, &physical_bucket).unwrap();
    crate::path_safety::directory_link(&physical_bucket, logical_bucket);
    observed(&[&w_native, &s_native], &roots)
        .validate()
        .unwrap();
    let aliased_bucket = RuntimeEvidence::from_probe(&framed, &roots);
    let alias = temp.path().join("both-roots-aliased");
    crate::path_safety::directory_link(&work, &alias);
    let combined_roots = [("workspace", alias.as_path()), ("state", state.as_path())];
    observed(&[&w_native, &s_native], &combined_roots)
        .validate()
        .unwrap();
    let combined = RuntimeEvidence::from_probe(&framed, &combined_roots);
    crate::path_safety::remove_directory_link(&alias);
    crate::path_safety::remove_directory_link(logical_bucket);
    assert!(
        aliased_bucket.is_err(),
        "bucket alias bypassed sibling-input ownership: {aliased_bucket:?}"
    );
    assert!(
        combined.is_err(),
        "combined aliases bypassed sibling-input ownership: {combined:?}"
    );
}

#[test]
fn native_runtime_startup_requires_file_evidence_and_rejects_sibling_inputs() {
    use std::process::Command;
    let temp = tempfile::tempdir().unwrap();
    let run = temp
        .path()
        .join(".grapher-worktrees")
        .join(uuid::Uuid::new_v4().to_string());
    let work = run.join("a");
    let sibling = run.join("b/native");
    let state = crate::workspace_state::process_root(&work).unwrap();
    fs::create_dir_all(&work).unwrap();
    fs::create_dir_all(&state).unwrap();
    fs::create_dir_all(&sibling).unwrap();
    git2::Repository::init(&work).unwrap();
    let prefix = work.join("env");
    let mut create = Command::new(crate::python_test_support::file_backed_python());
    create
        .args(["-m", "venv", "--copies", "--without-pip"])
        .arg(&prefix);
    crate::environment::controlled_output(create).unwrap();
    let python = super::super::interpreter(&prefix, "venv");
    let mut query = Command::new(&python);
    query.args(["-I", "-B", "-c", "import _hashlib,json,sysconfig; print(json.dumps({'native':_hashlib.__file__,'site':sysconfig.get_path('purelib')}))"]);
    let info: serde_json::Value =
        serde_json::from_slice(&crate::environment::controlled_output(query).unwrap()).unwrap();
    let native = Path::new(info["native"].as_str().unwrap());
    let site = Path::new(info["site"].as_str().unwrap());
    fs::copy(native, sibling.join(native.file_name().unwrap())).unwrap();
    let literal = serde_json::to_string(&native::host_path(&sibling).to_string_lossy())
        .unwrap()
        .chars()
        .map(|c| {
            if c.is_ascii() {
                c.to_string()
            } else {
                format!("\\U{:08x}", c as u32)
            }
        })
        .collect::<String>();
    fs::write(
        site.join("recorded-dependency.pth"),
        format!("import sys; sys.path.insert(0, {literal}); print('probe-startup-argc='+str(len(sys.argv)))\n"),
    )
    .unwrap();
    assert!(super::super::verify(&work, "workspace", "env", "venv", false, &[], None).is_err());
    let measured =
        super::super::verify(&work, "workspace", "env", "venv", false, &[], Some(2)).unwrap();
    let roots = [("workspace", work.as_path()), ("state", state.as_path())];
    let error = super::super::verify(&work, "workspace", "env", "venv", false, &roots, Some(2))
        .unwrap_err();
    assert!(
        error.contains("another managed slot"),
        "new evidence must still reject shared sibling inputs: {error}"
    );
    let mut launch = crate::environment_automatic::resolve(&work, false)
        .unwrap()
        .0
        .unwrap()
        .launch;
    launch.entry = text(&python);
    launch.path.insert(0, text(python.parent().unwrap()));
    let mut unsupported = measured;
    unsupported.runtime_evidence = None;
    launch.environment = Some(unsupported);
    assert!(launch.validate().is_err());
    let original = serde_json::to_vec(&launch).unwrap();
    assert!(super::super::validate_launch_with_state(&work, Some(&state), &launch, false).is_err());
    assert_eq!(serde_json::to_vec(&launch).unwrap(), original);
}

#[test]
fn native_runtime_root_locations_allow_missing_reconstruction_but_not_redirected_old_roots() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("W");
    fs::create_dir_all(work.join("env")).unwrap();
    let owned = work.join("env/native");
    fs::write(&owned, "captured native bytes").unwrap();
    let roots = BTreeMap::from([("workspace".into(), work.clone())]);
    assert_eq!(
        target_layout(&work).unwrap(),
        text(&canonical(&work).unwrap())
    );
    let layouts = BTreeMap::from([(
        "workspace".into(),
        RootScope::normalized(vec!["env".into()], vec![]),
    )]);
    let evidence = observed(&[&owned], &[("workspace", &work)]);
    let files = Files::environment(&temp.path().join("store"), &[], &[])
        .unwrap()
        .with_project_index(false);
    let version = uuid::Uuid::new_v4().to_string();
    files
        .capture_roots(&roots, &layouts, &version, &[])
        .unwrap();
    let alias = temp.path().join("trusted-W-alias");
    crate::path_safety::directory_link(&work, &alias);
    evidence
        .preflight(
            &files,
            &version,
            "workspace",
            &BTreeMap::from([("workspace".into(), alias.clone())]),
        )
        .unwrap();
    crate::path_safety::remove_directory_link(&alias);
    fs::rename(&work, temp.path().join("old-W")).unwrap();
    evidence
        .preflight(&files, &version, "workspace", &roots)
        .unwrap();
    assert!(
        !work.exists(),
        "a missing recorded root is not populated during preflight"
    );
    let other = temp.path().join("other-owner/W");
    fs::create_dir_all(other.join("env")).unwrap();
    fs::write(other.join("env/native"), "captured native bytes").unwrap();
    crate::path_safety::directory_link(&other, &work);
    // Comparing both paths through today's filesystem would accept this: the
    // stored location must remain frozen instead of following the new redirect.
    assert!(crate::path_identity::same_path(&work, &work));
    let error = evidence
        .preflight(&files, &version, "workspace", &roots)
        .unwrap_err();
    assert!(
        error.contains("root layout differs for workspace"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(other.join("env/native")).unwrap(),
        "captured native bytes"
    );
}

#[test]
fn native_runtime_external_directory_redirection_is_not_authorized_by_equal_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let tools = temp.path().join("tools");
    let other = temp.path().join("other-mutable-tools");
    fs::create_dir(&tools).unwrap();
    fs::create_dir(&other).unwrap();
    fs::write(tools.join("native"), "same bytes").unwrap();
    fs::write(other.join("native"), "same bytes").unwrap();
    let evidence = observed(&[&tools.join("native")], &[]);
    fs::remove_dir_all(&tools).unwrap();
    crate::path_safety::directory_link(&other, &tools);
    let files = Files::environment(&temp.path().join("store"), &[], &[]).unwrap();
    let version = uuid::Uuid::new_v4().to_string();
    files.capture_empty(&version).unwrap();
    let error = evidence
        .preflight(&files, &version, "workspace", &BTreeMap::new())
        .unwrap_err();
    assert!(error.contains("redirected"), "{error}");
    assert_eq!(
        fs::read_to_string(other.join("native")).unwrap(),
        "same bytes"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_case_and_unicode_aliases_pass_observation_and_preflight_while_symlinks_still_fail() {
    let temp = tempfile::tempdir().unwrap();
    let base = crate::path_identity::actual_path(temp.path()).unwrap();
    let w = base.join("WorkspaceRoot");
    let tools = base.join("ToolDir");
    fs::create_dir_all(w.join(".venv/Cafe\u{0301}/bin")).unwrap();
    fs::create_dir_all(&tools).unwrap();
    let py = w.join(".venv/Cafe\u{0301}/bin/python");
    let ext = tools.join("libtool.dylib");
    fs::write(&py, "owned-py").unwrap();
    fs::write(&ext, "ext-lib").unwrap();

    let insensitive = crate::path_identity::case_insensitive_volume(&base);
    let lib_probe_name = if insensitive {
        "LIBTOOL.DYLIB"
    } else {
        "libtool.dylib"
    };
    let tools_alias_dir = if insensitive {
        base.join("tooldir")
    } else {
        tools.clone()
    };
    // Probe reports NFC + differing ASCII case in references while no symlinks exist.
    let raw_files = BTreeMap::from([
        (text(&w.join(".venv/Caf\u{00e9}/bin/python")), blob(&py)),
        (text(&tools.join(lib_probe_name)), blob(&ext)),
    ]);
    let refs = BTreeMap::from([
        (
            text(&w.join(".venv/Cafe\u{0301}/bin/python")),
            text(&w.join(".venv/Caf\u{00e9}/bin/python")),
        ),
        (
            text(&tools_alias_dir.join("libtool.dylib")),
            text(&tools.join(lib_probe_name)),
        ),
    ]);
    let probe = serde_json::json!({
        "schema": 3,
        "files": raw_files,
        "references": refs,
    });
    let mut framed = MARKER.to_vec();
    framed.extend_from_slice(&serde_json::to_vec(&probe).unwrap());
    framed.extend_from_slice(b"\0abi\n");
    let w_alias = if insensitive {
        base.join("workspaceroot")
    } else {
        w.clone()
    };
    let (evidence, _) = RuntimeEvidence::from_probe(&framed, &[("workspace", &w_alias)]).unwrap();

    // Capture E and preflight with NFC/case-variant layout + check alias lookup.
    let scope_name = if insensitive { ".Venv" } else { ".venv" };
    let store_dir = base.join("env-store");
    let files = Files::environment(&store_dir, &[scope_name.into()], &[]).unwrap();
    let version = uuid::Uuid::new_v4().to_string();
    let layouts = BTreeMap::from([(
        "workspace".to_string(),
        RootScope::normalized(vec![scope_name.to_string()], vec![]),
    )]);
    files
        .capture_roots(
            &BTreeMap::from([("workspace".to_string(), w.clone())]),
            &layouts,
            &version,
            &[],
        )
        .unwrap();
    evidence
        .preflight(
            &files,
            &version,
            "workspace",
            &BTreeMap::from([("workspace".to_string(), w.clone())]),
        )
        .unwrap();

    // Verify RuntimePaths and RuntimeEvidence alias lookups resolve NFD vs NFC and case.
    let rp = files
        .runtime_paths(
            &version,
            "workspace",
            &BTreeMap::from([("workspace".to_string(), w.clone())]),
        )
        .unwrap();
    assert!(rp.lookup("workspace", ".venv/Caf\u{00e9}/bin/python").is_ok());

    // Symlink redirect must still fail preflight even with identical bytes.
    let other_tools = base.join("OtherTools");
    fs::create_dir(&other_tools).unwrap();
    fs::write(other_tools.join("libtool.dylib"), "ext-lib").unwrap();
    fs::remove_dir_all(&tools).unwrap();
    crate::path_safety::directory_link(&other_tools, &tools);
    let err = evidence
        .preflight(
            &files,
            &version,
            "workspace",
            &BTreeMap::from([("workspace".to_string(), w)]),
        )
        .unwrap_err();
    assert!(err.contains("redirected"), "{err}");
}
