use super::*;

#[cfg(feature = "fixture")]
#[test]
fn batch_regression_source_prerequisite_retry_keeps_its_directory_and_refreshes_only_unstarted_peers() {
    for restart in [false, true] {
        let (_temp, source, mut runtime) = adaptive(false,
            graph(&["a", "b", "a1", "a2", "a3", "a4", "b1"],
                &[("a", "a1"), ("a", "a2"), ("a", "a3"), ("a", "a4"), ("b", "b1")]), true, 4);
        let roots = runtime.jobs().unwrap();
        let failed = roots.iter().find(|j| j.execution.node == "b").unwrap().execution.clone();
        finish_shared(&mut runtime, roots.iter().find(|j| j.execution.node == "a").unwrap(), "done");
        fs::write(source.join("b.txt"), "unfinished source work").unwrap();
        runtime.finish(&failed, Err("provider failed".into())).unwrap();
        let mut children = runtime.jobs().unwrap();
        assert_eq!(children.len(), 4);
        for child in &mut children { prepare_private(&mut runtime, child); }
        for child in &children[..3] {
            finish_private(&mut runtime, child, &format!("{}.txt", child.execution.node), "done");
        }
        let old_baseline = runtime.latest_source_head().to_owned();
        runtime.resume_node("b").unwrap();
        assert!(runtime.jobs().unwrap().is_empty(), "source recovery must first drain private writers");
        assert!(runtime.state.publication.is_none());
        finish_private(&mut runtime, &children[3], "a4.txt", "done");
        if restart {
            let root = runtime.root.clone();
            drop(runtime);
            runtime = Runtime::open(&root).unwrap();
            runtime.resume_scheduling().unwrap();
        }
        let recovery = runtime.jobs().unwrap();
        assert_eq!(recovery.len(), 1, "a required source retry must not be filtered out by the private batch");
        let mut recovery = recovery[0].clone();
        assert_eq!(recovery.execution.node, "b");
        assert!(recovery.source_direct);
        assert_eq!(recovery.execution.worktree, failed.worktree);
        assert_eq!(recovery.execution.session_id, failed.session_id);
        assert!(recovery.session_fork.is_none());
        assert!(runtime.state.publication.is_none());
        assert!(!source.join("a1.txt").exists());
        if restart {
            runtime.finish(&recovery.execution, Err("source retry failed again".into())).unwrap();
            assert!(runtime.jobs().unwrap().is_empty());
            assert!(runtime.state.publication.is_none());
            let root = runtime.root.clone();
            drop(runtime);
            runtime = Runtime::open(&root).unwrap();
            runtime.resume_node("b").unwrap();
            recovery = runtime.jobs().unwrap().remove(0);
            assert!(recovery.source_direct);
            assert_eq!(recovery.execution.worktree, failed.worktree);
            assert_eq!(recovery.execution.session_id, failed.session_id);
        }
        fs::write(source.join("b.txt"), "completed source work").unwrap();
        finish_shared(&mut runtime, &recovery, "done");
        let mut last = runtime.jobs().unwrap().remove(0);
        assert_eq!(last.execution.node, "b1");
        assert!(!last.source_direct);
        prepare_private(&mut runtime, &mut last);
        assert_ne!(last.expected_source_head, old_baseline);
        assert_eq!(fs::read_to_string(Path::new(&last.execution.worktree).join("b.txt")).unwrap(), "completed source work");
        for old in &children {
            assert_eq!(fs::read_to_string(Path::new(&old.execution.worktree).join("b.txt")).unwrap(), "unfinished source work",
                "prepared private views must not be reset by source recovery");
        }
        finish_private(&mut runtime, &last, "b1.txt", "done");
        assert!(runtime.jobs().unwrap().is_empty());
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads.len(), 5);
        deliver_batch(&mut runtime);
        runtime.jobs().unwrap();
        assert_eq!(runtime.state.phase, "completed");
        assert_eq!(fs::read_to_string(source.join("b.txt")).unwrap(), "completed source work");
        assert!(source.join("a1.txt").exists() && source.join("b1.txt").exists());
        assert_eq!(runtime.state.events.iter().filter(|event|
            matches!(event.kind, EventKind::PublicationCompleted { .. })).count(), 1);
    }
}

#[cfg(feature = "fixture")]
#[test]
fn batch_regression_unrelated_revision_preserves_undelivered_members_across_restart() {
    for (restart, manual) in [(false, false), (true, false), (true, true)] {
        let (_temp, source, mut runtime) = adaptive(false,
            graph(&["a", "b", "c", "d", "e", "f"], &[]), true, 4);
        let mut first = runtime.jobs().unwrap();
        for job in &mut first {
            prepare_private(&mut runtime, job);
            finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
        }
        if manual {
            runtime.add_manual_node(ManualNodeRequest {
                node: Node { name: "z".into(), task: "z".into() }, from: None, to: None,
                feedback: false, confirmed_completed: vec![],
            }).unwrap();
        } else {
            runtime.revise_graph(graph(&["a", "b", "c", "d", "e", "f", "z"], &[]), PlanningSummary::default()).unwrap();
        }
        if restart {
            let root = runtime.root.clone();
            drop(runtime);
            runtime = Runtime::open(&root).unwrap();
            runtime.resume_scheduling().unwrap();
        }
        let mut remaining = runtime.jobs().unwrap();
        assert!(runtime.state.publication.is_none(), "an unrelated edit cannot release half a private batch");
        assert_eq!(remaining.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), ["e", "f", "z"]);
        assert_eq!(runtime.state.private_batch.len(), 7);
        for job in &mut remaining {
            assert!(!job.source_direct);
            prepare_private(&mut runtime, job);
            finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
        }
        assert!(!source.join("a.txt").exists());
        runtime.jobs().unwrap();
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads.len(), 7);
        deliver_batch(&mut runtime);
        runtime.jobs().unwrap();
        assert_eq!(runtime.state.phase, "completed");
        assert_eq!(runtime.state.executions.len(), 7, "unrelated edits must not rerun completed members");
    }
}

#[cfg(feature = "fixture")]
#[test]
fn batch_regression_revision_reconciles_removed_members_and_new_prerequisites() {
    for add_parent in [false, true] {
        let (_temp, source, mut runtime) = adaptive(false,
            graph(&["a", "b", "c", "d", "e", "f"], &[]), true, 4);
        let mut first = runtime.jobs().unwrap();
        for job in &mut first {
            prepare_private(&mut runtime, job);
            finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
        }
        let revised = if add_parent { graph(&["a", "b", "c", "d", "e", "f", "g"], &[("g", "e")]) }
            else { graph(&["a", "b", "c", "d", "e"], &[]) };
        runtime.revise_graph(revised, PlanningSummary::default()).unwrap();
        let mut next = runtime.jobs().unwrap();
        assert!(runtime.state.publication.is_none());
        assert_eq!(next.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(),
            if add_parent { vec!["f", "g"] } else { vec!["e"] });
        for job in &mut next {
            assert!(!job.source_direct);
            prepare_private(&mut runtime, job);
            finish_private(&mut runtime, job, &format!("{}.txt", job.execution.node), "done");
        }
        if add_parent {
            let mut child = runtime.jobs().unwrap().remove(0);
            assert_eq!(child.execution.node, "e");
            assert!(runtime.state.publication.is_none());
            prepare_private(&mut runtime, &mut child);
            assert!(Path::new(&child.execution.worktree).join("g.txt").exists());
            finish_private(&mut runtime, &child, "e.txt", "done");
        }
        assert!(!source.join("a.txt").exists());
        runtime.jobs().unwrap();
        assert_eq!(runtime.state.publication.as_ref().unwrap().heads.len(), if add_parent { 7 } else { 5 });
        deliver_batch(&mut runtime);
        runtime.jobs().unwrap();
        assert_eq!(runtime.state.phase, "completed");
    }
}

#[test]
fn batch_regression_source_recovery_requires_recorded_source_ownership_not_a_path_alias() {
    let (_temp, source, mut runtime) = adaptive(false, graph(&["a", "b", "c", "d"], &[]), true, 4);
    let jobs = runtime.jobs().unwrap();
    runtime.finish(&jobs[0].execution, Err("provider failed".into())).unwrap();
    runtime.resume_node("a").unwrap();
    runtime.state.executions[0].worktree = source.to_string_lossy().into();
    assert!(!runtime.source_batch_recovery("a"), "a private attempt cannot gain source access through an aliased path");
}

#[test]
fn batch_regression_shared_ready_groups_are_not_filtered_by_private_topology() {
    let (_temp, _source, mut runtime) = adaptive(false,
        graph(&["a", "b", "c", "d"], &[("a", "c"), ("a", "d")]), true, 4);
    let roots = runtime.jobs().unwrap();
    finish_shared(&mut runtime, roots.iter().find(|j| j.execution.node == "a").unwrap(), "done");
    runtime.finish(&roots.iter().find(|j| j.execution.node == "b").unwrap().execution, Err("provider failed".into())).unwrap();
    runtime.resume_node("b").unwrap();
    let jobs = runtime.jobs().unwrap();
    assert_eq!(jobs.iter().map(|job| job.execution.node.as_str()).collect::<Vec<_>>(), ["b", "c", "d"]);
    assert!(jobs.iter().all(|job| job.source_direct));
    assert!(runtime.state.private_batch.is_empty());
}
