#![cfg(target_os = "macos")]

use grapher::sandbox;
use std::{fs, os::unix::fs::symlink, path::Path, process::Command};
use tempfile::TempDir;

fn run(profile: &Path, cwd: &Path, script: &str, paths: &[&Path]) -> std::process::Output {
    Command::new("/usr/bin/sandbox-exec")
        .arg("-f")
        .arg(profile)
        .args(["/bin/bash", "-c", script, "sandbox-test"])
        .args(paths)
        .current_dir(cwd)
        .output()
        .unwrap()
}

#[test]
fn graph_filesystem_policy_and_inherited_child_processes() {
    let temp = TempDir::new().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let source = base.join("source project");
    let root = base.join(".grapher-worktrees");
    let current = root.join("run/current");
    let sibling = root.join("run/sibling");
    let outside = base.join("outside");
    for dir in [&source, &current, &sibling, &outside] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("marker"), "original").unwrap();
    }
    let profile = base.join("profile.sb");
    sandbox::write_graph_profile(&profile, &source, &root, &current).unwrap();
    // These directories do not exist when the policy is generated.
    let later = root.join("run/later");
    let other_run = root.join("another-run/node");
    for dir in [&later, &other_run] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("marker"), "original").unwrap();
    }
    symlink(&source, current.join("source-link")).unwrap();
    symlink(&sibling, outside.join("sibling-link")).unwrap();
    symlink(&outside, current.join("outside-link")).unwrap();
    let allowed = run(&profile, &current,
        "set -e; /bin/cat marker; echo current > new-file; /bin/cat \"$1/marker\"; echo external > \"$1/new-file\"; /bin/cat outside-link/marker; /bin/sh -c 'echo child > child-file'",
        &[&outside]);
    assert!(
        allowed.status.success(),
        "allowed operations failed: {}",
        String::from_utf8_lossy(&allowed.stderr)
    );
    for denied in [
        &source,
        &sibling,
        &later,
        &other_run,
        &current.join("source-link"),
        &outside.join("sibling-link"),
        &current.join("../sibling"),
    ] {
        let result = run(&profile, &current, "/bin/cat \"$1/marker\"", &[denied]);
        assert!(
            !result.status.success(),
            "read escaped policy: {}",
            denied.display()
        );
        let result = run(
            &profile,
            &current,
            "/bin/sh -c 'echo overwrite > \"$1/marker\"' child \"$1\"",
            &[denied],
        );
        assert!(
            !result.status.success(),
            "child write escaped policy: {}",
            denied.display()
        );
        assert_eq!(
            fs::read_to_string(denied.join("marker")).unwrap(),
            "original"
        );
    }
}

#[test]
fn node_network_and_upstream_tools_work_inside_sandbox() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
        time::Duration,
    };
    let temp = TempDir::new().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let source = base.join("source");
    let root = base.join(".grapher-worktrees");
    let current = root.join("run/current");
    let sibling = root.join("run/sibling");
    let outside = base.join("outside");
    let agent = outside.join("agent");
    for dir in [&source, &current, &sibling, &agent] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("marker"), "original").unwrap();
    }
    fs::write(
        agent.join("auth.json"),
        r#"{"openai":{"type":"api_key","key":"sandbox-test-not-a-real-key"}}"#,
    )
    .unwrap();
    let profile = base.join("new-sessions/profile.sb");
    sandbox::write_graph_profile(&profile, &source, &root, &current).unwrap();
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok((mut socket, _)) = listener.accept() {
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut buffer = [0; 4096];
                socket.read(&mut buffer).unwrap();
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .unwrap();
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "sandbox could not connect to test server"
            );
            thread::sleep(Duration::from_millis(20));
        }
    });
    let network = Command::new("/usr/bin/sandbox-exec").arg("-f").arg(&profile)
        .args(["node", "--input-type=module", "-e"])
        .arg(format!("const r = await fetch('http://{address}', {{signal: AbortSignal.timeout(5000)}}); if (await r.text() !== 'ok') process.exit(1);"))
        .current_dir(&current).output().unwrap();
    assert!(
        network.status.success(),
        "Node/network failed: {}",
        String::from_utf8_lossy(&network.stderr)
    );
    server.join().unwrap();
    let probe = Command::new("/usr/bin/sandbox-exec")
        .arg("-f")
        .arg(&profile)
        .arg("node")
        .arg(project.join("pi/node_modules/tsx/dist/cli.mjs"))
        .arg("--tsconfig")
        .arg(project.join("pi/tsconfig.json"))
        .arg(project.join("scripts/sandbox-probe.ts"))
        .args([&source, &sibling, &outside])
        .env("PI_CODING_AGENT_DIR", &agent)
        .env("PI_OFFLINE", "1")
        .current_dir(&current)
        .output()
        .unwrap();
    assert!(
        probe.status.success(),
        "Pi tools failed: {}\n{}",
        String::from_utf8_lossy(&probe.stdout),
        String::from_utf8_lossy(&probe.stderr)
    );
    let cli = Command::new("/usr/bin/sandbox-exec")
        .arg("-f")
        .arg(&profile)
        .arg("node")
        .arg(project.join("engine/entrypoint.mjs"))
        .arg("--version")
        .current_dir(&current)
        .env("PI_CODING_AGENT_DIR", &agent)
        .output()
        .unwrap();
    assert!(
        cli.status.success(),
        "Pi entrypoint failed: {}",
        String::from_utf8_lossy(&cli.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&cli.stdout).trim(), "0.85.1");
}

#[test]
fn shared_git_metadata_outside_source_is_protected() {
    use grapher::workspace::git;
    let temp = TempDir::new().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let source = base.join("source");
    let common = base.join("separate-git-dir");
    let root = base.join(".grapher-worktrees");
    let current = root.join("run/current");
    fs::create_dir_all(&source).unwrap();
    git(
        &source,
        &["init", "--separate-git-dir", common.to_str().unwrap()],
    )
    .unwrap();
    fs::write(source.join("marker"), "source snapshot").unwrap();
    git(&source, &["add", "."]).unwrap();
    git(&source, &["commit", "-m", "initial"]).unwrap();
    fs::create_dir_all(current.parent().unwrap()).unwrap();
    git(
        &source,
        &[
            "worktree",
            "add",
            "--detach",
            current.to_str().unwrap(),
            "HEAD",
        ],
    )
    .unwrap();
    let profile = base.join("profile.sb");
    sandbox::write_graph_profile(&profile, &source, &root, &current).unwrap();
    assert!(run(&profile, &current, "/bin/cat marker", &[])
        .status
        .success());
    assert!(!run(&profile, &current, "/bin/cat \"$1/HEAD\"", &[&common])
        .status
        .success());
    assert!(!run(&profile, &current, "git show HEAD:marker", &[])
        .status
        .success());
    assert!(
        git(&current, &["status", "--porcelain"]).is_ok(),
        "host Git must remain usable"
    );
    for parent in [&root, current.parent().unwrap()] {
        assert!(!run(&profile, &current, "/bin/ls \"$1\"", &[parent])
            .status
            .success());
    }
}
