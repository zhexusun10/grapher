"""Harbor 0.23 import-path contract. Run with Harbor installed in Python 3.12."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock

try:
    import harbor  # noqa: F401
except ModuleNotFoundError as exc:
    if exc.name != "harbor":
        raise
    AgentContext = None
    GrapherAgent = None
else:
    from harbor.models.agent.context import AgentContext
    from benchmark.harbor_agent import GrapherAgent


@unittest.skipUnless(GrapherAgent is not None, "Harbor Python 3.12 is not installed")
class HarborAgentTests(unittest.TestCase):
    def test_options_and_version_cannot_mislabel_binary(self):
        GrapherAgent.preflight({"timeout_sec": 120, "max_parallel": 2})
        with self.assertRaises(ValueError):
            GrapherAgent.preflight({"max_parallel": 9})
        with self.assertRaises(ValueError):
            GrapherAgent.preflight({"version": "fake-version"})
        with tempfile.TemporaryDirectory() as directory:
            agent = GrapherAgent(logs_dir=Path(directory), model_name="openai/fixed-model")
            self.assertEqual(agent.name(), "grapher")
            self.assertIn("--build-identity", agent.get_version_command())
            with self.assertRaises(ValueError):
                GrapherAgent(logs_dir=Path(directory), model_name="openai/fixed-model", version="fake")

    def test_run_uses_harbor_workdir_credentials_prompt_file_and_fixed_model(self):
        class Environment:
            default_user = None

            def __init__(self):
                self.uploads = []

            async def upload_file(self, source, target):
                self.uploads.append((target, Path(source).read_text()))

        with tempfile.TemporaryDirectory() as directory:
            agent = GrapherAgent(logs_dir=Path(directory), model_name="openai/fixed-model",
                                 extra_env={"OPENAI_API_KEY": "not-a-real-key"})
            agent.exec_as_agent = AsyncMock(return_value=SimpleNamespace(stdout="/task/project\n"))
            env = Environment()
            asyncio.run(agent.install(env))
            self.assertIn("grapher-harbor-run.py", env.uploads[0][0])
            preflight = agent.exec_as_agent.await_args.kwargs["command"]
            self.assertIn("--build-identity", preflight)
            self.assertIn("--unshare-user", preflight)
            self.assertIn("--dev-bind /dev /dev", preflight)
            self.assertIn("<>/dev/null", preflight)
            self.assertIn("pi-baseline.mjs verify", preflight)
            agent.exec_as_agent.reset_mock()
            asyncio.run(agent.run("Original Harbor instruction", env, AgentContext()))
            self.assertIn(("/installed-agent/grapher-instruction.txt", "Original Harbor instruction"), env.uploads)
            command = agent.exec_as_agent.await_args.kwargs["command"]
            self.assertIn("--repository /task/project", command)
            self.assertIn("--model openai/fixed-model", command)
            self.assertNotIn("Original Harbor instruction", command)
            self.assertEqual(agent.exec_as_agent.await_args.kwargs["timeout_sec"], 3660)
            self.assertNotIn("not-a-real-key", command)
            self.assertEqual(agent.exec_as_agent.await_args.kwargs["env"]["OPENAI_API_KEY"],
                             "not-a-real-key")

    def test_metrics_are_loaded_after_harbor_sync(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = GrapherAgent(logs_dir=Path(directory), model_name="openai/fixed-model")
            (Path(directory) / "result.json").write_text(json.dumps({
                "runId": "run-1", "route": "graph",
                "runMetrics": {"totalUsage": {"input": 2, "cacheRead": 7, "cacheWrite": 1, "output": 3}},
            }))
            context = AgentContext()
            agent.populate_context_post_run(context)
            self.assertEqual((context.n_input_tokens, context.n_cache_tokens, context.n_output_tokens), (10, 7, 3))
            self.assertEqual(context.metadata["route"], "graph")
            self.assertEqual(context.model_usage["openai/fixed-model"].n_input_tokens, 10)


if __name__ == "__main__":
    unittest.main()
