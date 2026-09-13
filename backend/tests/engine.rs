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
            tools: "read,bash",
            session_id: Some("test-session"),
            extra_args: Vec::new(),
            environment: mode.map(|mode| vec![("GRAPHER_MODE", mode.into())]).unwrap_or_default(),
            system_prompt: None,
        },
        |text| output.push_str(&text),
    );
    (result, output)
}

#[test]
fn parse_route_decision_recognizes_exact_single_words_and_formatting() {
    assert_eq!(parse_route_decision("graph"), Route { plan_type: "graph".into() });
    assert_eq!(parse_route_decision("serial"), Route { plan_type: "serial".into() });
    assert_eq!(parse_route_decision("Graph"), Route { plan_type: "graph".into() });
    assert_eq!(parse_route_decision("SERIAL\n"), Route { plan_type: "serial".into() });
    assert_eq!(parse_route_decision("  graph  "), Route { plan_type: "graph".into() });
    assert_eq!(parse_route_decision("**graph**"), Route { plan_type: "graph".into() });
    assert_eq!(parse_route_decision("`serial`"), Route { plan_type: "serial".into() });
    assert_eq!(parse_route_decision("\"graph\"."), Route { plan_type: "graph".into() });
}

#[test]
fn parse_route_decision_recognizes_keywords_in_discursive_sentences() {
    // Model outputs conversational text instead of single word
    assert_eq!(
        parse_route_decision("I recommend graph for this parallel task."),
        Route { plan_type: "graph".into() }
    );
    assert_eq!(
        parse_route_decision("This is a simple bug fix, please use serial."),
        Route { plan_type: "serial".into() }
    );
    // Multiline reasoning ending with recommendation
    assert_eq!(
        parse_route_decision("Analysis:\n- Independent modules\n- Parallel work\nTherefore, graph execution is required."),
        Route { plan_type: "graph".into() }
    );
    assert_eq!(
        parse_route_decision("Analysis:\n- Single file edit\nProceed with serial."),
        Route { plan_type: "serial".into() }
    );
}

#[test]
fn parse_route_decision_resolves_comparison_of_both_keywords() {
    // When both words are mentioned, later occurrence represents the conclusion
    assert_eq!(
        parse_route_decision("Serial execution was considered, but we should use a graph."),
        Route { plan_type: "graph".into() }
    );
    assert_eq!(
        parse_route_decision("While a graph is possible, serial is safer here."),
        Route { plan_type: "serial".into() }
    );
}

#[test]
fn parse_route_decision_recognizes_explicit_decision_marker() {
    assert_eq!(
        parse_route_decision("Some reasoning here...\nDECISION: graph"),
        Route { plan_type: "graph".into() }
    );
    assert_eq!(
        parse_route_decision("Some reasoning here...\nDECISION: serial"),
        Route { plan_type: "serial".into() }
    );
    assert_eq!(
        parse_route_decision("Reasoning: parallel work.\n**DECISION: GRAPH**"),
        Route { plan_type: "graph".into() }
    );
    assert_eq!(
        parse_route_decision("Reasoning: single step.\n**decision:** serial."),
        Route { plan_type: "serial".into() }
    );
}

#[test]
fn parse_route_decision_safe_fallback_on_ambiguity_or_gibberish() {
    // Empty output
    assert_eq!(
        parse_route_decision(""),
        Route { plan_type: "serial".into() }
    );
    // Hallucination / gibberish
    assert_eq!(
        parse_route_decision("I am not sure what to do here. Hello world!"),
        Route { plan_type: "serial".into() }
    );
    // Unrelated text
    assert_eq!(
        parse_route_decision("42 is the answer to everything."),
        Route { plan_type: "serial".into() }
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
            role: PiRole::Subagent,
            config: &config,
            cwd: temp.path(),
            task: "Do not run a model",
            session_dir: &temp.path().join("session"),
            extension: None,
            tools: "read,bash",
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
