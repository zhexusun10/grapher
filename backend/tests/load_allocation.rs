//! TC-09: `Store::load` must never deserialize a log payload. A counting
//! allocator proves the replay parses business events only, even when the run
//! still holds tens of megabytes of legacy `Finished`/`Output` text.
use grapher::{model::*, store::Store};
use rusqlite::{params, Connection};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tempfile::TempDir;

struct Counting;
static TRACK: AtomicBool = AtomicBool::new(false);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
static MAX: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) {
            TOTAL.fetch_add(layout.size(), Ordering::Relaxed);
            MAX.fetch_max(layout.size(), Ordering::Relaxed);
        }
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { System.dealloc(ptr, layout) }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) {
            TOTAL.fetch_add(new_size, Ordering::Relaxed);
            MAX.fetch_max(new_size, Ordering::Relaxed);
        }
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

fn legacy(db: &Connection, kind: EventKind) {
    db.execute(
        "INSERT INTO events(run_id,timestamp,payload) VALUES('run',1000,?1)",
        params![serde_json::to_string(&kind).unwrap()],
    ).unwrap();
}

#[test]
fn load_of_a_large_legacy_run_never_parses_transcript_text() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.sqlite");
    {
        // Pure legacy schema: no kind/execution_id columns, no logs table.
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL);").unwrap();
        let config: Config = serde_json::from_value(serde_json::json!({
            "repository": "/repo", "model": "test", "maxParallel": 1
        })).unwrap();
        legacy(&db, EventKind::Created {
            graph: Graph {
                nodes: ["one", "two"].iter().map(|name| Node { name: (*name).into(), task: "test".into() }).collect(),
                ..Default::default()
            },
            config, planning_id: None, planning: None,
        });
        let filler = "x".repeat(8 * 1024 * 1024);
        for id in ["one", "two"] {
            let execution = Execution {
                id: id.into(), node: id.into(), revision: 1, attempt: 1,
                session_id: id.into(), worktree: String::new(), before: String::new(),
                workspace_lineage: vec![],
                after: None, status: "running".into(), output: String::new(), output_bytes: 0, pid: None,
                input: None, result: None,
                started_at: 1, completed_at: None, metrics: None,
            };
            legacy(&db, EventKind::Started { execution });
            for _ in 0..3 {
                legacy(&db, EventKind::Output { execution_id: id.into(), text: filler.clone() });
            }
            legacy(&db, EventKind::Finished {
                execution_id: id.into(), head: "h".into(),
                output: format!("{filler}{filler}{filler}END-{id}"), output_bytes: 0, metrics: None,
            });
        }
    }
    let store = Store::open(&path).unwrap();
    let before = std::fs::metadata(&path).unwrap().len();
    assert!(before > 80 * 1024 * 1024, "fixture too small: {before}");
    TOTAL.store(0, Ordering::SeqCst);
    MAX.store(0, Ordering::SeqCst);
    TRACK.store(true, Ordering::SeqCst);
    let started = std::time::Instant::now();
    let state = store.load("run").unwrap();
    let elapsed = started.elapsed();
    TRACK.store(false, Ordering::SeqCst);
    let total = TOTAL.load(Ordering::SeqCst);
    let max = MAX.load(Ordering::SeqCst);
    eprintln!("legacy load: {elapsed:?}, allocated {total} bytes, largest block {max} bytes");
    assert_eq!(state.events.len(), 5, "only business events replay");
    assert!(state.executions.iter().all(|execution| execution.output.is_empty()));
    assert_eq!(state.executions.len(), 2);
    assert!(max < 1024 * 1024, "a transcript-sized allocation was observed: {max}");
    assert!(total < 4 * 1024 * 1024, "replay allocated {total} bytes");
}
