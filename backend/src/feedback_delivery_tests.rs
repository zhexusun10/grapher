use super::*;
use std::io::Write;

fn ready_rechecks() -> (TempDir, Runtime, Job, Job) {
    ready_rechecks_with_images(None)
}

fn ready_rechecks_with_images(images: Option<Vec<ImageAttachment>>) -> (TempDir, Runtime, Job, Job) {
    let (temp, _source, mut runtime) = configured(true);
    let (_, review, _) = invalidate(&mut runtime, false);
    let repair = runtime.jobs().unwrap().remove(0);
    finish(&mut runtime, &repair, "repaired");
    if images.is_some() {
        runtime.intervene_with_images("review", "Review this screenshot", images).unwrap();
    }
    let jobs = runtime.jobs().unwrap();
    let recheck = jobs
        .iter()
        .find(|job| job.execution.node == "review")
        .unwrap()
        .clone();
    for other in jobs.iter().filter(|job| job.execution.node != "review") {
        finish(&mut runtime, other, "done");
    }
    (temp, runtime, review, recheck)
}

/// Mirror perform's boundary, without running a model or delivering a user turn.
pub(super) fn bind(runtime: &Runtime, job: &Job) {
    if let Some(original) = &job.session_fork {
        crate::session_branch::fork_session(
            &runtime.root.join("sessions").join(&original.id),
            &original.session_id,
            Path::new(&original.worktree),
            &runtime.root.join("sessions").join(&job.execution.id),
            &job.execution.session_id,
            Path::new(&job.execution.worktree),
        )
        .unwrap();
    }
    feedback_continuation::record_feedback_input(&runtime.root, job).unwrap();
}

pub(super) fn deliver(runtime: &Runtime, job: &Job) {
    let prompt = engine::feedback_input::prompt(&job.task, job.feedback_delivery_id.as_deref());
    deliver_text(runtime, job, &prompt);
}

fn deliver_text(runtime: &Runtime, job: &Job, text: &str) {
    bind(runtime, job);
    let origin = job
        .resume_execution_id
        .as_deref()
        .unwrap_or(&job.execution.id);
    let directory = runtime.root.join("sessions").join(origin);
    let suffix = format!("_{}.jsonl", job.execution.session_id);
    let path = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with(&suffix)
        })
        .unwrap();
    let entry = serde_json::json!({"type":"message", "id":Uuid::new_v4().to_string(),
        "message":{"role":"user", "content":[{"type":"text", "text":text}]}});
    writeln!(
        fs::OpenOptions::new().append(true).open(path).unwrap(),
        "{entry}"
    )
    .unwrap();
}

#[test]
fn feedback_delivery_image_normalization_survives_retry_and_restart() {
    for restart in [false, true] {
        let (_temp, mut runtime, _review, recheck) = ready_rechecks_with_images(Some(vec![image("screenshot")]));
        assert_eq!(recheck.images.as_ref().unwrap().len(), 1);
        let prompt = engine::feedback_input::prompt(&recheck.task, recheck.feedback_delivery_id.as_deref());
        // Pinned Pi appends normalization hints to the user text before it is
        // stored, even though the original instruction was accepted unchanged.
        let normalized = format!("{prompt}\n\n[Image: original 3000x2000, displayed at 2000x1333. Multiply coordinates by 1.50 to map to original image.]");
        deliver_text(&runtime, &recheck, &normalized);
        runtime.finish(&recheck.execution, Err("provider stopped after input".into())).unwrap();
        if restart {
            runtime.jobs().unwrap();
            let root = runtime.root.clone();
            drop(runtime);
            runtime = Runtime::open(&root).unwrap();
            runtime.pause(false).unwrap();
        } else {
            runtime.resume_node("review").unwrap();
        }
        let retry = runtime.jobs().unwrap().remove(0);
        assert!(retry.continuation && retry.task.is_empty(), "a normalized but delivered turn must not be resent");
        assert!(retry.feedback_delivery_id.is_none());
    }
}

#[test]
fn feedback_delivery_requires_the_current_identity_and_retains_legacy_boundaries() {
    for mode in ["missing", "wrong", "ambiguous", "legacy"] {
        let (_temp, mut runtime, _review, recheck) = ready_rechecks();
        let current = engine::feedback_input::prompt(&recheck.task, recheck.feedback_delivery_id.as_deref());
        let wrong = engine::feedback_input::prompt(&recheck.task, Some(&Uuid::new_v4().to_string()));
        let text = match mode {
            "wrong" => wrong,
            "ambiguous" => format!("{current}\n{wrong}"),
            _ => recheck.task.clone(),
        };
        deliver_text(&runtime, &recheck, &text);
        if mode == "legacy" {
            let receipt = runtime.root.join("sessions").join(&recheck.execution.id).join("feedback-input.json");
            let mut boundary: serde_json::Value = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
            boundary.as_object_mut().unwrap().remove("delivery_marker");
            fs::write(receipt, boundary.to_string()).unwrap();
        }
        runtime.finish(&recheck.execution, Err("provider stopped".into())).unwrap();
        runtime.resume_node("review").unwrap();
        if mode == "legacy" {
            let retry = runtime.jobs().unwrap().remove(0);
            assert!(retry.continuation && retry.task.is_empty());
        } else {
            let count = runtime.state.executions.len();
            assert!(runtime.jobs().err().unwrap().contains("differs from the recorded turn"), "{mode}");
            assert_eq!(runtime.state.executions.len(), count, "uncertain input cannot become a duplicate turn");
        }
    }
}

#[test]
fn feedback_delivery_prepared_fork_is_not_a_consumed_notice() {
    for restart in [false, true] {
        let (_temp, mut runtime, _review, recheck) = ready_rechecks();
        runtime
            .emit(EventKind::Prepared {
                execution_id: recheck.execution.id.clone(),
                head: String::new(),
            })
            .unwrap();
        bind(&runtime, &recheck);
        runtime
            .finish(
                &recheck.execution,
                Err("attachment delivery failed before Pi".into()),
            )
            .unwrap();
        if restart {
            runtime.jobs().unwrap(); // settle dependent blocks before reopening
            let root = runtime.root.clone();
            drop(runtime);
            runtime = Runtime::open(&root).unwrap();
            runtime.pause(false).unwrap();
        } else {
            runtime.resume_node("review").unwrap();
        }
        let retry = runtime.jobs().unwrap().remove(0);
        assert_eq!(retry.task, recheck.task);
        assert!(!retry.continuation);
        assert_eq!(
            retry.resume_execution_id.as_deref(),
            Some(recheck.execution.id.as_str())
        );
    }
}

#[test]
fn feedback_delivery_user_followup_after_failed_fork_retains_notice_and_anchor() {
    for fork_created in [false, true] {
        let (_temp, mut runtime, review, recheck) = ready_rechecks();
        if fork_created {
            runtime
                .emit(EventKind::Prepared {
                    execution_id: recheck.execution.id.clone(),
                    head: String::new(),
                })
                .unwrap();
            bind(&runtime, &recheck);
        }
        runtime
            .finish(&recheck.execution, Err("failed before input".into()))
            .unwrap();
        runtime
            .intervene("review", "also check the error case")
            .unwrap();
        let next = runtime.jobs().unwrap().remove(0);
        if fork_created {
            assert_eq!(
                next.resume_execution_id.as_deref(),
                Some(recheck.execution.id.as_str())
            );
        } else {
            assert_eq!(next.session_fork.as_ref().unwrap().id, review.execution.id);
        }
        assert_eq!(next.task.matches(&recheck.task).count(), 1);
        assert!(next.task.contains("also check the error case"));
        assert!(!next.continuation);
        runtime
            .finish(&next.execution, Err("failed again before input".into()))
            .unwrap();
        runtime.resume_node("review").unwrap();
        let again = runtime.jobs().unwrap().remove(0);
        assert_eq!(again.task, next.task);
    }
}

#[test]
fn feedback_delivery_missing_template_drains_unrelated_workers_before_error() {
    for unreadable in [false, true] {
        let (_temp, _source, mut runtime) = configured(true);
        let roots = runtime.jobs().unwrap();
        let owner = roots
            .iter()
            .find(|job| job.execution.node == "owner")
            .unwrap();
        let unrelated = roots
            .iter()
            .find(|job| job.execution.node == "unrelated")
            .unwrap();
        history(&runtime, owner);
        finish(&mut runtime, owner, "done");
        let review = runtime.jobs().unwrap().remove(0);
        assert_eq!(review.execution.node, "review");
        history(&runtime, &review);
        finish(&mut runtime, &review, "fix\n<FEEDBACK>");
        let repair = runtime.jobs().unwrap().remove(0);
        finish(&mut runtime, &repair, "repaired");
        let template = runtime.root.join("prompts/feedback-returned.md");
        if unreadable {
            fs::remove_file(&template).unwrap();
            fs::create_dir(&template).unwrap();
        } else {
            fs::write(&template, "").unwrap();
        }
        assert_eq!(runtime.state.nodes["unrelated"].status, "running");
        assert!(runtime.jobs().unwrap().is_empty());
        // The driver remains alive to commit this completion before it reports
        // an idle-boundary admission error, rather than losing its channel.
        finish(&mut runtime, unrelated, "unrelated completed");
        assert!(runtime.jobs().is_err());
        assert_eq!(
            runtime.store.load(&runtime.state.run_id).unwrap().nodes["unrelated"].status,
            "completed"
        );
    }
}

fn image(data: &str) -> ImageAttachment {
    ImageAttachment {
        r#type: "image".into(),
        mime_type: "image/png".into(),
        data: data.into(),
        name: Some(data.into()),
    }
}

#[test]
fn feedback_delivery_retry_keeps_images_and_appends_new_ones_in_order() {
    let (_temp, _source, mut runtime) = configured(true);
    invalidate(&mut runtime, false);
    let repair = runtime.jobs().unwrap().remove(0);
    finish(&mut runtime, &repair, "repaired");
    for n in ["first", "second"] {
        runtime
            .intervene_with_images("review", n, Some(vec![image(n)]))
            .unwrap();
    }
    let jobs = runtime.jobs().unwrap();
    let recheck = jobs
        .iter()
        .find(|job| job.execution.node == "review")
        .unwrap();
    assert_eq!(recheck.images.as_ref().unwrap().len(), 2);
    for job in &jobs {
        if job.execution.node == "review" {
            runtime
                .finish(&job.execution, Err("failed before fork".into()))
                .unwrap();
        } else {
            finish(&mut runtime, job, "done");
        }
    }
    runtime.jobs().unwrap();
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.pause(false).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.task, recheck.task);
    assert_eq!(
        retry
            .images
            .as_ref()
            .unwrap()
            .iter()
            .map(|image| &image.data)
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
    runtime
        .finish(&retry.execution, Err("still before input".into()))
        .unwrap();
    runtime
        .intervene_with_images("review", "third", Some(vec![image("third")]))
        .unwrap();
    let next = runtime.jobs().unwrap().remove(0);
    assert_eq!(
        next.images
            .as_ref()
            .unwrap()
            .iter()
            .map(|image| &image.data)
            .collect::<Vec<_>>(),
        vec!["first", "second", "third"]
    );
    assert!(next.task.contains("attached images 3-3"));
    assert_eq!(next.task.matches(&retry.task).count(), 1);
}

#[test]
fn feedback_delivery_session_receipt_survives_crash_without_output_and_prevents_duplicates() {
    let (_temp, mut runtime, _review, recheck) = ready_rechecks();
    runtime
        .emit(EventKind::Prepared {
            execution_id: recheck.execution.id.clone(),
            head: String::new(),
        })
        .unwrap();
    deliver(&runtime, &recheck); // Pi saved the user entry, but Output never committed
    runtime
        .finish(
            &recheck.execution,
            Err("provider failed before output flush".into()),
        )
        .unwrap();
    runtime.jobs().unwrap();
    let root = runtime.root.clone();
    drop(runtime);
    let mut runtime = Runtime::open(&root).unwrap();
    runtime.pause(false).unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert!(retry.continuation && retry.task.is_empty());
    assert!(retry.feedback_delivery_id.is_none());
    runtime
        .finish(&retry.execution, Err("provider failed again".into()))
        .unwrap();
    runtime
        .intervene("review", "new human instruction")
        .unwrap();
    let followup = runtime.jobs().unwrap().remove(0);
    assert_eq!(followup.task, "new human instruction");
    assert!(!followup.task.contains(&recheck.task));
    // Losing a later unstarted human turn must not resend the already-delivered
    // notice, or treat earlier activity in the same session as its own launch.
    runtime
        .finish(&followup.execution, Err("before new input boundary".into()))
        .unwrap();
    runtime.resume_node("review").unwrap();
    let recovered = runtime.jobs().unwrap().remove(0);
    assert_eq!(recovered.task, followup.task);
}

#[test]
fn feedback_delivery_missing_boundary_after_unflushed_input_fails_closed() {
    let (_temp, mut runtime, _review, recheck) = ready_rechecks();
    runtime
        .emit(EventKind::Prepared {
            execution_id: recheck.execution.id.clone(),
            head: String::new(),
        })
        .unwrap();
    deliver(&runtime, &recheck);
    runtime
        .finish(&recheck.execution, Err("no output flushed".into()))
        .unwrap();
    fs::remove_file(
        runtime
            .root
            .join("sessions")
            .join(&recheck.execution.id)
            .join("feedback-input.json"),
    )
    .unwrap();
    runtime.resume_node("review").unwrap();
    let count = runtime.state.executions.len();
    assert!(runtime
        .jobs()
        .err()
        .unwrap()
        .contains("refusing to guess consumption"));
    assert_eq!(runtime.state.executions.len(), count);
}

#[test]
fn feedback_delivery_missing_or_damaged_consumption_evidence_never_resends() {
    for damage in ["receipt", "session", "newline"] {
        let (_temp, mut runtime, _review, recheck) = ready_rechecks();
        deliver(&runtime, &recheck);
        runtime
            .emit(EventKind::Output {
                execution_id: recheck.execution.id.clone(),
                text: "launched".into(),
            })
            .unwrap();
        runtime
            .finish(&recheck.execution, Err("provider stopped".into()))
            .unwrap();
        let directory = runtime.root.join("sessions").join(&recheck.execution.id);
        let session = directory.join(format!("grapher_{}.jsonl", recheck.execution.session_id));
        match damage {
            "receipt" => fs::remove_file(directory.join("feedback-input.json")).unwrap(),
            "session" => fs::remove_file(session).unwrap(),
            _ => {
                let bytes = fs::read(&session).unwrap();
                fs::write(&session, &bytes[..bytes.len() - 1]).unwrap();
            }
        }
        runtime.resume_node("review").unwrap();
        let count = runtime.state.executions.len();
        assert!(
            runtime.jobs().is_err(),
            "lost {damage} must not become a resend"
        );
        assert_eq!(runtime.state.executions.len(), count);
    }
}

#[test]
fn feedback_delivery_old_equal_identity_is_not_a_receipt_and_corrupt_evidence_fails_closed() {
    let (_temp, mut runtime, review, recheck) = ready_rechecks();
    let source = runtime
        .root
        .join("sessions")
        .join(&review.execution.id)
        .join(format!("test_{}.jsonl", review.execution.session_id));
    writeln!(fs::OpenOptions::new().append(true).open(source).unwrap(), "{}",
        serde_json::json!({"type":"message", "id":"historical", "message":{"role":"user",
            "content":engine::feedback_input::prompt(&recheck.task, recheck.feedback_delivery_id.as_deref())}})).unwrap();
    bind(&runtime, &recheck);
    runtime
        .finish(&recheck.execution, Err("not sent".into()))
        .unwrap();
    runtime.resume_node("review").unwrap();
    let retry = runtime.jobs().unwrap().remove(0);
    assert_eq!(retry.task, recheck.task);
    deliver(&runtime, &retry);
    runtime
        .finish(&retry.execution, Err("after input".into()))
        .unwrap();
    let receipt = runtime
        .root
        .join("sessions")
        .join(retry.feedback_delivery_id.as_ref().unwrap())
        .join("feedback-input.json");
    fs::write(receipt, "broken json").unwrap();
    runtime.resume_node("review").unwrap();
    let count = runtime.state.executions.len();
    assert!(runtime
        .jobs()
        .err()
        .unwrap()
        .contains("Invalid feedback delivery evidence"));
    assert_eq!(runtime.state.executions.len(), count);
}
