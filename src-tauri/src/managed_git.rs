//! On-demand managed Git provisioning for desktop installs when the host has no
//! working Git executable (for example a fresh macOS machine without Xcode CLT
//! or a Windows machine without Git for Windows).
//!
//! Downloads a pinned, SHA-256-verified relocatable Git distribution into
//! `app_data_dir()/tools/git/<id>/` without requiring admin privileges or
//! growing the desktop installer size.
use crate::paths::{host_path, verify_git_executable};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManagedGitArchiveKind {
    TarGz,
    WindowsPortableGit7zExe,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ManagedGitSpec {
    pub id: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub archive_filename: &'static str,
    pub archive_kind: ManagedGitArchiveKind,
    /// Relative path inside `<install_root>` to the executable passed as
    /// `GRAPHER_TRUSTED_GIT` / `GRAPHER_MANAGED_GIT_PATH`.
    pub git_relpath: &'static str,
}

const MACOS_ARM64_SPEC: ManagedGitSpec = ManagedGitSpec {
    id: "dugite-v2.56.1-macos-arm64",
    url: "https://github.com/desktop/dugite-native/releases/download/v2.56.1/dugite-native-v2.56.1-238326e-macOS-arm64.tar.gz",
    sha256: "a882ec6882416b57d212a22bac845ae27944f96cf73453a864f6a12c17863a79",
    archive_filename: "dugite-native-v2.56.1-238326e-macOS-arm64.tar.gz",
    archive_kind: ManagedGitArchiveKind::TarGz,
    git_relpath: "bin/git-grapher",
};

const MACOS_X64_SPEC: ManagedGitSpec = ManagedGitSpec {
    id: "dugite-v2.56.1-macos-x64",
    url: "https://github.com/desktop/dugite-native/releases/download/v2.56.1/dugite-native-v2.56.1-238326e-macOS-x64.tar.gz",
    sha256: "3fdb0c2f102fe0273d64b5d5fb77315c19f2b4648a154593723cb9ed98f2bc7d",
    archive_filename: "dugite-native-v2.56.1-238326e-macOS-x64.tar.gz",
    archive_kind: ManagedGitArchiveKind::TarGz,
    git_relpath: "bin/git-grapher",
};

const WINDOWS_X64_SPEC: ManagedGitSpec = ManagedGitSpec {
    id: "portablegit-v2.56.1-windows-x64",
    url: "https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/PortableGit-2.56.1-64-bit.7z.exe",
    sha256: "9dd04a608ceb5f6ab32a73709e0ecb159d211da71b697c45ff81f6dd0c6b49c7",
    archive_filename: "PortableGit-2.56.1-64-bit.7z.exe",
    archive_kind: ManagedGitArchiveKind::WindowsPortableGit7zExe,
    git_relpath: "cmd/git.exe",
};

/// Return the pinned managed Git spec for the current OS and architecture, if
/// automatic desktop provisioning is supported on this target.
pub fn current_platform_spec() -> Option<ManagedGitSpec> {
    spec_for_target(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn spec_for_target(os: &str, arch: &str) -> Option<ManagedGitSpec> {
    match (os, arch) {
        ("macos", "aarch64") => Some(MACOS_ARM64_SPEC),
        ("macos", "x86_64") => Some(MACOS_X64_SPEC),
        ("windows", "x86_64") => Some(WINDOWS_X64_SPEC),
        _ => None,
    }
}

/// Directory where a specific managed Git revision is installed:
/// `<app_data_dir>/tools/git/<spec.id>`.
pub fn install_dir_for_spec(app_data_dir: &Path, spec: ManagedGitSpec) -> PathBuf {
    app_data_dir.join("tools").join("git").join(spec.id)
}

/// Expected executable path for the current platform's managed Git. Passed to
/// the backend sidecar via `GRAPHER_MANAGED_GIT_PATH` so the backend picks it
/// up automatically as soon as background provisioning finishes.
pub fn expected_managed_git_path(app_data_dir: &Path) -> Option<PathBuf> {
    let spec = current_platform_spec()?;
    Some(host_path(
        &install_dir_for_spec(app_data_dir, spec).join(spec.git_relpath),
    ))
}

/// Return a verified already-installed managed Git binary, if present.
pub fn existing_managed_git(app_data_dir: &Path) -> Option<PathBuf> {
    let candidate = expected_managed_git_path(app_data_dir)?;
    if !candidate.is_file() {
        return None;
    }
    verify_git_executable(&candidate).ok()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBootstrapStatus {
    /// One of `"not_needed"`, `"downloading"`, `"ready"`, `"failed"`.
    pub phase: String,
    pub git_path: Option<String>,
    pub error: Option<String>,
}

impl GitBootstrapStatus {
    pub fn not_needed(git_path: Option<PathBuf>) -> Self {
        Self {
            phase: "not_needed".into(),
            git_path: git_path.map(|p| host_path(&p).to_string_lossy().into_owned()),
            error: None,
        }
    }

    pub fn downloading() -> Self {
        Self {
            phase: "downloading".into(),
            git_path: None,
            error: None,
        }
    }

    pub fn ready(git_path: PathBuf) -> Self {
        Self {
            phase: "ready".into(),
            git_path: Some(host_path(&git_path).to_string_lossy().into_owned()),
            error: None,
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            phase: "failed".into(),
            git_path: None,
            error: Some(message.into()),
        }
    }
}

/// Single-flight background manager for on-demand Git provisioning.
#[derive(Clone)]
pub struct GitBootstrapManager {
    app_data_dir: PathBuf,
    status: Arc<Mutex<GitBootstrapStatus>>,
}

impl GitBootstrapManager {
    pub fn new(app_data_dir: PathBuf, initial_git: Option<PathBuf>) -> Self {
        let initial = if initial_git.is_some() {
            GitBootstrapStatus::not_needed(initial_git)
        } else if current_platform_spec().is_some() {
            GitBootstrapStatus::downloading()
        } else {
            GitBootstrapStatus::failed(
                "Automatic Git download is not available on this platform; please install Git manually.",
            )
        };
        Self {
            app_data_dir,
            status: Arc::new(Mutex::new(initial)),
        }
    }

    pub fn status(&self) -> GitBootstrapStatus {
        self.status
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    /// Start background provisioning if the manager was initialized in the
    /// `"downloading"` phase (i.e. no host or cached managed Git was found).
    pub fn start_background_if_needed(&self) {
        if self.status().phase != "downloading" {
            return;
        }
        self.spawn_worker();
    }

    /// Retry provisioning after a failure. Idempotent if already downloading,
    /// ready, or not needed.
    pub fn retry(&self) -> GitBootstrapStatus {
        let should_spawn = {
            let mut guard = self
                .status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.phase != "failed" {
                return guard.clone();
            }
            if current_platform_spec().is_none() {
                return guard.clone();
            }
            *guard = GitBootstrapStatus::downloading();
            true
        };
        if should_spawn {
            self.spawn_worker();
        }
        self.status()
    }

    fn spawn_worker(&self) {
        let app_data_dir = self.app_data_dir.clone();
        let status = Arc::clone(&self.status);
        let _ = thread::Builder::new()
            .name("grapher-git-bootstrap".into())
            .spawn(move || {
                let Some(spec) = current_platform_spec() else {
                    set_status(
                        &status,
                        GitBootstrapStatus::failed(
                            "Automatic Git download is not available on this platform.",
                        ),
                    );
                    return;
                };
                eprintln!(
                    "[grapher-desktop] Host Git not found; provisioning managed Git ({}) into {}...",
                    spec.id,
                    install_dir_for_spec(&app_data_dir, spec).display()
                );
                match provision_managed_git(&app_data_dir, spec) {
                    Ok(git_path) => {
                        eprintln!(
                            "[grapher-desktop] Managed Git ready at {}",
                            git_path.display()
                        );
                        set_status(&status, GitBootstrapStatus::ready(git_path));
                    }
                    Err(error) => {
                        eprintln!(
                            "[grapher-desktop] Managed Git provisioning failed: {error}"
                        );
                        set_status(&status, GitBootstrapStatus::failed(error));
                    }
                }
            });
    }
}

fn set_status(slot: &Arc<Mutex<GitBootstrapStatus>>, next: GitBootstrapStatus) {
    if let Ok(mut guard) = slot.lock() {
        *guard = next;
    }
}

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Download, verify SHA-256, extract, validate, and atomically install the
/// pinned managed Git distribution into `<app_data_dir>/tools/git/<spec.id>`.
pub fn provision_managed_git(
    app_data_dir: &Path,
    spec: ManagedGitSpec,
) -> Result<PathBuf, String> {
    let install_dir = install_dir_for_spec(app_data_dir, spec);
    let final_git = install_dir.join(spec.git_relpath);
    if final_git.is_file() {
        if let Ok(verified) = verify_git_executable(&final_git) {
            return Ok(verified);
        }
    }

    let tools_root = app_data_dir.join("tools");
    let git_parent = tools_root.join("git");
    fs::create_dir_all(&git_parent).map_err(|error| {
        format!(
            "Cannot create managed Git directory {}: {error}",
            git_parent.display()
        )
    })?;

    let temp_root = tools_root.join(format!(".git-bootstrap-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_root).map_err(|error| {
        format!(
            "Cannot create temporary Git staging directory {}: {error}",
            temp_root.display()
        )
    })?;
    let _cleanup = TempDirGuard(temp_root.clone());

    let archive_path = temp_root.join(spec.archive_filename);
    download_file(spec.url, &archive_path)?;

    let actual_sha = sha256_file(&archive_path)?;
    if !actual_sha.eq_ignore_ascii_case(spec.sha256) {
        return Err(format!(
            "SHA-256 mismatch for {}: expected {}, got {}",
            spec.archive_filename, spec.sha256, actual_sha
        ));
    }

    let staging_dir = temp_root.join("extracted");
    fs::create_dir_all(&staging_dir)
        .map_err(|error| format!("Cannot create Git extraction directory: {error}"))?;
    extract_archive(&archive_path, &staging_dir, spec.archive_kind)?;

    if matches!(spec.archive_kind, ManagedGitArchiveKind::TarGz) {
        write_posix_git_wrapper(&staging_dir)?;
    }

    let staged_git = staging_dir.join(spec.git_relpath);
    verify_git_executable(&staged_git).map_err(|error| {
        format!(
            "Extracted managed Git failed verification ({}): {error}",
            staged_git.display()
        )
    })?;

    // Atomic install: if a concurrent run already placed a valid install, keep it.
    if install_dir.exists() {
        if final_git.is_file() {
            if let Ok(verified) = verify_git_executable(&final_git) {
                return Ok(verified);
            }
        }
        let _ = fs::remove_dir_all(&install_dir);
    }

    fs::rename(&staging_dir, &install_dir).map_err(|error| {
        format!(
            "Cannot finalize managed Git installation at {}: {error}",
            install_dir.display()
        )
    })?;

    verify_git_executable(&final_git)
}

/// Write a tiny self-contained POSIX wrapper (`bin/git-grapher`) around
/// dugite-native's `bin/git` so `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, and
/// `GIT_SSL_CAINFO` resolve relative to the install directory even when callers
/// invoke Git with `env_clear()`.
pub fn write_posix_git_wrapper(install_root: &Path) -> Result<PathBuf, String> {
    let bin_dir = install_root.join("bin");
    fs::create_dir_all(&bin_dir)
        .map_err(|error| format!("Cannot create {}: {error}", bin_dir.display()))?;
    let wrapper_path = bin_dir.join("git-grapher");
    let script = concat!(
        "#!/bin/sh\n",
        "ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd -P)\"\n",
        "export GIT_EXEC_PATH=\"${GIT_EXEC_PATH:-$ROOT/libexec/git-core}\"\n",
        "if [ -d \"$ROOT/share/git-core/templates\" ]; then\n",
        "  export GIT_TEMPLATE_DIR=\"${GIT_TEMPLATE_DIR:-$ROOT/share/git-core/templates}\"\n",
        "fi\n",
        "if [ -f \"$ROOT/ssl/cacert.pem\" ]; then\n",
        "  export GIT_SSL_CAINFO=\"${GIT_SSL_CAINFO:-$ROOT/ssl/cacert.pem}\"\n",
        "fi\n",
        "exec \"$ROOT/bin/git\" \"$@\"\n",
    );
    fs::write(&wrapper_path, script)
        .map_err(|error| format!("Cannot write {}: {error}", wrapper_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&wrapper_path, fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("Cannot chmod {}: {error}", wrapper_path.display()))?;
    }
    Ok(wrapper_path)
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Cannot open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    Ok(hex)
}

fn download_file(url: &str, destination: &Path) -> Result<(), String> {
    let mut command = if cfg!(windows) {
        let mut cmd = Command::new("curl.exe");
        cmd.args([
            "-fsSL",
            "--retry",
            "2",
            "--retry-delay",
            "2",
            "--connect-timeout",
            "20",
            "--output",
        ])
        .arg(destination)
        .arg(url);
        cmd
    } else {
        let curl = if Path::new("/usr/bin/curl").is_file() {
            "/usr/bin/curl"
        } else {
            "curl"
        };
        let mut cmd = Command::new(curl);
        cmd.args([
            "-fsSL",
            "--retry",
            "2",
            "--retry-delay",
            "2",
            "--connect-timeout",
            "20",
            "--output",
        ])
        .arg(destination)
        .arg(url);
        cmd
    };

    configure_silent_command(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("Failed to start download tool for {url}: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "Failed to download Git from {url} (exit {}){}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into()),
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        ));
    }
    Ok(())
}

fn extract_archive(
    archive_path: &Path,
    destination: &Path,
    kind: ManagedGitArchiveKind,
) -> Result<(), String> {
    match kind {
        ManagedGitArchiveKind::TarGz => {
            let tar = if Path::new("/usr/bin/tar").is_file() {
                "/usr/bin/tar"
            } else {
                "tar"
            };
            let mut command = Command::new(tar);
            command
                .args(["-xzf"])
                .arg(archive_path)
                .arg("-C")
                .arg(destination);
            configure_silent_command(&mut command);
            let output = command
                .output()
                .map_err(|error| format!("Failed to run tar for managed Git: {error}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(format!(
                    "Failed to extract managed Git archive{}: {stderr}",
                    if stderr.is_empty() { "" } else { ": " }
                ));
            }
            Ok(())
        }
        ManagedGitArchiveKind::WindowsPortableGit7zExe => {
            let mut command = Command::new(archive_path);
            let mut out_arg = std::ffi::OsString::from("-o");
            out_arg.push(destination.as_os_str());
            command.arg(out_arg).arg("-y");
            configure_silent_command(&mut command);
            let output = command.output().map_err(|error| {
                format!("Failed to run PortableGit self-extractor: {error}")
            })?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(format!(
                    "PortableGit extraction failed (exit {}){}",
                    output
                        .status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "signal".into()),
                    if stderr.is_empty() {
                        String::new()
                    } else {
                        format!(": {stderr}")
                    }
                ));
            }
            Ok(())
        }
    }
}

fn configure_silent_command(command: &mut Command) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_cover_macos_and_windows_targets_with_valid_sha256() {
        for (os, arch) in [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("windows", "x86_64"),
        ] {
            let spec = spec_for_target(os, arch).expect("supported desktop target");
            assert!(spec.url.starts_with("https://github.com/"));
            assert_eq!(spec.sha256.len(), 64);
            assert!(spec.sha256.chars().all(|c| c.is_ascii_hexdigit()));
        }
        assert!(spec_for_target("linux", "x86_64").is_none());
    }

    #[test]
    fn sha256_file_computes_known_digest() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("sample.bin");
        fs::write(&file, b"abc").unwrap();
        let digest = sha256_file(&file).unwrap();
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn bootstrap_manager_marks_not_needed_when_git_already_present() {
        let temp = tempfile::tempdir().unwrap();
        let manager = GitBootstrapManager::new(
            temp.path().to_path_buf(),
            Some(PathBuf::from("/usr/bin/git")),
        );
        let status = manager.status();
        assert_eq!(status.phase, "not_needed");
        assert_eq!(status.git_path.as_deref(), Some("/usr/bin/git"));
        assert!(status.error.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn posix_git_wrapper_injects_relative_exec_path_and_forwards_args() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("git-root");
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join("libexec/git-core")).unwrap();
        fs::create_dir_all(root.join("share/git-core/templates")).unwrap();
        fs::create_dir_all(root.join("ssl")).unwrap();
        fs::write(root.join("ssl/cacert.pem"), "dummy-ca").unwrap();

        let fake_git = root.join("bin/git");
        fs::write(
            &fake_git,
            "#!/bin/sh\nprintf 'exec=%s|tpl=%s|ca=%s|arg=%s\\n' \"$GIT_EXEC_PATH\" \"$GIT_TEMPLATE_DIR\" \"$GIT_SSL_CAINFO\" \"$1\"\n",
        )
        .unwrap();
        fs::set_permissions(&fake_git, fs::Permissions::from_mode(0o755)).unwrap();

        let wrapper = write_posix_git_wrapper(&root).unwrap();
        let output = Command::new(&wrapper)
            .arg("--version")
            .env_clear()
            .output()
            .unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        let canonical_root = root.canonicalize().unwrap();
        assert!(
            stdout.contains(&format!(
                "exec={}",
                canonical_root.join("libexec/git-core").display()
            )),
            "stdout was: {stdout}"
        );
        assert!(
            stdout.contains(&format!(
                "tpl={}",
                canonical_root.join("share/git-core/templates").display()
            )),
            "stdout was: {stdout}"
        );
        assert!(
            stdout.contains(&format!(
                "ca={}",
                canonical_root.join("ssl/cacert.pem").display()
            )),
            "stdout was: {stdout}"
        );
        assert!(stdout.contains("arg=--version"), "stdout was: {stdout}");
    }
}
