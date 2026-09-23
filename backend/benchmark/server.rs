use super::*;
// Test-host adapter. Calls the product handlers and product drive, never a duplicate scheduler.
use serde_json::{json, Value};
use std::{
    io::Write,
    path::Path,
    time::{Duration, Instant},
};

fn write_json(path: &Path, value: &impl serde::Serialize) {
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn record(path: &Path, value: Value) {
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    writeln!(f, "{value}").unwrap();
}
fn ipc(
    window: &Arc<Service>,
    root: &Path,
    cmd: &str,
    body: Value,
) -> Result<Value, String> {
    record(
        &root.join("requests.jsonl"),
        json!({"timestamp":now(),"command":cmd,"request":body}),
    );
    let result = dispatch(window, cmd, body);
    record(
        &root.join("responses.jsonl"),
        json!({"timestamp":now(),"command":cmd,"result":result}),
    );
    result
}
fn check(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn graph(names: &[&str], edges: &[(&str, &str, bool)]) -> Graph {
    Graph {
        original_goal: "Canonical Grapher benchmark".into(),
        nodes: names
            .iter()
            .map(|name| Node {
                name: (*name).into(),
                task: format!("Write the result for {name}"),
            })
            .collect(),
        edges: edges
            .iter()
            .map(|(a, b, f)| Edge {
                from: (*a).into(),
                to: (*b).into(),
                feedback: *f,
                relation: "benchmark dependency".into(),
            })
            .collect(),
    }
}
fn settled(
    window: &Arc<Service>,
    root: &Path,
    service: &Service,
) -> Result<Value, String> {
    let start = Instant::now();
    loop {
        let s = ipc(window, root, "snapshot", json!({}))?;
        if !service.driving.load(Ordering::SeqCst)
            && matches!(s["phase"].as_str(), Some("completed" | "needs_attention"))
        {
            return Ok(s);
        }
        if start.elapsed() > Duration::from_secs(180) {
            return Err("Execution did not settle in 180 seconds".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
}
fn run_case(
    id: &str,
    root: &Path,
    service: &Arc<Service>,
    window: &Arc<Service>,
) -> Result<(), String> {
    let mut config = Config {
        repository: String::new(),
        engine: crate::fixture::ENGINE.into(),
        pi_command: "pi".into(),
        pi_args: vec![],
        model: String::new(),
        thinking_level: "medium".into(),
        max_parallel: 2,
        max_feedback: 3,
    };
    let g = match id {
        "B002" => graph(&["A", "B", "C"], &[("A", "B", false), ("B", "C", false)]),
        "B003" => graph(&["A", "B", "C"], &[("A", "B", false), ("A", "C", false)]),
        "B004" => graph(
            &["A", "B", "C", "D"],
            &[
                ("A", "B", false),
                ("A", "C", false),
                ("B", "D", false),
                ("C", "D", false),
            ],
        ),
        "B005" => graph(&["A", "B"], &[("A", "B", false), ("B", "A", false)]),
        "B006" => graph(&["A", "B"], &[("A", "B", false)]),
        "B007" | "B009" => graph(
            &["A", "review", "independent"],
            &[("A", "review", false), ("review", "A", true)],
        ),
        _ => graph(&["A"], &[]),
    };
    if id == "B009" {
        config.max_feedback = 0;
    }
    if id == "B006" {
        config.repository = crate::fixture::repository(root)?
            .to_string_lossy()
            .into();
        config.engine = "pi".into();
        config.pi_command = "/usr/bin/false".into();
    }
    let compiled = ipc(window, root, "compile_graph", json!({"graph":g}));
    write_json(&root.join("compiler.json"), &compiled);
    if id == "B005" {
        check(
            compiled.as_ref().err().is_some_and(|e| e.contains("E101")),
            "Cycle must produce E101",
        )?;
        check(
            ipc(
                window,
                root,
                "save_graph",
                json!({"graph":g,"config":config}),
            )
            .is_err(),
            "Invalid graph must be rejected",
        )?;
        let s = ipc(window, root, "snapshot", json!({}))?;
        return check(
            s["executions"].as_array().unwrap().is_empty() && !root.join("worktrees").exists(),
            "Rejected graph must not execute",
        );
    }
    compiled?;
    ipc(
        window,
        root,
        "save_graph",
        json!({"graph":g,"config":config}),
    )?;
    check(
        !root.join("worktrees").exists(),
        "Approval boundary violated",
    )?;
    ipc(window, root, "control", json!({"action":"approve"}))?;
    let mut s = settled(window, root, service)?;
    if id == "B006" {
        check(
            s["nodes"]["A"]["status"] == "failed" && s["nodes"]["B"]["status"] == "blocked",
            "Failure must propagate to dependent node",
        )?;
        check(
            s["nodes"]["A"]["error"]
                .as_str()
                .unwrap_or("")
                .contains("Pi exited"),
            "Pi exit cause must be observable",
        )?;
        check(
            s["phase"] == "needs_attention",
            "Failure must not report completion",
        )?;
    } else if id == "B009" {
        check(
            s["nodes"]["review"]["status"] == "failed"
                && s["nodes"]["independent"]["status"] == "done",
            "Retry exhaustion must preserve independent branch",
        )?;
        check(
            s["executions"].as_array().unwrap().len() == 3,
            "Zero feedback limit must not launch retry",
        )?;
    } else {
        check(
            s["phase"] == "completed",
            &format!("Expected completed, got {}: {}", s["phase"], s["nodes"]),
        )?;
        check(
            s["nodes"]
                .as_object()
                .unwrap()
                .values()
                .all(|n| n["status"] == "done"),
            "All nodes must be done",
        )?;
    }
    let executions = s["executions"].as_array().unwrap();
    let expected = match id {
        "B002" | "B003" | "B009" => 3,
        "B004" => 4,
        "B007" => 5,
        _ => 1,
    };
    check(executions.len() == expected, "Unexpected execution count")?;
    let sessions: std::collections::BTreeSet<_> = executions
        .iter()
        .map(|e| e["sessionId"].as_str().unwrap())
        .collect();
    check(
        sessions.len() == executions.len(),
        "Session IDs must be fresh per attempt",
    )?;
    // Event ordering, not merely a topology assertion.
    let events = s["events"].as_array().unwrap();
    for e in executions {
        let start = events
            .iter()
            .position(|v| v["type"] == "started" && v["execution"]["id"] == e["id"])
            .unwrap();
        for edge in g
            .edges
            .iter()
            .filter(|edge| !edge.feedback && edge.to == e["node"].as_str().unwrap())
        {
            check(
                events[..start].iter().any(|v| {
                    v["type"] == "finished"
                        && executions
                            .iter()
                            .any(|up| up["node"] == edge.from && up["id"] == v["execution_id"])
                }),
                "Downstream started before upstream completion",
            )?;
        }
        check(
            e["completedAt"].is_number(),
            "Attempt lacks completion time",
        )?;
    }
    if id == "B003" || id == "B004" {
        // Output is emitted inside execute, after actual worktree preparation.
        let mut intervals = Vec::new();
        for name in ["B", "C"] {
            let e = executions.iter().find(|e| e["node"] == name).unwrap();
            let output: Vec<_> = events
                .iter()
                .filter(|v| v["type"] == "output" && v["execution_id"] == e["id"])
                .collect();
            let start = output
                .iter()
                .find(|v| {
                    v["text"]
                        .as_str()
                        .unwrap_or("")
                        .contains("[fixture] Fresh execution")
                })
                .unwrap()["timestamp"]
                .as_u64()
                .unwrap();
            let end = output
                .iter()
                .find(|v| v["text"].as_str().unwrap_or("").contains("[assistant]"))
                .unwrap()["timestamp"]
                .as_u64()
                .unwrap();
            intervals.push((start, end));
        }
        check(
            intervals[0].0 < intervals[1].1 && intervals[1].0 < intervals[0].1,
            "B/C engine execution intervals must overlap",
        )?;
        write_json(&root.join("concurrency.json"), &intervals);
    }
    if id == "B004" {
        let d = executions.iter().find(|e| e["node"] == "D").unwrap();
        for file in ["A.md", "B.md", "C.md", "D.md"] {
            check(
                Path::new(d["worktree"].as_str().unwrap())
                    .join(file)
                    .exists(),
                "Fan-in workspace lost upstream work",
            )?;
        }
    }
    if id == "B007" {
        check(
            events
                .iter()
                .any(|e| e["type"] == "feedback" && e["accepted"] == false)
                && events
                    .iter()
                    .any(|e| e["type"] == "feedback" && e["accepted"] == true),
            "Both REVISE and ACCEPT must be observed",
        )?;
        check(
            s["feedbackCounts"]["review->A"] == 1,
            "Exactly one revision expected",
        )?;
    }
    if id == "B008" {
        let before = s.clone();
        ipc(
            window,
            root,
            "control",
            json!({"action":"intervene","node":"A","instruction":"Add a brief second revision"}),
        )?;
        s = settled(window, root, service)?;
        check(
            s["nodes"]["A"]["revision"] == 2 && s["executions"].as_array().unwrap().len() == 2,
            "Intervention must preserve first attempt and run second revision",
        )?;
        write_json(&root.join("frontend-before.json"), &before);
        write_json(&root.join("frontend-after.json"), &s);
    }
    if id == "B009" {
        // A concurrent fork temporarily inherits open file descriptions, just as Git/Pi spawn does.
        // Keep that child alive deterministically until after the old Runtime owner is dropped.
        let recovery_root = root.join("recovery");
        let mut owner = Runtime::open(&recovery_root)?;
        owner.create(
            graph(&["interrupted"], &[]),
            Config {
                engine: crate::fixture::ENGINE.into(),
                repository: String::new(),
                pi_command: "pi".into(),
                pi_args: vec![],
                model: String::new(),
                thinking_level: "medium".into(),
                max_parallel: 1,
                max_feedback: 0,
            },
        )?;
        owner.approve()?;
        owner.jobs()?;
        write_json(&recovery_root.join("before.json"), &owner.state);
        let mut pipe = [0; 2];
        if unsafe { libc::pipe(pipe.as_mut_ptr()) } != 0 {
            return Err("Cannot create fork fixture pipe".into());
        }
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            // Only async-signal-safe operations between fork and _exit.
            unsafe {
                libc::close(pipe[1]);
                let mut byte = 0u8;
                libc::read(pipe[0], (&mut byte as *mut u8).cast(), 1);
                libc::_exit(0);
            }
        }
        unsafe {
            libc::close(pipe[0]);
        }
        if pid < 0 {
            unsafe {
                libc::close(pipe[1]);
            }
            return Err("Cannot fork fixture".into());
        }
        drop(owner);
        let reopened = Runtime::open(&recovery_root);
        unsafe {
            libc::close(pipe[1]);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
        let recovered = reopened.map_err(|e| {
            format!("Runtime lock survived its owner through an unrelated fork: {e}")
        })?;
        write_json(&recovery_root.join("snapshot.json"), &recovered.state);
        check(
            recovered.state.paused && recovered.state.nodes["interrupted"].status == "failed",
            "Restart must mark interrupted execution failed and pause",
        )?;
        check(
            recovered.state.executions[0].completed_at.is_some(),
            "Recovered failure needs completion time",
        )?;
    }
    let history = ipc(window, root, "history", json!({"runId":s["runId"]}))?;
    check(
        history == s,
        "SQLite replay must exactly equal IPC snapshot",
    )?;
    let repository = root.join(crate::fixture::REPOSITORY);
    check(
        crate::workspace::git(&repository, &["status", "--porcelain"])?.is_empty(),
        "Source repository modified",
    )?;
    Ok(())
}

mod planning {
    include!("planning-host.rs");
}

pub fn main() {
    if let Ok(input) = std::env::var("BENCHMARK_PLANNING_INPUT") {
        let mut signals = signal_hook::iterator::Signals::new([signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT]).unwrap();
        thread::spawn(move || {
            if signals.forever().next().is_some() {
                crate::engine::terminate_all();
                std::process::exit(2);
            }
        });
        let result = planning::main(&input);
        crate::engine::terminate_all();
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    let id = std::env::var("BENCHMARK_CASE").expect("BENCHMARK_CASE");
    assert!(["B001", "B002", "B003", "B004", "B005", "B006", "B007", "B008", "B009"].contains(&id.as_str()), "Unknown runtime case; B010 is planning-only");
    let root = PathBuf::from(std::env::var("BENCHMARK_CASE_DIR").expect("BENCHMARK_CASE_DIR"));
    fs::create_dir_all(&root).unwrap();
    let started = now();
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open(&root).unwrap()),
        driving: AtomicBool::new(false),
        planning: AtomicBool::new(false),
        extension: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/planner.ts"),
    });
    let window = service.clone();
    if std::env::var("BENCHMARK_SERVE").is_ok() {
        use std::io::BufRead;
        // Preserve original event-store snapshots before destructive fixture-only commands.
        let mut observed = std::collections::BTreeMap::new();
        for line in std::io::stdin().lock().lines() {
            let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
            {
                let runtime = service.runtime.lock().unwrap();
                for id in runtime.store.runs().unwrap() {
                    observed.insert(id.clone(), runtime.store.load(&id).unwrap());
                }
            }
            if request["command"] == "shutdown" {
                break;
            }
            let result = ipc(
                &window,
                &root,
                request["command"].as_str().unwrap(),
                request["body"].clone(),
            );
            println!("{}", json!({"result":result}));
            std::io::stdout().flush().unwrap();
        }
        let state = service.runtime.lock().unwrap().state.clone();
        write_json(&root.join("snapshot.json"), &state);
        write_json(
            &root.join("histories.json"),
            &observed.into_values().collect::<Vec<_>>(),
        );
        crate::engine::terminate_all();
        return;
    }
    let result = run_case(&id, &root, &service, &window).and_then(|_| {
        // Test the host's failure reporting without depending on a flaky runtime
        // race or intentionally breaking a production invariant.
        if std::env::var_os("BENCHMARK_TEST_FORCE_FAILURE").is_some() {
            Err("Injected benchmark host failure".into())
        } else {
            Ok(())
        }
    });
    if result.is_err() && service.driving.load(Ordering::SeqCst) {
        crate::engine::terminate_all();
        let deadline = Instant::now();
        while service.driving.load(Ordering::SeqCst) && deadline.elapsed() < Duration::from_secs(10)
        {
            thread::sleep(Duration::from_millis(50));
        }
    }
    let state = service.runtime.lock().unwrap().state.clone();
    write_json(&root.join("snapshot.json"), &state);
    for event in &state.events {
        record(
            &root.join("runtime-events.jsonl"),
            serde_json::to_value(event).unwrap(),
        );
    }
    let failed = result.is_err();
    write_json(
        &root.join("result.json"),
        &json!({"caseId":id,"startedAt":started,"endedAt":now(),"durationMs":now()-started,"status":if failed {"FAIL"}else{"PASS"},"error":result.err(),"grapherRunId":state.run_id,"nodeExecutionCount":state.executions.len(),"retryCount":state.executions.iter().filter(|e|e.attempt>1).count()}),
    );
    crate::engine::terminate_all();
    // The artifact is useful for diagnostics, but it must not hide a failed case
    // from callers that rely on the process exit status (CI, shell, other harnesses).
    if failed {
        std::process::exit(1);
    }
}
