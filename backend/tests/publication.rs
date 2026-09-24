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
    assert!(graph_merge::merge_graph(&source, &heads, || panic!("Not a conflict")).is_err());
    assert_eq!(
        fs::read_to_string(source.join("user.txt")).unwrap(),
        "user work"
    );
    assert!(source.join("delete.txt").exists());
    fs::remove_file(source.join("user.txt")).unwrap();
    let published =
        graph_merge::merge_graph(&source, &heads, || panic!("No conflict expected")).unwrap();
    assert!(!source.join("delete.txt").exists());
    assert_eq!(
        fs::read_to_string(source.join("shared.txt")).unwrap(),
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
        fs::read_to_string(source.join("shared.txt")).unwrap(),
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
            repository: source.to_string_lossy().into(),
            engine: "pi".into(),
            pi_command: "/bin/sh".into(),
            pi_args: vec![script.to_string_lossy().into()],
            model: String::new(),
            thinking_level: "medium".into(),
            max_parallel: 2,
            max_feedback: 1,
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
        assert!(fs::read_to_string(session.join("system-prompt.md"))
            .unwrap()
            .starts_with("User query:\nCombine results"));
        assert!(!source.join(".git").exists());
        assert!(!source.join("mergers").exists());
        assert_eq!(
            fs::read_to_string(source.join("shared.txt")).unwrap(),
            "ours\ntheirs\n"
        );
    }
}
