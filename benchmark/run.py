#!/usr/bin/env python3
"""Run one Harbor trial against an isolated, local Grapher backend.

This file runs INSIDE the Harbor task environment. It has no Harbor/Python deps.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib import error, request


ROLE_MODELS = ("PARTITIONER_MODEL", "PLANNER_MODEL", "NODE_AGENT_MODEL", "MERGER_MODEL")
TERMINAL_FAILURES = {"needs_attention", "publication_failed", "rejected", "paused"}


class TrialCancelled(Exception):
    pass


def _handle_cancel(signum, _frame):
    raise TrialCancelled(f"Harbor cancelled Grapher (signal {signum})")


def _parent_death_signal(parent_pid):
    """Ensure a hard-killed Harbor runner cannot leave a live Linux backend."""
    def arm():
        # Linux prctl(PR_SET_PDEATHSIG, SIGTERM); inherited by the backend only.
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "Cannot configure Grapher parent-death signal")
        if os.getppid() != parent_pid:
            os.kill(os.getpid(), signal.SIGTERM)
    return arm


def harbor_usage(result):
    """Map Pi's uncached/cache token buckets to Harbor's inclusive input count."""
    usage = (result.get("runMetrics") or {}).get("totalUsage")
    if not isinstance(usage, dict):
        return None
    return {
        "input": usage.get("input", 0) + usage.get("cacheRead", 0) + usage.get("cacheWrite", 0),
        "cache": usage.get("cacheRead", 0),
        "output": usage.get("output", 0),
    }


def config_for(repository, model, thinking, max_parallel):
    if not model or "/" not in model or not all(model.split("/", 1)):
        raise ValueError("--model must be a fully qualified provider/model identifier")
    if not 1 <= max_parallel <= 8:
        raise ValueError("--max-parallel must be between 1 and 8")
    path = Path(repository).resolve(strict=True)
    if not path.is_dir():
        raise ValueError("Harbor task workdir must be a directory")
    return {
        "repository": str(path),
        "model": model,
        "thinkingLevel": thinking,
        "maxParallel": max_parallel,
        "maxFeedback": 3,
        "autoApprove": True,
    }


class GrapherClient:
    def __init__(self, port):
        self.url = f"http://127.0.0.1:{port}/api/"
        self.last_snapshot = None

    def call(self, command, data=None, timeout=30):
        body = json.dumps(data or {}).encode("utf-8")
        req = request.Request(
            self.url + command, body,
            {"Content-Type": "application/json", "Host": self.url.split("/")[2]},
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=timeout) as response:
                reply = json.load(response)
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(detail).get("error", detail)
            except ValueError:
                pass
            raise RuntimeError(f"Grapher {command}: {detail}") from exc
        if not isinstance(reply, dict) or "result" not in reply:
            raise RuntimeError(f"Invalid Grapher {command} response: {reply!r}")
        if command in ("plan_goal", "snapshot", "control") and isinstance(reply["result"], dict):
            self.last_snapshot = reply["result"]
        return reply["result"]


def run_goal(client, instruction, config, timeout, poll_interval=1.0):
    # No mode=graph/serial: the Partitioner must choose, including on Linux.
    deadline = time.monotonic() + timeout
    snap = client.call("plan_goal", {"goal": instruction, "config": config}, timeout=timeout)
    run_id = snap.get("runId")
    if not run_id:
        raise RuntimeError("Planning returned no runId")
    if snap.get("phase") == "awaiting_approval" and not snap.get("approved"):
        # Defensive compatibility with older Grapher builds. Still only approve
        # a graph after the server has compiled it and made it approvable.
        snap = client.call("control", {"action": "approve"})
    while True:
        if snap.get("runId") != run_id:
            raise RuntimeError("Grapher switched runs during the trial")
        phase = snap.get("phase")
        if phase == "completed":
            if (not snap.get("approved") or snap.get("planType") not in ("serial", "graph")
                or not snap.get("nodes") or any(
                    node.get("status") != "done" for node in snap["nodes"].values()
                ) or (snap.get("planType") == "graph" and
                      (snap.get("publication") or {}).get("status") != "completed")):
                raise RuntimeError("Grapher reported completion without published successful work")
            return snap
        if phase in TERMINAL_FAILURES or phase == "awaiting_approval":
            failures = {name: node.get("error") for name, node in snap.get("nodes", {}).items()
                        if node.get("status") != "done"}
            raise RuntimeError(f"Grapher run {run_id} stopped in {phase}: "
                               f"{(snap.get('publication') or {}).get('error') or failures}")
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Grapher run {run_id} exceeded {timeout}s (phase={phase})")
        time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))
        snap = client.call("snapshot", {"detail": "metadata"}, timeout=min(30, max(1, deadline - time.monotonic())))


def retain_trace(data_dir, logs):
    """Keep reproducible trial evidence, not the task's shadow Git repo or Pi credentials.

    The backend has stopped before this is called, so SQLite's WAL can safely
    be checkpointed via backup. Never follow symlinks created by agent code.
    """
    source = Path(data_dir)
    trace = logs / "trace"
    trace.mkdir(exist_ok=True)
    manifest = []
    for directory in ("planning", "planner-sessions", "sessions", "mergers"):
        origin = source / directory
        if not origin.is_dir() or origin.is_symlink():
            continue
        for base, dirs, files in os.walk(origin, followlinks=False):
            dirs[:] = [d for d in dirs if d != "jiti" and not (Path(base) / d).is_symlink()]
            for filename in files:
                item = Path(base) / filename
                if not item.is_file() or item.is_symlink():
                    continue
                dest = trace / item.relative_to(source)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(item, dest)
                manifest.append(dest)
    database = source / "events.sqlite"
    if database.is_file() and not database.is_symlink():
        dest = trace / "events.sqlite"
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as original, \
             sqlite3.connect(dest) as backup:
            original.backup(backup)
        manifest.append(dest)
    # Do not archive config.json, shadow_repos, runtime.lock or the private Pi
    # directory. Hashes make it possible to detect incomplete log transfers.
    entries = []
    for item in sorted(manifest):
        digest = hashlib.sha256()
        with item.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        entries.append({"path": str(item.relative_to(logs)), "bytes": item.stat().st_size,
                        "sha256": digest.hexdigest()})
    (logs / "trace-manifest.json").write_text(json.dumps(entries, indent=2), encoding="utf-8")


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--instruction-file", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--thinking", default="medium")
    parser.add_argument("--max-parallel", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--logs", required=True)
    args = parser.parse_args(argv)
    logs = Path(args.logs)
    logs.mkdir(parents=True, exist_ok=True)
    instruction = Path(args.instruction_file).read_text(encoding="utf-8")
    config = config_for(args.repository, args.model, args.thinking, args.max_parallel)
    if not instruction.strip() or args.timeout <= 0:
        raise ValueError("Empty instruction or invalid timeout")
    port = free_port()
    signal.signal(signal.SIGTERM, _handle_cancel)
    signal.signal(signal.SIGINT, _handle_cancel)
    # Pi credentials must remain accessible to Graph nodes. Grapher isolates
    # runtime data except the current session, so keep Pi config beside it.
    with tempfile.TemporaryDirectory(prefix="grapher-harbor-") as data_dir, \
         tempfile.TemporaryDirectory(prefix="grapher-harbor-pi-") as pi_dir:
        env = os.environ.copy()
        env.update({"GRAPHER_PORT": str(port), "GRAPHER_DATA_DIR": data_dir,
                    "PI_CODING_AGENT_DIR": pi_dir,
                    "GRAPHER_ISOLATED_PI_MODELS": "1"})
        # Avoid hidden .env or role-specific overrides silently changing the
        # provider/model for the Partitioner, Planner, nodes or merger.
        env.update({key: args.model for key in ROLE_MODELS})
        with (logs / "backend.log").open("w", encoding="utf-8") as output:
            # Do not source an arbitrary task's .env via Grapher's backend
            # load_env_file(); Pi itself still works in the task repository.
            process = subprocess.Popen([args.binary], cwd=data_dir, env=env,
                                       stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=(os.name == "posix"),
                                       preexec_fn=(_parent_death_signal(os.getpid())
                                                   if sys.platform == "linux" else None))
            client = GrapherClient(port)
            try:
                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError(f"Grapher backend exited during startup ({process.returncode})")
                    try:
                        client.call("snapshot", timeout=1)
                        break
                    except TrialCancelled:
                        raise
                    except (OSError, RuntimeError):
                        time.sleep(0.1)
                else:
                    raise TimeoutError("Grapher backend did not start")
                snap = run_goal(client, instruction, config, args.timeout)
                (logs / "snapshot.json").write_text(json.dumps(snap, indent=2), encoding="utf-8")
                (logs / "result.json").write_text(json.dumps({
                    "runId": snap["runId"], "route": snap.get("planType"),
                    "phase": snap["phase"], "model": args.model,
                    "planning": snap.get("planning"), "runMetrics": snap.get("runMetrics"),
                }, indent=2), encoding="utf-8")
                print(f"Grapher {snap['runId']} completed ({snap.get('planType')})", flush=True)
            except Exception as exc:
                snap = client.last_snapshot or {}
                (logs / "snapshot.json").write_text(json.dumps(snap, indent=2), encoding="utf-8")
                (logs / "result.json").write_text(json.dumps({
                    "runId": snap.get("runId"), "route": snap.get("planType"),
                    "phase": snap.get("phase", "failed"), "model": args.model,
                    "planning": snap.get("planning"), "runMetrics": snap.get("runMetrics"),
                    "error": str(exc),
                }, indent=2), encoding="utf-8")
                raise
            finally:
                # Do not let a second Harbor signal interrupt child cleanup.
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                signal.signal(signal.SIGINT, signal.SIG_IGN)
                if process.poll() is None:
                    if os.name == "posix":
                        os.killpg(process.pid, signal.SIGTERM)
                    else:
                        process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        if os.name == "posix":
                            os.killpg(process.pid, signal.SIGKILL)
                        else:
                            process.kill()
                        process.wait()
                # The runtime directory is deleted at the end of the trial.
                # Fail closed if archiving fails rather than report an
                # unauditable successful run.
                retain_trace(data_dir, logs)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Grapher Harbor trial failed: {exc}", file=sys.stderr)
        sys.exit(1)
