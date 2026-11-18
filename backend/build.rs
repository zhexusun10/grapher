use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
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
    let release = env::var("PROFILE").as_deref() == Ok("release");
    let commit = git(&root, &["rev-parse", "--verify", "HEAD"])
        .map(|sha| sha.trim().to_owned())
        .filter(|sha| sha.len() == 40 && sha.bytes().all(|c| c.is_ascii_hexdigit()))
        .unwrap_or_else(|| "unknown".into());
    // Release binaries (including Harbor benchmarks) verify full checkout
    // cleanliness against every tracked file. Debug builds always report dirty
    // so editing frontend/docs/scripts never triggers a full Rust rebuild while
    // still never falsely reporting a dirty tree as the clean HEAD.
    let clean = release
        && git(
            &root,
            &["status", "--porcelain", "--untracked-files=normal"],
        )
        .is_some_and(|status| status.trim().is_empty());
    println!("cargo:rustc-env=GRAPHER_BUILD_COMMIT={commit}");
    println!(
        "cargo:rustc-env=GRAPHER_BUILD_DIRTY={}",
        if clean { "0" } else { "1" }
    );

    println!("cargo:rerun-if-changed=build.rs");
    let dotgit = root.join(".git");
    if dotgit.is_dir() {
        println!("cargo:rerun-if-changed={}", dotgit.join("HEAD").display());
        if release {
            println!("cargo:rerun-if-changed={}", dotgit.join("index").display());
        }
    } else {
        println!("cargo:rerun-if-changed={}", dotgit.display());
    }
    if release {
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
}
