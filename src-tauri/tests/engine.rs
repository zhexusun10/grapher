use grapher::{
    engine::{run_pi, PiRequest},
    model::Config,
};
use std::fs;
use tempfile::TempDir;

fn execute_script(script: &str) -> (Result<String, String>, String) {
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
            config: &config,
            cwd: temp.path(),
            task: "Do not run a model",
            session_dir: &temp.path().join("session"),
            extension: None,
            tools: "read,bash",
            session_id: Some("test-session"),
            environment: Vec::new(),
        },
        |text| output.push_str(&text),
    );
    (result, output)
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
