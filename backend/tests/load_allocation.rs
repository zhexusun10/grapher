//! Metadata replay must not allocate in proportion to current execution logs.
use grapher::{model::*, store::Store};
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
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
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

#[test]
fn load_of_large_current_logs_never_materializes_transcript_text() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("events.sqlite");
    let store = Store::open(&path).unwrap();
    let mut state = Snapshot {
        run_id: "run".into(),
        ..Default::default()
    };
    let config: Config = serde_json::from_value(serde_json::json!({
        "repository":"/repo", "model":"test", "maxParallel":1
    }))
    .unwrap();
    store
        .append(
            &mut state,
            EventKind::Created {
                graph: Graph {
                    nodes: ["one", "two"]
                        .into_iter()
                        .map(|id| Node {
                            id: id.into(),
                            task: "test".into(),
                        })
                        .collect(),
                    ..Default::default()
                },
                config,
                planning_id: None,
                planning: None,
            },
        )
        .unwrap();
    let filler = "x".repeat(8 * 1024 * 1024);
    for id in ["one", "two"] {
        let execution: Execution = serde_json::from_value(serde_json::json!({
            "id":id,"node":id,"revision":1,"attempt":1,"sessionId":id,
            "worktree":"","before":"","after":null,"status":"running","output":"",
            "startedAt":1,"completedAt":null
        }))
        .unwrap();
        store
            .append(
                &mut state,
                EventKind::Started {
                    execution,
                    message_sequences: Some(vec![]),
                    fresh_restart: false,
                },
            )
            .unwrap();
        for _ in 0..3 {
            store
                .append(
                    &mut state,
                    EventKind::Output {
                        execution_id: id.into(),
                        text: filler.clone(),
                    },
                )
                .unwrap();
        }
        store
            .append(
                &mut state,
                EventKind::Finished {
                    execution_id: id.into(),
                    head: "h".into(),
                    output: String::new(),
                    output_bytes: 3 * filler.len(),
                    metrics: None,
                },
            )
            .unwrap();
    }
    drop(store);
    drop(state);
    assert!(std::fs::metadata(&path).unwrap().len() > 48 * 1024 * 1024);
    let store = Store::open(&path).unwrap();
    TOTAL.store(0, Ordering::SeqCst);
    MAX.store(0, Ordering::SeqCst);
    TRACK.store(true, Ordering::SeqCst);
    let state = store.load("run");
    TRACK.store(false, Ordering::SeqCst);
    let state = state.unwrap();
    let total = TOTAL.load(Ordering::SeqCst);
    let max = MAX.load(Ordering::SeqCst);
    assert_eq!(state.events.len(), 5);
    assert_eq!(state.executions.len(), 2);
    assert!(state
        .executions
        .iter()
        .all(|e| e.output.is_empty() && e.output_bytes == 3 * filler.len()));
    assert!(max < 1024 * 1024, "transcript-sized allocation: {max}");
    assert!(
        total < 4 * 1024 * 1024,
        "metadata replay allocated {total} bytes"
    );
}
