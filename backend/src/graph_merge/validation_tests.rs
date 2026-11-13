use super::*;
use crate::{
    engine::PiRole,
    graph_merge::{continue_merger_for_node, resolve_with_merger_for_node, MergerConflicts},
    model::{now, Config, EventKind, Graph, Node},
    runtime::Runtime,
    workspace,
};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;
use uuid::Uuid;

const SCRIPT_HEADER: &str = r#"set -eu
session_dir= session_id=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-dir) session_dir="$2"; shift ;;
    --session-id) session_id="$2"; shift ;;
  esac
  shift
done
printf '%s\n' "$session_id" >> "$session_dir/calls.txt"
turn=$(wc -l < "$session_dir/calls.txt" | tr -d ' ')
cat > "$session_dir/prompt-$turn.txt"
"#;
const SCRIPT_END: &str = r#"
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"repair turn finished"}]}}'
"#;

fn script(path: &Path, body: &str) {
    fs::write(path, format!("{SCRIPT_HEADER}\n{body}\n{SCRIPT_END}")).unwrap();
}

fn config(source: &Path, script: &Path) -> Config {
    serde_json::from_value(serde_json::json!({
        "repository": source, "piCommand": "/bin/sh", "piArgs": [script],
        "model": "fixture", "maxParallel": 1, "postTaskReview": false,
    }))
    .unwrap()
}

struct Fixture {
    _temp: TempDir,
    source: PathBuf,
    target: PathBuf,
    parents: Vec<String>,
    script: PathBuf,
    config: Config,
    runtime: Runtime,
}

impl Fixture {
    fn new(plain: bool, body: &str) -> Self {
        crate::ensure_test_data_root();
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("registry.jsonl"), "base\n").unwrap();
        fs::write(source.join("attempts.sqlite3"), b"SQLite format 3\0base").unwrap();
        if !plain {
            workspace::git(&source, &["init", "-q"]).unwrap();
        }
        let base = workspace::snapshot_repository(&source).unwrap();
        let slot = |name: &str| temp.path().join(".grapher-worktrees/run").join(name);
        let mut parents = Vec::new();
        for label in ["left", "right"] {
            let path = slot(label);
            workspace::prepare(&source, &path, &base, &[]).unwrap();
            fs::write(path.join("registry.jsonl"), format!("{label}\n")).unwrap();
            fs::write(
                path.join("attempts.sqlite3"),
                format!("SQLite format 3\0{label}"),
            )
            .unwrap();
            parents.push(workspace::snapshot_node(&path, &source, label).unwrap());
        }
        let target = slot("join");
        assert!(workspace::prepare(&source, &target, &base, &parents).is_err());
        let script_path = temp.path().join("merger.sh");
        script(&script_path, body);
        let config = config(&source, &script_path);
        let mut runtime = Runtime::open(&temp.path().join("runtime")).unwrap();
        runtime.state.run_id = Uuid::new_v4().to_string();
        runtime
            .emit(EventKind::Created {
                graph: Graph {
                    original_goal: "combine both results".into(),
                    nodes: vec![Node {
                        name: "join".into(),
                        task: "combine".into(),
                    }],
                    edges: vec![],
                },
                config: config.clone(),
                planning_id: None,
                planning: None,
            })
            .unwrap();
        runtime.emit(EventKind::Approved { base }).unwrap();
        Self {
            _temp: temp,
            source,
            target,
            parents,
            script: script_path,
            config,
            runtime,
        }
    }

    fn resolve(&mut self) -> Result<(), String> {
        let root = self.runtime.root.clone();
        resolve_with_merger_for_node(
            &self.target,
            "combine both results",
            &self.config,
            &root,
            1,
            "merge:join",
            MergerConflicts::GIT,
            |event| self.runtime.emit(event),
        )
    }

    fn session(&self) -> PathBuf {
        self.runtime
            .root
            .join("mergers")
            .join(&self.runtime.state.mergers[0].session_id)
    }

    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.session().join("calls.txt"))
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn assert_resolved(&self) {
        assert!(workspace::git(&self.target, &["ls-files", "-u"])
            .unwrap()
            .is_empty());
        for parent in &self.parents {
            workspace::verify_prepared_ancestor(&self.target, parent).unwrap();
        }
        assert_eq!(
            fs::read(self.target.join("registry.jsonl")).unwrap(),
            b"left\nright\n"
        );
        assert_eq!(
            fs::read(self.target.join("attempts.sqlite3")).unwrap(),
            b"SQLite format 3\0left+right"
        );
        assert_eq!(
            fs::read(self.source.join("registry.jsonl")).unwrap(),
            b"base\n"
        );
        assert_eq!(
            fs::read(self.source.join("attempts.sqlite3")).unwrap(),
            b"SQLite format 3\0base"
        );
    }
}

#[test]
fn validation_feedback_repairs_plain_binary_and_git_conflicts_in_same_execution() {
    for plain in [true, false] {
        let mut fixture = Fixture::new(
            plain,
            r#"
if [ "$turn" -eq 1 ]; then
  test -n "$(git ls-files -u)"
  printf 'left\nright\n' > registry.jsonl
  git add -f -- registry.jsonl
else
  test "$turn" -eq 2
  grep -q 'attempts.sqlite3' "$session_dir/prompt-$turn.txt"
  grep -q 'Merge validation failed:' "$session_dir/prompt-$turn.txt"
  printf 'SQLite format 3\000left+right' > attempts.sqlite3
  git add -f -- attempts.sqlite3
  test -z "$(git ls-files -u)"
  git diff --cached --check
fi
"#,
        );
        fixture.resolve().unwrap();
        fixture.assert_resolved();
        assert_eq!(fixture.target.join(".git").exists(), !plain);
        let calls = fixture.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], calls[1]);
        assert_eq!(fixture.runtime.state.mergers.len(), 1);
        assert_eq!(fixture.runtime.state.mergers[0].status, "completed");
        assert!(!fixture
            .runtime
            .state
            .events
            .iter()
            .any(|event| matches!(event.kind, EventKind::MergerFailed { .. })));
        let output = fs::read_to_string(fixture.session().join("output.jsonl")).unwrap();
        assert!(output.contains("Merger validation failed; requesting repair 1/3"));
        let prompt = fs::read_to_string(fixture.session().join("system-prompt.md")).unwrap();
        assert!(prompt.contains("even if .git is absent"));
        assert!(prompt.contains("git ls-files -u"));
        assert!(prompt.contains("git diff --cached --check"));
        let feedback = fs::read_to_string(fixture.session().join("prompt-2.txt")).unwrap();
        assert!(feedback.starts_with("Merge validation failed:\n\n"));
        assert!(feedback.ends_with("Fix the remaining issue and rerun the Git checks."));
        assert!(!feedback.contains("<workspace_objective>"));
        assert!(
            !feedback.contains("git ls-files -u"),
            "feedback should not repeat the checklist"
        );
        let replay = fixture
            .runtime
            .store
            .load(&fixture.runtime.state.run_id)
            .unwrap();
        assert_eq!(replay.mergers.len(), 1);
        assert_eq!(replay.mergers[0].status, "completed");
    }
}

#[test]
fn plain_binary_can_be_explicitly_staged_without_a_meaningless_rewrite() {
    let mut fixture = Fixture::new(
        true,
        r#"
printf 'left\nright\n' > registry.jsonl
git add -f -- registry.jsonl
# Deliberate keep-ours resolution of the binary file; no rewrite/touch.
git add -f -- attempts.sqlite3
test -z "$(git ls-files -u)"
git diff --cached --check
"#,
    );
    let file = fixture.target.join("attempts.sqlite3");
    let original = fs::read(&file).unwrap();
    let modified = fs::metadata(&file).unwrap().modified().unwrap();
    fixture.resolve().unwrap();
    assert_eq!(fixture.calls().len(), 1);
    assert_eq!(fs::read(&file).unwrap(), original);
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), modified);
    assert!(!fixture.target.join(".git").exists());
    for parent in &fixture.parents {
        workspace::verify_prepared_ancestor(&fixture.target, parent).unwrap();
    }
}

#[test]
fn cleared_index_entries_and_staged_markers_do_not_manufacture_completion() {
    for (command, expected) in [
        (
            "git reset -- registry.jsonl",
            "does not match its staged resolution",
        ),
        ("git add -f -- registry.jsonl", "git diff --cached --check"),
    ] {
        let mut fixture = Fixture::new(true, &format!("{command}\ngit add -f -- attempts.sqlite3"));
        let before = workspace::git(&fixture.target, &["rev-parse", "HEAD"]).unwrap();
        let incoming = workspace::git(&fixture.target, &["rev-parse", "MERGE_HEAD"]).unwrap();
        let error = fixture.resolve().unwrap_err();
        assert!(error.contains(expected), "{error}");
        assert_eq!(fixture.calls().len(), MAX_REPAIR_TURNS + 1);
        assert_eq!(
            workspace::git(&fixture.target, &["rev-parse", "HEAD"]).unwrap(),
            before
        );
        assert!(fs::read_to_string(fixture.target.join("registry.jsonl"))
            .unwrap()
            .contains("<<<<<<<"));
        assert_eq!(
            fs::read(fixture.source.join("registry.jsonl")).unwrap(),
            b"base\n"
        );
        assert_eq!(fixture.runtime.state.mergers[0].status, "failed");
        let replay = fixture
            .runtime
            .store
            .load(&fixture.runtime.state.run_id)
            .unwrap();
        assert_eq!(replay.mergers[0].status, "failed");
        // A later publication retry must recheck a pending merge even when
        // the model has cleared all U entries. It cannot commit these markers.
        let error =
            crate::graph_merge::finish_merge(&fixture.target, &incoming, &[], true).unwrap_err();
        assert!(error.contains("git diff --cached --check"), "{error}");
        assert_eq!(
            workspace::git(&fixture.target, &["rev-parse", "HEAD"]).unwrap(),
            before
        );
    }
}

#[test]
fn index_reset_rejection_can_be_repaired_in_the_same_session() {
    let mut fixture = Fixture::new(
        true,
        r#"
if [ "$turn" -eq 1 ]; then
  git reset -- registry.jsonl
  git add -f -- attempts.sqlite3
else
  grep -q 'does not match its staged resolution' "$session_dir/prompt-$turn.txt"
  printf 'left\nright\n' > registry.jsonl
  printf 'SQLite format 3\000left+right' > attempts.sqlite3
  git add -f -- registry.jsonl attempts.sqlite3
fi
"#,
    );
    fixture.resolve().unwrap();
    fixture.assert_resolved();
    assert_eq!(fixture.calls().len(), 2);
    assert_eq!(fixture.calls()[0], fixture.calls()[1]);
}

#[test]
fn exhausted_validation_retains_conflicts_and_continuation_repairs_after_restart() {
    let mut fixture = Fixture::new(true, ":");
    let error = fixture.resolve().unwrap_err();
    assert!(error.contains("after 3 repair turns"));
    assert!(error.contains("attempts.sqlite3"));
    assert_eq!(fixture.calls().len(), MAX_REPAIR_TURNS + 1);
    assert!(!workspace::git(&fixture.target, &["ls-files", "-u"])
        .unwrap()
        .is_empty());
    assert_eq!(fixture.runtime.state.mergers[0].status, "failed");
    let root = fixture.runtime.root.clone();
    let run = fixture.runtime.state.run_id.clone();
    drop(fixture.runtime);
    fixture.runtime = Runtime::open(&root).unwrap().open_run(&run).unwrap();
    let previous = fixture.runtime.state.mergers[0].clone();
    assert_eq!(previous.status, "failed");
    assert!(previous.output_bytes > 0);
    script(
        &fixture.script,
        r#"
if grep -q 'repair after restart' "$session_dir/prompt-$turn.txt"; then
  printf 'left\nright\n' > registry.jsonl
  git add -f -- registry.jsonl
else
  grep -q 'attempts.sqlite3' "$session_dir/prompt-$turn.txt"
  printf 'SQLite format 3\000left+right' > attempts.sqlite3
  git add -f -- attempts.sqlite3
  test -z "$(git ls-files -u)"
  git diff --cached --check
fi
"#,
    );
    let execution = crate::model::Execution {
        id: Uuid::new_v4().to_string(),
        before: workspace::git(&fixture.target, &["rev-parse", "HEAD"]).unwrap(),
        attempt: previous.attempt + 1,
        status: "running".into(),
        completed_at: None,
        started_at: now(),
        output: String::new(),
        output_bytes: 0,
        ..previous.clone()
    };
    fixture
        .runtime
        .emit(EventKind::MergerStarted {
            execution: execution.clone(),
        })
        .unwrap();
    let session = fixture.session();
    continue_merger_for_node(
        &previous,
        &execution,
        "repair after restart",
        None,
        &fixture.config,
        &session,
        |event| fixture.runtime.emit(event),
    )
    .unwrap();
    fixture.assert_resolved();
    let calls = fixture.calls();
    assert_eq!(calls.len(), MAX_REPAIR_TURNS + 3);
    assert!(calls.iter().all(|id| id == &previous.session_id));
    let replay = fixture.runtime.store.load(&run).unwrap();
    assert_eq!(replay.mergers.len(), 2);
    assert_eq!(replay.mergers[0].status, "failed");
    assert_eq!(replay.mergers[1].status, "completed");
}

fn simple_turn(
    body: &str,
    output: impl FnMut(String) -> Result<(), String>,
    validate: impl FnMut() -> Result<(), ResolutionError>,
) -> (Result<(), String>, usize) {
    let temp = TempDir::new().unwrap();
    let script_path = temp.path().join("merger.sh");
    script(&script_path, body);
    let config = config(temp.path(), &script_path);
    let session = temp.path().join("session");
    let id = Uuid::new_v4().to_string();
    let result = run_validated_merger(
        PiRequest {
            role: PiRole::Merger,
            config: &config,
            cwd: temp.path(),
            task: "repair",
            session_dir: &session,
            extension: None,
            tools: Some("read,write,bash,edit"),
            session_id: Some(&id),
            extra_args: vec![],
            environment: vec![],
            system_prompt: None,
            images: None,
        },
        output,
        validate,
    );
    let count = fs::read_to_string(session.join("calls.txt"))
        .unwrap()
        .lines()
        .count();
    (result, count)
}

#[test]
fn provider_failure_is_not_retried_or_validated() {
    let (result, count) = simple_turn(
        "exit 23",
        |_| Ok(()),
        || panic!("failed model cannot validate"),
    );
    assert!(result.is_err());
    assert_eq!(count, 1);
}

#[test]
fn infrastructure_validation_error_is_not_sent_back_to_model() {
    let (result, count) = simple_turn(
        ":",
        |_| Ok(()),
        || Err(ResolutionError::Fatal("repository unavailable".into())),
    );
    assert_eq!(result.unwrap_err(), "repository unavailable");
    assert_eq!(count, 1);
}

#[test]
fn output_failure_is_not_retried_or_validated() {
    let (result, count) = simple_turn(
        ":",
        |_| Err("log unavailable".into()),
        || panic!("unlogged turn cannot validate"),
    );
    assert!(result
        .unwrap_err()
        .contains("Cannot persist merger output: log unavailable"));
    assert_eq!(count, 1);
}

#[test]
fn feedback_log_failure_does_not_start_another_turn() {
    let (result, count) = simple_turn(
        ":",
        |text| {
            if text.contains("requesting repair") {
                Err("log unavailable".into())
            } else {
                Ok(())
            }
        },
        || Err(ResolutionError::Repair("still unresolved".into())),
    );
    assert!(result
        .unwrap_err()
        .contains("Cannot persist merger output: log unavailable"));
    assert_eq!(count, 1);
}

#[test]
fn file_log_failure_still_persists_event_output_and_stops_the_turn() {
    struct FailedLog;
    impl std::io::Write for FailedLog {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("session log unavailable"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut event_log = String::new();
    let (result, count) = simple_turn(
        ":",
        |text| {
            persist_output(&mut FailedLog, text, |text| {
                event_log.push_str(&text);
                Ok(())
            })
        },
        || panic!("a persistence failure must prevent validation"),
    );
    assert!(result.unwrap_err().contains("session log unavailable"));
    assert!(
        event_log.contains("repair turn finished"),
        "the surviving sink must retain model output"
    );
    assert_eq!(count, 1);

    let mut file_log = Vec::new();
    assert!(persist_output(&mut file_log, "retained".into(), |_| Err(
        "database unavailable".into()
    ))
    .is_err());
    assert_eq!(file_log, b"retained");
    let error = persist_output(&mut FailedLog, "output".into(), |_| {
        Err("database unavailable".into())
    })
    .unwrap_err();
    assert!(error.contains("session log unavailable") && error.contains("database unavailable"));
}

#[test]
fn run_wide_cancel_between_turns_blocks_respawn_without_poisoning_explicit_retry() {
    let run = Uuid::new_v4().to_string();
    for owner in [
        run.clone(),
        crate::process_control::execution_owner(&run, "join", "attempt"),
    ] {
        crate::process_control::with_owner(&owner, || {
            let (result, count) = simple_turn(
                ":",
                |text| {
                    if text.contains("requesting repair") {
                        // Use the actual run-wide Stop path, not stop_owner.
                        crate::engine::terminate_run(&run);
                    }
                    Ok(())
                },
                || Err(ResolutionError::Repair("still unresolved".into())),
            );
            assert!(result.unwrap_err().contains("cancelled by user"));
            assert_eq!(count, 1);
            let (retry, count) = simple_turn(":", |_| Ok(()), || Ok(()));
            retry.unwrap();
            assert_eq!(count, 1);
        });
    }
}

#[test]
fn run_wide_cancel_during_validation_cannot_report_completion() {
    let run = Uuid::new_v4().to_string();
    crate::process_control::with_owner(&run, || {
        let (result, count) = simple_turn(
            ":",
            |_| Ok(()),
            || {
                crate::engine::terminate_run(&run);
                Ok(())
            },
        );
        assert!(result.unwrap_err().contains("cancelled by user"));
        assert_eq!(count, 1);
    });
}

#[test]
fn cancellation_between_validation_turns_does_not_respawn() {
    let owner = Uuid::new_v4().to_string();
    let (result, count) = crate::process_control::with_owner(&owner, || {
        simple_turn(
            ":",
            |_| Ok(()),
            || {
                crate::process_control::stop_owner(&owner).unwrap();
                Err(ResolutionError::Repair("still unresolved".into()))
            },
        )
    });
    crate::process_control::clear_owner_stop(&owner);
    assert!(result.unwrap_err().contains("paused by user"));
    assert_eq!(count, 1);
}
