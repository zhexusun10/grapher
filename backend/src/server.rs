use crate::{
    compiler,
    engine::{parse_route_decision, run_pi, PiModelConfig, PiRequest, PiRole},
    model::*,
    runtime::{perform, Runtime},
    snapshot_view::{execution_page, snapshot_metadata},
};
use serde::Serialize;
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

use uuid::Uuid;

pub struct Service {
    runtime: Mutex<Runtime>,
    driving: AtomicBool,
    planning: AtomicBool,
    extension: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    snapshot: serde_json::Value,
    config: Config,
    runs: Vec<String>,
    data_path: String,
    repository_info: Option<crate::workspace::RepositoryInfo>,
}

const PARTITIONER_PROMPT: &str = include_str!("../resources/prompts/partitioner.md");
const PLANNER_PROMPT: &str = include_str!("../resources/prompts/planner.md");

#[allow(dead_code)]
fn render_prompt(template: &str, replacements: &[(&str, &str)]) -> String {
    let mut rendered = template.to_string();
    for (key, value) in replacements {
        let double_brace = format!("{{{{{key}}}}}");
        let single_brace = format!("{{{key}}}");
        if rendered.contains(&double_brace) {
            rendered = rendered.replace(&double_brace, value);
        } else if rendered.contains(&single_brace) {
            rendered = rendered.replace(&single_brace, value);
        }
    }
    rendered
}

fn split_prompt_template<'a>(template: &'a str) -> (&'a str, &'a str) {
    if let Some((system, query)) = template.split_once("User query:") {
        (system.trim(), query.trim())
    } else {
        (template.trim(), "")
    }
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    #[cfg(feature = "fixture")]
    #[test]
    fn partitioner_failure_does_not_create_or_approve_a_run() {
        let temp = tempfile::TempDir::new().unwrap();
        let repo = temp.path().join("repository");
        fs::create_dir_all(&repo).unwrap();
        fs::write(repo.join("README.md"), "Two independent modules").unwrap();
        let script = temp.path().join("failed-pi.sh");
        fs::write(&script, "echo 'provider unavailable' >&2\nexit 1\n").unwrap();
        let root = temp.path().join("runtime");
        let service = Arc::new(Service {
            runtime: Mutex::new(Runtime::open(&root).unwrap()),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let before = service.runtime.lock().unwrap().state.run_id.clone();
        let result = plan_goal_internal(
            "Build two modules".into(),
            Config {
                repository: repo.to_string_lossy().into(),
                engine: "pi".into(),
                pi_command: "/bin/sh".into(),
                pi_args: vec![script.to_string_lossy().into()],
                model: String::new(),
                max_parallel: 4,
                max_feedback: 3,
            },
            &service,
            |_| {},
            |_| panic!("Failure must not emit a route"),
            |_| {},
        );
        assert!(result.unwrap_err().0.contains("Partitioner failed"));
        let runtime = service.runtime.lock().unwrap();
        assert_eq!(runtime.state.run_id, before);
        assert!(runtime.state.executions.is_empty());
        assert!(!runtime.state.approved);
        assert!(!service.planning.load(Ordering::SeqCst));
        let directory = fs::read_dir(root.join("planning"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(fs::read_to_string(directory.join("partition.jsonl"))
            .unwrap()
            .contains("provider unavailable"));
        assert!(!directory.join("route.json").exists());
        let summary_content = fs::read_to_string(directory.join("summary.json")).unwrap();
        let failure_summary: PlanningSummary = serde_json::from_str(&summary_content).unwrap();
        assert_eq!(failure_summary.status.as_deref(), Some("failed"));
        assert!(failure_summary.roles.contains_key("partition"));
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn fast_sibling_releases_slot_for_downstream_before_slow_sibling() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path();
        let repository = crate::fixture::repository(root).unwrap();
        let release = root.join("release-slow");
        let script = root.join("worker.sh");
        fs::write(&script, format!(r#"case "$PWD" in
  *a_slow-*) while [ ! -f '{}' ]; do sleep 0.02; done; echo done > slow.txt ;;
  *z_fast-*) echo done > fast.txt ;;
  *) echo done > downstream.txt ;;
esac
printf '%s\n' '{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"Completed"}}]}}}}'
"#, release.display())).unwrap();
        let mut runtime = Runtime::open(root).unwrap();
        runtime
            .create(
                Graph {
                    original_goal: "Check real completion order".into(),
                    nodes: ["a_slow", "z_fast", "after_fast"]
                        .into_iter()
                        .map(|name| Node {
                            name: name.into(),
                            task: "Write your result".into(),
                        })
                        .collect(),
                    edges: vec![Edge {
                        from: "z_fast".into(),
                        to: "after_fast".into(),
                        feedback: false,
                        relation: String::new(),
                    }],
                },
                Config {
                    repository: repository.to_string_lossy().into(),
                    engine: "pi".into(),
                    pi_command: "/bin/sh".into(),
                    pi_args: vec![script.to_string_lossy().into()],
                    model: "test".into(),
                    max_parallel: 4,
                    max_feedback: 2,
                },
            )
            .unwrap();
        runtime.approve().unwrap();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: root.join("unused.ts"),
        });
        drive(service.clone());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let observed = loop {
            let state = service.runtime.lock().unwrap().state.clone();
            if state.nodes["after_fast"].status == "done" || std::time::Instant::now() > deadline {
                break state;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        };
        // Always release and drain before assertions, even on a regression.
        fs::write(&release, "release").unwrap();
        while service.driving.load(Ordering::SeqCst) {
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(observed.nodes["z_fast"].status, "done");
        assert_eq!(observed.nodes["a_slow"].status, "running");
        assert_eq!(observed.nodes["after_fast"].status, "done");
        let fast = observed
            .executions
            .iter()
            .find(|e| e.node == "z_fast")
            .unwrap();
        assert!(fast.completed_at.is_some());
        let runtime = service.runtime.lock().unwrap();
        let replayed = runtime.store.load(&runtime.state.run_id).unwrap();
        assert_eq!(
            replayed
                .executions
                .iter()
                .find(|e| e.node == "z_fast")
                .unwrap()
                .completed_at,
            fast.completed_at
        );
        assert_eq!(replayed.phase, "completed");
    }

    #[test]
    fn metadata_and_output_pages_preserve_unicode_without_copying_logs_into_polls() {
        let temp = tempfile::TempDir::new().unwrap();
        let runtime = Runtime::open(temp.path()).unwrap();
        let text = format!(
            "{}{}\n",
            "a".repeat(256 * 1024 - 1),
            "规划输出".repeat(100_000)
        );
        let execution = Execution {
            id: "large".into(),
            node: "worker".into(),
            revision: 1,
            attempt: 1,
            session_id: "fresh".into(),
            worktree: String::new(),
            before: String::new(),
            after: None,
            status: "running".into(),
            output: text.clone(),
            started_at: now(),
            completed_at: None,
        };
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: temp.path().join("unused"),
        });
        {
            let mut runtime = service.runtime.lock().unwrap();
            runtime.state.run_id = "large-run".into();
            runtime.state.executions.push(execution);
            runtime.state.events.push(Event {
                sequence: 1,
                timestamp: now(),
                kind: EventKind::Finished {
                    execution_id: "large".into(),
                    head: "head".into(),
                    output: text.clone(),
                },
            });
        }
        let metadata = dispatch(
            &service,
            "snapshot",
            serde_json::json!({"detail":"metadata"}),
        )
        .unwrap();
        assert!(metadata.to_string().len() < 2048);
        assert_eq!(metadata["executions"][0]["outputBytes"], text.len());
        let mut restored = String::new();
        let mut offset = 0;
        loop {
            let page = get_execution_output(
                &serde_json::json!({"runId":"large-run", "executionId":"large", "offset":offset}),
                &service,
            )
            .unwrap();
            let content = page["content"].as_str().unwrap();
            assert!(content.len() <= 256 * 1024);
            restored.push_str(content);
            offset = page["nextOffset"].as_u64().unwrap();
            if page["complete"] == true {
                break;
            }
        }
        assert_eq!(restored, text);
        assert!(get_execution_output(
            &serde_json::json!({"runId":"large-run", "executionId":"large", "offset":256*1024}),
            &service
        )
        .is_err());
        assert_eq!(
            service.runtime.lock().unwrap().state.executions[0].output,
            text
        );
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn feedback_graph_drains_siblings_before_invalidating_and_never_runs_stale_consumer() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path();
        let repository = crate::fixture::repository(root).unwrap();
        let release = root.join("release-slow");
        let script = root.join("worker.sh");
        fs::write(&script, format!(r#"cat >/dev/null
case "$PWD" in
  *slow-*) while [ ! -f '{}' ]; do sleep 0.02; done; echo done > slow.txt ;;
  *review-*) printf '%s\n' '{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"Fix owner.\n<REVISE>"}}]}}}}'; exit 0 ;;
  *consumer-*) echo invalid > stale.txt ;;
  *) echo done > owner.txt ;;
esac
printf '%s\n' '{{"type":"message_end","message":{{"role":"assistant","content":[{{"type":"text","text":"Completed"}}]}}}}'
"#, release.display())).unwrap();
        let mut runtime = Runtime::open(root).unwrap();
        runtime
            .create(
                Graph {
                    original_goal: "Feedback barrier".into(),
                    nodes: ["owner", "slow", "review", "consumer"]
                        .into_iter()
                        .map(|name| Node {
                            name: name.into(),
                            task: "Work".into(),
                        })
                        .collect(),
                    edges: [
                        ("owner", "review", false),
                        ("review", "owner", true),
                        ("review", "consumer", false),
                    ]
                    .into_iter()
                    .map(|(from, to, feedback)| Edge {
                        from: from.into(),
                        to: to.into(),
                        feedback,
                        relation: String::new(),
                    })
                    .collect(),
                },
                Config {
                    repository: repository.to_string_lossy().into(),
                    engine: "pi".into(),
                    pi_command: "/bin/sh".into(),
                    pi_args: vec![script.to_string_lossy().into()],
                    model: "test".into(),
                    max_parallel: 4,
                    max_feedback: 1,
                },
            )
            .unwrap();
        runtime.approve().unwrap();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: root.join("unused"),
        });
        drive(service.clone());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let observed = loop {
            let state = service.runtime.lock().unwrap().state.clone();
            if state.nodes["owner"].status == "done" || std::time::Instant::now() > deadline {
                break state;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        };
        fs::write(&release, "release").unwrap();
        while service.driving.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(observed.nodes["slow"].status, "running");
        assert_eq!(observed.nodes["review"].status, "waiting");
        let runtime = service.runtime.lock().unwrap();
        assert_eq!(
            runtime
                .state
                .executions
                .iter()
                .filter(|e| e.node == "slow")
                .count(),
            1
        );
        assert_eq!(
            runtime
                .state
                .executions
                .iter()
                .filter(|e| e.node == "owner")
                .count(),
            2
        );
        assert!(!runtime
            .state
            .executions
            .iter()
            .any(|e| e.node == "consumer"));
        assert_eq!(runtime.state.phase, "needs_attention");
    }

    #[test]
    fn planning_metrics_parsing_and_persistence() {
        let sample_log = r#"{"type":"grapher_process_started","timestamp":1726300000000}
{"type":"tool_execution_start","toolName":"bash"}
{"type":"tool_execution_end","toolName":"bash","isError":true}
{"type":"tool_execution_start","toolName":"read"}
{"type":"tool_execution_end","toolName":"read","isError":false}
{"type":"message_end","message":{"role":"assistant","usage":{"input":200,"output":300,"cacheRead":50,"cacheWrite":0,"reasoning":100,"totalTokens":500}}}
{"type":"grapher_process_exited","elapsedMs":12345,"success":true,"timestamp":1726300012345}
"#;
        let metrics = parse_planning_role_metrics("test-model", sample_log);
        assert_eq!(metrics.model, "test-model");
        assert_eq!(metrics.assistant_messages, 1);
        assert_eq!(metrics.tools, 2);
        assert_eq!(metrics.tool_errors, 1);
        assert_eq!(metrics.duration_seconds, 12.345);
        assert_eq!(metrics.usage.input, 200);
        assert_eq!(metrics.usage.output, 300);
        assert_eq!(metrics.usage.total_tokens, 500);

        let temp = tempfile::TempDir::new().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let config = Config {
            repository: String::new(),
            #[cfg(feature = "fixture")]
            engine: "fixture".into(),
            #[cfg(feature = "fixture")]
            pi_command: String::new(),
            #[cfg(feature = "fixture")]
            pi_args: Vec::new(),
            model: "test-model".into(),
            max_parallel: 4,
            max_feedback: 1,
        };
        let mut roles = std::collections::BTreeMap::new();
        roles.insert("planner".to_string(), metrics);
        let summary = PlanningSummary {
            planning_id: "test-plan-id".into(),
            roles,
            total_planning_duration: 15.0,
            model_duration: 12.345,
            status: Some("success".into()),
            error: None,
            created_at: None,
            repository: None,
        };
        runtime
            .create_with_planning(
                Graph {
                    original_goal: "Test plan persistence".into(),
                    nodes: vec![Node {
                        name: "task".into(),
                        task: "Run task".into(),
                    }],
                    edges: Vec::new(),
                },
                config,
                Some("test-plan-id".into()),
                Some(summary.clone()),
            )
            .unwrap();
        assert_eq!(runtime.state.planning_id.as_deref(), Some("test-plan-id"));
        assert_eq!(runtime.state.planning.as_ref(), Some(&summary));

        // Replay from store to ensure durability across reload
        let loaded = runtime.store.load(&runtime.state.run_id).unwrap();
        assert_eq!(loaded.planning_id.as_deref(), Some("test-plan-id"));
        assert_eq!(loaded.planning.as_ref(), Some(&summary));
    }

    #[test]
    fn legacy_planning_summary_backfill_and_fail_closed_filtering() {
        let temp = tempfile::TempDir::new().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let config = Config {
            repository: "/workspace/repo-a".into(),
            #[cfg(feature = "fixture")]
            engine: "fixture".into(),
            #[cfg(feature = "fixture")]
            pi_command: String::new(),
            #[cfg(feature = "fixture")]
            pi_args: Vec::new(),
            model: String::new(),
            max_parallel: 4,
            max_feedback: 1,
        };
        let summary = PlanningSummary {
            planning_id: "legacy-plan-a".into(),
            roles: Default::default(),
            total_planning_duration: 10.0,
            model_duration: 8.0,
            status: Some("success".into()),
            error: None,
            created_at: Some(100),
            repository: None, // legacy: missing repository
        };
        runtime
            .create_with_planning(
                Graph {
                    original_goal: "Goal A".into(),
                    nodes: vec![Node {
                        name: "task".into(),
                        task: "Run task".into(),
                    }],
                    edges: Vec::new(),
                },
                config,
                Some("legacy-plan-a".into()),
                Some(summary.clone()),
            )
            .unwrap();

        // Write legacy summary on disk with NO repository
        let plan_a_dir = temp.path().join("planning").join("legacy-plan-a");
        fs::create_dir_all(&plan_a_dir).unwrap();
        let legacy_json = serde_json::to_string_pretty(&summary).unwrap();
        fs::write(plan_a_dir.join("summary.json"), &legacy_json).unwrap();

        // Write an unattributed legacy summary (failed planning never tied to a run)
        let unattr_summary = PlanningSummary {
            planning_id: "unattributed-plan".into(),
            roles: Default::default(),
            total_planning_duration: 5.0,
            model_duration: 4.0,
            status: Some("failed".into()),
            error: Some("Planner crashed".into()),
            created_at: Some(200),
            repository: None,
        };
        let unattr_dir = temp.path().join("planning").join("unattributed-plan");
        fs::create_dir_all(&unattr_dir).unwrap();
        fs::write(
            unattr_dir.join("summary.json"),
            serde_json::to_string_pretty(&unattr_summary).unwrap(),
        )
        .unwrap();

        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: temp.path().join("ext.ts"),
        });

        // 1. Filter by repo-b: must return NOTHING (fail closed against repo-a and unattributed)
        let res_b = list_plannings(&service, Some("/workspace/repo-b".into())).unwrap();
        assert_eq!(
            res_b.len(),
            0,
            "Repo B must not receive Repo A or unattributed plannings"
        );

        // 2. Filter by repo-a: must backfill legacy-plan-a and return it, and exclude unattributed
        let res_a = list_plannings(&service, Some("/workspace/repo-a".into())).unwrap();
        assert_eq!(res_a.len(), 1, "Repo A must receive backfilled planning");
        assert_eq!(res_a[0].planning_id, "legacy-plan-a");
        assert_eq!(res_a[0].repository.as_deref(), Some("/workspace/repo-a"));

        // Verify summary on disk was migrated
        let migrated_disk = fs::read_to_string(plan_a_dir.join("summary.json")).unwrap();
        let parsed_disk: PlanningSummary = serde_json::from_str(&migrated_disk).unwrap();
        assert_eq!(parsed_disk.repository.as_deref(), Some("/workspace/repo-a"));

        // 3. Unfiltered: returns both legacy-plan-a and unattributed-plan
        let res_all = list_plannings(&service, None).unwrap();
        assert_eq!(res_all.len(), 2, "Unfiltered query returns all plannings");
        assert_eq!(res_all[0].planning_id, "unattributed-plan"); // created_at 200 > 100
        assert_eq!(res_all[1].planning_id, "legacy-plan-a");
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn completed_graph_is_published_by_driver() {
        let temp = tempfile::TempDir::new().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let config = Config {
            repository: String::new(),
            engine: "fixture".into(),
            pi_command: String::new(),
            pi_args: Vec::new(),
            model: String::new(),
            max_parallel: 4,
            max_feedback: 1,
        };
        runtime
            .create(
                Graph {
                    original_goal: "Publish both independent outcomes".into(),
                    nodes: vec![
                        Node {
                            name: "first".into(),
                            task: "First".into(),
                        },
                        Node {
                            name: "last".into(),
                            task: "Last".into(),
                        },
                    ],
                    edges: Vec::new(),
                },
                config,
            )
            .unwrap();
        runtime.approve().unwrap();
        let service = Arc::new(Service {
            runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false),
            planning: AtomicBool::new(false),
            extension: temp.path().join("unused-extension.ts"),
        });
        drive(service.clone());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while service.driving.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "Driver did not settle"
            );
            thread::sleep(std::time::Duration::from_millis(20));
        }
        let runtime = service.runtime.lock().unwrap();
        assert_eq!(runtime.state.phase, "completed");
        let source = temp.path().join("fixture-repository");
        assert!(source.join("first.md").exists());
        assert!(source.join("last.md").exists());
        assert!(crate::workspace::git(&source, &["status", "--porcelain"])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn planning_prompts_separate_user_query_from_system() {
        for template in [PLANNER_PROMPT, PARTITIONER_PROMPT] {
            let (system, query) = split_prompt_template(template);
            assert!(!system.contains("{{query}}"));
            assert!(!system.contains("Goal:"));
            assert_eq!(query, "{{query}}");
            assert_eq!(
                render_prompt(query, &[("query", "Build a graph")]),
                "Build a graph"
            );
        }
    }
}

fn load_env_file() {
    let candidates = [
        PathBuf::from(".env"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.env"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".env"),
    ];
    for path in &candidates {
        if let Ok(content) = fs::read_to_string(path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = trimmed.split_once('=') {
                    let k = k.trim();
                    let v = v.trim().trim_matches('"').trim_matches('\'');
                    if std::env::var(k).is_err() {
                        std::env::set_var(k, v);
                    }
                }
            }
            break;
        }
    }
}

fn bootstrap(service: &Arc<Service>, metadata: bool) -> Result<Bootstrap, String> {
    load_env_file();
    let active_config = if service.planning.load(Ordering::SeqCst) {
        let active = list_plannings(service, None)?
            .into_iter()
            .find(|summary| summary.status.as_deref() == Some("running"));
        let root = service
            .runtime
            .lock()
            .map_err(|e| e.to_string())?
            .root
            .clone();
        active
            .and_then(|summary| {
                fs::read(
                    root.join("planning")
                        .join(summary.planning_id)
                        .join("request.json"),
                )
                .ok()
            })
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| serde_json::from_value::<Config>(value["config"].clone()).ok())
    } else {
        None
    };
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    #[cfg(feature = "fixture")]
    let entrypoint = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engine/entrypoint.mjs");
    let detected_repo = crate::workspace::detect(None).ok().flatten();
    let mut config = active_config
        .or_else(|| runtime.state.config.clone())
        .unwrap_or(Config {
            repository: detected_repo
                .as_ref()
                .map(|r| r.path.clone())
                .unwrap_or_default(),
            model: String::new(),
            max_parallel: 4,
            max_feedback: 3,
            #[cfg(feature = "fixture")]
            engine: "pi".into(),
            #[cfg(feature = "fixture")]
            pi_command: "node".into(),
            #[cfg(feature = "fixture")]
            pi_args: vec![entrypoint.to_string_lossy().into()],
        });
    if config.repository.is_empty() {
        if let Some(ref repo) = detected_repo {
            config.repository = repo.path.clone();
        }
    }
    let repository_info = if !config.repository.is_empty() {
        if let Some(ref repo) = detected_repo {
            if repo.path == config.repository {
                Some(repo.clone())
            } else {
                crate::workspace::detect(Some(std::path::Path::new(&config.repository)))
                    .ok()
                    .flatten()
            }
        } else {
            crate::workspace::detect(Some(std::path::Path::new(&config.repository)))
                .ok()
                .flatten()
        }
    } else {
        None
    };
    Ok(Bootstrap {
        snapshot: if metadata {
            snapshot_metadata(&runtime.state)?
        } else {
            serde_json::to_value(&runtime.state).map_err(|e| e.to_string())?
        },
        config,
        runs: runtime.store.runs()?,
        data_path: runtime.root.to_string_lossy().into(),
        repository_info,
    })
}

fn snapshot(service: &Arc<Service>) -> Result<Snapshot, String> {
    Ok(service
        .runtime
        .lock()
        .map_err(|error| error.to_string())?
        .state
        .clone())
}

fn history(run_id: String, service: &Arc<Service>) -> Result<Snapshot, String> {
    service
        .runtime
        .lock()
        .map_err(|error| error.to_string())?
        .store
        .load(&run_id)
}

fn load_run(run_id: String, service: &Arc<Service>) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish before switching runs".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.load_run(&run_id)
}

fn compile_graph(graph: Graph) -> Result<Plan, Vec<compiler::Diagnostic>> {
    compiler::compile(&graph, true)
}

fn save_graph(
    graph: Graph,
    config: Config,
    service: &Arc<Service>,
) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.create(graph, config)?;
    Ok(runtime.state.clone())
}

pub fn parse_planning_role_metrics(model: &str, log: &str) -> PlanningRoleMetrics {
    let mut session_start = None;
    let mut last_event = None;
    let mut duration_seconds = 0.0;
    let mut assistant_messages = 0;
    let mut tools = 0;
    let mut tool_errors = 0;
    let mut usage = TokenUsage::default();

    for line in log.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("[stderr]") {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(ts) = value.get("timestamp") {
                let ts_str = if let Some(s) = ts.as_str() {
                    s.to_string()
                } else if let Some(n) = ts.as_u64() {
                    format!("{n}")
                } else {
                    String::new()
                };
                if !ts_str.is_empty() {
                    if session_start.is_none() {
                        session_start = Some(ts_str.clone());
                    }
                    last_event = Some(ts_str);
                }
            }
            match value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
            {
                "grapher_process_exited" => {
                    if let Some(elapsed) = value.get("elapsedMs").and_then(|v| v.as_f64()) {
                        duration_seconds = elapsed / 1000.0;
                    }
                }
                "message_end" => {
                    if let Some(msg) = value.get("message") {
                        if msg.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                            assistant_messages += 1;
                            if let Some(u) = msg.get("usage") {
                                usage.input +=
                                    u.get("input").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.output +=
                                    u.get("output").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.cache_read +=
                                    u.get("cacheRead").and_then(|v| v.as_u64()).unwrap_or(0)
                                        as usize;
                                usage.cache_write +=
                                    u.get("cacheWrite").and_then(|v| v.as_u64()).unwrap_or(0)
                                        as usize;
                                usage.reasoning +=
                                    u.get("reasoning").and_then(|v| v.as_u64()).unwrap_or(0)
                                        as usize;
                                usage.total_tokens +=
                                    u.get("totalTokens").and_then(|v| v.as_u64()).unwrap_or(0)
                                        as usize;
                            }
                        }
                    }
                }
                "tool_execution_start" => {
                    tools += 1;
                }
                "tool_execution_end" => {
                    if value
                        .get("isError")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        tool_errors += 1;
                    }
                }
                _ => {}
            }
        }
    }

    PlanningRoleMetrics {
        model: model.to_string(),
        session_start,
        last_event,
        duration_seconds,
        assistant_messages,
        tools,
        tool_errors,
        usage,
    }
}

fn plan_goal_internal(
    goal: String,
    config: Config,
    service: &Arc<Service>,
    mut on_partitioner_line: impl FnMut(&str),
    mut on_route: impl FnMut(&Route),
    mut on_planner_line: impl FnMut(&str),
) -> Result<Snapshot, (String, Option<PlanningSummary>)> {
    if goal.trim().is_empty() {
        return Err(("Enter a goal".into(), None));
    }
    #[cfg(feature = "fixture")]
    if config.engine != "pi" {
        return Err((
            "Automatic planning requires the Execution Instance Engine".into(),
            None,
        ));
    }
    if service.driving.load(Ordering::SeqCst) || service.planning.swap(true, Ordering::SeqCst) {
        return Err(("Another operation is running".into(), None));
    }
    let service = service.clone();
    let cleanup = service.clone();
    let result = (move || {
        let planning_start = std::time::Instant::now();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let root = service
            .runtime
            .lock()
            .map_err(|error| (error.to_string(), None))?
            .root
            .clone();
        let repository = PathBuf::from(&config.repository);
        let repo_str = repository.to_string_lossy().to_string();
        crate::workspace::verify(&repository).map_err(|error| (error, None))?;
        let planning_id = Uuid::new_v4().to_string();
        let directory = root.join("planning").join(&planning_id);
        fs::create_dir_all(&directory).map_err(|error| (error.to_string(), None))?;
        fs::write(
            directory.join("request.json"),
            serde_json::to_vec(&serde_json::json!({
                "goal": goal, "config": config
            }))
            .map_err(|e| (e.to_string(), None))?,
        )
        .map_err(|e| (e.to_string(), None))?;
        // Publish identity before launching Pi; a browser connection does not own planning.
        let running = PlanningSummary {
            planning_id: planning_id.clone(),
            status: Some("running".into()),
            created_at: Some(now_ms),
            repository: Some(repo_str.clone()),
            roles: ["partition", "planner"]
                .into_iter()
                .map(|role| (role.to_string(), PlanningRoleMetrics::default()))
                .collect(),
            ..Default::default()
        };
        write_planning_summary(&directory, &running).map_err(|error| (error, None))?;
        let plan_outcome = (|| -> Result<Snapshot, String> {
            let route_path = directory.join("route.json");
            let (default_partitioner_system, _) = split_prompt_template(PARTITIONER_PROMPT);
            let partitioner_system_prompt = std::env::var("PARTITIONER_SYSTEM_PROMPT")
                .unwrap_or_else(|_| default_partitioner_system.to_string());
            let task = format!("User query:\n\n{goal}");
            let partitioner_model_cfg = PiModelConfig::resolve(PiRole::Partitioner, &config);
            let partitioner_config = partitioner_model_cfg.effective_config(&config);
            let mut partitioner_extra_args = vec!["--no-tools", "--no-context-files"];
            if let Some(thinking) = &partitioner_model_cfg.thinking {
                partitioner_extra_args.push("--thinking");
                partitioner_extra_args.push(thinking.as_str());
            }
            let mut log = String::new();
            let mut partition_log =
                fs::File::create(directory.join("partition.jsonl")).map_err(|e| e.to_string())?;
            let mut log_error = None;
            let partition_start = std::time::Instant::now();
            let partition_result = run_pi(
                PiRequest {
                    role: PiRole::Partitioner,
                    config: &partitioner_config,
                    cwd: &repository,
                    task: &task,
                    session_dir: &directory.join("partition-session"),
                    extension: None,
                    tools: Some(""),
                    session_id: None,
                    extra_args: partitioner_extra_args,
                    environment: vec![
                        ("GRAPHER_MODE", "partition".into()),
                        ("GRAPHER_GRAPH_PATH", route_path.to_string_lossy().into()),
                    ],
                    system_prompt: Some(&partitioner_system_prompt),
                },
                |text| {
                    if let Err(error) = partition_log.write_all(text.as_bytes()) {
                        log_error = Some(error.to_string());
                    }
                    log.push_str(&text);
                    on_partitioner_line(&text);
                },
            );
            let partition_wall_sec = partition_start.elapsed().as_secs_f64();
            if let Some(error) = log_error {
                return Err(format!("Cannot persist planning output: {error}"));
            }
            let mut partition_metrics =
                parse_planning_role_metrics(&partitioner_config.model, &log);
            if partition_metrics.duration_seconds == 0.0 {
                partition_metrics.duration_seconds = partition_wall_sec;
            }
            // A failed engine call is not a routing decision. In particular, do not
            // turn authentication/provider failures into an auto-approved serial run.
            let output =
                partition_result.map_err(|error| format!("Partitioner failed: {error}"))?;
            let route = parse_route_decision(&output);
            fs::write(&route_path, serde_json::to_string_pretty(&route).unwrap())
                .map_err(|error| error.to_string())?;
            on_route(&route);
            let mut planner_metrics = None;
            let graph = match route.plan_type.as_str() {
                "serial" => Graph {
                    original_goal: goal.clone(),
                    nodes: vec![Node {
                        name: "task".into(),
                        task: goal.clone(),
                    }],
                    edges: Vec::new(),
                },
                "graph" => {
                    let graph_path = directory.join("graph.json");
                    fs::write(
                        &graph_path,
                        serde_json::to_string(&Graph {
                            original_goal: goal.clone(),
                            ..Graph::default()
                        })
                        .unwrap(),
                    )
                    .map_err(|error| error.to_string())?;
                    let planner_model_cfg = PiModelConfig::resolve(PiRole::Planner, &config);
                    let planner_config = planner_model_cfg.effective_config(&config);
                    let (default_planner_system, _) = split_prompt_template(PLANNER_PROMPT);
                    let planner_system_prompt = std::env::var("PLANNER_SYSTEM_PROMPT")
                        .unwrap_or_else(|_| default_planner_system.to_string());
                    let task = format!("User query:\n\n{goal}");
                    let mut planner_extra_args = Vec::new();
                    if let Some(thinking) = &planner_model_cfg.thinking {
                        planner_extra_args.push("--thinking");
                        planner_extra_args.push(thinking.as_str());
                    }
                    let mut log = String::new();
                    let mut planner_log = fs::File::create(directory.join("planner.jsonl"))
                        .map_err(|e| e.to_string())?;
                    let mut log_error = None;
                    let planner_start = std::time::Instant::now();
                    let planner_result = run_pi(
                        PiRequest {
                            role: PiRole::Planner,
                            config: &planner_config,
                            cwd: &repository,
                            task: &task,
                            session_dir: &directory.join("planner-session"),
                            extension: Some(&service.extension),
                            tools: Some("node,edge,read,bash"),
                            session_id: None,
                            extra_args: planner_extra_args,
                            environment: vec![
                                ("GRAPHER_MODE", "planner".into()),
                                ("GRAPHER_GRAPH_PATH", graph_path.to_string_lossy().into()),
                                (
                                    "GRAPHER_COMPILER_PATH",
                                    std::env::current_exe()
                                        .map_err(|error| error.to_string())?
                                        .to_string_lossy()
                                        .into(),
                                ),
                            ],
                            system_prompt: Some(&planner_system_prompt),
                        },
                        |text| {
                            if let Err(error) = planner_log.write_all(text.as_bytes()) {
                                log_error = Some(error.to_string());
                            }
                            log.push_str(&text);
                            on_planner_line(&text);
                        },
                    );
                    let planner_wall_sec = planner_start.elapsed().as_secs_f64();
                    if let Some(error) = log_error {
                        return Err(format!("Cannot persist planning output: {error}"));
                    }
                    let mut m = parse_planning_role_metrics(&planner_config.model, &log);
                    if m.duration_seconds == 0.0 {
                        m.duration_seconds = planner_wall_sec;
                    }
                    planner_metrics = Some(m);
                    planner_result?;
                    serde_json::from_str(
                        &fs::read_to_string(graph_path).map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| error.to_string())?
                }
                _ => return Err("Partitioner returned an invalid route".into()),
            };
            let total_planning_duration = planning_start.elapsed().as_secs_f64();
            let model_duration = partition_metrics.duration_seconds
                + planner_metrics
                    .as_ref()
                    .map(|p| p.duration_seconds)
                    .unwrap_or(0.0);
            let mut roles = std::collections::BTreeMap::new();
            roles.insert("partition".to_string(), partition_metrics);
            if let Some(m) = planner_metrics {
                roles.insert("planner".to_string(), m);
            }
            let summary = PlanningSummary {
                planning_id: planning_id.clone(),
                roles,
                total_planning_duration,
                model_duration,
                status: Some("success".to_string()),
                error: None,
                created_at: Some(now_ms),
                repository: Some(repo_str.clone()),
            };

            let final_config = config.clone();
            let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
            runtime.create_with_planning(
                graph,
                final_config,
                Some(planning_id.clone()),
                Some(summary.clone()),
            )?;
            runtime.set_route(&route.plan_type)?;
            if route.plan_type == "serial" {
                runtime.approve()?;
            }
            let snapshot = runtime.state.clone();
            drop(runtime);
            write_planning_summary(&directory, &summary)?;
            if route.plan_type == "serial" {
                drive(service.clone());
            }
            Ok(snapshot)
        })();
        match plan_outcome {
            Ok(snapshot) => Ok(snapshot),
            Err(err) => {
                let mut roles: std::collections::BTreeMap<String, PlanningRoleMetrics> =
                    Default::default();
                let mut model_duration = 0.0;
                let partition_file = directory.join("partition.jsonl");
                if partition_file.exists() {
                    if let Ok(content) = fs::read_to_string(&partition_file) {
                        let partitioner_model_cfg =
                            PiModelConfig::resolve(PiRole::Partitioner, &config);
                        let partitioner_config = partitioner_model_cfg.effective_config(&config);
                        let m = parse_planning_role_metrics(&partitioner_config.model, &content);
                        model_duration += m.duration_seconds;
                        roles.insert("partition".into(), m);
                    }
                }
                let planner_file = directory.join("planner.jsonl");
                if planner_file.exists() {
                    if let Ok(content) = fs::read_to_string(&planner_file) {
                        let planner_model_cfg = PiModelConfig::resolve(PiRole::Planner, &config);
                        let planner_config = planner_model_cfg.effective_config(&config);
                        let m = parse_planning_role_metrics(&planner_config.model, &content);
                        model_duration += m.duration_seconds;
                        roles.insert("planner".into(), m);
                    }
                }
                let failure_summary = PlanningSummary {
                    planning_id: planning_id.clone(),
                    roles,
                    total_planning_duration: planning_start.elapsed().as_secs_f64(),
                    model_duration,
                    status: Some("failed".to_string()),
                    error: Some(err.clone()),
                    created_at: Some(now_ms),
                    repository: Some(repo_str.clone()),
                };
                if let Err(error) = write_planning_summary(&directory, &failure_summary) {
                    eprintln!("Cannot persist planning failure: {error}");
                }
                Err((err, Some(failure_summary)))
            }
        }
    })();
    cleanup.planning.store(false, Ordering::SeqCst);
    result
}

fn write_planning_summary(
    directory: &std::path::Path,
    summary: &PlanningSummary,
) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(summary).map_err(|e| e.to_string())?;
    let pending = directory.join("summary.pending");
    fs::write(&pending, &json).map_err(|e| e.to_string())?;
    fs::rename(pending, directory.join("summary.json")).map_err(|e| e.to_string())?;
    Ok(())
}

fn recover_plannings(root: &std::path::Path) -> Result<(), String> {
    if let Ok(entries) = fs::read_dir(root.join("planning")) {
        for entry in entries.flatten() {
            if let Ok(content) = fs::read(entry.path().join("summary.json")) {
                if let Ok(mut summary) = serde_json::from_slice::<PlanningSummary>(&content) {
                    if summary.status.as_deref() == Some("running") {
                        summary.status = Some("failed".into());
                        summary.error = Some("Backend stopped during planning. Saved output is preserved; start a new planning attempt.".into());
                        write_planning_summary(&entry.path(), &summary)?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn plan_goal(goal: String, config: Config, service: &Arc<Service>) -> Result<Snapshot, String> {
    plan_goal_internal(goal, config, service, |_| {}, |_| {}, |_| {}).map_err(|(error, _)| error)
}

fn drive(service: Arc<Service>) {
    if service.driving.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let (completed_tx, completed_rx) = std::sync::mpsc::channel();
            let mut in_flight = 0usize;
            let mut feedback_results = Vec::new();
            loop {
                let (jobs, root, parents) = {
                    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                    let feedback_barrier =
                        in_flight > 0 && runtime.state.graph.edges.iter().any(|edge| edge.feedback);
                    let jobs = if feedback_barrier {
                        Vec::new()
                    } else {
                        runtime.jobs()?
                    };
                    let parents: Vec<_> = jobs
                        .iter()
                        .map(|job| runtime.parents(&job.execution.node))
                        .collect();
                    (jobs, runtime.root.clone(), parents)
                };
                if jobs.is_empty() && in_flight == 0 {
                    // PublicationStarted is durable before any user files change.
                    let publication = {
                        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                        if runtime.state.phase == "publishing" {
                            Some((
                                runtime.state.config.clone().ok_or("Missing config")?,
                                runtime.state.graph.original_goal.clone(),
                                runtime
                                    .state
                                    .publication
                                    .clone()
                                    .ok_or("Missing publication state")?,
                            ))
                        } else {
                            None
                        }
                    };
                    if let Some((config, query, publication)) = publication {
                        let repository = PathBuf::from(&publication.repository);
                        let result = crate::graph_merge::merge_graph(
                            &repository,
                            &publication.heads,
                            || {
                                let attempt = service
                                    .runtime
                                    .lock()
                                    .map_err(|e| e.to_string())?
                                    .state
                                    .mergers
                                    .len()
                                    + 1;
                                crate::graph_merge::resolve_with_merger(
                                    &repository,
                                    &query,
                                    &config,
                                    &root,
                                    attempt,
                                    |event| {
                                        service
                                            .runtime
                                            .lock()
                                            .map_err(|e| e.to_string())?
                                            .emit(event)
                                    },
                                )
                            },
                        );
                        let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
                        match result {
                            Ok(head) => runtime.emit(EventKind::PublicationCompleted { head })?,
                            Err(error) => runtime.emit(EventKind::PublicationFailed { error })?,
                        }
                    }
                    break;
                }
                in_flight += jobs.len();
                for (job, parents) in jobs.into_iter().zip(parents) {
                    let service = service.clone();
                    let root = root.clone();
                    let completed_tx = completed_tx.clone();
                    thread::spawn(move || {
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            perform(
                                &job,
                                &root,
                                &parents,
                                |text| {
                                    if let Ok(mut runtime) = service.runtime.lock() {
                                        if let Err(error) = runtime.emit(EventKind::Output {
                                            execution_id: job.execution.id.clone(),
                                            text,
                                        }) {
                                            eprintln!("Cannot persist Pi output: {error}");
                                        }
                                    }
                                },
                                |head| {
                                    service
                                        .runtime
                                        .lock()
                                        .map_err(|error| error.to_string())?
                                        .emit(EventKind::Prepared {
                                            execution_id: job.execution.id.clone(),
                                            head,
                                        })
                                },
                            )
                        }))
                        .unwrap_or_else(|_| Err("Execution worker panicked".into()));
                        let result = service
                            .runtime
                            .lock()
                            .map_err(|error| error.to_string())
                            .and_then(|mut runtime| runtime.finish(&job.execution, result));
                        let _ = completed_tx.send(result);
                    });
                }
                if in_flight > 0 {
                    let completed = completed_rx
                        .recv()
                        .map_err(|_| "Execution channel closed")?;
                    in_flight -= 1;
                    if let Some(feedback) = completed? {
                        feedback_results.push(feedback);
                    }
                }
                if in_flight == 0 {
                    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                    for (from, output) in feedback_results.drain(..) {
                        if runtime.state.nodes[&from].status == "done" {
                            runtime.apply_feedback(&from, &output)?;
                        }
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("Runtime halted safely: {error}");
            if let Ok(mut runtime) = service.runtime.lock() {
                if matches!(runtime.state.phase.as_str(), "publishing" | "merging") {
                    let _ = runtime.emit(EventKind::PublicationFailed { error });
                } else {
                    let _ = runtime.emit(EventKind::Paused { paused: true });
                }
            }
        }
        service.driving.store(false, Ordering::SeqCst);
        let resume = service
            .runtime
            .lock()
            .map(|runtime| {
                runtime.state.approved
                    && !runtime.state.paused
                    && runtime.state.phase == "running"
                    && !runtime.active()
            })
            .unwrap_or(false);
        if resume {
            drive(service.clone());
        }
    });
}

fn control(
    action: String,
    node: Option<String>,
    instruction: Option<String>,
    service: &Arc<Service>,
) -> Result<Snapshot, String> {
    if service.planning.load(Ordering::SeqCst) {
        return Err("Wait for planning to finish".into());
    }
    if matches!(
        action.as_str(),
        "intervene" | "resolve" | "retry_publication"
    ) && service.driving.load(Ordering::SeqCst)
    {
        return Err("Wait for active executions to finish before intervening".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    match action.as_str() {
        "retry_publication" => runtime.retry_publication()?,
        "approve" => runtime.approve()?,
        "pause" => runtime.pause(true)?,
        "resume" => runtime.pause(false)?,
        "reject" => {
            if runtime.state.phase != "awaiting_approval" {
                return Err("Only an unapproved plan can be rejected".into());
            }
            runtime.emit(EventKind::Rejected)?;
        }
        "intervene" => runtime.intervene(
            node.as_deref().unwrap_or_default(),
            instruction.as_deref().unwrap_or_default(),
        )?,
        "resolve" => runtime.resolved(node.as_deref().unwrap_or_default())?,
        "stop" | "cancel" => {
            crate::engine::terminate_all();
            if runtime.state.approved {
                let _ = runtime.pause(true);
            }
        }
        _ => return Err("Unknown action".into()),
    }
    let snapshot = runtime.state.clone();
    drop(runtime);
    if matches!(
        action.as_str(),
        "approve" | "resume" | "intervene" | "resolve" | "retry_publication"
    ) {
        drive(service.clone());
    }
    Ok(snapshot)
}

fn detect_repository(
    path: Option<String>,
) -> Result<Option<crate::workspace::RepositoryInfo>, String> {
    crate::workspace::detect(path.as_deref().map(std::path::Path::new))
}

fn reset_workspace(service: &Arc<Service>) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.reset_workspace()
}

fn clear_history(service: &Arc<Service>) -> Result<(), String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.clear_history()
}

fn delete_run(run_id: String, service: &Arc<Service>) -> Result<(), String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.delete_run(&run_id)
}

fn is_valid_planning_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !id.starts_with('.')
        && id != ".."
}

fn get_planning(planning_id: String, service: &Arc<Service>) -> Result<PlanningSummary, String> {
    if !is_valid_planning_id(&planning_id) {
        return Err(format!("Invalid planning ID: {planning_id}"));
    }
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    let planning_dir = runtime.root.join("planning");
    let summary_path = planning_dir.join(&planning_id).join("summary.json");
    if let Ok(canonical_summary) = summary_path.canonicalize() {
        if let Ok(canonical_planning_dir) = planning_dir.canonicalize() {
            if !canonical_summary.starts_with(&canonical_planning_dir) {
                return Err(format!(
                    "Invalid planning ID: path traversal detected: {planning_id}"
                ));
            }
        }
    }
    if summary_path.exists() {
        let content = fs::read_to_string(&summary_path).map_err(|error| error.to_string())?;
        let mut summary =
            serde_json::from_str::<PlanningSummary>(&content).map_err(|error| error.to_string())?;
        if summary.repository.is_none() {
            if let Some(repo) = runtime
                .store
                .find_repository_by_planning_id(&summary.planning_id)
            {
                summary.repository = Some(repo);
                if let Ok(migrated_json) = serde_json::to_string_pretty(&summary) {
                    let _ = fs::write(&summary_path, migrated_json);
                }
            }
        }
        Ok(summary)
    } else {
        Err(format!("Planning summary not found: {planning_id}"))
    }
}

// Planning traces are loaded only when opened in the UI. Keep raw model output
// out of bootstrap/list/poll responses and cap each UTF-8-safe page.
fn get_planning_output(
    planning_id: String,
    role: String,
    offset: u64,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    if !is_valid_planning_id(&planning_id) {
        return Err("Invalid planning ID".into());
    }
    if !matches!(role.as_str(), "partition" | "planner") {
        return Err("Invalid planning role".into());
    }
    let root = service
        .runtime
        .lock()
        .map_err(|e| e.to_string())?
        .root
        .join("planning");
    let root = root
        .canonicalize()
        .map_err(|_| "Planning output not found")?;
    let directory = root
        .join(&planning_id)
        .canonicalize()
        .map_err(|_| "Planning output not found")?;
    if !directory.starts_with(&root) {
        return Err("Invalid planning output path".into());
    }
    let running = fs::read(directory.join("summary.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PlanningSummary>(&bytes).ok())
        .is_some_and(|summary| summary.status.as_deref() == Some("running"));
    let file_path = directory.join(format!("{role}.jsonl"));
    if !file_path.exists() && running && offset == 0 {
        return Ok(
            serde_json::json!({ "planningId": planning_id, "role": role, "content": "",
            "nextOffset": 0, "totalBytes": 0, "complete": true, "running": true }),
        );
    }
    let file_path = file_path
        .canonicalize()
        .map_err(|_| "Planning output not found")?;
    if !file_path.starts_with(&root) {
        return Err("Invalid planning output path".into());
    }
    let mut file = fs::File::open(file_path).map_err(|e| e.to_string())?;
    let total_bytes = file.metadata().map_err(|e| e.to_string())?.len();
    if offset > total_bytes {
        return Err("Invalid planning output offset".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(256 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let length = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => return Err("Invalid planning output UTF-8 offset".into()),
    };
    let content = std::str::from_utf8(&bytes[..length]).map_err(|e| e.to_string())?;
    let next_offset = offset + length as u64;
    Ok(serde_json::json!({ "planningId": planning_id, "role": role,
        "content": content, "nextOffset": next_offset, "totalBytes": total_bytes,
        "complete": next_offset >= total_bytes, "running": running }))
}

fn list_plannings(
    service: &Arc<Service>,
    repository_filter: Option<String>,
) -> Result<Vec<PlanningSummary>, String> {
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    let planning_dir = runtime.root.join("planning");
    if !planning_dir.exists() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    if let Ok(entries) = fs::read_dir(planning_dir) {
        for entry in entries.flatten() {
            let summary_path = entry.path().join("summary.json");
            if summary_path.exists() {
                if let Ok(content) = fs::read_to_string(&summary_path) {
                    if let Ok(mut summary) = serde_json::from_str::<PlanningSummary>(&content) {
                        // If repository is missing, attempt to backfill from associated run in event store
                        if summary.repository.is_none() {
                            if let Some(repo) = runtime
                                .store
                                .find_repository_by_planning_id(&summary.planning_id)
                            {
                                summary.repository = Some(repo);
                                if let Ok(migrated_json) = serde_json::to_string_pretty(&summary) {
                                    let _ = fs::write(&summary_path, migrated_json);
                                }
                            }
                        }

                        // Filter by repository if requested (fail closed)
                        if let Some(ref repo) = repository_filter {
                            let filter = repo.trim();
                            if !filter.is_empty() {
                                match &summary.repository {
                                    Some(summary_repo) if summary_repo == filter => {}
                                    _ => continue, // Fail closed: reject mismatched or unattributed summaries
                                }
                            }
                        }
                        summaries.push(summary);
                    }
                }
            }
        }
    }
    summaries.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.planning_id.cmp(&a.planning_id))
    });
    Ok(summaries)
}

fn argument<T: serde::de::DeserializeOwned>(
    body: &serde_json::Value,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(body.get(key).cloned().unwrap_or(serde_json::Value::Null))
        .map_err(|error| format!("Invalid {key}: {error}"))
}

fn get_execution_output(
    body: &serde_json::Value,
    service: &Arc<Service>,
) -> Result<serde_json::Value, String> {
    let run_id: String = argument(body, "runId")?;
    let execution_id: String = argument(body, "executionId")?;
    let offset: usize = body
        .get("offset")
        .map(|_| argument(body, "offset"))
        .transpose()?
        .unwrap_or(0);
    let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
    let historical;
    let state = if runtime.state.run_id == run_id {
        &runtime.state
    } else {
        historical = runtime.store.load(&run_id)?;
        &historical
    };
    execution_page(state, &execution_id, offset)
}

pub fn dispatch(
    service: &Arc<Service>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::to_value;
    let compact = body
        .get("compact")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let metadata = body.get("detail").and_then(serde_json::Value::as_str) == Some("metadata");
    if command == "snapshot" && metadata {
        let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
        return snapshot_metadata(&runtime.state);
    }
    if command == "history" && metadata {
        return snapshot_metadata(&history(argument(&body, "runId")?, service)?);
    }
    let result = match command {
        "provider_auth" => to_value(crate::provider_auth::request(body)?),
        "bootstrap" => to_value(bootstrap(service, metadata)?),
        "snapshot" => to_value(snapshot(service)?),
        "history" => to_value(history(argument(&body, "runId")?, service)?),
        "load_run" => to_value(load_run(argument(&body, "runId")?, service)?),
        "compile_graph" => to_value(
            compile_graph(argument(&body, "graph")?)
                .map_err(|errors| serde_json::to_string(&errors).unwrap())?,
        ),
        "save_graph" => to_value(save_graph(
            argument(&body, "graph")?,
            argument(&body, "config")?,
            service,
        )?),
        "plan_goal" => to_value(plan_goal(
            argument(&body, "goal")?,
            argument(&body, "config")?,
            service,
        )?),
        "get_execution_output" => return get_execution_output(&body, service),
        "get_planning_snapshot" => {
            let id: String = argument(&body, "planningId")?;
            let repository: String = argument(&body, "repository")?;
            let runtime = service.runtime.lock().map_err(|e| e.to_string())?;
            let state = if runtime.state.planning_id.as_ref() == Some(&id) {
                snapshot_metadata(&runtime.state)?
            } else {
                let run = runtime
                    .store
                    .runs()?
                    .into_iter()
                    .find_map(|run| {
                        let state = runtime.store.load(&run).ok()?;
                        (state.planning_id.as_ref() == Some(&id)).then_some(state)
                    })
                    .ok_or("Planning run not found")?;
                snapshot_metadata(&run)?
            };
            if state["config"]["repository"].as_str() != Some(repository.as_str()) {
                return Err("Planning repository mismatch".into());
            }
            return Ok(state);
        }
        "get_planning_output" => to_value(get_planning_output(
            argument(&body, "planningId")?,
            argument(&body, "role")?,
            body.get("offset")
                .map(|_| argument(&body, "offset"))
                .transpose()?
                .unwrap_or(0),
            service,
        )?),
        "get_planning" => to_value(get_planning(argument(&body, "planningId")?, service)?),
        "list_plannings" => to_value(list_plannings(service, argument(&body, "repository").ok())?),
        "control" => to_value(control(
            argument(&body, "action")?,
            argument(&body, "node")?,
            argument(&body, "instruction")?,
            service,
        )?),
        "repository_status" => {
            let repository: String = argument(&body, "repository")?;
            let error = crate::workspace::validate_binding(std::path::Path::new(&repository)).err();
            Ok(serde_json::json!({ "repository": repository, "valid": error.is_none(), "error": error }))
        }
        "detect_repository" => to_value(detect_repository(argument(&body, "path")?)?),
        "pick_repository" => to_value(crate::workspace::pick_repository()?),
        "reset_workspace" => to_value(reset_workspace(service)?),
        "clear_history" => to_value(clear_history(service)?),
        "delete_run" => to_value(delete_run(argument(&body, "runId")?, service)?),
        _ => return Err("Unknown command".into()),
    };
    let mut value = result.map_err(|error| error.to_string())?;
    if metadata && command != "bootstrap" {
        let target = if value.get("executions").is_some() {
            Some(&mut value)
        } else {
            None
        };
        if let Some(target) = target {
            let state: Snapshot =
                serde_json::from_value(target.take()).map_err(|e| e.to_string())?;
            *target = snapshot_metadata(&state)?;
        }
    }
    // UI transcripts already live on executions/mergers. Avoid sending every
    // raw Output frame a second time on each poll; the durable event store and
    // default API responses retain the complete history for replay/export.
    if compact {
        let snapshot = if command == "bootstrap" {
            value.get_mut("snapshot")
        } else if matches!(
            command,
            "snapshot"
                | "history"
                | "load_run"
                | "save_graph"
                | "plan_goal"
                | "control"
                | "reset_workspace"
        ) {
            Some(&mut value)
        } else {
            None
        };
        if let Some(events) = snapshot
            .and_then(|snapshot| snapshot.get_mut("events"))
            .and_then(serde_json::Value::as_array_mut)
        {
            events.retain(|event| {
                event.get("type").and_then(serde_json::Value::as_str) != Some("output")
            });
        }
    }
    Ok(value)
}

struct SseStreamReceiver {
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    current: Vec<u8>,
    pos: usize,
}

impl std::io::Read for SseStreamReceiver {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos < self.current.len() {
            let n = (self.current.len() - self.pos).min(buf.len());
            buf[..n].copy_from_slice(&self.current[self.pos..self.pos + n]);
            self.pos += n;
            return Ok(n);
        }
        match self.rx.recv() {
            Ok(bytes) => {
                if bytes.is_empty() {
                    return Ok(0);
                }
                let n = bytes.len().min(buf.len());
                buf[..n].copy_from_slice(&bytes[..n]);
                if n < bytes.len() {
                    self.current = bytes;
                    self.pos = n;
                } else {
                    self.current.clear();
                    self.pos = 0;
                }
                Ok(n)
            }
            Err(_) => Ok(0),
        }
    }
}

fn send_sse_event(tx: &std::sync::mpsc::Sender<Vec<u8>>, event: &str, data: &serde_json::Value) {
    let payload = format!("event: {event}\ndata: {}\n\n", data);
    let _ = tx.send(payload.into_bytes());
}

pub fn run() -> Result<(), String> {
    use tiny_http::{Header, Response, Server};
    load_env_file();
    let root = std::env::var_os("GRAPHER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.grapher"));
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let extension = root.join("grapher-planner.ts");
    fs::write(&extension, include_str!("../resources/planner.ts"))
        .map_err(|error| error.to_string())?;
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open(&root)?),
        driving: AtomicBool::new(false),
        planning: AtomicBool::new(false),
        extension,
    });
    #[cfg(not(feature = "fixture"))]
    crate::native::check_retired_leases(&root)?;
    recover_plannings(&root)?;
    let port: u16 = std::env::var("GRAPHER_PORT")
        .unwrap_or_else(|_| "1421".into())
        .parse()
        .map_err(|_| "Invalid GRAPHER_PORT")?;
    let server = Server::http(("127.0.0.1", port)).map_err(|error| error.to_string())?;
    let mut signals = signal_hook::iterator::Signals::new([
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
    ])
    .map_err(|error| error.to_string())?;
    let shutdown_service = service.clone();
    thread::spawn(move || {
        if signals.forever().next().is_some() {
            if let Ok(mut runtime) = shutdown_service.runtime.lock() {
                if matches!(runtime.state.phase.as_str(), "publishing" | "merging") {
                    let _ = runtime.emit(EventKind::PublicationFailed {
                        error: "Backend stopped during publication; inspect and retry publication."
                            .into(),
                    });
                } else if runtime.state.approved
                    && (runtime.active() || runtime.state.phase == "running")
                {
                    let _ = runtime.emit(EventKind::Paused { paused: true });
                }
            }
            crate::engine::terminate_all();
            crate::provider_auth::shutdown();
            std::process::exit(0);
        }
    });
    eprintln!(
        "Grapher backend: http://127.0.0.1:{port} (data: {})",
        root.display()
    );
    let web_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    for mut request in server.incoming_requests() {
        let service = service.clone();
        let web_root = web_root.clone();
        thread::spawn(move || {
            let trusted_hosts = [
                format!("127.0.0.1:{port}"),
                format!("localhost:{port}"),
                "127.0.0.1:1420".into(),
                "localhost:1420".into(),
            ];
            let trusted = request
                .headers()
                .iter()
                .filter(|h| h.field.equiv("Host") || h.field.equiv("Origin"))
                .all(|h| {
                    let value = h.value.as_str();
                    let host = if h.field.equiv("Origin") {
                        value.strip_prefix("http://").unwrap_or("")
                    } else {
                        value
                    };
                    trusted_hosts.iter().any(|allowed| allowed == host)
                });
            if !trusted {
                let _ = request
                    .respond(Response::from_string("Untrusted origin").with_status_code(403));
                return;
            }
            let url = request.url().split('?').next().unwrap_or("/").to_string();
            if let Some(command) = url.strip_prefix("/api/") {
                // JSON-only requests and no CORS prevent other websites from issuing commands.
                let is_json = request.headers().iter().any(|h| {
                    h.field.equiv("Content-Type")
                        && h.value.as_str().split(';').next() == Some("application/json")
                });
                if request.method() != &tiny_http::Method::Post || !is_json {
                    let _ = request
                        .respond(Response::from_string("JSON POST required").with_status_code(415));
                    return;
                }

                if command == "plan_goal_stream" {
                    let mut input = String::new();
                    let body_res = std::io::Read::read_to_string(
                        &mut request.as_reader().take(10 * 1024 * 1024 + 1),
                        &mut input,
                    )
                    .map_err(|e| e.to_string())
                    .and_then(|_| {
                        serde_json::from_str::<serde_json::Value>(&input).map_err(|e| e.to_string())
                    });

                    let (goal, config): (String, Config) = match body_res.and_then(|body| {
                        let goal: String = argument(&body, "goal")?;
                        let config: Config = argument(&body, "config")?;
                        Ok((goal, config))
                    }) {
                        Ok(pair) => pair,
                        Err(err) => {
                            let _ = request.respond(
                                Response::from_string(
                                    serde_json::json!({"error": err}).to_string(),
                                )
                                .with_status_code(400)
                                .with_header(
                                    Header::from_bytes("Content-Type", "application/json").unwrap(),
                                ),
                            );
                            return;
                        }
                    };

                    let (tx, rx) = std::sync::mpsc::channel();
                    let service_clone = service.clone();

                    thread::spawn(move || {
                        let tx_part = tx.clone();
                        let tx_route = tx.clone();
                        let tx_plan = tx.clone();
                        let result = plan_goal_internal(
                            goal,
                            config,
                            &service_clone,
                            |line| {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line)
                                {
                                    send_sse_event(
                                        &tx_part,
                                        "partitioner",
                                        &serde_json::json!({ "raw": line, "event": parsed }),
                                    );
                                } else {
                                    send_sse_event(
                                        &tx_part,
                                        "partitioner",
                                        &serde_json::json!({ "raw": line }),
                                    );
                                }
                            },
                            |route| {
                                send_sse_event(
                                    &tx_route,
                                    "route_decision",
                                    &serde_json::json!({ "planType": route.plan_type }),
                                );
                            },
                            |line| {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line)
                                {
                                    send_sse_event(
                                        &tx_plan,
                                        "planner",
                                        &serde_json::json!({ "raw": line, "event": parsed }),
                                    );
                                } else {
                                    send_sse_event(
                                        &tx_plan,
                                        "planner",
                                        &serde_json::json!({ "raw": line }),
                                    );
                                }
                            },
                        );

                        match result {
                            Ok(snapshot) => {
                                send_sse_event(
                                    &tx,
                                    "complete",
                                    &serde_json::json!({ "snapshot": snapshot }),
                                );
                            }
                            Err((err, summary)) => {
                                let mut err_payload = serde_json::json!({ "error": err });
                                if let Some(s) = summary {
                                    err_payload["planningId"] = serde_json::json!(s.planning_id);
                                    err_payload["summary"] = serde_json::json!(s);
                                }
                                send_sse_event(&tx, "error", &err_payload);
                            }
                        }
                        let _ = tx.send(Vec::new());
                    });

                    let stream = SseStreamReceiver {
                        rx,
                        current: Vec::new(),
                        pos: 0,
                    };
                    let response = Response::empty(200)
                        .with_data(stream, None)
                        .with_header(
                            Header::from_bytes("Content-Type", "text/event-stream").unwrap(),
                        )
                        .with_header(Header::from_bytes("Cache-Control", "no-cache").unwrap())
                        .with_header(Header::from_bytes("Connection", "keep-alive").unwrap())
                        .with_header(Header::from_bytes("X-Accel-Buffering", "no").unwrap());
                    let _ = request.respond(response);
                    return;
                }

                let mut input = String::new();
                let result = std::io::Read::read_to_string(
                    &mut request.as_reader().take(10 * 1024 * 1024 + 1),
                    &mut input,
                )
                .map_err(|e| e.to_string())
                .and_then(|_| {
                    if input.len() > 10 * 1024 * 1024 {
                        return Err("Request too large".into());
                    }
                    let body = serde_json::from_str(&input).map_err(|e| e.to_string())?;
                    dispatch(&service, command, body)
                });
                let (status, body) = match result {
                    Ok(value) => (200, serde_json::json!({"result": value})),
                    Err(error) => (400, serde_json::json!({"error": error})),
                };
                let _ = request.respond(
                    Response::from_string(body.to_string())
                        .with_status_code(status)
                        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
                        .with_header(
                            Header::from_bytes("Content-Type", "application/json").unwrap(),
                        ),
                );
            } else {
                let relative = url.trim_start_matches('/');
                if relative.split('/').any(|part| part == "..") {
                    let _ = request.respond(Response::empty(404));
                    return;
                }
                let path = web_root.join(if relative.is_empty() {
                    "index.html"
                } else {
                    relative
                });
                let mime = match path.extension().and_then(|s| s.to_str()) {
                    Some("html") => "text/html; charset=utf-8",
                    Some("js") => "text/javascript",
                    Some("css") => "text/css",
                    Some("svg") => "image/svg+xml",
                    _ => "application/octet-stream",
                };
                match fs::read(path) {
                    Ok(bytes) => {
                        let _ =
                            request
                                .respond(Response::from_data(bytes).with_header(
                                    Header::from_bytes("Content-Type", mime).unwrap(),
                                ));
                    }
                    Err(_) => {
                        let _ = request.respond(
                            Response::from_string("Run npm run build to build the frontend")
                                .with_status_code(404),
                        );
                    }
                }
            }
        });
    }
    Ok(())
}

#[cfg(feature = "benchmark")]
pub mod benchmark {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../grapher-tests/benchmark/server.rs"
    ));
}
