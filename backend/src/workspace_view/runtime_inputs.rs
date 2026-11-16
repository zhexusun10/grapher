//! Read-only native file proof from the existing graph Git channel. This never
//! checks out code, reads the live project files, repairs objects or creates refs.
use super::*;
use std::collections::BTreeSet;

struct TreeEntry {
    mode: String,
    kind: String,
    oid: String,
}

#[cfg(windows)]
fn ordinal_case_alias(left: &str, right: &str) -> Result<bool, String> {
    // Unicode lowercase conversion merges distinct Windows names (K/K,
    // İ/i+combining-dot). Use the native ordinal table for alias fallback.
    #[link(name = "kernel32")]
    extern "system" {
        fn CompareStringOrdinal(
            left: *const u16,
            left_len: i32,
            right: *const u16,
            right_len: i32,
            ignore_case: i32,
        ) -> i32;
    }
    let left: Vec<_> = left.encode_utf16().collect();
    let right: Vec<_> = right.encode_utf16().collect();
    let left_len = i32::try_from(left.len()).map_err(|_| "Native path component is too long")?;
    let right_len = i32::try_from(right.len()).map_err(|_| "Native path component is too long")?;
    match unsafe { CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) } {
        1 | 3 => Ok(false),
        2 => Ok(true),
        _ => Err(format!(
            "Cannot compare native project path components: {}",
            std::io::Error::last_os_error()
        )),
    }
}

fn find_entry<'a>(
    entries: &'a BTreeMap<String, TreeEntry>,
    part: &str,
    path: &str,
) -> Result<Option<&'a TreeEntry>, String> {
    // Exact recorded names work on both case-sensitive and case-insensitive
    // volumes. This verifies one native input, not the whole tree's ability to
    // materialize on a particular volume (normal preparation still checks it).
    if let Some(entry) = entries.get(part) {
        return Ok(Some(entry));
    }
    #[cfg(windows)]
    {
        let mut found = None;
        for (name, entry) in entries {
            if ordinal_case_alias(name, part)? {
                if found.is_some() {
                    return Err(format!(
                        "Ambiguous native runtime project path in codeRef: {path}"
                    ));
                }
                found = Some(entry);
            }
        }
        if let Some(entry) = found {
            return Ok(Some(entry));
        }
    }
    // macOS canonicalize can retain caller casing/Unicode spelling. A Git
    // name alone cannot decide whether a missing W's destination volume treats
    // a different spelling as the same path. Keep the prior prepared-file
    // check instead of introducing a new rejection or guessing identity.
    #[cfg(target_os = "macos")]
    {
        let _ = path;
        Ok(None)
    }
    #[cfg(not(target_os = "macos"))]
    Err(format!("Native runtime project input is missing from codeRef: {path}; preserving current workspace/state"))
}

pub(crate) fn verify_native_inputs(
    source: &Path,
    code_ref: &str,
    expected: &[(String, String, String)],
) -> Result<(), String> {
    if expected.is_empty() {
        return Ok(());
    }
    if expected.len() > 128
        || !matches!(code_ref.len(), 40 | 64)
        || !code_ref.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Invalid native runtime codeRef proof request".into());
    }
    let shadow = workspace::shadow_repo_if_exists(source)?
        .ok_or("Missing recorded project Git objects for native runtime preflight; live source cannot repair history")?;
    let git_dir = shadow.to_str().ok_or("Invalid project Git object path")?;
    let git = |args: &[&str]| {
        let mut command = vec!["--git-dir", git_dir];
        command.extend_from_slice(args);
        workspace::git(source, &command)
    };
    if git(&["cat-file", "-t", code_ref])? != "commit" {
        return Err("Native runtime codeRef does not name a recorded commit".into());
    }
    let root_tree = git(&["rev-parse", "--verify", &format!("{code_ref}^{{tree}}")])?;
    let mut trees = BTreeMap::<String, BTreeMap<String, TreeEntry>>::new();
    let mut verified = BTreeSet::new();
    'inputs: for (root, path, wanted) in expected {
        if root != "workspace"
            || path.is_empty()
            || !Path::new(path)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
            || path.contains('\0')
            || wanted.len() != 40
            || !wanted.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Invalid native runtime project byte evidence".into());
        }
        let parts = Path::new(path)
            .components()
            .map(|part| {
                part.as_os_str()
                    .to_str()
                    .ok_or("Native project input path is not UTF-8")
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut tree = root_tree.clone();
        let mut object = String::new();
        for (index, part) in parts.iter().enumerate() {
            if !trees.contains_key(&tree) {
                let bytes = workspace::git_bytes(
                    source,
                    &["--git-dir", git_dir, "ls-tree", "-z", &tree],
                    None,
                    None,
                )?;
                let listing =
                    String::from_utf8(bytes).map_err(|_| "Non-UTF-8 project tree names")?;
                let mut entries = BTreeMap::new();
                for item in listing.split('\0').filter(|item| !item.is_empty()) {
                    let (header, name) =
                        item.split_once('\t').ok_or("Invalid project tree entry")?;
                    let fields: Vec<_> = header.split_whitespace().collect();
                    if fields.len() != 3 {
                        return Err("Invalid project tree metadata".into());
                    }
                    entries.insert(
                        name.into(),
                        TreeEntry {
                            mode: fields[0].into(),
                            kind: fields[1].into(),
                            oid: fields[2].into(),
                        },
                    );
                }
                trees.insert(tree.clone(), entries);
            }
            let Some(entry) = find_entry(&trees[&tree], part, path)? else {
                eprintln!("Native runtime project input {path} has no exact Git spelling on this host; byte/path verification remains deferred until code preparation, before E writes");
                continue 'inputs;
            };
            if index + 1 < parts.len() {
                if entry.kind != "tree" || entry.mode != "040000" {
                    return Err(format!(
                        "Native runtime project input traverses a non-directory in codeRef: {path}"
                    ));
                }
                tree = entry.oid.clone();
            } else {
                if entry.kind != "blob" || !matches!(entry.mode.as_str(), "100644" | "100755") {
                    return Err(format!(
                        "Native runtime project input lacks regular-file bytes in codeRef: {path}"
                    ));
                }
                object = entry.oid.clone();
            }
        }
        if object.len() == 40 && object != *wanted {
            return Err(format!("Native runtime project input differs from codeRef bytes: {path}; preserving current workspace/state"));
        }
        if verified.insert((object.clone(), wanted.clone())) {
            // Stream and hash the complete recorded bytes, including for
            // SHA-256 storage. Cache this proof only for the current preflight.
            workspace::verify_git_blob(source, &shadow, &object, wanted)
                .map_err(|error| format!("{path}: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "runtime_inputs_tests.rs"]
mod tests;
