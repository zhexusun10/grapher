use super::*;

// Planning-only host: shares production prompts, extension, compiler and Pi adapter.
// It never constructs a Runtime, approves a graph, creates worktrees or calls drive.
pub fn main(input_path: &str) -> Result<(), String> {
    load_env_file();
    let input: Value = serde_json::from_slice(&fs::read(input_path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let root = PathBuf::from(input["output"].as_str().ok_or("Missing output")?);
    let repository = PathBuf::from(input["repository"].as_str().ok_or("Missing repository")?);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let stage = input["stage"].as_str().ok_or("Missing stage")?;
    let goal = input["goal"].as_str().ok_or("Missing goal")?;
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let custom_command = std::env::var("BENCHMARK_PI_COMMAND").ok();
    let mut config = Config {
        repository: repository.to_string_lossy().into(), engine: "pi".into(),
        pi_command: custom_command.clone().unwrap_or_else(|| "node".into()),
        pi_args: match std::env::var("BENCHMARK_PI_ARGS") {
            Ok(args) => serde_json::from_str(&args).map_err(|e| format!("Invalid BENCHMARK_PI_ARGS: {e}"))?,
            Err(_) if custom_command.is_none() => vec![source.join("engine/entrypoint.mjs").to_string_lossy().into()],
            Err(_) => vec![],
        },
        model: String::new(), thinking_level: "medium".into(), max_parallel: 2, max_feedback: 3,
    };
    let model_variable = match stage { "partition" => "PARTITIONER_MODEL", "planner" => "PLANNER_MODEL", _ => return Err("Unknown planning stage".into()) };
    let configured_model = || -> Option<String> {
        let bytes = fs::read(crate::workspace::data_root().join("config.json")).ok()?;
        let saved: Value = serde_json::from_slice(&bytes).ok()?;
        saved["model"].as_str().map(str::to_owned).filter(|v| !v.trim().is_empty())
    };
    config.model = std::env::var("BENCHMARK_PI_MODEL")
        .ok().filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var(model_variable).ok().filter(|v| !v.trim().is_empty()))
        .or_else(configured_model)
        .ok_or("No benchmark model configured. Select a model in Grapher or set BENCHMARK_PI_MODEL=provider/model.")?;
    if !config.model.contains('/') {
        return Err(format!("Benchmark model '{}' requires a provider/model identifier, matching production preflight.", config.model));
    }
    let role = match stage {
        "partition" => PiRole::Partitioner,
        "planner" => PiRole::Planner,
        _ => PiRole::NodeAgent,
    };
    let role_config = PiModelConfig::resolve(role, &config);
    // Resolve production thinking defaults without overwriting an explicit
    // BENCHMARK_PI_MODEL with a role-specific environment override.
    let extension = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/planner.ts");
    let graph_path = root.join(if stage == "partition" { "route.json" } else { "graph.json" });
    if stage == "planner" {
        write_json(&graph_path, &json!({"originalGoal":goal,"nodes":[],"edges":[]}));
    }
    let (system, task, tools, mut extra_args) = match stage {
        "partition" => (std::env::var("PARTITIONER_SYSTEM_PROMPT").unwrap_or_else(|_| split_prompt_template(PARTITIONER_PROMPT).0.into()), format!("User query:\n\n{goal}"), "", vec!["--no-tools", "--no-context-files"]),
        "planner" => (std::env::var("PLANNER_SYSTEM_PROMPT").unwrap_or_else(|_| split_prompt_template(PLANNER_PROMPT).0.into()), format!("User query:\n\n{goal}"), "node,edge,read,bash", vec![]),
        _ => unreachable!(),
    };
    if stage == "planner" {
        if let Some(thinking) = &role_config.thinking {
            extra_args.extend(["--thinking", thinking.as_str()]);
        }
    }
    let compiler = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/grapher");
    let environment = if stage == "planner" { vec![
        ("GRAPHER_MODE", stage.into()),
        ("GRAPHER_GRAPH_PATH", graph_path.to_string_lossy().into()),
        ("GRAPHER_COMPILER_PATH", compiler.to_string_lossy().into()),
    ] } else { vec![] };
    // Persist the effective prompt/model, including overrides, for reproducible comparisons.
    fs::write(root.join("system-prompt.txt"), &system).map_err(|e| e.to_string())?;
    write_json(&root.join("stage.json"), &json!({"stage":stage,"model":config.model,"thinking":role_config.thinking.as_deref(),"tools":tools,"toolPolicy":if stage == "planner" { Some("planner-workspace-tools-v11-array-only") } else { None }}));
    let mut log = fs::File::create(root.join("events.jsonl")).map_err(|e| e.to_string())?;
    let mut log_error = None;
    let started = Instant::now();
    let result = run_pi(PiRequest {
        role,
        config: &config, cwd: &repository, task: &task,
        session_dir: &root.join("session"), extension: if stage == "planner" { Some(&extension) } else { None },
        tools: Some(tools), session_id: None, extra_args, environment, system_prompt: Some(&system),
    }, |text| { if let Err(error) = log.write_all(text.as_bytes()) { log_error = Some(error.to_string()); } });
    let result = match log_error { Some(error) => Err(format!("Cannot retain planning evidence: {error}")), None => result };
    write_json(&root.join("result.json"), &json!({"status":if result.is_ok(){"PASS"}else{"FAIL"},"durationMs":started.elapsed().as_millis(),"response":result.as_ref().ok(),"error":result.as_ref().err()}));
    if stage == "partition" {
        if let Ok(output) = &result {
            let route = parse_route_decision(output);
            write_json(&graph_path, &serde_json::to_value(&route).unwrap());
        }
    }
    if stage == "planner" {
        let graph = serde_json::from_slice::<Graph>(&fs::read(&graph_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let compiled = match compiler::compile(&graph, true) { Ok(plan) => json!({"plan":plan,"diagnostics":[]}), Err(errors) => json!({"diagnostics":errors}) };
        write_json(&root.join("compiler.json"), &compiled);
    }
    result.map(|_| ())
}
