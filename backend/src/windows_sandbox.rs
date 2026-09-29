//! Windows AppContainer launcher for Graph Execution Instances.
//!
//! Each Graph instance gets a separate AppContainer SID. Only its current
//! worktree, session, engine copy, agent directory, temporary directory, and
//! executable search paths are granted access. The source repository and
//! sibling workspaces are never granted.
#![cfg(windows)]

use std::{
    env, fs,
    path::{Path, PathBuf},
    ptr,
};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, LocalFree, GENERIC_ALL, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0,
    },
    Security::Authorization::{
        BuildTrusteeWithSidW, ConvertStringSidToSidW, GetNamedSecurityInfoW, SetEntriesInAclW,
        SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
        TRUSTEE_IS_WELL_KNOWN_GROUP,
    },
    Security::Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName},
    Security::{
        DACL_SECURITY_INFORMATION, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    },
    Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES as WIN_FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    },
    System::{
        Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
        Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
            InitializeProcThreadAttributeList, UpdateProcThreadAttribute, WaitForSingleObject,
            CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
            PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES,
            STARTUPINFOEXW,
        },
    },
};

#[cfg(test)]
use windows_sys::Win32::Foundation::WAIT_TIMEOUT;

const GENERIC_READ_EXECUTE: u32 = 0x1200_00A0;
const S_OK: i32 = 0;
const ERROR_ALREADY_EXISTS_HRESULT: i32 = 0x8007_00B7u32 as i32;

fn windows_error(operation: &str) -> String {
    format!("{operation} failed with Windows error {}", unsafe {
        GetLastError()
    })
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn path_wide(path: &Path) -> Result<Vec<u16>, String> {
    let value = path
        .to_str()
        .ok_or("Windows sandbox paths must be valid UTF-8")?;
    // The security APIs reject the extended spelling of a volume root
    // (\\\\?\\C:\\), even though canonicalize() returns it. Keep extended
    // paths everywhere else so long workspace paths remain supported.
    let value = if let Some(local) = value.strip_prefix("\\\\?\\") {
        let is_volume_root = local.len() == 3
            && local.as_bytes().get(1) == Some(&b':')
            && local.ends_with('\\');
        if is_volume_root {
            local
        } else if let Some(unc) = local.strip_prefix("UNC\\") {
            // UNC share roots have the same API limitation.
            return Ok(wide(&format!(r"\\{unc}")));
        } else {
            value
        }
    } else {
        value
    };
    Ok(wide(value))
}

fn quote_arg(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".into();
    }
    if !value.chars().any(|c| c.is_whitespace() || c == '"') {
        return value.into();
    }
    let mut output = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        match character {
            '\\' => slashes += 1,
            '"' => {
                output.push_str(&"\\".repeat(slashes * 2 + 1));
                output.push('"');
                slashes = 0;
            }
            _ => {
                output.push_str(&"\\".repeat(slashes));
                slashes = 0;
                output.push(character);
            }
        }
    }
    output.push_str(&"\\".repeat(slashes * 2));
    output.push('"');
    output
}

fn hard_link_count(path: &Path) -> Result<u32, String> {
    let name = path_wide(path)?;
    unsafe {
        let handle = CreateFileW(
            name.as_ptr(),
            WIN_FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        );
        if handle.is_null() || handle as isize == -1 {
            return Err(windows_error("CreateFileW(file metadata)"));
        }
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        let result = GetFileInformationByHandle(handle, &mut info);
        CloseHandle(handle);
        if result == 0 {
            return Err(windows_error("GetFileInformationByHandle"));
        }
        Ok(info.nNumberOfLinks)
    }
}

fn profile_name(session: &Path) -> String {
    let suffix = session
        .parent()
        .and_then(Path::file_name)
        .or_else(|| session.file_name())
        .and_then(|value| value.to_str())
        .unwrap_or("session");
    let safe: String = suffix
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
    format!("Grapher-Graph-{safe}")
}

unsafe fn create_profile(
    name: &str,
) -> Result<
    (
        windows_sys::Win32::Security::PSID,
        windows_sys::Win32::Security::PSID,
    ),
    String,
> {
    let name = wide(name);
    let display = wide("Grapher Graph Execution");
    let description = wide("Isolated Grapher Graph Execution Instance");
    // WinCapabilityInternetClientSid is S-1-15-3-1.
    let internet_name = wide("S-1-15-3-1");
    let mut capability_sid = ptr::null_mut();
    if ConvertStringSidToSidW(internet_name.as_ptr(), &mut capability_sid) == 0 {
        return Err(windows_error("ConvertStringSidToSid"));
    }
    let mut capability = SID_AND_ATTRIBUTES {
        Sid: capability_sid,
        // SECURITY_CAPABILITIES requires enabled capability attributes.
        Attributes: 0x0000_0004,
    };
    let mut app_sid = ptr::null_mut();
    let result = CreateAppContainerProfile(
        name.as_ptr(),
        display.as_ptr(),
        description.as_ptr(),
        &mut capability,
        1,
        &mut app_sid,
    );
    if result != S_OK && result != ERROR_ALREADY_EXISTS_HRESULT {
        LocalFree(capability_sid);
        return Err(format!(
            "CreateAppContainerProfile failed with HRESULT 0x{result:08x}"
        ));
    }
    if app_sid.is_null() {
        let result = DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut app_sid);
        if result != S_OK {
            LocalFree(capability_sid);
            return Err(format!(
                "DeriveAppContainerSidFromAppContainerName failed with HRESULT 0x{result:08x}"
            ));
        }
    }
    Ok((app_sid, capability_sid))
}

unsafe fn grant_access(
    path: &Path,
    sid: windows_sys::Win32::Security::PSID,
    access: u32,
    inheritance: u32,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_file() && hard_link_count(path)? > 1 {
        // System executables in PATH commonly have multiple hard links. Never
        // modify the ACL on those files: it would grant access via every name.
        // For read-only tool paths, leave their existing AppContainer ACL alone;
        // launching a tool without sufficient access will fail closed.
        if access == GENERIC_READ_EXECUTE {
            return Ok(());
        }
        return Err(format!(
            "Windows Graph sandbox refuses a hard-linked allowed file: {}",
            path.display()
        ));
    }
    let name = path_wide(path)?;
    let mut owner = ptr::null_mut();
    let mut group = ptr::null_mut();
    let mut old_acl = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    let result = GetNamedSecurityInfoW(
        name.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        &mut owner,
        &mut group,
        &mut old_acl,
        ptr::null_mut(),
        &mut descriptor,
    );
    if result != 0 {
        return Err(format!(
            "GetNamedSecurityInfoW({}) failed with Windows error {result}",
            path.display()
        ));
    }

    let mut trustee = windows_sys::Win32::Security::Authorization::TRUSTEE_W::default();
    BuildTrusteeWithSidW(&mut trustee, sid);
    trustee.TrusteeForm = TRUSTEE_IS_SID;
    trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: access,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: inheritance,
        Trustee: trustee,
    };
    let mut new_acl = ptr::null_mut();
    let result = SetEntriesInAclW(1, &entry, old_acl, &mut new_acl);
    if result != 0 {
        LocalFree(descriptor);
        return Err(format!(
            "SetEntriesInAclW({}) failed with Windows error {result}",
            path.display()
        ));
    }
    let result = SetNamedSecurityInfoW(
        name.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        ptr::null_mut(),
        ptr::null_mut(),
        new_acl,
        ptr::null_mut(),
    );
    LocalFree(descriptor);
    LocalFree(new_acl.cast());
    if result != 0 {
        return Err(format!(
            "SetNamedSecurityInfoW({}) failed with Windows error {result}",
            path.display()
        ));
    }
    Ok(())
}

fn grant_tree(
    root: &Path,
    sid: windows_sys::Win32::Security::PSID,
    access: u32,
) -> Result<(), String> {
    // An inheritable ACE on the allowed root covers existing descendants and
    // future files. Walking every file here is both slow and unnecessary for
    // large node_modules/.git trees.
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    unsafe { grant_access(&root, sid, access, SUB_CONTAINERS_AND_OBJECTS_INHERIT) }
}

fn grant_traverse(_path: &Path, _sid: windows_sys::Win32::Security::PSID) -> Result<(), String> {
    // Do not rewrite C:\\Users or the volume root. AppContainer has the
    // traverse privilege for directory walks; the actual allowed roots below
    // receive their own ACLs. Rewriting protected ancestors is the source of
    // the Windows error 5 seen on machines where the user is not elevated.
    Ok(())
}

fn grant_traverse_many(
    _paths: &[&Path],
    _sid: windows_sys::Win32::Security::PSID,
) -> Result<(), String> {
    Ok(())
}

fn normal_windows_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(local) = value.strip_prefix(r"\\?\") {
        PathBuf::from(local)
    } else {
        path.to_path_buf()
    }
}

fn normalized_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(local) = value.strip_prefix(r"\\?\") {
        PathBuf::from(local)
    } else {
        path.to_path_buf()
    }
}

fn same_component(left: &std::path::Component<'_>, right: &std::path::Component<'_>) -> bool {
    match (left, right) {
        (std::path::Component::Prefix(left), std::path::Component::Prefix(right)) => {
            left.as_os_str().to_string_lossy().eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
        }
        (std::path::Component::Normal(left), std::path::Component::Normal(right)) => {
            left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
        }
        _ => left == right,
    }
}

fn relative_path(from: &Path, target: &Path) -> Option<PathBuf> {
    let from = normalized_path(from);
    let target = normalized_path(target);
    let from_components: Vec<_> = from.components().collect();
    let target_components: Vec<_> = target.components().collect();
    let common = from_components
        .iter()
        .zip(&target_components)
        .take_while(|(left, right)| same_component(left, right))
        .count();
    if common == 0 {
        return None;
    }
    let mut result = PathBuf::new();
    for _ in common..from_components.len() {
        result.push("..");
    }
    for component in &target_components[common..] {
        result.push(component.as_os_str());
    }
    Some(if result.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        result
    })
}

fn module_specifier(path: &str) -> String {
    let path = path.replace('\\', "/");
    if path.starts_with("./") || path.starts_with("../") || path.starts_with('/') {
        if path.starts_with("../") {
            format!("./{path}")
        } else {
            path
        }
    } else {
        format!("./{path}")
    }
}

fn canonical_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn path_suffix(path: &Path, root: &Path) -> Option<PathBuf> {
    let path = normalized_path(&canonical_or_original(path));
    let root = normalized_path(&canonical_or_original(root));
    let suffix = relative_path(&root, &path)?;
    if suffix
        .components()
        .any(|component| component == std::path::Component::ParentDir)
    {
        return None;
    }
    Some(if suffix == Path::new(".") {
        PathBuf::new()
    } else {
        suffix
    })
}

fn map_child_argument(
    value: &str,
    current: &Path,
    source: &Path,
    session: &Path,
    data: &Path,
    engine: &Path,
    agent: &Path,
) -> String {
    let path = PathBuf::from(value);
    let mapped = if let Some(suffix) = path_suffix(&path, source) {
        current.join(suffix)
    } else if let Some(suffix) = path_suffix(&path, current) {
        current.join(suffix)
    } else if let Some(suffix) = path_suffix(&path, session) {
        session.join(suffix)
    } else if let Some(suffix) = path_suffix(&path, data) {
        data.join(suffix)
    } else if let Some(suffix) = path_suffix(&path, engine) {
        engine.join(suffix)
    } else if let Some(suffix) = path_suffix(&path, agent) {
        agent.join(suffix)
    } else {
        return value.into();
    };
    relative_path(&canonical_or_original(current), &canonical_or_original(&mapped))
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| value.into())
}

fn prepare_access(sid: windows_sys::Win32::Security::PSID) -> Result<(), String> {
    let current = PathBuf::from(
        env::var("GRAPHER_WINDOWS_SANDBOX_CURRENT")
            .map_err(|_| "Missing sandbox current directory")?,
    );
    let session = PathBuf::from(
        env::var("GRAPHER_WINDOWS_SANDBOX_SESSION")
            .map_err(|_| "Missing sandbox session directory")?,
    );
    let data = PathBuf::from(
        env::var("GRAPHER_WINDOWS_SANDBOX_DATA")
            .map_err(|_| "Missing sandbox data directory")?,
    );
    let engine = PathBuf::from(
        env::var("GRAPHER_WINDOWS_SANDBOX_ENGINE")
            .map_err(|_| "Missing sandbox engine directory")?,
    );
    let agent = PathBuf::from(
        env::var("PI_CODING_AGENT_DIR").map_err(|_| "Missing PI_CODING_AGENT_DIR")?,
    );
    let target = PathBuf::from(
        env::var("GRAPHER_WINDOWS_SANDBOX_TARGET").map_err(|_| "Missing sandbox target")?,
    );
    let source = PathBuf::from(
        env::var("GRAPHER_WINDOWS_SANDBOX_SOURCE")
            .map_err(|_| "Missing sandbox source directory")?,
    );
    if engine.starts_with(&source)
        || source.starts_with(&engine)
        || agent.starts_with(&source)
        || source.starts_with(&agent)
    {
        return Err(format!(
            "Windows Graph sandbox paths overlap the source or engine boundary (source={}, engine={}, agent={})",
            source.display(), engine.display(), agent.display()
        ));
    }

    let temp = session.join("tmp");
    fs::create_dir_all(&temp).map_err(|error| error.to_string())?;

    // Data itself is not an allowed read/write root. Only the current session
    // is granted access; data is traversable so the session can be reached.
    grant_traverse_many(
        &[&current, &session, &data, &engine, &agent, &target],
        sid,
    )?;
    for path in [&current, &session, &engine, &agent, &temp] {
        grant_tree(path, sid, GENERIC_ALL)?;
    }
    // The node borrows only the host Git object database. Validate its
    // alternate against the bound source before granting read-only access;
    // never accept an arbitrary agent-supplied alternate path.
    if let Ok(alternate) = fs::read_to_string(current.join(".git/objects/info/alternates")) {
        let expected = crate::workspace::repository_git(
            &source, &["rev-parse", "--path-format=absolute", "--git-path", "objects"]
        )?;
        let objects = PathBuf::from(alternate.trim()).canonicalize().map_err(|e| e.to_string())?;
        if objects != PathBuf::from(expected).canonicalize().map_err(|e| e.to_string())? {
            return Err("Untrusted Graph object alternate".into());
        }
        grant_traverse(&objects, sid)?;
        grant_tree(&objects, sid, GENERIC_READ_EXECUTE)?;
    }
    unsafe {
        grant_access(&target, sid, GENERIC_READ_EXECUTE, 0)?;
        if let Ok(compiler) = env::var("GRAPHER_WINDOWS_SANDBOX_COMPILER") {
            grant_access(Path::new(&compiler), sid, GENERIC_READ_EXECUTE, 0)?;
        }
    }

    // Never walk or rewrite every directory in PATH. CI's PATH includes entire
    // SDK/toolchain trees; recursively changing their ACLs can take minutes and
    // also exposes arbitrary programs to the container. The executable above
    // and Grapher-owned roots are explicit grants. External tools retain their
    // OS ACLs; an inaccessible tool must fail rather than broadening access.
    Ok(())
}

pub fn run_helper(arguments: &[String]) -> Result<i32, String> {
    let target =
        env::var("GRAPHER_WINDOWS_SANDBOX_TARGET").map_err(|_| "Missing sandbox target")?;
    let prefix =
        env::var("GRAPHER_WINDOWS_SANDBOX_PREFIX").map_err(|_| "Missing sandbox prefix")?;
    let current = PathBuf::from(
        env::var("GRAPHER_WINDOWS_SANDBOX_CURRENT").map_err(|_| "Missing sandbox current")?,
    );
    let source = PathBuf::from(
        env::var("GRAPHER_WINDOWS_SANDBOX_SOURCE")
            .map_err(|_| "Missing sandbox source directory")?,
    );
    let session = PathBuf::from(
        env::var("GRAPHER_WINDOWS_SANDBOX_SESSION").map_err(|_| "Missing sandbox session")?,
    );
    let data = PathBuf::from(
        env::var("GRAPHER_WINDOWS_SANDBOX_DATA").map_err(|_| "Missing sandbox data directory")?,
    );
    let engine = PathBuf::from(
        env::var("GRAPHER_WINDOWS_SANDBOX_ENGINE")
            .map_err(|_| "Missing sandbox engine directory")?,
    );
    let agent = PathBuf::from(
        env::var("PI_CODING_AGENT_DIR").map_err(|_| "Missing PI_CODING_AGENT_DIR")?,
    );
    let profile = profile_name(&session);

    unsafe {
        let (app_sid, capability_sid) = create_profile(&profile)?;
        let result = (|| {
            #[cfg(test)]
            eprintln!("AppContainer probe: granting workspace ACLs");
            prepare_access(app_sid)?;
            #[cfg(test)]
            eprintln!("AppContainer probe: workspace ACLs ready");
            let temp = session.join("tmp");
            env::set_var("TEMP", &temp);
            env::set_var("TMP", &temp);
            let mut capability = SID_AND_ATTRIBUTES {
                Sid: capability_sid,
                Attributes: 0x0000_0004,
            };
            let mut capabilities = SECURITY_CAPABILITIES {
                AppContainerSid: app_sid,
                Capabilities: &mut capability,
                CapabilityCount: 1,
                Reserved: 0,
            };
            let mut attribute_size = 0usize;
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attribute_size);
            if attribute_size == 0 {
                return Err(windows_error("InitializeProcThreadAttributeList(size)"));
            }
            let mut attribute_buffer = vec![0u8; attribute_size];
            let attributes = attribute_buffer.as_mut_ptr().cast();
            if InitializeProcThreadAttributeList(attributes, 1, 0, &mut attribute_size) == 0 {
                return Err(windows_error("InitializeProcThreadAttributeList"));
            }
            if UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                (&mut capabilities as *mut SECURITY_CAPABILITIES).cast(),
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                ptr::null_mut(),
                ptr::null(),
            ) == 0
            {
                DeleteProcThreadAttributeList(attributes);
                return Err(windows_error("UpdateProcThreadAttribute"));
            }

            let mapped_target = map_child_argument(
                &target, &current, &source, &session, &data, &engine, &agent,
            );
            let mapped_prefix = map_child_argument(
                &prefix, &current, &source, &session, &data, &engine, &agent,
            );
            let mapped_arguments: Vec<String> = arguments
                .iter()
                .skip(2)
                .map(|argument| {
                    map_child_argument(
                        argument, &current, &source, &session, &data, &engine, &agent,
                    )
                })
                .collect();
            let mapped_prefix = module_specifier(&mapped_prefix);
            let mapped_tsconfig = map_child_argument(
                &engine.join("pi/tsconfig.json").to_string_lossy(),
                &current, &source, &session, &data, &engine, &agent,
            );
            let mapped_execution = map_child_argument(
                &engine.join("engine/execution-cli.ts").to_string_lossy(),
                &current, &source, &session, &data, &engine, &agent,
            );
            let mapped_extension = map_child_argument(
                &engine.join("engine/prompt-extension.ts").to_string_lossy(),
                &current, &source, &session, &data, &engine, &agent,
            );
            let mapped_preflight = map_child_argument(
                &engine.join("pi/node_modules/tsx/dist/preflight.cjs").to_string_lossy(),
                &current, &source, &session, &data, &engine, &agent,
            );
            let mapped_loader = map_child_argument(
                &engine.join("pi/node_modules/tsx/dist/loader.mjs").to_string_lossy(),
                &current, &source, &session, &data, &engine, &agent,
            );
            let mapped_loader = module_specifier(&mapped_loader);
            env::set_var("GRAPHER_WINDOWS_SANDBOX_CURRENT_RELATIVE", ".");
            env::set_var(
                "GRAPHER_TSX_PIPE_ID",
                current.file_name().and_then(|name| name.to_str()).unwrap_or("session"),
            );
            env::set_var("GRAPHER_WINDOWS_SANDBOX_ENTRYPOINT", &mapped_prefix);
            env::set_var(
                "NODE_OPTIONS",
                "--preserve-symlinks --preserve-symlinks-main",
            );
            env::set_var("GRAPHER_WINDOWS_SANDBOX_TSX_PREFLIGHT", &mapped_preflight);
            env::set_var("GRAPHER_WINDOWS_SANDBOX_TSX_LOADER", &mapped_loader);
            let command = std::iter::once(mapped_target.as_str())
                .chain([
                    "--preserve-symlinks",
                    "--preserve-symlinks-main",
                    "--eval",
                    "require(process.env.GRAPHER_WINDOWS_SANDBOX_ENTRYPOINT)",
                    "--",
                    "tsx.cjs",
                    "--tsconfig",
                    mapped_tsconfig.as_str(),
                    mapped_execution.as_str(),
                    "--extension",
                    mapped_extension.as_str(),
                ])
                .chain(mapped_arguments.iter().map(String::as_str))
                .map(quote_arg)
                .collect::<Vec<_>>()
                .join(" ");
            if let Ok(compiler) = env::var("GRAPHER_WINDOWS_SANDBOX_COMPILER") {
                let mapped = map_child_argument(
                    &compiler, &current, &source, &session, &data, &engine, &agent,
                );
                env::set_var("GRAPHER_COMPILER_PATH", mapped);
            }
            let mut command_line = wide(&command);
            let current_wide = wide(
                &normal_windows_path(&current)
                    .to_string_lossy()
                    .into_owned(),
            );
            let application_path = normal_windows_path(Path::new(&target));
            let application = wide(&application_path.to_string_lossy());
            let mut startup = STARTUPINFOEXW::default();
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            startup.lpAttributeList = attributes;
            for handle in [
                startup.StartupInfo.hStdInput,
                startup.StartupInfo.hStdOutput,
                startup.StartupInfo.hStdError,
            ] {
                if !handle.is_null() {
                    let _ = windows_sys::Win32::Foundation::SetHandleInformation(
                        handle,
                        HANDLE_FLAG_INHERIT,
                        HANDLE_FLAG_INHERIT,
                    );
                }
            }
            let mut process = PROCESS_INFORMATION::default();
            #[cfg(test)]
            eprintln!("AppContainer probe: creating sandboxed process");
            let created = CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                ptr::null(),
                current_wide.as_ptr(),
                &startup.StartupInfo as *const _,
                &mut process,
            );
            DeleteProcThreadAttributeList(attributes);
            if created == 0 {
                return Err(windows_error("CreateProcessW(AppContainer)"));
            }
            CloseHandle(process.hThread);
            // A broken sandbox probe must fail promptly rather than hanging CI.
            // Real agent executions remain governed by the outer process job.
            #[cfg(test)]
            let wait_limit = 30_000;
            #[cfg(not(test))]
            let wait_limit = INFINITE;
            #[cfg(test)]
            eprintln!("AppContainer probe: waiting for sandboxed process");
            let waited = WaitForSingleObject(process.hProcess, wait_limit);
            #[cfg(test)]
            if waited == WAIT_TIMEOUT {
                windows_sys::Win32::System::Threading::TerminateProcess(process.hProcess, 1);
                WaitForSingleObject(process.hProcess, INFINITE);
                CloseHandle(process.hProcess);
                return Err("AppContainer test process did not exit within 30 seconds".into());
            }
            if waited != WAIT_OBJECT_0 {
                let error = windows_error("WaitForSingleObject(AppContainer)");
                CloseHandle(process.hProcess);
                return Err(error);
            }
            let mut exit_code = 1u32;
            if GetExitCodeProcess(process.hProcess, &mut exit_code) == 0 {
                CloseHandle(process.hProcess);
                return Err(windows_error("GetExitCodeProcess"));
            }
            CloseHandle(process.hProcess);
            Ok(exit_code as i32)
        })();
        LocalFree(app_sid);
        LocalFree(capability_sid);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    // Run only by the parent test inside the sandbox. File access is checked
    // directly instead of passing a script through cmd.exe's /C quoting rules.
    #[test]
    #[ignore = "AppContainer child probe"]
    fn appcontainer_probe_child() {
        assert_eq!(
            env::var("GRAPHER_WINDOWS_SANDBOX_PROBE").as_deref(),
            Ok("1")
        );
        let source = PathBuf::from(env::var("GRAPHER_WINDOWS_SANDBOX_SOURCE").unwrap());
        let current = PathBuf::from(env::var("GRAPHER_WINDOWS_SANDBOX_CURRENT").unwrap());
        let session = PathBuf::from(env::var("GRAPHER_WINDOWS_SANDBOX_SESSION").unwrap());
        let sibling = current.parent().unwrap().join("sibling");
        let other_session = session.parent().unwrap().join("other-session");
        for denied in [&source, &sibling, &other_session] {
            assert!(
                fs::read_to_string(denied.join("marker.txt")).is_err(),
                "{}",
                denied.display()
            );
            assert!(
                fs::write(denied.join("forbidden.txt"), "forbidden").is_err(),
                "{}",
                denied.display()
            );
        }
        fs::write(current.join("allowed.txt"), "allowed").unwrap();
        fs::write(session.join("allowed.txt"), "session").unwrap();
    }

    #[test]
    fn appcontainer_allows_current_workspace_and_denies_source() {
        let _guard = ENV_LOCK.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let current = root.path().join(".grapher-worktrees/run/node");
        let sibling = current.parent().unwrap().join("sibling");
        let data = root.path().join("data");
        let session = data.join("sessions/test-session");
        let other_session = data.join("sessions/other-session");
        let engine = root.path().join("engine");
        let agent = root.path().join("agent");
        for path in [
            &source,
            &current,
            &sibling,
            &data,
            &session,
            &other_session,
            &engine,
            &agent,
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        for path in [&source, &sibling, &other_session] {
            std::fs::write(path.join("marker.txt"), "protected").unwrap();
        }
        // The test executable is statically built and its path is under our
        // allowed engine root; no system executable ACLs or shell are needed.
        let target = engine.join("sandbox-probe.exe");
        std::fs::copy(std::env::current_exe().unwrap(), &target).unwrap();
        let current_marker = current.join("marker.txt");
        std::fs::write(&current_marker, "current").unwrap();

        let values = [
            (
                "GRAPHER_WINDOWS_SANDBOX_TARGET",
                target.to_string_lossy().into_owned(),
            ),
            ("GRAPHER_WINDOWS_SANDBOX_PREFIX", "--exact".into()),
            ("GRAPHER_WINDOWS_SANDBOX_PROBE", "1".into()),
            (
                "GRAPHER_WINDOWS_SANDBOX_CURRENT",
                current.to_string_lossy().into_owned(),
            ),
            (
                "GRAPHER_WINDOWS_SANDBOX_SESSION",
                session.to_string_lossy().into_owned(),
            ),
            (
                "GRAPHER_WINDOWS_SANDBOX_DATA",
                data.to_string_lossy().into_owned(),
            ),
            (
                "GRAPHER_WINDOWS_SANDBOX_ENGINE",
                engine.to_string_lossy().into_owned(),
            ),
            (
                "GRAPHER_WINDOWS_SANDBOX_SOURCE",
                source.to_string_lossy().into_owned(),
            ),
            ("PI_CODING_AGENT_DIR", agent.to_string_lossy().into_owned()),
        ];
        let previous: Vec<_> = values
            .iter()
            .map(|(key, _)| (*key, std::env::var_os(key)))
            .collect();
        for (key, value) in &values {
            std::env::set_var(key, value);
        }
        let result = run_helper(&[
            "grapher.exe".into(),
            "--grapher-windows-sandbox-helper".into(),
            "windows_sandbox::tests::appcontainer_probe_child".into(),
            "--include-ignored".into(),
            "--nocapture".into(),
        ]);
        for (key, value) in previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        assert_eq!(result.unwrap(), 0);
        assert_eq!(
            std::fs::read_to_string(current.join("allowed.txt"))
                .unwrap()
                .trim(),
            "allowed"
        );
        assert_eq!(
            std::fs::read_to_string(session.join("allowed.txt")).unwrap(),
            "session"
        );
        for path in [&source, &sibling, &other_session] {
            assert!(!path.join("forbidden.txt").exists());
            assert_eq!(
                std::fs::read_to_string(path.join("marker.txt")).unwrap(),
                "protected"
            );
        }
        assert_eq!(std::fs::read_to_string(current_marker).unwrap(), "current");
    }
}
