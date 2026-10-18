//! Filesystem identity and model/host path normalization.
//!
//! macOS can preserve the caller's case spelling through `canonicalize()`, and
//! Windows can spell the same path with a different case or separator. String
//! equality is therefore not a reliable workspace/identity check.
use std::{ffi::OsStr, fs, path::Path, path::PathBuf};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

#[cfg(target_os = "macos")]
use std::os::unix::ffi::OsStringExt;

#[cfg(any(windows, target_os = "macos"))]
fn metadata_name(value: String) -> String {
    value.to_ascii_lowercase()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn metadata_name(value: String) -> String {
    value
}

/// Whether a directory entry is Grapher/Git metadata that ordinary snapshots
/// must never copy. Windows and default macOS volumes fold case.
pub(crate) fn is_runtime_metadata_name(name: &OsStr) -> bool {
    let name = metadata_name(name.to_string_lossy().into_owned());
    name == ".git" || name.starts_with(".grapher")
}

pub(crate) fn is_runtime_metadata_path(path: &Path) -> bool {
    path.components().any(|component| match component {
        std::path::Component::Normal(name) => is_runtime_metadata_name(name),
        _ => false,
    })
}

#[cfg(target_os = "macos")]
fn actual_existing(path: &Path) -> Option<PathBuf> {
    use std::os::unix::io::AsRawFd;
    if let Ok(file) = fs::File::open(path) {
        let mut buffer = vec![0u8; libc::PATH_MAX as usize + 1];
        let result = unsafe {
            libc::fcntl(
                file.as_raw_fd(),
                libc::F_GETPATH,
                buffer.as_mut_ptr(),
            )
        };
        if result == 0 {
            if let Some(end) = buffer.iter().position(|byte| *byte == 0) {
                return Some(PathBuf::from(std::ffi::OsString::from_vec(
                    buffer[..end].to_vec(),
                )));
            }
        }
    }
    // No read permission or an unusual file type: canonicalize still resolves
    // symlinks and /var aliases, even if it preserves the caller's letter case.
    fs::canonicalize(path).ok()
}

#[cfg(not(target_os = "macos"))]
fn actual_existing(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

/// Resolve a path to the spelling the host filesystem actually reports. This
/// resolves symlinks and fixes case/Unicode spelling on macOS. Missing leaf
/// components are appended to the normalized longest existing ancestor.
pub(crate) fn actual_path(path: &Path) -> Result<PathBuf, String> {
    if let Some(actual) = actual_existing(path) {
        return Ok(actual);
    }
    let mut candidate = path.to_path_buf();
    let mut missing = Vec::new();
    loop {
        if let Some(actual) = actual_existing(&candidate) {
            let mut result = actual;
            for name in missing.iter().rev() {
                result.push(name);
            }
            return Ok(result);
        }
        let Some(name) = candidate.file_name().map(OsStr::to_os_string) else {
            break;
        };
        missing.push(name);
        if !candidate.pop() {
            break;
        }
    }
    Err(format!("Cannot resolve path identity: {}", path.display()))
}

/// Stable comparison key. Existing paths use the host's actual spelling;
/// fallback spelling normalization covers paths that do not exist yet.
pub(crate) fn path_key(path: &Path) -> String {
    let actual = actual_path(path).unwrap_or_else(|_| path.to_path_buf());
    let text = actual.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        let text = text
            .strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .or_else(|| text.strip_prefix(r"\\?\").map(str::to_owned))
            .unwrap_or(text);
        let text = text.replace('/', "\\");
        return text
            .trim_end_matches('\\')
            .to_ascii_lowercase();
    }
    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        {
            if macos_case_insensitive(Path::new(&text)) {
                text.to_lowercase()
            } else {
                text
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            text
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_case_insensitive(path: &Path) -> bool {
    let probe = if path.is_dir() {
        path
    } else if let Some(parent) = path.parent() {
        parent
    } else {
        return false;
    };
    let Ok(original) = fs::metadata(probe) else { return false };
    let text = probe.to_string_lossy();
    let swapped: String = text.chars().map(|character| {
        if character.is_ascii_lowercase() {
            character.to_ascii_uppercase()
        } else if character.is_ascii_uppercase() {
            character.to_ascii_lowercase()
        } else {
            character
        }
    }).collect();
    if swapped == text {
        return false;
    }
    fs::metadata(swapped).is_ok_and(|other| original.dev() == other.dev() && original.ino() == other.ino())
}

/// Cheap comparison key for relative workspace paths. Avoids filesystem
/// queries in per-file snapshot loops; callers use path_key for absolute paths.
pub(crate) fn lexical_key(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        return text.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    }
    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        {
            text.to_lowercase()
        }
        #[cfg(not(target_os = "macos"))]
        {
            text
        }
    }
}

/// Compare the same directory/file even when the spelling differs.
/// Compare the same directory/file even when the spelling differs.
pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    #[cfg(unix)]
    {
        if let (Ok(left), Ok(right)) = (fs::metadata(left), fs::metadata(right)) {
            // Both paths exist. Their filesystem identity is authoritative,
            // including on case-sensitive APFS volumes.
            return left.dev() == right.dev() && left.ino() == right.ino();
        }
    }
    path_key(left) == path_key(right)
}

/// Windows tools downstream (Node module loader, Git for Windows, Git Bash)
/// receive ordinary, non-extended paths. Give the user an actionable failure
/// before a deep MAX_PATH error.
#[cfg(windows)]
pub(crate) fn ensure_windows_path(path: &Path, label: &str) -> Result<(), String> {
    let length = path.to_string_lossy().encode_utf16().count();
    if length > 240 {
        return Err(format!(
            "{label} path is {length} UTF-16 units and may exceed Windows, Node and Git command-line limits: {}. Use GRAPHER_CACHE_DIR/GRAPHER_WORKSPACE_PARENT with a shorter parent.",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn ensure_windows_path(_path: &Path, _label: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_metadata_names_are_portable() {
        for name in [".git", ".grapher", ".grapher-worktrees", ".grapher-workspaces", ".grapher-path-audit"] {
            assert!(is_runtime_metadata_name(OsStr::new(name)));
            #[cfg(any(windows, target_os = "macos"))]
            assert!(is_runtime_metadata_name(&OsStr::new(&name.to_ascii_uppercase())));
        }
        assert!(!is_runtime_metadata_name(OsStr::new("src")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn actual_path_and_same_path_follow_macos_case_insensitivity() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("MixedCaseDir");
        fs::create_dir(&directory).unwrap();
        let lower = PathBuf::from(directory.to_string_lossy().to_lowercase());
        assert!(same_path(&directory, &lower));
        let actual = actual_path(&lower).unwrap();
        assert_eq!(actual, actual_path(&directory).unwrap());
    }

    #[test]
    fn missing_leaf_keeps_its_spelling_under_the_existing_parent() {
        let temp = tempfile::tempdir().unwrap();
        let existing = temp.path().canonicalize().unwrap();
        let missing = existing.join("not-created-yet");
        assert_eq!(actual_path(&missing).unwrap(), missing);
    }

    #[cfg(windows)]
    #[test]
    fn windows_long_paths_fail_with_a_shorter_parent_hint() {
        assert!(ensure_windows_path(Path::new(r"C:\Users\test\project"), "Workspace").is_ok());
        let long = PathBuf::from(format!(r"C:\{}", "a".repeat(250)));
        let error = ensure_windows_path(&long, "Workspace").unwrap_err();
        assert!(error.contains("Workspace path is"));
        assert!(error.contains("GRAPHER_CACHE_DIR/GRAPHER_WORKSPACE_PARENT"));
    }
}
