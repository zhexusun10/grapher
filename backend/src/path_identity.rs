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
    // Never open FIFOs, sockets or special devices: `File::open` on a named
    // pipe blocks waiting for a writer, while `realpath`/`canonicalize` does not.
    // Also skip `F_GETPATH` on multi-link regular files (`nlink > 1`): XNU's
    // vnode name cache stores only one link name per inode, so a concurrent
    // open/link on a sibling hardlink would make `F_GETPATH` report the other name.
    let meta = fs::metadata(path).ok()?;
    if meta.is_dir() || (meta.is_file() && meta.nlink() == 1) {
        if let Ok(file) = fs::File::open(path) {
            let mut buffer = vec![0u8; libc::PATH_MAX as usize + 1];
            let result =
                unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
            if result == 0 {
                if let Some(end) = buffer.iter().position(|byte| *byte == 0) {
                    return Some(PathBuf::from(std::ffi::OsString::from_vec(
                        buffer[..end].to_vec(),
                    )));
                }
            }
        }
    }
    // No read permission or an unusual file type (FIFO/socket/device): resolve
    // symlinks via canonicalize, then query the parent directory's F_GETPATH and
    // directory entry so case/Unicode aliases still normalize to disk spelling.
    let canonical = fs::canonicalize(path).ok()?;
    if let (Some(parent), Some(leaf)) = (canonical.parent(), canonical.file_name()) {
        if !parent.as_os_str().is_empty() {
            if let Some(parent_actual) = actual_existing(parent) {
                if let Ok(entries) = fs::read_dir(&parent_actual) {
                    let insensitive = case_insensitive_volume(&parent_actual);
                    let leaf_path = Path::new(leaf);
                    let mut matched = None;
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        if fs::symlink_metadata(entry.path())
                            .is_ok_and(|m| m.dev() == meta.dev() && m.ino() == meta.ino())
                            && (name == leaf
                                || macos_equivalent_path(Path::new(&name), leaf_path, insensitive))
                        {
                            if name == leaf {
                                return Some(parent_actual.join(name));
                            }
                            matched.get_or_insert(name);
                        }
                    }
                    if let Some(name) = matched {
                        return Some(parent_actual.join(name));
                    }
                }
                return Some(parent_actual.join(leaf));
            }
        }
    }
    Some(canonical)
}

#[cfg(not(target_os = "macos"))]
fn actual_existing(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

#[cfg(target_os = "macos")]
mod core_foundation {
    use std::ffi::c_void;

    pub(super) type CFTypeRef = *const c_void;
    pub(super) type CFStringRef = *const c_void;
    pub(super) type CFMutableStringRef = *mut c_void;
    pub(super) type CFIndex = isize;
    pub(super) type CFStringEncoding = u32;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub(super) struct CFRange {
        pub(super) location: CFIndex,
        pub(super) length: CFIndex,
    }

    pub(super) const K_CF_STRING_ENCODING_UTF8: CFStringEncoding = 0x0800_0100;
    pub(super) const K_CF_STRING_NORMALIZATION_FORM_D: CFIndex = 0;
    pub(super) const K_CF_STRING_NORMALIZATION_FORM_C: CFIndex = 2;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub(super) fn CFStringCreateWithBytes(
            alloc: CFTypeRef,
            bytes: *const u8,
            num_bytes: CFIndex,
            encoding: CFStringEncoding,
            is_external_representation: u8,
        ) -> CFStringRef;
        pub(super) fn CFStringCreateMutableCopy(
            alloc: CFTypeRef,
            max_length: CFIndex,
            the_string: CFStringRef,
        ) -> CFMutableStringRef;
        pub(super) fn CFStringNormalize(the_string: CFMutableStringRef, the_form: CFIndex);
        pub(super) fn CFStringGetLength(the_string: CFStringRef) -> CFIndex;
        pub(super) fn CFStringGetBytes(
            the_string: CFStringRef,
            range: CFRange,
            encoding: CFStringEncoding,
            loss_byte: u8,
            is_external_representation: u8,
            buffer: *mut u8,
            max_buf_len: CFIndex,
            used_buf_len: *mut CFIndex,
        ) -> CFIndex;
        pub(super) fn CFRelease(cf: CFTypeRef);
    }
}

#[cfg(target_os = "macos")]
fn macos_normalize(value: &str, form: core_foundation::CFIndex) -> String {
    if value.is_ascii() {
        return value.to_owned();
    }
    use core_foundation::*;
    struct Guard(CFTypeRef);
    impl Drop for Guard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }
    let bytes = value.as_bytes();
    let Ok(num_bytes) = CFIndex::try_from(bytes.len()) else {
        return value.to_owned();
    };
    let cf = Guard(unsafe {
        CFStringCreateWithBytes(
            std::ptr::null(),
            bytes.as_ptr(),
            num_bytes,
            K_CF_STRING_ENCODING_UTF8,
            0,
        )
    });
    if cf.0.is_null() {
        return value.to_owned();
    }
    let mutable = Guard(unsafe { CFStringCreateMutableCopy(std::ptr::null(), 0, cf.0) });
    if mutable.0.is_null() {
        return value.to_owned();
    }
    unsafe { CFStringNormalize(mutable.0 as CFMutableStringRef, form) };
    let length = unsafe { CFStringGetLength(mutable.0) };
    let range = CFRange {
        location: 0,
        length,
    };
    let mut used = 0;
    let count = unsafe {
        CFStringGetBytes(
            mutable.0,
            range,
            K_CF_STRING_ENCODING_UTF8,
            0,
            0,
            std::ptr::null_mut(),
            0,
            &mut used,
        )
    };
    if count != length || used < 0 {
        return value.to_owned();
    }
    let mut out = vec![0u8; used as usize];
    let mut written = 0;
    let count = unsafe {
        CFStringGetBytes(
            mutable.0,
            range,
            K_CF_STRING_ENCODING_UTF8,
            0,
            0,
            out.as_mut_ptr(),
            used,
            &mut written,
        )
    };
    if count != length || written != used {
        return value.to_owned();
    }
    String::from_utf8(out).unwrap_or_else(|_| value.to_owned())
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_nfd(value: &str) -> String {
    macos_normalize(value, core_foundation::K_CF_STRING_NORMALIZATION_FORM_D)
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_nfc(value: &str) -> String {
    macos_normalize(value, core_foundation::K_CF_STRING_NORMALIZATION_FORM_C)
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_fold_component(value: &str, case_insensitive: bool) -> String {
    let nfd = macos_nfd(value);
    if case_insensitive {
        nfd.to_lowercase()
    } else {
        nfd
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_equivalent_path(left: &Path, right: &Path, case_insensitive: bool) -> bool {
    let mut left_parts = left.components();
    let mut right_parts = right.components();
    loop {
        match (left_parts.next(), right_parts.next()) {
            (None, None) => return true,
            (Some(a), Some(b)) => {
                if a != b
                    && macos_fold_component(&a.as_os_str().to_string_lossy(), case_insensitive)
                        != macos_fold_component(&b.as_os_str().to_string_lossy(), case_insensitive)
                {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

#[cfg(target_os = "macos")]
fn normalize_macos_root_firmlink_alias(path: &Path) -> PathBuf {
    for (alias, target) in [
        ("/var", "/private/var"),
        ("/tmp", "/private/tmp"),
        ("/etc", "/private/etc"),
    ] {
        let alias_path = Path::new(alias);
        if let Ok(rest) = path.strip_prefix(alias_path) {
            let expected = target.trim_start_matches('/');
            if fs::read_link(alias_path).is_ok_and(|link| {
                link == Path::new(expected) || link == Path::new(target)
            }) {
                return Path::new(target).join(rest);
            }
        }
    }
    path.to_path_buf()
}

#[cfg(target_os = "macos")]
pub(crate) fn equivalent_no_symlink_change(actual: &Path, recorded: &Path) -> bool {
    if actual == recorded {
        return true;
    }
    let normalized_recorded;
    let recorded = if actual.starts_with("/private") && !recorded.starts_with("/private") {
        normalized_recorded = normalize_macos_root_firmlink_alias(recorded);
        normalized_recorded.as_path()
    } else {
        recorded
    };
    if actual == recorded {
        return true;
    }
    let actual_parts: Vec<_> = actual.components().collect();
    let recorded_parts: Vec<_> = recorded.components().collect();
    if actual_parts.len() != recorded_parts.len() {
        return false;
    }
    let mut prefix_actual = PathBuf::new();
    let mut prefix_recorded = PathBuf::new();
    for (a, b) in actual_parts.into_iter().zip(recorded_parts) {
        prefix_actual.push(a.as_os_str());
        prefix_recorded.push(b.as_os_str());
        if a == b {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&prefix_recorded) else {
            return false;
        };
        if metadata.file_type().is_symlink() {
            return false;
        }
        let insensitive = prefix_actual
            .parent()
            .is_some_and(case_insensitive_volume);
        if macos_fold_component(&a.as_os_str().to_string_lossy(), insensitive)
            != macos_fold_component(&b.as_os_str().to_string_lossy(), insensitive)
        {
            return false;
        }
        if actual_existing(&prefix_recorded).as_deref() != Some(prefix_actual.as_path()) {
            return false;
        }
    }
    true
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

/// Drop trailing separators so `/a/b/` and `/a/b` share one key; `/` stays root.
#[cfg(not(windows))]
fn trim_posix_trailing_slashes(text: String) -> String {
    if text.len() > 1 {
        let trimmed = text.trim_end_matches('/');
        if trimmed.is_empty() && text.starts_with('/') {
            return "/".to_owned();
        }
        return trimmed.to_owned();
    }
    text
}

/// Stable comparison key. Existing paths use the host's actual spelling;
/// fallback spelling normalization covers paths that do not exist yet.
pub(crate) fn path_key(path: &Path) -> String {
    let text = actual_path(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    {
        let text = text
            .strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .or_else(|| text.strip_prefix(r"\\?\").map(str::to_owned))
            .unwrap_or(text);
        let text = text.replace('/', "\\");
        text.trim_end_matches('\\').to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        {
            let text = trim_posix_trailing_slashes(macos_nfd(&text));
            if case_insensitive_volume(Path::new(&text)) {
                text.to_lowercase()
            } else {
                text
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            trim_posix_trailing_slashes(text)
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_case_insensitive(path: &Path) -> bool {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let mut probe = None;
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            break;
        }
        if fs::metadata(ancestor).is_ok() {
            probe = Some(ancestor);
            break;
        }
    }
    let Some(probe) = probe else {
        return false;
    };
    if let Ok(c_path) = CString::new(probe.as_os_str().as_bytes()) {
        let value = unsafe { libc::pathconf(c_path.as_ptr(), libc::_PC_CASE_SENSITIVE) };
        if value == 0 {
            return true;
        }
        if value > 0 {
            return false;
        }
    }
    let Some(actual) = actual_existing(probe) else {
        return false;
    };
    let (Some(parent), Some(name)) = (actual.parent(), actual.file_name()) else {
        return false;
    };
    let (Ok(orig), Ok(parent_meta)) = (fs::metadata(&actual), fs::metadata(parent)) else {
        return false;
    };
    if orig.dev() != parent_meta.dev() {
        return false;
    }
    let name_text = name.to_string_lossy();
    let swapped: String = name_text
        .chars()
        .map(|character| {
            if character.is_ascii_lowercase() {
                character.to_ascii_uppercase()
            } else if character.is_ascii_uppercase() {
                character.to_ascii_lowercase()
            } else {
                character
            }
        })
        .collect();
    if swapped == name_text {
        return false;
    }
    fs::metadata(parent.join(swapped))
        .is_ok_and(|other| orig.dev() == other.dev() && orig.ino() == other.ino())
}

/// Whether lexical aliases should fold case on this path's volume. Relative
/// names without a root must not guess this property.
pub(crate) fn case_insensitive_volume(path: &Path) -> bool {
    #[cfg(windows)]
    {
        let _ = path;
        true
    }
    #[cfg(target_os = "macos")]
    {
        macos_case_insensitive(path)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = path;
        false
    }
}

/// Cheap comparison key for relative workspace paths. Relative names have no
/// volume context, so preserve case on POSIX; callers that have absolute paths
/// use `path_key`, which applies the host volume's actual case rules.
pub(crate) fn lexical_key(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        text.replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    }
    #[cfg(target_os = "macos")]
    {
        trim_posix_trailing_slashes(macos_nfd(&text))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        trim_posix_trailing_slashes(text)
    }
}

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

/// Match a persisted repository binding to a requested repository path.
/// Prefer canonical identity when available; on Windows and macOS also recognize
/// lexical aliases for archived/deleted paths. Never treat two failed
/// canonicalizations (or an unattributed record) as equal.
pub(crate) fn same_repository_binding(left: &str, right: &str) -> bool {
    if left.is_empty() || right.trim().is_empty() {
        return false;
    }
    if left == right {
        return true;
    }
    let left = Path::new(left);
    let right = Path::new(right);
    if !left.is_absolute() || !right.is_absolute() {
        return false;
    }
    if let (Ok(left), Ok(right)) = (left.canonicalize(), right.canonicalize()) {
        return same_path(&left, &right);
    }
    #[cfg(windows)]
    if let (Some(left), Some(right)) = (windows_repository_key(left), windows_repository_key(right))
    {
        return left == right;
    }
    #[cfg(target_os = "macos")]
    if let (Some(left), Some(right)) = (macos_repository_key(left), macos_repository_key(right)) {
        return left == right;
    }
    false
}

#[cfg(target_os = "macos")]
fn macos_repository_key(path: &Path) -> Option<String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return None;
    }
    let normalized: PathBuf = path
        .components()
        .filter(|part| !matches!(part, std::path::Component::CurDir))
        .collect();
    let key = path_key(&normalized);
    Some(if key == "/" {
        key
    } else {
        key.trim_end_matches('/').to_owned()
    })
}

#[cfg(windows)]
pub(crate) fn windows_repository_key(path: &Path) -> Option<String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return None;
    }
    // Archived bindings may point at a deleted final directory. Canonicalize
    // the longest existing ancestor first so 8.3 aliases such as RUNNER~1
    // still match the saved long path without guessing a missing component.
    let probe = actual_path(path).unwrap_or_else(|_| path.to_path_buf());
    let value = probe.to_str()?.replace('/', "\\").to_lowercase();
    let value = if let Some(unc) = value.strip_prefix(r"\\?\unc\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
    };
    Some(value.trim_end_matches('\\').to_owned())
}

/// Encode an absolute, NUL-terminated path for raw Win32 filesystem calls.
/// Unlike canonicalize, this does not follow the final symlink/junction (which
/// may be dangling). Keep this native boundary separate from Node/Git paths.
#[cfg(windows)]
pub(crate) fn windows_api_path(path: &Path) -> Result<Vec<u16>, String> {
    use std::{
        os::windows::ffi::OsStrExt,
        path::{Component, Prefix},
    };
    let absolute = std::path::absolute(path)
        .map_err(|e| format!("Cannot prepare native Windows path {}: {e}", path.display()))?;
    let (prefix, skip) = match absolute.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_) => (r"\\?\", 0),
            Prefix::UNC(..) => (r"\\?\UNC\", 2),
            _ => ("", 0),
        },
        _ => ("", 0),
    };
    Ok(OsStr::new(prefix)
        .encode_wide()
        .chain(absolute.as_os_str().encode_wide().skip(skip))
        .chain([0])
        .collect())
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
        for name in [
            ".git",
            ".grapher",
            ".grapher-worktrees",
            ".grapher-workspaces",
            ".grapher-path-audit",
        ] {
            assert!(is_runtime_metadata_name(OsStr::new(name)));
            #[cfg(any(windows, target_os = "macos"))]
            assert!(is_runtime_metadata_name(OsStr::new(
                &name.to_ascii_uppercase()
            )));
        }
        assert!(!is_runtime_metadata_name(OsStr::new("src")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn relative_scope_checks_preserve_case_on_case_sensitive_volumes() {
        let temp = tempfile::tempdir().unwrap();
        let upper = temp.path().join("Managed");
        let lower = temp.path().join("managed");
        fs::create_dir(&upper).unwrap();
        let insensitive = lower.exists();
        assert_eq!(
            crate::workspace::scope_contains_at(
                temp.path(),
                Path::new("managed/file"),
                Path::new("Managed")
            ),
            insensitive
        );
        // Relative spellings without a filesystem root preserve case instead
        // of assuming the default macOS volume behavior.
        if insensitive {
            return;
        }

        assert!(!crate::workspace::scope_contains(
            Path::new("managed/file"),
            Path::new("Managed")
        ));
        assert!(crate::workspace::scope_contains(
            Path::new("Managed/file"),
            Path::new("Managed")
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn relative_scope_checks_follow_macos_unicode_normalization() {
        let temp = tempfile::tempdir().unwrap();
        let nfc = "é";
        let nfd = "e\u{301}";
        let directory = temp.path().join(nfc);
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("child"), "scoped").unwrap();

        assert!(crate::workspace::scope_contains_at(
            temp.path(),
            Path::new(&format!("{nfd}/child")),
            Path::new(nfc)
        ));
        assert!(!crate::workspace::scope_contains_at(
            temp.path(),
            Path::new(&format!("{nfd}x/child")),
            Path::new(nfc)
        ));

        let upper = "Étage";
        let lower = "étage";
        let insensitive = crate::path_identity::case_insensitive_volume(temp.path());
        fs::create_dir(temp.path().join(upper)).unwrap();
        assert_eq!(
            crate::workspace::scope_contains_at(
                temp.path(),
                Path::new(&format!("{lower}/child")),
                Path::new(upper)
            ),
            insensitive
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn actual_path_and_same_path_follow_macos_case_insensitivity() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("MixedCaseDir");
        fs::create_dir(&directory).unwrap();
        let lower = PathBuf::from(directory.to_string_lossy().to_lowercase());
        if lower.exists() {
            assert!(same_path(&directory, &lower));
            let actual = actual_path(&lower).unwrap();
            assert_eq!(actual, actual_path(&directory).unwrap());
        } else {
            assert!(!same_path(&directory, &lower));
        }
    }

    #[test]
    fn repository_bindings_follow_filesystem_identity_and_volume_case_rules() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("MixedCaseProject");
        let lower = temp.path().join("mixedcaseproject");
        fs::create_dir(&project).unwrap();
        let matches = |other: &Path| {
            same_repository_binding(project.to_str().unwrap(), other.to_str().unwrap())
        };
        assert!(matches(&project));
        if lower.exists() {
            assert!(matches(&lower));
        } else {
            fs::create_dir(&lower).unwrap();
            assert!(!matches(&lower));
        }
        let alias = temp.path().join("alias");
        crate::path_safety::directory_link(&project, &alias);
        assert!(matches(&alias));
        assert!(!matches(&temp.path().join("missing")));
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
    fn windows_long_path_encoding_preserves_native_prefixes() {
        for (input, expected) in [
            (r"C:\project\file", r"\\?\C:\project\file"),
            (r"C:/project/../file", r"\\?\C:\file"),
            (r"C:\中文 space\file", r"\\?\C:\中文 space\file"),
            (r"\\server\share\file", r"\\?\UNC\server\share\file"),
            (r"\\?\C:\project\file", r"\\?\C:\project\file"),
            (r"\\?\UNC\server\share\file", r"\\?\UNC\server\share\file"),
        ] {
            let actual = windows_api_path(Path::new(input)).unwrap();
            assert_eq!(actual.last(), Some(&0));
            assert_eq!(
                String::from_utf16(&actual[..actual.len() - 1]).unwrap(),
                expected
            );
        }
        let relative = Path::new("project/../file");
        assert_eq!(
            windows_api_path(relative).unwrap(),
            windows_api_path(&std::path::absolute(relative).unwrap()).unwrap()
        );
        for invalid in ["invalid\0path", concat!(r"\\?\C:\invalid", "\0path")] {
            assert!(windows_api_path(Path::new(invalid)).is_err());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_case_and_unicode_helpers_handle_missing_ancestors_and_symlinks() {
        assert_eq!(macos_nfd("Caf\u{00e9}"), "Cafe\u{301}");
        assert_eq!(macos_nfc("Cafe\u{301}"), "Caf\u{00e9}");

        let temp = tempfile::tempdir().unwrap();
        let volume_insensitive = case_insensitive_volume(temp.path());
        assert_eq!(
            case_insensitive_volume(&temp.path().join("missing-a/missing-b/missing-c")),
            volume_insensitive
        );
        assert!(!case_insensitive_volume(Path::new("/dev")));

        // Offline / deleted binding fallback normalizes NFD vs NFC and respects ancestor case sensitivity.
        let offline_nfc = temp.path().join("absent/nested/Caf\u{00e9}");
        let offline_nfd = temp.path().join("absent/nested/Cafe\u{301}");
        assert!(same_repository_binding(
            offline_nfc.to_str().unwrap(),
            offline_nfd.to_str().unwrap()
        ));
        if volume_insensitive {
            let offline_case = temp.path().join("ABSENT/NESTED/cafe\u{0301}");
            assert!(same_repository_binding(
                offline_nfc.to_str().unwrap(),
                offline_case.to_str().unwrap()
            ));
        }

        // equivalent_no_symlink_change accepts NFC/NFD and case variants on real dirs,
        // while rejecting symlink replacement.
        let real_dir = temp.path().join("Cafe\u{0301}Tools");
        let other_dir = temp.path().join("OtherTools");
        fs::create_dir(&real_dir).unwrap();
        fs::create_dir(&other_dir).unwrap();
        let tool = real_dir.join("python");
        fs::write(&tool, b"py").unwrap();
        fs::write(other_dir.join("python"), b"py").unwrap();
        let actual_tool = actual_path(&tool).unwrap();
        let base_canon = temp.path().canonicalize().unwrap();
        let nfc_variant = base_canon.join("Caf\u{00e9}Tools/python");
        assert!(equivalent_no_symlink_change(&actual_tool, &nfc_variant));
        if volume_insensitive {
            let upper_variant = base_canon.join("CAF\u{00c9}TOOLS/PYTHON");
            assert!(equivalent_no_symlink_change(&actual_tool, &upper_variant));
        }

        let linked_dir = temp.path().join("LinkedTools");
        crate::path_safety::directory_link(&other_dir, &linked_dir);
        let target_through_link = actual_path(&linked_dir.join("python")).unwrap();
        let uncanonical_through_link = base_canon.join("LinkedTools/python");
        assert!(!equivalent_no_symlink_change(
            &target_through_link,
            &uncanonical_through_link
        ));

        // Platform /var -> /private/var alias matches, while symlinks beneath still fail.
        assert!(equivalent_no_symlink_change(
            &actual_tool,
            &temp.path().join("Cafe\u{0301}Tools/python")
        ));
        assert!(!equivalent_no_symlink_change(
            &target_through_link,
            &temp.path().join("LinkedTools/python")
        ));

        // Named pipe (FIFO) must resolve without blocking on File::open, including
        // when accessed through an NFC/case alias of its parent or leaf name.
        use std::os::unix::ffi::OsStrExt;
        let fifo = real_dir.join("Named.Pipe");
        let c_fifo = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_fifo.as_ptr(), 0o600) }, 0);
        let fifo_query = if volume_insensitive {
            base_canon.join("caf\u{00e9}tools/named.pipe")
        } else {
            base_canon.join("Caf\u{00e9}Tools/Named.Pipe")
        };
        assert_eq!(
            actual_path(&fifo_query).unwrap(),
            base_canon.join("Cafe\u{0301}Tools/Named.Pipe")
        );

        // Readable and unreadable hardlinked files sharing (dev, ino) must resolve to their own name.
        use std::os::unix::fs::PermissionsExt;
        let hard_a = real_dir.join("alpha-unreadable");
        let hard_b = real_dir.join("beta-unreadable");
        fs::write(&hard_a, b"secret").unwrap();
        fs::hard_link(&hard_a, &hard_b).unwrap();
        let _keep_b_open = fs::File::open(&hard_b).unwrap();
        assert_eq!(
            actual_path(&hard_a).unwrap(),
            base_canon.join("Cafe\u{0301}Tools/alpha-unreadable")
        );
        assert_eq!(
            actual_path(&hard_b).unwrap(),
            base_canon.join("Cafe\u{0301}Tools/beta-unreadable")
        );
        fs::set_permissions(&hard_a, fs::Permissions::from_mode(0o000)).unwrap();
        let resolved_a = actual_path(&hard_a).unwrap();
        let resolved_b = actual_path(&hard_b).unwrap();
        let _ = fs::set_permissions(&hard_a, fs::Permissions::from_mode(0o644));
        assert_eq!(resolved_a, base_canon.join("Cafe\u{0301}Tools/alpha-unreadable"));
        assert_eq!(resolved_b, base_canon.join("Cafe\u{0301}Tools/beta-unreadable"));
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
