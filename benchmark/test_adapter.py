"""Model-free contract tests: python3 -m unittest discover -s benchmark -p 'test_*.py'."""

import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

from benchmark.run import config_for, harbor_usage, retain_trace, run_goal


class FakeClient:
    def __init__(self, initial, following=()):
        self.initial = initial
        self.following = iter(following)
        self.calls = []

    def call(self, command, data=None, timeout=30):
        self.calls.append((command, data))
        if command == "plan_goal":
            return self.initial
        if command in ("control", "snapshot"):
            return next(self.following)
        raise AssertionError(command)


def state(phase, route="graph", approved=True):
    return {"runId": "one", "phase": phase, "planType": route, "approved": approved,
            "nodes": {"work": {"status": "done" if phase == "completed" else "running"}},
            "publication": {"status": "completed" if phase == "completed" else "publishing"}}


class AdapterTests(unittest.TestCase):
    def test_single_model_auto_mode_and_approval(self):
        with tempfile.TemporaryDirectory() as repo:
            config = config_for(repo, "anthropic/sonnet", "low", 2)
            self.assertTrue(config["autoApprove"])
            self.assertEqual(config["maxFeedback"], 3)
            client = FakeClient(state("awaiting_approval", approved=False),
                                [state("running"), state("completed")])
            finished = run_goal(client, "Build the feature", config, 2, 0)
            self.assertEqual(finished["phase"], "completed")
            self.assertEqual(client.calls[0], ("plan_goal", {"goal": "Build the feature", "config": config}))
            self.assertEqual(client.calls[1], ("control", {"action": "approve"}))
            self.assertEqual(client.calls[2][0], "snapshot")

    def test_plan_failure_never_retries_as_serial(self):
        class FailingClient(FakeClient):
            def call(self, command, data=None, timeout=30):
                self.calls.append((command, data))
                raise RuntimeError("Native Graph execution requires macOS sandbox-exec")

        client = FailingClient(state("running"))
        with self.assertRaisesRegex(RuntimeError, "Native Graph"):
            run_goal(client, "task", {}, 1)
        self.assertEqual([command for command, _ in client.calls], ["plan_goal"])

    def test_serial_also_auto_approves(self):
        client = FakeClient(state("completed", route="serial"))
        self.assertEqual(run_goal(client, "task", {}, 1)["planType"], "serial")
        self.assertEqual(len(client.calls), 1)

    def test_fail_closed_on_graph_without_publication(self):
        snap = state("completed")
        snap["publication"] = None
        with self.assertRaisesRegex(RuntimeError, "without published"):
            run_goal(FakeClient(snap), "task", {}, 1)

    def test_fail_closed_on_attention_and_foreign_run(self):
        with self.assertRaisesRegex(RuntimeError, "needs_attention"):
            run_goal(FakeClient(state("needs_attention")), "task", {}, 1)
        other = state("completed")
        other["runId"] = "two"
        with self.assertRaisesRegex(RuntimeError, "switched runs"):
            run_goal(FakeClient(state("running"), [other]), "task", {}, 1, 0)

    def test_usage_includes_cached_tokens_in_harbor_input(self):
        result = {"runMetrics": {"totalUsage": {
            "input": 10, "cacheRead": 7, "cacheWrite": 3, "output": 4,
        }}}
        self.assertEqual(harbor_usage(result), {"input": 20, "cache": 7, "output": 4})
        self.assertIsNone(harbor_usage({"phase": "failed"}))

    def test_trace_keeps_sessions_and_sqlite_wal_but_not_shadow_repos_or_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data, logs = root / "data", root / "logs"
            data.mkdir()
            logs.mkdir()
            db = sqlite3.connect(data / "events.sqlite")
            db.execute("pragma journal_mode=WAL")
            db.execute("create table events (payload text)")
            db.execute("insert into events values ('one')")
            db.commit()
            (data / "planning" / "one" / "partition-session").mkdir(parents=True)
            (data / "planning" / "one" / "partition.jsonl").write_text('partition')
            (data / "planning" / "one" / "partition-session" / "turns.jsonl").write_text('turns')
            (data / "sessions" / "node").mkdir(parents=True)
            (data / "sessions" / "node" / "agent.jsonl").write_text('node')
            (data / "sessions" / "node" / "jiti").mkdir()
            (data / "sessions" / "node" / "jiti" / "compiled.mjs").write_text('cache')
            (data / "planner-sessions" / "run").mkdir(parents=True)
            (data / "planner-sessions" / "run" / "turns.jsonl").write_text('planner')
            (data / "mergers" / "run").mkdir(parents=True)
            (data / "mergers" / "run" / "output.jsonl").write_text('merger')
            (data / "shadow_repos").mkdir()
            (data / "shadow_repos" / "secret").write_text('no')
            (data / "sessions" / "node" / "leak").symlink_to(data / "shadow_repos" / "secret")
            retain_trace(data, logs)
            db.close()
            self.assertEqual(sqlite3.connect(logs / "trace/events.sqlite").execute(
                "select payload from events").fetchone(), ('one',))
            self.assertTrue((logs / "trace/planning/one/partition-session/turns.jsonl").is_file())
            self.assertTrue((logs / "trace/planner-sessions/run/turns.jsonl").is_file())
            self.assertTrue((logs / "trace/sessions/node/agent.jsonl").is_file())
            self.assertTrue((logs / "trace/mergers/run/output.jsonl").is_file())
            self.assertFalse((logs / "trace/shadow_repos").exists())
            self.assertFalse((logs / "trace/sessions/node/leak").exists())
            self.assertFalse((logs / "trace/sessions/node/jiti").exists())
            manifest = json.loads((logs / "trace-manifest.json").read_text())
            self.assertEqual(len(manifest), 6)
            self.assertTrue(all(entry['sha256'] and entry['bytes'] > 0 for entry in manifest))

    def test_reject_unqualified_model(self):
        with tempfile.TemporaryDirectory() as repo:
            with self.assertRaisesRegex(ValueError, "provider/model"):
                config_for(repo, "sonnet", "medium", 4)

    def test_graph_lifecycle_requires_publication_in_task_directory(self):
        backend = '''#!/usr/bin/env python3
import json, os
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
repo = None
class Handler(BaseHTTPRequestHandler):
 def do_POST(self):
  global repo
  body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if self.path.endswith('plan_goal'):
   assert 'mode' not in body and body['config']['autoApprove'] is True
   assert os.environ['PLANNER_MODEL'] == os.environ['NODE_AGENT_MODEL'] == body['config']['model']
   repo = Path(body['config']['repository'])
   result = {'runId':'graph-run','phase':'running','approved':True,'planType':'graph'}
  elif self.path.endswith('snapshot'):
   if repo is None: result = {'runId':'','phase':'draft'}
   else:
    (repo/'published.txt').write_text('merged result')
    result = {'runId':'graph-run','phase':'completed','approved':True,'planType':'graph',
      'nodes':{'first':{'status':'done'},'second':{'status':'done'}},
      'publication':{'status':os.environ.get('FAKE_PUBLICATION','completed')}}
  else: raise AssertionError(self.path)
  data = json.dumps({'result':result}).encode()
  self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
 def log_message(self, *args): pass
HTTPServer(('127.0.0.1',int(os.environ['GRAPHER_PORT'])),Handler).serve_forever()
'''
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binary = root / "backend.py"
            binary.write_text(backend)
            binary.chmod(0o755)
            (root / "instruction.txt").write_text("Build both features")
            command = [sys.executable, str(Path(__file__).with_name("run.py")),
                       "--binary", str(binary), "--repository", str(root),
                       "--instruction-file", str(root / "instruction.txt"),
                       "--model", "openai/gpt-test", "--logs", str(root / "logs"),
                       "--timeout", "10"]
            success = subprocess.run(command, capture_output=True, text=True, timeout=20)
            self.assertEqual(success.returncode, 0, success.stderr)
            self.assertEqual((root / "published.txt").read_text(), "merged result")
            result = json.loads((root / "logs/result.json").read_text())
            self.assertEqual((result["route"], result["phase"]), ("graph", "completed"))
            self.assertEqual(json.loads((root / "logs/snapshot.json").read_text())["runId"], "graph-run")
            self.assertTrue((root / "logs/trace-manifest.json").exists())
            failure = subprocess.run(command, env={**os.environ, "FAKE_PUBLICATION": "failed"},
                                     capture_output=True, text=True, timeout=20)
            self.assertNotEqual(failure.returncode, 0)
            self.assertIn("without published", failure.stderr)
            failed_result = json.loads((root / "logs/result.json").read_text())
            self.assertEqual((failed_result["runId"], failed_result["route"]), ("graph-run", "graph"))
            self.assertEqual(json.loads((root / "logs/snapshot.json").read_text())["runId"], "graph-run")
            self.assertTrue((root / "logs/trace-manifest.json").exists())

    def test_cancel_terminates_backend_without_detached_work(self):
        backend = '''#!/usr/bin/env python3
import json, os, time
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
root = Path(os.environ['FAKE_TEST_DIR'])
(root/'backend.pid').write_text(str(os.getpid()))
class Handler(BaseHTTPRequestHandler):
 def do_POST(self):
  self.rfile.read(int(self.headers['Content-Length']))
  if self.path.endswith('plan_goal'):
   (root/'planning.started').write_text('yes')
   time.sleep(60)
  data = json.dumps({'result':{'runId':'','phase':'draft'}}).encode()
  self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
 def log_message(self, *args): pass
HTTPServer(('127.0.0.1',int(os.environ['GRAPHER_PORT'])),Handler).serve_forever()
'''
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binary = root / 'backend.py'
            binary.write_text(backend)
            binary.chmod(0o755)
            (root / 'instruction.txt').write_text('task')
            process = subprocess.Popen([
                sys.executable, str(Path(__file__).with_name('run.py')),
                '--binary', str(binary), '--repository', str(root),
                '--instruction-file', str(root / 'instruction.txt'),
                '--model', 'openai/test', '--logs', str(root / 'logs'),
                '--timeout', '80',
            ], env={**os.environ, 'FAKE_TEST_DIR': str(root)},
               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic() + 10
                while not (root / 'planning.started').exists():
                    self.assertIsNone(process.poll(), 'runner terminated before planning')
                    self.assertLess(time.monotonic(), deadline, 'runner never started planning')
                    time.sleep(0.05)
                backend_pid = int((root / 'backend.pid').read_text())
                process.send_signal(signal.SIGTERM)
                _, stderr = process.communicate(timeout=10)
                self.assertNotEqual(process.returncode, 0)
                self.assertIn('Harbor cancelled Grapher', stderr)
                self.assertIn('cancelled', (root / 'logs/result.json').read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(backend_pid, 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)

    @unittest.skipUnless(sys.platform == "linux", "Linux parent-death signal")
    def test_forced_runner_kill_cannot_leave_live_backend(self):
        driver = '''import os, signal, subprocess, sys, time
from pathlib import Path
from benchmark.run import _parent_death_signal
p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],
                     start_new_session=True, preexec_fn=_parent_death_signal(os.getpid()))
Path(sys.argv[1]).write_text(str(p.pid))
time.sleep(60)
'''
        with tempfile.TemporaryDirectory() as temp:
            pid_file = Path(temp) / "child.pid"
            process = subprocess.Popen([sys.executable, "-c", driver, str(pid_file)])
            child_pid = None
            try:
                deadline = time.monotonic() + 10
                while not pid_file.exists():
                    self.assertIsNone(process.poll(), "driver died before spawning backend")
                    self.assertLess(time.monotonic(), deadline, "driver did not spawn backend")
                    time.sleep(0.05)
                child_pid = int(pid_file.read_text())
                process.kill()
                process.wait(timeout=5)
                deadline = time.monotonic() + 5
                while True:
                    try:
                        status = Path(f"/proc/{child_pid}/stat").read_text()
                    except FileNotFoundError:
                        break
                    if status.split(") ", 1)[1][0] == "Z":
                        break
                    self.assertLess(time.monotonic(), deadline, "orphan backend still executing")
                    time.sleep(0.05)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                if child_pid and Path(f"/proc/{child_pid}/stat").exists():
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_local_backend_lifecycle_and_fixed_role_models(self):
        # Stand-in for the Grapher binary to exercise actual loopback HTTP,
        # backend process startup/cleanup, per-trial request and log artifacts.
        backend = '''#!/usr/bin/env python3
import json, os
from http.server import HTTPServer, BaseHTTPRequestHandler
class Handler(BaseHTTPRequestHandler):
 def do_POST(self):
  body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if self.path.endswith('plan_goal'):
   assert 'mode' not in body
   assert body['config']['autoApprove'] is True
   assert os.getcwd() != body['config']['repository']
   assert all(os.environ[k] == body['config']['model'] for k in ('PLANNER_MODEL','PARTITIONER_MODEL','NODE_AGENT_MODEL','MERGER_MODEL'))
   result = {'runId':'trial', 'approved':True, 'phase':'running', 'planType':'serial'}
  elif self.path.endswith('snapshot'):
   result = {'runId':'trial', 'approved':True, 'phase':'completed', 'planType':'serial', 'nodes':{'task':{'status':'done'}}}
  else: raise AssertionError(self.path)
  data = json.dumps({'result':result}).encode()
  self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
 def log_message(self, *args): pass
HTTPServer(('127.0.0.1',int(os.environ['GRAPHER_PORT'])),Handler).serve_forever()
'''
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binary = root / "backend.py"
            binary.write_text(backend)
            binary.chmod(0o755)
            (root / "instruction.txt").write_text("Actual Harbor instruction\n")
            result = subprocess.run([
                sys.executable, str(Path(__file__).with_name("run.py")),
                "--binary", str(binary), "--repository", str(root),
                "--instruction-file", str(root / "instruction.txt"),
                "--model", "openai/gpt-test", "--logs", str(root / "logs"),
                "--timeout", "10",
            ], capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((root / "logs/result.json").read_text())["phase"], "completed")
            self.assertTrue((root / "logs/backend.log").exists())


if __name__ == "__main__":
    unittest.main()
