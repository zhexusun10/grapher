//! Bounded, read-only Git blob verification for native recovery evidence.
//! Object storage can be SHA-1 or SHA-256; the recorded blob identity is SHA-1.
use super::{configure_host_git, SlotGitGuard};
use sha1_checked::{Digest, Sha1};
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
};

const CHUNK: usize = 64 * 1024;
const DIAGNOSTICS: usize = 16 * 1024;
const HEADER_LIMIT: u64 = 128;

fn oid(value: &str, sizes: &[usize]) -> bool {
    sizes.contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn verify_git_blob(
    cwd: &Path,
    git_dir: &Path,
    object: &str,
    expected: &str,
) -> Result<(), String> {
    if !oid(object, &[40, 64]) || !oid(expected, &[40]) {
        return Err("Invalid streaming native runtime blob identity".into());
    }
    let _lease = SlotGitGuard::acquire(cwd)?;
    let mut command = Command::new(crate::native::trusted_git()?);
    configure_host_git(&mut command);
    crate::native::clear_git_environment(&mut command);
    command
        .current_dir(cwd)
        .arg("--git-dir")
        .arg(crate::native::host_path(git_dir))
        .args([
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
            "cat-file",
            "--batch",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1");
    run(command, object, expected)
        .map_err(|error| format!("Native runtime project blob bytes failed verification ({object}): {error}; preserving current workspace/state"))
}

// The invocation's process boundary is owned through read/write failures and
// unwind. Normal Git blob reads cannot spawn hooks or lazy-fetch helpers.
struct OwnedChild {
    process: Child,
    tree: Option<crate::process_control::ProcessTree>,
    reaped: bool,
}
impl OwnedChild {
    fn terminate(&mut self) {
        if let Some(tree) = &self.tree {
            tree.terminate();
        }
        let _ = self.process.kill();
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        // A descendant holding stderr must also release it before scope joins,
        // including during unwind after the direct child has already exited.
        if let Some(tree) = &self.tree {
            tree.terminate();
        }
        if !self.reaped {
            let _ = self.process.kill();
            let _ = self.process.wait();
        }
    }
}

struct Invocation(crate::process_control::ProcessTree);
impl Drop for Invocation {
    fn drop(&mut self) {
        self.0.terminate();
    }
}

fn run(mut command: Command, object: &str, expected: &str) -> Result<(), String> {
    crate::process_control::check_current_owner_stop()?;
    crate::process_control::configure_command(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Retain host Git's no-console behavior while assigning the suspended
        // child to its owner before it can execute or start descendants.
        command.creation_flags(0x0800_0000 | 0x0000_0200 | 0x0000_0004);
    }
    let mut child = OwnedChild {
        process: command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Cannot start Git blob reader: {error}"))?,
        tree: None,
        reaped: false,
    };
    // Host snapshot utilities keep their existing resource-limit semantics;
    // registration adds cancellation ownership, not a new memory/CPU gate.
    child.tree = Some(crate::process_control::with_resource_limits(None, || {
        crate::process_control::track(&child.process)
    })?);
    let mut input = child
        .process
        .stdin
        .take()
        .ok_or("Missing Git blob request pipe")?;
    let output = child
        .process
        .stdout
        .take()
        .ok_or("Missing Git blob output pipe")?;
    let stderr = child
        .process
        .stderr
        .take()
        .ok_or("Missing Git blob diagnostics pipe")?;
    std::thread::scope(move |scope| {
        let invocation = Invocation(child.tree.as_ref().expect("tracked blob reader").clone());
        // Reap concurrently with pipe reads. On POSIX a descendant can keep
        // stdout open after Git exits; waiting for EOF before wait() would hang.
        let waiter = scope.spawn(move || {
            let mut child = child;
            let status = child.process.wait();
            if status.is_ok() {
                child.reaped = true;
            } else {
                child.terminate();
                let _ = child.process.wait();
            }
            if let Some(tree) = &child.tree {
                tree.terminate();
            }
            status
        });
        // Drain continuously even after the retained prefix is full. Stderr
        // backpressure must not block Git while stdout is consumed.
        let diagnostic_reader = scope.spawn(move || drain_diagnostics(stderr));
        let result = (|| {
            writeln!(input, "{object}")
                .map_err(|error| format!("Cannot request Git blob: {error}"))?;
            drop(input); // one object, then EOF; no persistent batch process
            verify_response(output, object, expected)
        })();
        if result.is_err() {
            invocation.0.terminate();
        }
        let status = waiter.join().map_err(|_| "Git blob waiter panicked")?;
        let diagnostics = diagnostic_reader
            .join()
            .map_err(|_| "Git diagnostic reader panicked")?
            .map_err(|error| format!("Cannot read Git diagnostics: {error}"))?;
        let status = status.map_err(|error| format!("Cannot wait for Git blob reader: {error}"))?;
        if !status.success() || result.is_err() {
            return Err(format!(
                "Git blob reader {status}: {}{}",
                result
                    .err()
                    .unwrap_or_else(|| "Git failed after emitting blob data".into()),
                if diagnostics.is_empty() {
                    String::new()
                } else {
                    format!(
                        "\nstderr (bounded): {}",
                        String::from_utf8_lossy(&diagnostics)
                    )
                }
            ));
        }
        Ok(())
    })
}

fn drain_diagnostics(mut input: impl Read) -> io::Result<Vec<u8>> {
    let mut retained = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let count = match input.read(&mut chunk) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            return Ok(retained);
        }
        let keep = count.min(DIAGNOSTICS - retained.len());
        retained.extend_from_slice(&chunk[..keep]);
    }
}

fn verify_response(input: impl Read, object: &str, expected: &str) -> Result<(), String> {
    let mut input = BufReader::with_capacity(CHUNK, input);
    let mut header = Vec::new();
    input
        .by_ref()
        .take(HEADER_LIMIT)
        .read_until(b'\n', &mut header)
        .map_err(|error| format!("Cannot read Git blob header: {error}"))?;
    if !header.ends_with(b"\n") {
        return Err("Missing or oversized Git blob header".into());
    }
    let header = std::str::from_utf8(&header).map_err(|_| "Invalid Git blob header encoding")?;
    let fields: Vec<_> = header.trim_end_matches('\n').split(' ').collect();
    if fields.len() != 3
        || fields[0] != object
        || fields[1] != "blob"
        || fields[2].is_empty()
        || !fields[2].bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("Missing, wrong-type or mismatched Git blob response".into());
    }
    let size: u64 = fields[2].parse().map_err(|_| "Invalid Git blob length")?;
    let mut hash = Sha1::new();
    hash.update(format!("blob {size}\0").as_bytes());
    let mut remaining = size;
    while remaining != 0 {
        let bytes = match input.fill_buf() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result.map_err(|error| format!("Cannot read Git blob output: {error}"))?,
        };
        if bytes.is_empty() {
            return Err("Incomplete Git blob output".into());
        }
        let count = remaining.min(bytes.len() as u64) as usize;
        hash.update(&bytes[..count]);
        input.consume(count);
        remaining -= count as u64;
    }
    let mut terminator = [0u8; 1];
    input
        .read_exact(&mut terminator)
        .map_err(|error| format!("Missing Git blob terminator: {error}"))?;
    if terminator[0] != b'\n' {
        return Err("Invalid Git blob terminator".into());
    }
    loop {
        match input.read(&mut terminator) {
            Ok(0) => break,
            Ok(_) => return Err("Unexpected data after Git blob".into()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(format!("Cannot finish reading Git blob: {error}")),
        }
    }
    if finish_hash(hash)? != expected {
        return Err("Git blob content hash differs from recorded native bytes".into());
    }
    Ok(())
}

fn finish_hash(hash: Sha1) -> Result<String, String> {
    let result = hash.try_finalize();
    if result.has_collision() {
        return Err("SHA1 collision attack detected in native runtime blob".into());
    }
    Ok(format!("{:x}", result.hash()))
}

#[cfg(test)]
#[path = "workspace_blob_tests.rs"]
mod tests;
