use super::*;
use std::{
    fs,
    io::{Cursor, Seek, SeekFrom},
};

fn identity(bytes: &[u8]) -> String {
    git2::Oid::hash_object(git2::ObjectType::Blob, bytes)
        .unwrap()
        .to_string()
}
fn frame(object: &str, bytes: &[u8]) -> Vec<u8> {
    let mut result = format!("{object} blob {}\n", bytes.len()).into_bytes();
    result.extend_from_slice(bytes);
    result.push(b'\n');
    result
}

#[test]
fn streaming_git_blob_review_retains_collision_detection_in_hash_finalization() {
    let input = include_bytes!("../tests/fixtures/sha1-collision/sha-mbles-1.bin");
    for chunk in [1, 37, 64, 257, input.len()] {
        let mut hash = Sha1::new();
        for part in input.chunks(chunk) {
            hash.update(part);
        }
        assert!(finish_hash(hash)
            .unwrap_err()
            .contains("collision attack detected"));
    }
}

#[test]
fn streaming_git_blob_matches_existing_ids_across_chunk_and_hash_boundaries() {
    for length in [
        0,
        1,
        55,
        56,
        63,
        64,
        65,
        CHUNK - 1,
        CHUNK,
        CHUNK + 1,
        CHUNK * 17 + 13,
    ] {
        let bytes = (0..length)
            .map(|index| (index.wrapping_mul(37) % 256) as u8)
            .collect::<Vec<_>>();
        let expected = identity(&bytes);
        for object in [expected.clone(), "a".repeat(64)] {
            verify_response(Cursor::new(frame(&object, &bytes)), &object, &expected).unwrap();
        }
    }
}

#[test]
fn streaming_git_blob_rejects_truncation_extra_data_wrong_identity_type_and_hash() {
    let bytes = b"binary\0\xff\r\n";
    let expected = identity(bytes);
    let complete = frame(&expected, bytes);
    for end in [0, 10, complete.len() - 2, complete.len() - 1] {
        assert!(verify_response(Cursor::new(&complete[..end]), &expected, &expected).is_err());
    }
    for invalid in [
        format!("{expected} missing\n").into_bytes(),
        format!("{expected} tree 0\n\n").into_bytes(),
        format!("{expected} blob 18446744073709551616\n").into_bytes(),
        vec![b'a'; 200],
        [complete.clone(), b"unexpected".to_vec()].concat(),
        frame(&"0".repeat(40), bytes),
        frame(&expected, b"different bytes"),
    ] {
        assert!(verify_response(Cursor::new(invalid), &expected, &expected).is_err());
    }
    let mut wrong_terminator = complete;
    *wrong_terminator.last_mut().unwrap() = 0;
    assert!(verify_response(Cursor::new(wrong_terminator), &expected, &expected).is_err());
}

#[test]
fn streaming_git_blob_bounds_reads_for_large_declared_content_and_propagates_io_failure() {
    struct Bounded {
        left: u64,
        calls: usize,
        fail: bool,
    }
    impl Read for Bounded {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            assert!(
                bytes.len() <= CHUNK,
                "a declared blob size must never allocate a matching read buffer"
            );
            self.calls += 1;
            if self.fail && self.calls == 3 {
                return Err(io::Error::other("fixture read failure"));
            }
            let count = self.left.min(bytes.len() as u64) as usize;
            bytes[..count].fill(b'x');
            self.left -= count as u64;
            Ok(count)
        }
    }
    let object = "0".repeat(40);
    let header = format!("{object} blob {}\n", 8u64 * 1024 * 1024 * 1024);
    // Simulate a multi-GB declaration without allocating or reading that many
    // bytes. A short actual stream must fail, not succeed or reserve 8 GB.
    let input = Cursor::new(header).chain(Bounded {
        left: (CHUNK * 8) as u64,
        calls: 0,
        fail: false,
    });
    assert!(verify_response(input, &object, &object)
        .unwrap_err()
        .contains("Incomplete"));
    let input = Cursor::new(format!("{object} blob {}\n", CHUNK * 8)).chain(Bounded {
        left: (CHUNK * 8) as u64,
        calls: 0,
        fail: true,
    });
    assert!(verify_response(input, &object, &object)
        .unwrap_err()
        .contains("fixture read failure"));
}

fn fake(script: &str) -> Command {
    let mut command = Command::new(crate::native::trusted_node().unwrap());
    command
        .args(["-e", script])
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");
    command
}

#[test]
fn streaming_git_blob_drains_bounded_stderr_and_requires_successful_child_exit() {
    let object = identity(b"abc");
    let response =
        serde_json::to_string(&String::from_utf8(frame(&object, b"abc")).unwrap()).unwrap();
    let script = format!("const fs=require('node:fs');fs.writeSync(2,Buffer.alloc(2*1024*1024,120));fs.writeSync(1,{response});");
    run(fake(&script), &object, &object).unwrap();
    let error = run(
        fake(&(script.clone() + "process.exitCode=7;")),
        &object,
        &object,
    )
    .unwrap_err();
    assert!(error.contains("7"), "{error}");
    assert!(
        error.len() < DIAGNOSTICS + 1024,
        "diagnostic retention must be bounded"
    );
    // The verifier must kill/reap its child on protocol failure even when more
    // stdout is waiting; otherwise waiting on stderr/stdout can deadlock.
    let script = "const fs=require('node:fs');fs.writeSync(1,'bad header\\n');for(let i=0;i<128;i++)fs.writeSync(1,Buffer.alloc(65536));";
    assert!(run(fake(script), &object, &object).is_err());
}

#[test]
fn streaming_git_blob_review_cancellation_interrupts_a_stalled_reader() {
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };
    let temp = tempfile::tempdir().unwrap();
    let ready = temp.path().join("ready");
    let object = identity(b"abc");
    let owner = format!("blob-review-{}", uuid::Uuid::new_v4());
    let control = crate::process_control::ResultControl::begin(&owner).unwrap();
    let ready_literal = serde_json::to_string(&ready.to_string_lossy()).unwrap();
    // The child's own short deadline makes this a bounded regression even
    // before process registration is fixed; no orphan or test-wide kill needed.
    let script = format!("require('node:fs').writeFileSync({ready_literal},'ready');setTimeout(()=>process.exit(0),5000);");
    let command = fake(&script);
    let (tx, rx) = mpsc::channel();
    let worker_owner = owner.clone();
    let worker = std::thread::spawn(move || {
        let result =
            crate::process_control::with_owner(&worker_owner, || run(command, &object, &object));
        tx.send(result).unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    while !ready.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let started = ready.exists();
    crate::process_control::cancel_result(&owner).unwrap();
    let promptly = rx.recv_timeout(Duration::from_secs(2));
    worker.join().unwrap();
    drop(control);
    assert!(started, "fixture reader never started");
    assert!(
        promptly.is_ok(),
        "result cancellation did not interrupt blocked Git blob IO"
    );
    assert!(
        promptly.unwrap().is_err(),
        "cancellation cannot become successful verification"
    );
}

#[test]
fn streaming_git_blob_review_cancellation_keeps_other_invocations_running() {
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };
    let temp = tempfile::tempdir().unwrap();
    let object = identity(b"abc");
    let response =
        serde_json::to_string(&String::from_utf8(frame(&object, b"abc")).unwrap()).unwrap();
    let mut workers = Vec::new();
    for index in 0..2 {
        let owner = format!("blob-isolation-{}", uuid::Uuid::new_v4());
        let control = crate::process_control::ResultControl::begin(&owner).unwrap();
        let ready = temp.path().join(format!("ready-{index}"));
        let release = temp.path().join(format!("release-{index}"));
        let ready_literal = serde_json::to_string(&ready.to_string_lossy()).unwrap();
        let release_literal = serde_json::to_string(&release.to_string_lossy()).unwrap();
        let script = format!("const fs=require('node:fs');fs.writeFileSync({ready_literal},'ready');setInterval(()=>{{if(fs.existsSync({release_literal})){{fs.writeSync(1,{response});process.exit(0)}}}},10);setTimeout(()=>process.exit(9),5000);");
        let command = fake(&script);
        let (tx, rx) = mpsc::channel();
        let worker_owner = owner.clone();
        let wanted = object.clone();
        let handle = std::thread::spawn(move || {
            tx.send(crate::process_control::with_owner(&worker_owner, || {
                run(command, &wanted, &wanted)
            }))
            .unwrap();
        });
        workers.push((owner, control, ready, release, rx, handle));
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while workers.iter().any(|(_, _, ready, _, _, _)| !ready.exists()) && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(10));
    }
    crate::process_control::cancel_result(&workers[0].0).unwrap();
    let cancelled = workers[0].4.recv_timeout(Duration::from_secs(2));
    let other_alive = workers[1].4.try_recv().is_err();
    fs::write(&workers[1].3, "continue").unwrap();
    let completed = workers[1].4.recv_timeout(Duration::from_secs(2));
    for (_, control, _, _, _, handle) in workers {
        handle.join().unwrap();
        drop(control);
    }
    assert!(cancelled.unwrap().is_err());
    assert!(
        other_alive,
        "cancelling one owner terminated another reader"
    );
    completed.unwrap().unwrap();
}

#[test]
fn streaming_git_blob_review_direct_exit_does_not_wait_for_leaked_pipe_holders() {
    use std::time::{Duration, Instant};
    let temp = tempfile::tempdir().unwrap();
    let late = temp.path().join("helper-survived");
    let literal = serde_json::to_string(&late.to_string_lossy()).unwrap();
    let ready = temp.path().join("helper-ready");
    let ready_literal = serde_json::to_string(&ready.to_string_lossy()).unwrap();
    let helper = format!("require('node:fs').writeFileSync({ready_literal},'ready');setTimeout(()=>{{require('node:fs').writeFileSync({literal},'leaked');process.exit(0)}},4000)");
    let object = identity(b"abc");
    let response =
        serde_json::to_string(&String::from_utf8(frame(&object, b"abc")).unwrap()).unwrap();
    let script = format!("const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',{}],{{stdio:['ignore',1,2]}}).unref();const deadline=Date.now()+2000;while(!fs.existsSync({ready_literal})&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(!fs.existsSync({ready_literal}))process.exit(9);fs.writeSync(1,{response});process.exit(0);", serde_json::to_string(&helper).unwrap());
    let start = Instant::now();
    run(fake(&script), &object, &object).unwrap();
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "a leaked inherited pipe held the verifier past direct-child exit"
    );
    assert!(
        !late.exists(),
        "the invocation's helper survived until its own deadline"
    );
}

#[test]
fn streaming_git_blob_verifies_large_loose_and_packed_objects_in_both_git_formats() {
    for format in ["sha1", "sha256"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        super::super::git(root, &["init", "-q", &format!("--object-format={format}")]).unwrap();
        let file = root.join("native.bin");
        let mut output = fs::File::create(&file).unwrap();
        let chunk = (0..CHUNK)
            .map(|i| ((i * 31 + i / 17) % 256) as u8)
            .collect::<Vec<_>>();
        for _ in 0..512 {
            output.write_all(&chunk).unwrap();
        } // 32 MiB, no whole-file test allocation
        drop(output);
        let expected = git2::Oid::hash_file(git2::ObjectType::Blob, &file)
            .unwrap()
            .to_string();
        super::super::git(root, &["add", "native.bin"]).unwrap();
        super::super::git(root, &["commit", "-qm", "original native input"]).unwrap();
        let object = super::super::git(root, &["rev-parse", "HEAD:native.bin"]).unwrap();
        verify_git_blob(root, &root.join(".git"), &object, &expected).unwrap();
        let mut output = fs::OpenOptions::new().write(true).open(&file).unwrap();
        output.seek(SeekFrom::Start((CHUNK * 300) as u64)).unwrap();
        output.write_all(b"local patch").unwrap();
        drop(output);
        super::super::git(root, &["add", "native.bin"]).unwrap();
        super::super::git(root, &["commit", "-qm", "patched native input"]).unwrap();
        super::super::git(root, &["repack", "-ad"]).unwrap();
        fs::remove_file(&file).unwrap();
        let refs = super::super::git(root, &["show-ref"]).unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();
        verify_git_blob(root, &root.join(".git"), &object, &expected).unwrap();
        assert!(verify_git_blob(root, &root.join(".git"), &object, &"0".repeat(40)).is_err());
        assert_eq!(super::super::git(root, &["show-ref"]).unwrap(), refs);
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        assert!(
            !file.exists(),
            "streaming verification never materializes a project file"
        );
    }
}
