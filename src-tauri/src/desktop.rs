use crate::{
    compiler,
    engine::{run_pi, PiRequest},
    model::*,
    runtime::{perform, Runtime},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{Manager, State};
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

#[derive(Deserialize)]
pub struct Route {
    plan_type: String,
}

const PARTITIONER_PROMPT: &str = include_str!("../resources/prompts/partitioner.md");
const PLANNER_PROMPT: &str = include_str!("../resources/prompts/planner.md");

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

#[tauri::command]
fn bootstrap(service: State<'_, Arc<Service>>) -> Result<Bootstrap, String> {
    let runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("pi");
    let local = source.join("node_modules/.bin/tsx").exists();
    let detected_repo = crate::workspace::detect(None).ok().flatten();
    let mut config = runtime.state.config.clone().unwrap_or(Config {
        repository: detected_repo
            .as_ref()
            .map(|r| r.path.clone())
            .unwrap_or_default(),
        engine: "pi".into(),
        pi_command: if local {
            "/opt/homebrew/bin/node"
        } else {
            "pi"
        }
        .into(),
        pi_args: if local {
            vec![
                source
                    .join("node_modules/tsx/dist/cli.mjs")
                    .to_string_lossy()
                    .into(),
                "--tsconfig".into(),
                source.join("tsconfig.json").to_string_lossy().into(),
                source
                    .join("packages/coding-agent/src/cli.ts")
                    .to_string_lossy()
                    .into(),
            ]
        } else {
            Vec::new()
        },
        model: String::new(),
        max_parallel: 2,
        max_feedback: 3,
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
        snapshot: runtime.state.clone(),
        config,
        runs: runtime.store.runs()?,
        data_path: runtime.root.to_string_lossy().into(),
        repository_info,
    })
}

#[tauri::command]
fn snapshot(service: State<'_, Arc<Service>>) -> Result<Snapshot, String> {
    Ok(service
        .runtime
        .lock()
        .map_err(|error| error.to_string())?
        .state
        .clone())
}

#[tauri::command]
fn history(run_id: String, service: State<'_, Arc<Service>>) -> Result<Snapshot, String> {
    service
        .runtime
        .lock()
        .map_err(|error| error.to_string())?
        .store
        .load(&run_id)
}

#[tauri::command]
fn compile_graph(graph: Graph) -> Result<Plan, Vec<compiler::Diagnostic>> {
    compiler::compile(&graph, true)
}

#[tauri::command]
fn save_graph(
    graph: Graph,
    config: Config,
    service: State<'_, Arc<Service>>,
) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.create(graph, config)?;
    Ok(runtime.state.clone())
}

#[tauri::command]
async fn plan_goal(
    goal: String,
    config: Config,
    service: State<'_, Arc<Service>>,
) -> Result<Snapshot, String> {
    if goal.trim().is_empty() {
        return Err("Enter a goal".into());
    }
    if config.engine != "pi" {
        return Err("Automatic planning requires the Pi engine".into());
    }
    if service.driving.load(Ordering::SeqCst) || service.planning.swap(true, Ordering::SeqCst) {
        return Err("Another operation is running".into());
    }
    let service = service.inner().clone();
    let cleanup = service.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = service.runtime.lock().map_err(|error| error.to_string())?.root.clone();
        let repository = PathBuf::from(&config.repository);
        crate::workspace::verify(&repository)?;
        let directory = root.join("planning").join(Uuid::new_v4().to_string());
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let route_path = directory.join("route.json");
        let task = render_prompt(PARTITIONER_PROMPT, &[("goal", &goal)]);
        let mut log = String::new();
        run_pi(PiRequest { config: &config, cwd: &repository, task: &task, session_dir: &directory.join("partition-session"), extension: Some(&service.extension), tools: "route_task", session_id: None, extra_args: vec!["--thinking", "off"], environment: vec![("GRAPHER_MODE", "partition".into()), ("GRAPHER_GRAPH_PATH", route_path.to_string_lossy().into())] }, |text| log.push_str(&text))?;
        fs::write(directory.join("partition.jsonl"), log).map_err(|error| error.to_string())?;
        let route: Route = serde_json::from_str(&fs::read_to_string(route_path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        let graph = match route.plan_type.as_str() {
            "serial" => Graph { original_goal: goal.clone(), nodes: vec![Node { name: "task".into(), task: goal.clone() }], edges: Vec::new() },
            "graph" => {
                let graph_path = directory.join("graph.json");
                fs::write(&graph_path, serde_json::to_string(&Graph { original_goal: goal.clone(), ..Graph::default() }).unwrap()).map_err(|error| error.to_string())?;
                let task = render_prompt(PLANNER_PROMPT, &[("goal", &goal)]);
                let mut log = String::new();
                run_pi(PiRequest { config: &config, cwd: &repository, task: &task, session_dir: &directory.join("planner-session"), extension: Some(&service.extension), tools: "node,edge,read,bash", session_id: None, extra_args: Vec::new(), environment: vec![("GRAPHER_MODE", "planner".into()), ("GRAPHER_GRAPH_PATH", graph_path.to_string_lossy().into()), ("GRAPHER_COMPILER_PATH", std::env::current_exe().map_err(|error| error.to_string())?.to_string_lossy().into())] }, |text| log.push_str(&text))?;
                fs::write(directory.join("planner.jsonl"), log).map_err(|error| error.to_string())?;
                serde_json::from_str(&fs::read_to_string(graph_path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?
            }
            _ => return Err("Partitioner returned an invalid route".into()),
        };
        let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
        runtime.create(graph, config)?;
        Ok(runtime.state.clone())
    }).await.map_err(|error| error.to_string()).and_then(|result| result);
    cleanup.planning.store(false, Ordering::SeqCst);
    result
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
                let _ = runtime.emit(EventKind::Paused { paused: true });
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

#[tauri::command]
fn control(
    action: String,
    node: Option<String>,
    instruction: Option<String>,
    service: State<'_, Arc<Service>>,
) -> Result<Snapshot, String> {
    if service.planning.load(Ordering::SeqCst) {
        return Err("Wait for planning to finish".into());
    }
    if matches!(action.as_str(), "intervene" | "resolve") && service.driving.load(Ordering::SeqCst)
    {
        return Err("Pause and wait for the current execution wave to settle first".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    match action.as_str() {
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
        "approve" | "resume" | "intervene" | "resolve"
    ) {
        drive(service.inner().clone());
    }
    Ok(snapshot)
}

#[tauri::command]
fn detect_repository(
    path: Option<String>,
) -> Result<Option<crate::workspace::RepositoryInfo>, String> {
    crate::workspace::detect(path.as_deref().map(std::path::Path::new))
}

#[tauri::command]
fn pick_repository() -> Result<Option<crate::workspace::RepositoryInfo>, String> {
    if let Some(folder) = crate::workspace::pick_folder()? {
        let info = crate::workspace::detect(Some(&folder))?;
        if let Some(info) = info {
            Ok(Some(info))
        } else {
            Err(format!(
                "所选目录「{}」不是有效的 Git 仓库根目录（未找到 .git）。请选择包含 .git 的目录，或在该目录执行 git init。",
                folder.display()
            ))
        }
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn reset_workspace(service: State<'_, Arc<Service>>) -> Result<Snapshot, String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.reset_workspace()
}

#[tauri::command]
fn clear_history(service: State<'_, Arc<Service>>) -> Result<(), String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.clear_history()
}

#[tauri::command]
fn delete_run(run_id: String, service: State<'_, Arc<Service>>) -> Result<(), String> {
    if service.driving.load(Ordering::SeqCst) || service.planning.load(Ordering::SeqCst) {
        return Err("Wait for the current operation to finish".into());
    }
    let mut runtime = service.runtime.lock().map_err(|error| error.to_string())?;
    runtime.delete_run(&run_id)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            fs::create_dir_all(&root)?;
            let extension = root.join("grapher-planner.ts");
            fs::write(&extension, include_str!("../resources/planner.ts"))?;
            let prompts_dir = root.join("prompts");
            fs::create_dir_all(&prompts_dir)?;
            fs::write(prompts_dir.join("partitioner.md"), PARTITIONER_PROMPT)?;
            fs::write(prompts_dir.join("planner.md"), PLANNER_PROMPT)?;
            let runtime = Runtime::open(&root).map_err(std::io::Error::other)?;
            app.manage(Arc::new(Service {
                runtime: Mutex::new(runtime),
                driving: AtomicBool::new(false),
                planning: AtomicBool::new(false),
                extension,
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            snapshot,
            history,
            compile_graph,
            save_graph,
            plan_goal,
            control,
            detect_repository,
            pick_repository,
            reset_workspace,
            clear_history,
            delete_run
        ])
        .build(tauri::generate_context!())
        .expect("Cannot run Grapher desktop")
        .run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(service) = handle.try_state::<Arc<Service>>() {
                    if let Ok(mut runtime) = service.runtime.lock() {
                        if runtime.state.approved
                            && (runtime.active() || runtime.state.phase == "running")
                        {
                            let _ = runtime.emit(EventKind::Paused { paused: true });
                        }
                    }
                }
                crate::engine::terminate_all();
            }
        });
}

#[cfg(feature = "benchmark")]
pub mod benchmark {
    include!("../../benchmark/desktop.rs");
}
