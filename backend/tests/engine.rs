// Process substitution is not part of the production engine capability surface.
#![cfg(feature = "fixture")]

use grapher::{
    engine::{parse_route_decision, run_pi, PiRequest, PiRole},
    model::{Config, Route},
};
use std::fs;
use tempfile::TempDir;

fn execute_script(script: &str) -> (Result<String, String>, String) {
    execute_script_in_mode(script, None)
}

fn execute_script_in_mode(script: &str, mode: Option<&str>) -> (Result<String, String>, String) {
    let temp = TempDir::new().unwrap();
    let script_path = temp.path().join("fake-pi.sh");
    fs::write(&script_path, script).unwrap();
    let config = Config {
        repository: String::new(),
        engine: "pi".into(),
        pi_command: "/bin/sh".into(),
        pi_args: vec![script_path.to_string_lossy().into()],
        model: String::new(),
        max_parallel: 2,
        max_feedback: 3,
    };
    let mut output = String::new();
    let result = run_pi(
        PiRequest {
            role: PiRole::from_mode(mode),
            config: &config,
            cwd: temp.path(),
            task: "Do not run a model",
            session_dir: &temp.path().join("session"),
            extension: None,
            tools: Some("read,bash"),
            session_id: Some("test-session"),
            extra_args: Vec::new(),
            environment: mode
                .map(|mode| vec![("GRAPHER_MODE", mode.into())])
                .unwrap_or_default(),
            system_prompt: None,
        },
        |text| output.push_str(&text),
    );
    (result, output)
}

#[test]
fn parse_route_decision_recognizes_exact_single_words_and_formatting() {
    assert_eq!(
        parse_route_decision("graph"),
        Route {
            plan_type: "graph".into()
        }
    );
    assert_eq!(
        parse_route_decision("serial"),
        Route {
            plan_type: "serial".into()
        }
    );
    assert_eq!(
        parse_route_decision("Graph"),
        Route {
            plan_type: "graph".into()
        }
    );
    assert_eq!(
        parse_route_decision("SERIAL\n"),
        Route {
            plan_type: "serial".into()
        }
    );
    assert_eq!(
        parse_route_decision("  graph  "),
        Route {
            plan_type: "graph".into()
        }
    );
    assert_eq!(
        parse_route_decision("**graph**"),
        Route {
            plan_type: "graph".into()
        }
    );
    assert_eq!(
        parse_route_decision("`serial`"),
        Route {
            plan_type: "serial".into()
        }
    );
    assert_eq!(
        parse_route_decision("\"graph\"."),
        Route {
            plan_type: "graph".into()
        }
    );
}

#[test]
fn parse_route_decision_recognizes_keywords_in_discursive_sentences() {
    // Model outputs conversational text instead of single word
    assert_eq!(
        parse_route_decision("I recommend graph for this parallel task."),
        Route {
            plan_type: "graph".into()
        }
    );
    assert_eq!(
        parse_route_decision("This is a simple bug fix, please use serial."),
        Route {
            plan_type: "serial".into()
        }
    );
    // Multiline reasoning ending with recommendation
    assert_eq!(
        parse_route_decision("Analysis:\n- Independent modules\n- Parallel work\nTherefore, graph execution is required."),
        Route { plan_type: "graph".into() }
    );
    assert_eq!(
        parse_route_decision("Analysis:\n- Single file edit\nProceed with serial."),
        Route {
            plan_type: "serial".into()
        }
    );
}

#[test]
fn parse_route_decision_resolves_comparison_of_both_keywords() {
    // When both words are mentioned, later occurrence represents the conclusion
    assert_eq!(
        parse_route_decision("Serial execution was considered, but we should use a graph."),
        Route {
            plan_type: "graph".into()
        }
    );
    assert_eq!(
        parse_route_decision("While a graph is possible, serial is safer here."),
        Route {
            plan_type: "serial".into()
        }
    );
}

#[test]
fn parse_route_decision_recognizes_explicit_decision_marker() {
    assert_eq!(
        parse_route_decision("Some reasoning here...\nDECISION: graph"),
        Route {
            plan_type: "graph".into()
        }
    );
    assert_eq!(
        parse_route_decision("Some reasoning here...\nDECISION: serial"),
        Route {
            plan_type: "serial".into()
        }
    );
    assert_eq!(
        parse_route_decision("Reasoning: parallel work.\n**DECISION: GRAPH**"),
        Route {
            plan_type: "graph".into()
        }
    );
    assert_eq!(
        parse_route_decision("Reasoning: single step.\n**decision:** serial."),
        Route {
            plan_type: "serial".into()
        }
    );
}

#[test]
fn parse_route_decision_safe_fallback_on_ambiguity_or_gibberish() {
    // Empty output
    assert_eq!(
        parse_route_decision(""),
        Route {
            plan_type: "serial".into()
        }
    );
    // Hallucination / gibberish
    assert_eq!(
        parse_route_decision("I am not sure what to do here. Hello world!"),
        Route {
            plan_type: "serial".into()
        }
    );
    // Unrelated text
    assert_eq!(
        parse_route_decision("42 is the answer to everything."),
        Route {
            plan_type: "serial".into()
        }
    );
}

#[test]
fn parses_final_assistant_text_and_preserves_tool_stream() {
    let (result, stream) = execute_script("cat >/dev/null\nprintf '%s\\n' '{\"type\":\"tool_execution_start\",\"toolName\":\"read\",\"args\":{\"path\":\"README.md\"}}' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\",\"content\":[{\"type\":\"text\",\"text\":\"Done\\n<ACCEPT>\"}]}}'\n");
    assert_eq!(result.unwrap(), "Done\n<ACCEPT>");
    assert!(stream.contains("tool_execution_start"));
}

#[test]
fn provider_error_with_success_exit_is_still_failure() {
    let (result, _) = execute_script("cat >/dev/null\nprintf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"error\",\"errorMessage\":\"Authentication failed\",\"content\":[]}}'\n");
    assert!(result.unwrap_err().contains("Authentication failed"));
}

#[test]
fn nonzero_exit_and_empty_response_fail_closed() {
    let (result, stream) = execute_script("cat >/dev/null\necho 'bad CLI arguments' >&2\nexit 2\n");
    assert!(result.unwrap_err().contains("bad CLI arguments"));
    assert!(stream.contains("[stderr]"));
    assert!(execute_script("cat >/dev/null\n")
        .0
        .unwrap_err()
        .contains("no final assistant text"));
}

#[test]
fn successful_provider_retry_clears_the_previous_assistant_error() {
    // Supplemental adapter protocol regression, not a substitute for the real-Pi benchmark.
    let (result, stream) = execute_script(
        r#"cat >/dev/null
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"Temporary provider failure","content":[]}}' '{"type":"auto_retry_start","attempt":1}' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Recovered successfully"}]}}'
"#,
    );
    assert!(stream.contains("Temporary provider failure"));
    assert_eq!(result.unwrap(), "Recovered successfully");
}

#[test]
fn passes_system_prompt_flag_when_provided() {
    let temp = TempDir::new().unwrap();
    let script_path = temp.path().join("fake-pi.sh");
    let script = r#"cat >/dev/null
echo "ARGS: $@"
for arg in "$@"; do
    if [ "$prev" = "--system-prompt" ]; then
        echo "SYSTEM_PROMPT_CONTENT: $(cat "$arg")"
    fi
    prev="$arg"
done
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"OK"}]}}'
"#;
    fs::write(&script_path, script).unwrap();
    let config = Config {
        repository: String::new(),
        engine: "pi".into(),
        pi_command: "/bin/sh".into(),
        pi_args: vec![script_path.to_string_lossy().into()],
        model: String::new(),
        max_parallel: 2,
        max_feedback: 3,
    };
    let mut output = String::new();
    let result = run_pi(
        PiRequest {
            role: PiRole::NodeAgent,
            config: &config,
            cwd: temp.path(),
            task: "Do not run a model",
            session_dir: &temp.path().join("session"),
            extension: None,
            tools: Some("read,bash"),
            session_id: Some("test-session"),
            extra_args: Vec::new(),
            environment: Vec::new(),
            system_prompt: Some("Custom system prompt content for test"),
        },
        |text| output.push_str(&text),
    );
    assert_eq!(result.unwrap(), "OK");
    assert!(output.contains("--system-prompt"));
    assert!(output.contains("SYSTEM_PROMPT_CONTENT: Custom system prompt content for test"));
}

#[test]
fn node_agent_allows_skills_and_plugins_while_planner_and_partitioner_disable_them() {
    let temp = TempDir::new().unwrap();
    let script_path = temp.path().join("fake-pi.sh");
    let script = r#"cat >/dev/null
echo "ARGS: $@"
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"OK"}]}}'
"#;
    fs::write(&script_path, script).unwrap();
    let config = Config {
        repository: String::new(),
        engine: "pi".into(),
        pi_command: "/bin/sh".into(),
        pi_args: vec![script_path.to_string_lossy().into()],
        model: "test-model".into(),
        max_parallel: 2,
        max_feedback: 3,
    };

    // 1. Node Agent: must NOT have --no-skills or --no-extensions, MUST have --approve, must NOT restrict tools
    let mut node_agent_out = String::new();
    let _ = run_pi(
        PiRequest {
            role: PiRole::NodeAgent,
            config: &config,
            cwd: temp.path(),
            task: "task",
            session_dir: &temp.path().join("session-node-agent"),
            extension: None,
            tools: None,
            session_id: Some("node-agent-session"),
            extra_args: Vec::new(),
            environment: Vec::new(),
            system_prompt: None,
        },
        |text| node_agent_out.push_str(&text),
    );
    assert!(
        !node_agent_out.contains("--no-skills"),
        "Node agent must not have --no-skills"
    );
    assert!(
        !node_agent_out.contains("--no-extensions"),
        "Node agent must not have --no-extensions"
    );
    assert!(
        !node_agent_out.contains("--no-approve"),
        "Node agent must not have --no-approve"
    );
    assert!(
        node_agent_out.contains("--approve"),
        "Node agent must have --approve for workspace trust"
    );
    assert!(
        !node_agent_out.contains("--tools"),
        "Node agent must not restrict tools via --tools"
    );

    // 2. Planner: MUST have --no-skills, --no-extensions, --no-approve, and restricted tools
    let mut planner_out = String::new();
    let _ = run_pi(
        PiRequest {
            role: PiRole::Planner,
            config: &config,
            cwd: temp.path(),
            task: "task",
            session_dir: &temp.path().join("session-planner"),
            extension: None,
            tools: Some("node,edge,read,bash"),
            session_id: Some("planner-session"),
            extra_args: Vec::new(),
            environment: Vec::new(),
            system_prompt: None,
        },
        |text| planner_out.push_str(&text),
    );
    assert!(
        planner_out.contains("--no-skills"),
        "Planner must have --no-skills"
    );
    assert!(
        planner_out.contains("--no-extensions"),
        "Planner must have --no-extensions"
    );
    assert!(
        planner_out.contains("--no-approve"),
        "Planner must have --no-approve"
    );
    assert!(
        planner_out.contains("--tools node,edge,read,bash"),
        "Planner must restrict tools"
    );

    // 3. Partitioner: MUST have --no-skills, --no-extensions, --no-approve, and --no-tools
    let mut partitioner_out = String::new();
    let _ = run_pi(
        PiRequest {
            role: PiRole::Partitioner,
            config: &config,
            cwd: temp.path(),
            task: "task",
            session_dir: &temp.path().join("session-part"),
            extension: None,
            tools: Some(""),
            session_id: None,
            extra_args: vec!["--no-tools", "--no-context-files"],
            environment: Vec::new(),
            system_prompt: None,
        },
        |text| partitioner_out.push_str(&text),
    );
    assert!(
        partitioner_out.contains("--no-skills"),
        "Partitioner must have --no-skills"
    );
    assert!(
        partitioner_out.contains("--no-extensions"),
        "Partitioner must have --no-extensions"
    );
    assert!(
        partitioner_out.contains("--no-approve"),
        "Partitioner must have --no-approve"
    );
    assert!(
        partitioner_out.contains("--no-tools"),
        "Partitioner must have --no-tools"
    );
}

#[test]
fn instance_role_and_workspace_are_owned_by_the_host() {
    let temp = TempDir::new().unwrap();
    let script = temp.path().join("instance.sh");
    fs::write(&script, r#"cat >/dev/null
printf 'ROLE=%s\nROOT=%s\n' "$GRAPHER_MODE" "$GRAPHER_WORKSPACE_ROOT"
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"OK"}]}}'
"#).unwrap();
    let config = Config {
        repository: String::new(),
        engine: "pi".into(),
        pi_command: "/bin/sh".into(),
        pi_args: vec![script.to_string_lossy().into()],
        model: "test-model".into(),
        max_parallel: 2,
        max_feedback: 3,
    };
    for (role, name) in [
        (PiRole::Partitioner, "partition"),
        (PiRole::Planner, "planner"),
        (PiRole::NodeAgent, "node"),
        (PiRole::Merger, "merger"),
    ] {
        let cwd = temp.path().join(name);
        fs::create_dir(&cwd).unwrap();
        let mut output = String::new();
        run_pi(
            PiRequest {
                role,
                config: &config,
                cwd: &cwd,
                task: "task",
                session_dir: &cwd.join("session"),
                extension: None,
                tools: None,
                session_id: None,
                extra_args: vec![],
                environment: vec![
                    ("GRAPHER_MODE", "wrong-role".into()),
                    ("GRAPHER_WORKSPACE_ROOT", "/wrong/root".into()),
                ],
                system_prompt: None,
            },
            |text| output.push_str(&text),
        )
        .unwrap();
        assert!(output.contains(&format!("ROLE={name}\n")), "{output}");
        assert!(
            output.contains(&format!("ROOT={}\n", cwd.canonicalize().unwrap().display())),
            "{output}"
        );
        assert!(!output.contains("wrong-role") && !output.contains("/wrong/root"));
    }
}

#[test]
fn external_pi_model_env_does_not_override_node_agent_or_leak_to_child() {
    let temp = TempDir::new().unwrap();
    let script_path = temp.path().join("fake-pi.sh");
    let script = r#"cat >/dev/null
echo "PI_MODEL_ENV: ${PI_MODEL:-UNSET}"
echo "PI_THINKING_ENV: ${PI_THINKING:-UNSET}"
echo "PI_SESSION_ID_ENV: ${PI_SESSION_ID:-UNSET}"
echo "PI_SESSION_FILE_ENV: ${PI_SESSION_FILE:-UNSET}"
for arg in "$@"; do
    if [ "$prev" = "--model" ]; then
        echo "CLI_MODEL: $arg"
    fi
    prev="$arg"
done
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"OK"}]}}'
"#;
    fs::write(&script_path, script).unwrap();

    // Set external PI_MODEL, PI_THINKING, PI_SESSION_ID, PI_SESSION_FILE in current test process
    std::env::set_var("PI_MODEL", "leaked-external-model");
    std::env::set_var("PI_THINKING", "leaked-external-thinking");
    std::env::set_var("PI_SESSION_ID", "leaked-external-session");
    std::env::set_var("PI_SESSION_FILE", "leaked-external-file");

    let base_config = Config {
        repository: String::new(),
        engine: "pi".into(),
        pi_command: "/bin/sh".into(),
        pi_args: vec![script_path.to_string_lossy().into()],
        model: "internal-grapher-model".into(),
        max_parallel: 2,
        max_feedback: 3,
    };

    // Verify PiModelConfig::resolve for NodeAgent ignores PI_MODEL and uses base_config.model
    use grapher::engine::PiModelConfig;
    let resolved = PiModelConfig::resolve(PiRole::NodeAgent, &base_config);
    assert_eq!(resolved.model, "internal-grapher-model");
    assert_eq!(resolved.thinking, None);
    let saved_thinking = std::env::var("PARTITIONER_THINKING").ok();
    std::env::remove_var("PARTITIONER_THINKING");
    assert_eq!(
        PiModelConfig::resolve(PiRole::Partitioner, &base_config)
            .thinking
            .as_deref(),
        Some("off")
    );
    std::env::set_var("PARTITIONER_THINKING", "medium");
    assert_eq!(
        PiModelConfig::resolve(PiRole::Partitioner, &base_config)
            .thinking
            .as_deref(),
        Some("medium")
    );
    match saved_thinking {
        Some(value) => std::env::set_var("PARTITIONER_THINKING", value),
        None => std::env::remove_var("PARTITIONER_THINKING"),
    }

    // Verify NODE_AGENT_MODEL overrides base_config.model
    std::env::set_var("NODE_AGENT_MODEL", "override-node-model");
    let resolved_override = PiModelConfig::resolve(PiRole::NodeAgent, &base_config);
    assert_eq!(resolved_override.model, "override-node-model");
    std::env::remove_var("NODE_AGENT_MODEL");

    // Verify run_pi strips PI_MODEL, PI_THINKING, PI_SESSION_ID, PI_SESSION_FILE from child process environment
    let effective = resolved.effective_config(&base_config);
    let mut output = String::new();
    let _ = run_pi(
        PiRequest {
            role: PiRole::NodeAgent,
            config: &effective,
            cwd: temp.path(),
            task: "task",
            session_dir: &temp.path().join("session"),
            extension: None,
            tools: None,
            session_id: Some("session-id"),
            extra_args: Vec::new(),
            environment: Vec::new(),
            system_prompt: None,
        },
        |text| output.push_str(&text),
    );

    assert!(
        output.contains("PI_MODEL_ENV: UNSET"),
        "Child process must not inherit PI_MODEL"
    );
    assert!(
        output.contains("PI_THINKING_ENV: UNSET"),
        "Child process must not inherit PI_THINKING"
    );
    assert!(
        output.contains("PI_SESSION_ID_ENV: UNSET"),
        "Child process must not inherit PI_SESSION_ID"
    );
    assert!(
        output.contains("PI_SESSION_FILE_ENV: UNSET"),
        "Child process must not inherit PI_SESSION_FILE"
    );
    assert!(
        output.contains("CLI_MODEL: internal-grapher-model"),
        "Child must receive internal grapher model via --model"
    );

    // Clean up test env
    std::env::remove_var("PI_MODEL");
    std::env::remove_var("PI_THINKING");
    std::env::remove_var("PI_SESSION_ID");
    std::env::remove_var("PI_SESSION_FILE");
}
