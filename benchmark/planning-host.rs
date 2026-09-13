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
    let local_pi = source.join("pi/packages/coding-agent/src/cli.ts").exists();
    let mut config = Config {
        repository: repository.to_string_lossy().into(), engine: "pi".into(),
        pi_command: std::env::var("BENCHMARK_PI_COMMAND").unwrap_or_else(|_| if local_pi { "node" } else { "pi" }.into()),
        pi_args: match std::env::var("BENCHMARK_PI_ARGS") {
            Ok(args) => serde_json::from_str(&args).map_err(|e| format!("Invalid BENCHMARK_PI_ARGS: {e}"))?,
            Err(_) if local_pi => vec![source.join("pi/node_modules/tsx/dist/cli.mjs").to_string_lossy().into(), "--tsconfig".into(), source.join("pi/tsconfig.json").to_string_lossy().into(), source.join("pi/packages/coding-agent/src/cli.ts").to_string_lossy().into()],
            Err(_) => vec![],
        },
        model: String::new(), max_parallel: 2, max_feedback: 3,
    };
    let model_variable = match stage { "partition" => "PARTITIONER_MODEL", "planner" => "PLANNER_MODEL", "judge" => "BENCHMARK_JUDGE_MODEL", _ => return Err("Unknown planning stage".into()) };
    config.model = std::env::var(if stage == "judge" { "BENCHMARK_JUDGE_MODEL" } else { "BENCHMARK_PI_MODEL" })
        .ok().filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var(model_variable).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or("qwen3.8-flash".into());
    let extension = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/planner.ts");
    let graph_path = root.join(if stage == "partition" { "route.json" } else { "graph.json" });
    if stage == "planner" {
        write_json(&graph_path, &json!({"originalGoal":goal,"nodes":[],"edges":[]}));
    }
    let (system, task, tools, extra_args) = match stage {
        "partition" => (std::env::var("PARTITIONER_SYSTEM_PROMPT").unwrap_or_else(|_| split_prompt_template(PARTITIONER_PROMPT).0.into()), format!("User query:\n\n{goal}"), "", vec!["--no-tools", "--no-context-files", "--thinking", "off"]),
        "planner" => (std::env::var("PLANNER_SYSTEM_PROMPT").unwrap_or_else(|_| split_prompt_template(PLANNER_PROMPT).0.into()), format!("User query:\n\n{goal}"), "node,edge,read,bash", vec![]),
        "judge" => (input["system"].as_str().ok_or("Missing judge system")?.into(), goal.into(), "", vec!["--no-tools", "--no-context-files", "--thinking", "off"]),
        _ => unreachable!(),
    };
    let compiler = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/grapher");
    let environment = if stage == "judge" || stage == "partition" { vec![] } else { vec![
        ("GRAPHER_MODE", stage.into()),
        ("GRAPHER_GRAPH_PATH", graph_path.to_string_lossy().into()),
        ("GRAPHER_COMPILER_PATH", compiler.to_string_lossy().into()),
    ] };
    // Persist the effective prompt/model, including overrides, for reproducible comparisons.
    fs::write(root.join("system-prompt.txt"), &system).map_err(|e| e.to_string())?;
    write_json(&root.join("stage.json"), &json!({"stage":stage,"model":config.model,"tools":tools,"inspectionPolicy":if stage == "planner" { Some("repository-inspection-v1") } else { None }}));
    let mut log = fs::File::create(root.join("events.jsonl")).map_err(|e| e.to_string())?;
    let mut log_error = None;
    let started = Instant::now();
    let role = match stage {
        "partition" => PiRole::Partitioner,
        "planner" => PiRole::Planner,
        _ => PiRole::Subagent,
    };
    let result = run_pi(PiRequest {
        role,
        config: &config, cwd: &repository, task: &task,
        session_dir: &root.join("session"), extension: if stage == "judge" || stage == "partition" { None } else { Some(&extension) },
        tools, session_id: None, extra_args, environment, system_prompt: Some(&system),
    }, |text| { if let Err(error) = log.write_all(text.as_bytes()) { log_error = Some(error.to_string()); } });
    let result = match log_error { Some(error) => Err(format!("Cannot retain planning evidence: {error}")), None => result };
    write_json(&root.join("result.json"), &json!({"status":if result.is_ok(){"PASS"}else{"FAIL"},"durationMs":started.elapsed().as_millis(),"response":result.as_ref().ok(),"error":result.as_ref().err()}));
    if stage == "partition" {
        let route = match &result {
            Ok(output) => parse_route_decision(output),
            Err(_) => parse_route_decision(""),
        };
        write_json(&graph_path, &serde_json::to_value(&route).unwrap());
    }
    if stage == "planner" {
        let graph = serde_json::from_slice::<Graph>(&fs::read(&graph_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let compiled = match compiler::compile(&graph, true) { Ok(plan) => json!({"plan":plan,"diagnostics":[]}), Err(errors) => json!({"diagnostics":errors}) };
        write_json(&root.join("compiler.json"), &compiled);
    }
    result.map(|_| ())
}
