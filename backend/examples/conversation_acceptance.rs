//! Run only against an acceptance COPY. No mutation of a user's source DB.
//! cargo run --release --features acceptance --example conversation_acceptance -- DB RUN_ID [BUDGET_MS]
#[cfg(feature = "acceptance")]
use grapher::model::LOG_TEXT_DESERIALIZED_BYTES;
use grapher::store::Store;
use serde_json::json;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    path::Path,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Instant,
};

struct CountedAllocator;
static COUNTING: AtomicBool = AtomicBool::new(false);
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static LARGEST: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for CountedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if COUNTING.load(Ordering::Relaxed) {
            ALLOCATED.fetch_add(layout.size(), Ordering::Relaxed);
            LARGEST.fetch_max(layout.size(), Ordering::Relaxed);
        }
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if COUNTING.load(Ordering::Relaxed) {
            ALLOCATED.fetch_add(size, Ordering::Relaxed);
            LARGEST.fetch_max(size, Ordering::Relaxed);
        }
        System.realloc(ptr, layout, size)
    }
}
#[global_allocator]
static ALLOCATOR: CountedAllocator = CountedAllocator;

fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert!(args.len() >= 3, "DB RUN_ID [BUDGET_MS]");
    let store = Store::open(Path::new(&args[1])).unwrap();
    let run = &args[2];
    let budget: f64 = args.get(3).map(|v| v.parse().unwrap()).unwrap_or(50.0);
    if args.iter().any(|arg| arg == "--checkpoint") {
        let snapshot = store.load(run).unwrap();
        let sequence = snapshot.events.last().unwrap().sequence;
        let mut payload = serde_json::to_value(&snapshot).unwrap();
        payload["events"] = json!([]);
        let db = rusqlite::Connection::open(&args[1]).unwrap();
        db.execute(
            "INSERT OR REPLACE INTO checkpoints(run_id,sequence,payload) VALUES(?1,?2,?3)",
            rusqlite::params![run, sequence, payload.to_string()],
        )
        .unwrap();
    }
    #[cfg(feature = "acceptance")]
    LOG_TEXT_DESERIALIZED_BYTES.store(0, Ordering::Relaxed);
    let first_start = Instant::now();
    let first = store.load(run).unwrap();
    let first_ms = first_start.elapsed().as_secs_f64() * 1000.0;
    #[cfg(feature = "acceptance")]
    assert_eq!(
        LOG_TEXT_DESERIALIZED_BYTES.load(Ordering::Relaxed),
        0,
        "first load deserialized log text"
    );
    let events = first.events.len();
    let executions = first.executions.len() + first.mergers.len();
    assert!(
        executions > 0 || events >= 10_000,
        "benchmark must reference actual executions, not orphan log rows"
    );
    let mut timings = Vec::new();
    let mut max_allocated = 0;
    let mut largest = 0;
    for _ in 0..30 {
        ALLOCATED.store(0, Ordering::Relaxed);
        LARGEST.store(0, Ordering::Relaxed);
        #[cfg(feature = "acceptance")]
        LOG_TEXT_DESERIALIZED_BYTES.store(0, Ordering::Relaxed);
        COUNTING.store(true, Ordering::Relaxed);
        let start = Instant::now();
        let snapshot = store.load(run).unwrap();
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        COUNTING.store(false, Ordering::Relaxed);
        max_allocated = max_allocated.max(ALLOCATED.load(Ordering::Relaxed));
        largest = largest.max(LARGEST.load(Ordering::Relaxed));
        #[cfg(feature = "acceptance")]
        assert_eq!(
            LOG_TEXT_DESERIALIZED_BYTES.load(Ordering::Relaxed),
            0,
            "load deserialized log text"
        );
        assert_eq!(snapshot.events.len(), events);
        assert!(snapshot
            .executions
            .iter()
            .chain(&snapshot.mergers)
            .all(|e| e.output.is_empty()));
        assert!(ms < budget, "load {ms:.3} ms exceeds {budget} ms budget");
        timings.push(ms);
    }
    assert!(
        first_ms < budget,
        "first load {first_ms:.3} ms exceeds {budget} ms budget"
    );
    timings.sort_by(f64::total_cmp);
    println!(
        "{}",
        json!({
            "runId":run, "iterations":30, "businessEvents":events, "executions":executions,
            "firstMs":first_ms, "p50Ms":timings[15], "p95Ms":timings[28], "maxMs":timings[29],
            "budgetMs":budget, "maxAllocatedBytes":max_allocated, "largestAllocationBytes":largest,
            "logTextDeserializedBytes": if cfg!(feature = "acceptance") { Some(0) } else { None }
        })
    );
}
