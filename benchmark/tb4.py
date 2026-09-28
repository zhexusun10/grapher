#!/usr/bin/env python3
"""Run the pinned TB 4.0.0 dataset with Harbor 0.23 and retain comparable evidence.

Usage: python3.12 -m benchmark.tb4 smoke | all
Requires Docker/Colima, a native Linux/arm64 Grapher installation and toolchain
at ~/.local/share/grapher-tb4/{installed,toolchain}, and ~/.pi/agent/auth.json.
Never prints or persists the DeepSeek key. This local single-user Colima setup
requires nested namespace permissions and is NOT a multi-tenant security policy.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path.home() / ".local/share/grapher-tb4"
PROJECT = Path(__file__).resolve().parent.parent
HARBOR = Path.home() / "Desktop/harbor"
DATASET = "terminal-bench/terminal-bench@4.0.0"
MODEL = "deepseek/deepseek-flash"
COMMIT = "a7e7a35b2973b4e1589ed8997ecd6e21fa43b6d1"
TAG_COMMIT = "452bf305c6daa62fc59061d22133a7cbc7c1572e"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def verify_trial(job_dir):
    trials = [p for p in job_dir.iterdir() if p.is_dir() and (p / "result.json").exists()]
    if len(trials) != 1:
        raise RuntimeError(f"Expected one smoke trial, found {len(trials)}")
    trial = trials[0]
    result = json.loads((trial / "result.json").read_text())
    agent_dir = trial / "agent"
    if result.get("exception_info"):
        raise RuntimeError(f"Smoke environment or agent exception: {trial}/exception.txt")
    if not result.get("verifier_result"):
        raise RuntimeError("No verifier result in smoke trial")
    snapshot = json.loads((agent_dir / "snapshot.json").read_text())
    run = json.loads((agent_dir / "result.json").read_text())
    if (run.get("model") != MODEL or not run.get("runId")
            or run.get("phase") != "completed" or snapshot.get("phase") != "completed"):
        raise RuntimeError("Grapher did not complete its smoke run")
    manifest = json.loads((agent_dir / "trace-manifest.json").read_text())
    for entry in manifest:
        file = agent_dir / entry["path"]
        if not file.resolve().is_relative_to(agent_dir.resolve()):
            raise RuntimeError("Unexpected trace path")
        if file.stat().st_size != entry["bytes"] or sha(file) != entry["sha256"]:
            raise RuntimeError(f"Trace integrity failure: {file}")
    print(f"Smoke verified: {trial} (reward={result['verifier_result']['rewards']}, "
          f"route={run['route']}, trace files={len(manifest)})", flush=True)


def main():
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if mode not in {"smoke", "all"}:
        raise SystemExit("Usage: python3.12 -m benchmark.tb4 smoke|all")
    if git(ROOT / "installed", "rev-parse", "HEAD") != COMMIT:
        raise RuntimeError("Installed Grapher commit changed")
    if git(HARBOR, "rev-parse", "HEAD") != "31668af15560fb50a9d0584816d12726036656cf":
        raise RuntimeError("Harbor checkout changed")
    if git(ROOT / "source", "rev-parse", "v4.0.0") != TAG_COMMIT:
        raise RuntimeError("Terminal-Bench tag changed")
    env = os.environ.copy()
    auth = json.loads((Path.home() / ".pi/agent/auth.json").read_text())
    key = auth.get("deepseek", {}).get("key")
    if not key:
        raise RuntimeError("DeepSeek API key not found in Pi auth.json")
    env["DEEPSEEK_API_KEY"] = key
    env["PYTHONPATH"] = f"{PROJECT}:{HARBOR / 'src'}"
    # Avoid accidentally changing the fixed endpoint or the selected model.
    env.pop("DEEPSEEK_BASE_URL", None)
    env.pop("GRAPHER_DATA_DIR", None)
    out = ROOT / ("smoke" if mode == "smoke" else "results")
    out.mkdir(parents=True, exist_ok=True)
    meta = {
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "dataset": DATASET, "dataset_git_tag_commit": TAG_COMMIT,
        # Git tag is additional provenance, NOT the published Hub dataset lock:
        # task package digests on the Hub can differ from the tag's task hashes.
        "upstream_git_tag_manifest_sha256": sha(ROOT / "dataset-4.0.0.toml"),
        "authoritative_task_digests": "Harbor job lock.json trials[].task.digest",
        "harbor_commit": git(HARBOR, "rev-parse", "HEAD"),
        "harbor_version": "0.23.0", "agent": "benchmark.harbor_agent:GrapherAgent",
        "grapher_commit": COMMIT,
        "grapher_binary_sha256": sha(ROOT / "installed/backend/target/release/grapher"),
        "node_binary_sha256": sha(ROOT / "toolchain/bin/node"),
        "adapter_sha256": sha(PROJECT / "benchmark/harbor_agent.py"),
        "runner_sha256": sha(PROJECT / "benchmark/run.py"),
        "compose_overlay_sha256": sha(PROJECT / "benchmark/tb4-compose.yaml"),
        "model": MODEL, "endpoint": "https://api.deepseek.com", "thinking": "max",
        "agent_timeout_sec": 28800, "max_parallel": 2,
        "n_concurrent_trials": 1, "n_attempts": 1, "max_retries": 0,
        "image_policy": "Harbor force-build native ARM64; apt install of missing Debian agent tools before timed trial",
        "credentials": "Pi auth.json deepseek key passed only as process env; no key retained",
        "dataset_size_expected": 66,
    }
    manifest = out / f"invocation-{mode}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    manifest.write_text(json.dumps(meta, indent=2) + "\n")
    mounts = [{"type": "bind", "source": str(ROOT / name), "target": target, "read_only": True}
              for name, target in [("installed", "/installed-agent/grapher"),
                                   ("toolchain", "/installed-agent/grapher-tools")]]
    cmd = [str(Path.home() / ".local/share/grapher-harbor/venv/bin/harbor"),
           "run", "-d", DATASET,
           "-a", "benchmark.harbor_agent:GrapherAgent", "-m", MODEL,
           "--ak", "thinking=max", "--ak", "max_parallel=2",
           "--ak", "bootstrap_debian_tools=true", "--ak", "timeout_sec=28800",
           "--agent-setup-timeout-multiplier", "5",
           "--environment-build-timeout-multiplier", "4",
           "--agent-timeout-multiplier", "2",
           "--force-build", "--mounts", json.dumps(mounts),
           "--extra-docker-compose", str(PROJECT / "benchmark/tb4-compose.yaml"),
           "-n", "1", "-k", "1", "--max-retries", "0", "-o", str(out), "-y"]
    if mode == "smoke":
        cmd += ["-i", "*bun-sourcemap-leak*"]
    meta["command_without_credentials"] = cmd
    manifest.write_text(json.dumps(meta, indent=2) + "\n")
    before = set(out.glob("*/result.json"))
    print(f"Starting {mode}: {manifest}", flush=True)
    # Harbor resolves process DEEPSEEK_API_KEY through ModelConnectionSpec;
    # it does not need --agent-env nor a key in the job config/argv.
    result = subprocess.run(cmd, cwd=PROJECT, env=env)
    del key, auth
    new = set(out.glob("*/result.json")) - before
    if result.returncode or len(new) != 1:
        raise RuntimeError(f"Harbor {mode} failed: exit={result.returncode}, jobs={new}")
    job_dir = next(iter(new)).parent
    meta["job_dir"] = str(job_dir)
    meta["finished_utc"] = datetime.now(timezone.utc).isoformat()
    meta["exit_code"] = result.returncode
    manifest.write_text(json.dumps(meta, indent=2) + "\n")
    if mode == "smoke":
        verify_trial(job_dir)
    else:
        trials = list(job_dir.glob("*/result.json"))
        meta["trials_recorded"] = len(trials)
        meta["trial_exceptions"] = sum(bool(json.loads(p.read_text()).get("exception_info"))
                                       for p in trials)
        manifest.write_text(json.dumps(meta, indent=2) + "\n")
        if len(trials) != meta["dataset_size_expected"]:
            raise RuntimeError(f"Incomplete dataset: {len(trials)} of {meta['dataset_size_expected']} trials; see {job_dir}")
        print(f"All trials finished: {job_dir}; platform exceptions={meta['trial_exceptions']}", flush=True)


if __name__ == "__main__":
    main()
