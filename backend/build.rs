use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
}

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest dir"))
        .parent()
        .expect("Grapher root")
        .to_path_buf();
    let commit = git(&root, &["rev-parse", "--verify", "HEAD"])
        .map(|sha| sha.trim().to_owned())
        .filter(|sha| sha.len() == 40 && sha.bytes().all(|c| c.is_ascii_hexdigit()))
        .unwrap_or_else(|| "unknown".into());
    // A dirty build must NEVER be reported as the clean HEAD even if the
    // working tree is later reverted without rebuilding the executable.
    let clean = git(
        &root,
        &["status", "--porcelain", "--untracked-files=normal"],
    )
    .is_some_and(|status| status.trim().is_empty());
    println!("cargo:rustc-env=GRAPHER_BUILD_COMMIT={commit}");
    println!(
        "cargo:rustc-env=GRAPHER_BUILD_DIRTY={}",
        if clean { "0" } else { "1" }
    );

    let dotgit = root.join(".git");
    if dotgit.is_dir() {
        println!("cargo:rerun-if-changed={}", dotgit.join("HEAD").display());
        println!("cargo:rerun-if-changed={}", dotgit.join("index").display());
    } else {
        println!("cargo:rerun-if-changed={}", dotgit.display());
    }
    if let Some(paths) = git(&root, &["ls-files", "-z", "--cached"]) {
        for path in paths.split('\0').filter(|path| !path.is_empty()) {
            let file = root.join(path);
            // Pi is a pinned submodule: Git index and pi-lock.json track its
            // revision. Do not watch the 300MB+ dependency tree recursively.
            if file.is_file() {
                println!("cargo:rerun-if-changed={}", file.display());
            }
        }
    }
}
