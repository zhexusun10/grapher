//! Native execution resources. Device locks coordinate Grapher instances for
//! this host user; they are not isolation from unrelated host applications.
use crate::{
    environment::EnvironmentConfig, native_runtime_storage, path_safety::real_child_path, workspace,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resources {
    /// Windows Job aggregate committed memory, not a per-process RSS estimate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    /// Windows Job CPU hard cap in basis points (10000 = all host CPUs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_rate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<Device>,
    /// Initialization can involve large offline packages; finite, explicit limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initialize_timeout_seconds: Option<u64>,
    /// None permits long-running result workloads until explicit cancellation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_timeout_seconds: Option<u64>,
    /// Bounded stdout/stderr retention for long native workloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub backend: String,
    /// CUDA uses exact GPU UUIDs, never host ordinals or all available devices.
    pub ids: Vec<String>,
    /// Existing absolute native nvidia-smi; no PATH lookup or global fallback.
    pub probe: String,
}

impl Resources {
    pub fn validate(&self) -> Result<(), String> {
        if self.memory_bytes.is_some() || self.cpu_rate.is_some() {
            if !cfg!(windows) {
                return Err("Aggregate CPU/memory quotas require a supported native Job backend on this host; no per-process substitute".into());
            }
            if self
                .memory_bytes
                .is_some_and(|bytes| bytes < 32 * 1024 * 1024 || bytes > usize::MAX as u64)
            {
                return Err("Native memory quota must be at least 32 MiB and fit the host".into());
            }
            if self.cpu_rate.is_some_and(|rate| rate == 0 || rate > 10000) {
                return Err("Native CPU rate must be 1..10000 basis points".into());
            }
        }
        for seconds in [self.initialize_timeout_seconds, self.result_timeout_seconds]
            .into_iter()
            .flatten()
        {
            if seconds == 0 || seconds > 365 * 24 * 3600 {
                return Err("Explicit native command timeout must be 1..31536000 seconds".into());
            }
        }
        if self
            .max_output_bytes
            .is_some_and(|bytes| !(4 * 1024 * 1024..=256 * 1024 * 1024).contains(&bytes))
        {
            return Err("Native output cap must be between 4 MiB and 256 MiB".into());
        }
        if let Some(device) = &self.device {
            if device.backend != "cuda" || !cfg!(any(windows, target_os = "linux")) {
                return Err(format!("Native accelerator backend not implemented on this host: {}; no CPU/OS fallback", device.backend));
            }
            if device.ids.is_empty()
                || device.ids.len() > 8
                || !Path::new(&device.probe).is_absolute()
                || !Path::new(&device.probe).is_file()
            {
                return Err(
                    "CUDA needs explicit UUIDs and an existing absolute native nvidia-smi probe"
                        .into(),
                );
            }
            let mut ids = device.ids.clone();
            ids.sort();
            ids.dedup();
            if ids.len() != device.ids.len()
                || ids
                    .iter()
                    .any(|id| !id.starts_with("GPU-") || uuid::Uuid::parse_str(&id[4..]).is_err())
            {
                return Err("CUDA devices must be distinct exact GPU UUIDs".into());
            }
        }
        Ok(())
    }

    /// Stable native device evidence becomes part of D, not transient telemetry.
    pub(crate) fn device_identity(&self) -> Result<Option<Vec<String>>, String> {
        self.validate()?;
        let Some(device) = &self.device else {
            return Ok(None);
        };
        let mut command = Command::new(&device.probe);
        command
            .args([
                "--query-gpu=uuid,name,driver_version",
                "--format=csv,noheader",
            ])
            .env_clear();
        // Windows NVML locates native driver components through ProgramFiles;
        // these are OS installation roots, not inherited business PATH/secrets.
        for name in [
            "SystemRoot",
            "WINDIR",
            "ProgramFiles",
            "ProgramW6432",
            "TEMP",
            "TMP",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let output = crate::environment::controlled_output(command)?;
        let output = String::from_utf8(output).map_err(|e| e.to_string())?;
        let mut selected = Vec::new();
        for id in &device.ids {
            let row = output
                .lines()
                .find(|row| row.split(',').next().map(str::trim) == Some(id.as_str()))
                .ok_or_else(|| {
                    format!("Requested native CUDA device unavailable: {id}; no substitute")
                })?;
            let fields: Vec<_> = row.split(',').map(str::trim).collect();
            if fields.len() != 3 || fields.iter().any(|value| value.is_empty()) {
                return Err("Invalid native accelerator identity probe".into());
            }
            selected.push(fields.join(","));
        }
        selected.sort();
        Ok(Some(selected))
    }
}

#[derive(Debug)]
pub(crate) struct DeviceLease {
    _files: Vec<fs::File>,
}

fn lease_parent() -> Result<PathBuf, String> {
    // Shared across data roots, not a per-Run/data-root pseudo-lease.
    let parent = workspace::host_cache_root().join("grapher-device-leases");
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    real_child_path(
        parent.parent().ok_or("Missing device lease parent")?,
        &parent,
        false,
    )?;
    Ok(parent)
}

pub(crate) fn acquire(config: &EnvironmentConfig) -> Result<DeviceLease, String> {
    let Some(resources) = &config.resources else {
        return Ok(DeviceLease { _files: vec![] });
    };
    let Some(device) = resources.device.as_ref() else {
        return Ok(DeviceLease { _files: vec![] });
    };
    let lease = acquire_ids(&lease_parent()?, &device.ids)?;
    resources.device_identity()?;
    Ok(lease)
}

fn acquire_ids(parent: &Path, ids: &[String]) -> Result<DeviceLease, String> {
    let mut keys = ids.to_vec();
    keys.sort();
    let mut files = Vec::new();
    for id in keys {
        if !id.starts_with("GPU-") || uuid::Uuid::parse_str(&id[4..]).is_err() {
            return Err("Invalid device lease key".into());
        }
        let path = parent.join(format!("cuda-{}.lock", id.to_ascii_lowercase()));
        real_child_path(parent, &path, true)?;
        let file = native_runtime_storage::lock_file(&path, false)?.ok_or_else(|| {
            format!("Native CUDA device lease busy: {id}; retry when the current writer drains")
        })?;
        files.push(file);
    }
    Ok(DeviceLease { _files: files })
}

pub(crate) fn bind(command: &mut Command, config: &EnvironmentConfig) -> Result<(), String> {
    if let Some(device) = config.resources.as_ref().and_then(|r| r.device.as_ref()) {
        command.env(
            "GRAPHER_ACCELERATOR_BINDING",
            serde_json::to_string(device).map_err(|e| e.to_string())?,
        );
    }
    Ok(())
}

/// The trusted project must actually compute and synchronize through PyTorch;
/// finding nvidia-smi is only admission evidence, never framework acceptance.
pub(crate) const CUDA_PROOF: &str = r#"import json,os,torch
assert torch.cuda.is_available(), 'Declared CUDA unavailable; CPU fallback forbidden'
assert torch.version.cuda is not None and torch.version.hip is None
ids=os.environ['CUDA_VISIBLE_DEVICES'].split(',')
assert torch.cuda.device_count()==len(ids), 'Device visibility differs from the lease'
proof=[]
for i in range(len(ids)):
    p=torch.cuda.get_device_properties(i)
    actual=str(getattr(p,'uuid',''))
    actual='GPU-'+actual.removeprefix('GPU-')
    assert actual.lower()==ids[i].lower(), 'Computed device UUID differs from the lease; no substitute'
    x=torch.arange(1024,device='cuda:'+str(i),dtype=torch.int64)
    y=(x*x).sum()
    torch.cuda.synchronize(i)
    assert y.item()==sum(k*k for k in range(1024))
    proof.append({'id':ids[i],'actualId':actual,'name':p.name,'capability':list(torch.cuda.get_device_capability(i)),'sum':y.item()})
print(json.dumps({'backend':'cuda','framework':torch.__version__,'runtime':torch.version.cuda,'devices':proof},sort_keys=True))
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leases_are_exclusive_across_threads_and_release_partial_multi_device_acquisition() {
        let root = tempfile::tempdir().unwrap();
        let a = format!("GPU-{}", uuid::Uuid::new_v4());
        let b = format!("GPU-{}", uuid::Uuid::new_v4());
        let held = acquire_ids(root.path(), &[b.clone()]).unwrap();
        let conflict = acquire_ids(root.path(), &[a.clone(), b.clone()]).unwrap_err();
        assert!(
            conflict.contains("busy"),
            "expected lease conflict, got: {conflict}"
        );
        let a_lease = acquire_ids(root.path(), &[a.clone()]).unwrap();
        let path = root.path().to_path_buf();
        let other = b.clone();
        assert!(
            std::thread::spawn(move || acquire_ids(&path, &[other]).is_err())
                .join()
                .unwrap()
        );
        drop(held);
        drop(a_lease);
        acquire_ids(root.path(), &[a, b]).unwrap();
    }
    #[test]
    fn lease_subprocess() {
        let Some(root) = std::env::var_os("GRAPHER_TEST_DEVICE_LEASE_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let id = std::env::var("GRAPHER_TEST_DEVICE_LEASE_ID").unwrap();
        let _lease = acquire_ids(&root, &[id]).unwrap();
        fs::write(root.join("ready"), "leased").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn device_leases_coordinate_native_processes_and_release_after_crash() {
        let root = tempfile::tempdir().unwrap();
        let id = format!("GPU-{}", uuid::Uuid::new_v4());
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "environment_resources::tests::lease_subprocess",
                "--nocapture",
            ])
            .env("GRAPHER_TEST_DEVICE_LEASE_ROOT", root.path())
            .env("GRAPHER_TEST_DEVICE_LEASE_ID", &id)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .unwrap();
        let ready = std::time::Instant::now();
        while !root.path().join("ready").exists()
            && ready.elapsed() < std::time::Duration::from_secs(10)
        {
            if child.try_wait().unwrap().is_some() {
                panic!("Lease subprocess exited before acquisition");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let acquired = root.path().join("ready").exists();
        let busy = acquired
            && matches!(acquire_ids(root.path(), &[id.clone()]), Err(error) if error.contains("busy"));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(
            acquired && busy,
            "Independent native process must hold the same exclusive lease"
        );
        acquire_ids(root.path(), &[id]).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_memory_limit_covers_combined_native_descendants() {
        // One descendant plus its parent fits the 384 MiB ceiling. Two 220 MiB
        // descendants must fail against the aggregate Job, not per-process RSS.
        let node = crate::native::trusted_node().unwrap();
        let script = r#"const{spawn}=require('node:child_process');
const program="const chunks=[];try{for(let i=0;i<220;i++)chunks.push(Buffer.alloc(1024*1024,1));process.stdout.write('READY\\n');setTimeout(()=>process.exit(0),2500)}catch(e){console.error('QUOTA_ALLOCATION_FAILED');process.exit(23)}";
const count=Number(process.argv[1]||2);let left=count,failed=false; for(let i=0;i<count;i++){const child=spawn(process.execPath,['-e',program],{stdio:['ignore','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.on('exit',code=>{failed ||= code!==0;if(--left===0)process.exit(failed?19:0)})}"#;
        let mut baseline = Command::new(&node);
        baseline.args(["-e", script]);
        let output = crate::environment::controlled_output(baseline).unwrap();
        assert_eq!(
            String::from_utf8(output).unwrap().matches("READY").count(),
            2
        );
        let mut command = Command::new(node);
        command.args(["-e", script]);
        let resources = Resources {
            memory_bytes: Some(384 * 1024 * 1024),
            ..Default::default()
        };
        let mut single = Command::new(crate::native::trusted_node().unwrap());
        single.args(["-e", script, "1"]);
        assert!(
            crate::process_control::with_resource_limits(Some(&resources), || {
                crate::environment::controlled_output(single)
            })
            .is_ok(),
            "The same aggregate quota must admit one descendant"
        );
        let result = crate::process_control::with_resource_limits(Some(&resources), || {
            crate::environment::controlled_output(command)
        });
        let error = result.unwrap_err();
        assert!(
            (error.contains("QUOTA_ALLOCATION_FAILED") || error.contains("out of memory"))
                && !error.contains("SyntaxError"),
            "Expected a descendant quota failure, got {error}"
        );
        // TLS must not leak a quota into subsequent writers or metadata probes.
        let mut command = Command::new(crate::native::trusted_node().unwrap());
        command.args([
            "-e",
            "const a=Buffer.alloc(450*1024*1024,1);console.log(a.length)",
        ]);
        assert!(crate::environment::controlled_output(command).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_cpu_hard_cap_bounds_aggregate_native_descendant_work() {
        let cpus = std::thread::available_parallelism().unwrap().get() as u32;
        let script = r#"const{spawn}=require('node:child_process');
const work="const start=Date.now(),cpu=process.cpuUsage();let x=0;while(Date.now()-start<3000)x+=Math.sin(x+1);const used=process.cpuUsage(cpu);console.log(JSON.stringify({ms:(used.user+used.system)/1000,x}))";
Promise.all([0,1].map(()=>new Promise((resolve,reject)=>{let out='';const c=spawn(process.execPath,['-e',work],{stdio:['ignore','pipe','inherit']});c.stdout.on('data',v=>out+=v);c.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(Error('child failed')))}))).then(v=>console.log(JSON.stringify(v)),e=>{console.error(e);process.exit(1)})"#;
        let run = |resources: Option<&Resources>| {
            let mut command = Command::new(crate::native::trusted_node().unwrap());
            command.args(["-e", script]);
            let output = crate::process_control::with_resource_limits(resources, || {
                crate::environment::controlled_output(command)
            })
            .unwrap();
            let values: Vec<serde_json::Value> = serde_json::from_slice(&output).unwrap();
            values
                .iter()
                .map(|value| value["ms"].as_f64().unwrap())
                .sum::<f64>()
        };
        let unlimited = run(None);
        let resources = Resources {
            cpu_rate: Some((5000 / cpus).max(1)),
            ..Default::default()
        };
        let limited = run(Some(&resources));
        eprintln!("Native Job CPU proof: logical CPUs={cpus}, rate={}, descendant CPU ms: unlimited={unlimited:.0}, limited={limited:.0}", resources.cpu_rate.unwrap());
        assert!(
            limited < 3000.0 && limited < unlimited * 0.8,
            "Aggregate CPU hard cap did not constrain both descendants"
        );
    }

    #[test]
    fn strong_resource_requirements_are_validated_not_guessed() {
        assert!(Resources {
            cpu_rate: Some(0),
            ..Resources::default()
        }
        .validate()
        .is_err());
        assert!(Resources {
            memory_bytes: Some(1),
            ..Resources::default()
        }
        .validate()
        .is_err());
        assert!(Resources {
            result_timeout_seconds: Some(0),
            ..Resources::default()
        }
        .validate()
        .is_err());
        assert!(Resources {
            max_output_bytes: Some(1024),
            ..Resources::default()
        }
        .validate()
        .is_err());
        let executable = crate::native::trusted_node()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        for ids in [vec![], vec!["0".into()], vec!["GPU-invalid".into()]] {
            assert!(Resources {
                device: Some(Device {
                    backend: "cuda".into(),
                    ids,
                    probe: executable.clone()
                }),
                ..Resources::default()
            }
            .validate()
            .is_err());
        }
    }
}
