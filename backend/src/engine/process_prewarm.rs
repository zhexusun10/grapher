//! Three independent, unbound source-role processes. Run identity, resources,
//! sessions and tools are installed only after a worker has been claimed.
use super::{
    prewarm::{Pool, ReadyProcess, Ticket},
    Config, PiRole, PREWARM_SHUTTING_DOWN,
};
use crate::{native, process_control};
use serde_json::{json, Map, Value};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::Ordering, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone, PartialEq, Eq)]
struct Key {
    repository: PathBuf,
}

static PARTITIONER: OnceLock<Pool<Key, ReadyProcess>> = OnceLock::new();
static PLANNER: OnceLock<Pool<Key, ReadyProcess>> = OnceLock::new();
static SERIAL: OnceLock<Pool<Key, ReadyProcess>> = OnceLock::new();

fn mode(role: PiRole) -> &'static str {
    match role {
        PiRole::Partitioner => "partition",
        PiRole::Planner => "planner",
        PiRole::NodeAgent => "node",
        PiRole::Merger => unreachable!(),
    }
}
fn slot(role: PiRole) -> &'static OnceLock<Pool<Key, ReadyProcess>> {
    match role {
        PiRole::Partitioner => &PARTITIONER,
        PiRole::Planner => &PLANNER,
        PiRole::NodeAgent => &SERIAL,
        PiRole::Merger => unreachable!(),
    }
}
fn key(config: &Config) -> Result<Key, String> {
    Ok(Key {
        repository: Path::new(&config.repository)
            .canonicalize()
            .map_err(|e| e.to_string())?,
    })
}

pub(super) fn request(config: &Config, role: PiRole, refill: bool) {
    if cfg!(test)
        || role == PiRole::Merger
        || PREWARM_SHUTTING_DOWN.load(Ordering::SeqCst)
        || config.repository.trim().is_empty()
    {
        return;
    }
    if let Err(error) = schedule(config, role, refill) {
        eprintln!(
            "[Grapher] {} process preparation unavailable: {error}",
            role.name()
        );
    }
}

fn schedule(config: &Config, role: PiRole, refill: bool) -> Result<(), String> {
    // No model/session/resource state exists yet. Model or thinking changes
    // can reuse imports; role, project and auth invalidation still isolate hosts.
    let key = key(config)?;
    let prepare_key = key.clone();
    let prepare = move |ticket: Ticket| {
        let mut command = native::command(role, &prepare_key.repository, &prepare_key.repository)?;
        command
            .args(["--grapher-prewarm", mode(role)])
            .env("GRAPHER_MODE", mode(role))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let process = ReadyProcess::start_with(
            &mut command,
            &ticket,
            Duration::from_secs(30),
            json!({"type":"grapher_prepare", "role":mode(role)}),
        )?;
        Ok((prepare_key, process))
    };
    let label = if role == PiRole::NodeAgent {
        "Serial"
    } else {
        role.name()
    };
    let pool = slot(role).get_or_init(|| Pool::new(label));
    if refill {
        pool.refill(key, prepare);
    } else {
        pool.request(key, prepare);
    }
    Ok(())
}

pub(super) fn claim(config: &Config, role: PiRole, cwd: &Path) -> Option<ReadyProcess> {
    if role == PiRole::Merger
        || PREWARM_SHUTTING_DOWN.load(Ordering::SeqCst)
        || process_control::current_owner().is_none()
    {
        return None;
    }
    let key = key(config).ok()?;
    // An unbound source process cannot acquire a private Graph node's sandbox.
    if cwd.canonicalize().ok()? != key.repository {
        return None;
    }
    slot(role)
        .get()?
        .take_if(&key, |worker| worker.assign_to_current_owner().is_ok())
}

pub(super) fn bind(
    mut process: ReadyProcess,
    role: PiRole,
    command: &Command,
) -> Result<(ReadyProcess, u128), String> {
    let started = Instant::now();
    // Reuse the exact host-built cold-launch arguments and environment. No
    // second implementation of Planner tools, prompts, images or auth policy.
    let args = command
        .get_args()
        .skip(1)
        .map(|arg| {
            arg.to_str()
                .map(str::to_owned)
                .ok_or("Invalid task argument")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let environment = command
        .get_envs()
        .map(|(key, value)| {
            Ok((
                key.to_str()
                    .ok_or("Invalid task environment key")?
                    .to_owned(),
                match value {
                    Some(value) => Value::String(
                        value
                            .to_str()
                            .ok_or("Invalid task environment value")?
                            .to_owned(),
                    ),
                    None => Value::Null,
                },
            ))
        })
        .collect::<Result<Map<String, Value>, String>>()?;
    let cwd = command.get_current_dir().ok_or("Missing task cwd")?;
    process.exchange(json!({"type":"grapher_bind", "role":mode(role), "cwd":cwd, "args":args, "environment":environment}), Duration::from_secs(30))?;
    // Host-ready is not session-ready. No user prompt is sent until the actual
    // freshly created/resumed Pi session has acknowledged this second probe.
    process.exchange(json!({"type":"get_state"}), Duration::from_secs(30))?;
    Ok((process, started.elapsed().as_millis()))
}

pub(super) fn invalidate() {
    for slot in [&PARTITIONER, &PLANNER, &SERIAL] {
        if let Some(pool) = slot.get() {
            pool.invalidate();
        }
    }
}
pub(super) fn shutdown() {
    for slot in [&PARTITIONER, &PLANNER, &SERIAL] {
        if let Some(pool) = slot.get() {
            pool.shutdown();
        }
    }
    for slot in [&PARTITIONER, &PLANNER, &SERIAL] {
        if let Some(pool) = slot.get() {
            if !pool.wait_idle(Duration::from_secs(5)) {
                eprintln!("[Grapher] Process preparation shutdown timed out");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepared_roles_are_project_scoped_and_model_selection_is_late_bound() {
        // No model request and no session construction: test the unbound host.
        let _guard = super::super::tests::lock_env();
        invalidate();
        let temp = tempfile::tempdir().unwrap();
        let repository = temp.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        let config = Config {
            repository: repository.to_string_lossy().into(),
            model: "example/model".into(),
            thinking_level: "off".into(),
            max_parallel: 1,
            max_feedback: 0,
            auto_approve: false,
            environment: None,
            role_models: Default::default(),
        };
        for role in [PiRole::Partitioner, PiRole::Planner, PiRole::NodeAgent] {
            schedule(&config, role, false).unwrap();
        }
        for role in [PiRole::Partitioner, PiRole::Planner, PiRole::NodeAgent] {
            assert!(slot(role).get().unwrap().wait_idle(Duration::from_secs(30)));
            let other = Config {
                model: "example/other".into(),
                ..config.clone()
            };
            let process = process_control::with_owner("prepared-test", || {
                assert!(claim(&config, role, temp.path()).is_none());
                claim(&other, role, &repository)
            })
            .expect("matching prepared role with a late-selected model");
            assert!(claim(&config, role, &repository).is_none());
            let (mut child, _tree, _, _) = process.commit();
            drop(child.stdin.take());
            assert!(child.wait().unwrap().success());
        }
        assert_eq!(std::fs::read_dir(&repository).unwrap().count(), 0);
    }
}
