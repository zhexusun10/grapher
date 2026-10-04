//! Local-only Provider/Auth transport. The child owns upstream ModelRuntime;
//! Grapher never reads auth.json or implements credential refresh/storage.
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::Duration,
};

static BRIDGE: OnceLock<Mutex<Option<Bridge>>> = OnceLock::new();

struct Bridge {
    child: Child,
    process_tree: crate::process_control::ProcessTree,
    input: ChildStdin,
    output: mpsc::Receiver<String>,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.process_tree.terminate();
        let _ = self.child.wait();
    }
}

impl Bridge {
    fn start() -> Result<Self, String> {
        let root = crate::native::installation_root();
        let mut command = Command::new("node");
        command
            // Use the same audited Pi source loader as the execution and
            // extension hosts; no tsx install/download on the startup path.
            .arg("--import")
            .arg("./pi/packages/coding-agent/src/experimental/source-resolver.ts")
            .arg(crate::native::host_path(&root.join("engine/provider-host.ts")))
            .current_dir(&root)
            .env("PI_CODING_AGENT_DIR", crate::native::agent_dir()?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::process_control::configure_command(&mut command);
        let mut child = command
            .spawn()
            .map_err(|_| "Cannot start Provider/Auth Adapter. Run npm run pi:setup.")?;
        let process_tree = crate::process_control::track(&child).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            error
        })?;
        let input = child.stdin.take().ok_or("Adapter input unavailable")?;
        let stdout = child.stdout.take().ok_or("Adapter output unavailable")?;
        let stderr = child.stderr.take();
        if let Some(stderr) = stderr {
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    let Ok(line) = line else { break };
                    eprintln!("[provider_auth] {line}");
                }
            });
        }
        let (tx, output) = mpsc::sync_channel(1);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.len() > 4 * 1024 * 1024 || tx.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            process_tree,
            input,
            output,
        })
    }

    fn call(&mut self, body: &Value) -> Result<Value, String> {
        let mut encoded = serde_json::to_vec(body).map_err(|_| "Invalid adapter request")?;
        if encoded.len() > 128 * 1024 {
            return Err("Adapter request too large".into());
        }
        encoded.push(b'\n');
        self.input
            .write_all(&encoded)
            .map_err(|_| "Adapter disconnected")?;
        self.input.flush().map_err(|_| "Adapter disconnected")?;
        let line = self
            .output
            .recv_timeout(Duration::from_secs(40))
            .map_err(|_| "Adapter timed out or stopped. Restart login.")?;
        let value: Value = serde_json::from_str(&line).map_err(|_| "Invalid adapter response")?;
        if value["version"] != 1 {
            return Err("Incompatible Provider/Auth Adapter".into());
        }
        Ok(value)
    }
}

pub fn request(body: Value) -> Result<Value, String> {
    if body["version"] != 1
        || !matches!(
            body["operation"].as_str(),
            Some("catalog" | "login" | "poll" | "respond" | "cancel" | "logout")
        )
    {
        return Err("Invalid Provider/Auth Adapter operation".into());
    }
    let mut guard = BRIDGE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Adapter lock unavailable")?;
    if guard.is_none() {
        *guard = Some(Bridge::start()?);
    }
    let response = guard.as_mut().unwrap().call(&body);
    match response {
        Ok(value) => {
            if value.get("error").is_some() {
                Err("Provider/Auth operation failed. Refresh providers or restart login.".into())
            } else {
                Ok(value["result"].clone())
            }
        }
        Err(error) => {
            *guard = None;
            Err(error)
        }
    }
}

pub fn shutdown() {
    if let Some(bridge) = BRIDGE.get() {
        if let Ok(mut guard) = bridge.lock() {
            *guard = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_auth_catalog() {
        let result = request(serde_json::json!({
            "version": 1,
            "operation": "catalog",
            "refresh": false,
        }));
        assert!(result.is_ok(), "Expected catalog to succeed, got: {:?}", result.err());
        let val = result.unwrap();
        assert!(val.get("providers").is_some());
        shutdown();
    }
}
