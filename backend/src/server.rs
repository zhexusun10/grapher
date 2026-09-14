use crate::{
    compiler,
    engine::{parse_route_decision, run_pi, PiModelConfig, PiRequest, PiRole},
    model::*,
    runtime::{perform, Runtime},
};
use serde::Serialize;
use std::{
    fs,
    io::Read,
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
    snapshot: Snapshot,
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
            driving: AtomicBool::new(false), planning: AtomicBool::new(false),
            extension: temp.path().join("unused.ts"),
        });
        let before = service.runtime.lock().unwrap().state.run_id.clone();
        let result = plan_goal_internal("Build two modules".into(), Config {
            repository: repo.to_string_lossy().into(), engine: "pi".into(),
            pi_command: "/bin/sh".into(), pi_args: vec![script.to_string_lossy().into()],
            model: String::new(), max_parallel: 2, max_feedback: 3,
        }, &service, |_| {}, |_| panic!("Failure must not emit a route"), |_| {});
        assert!(result.unwrap_err().0.contains("Partitioner failed"));
        let runtime = service.runtime.lock().unwrap();
        assert_eq!(runtime.state.run_id, before);
        assert!(runtime.state.executions.is_empty());
        assert!(!runtime.state.approved);
        assert!(!service.planning.load(Ordering::SeqCst));
        let directory = fs::read_dir(root.join("planning")).unwrap().next().unwrap().unwrap().path();
        assert!(fs::read_to_string(directory.join("partition.jsonl")).unwrap().contains("provider unavailable"));
        assert!(!directory.join("route.json").exists());
        let summary_content = fs::read_to_string(directory.join("summary.json")).unwrap();
        let failure_summary: PlanningSummary = serde_json::from_str(&summary_content).unwrap();
        assert_eq!(failure_summary.status.as_deref(), Some("failed"));
        assert!(failure_summary.roles.contains_key("partition"));
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
            max_parallel: 2,
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

    #[cfg(feature = "fixture")]
    #[test]
    fn completed_graph_is_published_by_driver() {
        let temp = tempfile::TempDir::new().unwrap();
        let mut runtime = Runtime::open(temp.path()).unwrap();
        let config = Config {
            repository: String::new(), engine: "fixture".into(),
            pi_command: String::new(), pi_args: Vec::new(), model: String::new(),
            max_parallel: 2, max_feedback: 1,
        };
        runtime.create(Graph {
            original_goal: "Publish both independent outcomes".into(),
            nodes: vec![Node { name: "first".into(), task: "First".into() },
                Node { name: "last".into(), task: "Last".into() }], edges: Vec::new(),
        }, config).unwrap();
        runtime.approve().unwrap();
        let service = Arc::new(Service { runtime: Mutex::new(runtime),
            driving: AtomicBool::new(false), planning: AtomicBool::new(false),
            extension: temp.path().join("unused-extension.ts") });
        drive(service.clone());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while service.driving.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline, "Driver did not settle");
            thread::sleep(std::time::Duration::from_millis(20));
        }
        let runtime = service.runtime.lock().unwrap();
        assert_eq!(runtime.state.phase, "completed");
        let source = temp.path().join("fixture-repository");
        assert!(source.join("first.md").exists());
        assert!(source.join("last.md").exists());
        assert!(crate::workspace::git(&source, &["status", "--porcelain"]).unwrap().is_empty());
    }

    #[test]
    fn planning_prompts_separate_user_query_from_system() {
        for template in [PLANNER_PROMPT, PARTITIONER_PROMPT] {
            let (system, query) = split_prompt_template(template);
            assert!(!system.contains("{{query}}"));
            assert!(!system.contains("Goal:"));
            assert_eq!(query, "{{query}}");
            assert_eq!(render_prompt(query, &[("query", "Build a graph")]), "Build a graph");
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

fn bootstrap(service: &Arc<Service>) -> Result<Bootstrap, String> {
    load_env_file();
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    #[cfg(feature = "fixture")]
    let entrypoint = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../engine/entrypoint.mjs");
    let detected_repo = crate::workspace::detect(None).ok().flatten();
    let mut config = runtime.state.config.clone().unwrap_or(Config {
        repository: detected_repo
            .as_ref()
            .map(|r| r.path.clone())
            .unwrap_or_default(),
        model: "qwen3.8-flash".into(),
        max_parallel: 2,
        max_feedback: 3,
        #[cfg(feature = "fixture")]
        engine: "pi".into(),
        #[cfg(feature = "fixture")]
        pi_command: "node".into(),
        #[cfg(feature = "fixture")]
        pi_args: vec![entrypoint.to_string_lossy().into()],
    });
    if config.model.trim().is_empty() {
        config.model = "qwen3.8-flash".into();
    }
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
        snapshot: runtime.state.clone(),
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

fn save_graph(graph: Graph, mut config: Config, service: &Arc<Service>) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    if config.model.trim().is_empty() {
        config.model = "qwen3.8-flash".into();
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.create(graph, config)?;
    Ok(runtime.state.clone())
}

pub fn parse_planning_role_metrics(
    model: &str,
    log: &str,
) -> PlanningRoleMetrics {
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
            match value.get("type").and_then(|v| v.as_str()).unwrap_or_default() {
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
                                usage.input += u.get("input").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.output += u.get("output").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.cache_read += u.get("cacheRead").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.cache_write += u.get("cacheWrite").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.reasoning += u.get("reasoning").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                usage.total_tokens += u.get("totalTokens").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                            }
                        }
                    }
                }
                "tool_execution_start" => {
                    tools += 1;
                }
                "tool_execution_end" => {
                    if value.get("isError").and_then(|v| v.as_bool()).unwrap_or(false) {
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
        return Err(("Automatic planning requires the Execution Instance Engine".into(), None));
    }
    if service.driving.load(Ordering::SeqCst) || service.planning.swap(true, Ordering::SeqCst) {
        return Err(("Another operation is running".into(), None));
    }
    let service = service.clone();
    let cleanup = service.clone();
    let result = (move || {
        let planning_start = std::time::Instant::now();
        let root = service
            .runtime
            .lock()
            .map_err(|error| (error.to_string(), None))?
            .root
            .clone();
        let repository = PathBuf::from(&config.repository);
        crate::workspace::verify(&repository).map_err(|error| (error, None))?;
        let planning_id = Uuid::new_v4().to_string();
        let directory = root.join("planning").join(&planning_id);
        fs::create_dir_all(&directory).map_err(|error| (error.to_string(), None))?;
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
                log.push_str(&text);
                on_partitioner_line(&text);
            },
        );
        let partition_wall_sec = partition_start.elapsed().as_secs_f64();
        fs::write(directory.join("partition.jsonl"), &log).map_err(|error| error.to_string())?;
        let mut partition_metrics = parse_planning_role_metrics(&partitioner_config.model, &log);
        if partition_metrics.duration_seconds == 0.0 {
            partition_metrics.duration_seconds = partition_wall_sec;
        }
        // A failed engine call is not a routing decision. In particular, do not
        // turn authentication/provider failures into an auto-approved serial run.
        let output = partition_result.map_err(|error| format!("Partitioner failed: {error}"))?;
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
                        log.push_str(&text);
                        on_planner_line(&text);
                    },
                );
                let planner_wall_sec = planner_start.elapsed().as_secs_f64();
                fs::write(directory.join("planner.jsonl"), &log)
                    .map_err(|error| error.to_string())?;
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
            + planner_metrics.as_ref().map(|p| p.duration_seconds).unwrap_or(0.0);
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
        };
        if let Ok(summary_json) = serde_json::to_string_pretty(&summary) {
            let _ = fs::write(directory.join("summary.json"), &summary_json);
            let _ = fs::write(directory.join("metrics.json"), &summary_json);
        }

        #[allow(unused_mut)]
        let mut final_config = config.clone();
        #[cfg(not(feature = "fixture"))]
        if final_config.model.trim().is_empty() {
            final_config.model = "qwen3.8-flash".into();
        }
        let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        runtime.create_with_planning(graph, final_config, Some(planning_id.clone()), Some(summary))?;
        if route.plan_type == "serial" {
            runtime.approve()?;
        }
        let snapshot = runtime.state.clone();
        drop(runtime);
        if route.plan_type == "serial" {
            drive(service.clone());
        }
        Ok(snapshot)
        })();
        match plan_outcome {
            Ok(snapshot) => Ok(snapshot),
            Err(err) => {
                let mut roles: std::collections::BTreeMap<String, PlanningRoleMetrics> = Default::default();
                let mut model_duration = 0.0;
                let partition_file = directory.join("partition.jsonl");
                if partition_file.exists() {
                    if let Ok(content) = fs::read_to_string(&partition_file) {
                        let partitioner_model_cfg = PiModelConfig::resolve(PiRole::Partitioner, &config);
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
                };
                if let Ok(failure_json) = serde_json::to_string_pretty(&failure_summary) {
                    let _ = fs::write(directory.join("summary.json"), &failure_json);
                    let _ = fs::write(directory.join("metrics.json"), &failure_json);
                }
                Err((err, Some(failure_summary)))
            }
        }
    })();
    cleanup.planning.store(false, Ordering::SeqCst);
    result
}

fn plan_goal(goal: String, config: Config, service: &Arc<Service>) -> Result<Snapshot, String> {
    plan_goal_internal(goal, config, service, |_| {}, |_| {}, |_| {})
        .map_err(|(error, _)| error)
}

fn drive(service: Arc<Service>) {
    if service.driving.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            loop {
                let (jobs, root, parents) = {
                    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                    let jobs = runtime.jobs()?;
                    let parents: Vec<_> = jobs
                        .iter()
                        .map(|job| runtime.parents(&job.execution.node))
                        .collect();
                    (jobs, runtime.root.clone(), parents)
                };
                if jobs.is_empty() {
                    // PublicationStarted is durable before any user files change.
                    let publication = {
                        let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                        if runtime.state.phase == "publishing" {
                            Some((runtime.state.config.clone().ok_or("Missing config")?,
                                runtime.state.graph.original_goal.clone(),
                                runtime.state.publication.clone().ok_or("Missing publication state")?))
                        } else { None }
                    };
                    if let Some((config, query, publication)) = publication {
                        let repository = PathBuf::from(&publication.repository);
                        let result = crate::graph_merge::merge_graph(&repository, &publication.heads, || {
                            let attempt = service.runtime.lock().map_err(|e| e.to_string())?.state.mergers.len() + 1;
                            crate::graph_merge::resolve_with_merger(&repository, &query, &config, &root, attempt,
                                |event| service.runtime.lock().map_err(|e| e.to_string())?.emit(event))
                        });
                        let mut runtime = service.runtime.lock().map_err(|e| e.to_string())?;
                        match result {
                            Ok(head) => runtime.emit(EventKind::PublicationCompleted { head })?,
                            Err(error) => runtime.emit(EventKind::PublicationFailed { error })?,
                        }
                    }
                    break;
                }
                let handles: Vec<_> = jobs
                    .into_iter()
                    .zip(parents)
                    .map(|(job, parents)| {
                        let service = service.clone();
                        let root = root.clone();
                        thread::spawn(move || {
                            let result = perform(
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
                            );
                            (job.execution, result)
                        })
                    })
                    .collect();
                let mut reviews = Vec::new();
                for handle in handles {
                    let (execution, result) =
                        handle.join().map_err(|_| "Execution worker panicked")?;
                    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                    if let Some(review) = runtime.finish(&execution, result)? {
                        reviews.push(review);
                    }
                }
                let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
                for (from, output) in reviews {
                    if runtime.state.nodes[&from].status == "done" {
                        runtime.review(&from, &output)?;
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
    if matches!(action.as_str(), "intervene" | "resolve" | "retry_publication") && service.driving.load(Ordering::SeqCst)
    {
        return Err("Pause and wait for the current execution wave to settle first".into());
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

fn get_planning(planning_id: String, service: &Arc<Service>) -> Result<PlanningSummary, String> {
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    let summary_path = runtime.root.join("planning").join(&planning_id).join("summary.json");
    if summary_path.exists() {
        let content = fs::read_to_string(&summary_path).map_err(|error| error.to_string())?;
        serde_json::from_str(&content).map_err(|error| error.to_string())
    } else {
        Err(format!("Planning summary not found: {planning_id}"))
    }
}

fn list_plannings(service: &Arc<Service>) -> Result<Vec<PlanningSummary>, String> {
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
                    if let Ok(summary) = serde_json::from_str::<PlanningSummary>(&content) {
                        summaries.push(summary);
                    }
                }
            }
        }
    }
    summaries.sort_by(|a, b| b.planning_id.cmp(&a.planning_id));
    Ok(summaries)
}

fn argument<T: serde::de::DeserializeOwned>(
    body: &serde_json::Value,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(body.get(key).cloned().unwrap_or(serde_json::Value::Null))
        .map_err(|error| format!("Invalid {key}: {error}"))
}

pub fn dispatch(
    service: &Arc<Service>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::to_value;
    let result = match command {
        "provider_auth" => to_value(crate::provider_auth::request(body)?),
        "bootstrap" => to_value(bootstrap(service)?),
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
        "get_planning" => to_value(get_planning(argument(&body, "planningId")?, service)?),
        "list_plannings" => to_value(list_plannings(service)?),
        "control" => to_value(control(
            argument(&body, "action")?,
            argument(&body, "node")?,
            argument(&body, "instruction")?,
            service,
        )?),
        "detect_repository" => to_value(detect_repository(argument(&body, "path")?)?),
        "pick_repository" => to_value(crate::workspace::pick_repository()?),
        "reset_workspace" => to_value(reset_workspace(service)?),
        "clear_history" => to_value(clear_history(service)?),
        "delete_run" => to_value(delete_run(argument(&body, "runId")?, service)?),
        _ => return Err("Unknown command".into()),
    };
    result.map_err(|error| error.to_string())
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
    fs::write(root.join("planning-inspection.mjs"), include_str!("../resources/planning-inspection.mjs"))
        .map_err(|error| error.to_string())?;
    let service = Arc::new(Service {
        runtime: Mutex::new(Runtime::open(&root)?),
        driving: AtomicBool::new(false),
        planning: AtomicBool::new(false),
        extension,
    });
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
                    let _ = runtime.emit(EventKind::PublicationFailed { error: "Backend stopped during publication; inspect and retry publication.".into() });
                } else if runtime.state.approved && (runtime.active() || runtime.state.phase == "running")
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
                        &mut request.as_reader().take(2 * 1024 * 1024 + 1),
                        &mut input,
                    )
                    .map_err(|e| e.to_string())
                    .and_then(|_| serde_json::from_str::<serde_json::Value>(&input).map_err(|e| e.to_string()));

                    let (goal, config): (String, Config) = match body_res.and_then(|body| {
                        let goal: String = argument(&body, "goal")?;
                        let config: Config = argument(&body, "config")?;
                        Ok((goal, config))
                    }) {
                        Ok(pair) => pair,
                        Err(err) => {
                            let _ = request.respond(
                                Response::from_string(serde_json::json!({"error": err}).to_string())
                                    .with_status_code(400)
                                    .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
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
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                                    send_sse_event(&tx_part, "partitioner", &serde_json::json!({ "raw": line, "event": parsed }));
                                } else {
                                    send_sse_event(&tx_part, "partitioner", &serde_json::json!({ "raw": line }));
                                }
                            },
                            |route| {
                                send_sse_event(&tx_route, "route_decision", &serde_json::json!({ "planType": route.plan_type }));
                            },
                            |line| {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                                    send_sse_event(&tx_plan, "planner", &serde_json::json!({ "raw": line, "event": parsed }));
                                } else {
                                    send_sse_event(&tx_plan, "planner", &serde_json::json!({ "raw": line }));
                                }
                            },
                        );

                        match result {
                            Ok(snapshot) => {
                                send_sse_event(&tx, "complete", &serde_json::json!({ "snapshot": snapshot }));
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
                        .with_header(Header::from_bytes("Content-Type", "text/event-stream").unwrap())
                        .with_header(Header::from_bytes("Cache-Control", "no-cache").unwrap())
                        .with_header(Header::from_bytes("Connection", "keep-alive").unwrap())
                        .with_header(Header::from_bytes("X-Accel-Buffering", "no").unwrap());
                    let _ = request.respond(response);
                    return;
                }

                let mut input = String::new();
                let result = std::io::Read::read_to_string(
                    &mut request.as_reader().take(2 * 1024 * 1024 + 1),
                    &mut input,
                )
                .map_err(|e| e.to_string())
                .and_then(|_| {
                    if input.len() > 2 * 1024 * 1024 {
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
    include!("../../benchmark/server.rs");
}
