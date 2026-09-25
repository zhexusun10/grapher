"""Harbor import-path agent: benchmark.harbor_agent:GrapherAgent.

The Harbor installation is separate from this repository. See README.md.
"""

import json
import shlex
from pathlib import Path
from typing import Literal

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext, ModelUsage
from pydantic import Field

from benchmark.run import harbor_usage


class GrapherOptions(InstalledAgentOptions):
    version: None = Field(default=None, description="Derived from Grapher's build identity")
    grapher_root: str = Field(default="/installed-agent/grapher", description="Prepared Grapher checkout in the task environment")
    thinking: Literal["off", "minimal", "low", "medium", "high", "xhigh"] = "medium"
    max_parallel: int = Field(default=4, ge=1, le=8)
    timeout_sec: int = Field(default=3600, ge=1, description="End-to-end Grapher trial timeout in seconds")


class GrapherAgent(BaseInstalledAgent):
    """Use Grapher's Partitioner/Planner/runtime, not Harbor's Pi agent."""

    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)
    options_model = GrapherOptions
    options: GrapherOptions

    def __init__(self, *args, version: str | None = None, **kwargs):
        if version is not None:
            raise ValueError("Grapher version comes from the verified binary, not --ak version")
        super().__init__(*args, version=None, **kwargs)

    @staticmethod
    def name() -> str:
        return "grapher"

    def get_version_command(self) -> str | None:
        binary = f"{self.options.grapher_root}/backend/target/release/grapher"
        return f"{shlex.quote(binary)} --build-identity"

    async def install(self, environment: BaseEnvironment) -> None:
        root = self.options.grapher_root
        if not root.startswith("/"):
            raise ValueError("grapher_root must be an absolute path in the task environment")
        qroot = shlex.quote(root)
        binary = shlex.quote(f"{root}/backend/target/release/grapher")
        checks = [
            f"test -x {binary}",
            f"test -f {qroot}/pi/node_modules/tsx/dist/cli.mjs",
            f"test -f {qroot}/engine/entrypoint.mjs",
            f"test ! -e {qroot}/.env && test ! -e {qroot}/backend/.env",
            "command -v python3 && command -v git && command -v node",
            ("if [ \"$(uname -s)\" = Linux ]; then "
             "test -x /usr/bin/bwrap && /usr/bin/bwrap --die-with-parent "
             "--unshare-user --unshare-pid --cap-drop ALL "
             "--bind / / --dev-bind /dev /dev --proc /proc "
             "-- /bin/sh -c ': <>/dev/null'; fi"),
            f"node {qroot}/scripts/pi-baseline.mjs verify",
            f'test -z "$(git -C {qroot} status --porcelain --untracked-files=normal)"',
            f'test "$({binary} --build-identity)" = "$(git -C {qroot} rev-parse HEAD)"',
        ]
        # Never build a global/unpinned Pi or accept a dirty/stale backend.
        await self.exec_as_agent(environment, command=" && ".join(checks))
        await environment.upload_file(Path(__file__).with_name("run.py"),
                                      "/installed-agent/grapher-harbor-run.py")

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Pass --model provider/model; Grapher requires a fixed model")
        workdir = (await self.exec_as_agent(environment, command="pwd -P")).stdout
        repository = (workdir or "").strip()
        if not repository.startswith("/"):
            raise RuntimeError("The Harbor task must have an absolute working directory")
        await self._upload_config_text(
            environment, content=instruction, remote_path="/installed-agent/grapher-instruction.txt",
            filename="instruction.txt",
        )
        root = self.options.grapher_root
        parts = [
            "python3", "/installed-agent/grapher-harbor-run.py",
            "--binary", f"{root}/backend/target/release/grapher",
            "--repository", repository,
            "--instruction-file", "/installed-agent/grapher-instruction.txt",
            "--model", self.model_name,
            "--thinking", self.options.thinking,
            "--max-parallel", str(self.options.max_parallel),
            "--timeout", str(self.options.timeout_sec),
            "--logs", str(self.environment_logs_dir),
        ]
        # Harbor passes --agent-env into exec; model_connection also forwards
        # provider credentials without putting them on the command line.
        await self.exec_as_agent(
            environment, command=" ".join(map(shlex.quote, parts)),
            env=self.model_connection.env,
            timeout_sec=self.options.timeout_sec + 60,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        try:
            result = json.loads((self.logs_dir / "result.json").read_text(encoding="utf-8"))
            usage = harbor_usage(result)
            if usage is None:
                return
            context.n_input_tokens = usage["input"]
            context.n_cache_tokens = usage["cache"]
            context.n_output_tokens = usage["output"]
            context.model_usage = {self.model_name: ModelUsage(
                n_input_tokens=usage["input"], n_cache_tokens=usage["cache"],
                n_output_tokens=usage["output"],
            )}
            context.metadata = {**(context.metadata or {}),
                                "grapher_run_id": result.get("runId"), "route": result.get("route")}
        except (OSError, ValueError, TypeError, KeyError) as exc:
            self.logger.debug("Cannot read Grapher usage from Harbor logs: %s", exc)
