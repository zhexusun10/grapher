//! Read-only discovery of the user's global Pi resources, with Grapher-local selection.
use serde_json::Value;
use std::{io::Write, path::Path, process::{Command, Stdio}, sync::{mpsc, Mutex}, thread, time::Duration};

static REQUEST_LOCK: Mutex<()> = Mutex::new(());

fn discovery_command(root: &Path, agent_dir: &Path) -> Command {
    let mut command = Command::new("node");
    command.arg("--import")
        // --import expects a module specifier, not a Windows C:\\ filesystem path.
        // Resolve this relative specifier against the explicit installation cwd.
        .arg("./pi/packages/coding-agent/src/experimental/source-resolver.ts")
        .arg(crate::native::host_path(&root.join("engine/extensions-host.ts")))
        .current_dir(root)
        .env("PI_CODING_AGENT_DIR", agent_dir)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}

pub fn request(body: Value) -> Result<Value, String> {
    if body["version"] != 1 || !matches!(body["operation"].as_str(), Some("catalog" | "set_enabled")) {
        return Err("Invalid Pi extension operation".into());
    }
    let encoded = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    if encoded.len() > 128 * 1024 { return Err("Pi extension request too large".into()); }
    // Serialize read-modify-write selections across HTTP workers.
    let _guard = REQUEST_LOCK.lock().map_err(|_| "Pi extension lock unavailable")?;
    let root = crate::native::installation_root();
    let mut command = discovery_command(&root, &crate::native::agent_dir()?);
    crate::process_control::configure_command(&mut command);
    let mut child = command.spawn().map_err(|error| format!("Cannot start Pi extension discovery: {error}"))?;
    let tree = crate::process_control::track(&child).map_err(|error| {
        let _ = child.kill();
        let _ = child.wait();
        error
    })?;
    if let Err(error) = child.stdin.take().ok_or("Pi extension input unavailable")?.write_all(&encoded) {
        tree.terminate();
        let _ = child.wait();
        return Err(error.to_string());
    }
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || { let _ = tx.send(child.wait_with_output()); });
    let output = match rx.recv_timeout(Duration::from_secs(40)) {
        Ok(output) => output.map_err(|e| e.to_string())?,
        Err(_) => {
            tree.terminate();
            return Err("Pi extension discovery timed out".into());
        }
    };
    let response: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| format!("Pi extension discovery failed: {}", String::from_utf8_lossy(&output.stderr)))?;
    if let Some(error) = response["error"].as_str() { return Err(error.into()); }
    if !output.status.success() { return Err("Pi extension discovery failed".into()); }
    Ok(response["result"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run_discovery(root: &Path, own: &Path, global: &Path, body: Value) -> std::process::Output {
        let mut child = discovery_command(root, own)
            .env("GRAPHER_GLOBAL_PI_AGENT_DIR", global)
            .env("GRAPHER_ISOLATED_PI_MODELS", "1")
            .spawn().unwrap();
        child.stdin.take().unwrap().write_all(&serde_json::to_vec(&body).unwrap()).unwrap();
        child.wait_with_output().unwrap()
    }

    #[test]
    fn node_import_works_from_unicode_roots_with_spaces_and_url_characters() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("扩展 loader # %");
        let resolver = root.join("pi/packages/coding-agent/src/experimental");
        fs::create_dir_all(&resolver).unwrap();
        fs::create_dir_all(root.join("engine")).unwrap();
        fs::write(resolver.join("source-resolver.ts"), "export {};").unwrap();
        fs::write(root.join("engine/extensions-host.ts"),
            "import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(0, 'utf8'));").unwrap();
        let body = serde_json::json!({"version": 1, "operation": "catalog"});
        let output = run_discovery(&root, &root, &root, body.clone());
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap(), body);
    }

    #[test]
    fn real_discovery_lists_required_trim_and_rejects_disabling_it() {
        let temp = tempfile::tempdir().unwrap();
        let own = temp.path().join("own");
        let global = temp.path().join("global");
        fs::create_dir_all(&own).unwrap();
        fs::create_dir_all(&global).unwrap();
        fs::write(own.join("extensions.json"), r#"{"overrides":{"npm:pi-trim":false}}"#).unwrap();
        let root = crate::native::installation_root();
        let output = run_discovery(&root, &own, &global, serde_json::json!({"version": 1, "operation": "catalog"}));
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        let trim = response["result"]["extensions"].as_array().unwrap().iter()
            .find(|extension| extension["id"] == "npm:pi-trim").unwrap();
        assert_eq!(trim["enabled"], true);
        let output = run_discovery(&root, &own, &global, serde_json::json!({
            "version": 1, "operation": "set_enabled", "id": "npm:pi-trim", "enabled": false
        }));
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(!output.status.success());
        assert!(response["error"].as_str().unwrap().contains("pi-trim is required"));
    }
}
