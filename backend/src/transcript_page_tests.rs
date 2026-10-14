use super::*;

#[test]
fn planner_tail_pages_preserve_long_jsonl_records_and_unicode_across_boundaries() {
    let temp = tempfile::TempDir::new().unwrap();
    let id = Uuid::new_v4().to_string();
    let directory = temp.path().join("planning").join(&id);
    fs::create_dir_all(&directory).unwrap();
    let text = format!("{}\n{}\n", serde_json::json!({
        "type": "tool_execution_end", "toolCallId": "large", "toolName": "read",
        "result": { "content": [{ "type": "text", "text": "中文🚀".repeat(140_000) }] }
    }), serde_json::json!({ "type": "message_end", "message": { "role": "assistant", "content": [{ "type": "text", "text": "完成" }] } }));
    fs::write(directory.join("planner.jsonl"), &text).unwrap();
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open(temp.path()).unwrap()),
        driving: AtomicBool::new(false),
        drive_signal: (Mutex::new(0), std::sync::Condvar::new()),
        planning: AtomicBool::new(false),
        extension: temp.path().join("unused"),
    });
    for limit in [None, Some(512 * 1024), Some(1024 * 1024), Some(u64::MAX)] {
        let mut before = text.len() as u64;
        let mut restored = String::new();
        let mut pages = 0;
        loop {
            let page = get_planning_output(id.clone(), "planner".into(), 0, true, Some(before), limit, &service).unwrap();
            let start = page["startOffset"].as_u64().unwrap();
            assert!(start < before, "a long JSONL record must not produce a non-progressing tail");
            assert_eq!(page["nextOffset"].as_u64().unwrap(), before);
            let content = page["content"].as_str().unwrap();
            assert_eq!(content.as_bytes(), &text.as_bytes()[start as usize..before as usize]);
            assert!(content.len() <= 1024 * 1024 + 256 * 1024, "tail limit includes bounded look-behind, not full history");
            restored.insert_str(0, content);
            pages += 1;
            if start == 0 { break; }
            before = start;
        }
        assert!(pages > 1);
        assert_eq!(restored, text);
    }
    let forward = get_planning_output(id.clone(), "planner".into(), 0, false, None, Some(u64::MAX), &service).unwrap();
    assert!(forward["content"].as_str().unwrap().len() <= 256 * 1024, "live forward reads remain capped");
    let initial = get_planning_output(id.clone(), "planner".into(), 0, true, None, Some(512 * 1024), &service).unwrap();
    assert!(initial["content"].as_str().unwrap().len() >= 512 * 1024 - 4);
    let larger = get_planning_output(id, "planner".into(), 0, true, None, Some(1024 * 1024), &service).unwrap();
    assert!(larger["content"].as_str().unwrap().len() > initial["content"].as_str().unwrap().len());
}
