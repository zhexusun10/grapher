use grapher::{model::*, runtime::Runtime, workspace};
use std::{fs, path::Path};
use tempfile::TempDir;

fn config(source: &Path) -> Config {
    Config {
        repository: source.to_string_lossy().into(),
        model: String::new(),
        thinking_level: "medium".into(),
        max_parallel: 2,
        max_feedback: 1,
        #[cfg(feature = "fixture")]
        engine: "pi".into(),
        #[cfg(feature = "fixture")]
        pi_command: "node".into(),
        #[cfg(feature = "fixture")]
        pi_args: Vec::new(),
    }
}
fn source(root: &Path) -> (std::path::PathBuf, String) {
    let path = root.join("source");
    fs::create_dir(&path).unwrap();
    workspace::git(&path, &["init"]).unwrap();
    fs::write(path.join("file"), "initial").unwrap();
    let head = workspace::snapshot_repository(&path).unwrap();
    (path, head)
}

#[test]
fn publication_is_durable_before_completed_and_merger_does_not_mutate_a_node_named_merger() {
    let temp = TempDir::new().unwrap();
    let (source, head) = source(temp.path());
    let root = temp.path().join("runtime");
    let mut runtime = Runtime::open(&root).unwrap();
    runtime
        .create(
            Graph {
                original_goal: "Goal".into(),
                nodes: vec![
                    Node {
                        name: "merger".into(),
                        task: "A real graph node with this name".into(),
                    },
                    Node {
                        name: "other".into(),
                        task: "Another node".into(),
                    },
                ],
                edges: Vec::new(),
            },
            config(&source),
        )
        .unwrap();
    runtime.approve().unwrap();
    for job in runtime.jobs().unwrap() {
        runtime
            .finish(&job.execution, Ok((head.clone(), "done".into())))
            .unwrap();
    }
    assert!(runtime.jobs().unwrap().is_empty());
    assert_eq!(runtime.state.phase, "publishing");
    assert!(runtime.active());
    assert!(runtime.pause(true).is_err());
    assert!(runtime.intervene("other", "change").is_err());
    let id = runtime.state.run_id.clone();
    assert_eq!(runtime.store.load(&id).unwrap().phase, "publishing");
    let execution = Execution {
        id: "merger-execution".into(),
        node: "merger".into(),
        revision: 1,
        attempt: 1,
        session_id: "merger-session".into(),
        worktree: source.to_string_lossy().into(),
        before: head.clone(),
        after: None,
        status: "running".into(),
        output: String::new(),
        started_at: now(),
        completed_at: None,
    };
    runtime
        .emit(EventKind::MergerStarted { execution })
        .unwrap();
    runtime
        .emit(EventKind::Output {
            execution_id: "merger-execution".into(),
            text: "live output".into(),
        })
        .unwrap();
    assert_eq!(runtime.state.phase, "merging");
    assert_eq!(runtime.state.nodes["merger"].status, "done");
    assert_eq!(runtime.state.executions.len(), 2);
    assert_eq!(runtime.state.mergers[0].output, "live output");
    drop(runtime);

    // Restart never reports success or automatically re-enters the old session.
    let mut runtime = Runtime::open(&root).unwrap();
    assert_eq!(runtime.state.phase, "publication_failed");
    assert_eq!(runtime.state.mergers[0].status, "failed");
    assert!(!runtime.active());
    assert!(runtime
        .state
        .publication
        .as_ref()
        .unwrap()
        .error
        .as_ref()
        .unwrap()
        .contains("interrupted"));
    assert!(runtime.pause(false).is_err());
    let original_heads = runtime.state.publication.as_ref().unwrap().heads.clone();
    runtime.retry_publication().unwrap();
    assert_eq!(
        runtime.state.publication.as_ref().unwrap().heads,
        original_heads
    );
    assert_eq!(runtime.state.phase, "publishing");
    runtime
        .emit(EventKind::PublicationCompleted { head: head.clone() })
        .unwrap();
    assert_eq!(runtime.state.phase, "completed");
    assert_eq!(
        runtime.state.publication.as_ref().unwrap().head.as_ref(),
        Some(&head)
    );
    assert_eq!(runtime.store.load(&id).unwrap().phase, "completed");
    drop(runtime);
    assert_eq!(Runtime::open(&root).unwrap().state.phase, "completed");
}

#[test]
fn load_run_recovers_publication_and_serial_has_no_publication_step() {
    let temp = TempDir::new().unwrap();
    let (source, head) = source(temp.path());
    let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
    runtime
        .create(
            Graph {
                original_goal: "Serial".into(),
                nodes: vec![Node {
                    name: "task".into(),
                    task: "Work".into(),
                }],
                edges: Vec::new(),
            },
            config(&source),
        )
        .unwrap();
    runtime.approve().unwrap();
    let job = runtime.jobs().unwrap().remove(0);
    assert_eq!(job.execution.worktree, source.to_string_lossy());
    runtime
        .finish(&job.execution, Ok((head.clone(), "done".into())))
        .unwrap();
    runtime.jobs().unwrap();
    assert_eq!(runtime.state.phase, "completed");
    assert!(runtime.state.publication.is_none());
    runtime
        .emit(EventKind::PublicationStarted {
            repository: source.to_string_lossy().into(),
            heads: vec![head],
        })
        .unwrap();
    let run = runtime.state.run_id.clone();
    // Loading an interrupted stored run takes the same recovery path as startup.
    runtime.state = Snapshot::default();
    runtime.load_run(&run).unwrap();
    assert_eq!(runtime.state.phase, "publication_failed");
    assert!(runtime.state.publication.as_ref().unwrap().error.is_some());
}
