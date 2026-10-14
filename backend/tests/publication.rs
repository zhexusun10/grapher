use grapher::{graph_merge, workspace};
use std::{fs, path::Path};
use tempfile::TempDir;

fn branch(source: &Path, base: &str, path: &Path, file: &str, content: &str) -> String {
    workspace::prepare(source, path, base, &[]).unwrap();
    fs::write(path.join(file), content).unwrap();
    workspace::snapshot_node(
        path,
        source,
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("node"),
    )
    .unwrap()
}

#[test]
fn concurrent_source_edit_of_node_file_is_not_discarded_on_conflict_or_retry() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    workspace::git(&source, &["init", "-q"]).unwrap();
    fs::write(source.join("shared.txt"), "BASE\n").unwrap();
    let base = workspace::snapshot_repository(&source).unwrap();
    let head = branch(&source, &base, &temp.path().join("node"), "shared.txt", "NODE\n");
    fs::write(source.join("shared.txt"), "USER\n").unwrap();
    let heads = [head];
    let result = graph_merge::merge_graph(&source, &heads, || {
        // Source work was committed before the node merge, not overwritten.
        assert_eq!(workspace::git(&source, &["show", "HEAD:shared.txt"])?, "USER");
        assert!(workspace::git(&source, &["diff", "--name-only", "--diff-filter=U"])?.contains("shared.txt"));
        Err("explicit conflict; keep for retry".into())
    });
    assert!(result.is_err());
    assert!(fs::read_to_string(source.join("shared.txt")).unwrap().contains("USER"));
    graph_merge::merge_graph(&source, &heads, || {
        fs::write(source.join("shared.txt"), "USER\nNODE\n").unwrap();
        workspace::git(&source, &["add", "shared.txt"])?;
        Ok(())
    }).unwrap();
    assert_eq!(fs::read_to_string(source.join("shared.txt")).unwrap().replace("\r\n", "\n"), "USER\nNODE\n");
    workspace::git(&source, &["merge-base", "--is-ancestor", &heads[0], "HEAD"]).unwrap();
    assert!(workspace::git(&source, &["status", "--porcelain"]).unwrap().is_empty());
}

#[test]
fn plain_folder_publication_changes_deletions_conflict_retry_and_no_git_pollution() {
    let temp = TempDir::new().unwrap();
    std::env::set_var("GRAPHER_DATA_DIR", temp.path().join("runtime"));
    let source = temp.path().join("plain folder");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("shared.txt"), "original\n").unwrap();
    fs::write(source.join("delete.txt"), "remove me").unwrap();
    fs::write(source.join("unchanged.txt"), "keep me").unwrap();
    let base = workspace::verify(&source).unwrap();
    let a_dir = temp.path().join("a");
    workspace::prepare(&source, &a_dir, &base, &[]).unwrap();
    fs::remove_file(a_dir.join("delete.txt")).unwrap();
    fs::write(a_dir.join("new.txt"), "new").unwrap();
    let a = workspace::snapshot_node(&a_dir, &source, "a").unwrap();
    let b = branch(
        &source,
        &base,
        &temp.path().join("b"),
        "shared.txt",
        "updated\n",
    );
    let heads = [a, b];
    fs::write(source.join("user.txt"), "user work").unwrap();
    // User edits are always accepted: publication commits them as the base
    // and merges node results on top instead of rejecting the directory.
    let published =
        graph_merge::merge_graph(&source, &heads, || panic!("No conflict expected")).unwrap();
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "user work"
    );
    assert!(!source.join("delete.txt").exists());
    assert_eq!(
        fs::read_to_string(source.join("shared.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "updated\n"
    );
    assert_eq!(fs::read_to_string(source.join("new.txt")).unwrap(), "new");
    assert_eq!(
        fs::read_to_string(source.join("unchanged.txt")).unwrap(),
        "keep me"
    );
    assert_eq!(
        published,
        graph_merge::merge_graph(&source, &heads, || panic!()).unwrap()
    );

    let c = branch(
        &source,
        &published,
        &temp.path().join("c"),
        "shared.txt",
        "left\n",
    );
    let d = branch(
        &source,
        &published,
        &temp.path().join("d"),
        "shared.txt",
        "right\n",
    );
    let e = branch(
        &source,
        &published,
        &temp.path().join("e"),
        "last.txt",
        "last\n",
    );
    let heads = [c, d, e];
    assert!(
        graph_merge::merge_graph(&source, &heads, || Err("interrupted merger".into())).is_err()
    );
    assert!(
        !workspace::repository_git(&source, &["diff", "--name-only", "--diff-filter=U"])
            .unwrap()
            .is_empty()
    );
    let mut resolutions = 0;
    graph_merge::merge_graph(&source, &heads, || {
        resolutions += 1;
        fs::write(source.join("shared.txt"), "left\nright\n").unwrap();
        workspace::repository_git(&source, &["add", "shared.txt"])?;
        Ok(()) // Host commits the pending merge, even on retry.
    })
    .unwrap();
    assert_eq!(resolutions, 1);
    assert_eq!(
        fs::read_to_string(source.join("shared.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "left\nright\n"
    );
    assert!(source.join("last.txt").exists());
    assert!(!source.join(".git").exists());
    assert!(!source.join("mergers").exists());
    assert!(
        workspace::repository_git(&source, &["status", "--porcelain"])
            .unwrap()
            .is_empty()
    );

    // This merger fixture uses /bin/sh. The cross-platform publication path
    // above runs on Windows; a native Windows merger needs its own shell-free probe.
    #[cfg(all(feature = "fixture", unix))]
    {
        use grapher::model::{Config, EventKind};
        let base = workspace::repository_git(&source, &["rev-parse", "HEAD"]).unwrap();
        let f = branch(
            &source,
            &base,
            &temp.path().join("f"),
            "shared.txt",
            "ours\n",
        );
        let g = branch(
            &source,
            &base,
            &temp.path().join("g"),
            "shared.txt",
            "theirs\n",
        );
        let script = temp.path().join("merger.sh");
        fs::write(&script, r#"set -eu
cat >/dev/null
test -n "$GIT_DIR"
test "$GIT_WORK_TREE" = "$PWD"
test ! -e .git
printf 'ours\ntheirs\n' > shared.txt
git add shared.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"resolved"}]}}'
"#).unwrap();
        let config = Config {
            environment: None,
            repository: source.to_string_lossy().into(),
            engine: "pi".into(),
            pi_command: "/bin/sh".into(),
            pi_args: vec![script.to_string_lossy().into()],
            model: String::new(),
            role_models: Default::default(),
            thinking_level: "medium".into(),
            max_parallel: 2,
            max_feedback: 1, auto_approve: false,
        };
        let runtime_root = temp.path().join("runtime");
        let mut events = Vec::new();
        graph_merge::merge_graph(&source, &[f, g], || {
            graph_merge::resolve_with_merger(
                &source,
                "Combine results",
                &config,
                &runtime_root,
                1,
                |event| {
                    events.push(event);
                    Ok(())
                },
            )
        })
        .unwrap();
        assert!(matches!(
            events.first(),
            Some(EventKind::MergerStarted { .. })
        ));
        assert!(events
            .iter()
            .any(|e| matches!(e, EventKind::Output { text, .. } if text.contains("resolved"))));
        assert!(matches!(
            events.last(),
            Some(EventKind::MergerFinished { .. })
        ));
        let execution = match &events[0] {
            EventKind::MergerStarted { execution } => execution,
            _ => unreachable!(),
        };
        let session = runtime_root.join("mergers").join(&execution.id);
        assert!(session.join("result.json").exists());
        let prompt = fs::read_to_string(session.join("system-prompt.md")).unwrap();
        assert!(prompt.starts_with("The Workspace Objective below is ONLY to help you decide"));
        assert!(prompt.contains("\n\nWorkspace Objective:\n<workspace_objective>\nCombine results\n</workspace_objective>\n\n"));
        assert!(prompt.contains("Your sole responsibility is Git conflict repair"));
        assert!(!source.join(".git").exists());
        assert!(!source.join("mergers").exists());
        assert_eq!(
            fs::read_to_string(source.join("shared.txt")).unwrap(),
            "ours\ntheirs\n"
        );
    }
}

#[cfg(feature = "fixture")]
#[test]
fn publication_merger_conversation_continues_a_pending_merge() {
    use grapher::model::{now, Config, EventKind, Execution};
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("publication repo");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("shared.txt"), "base\n").unwrap();
    workspace::git(&source, &["init", "-q"]).unwrap();
    workspace::repository_git(&source, &["add", "-A"]).unwrap();
    workspace::repository_git(&source, &["commit", "-qm", "base"]).unwrap();
    let base = workspace::repository_git(&source, &["rev-parse", "HEAD"]).unwrap();
    let left = branch(&source, &base, &temp.path().join("left"), "shared.txt", "left\n");
    let right = branch(&source, &base, &temp.path().join("right"), "shared.txt", "right\n");
    // The source directory keeps a real conflict pending for the conversation.
    assert!(graph_merge::merge_graph(&source, &[left, right], || {
        Err("interrupted merger".into())
    })
    .is_err());
    assert!(!workspace::repository_git(&source, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap()
        .is_empty());

    let script = temp.path().join("publication-continuation.sh");
    fs::write(
        &script,
        r#"set -eu
cat >/dev/null
printf 'left\nright\n' > shared.txt
git add shared.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"resolved"}]}}'
"#,
    )
    .unwrap();
    let config = Config {
        environment: None,
        repository: source.to_string_lossy().into(),
        engine: "pi".into(),
        pi_command: "/bin/sh".into(),
        pi_args: vec![script.to_string_lossy().into()],
        model: String::new(),
        role_models: Default::default(),
        thinking_level: "medium".into(),
        max_parallel: 1,
        max_feedback: 1,
        auto_approve: false,
    };
    let root = temp.path().join("runtime");
    let session_dir = root.join("mergers").join("publication-merger");
    fs::create_dir_all(&session_dir).unwrap();
    let worktree = source.canonicalize().unwrap().to_string_lossy().into_owned();
    let previous = Execution {
        id: "publication-merger".into(),
        node: "merger".into(),
        revision: 1,
        attempt: 1,
        session_id: "session-1".into(),
        worktree: worktree.clone(),
        before: base,
        workspace_lineage: vec![],
        after: None,
        input: None, result: None,
        status: "failed".into(),
        output: String::new(), output_bytes: 0, pid: None,
        started_at: now(),
        completed_at: Some(now()),
        metrics: None,
    };
    let execution = Execution {
        id: "continued-merger".into(),
        node: "merger".into(),
        revision: 1,
        attempt: 2,
        session_id: previous.session_id.clone(),
        worktree: worktree.clone(),
        before: workspace::repository_git(&source, &["rev-parse", "HEAD"]).unwrap(),
        workspace_lineage: vec![],
        after: None,
        input: None, result: None,
        status: "running".into(),
        output: String::new(), output_bytes: 0, pid: None,
        started_at: now(),
        completed_at: None,
        metrics: None,
    };
    let mut events = vec![EventKind::MergerStarted { execution: execution.clone() }];
    graph_merge::continue_merger_for_node(
        &previous,
        &execution,
        "resolve the conflict with both changes",
        None,
        &config,
        &session_dir,
        |event| {
            events.push(event);
            Ok(())
        },
    )
    .unwrap();
    assert!(matches!(
        events.last(),
        Some(EventKind::MergerFinished { execution_id, .. }) if execution_id == "continued-merger"
    ));
    assert!(events.iter().any(
        |e| matches!(e, EventKind::Output { execution_id, text } if execution_id == "continued-merger" && text.contains("resolved"))
    ));
    assert!(workspace::repository_git(&source, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap()
        .is_empty());
    assert!(workspace::repository_git(&source, &["status", "--porcelain"])
        .unwrap()
        .is_empty());
    assert_eq!(
        fs::read_to_string(source.join("shared.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "left\nright\n"
    );
}
