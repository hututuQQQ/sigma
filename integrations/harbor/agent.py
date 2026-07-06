"""Harbor integration for the Sigma agent CLI."""

from __future__ import annotations

import json
import os
import pathlib
import re
import shlex
import shutil
import tempfile
import uuid
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


ENV_KEYS = [
    "DEEPSEEK_API_KEY",
    "GLM_API_KEY",
    "ZAI_API_KEY",
    "BIGMODEL_API_KEY",
    "DEEPSEEK_BASE_URL",
    "GLM_BASE_URL",
    "ZAI_BASE_URL",
]


def _default_model(provider: str) -> str:
    return "glm-5.2" if provider == "glm" else "deepseek-v4-pro"


def _return_code(result: Any) -> int:
    for attr in ("return_code", "exit_code", "returncode", "code"):
        value = getattr(result, attr, None)
        if isinstance(value, int):
            return value
    if isinstance(result, dict):
        for key in ("return_code", "exit_code", "returncode", "code"):
            value = result.get(key)
            if isinstance(value, int):
                return value
    if isinstance(result, int):
        return result
    return 0


def _output_text(result: Any) -> str:
    pieces: list[str] = []
    for attr in ("stdout", "stderr", "output", "text"):
        value = getattr(result, attr, None)
        if isinstance(value, str) and value:
            pieces.append(value)
    if isinstance(result, dict):
        for key in ("stdout", "stderr", "output", "text"):
            value = result.get(key)
            if isinstance(value, str) and value:
                pieces.append(value)
    return "\n".join(pieces)


def _json_number(data: dict[str, Any], key: str) -> int:
    value = data.get(key)
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    return 0


class AgentCliHarborAgent(BaseAgent):
    """Run Sigma's Node CLI as a Harbor external agent."""

    SUPPORTS_ATIF = False
    SUPPORTS_WINDOWS = False

    def __init__(
        self,
        logs_dir: pathlib.Path | str | None = None,
        provider: str = "deepseek",
        model: str | None = None,
        max_turns: int = 200,
        command_timeout_sec: int = 180,
        max_wall_time_sec: int = 7200,
        **kwargs: Any,
    ) -> None:
        resolved_logs_dir = pathlib.Path(logs_dir) if logs_dir is not None else pathlib.Path.cwd() / ".agent" / "harbor"
        harbor_model_name = kwargs.pop("model_name", None)
        resolved_model = model or harbor_model_name or _default_model(provider)
        super().__init__(logs_dir=resolved_logs_dir, model_name=resolved_model, **kwargs)
        self.provider = provider
        self.model = resolved_model
        self.max_turns = max_turns
        self.command_timeout_sec = command_timeout_sec
        self.max_wall_time_sec = max_wall_time_sec

    @staticmethod
    def name() -> str:
        return "sigma-agent-cli"

    def version(self) -> str | None:
        return "0.1.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        await environment.exec("mkdir -p /tmp/agent", timeout_sec=30)
        installed = await environment.exec("command -v /usr/local/bin/agent >/dev/null 2>&1", timeout_sec=30)
        if _return_code(installed) == 0:
            await self._verify_agent_ready(environment)
            return

        tarball = os.environ.get("AGENT_CLI_TARBALL")
        if tarball:
            await self._install_tarball(environment, pathlib.Path(tarball))
            await self._verify_agent_ready(environment)
            return

        cli_dir = os.environ.get("AGENT_CLI_DIR")
        if cli_dir:
            await self._install_source_dir(environment, pathlib.Path(cli_dir))
            await self._verify_agent_ready(environment)
            return

        raise RuntimeError(
            "agent CLI is not installed in the task container. Prefer setting "
            "AGENT_CLI_TARBALL to .artifacts/agent-cli-linux.tgz, or bake "
            "/usr/local/bin/agent into the Harbor task image."
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await environment.exec("mkdir -p /tmp/agent", timeout_sec=30)
        await self._upload_instruction(environment, instruction)

        command = [
            "/usr/local/bin/agent",
            "solve",
            "--workspace",
            "/app",
            "--instruction-file",
            "/tmp/agent/instruction.md",
            "--provider",
            self.provider,
            "--model",
            self.model,
            "--max-turns",
            str(self.max_turns),
            "--command-timeout-sec",
            str(self.command_timeout_sec),
            "--max-wall-time-sec",
            str(self.max_wall_time_sec),
            "--permission-mode",
            "yolo",
            "--trace-jsonl",
            "/tmp/agent/trace.jsonl",
            "--summary-json",
            "/tmp/agent/summary.json",
            "--no-stream-ui",
        ]
        env_vars = self._agent_env()
        result: Any | None = None
        error_message: str | None = None
        summary_path: pathlib.Path | None = None
        trace_path: pathlib.Path | None = None

        try:
            result = await environment.exec(
                " ".join(shlex.quote(part) for part in command),
                env=env_vars or None,
                timeout_sec=self.max_wall_time_sec + 60,
            )
        except Exception as exc:
            error_message = str(exc)
        finally:
            try:
                summary_path = await self._download_if_present(environment, "/tmp/agent/summary.json", "summary.json")
            except Exception as exc:
                error_message = error_message or f"failed to download summary.json: {exc}"
            try:
                trace_path = await self._download_if_present(environment, "/tmp/agent/trace.jsonl", "trace.jsonl")
            except Exception as exc:
                error_message = error_message or f"failed to download trace.jsonl: {exc}"

        summary = self._read_summary(summary_path)
        self._populate_context(context, result, summary, error_message)
        self._mirror_bench_artifacts(context, result, summary_path, trace_path)

    async def _install_tarball(self, environment: BaseEnvironment, tarball: pathlib.Path) -> None:
        await environment.upload_file(tarball, "/tmp/agent/agent-cli.tgz")
        await environment.exec(
            """
set -eu
rm -rf /opt/agent-cli
mkdir -p /opt/agent-cli
tar -xzf /tmp/agent/agent-cli.tgz -C /opt/agent-cli --strip-components=1
if [ -f /opt/agent-cli/bin/agent ]; then
  chmod +x /opt/agent-cli/bin/agent
  ln -sf /opt/agent-cli/bin/agent /usr/local/bin/agent
else
  npm install -g /tmp/agent/agent-cli.tgz
fi
command -v /usr/local/bin/agent >/dev/null
""".strip(),
            timeout_sec=180,
        )

    async def _install_source_dir(self, environment: BaseEnvironment, cli_dir: pathlib.Path) -> None:
        await environment.exec("rm -rf /tmp/agent/agent-cli-src", timeout_sec=30)
        await environment.upload_dir(cli_dir, "/tmp/agent/agent-cli-src")
        await environment.exec(
            "cd /tmp/agent/agent-cli-src && "
            "corepack enable && "
            "pnpm install --frozen-lockfile && "
            "pnpm build && "
            "npm link packages/agent-cli",
            timeout_sec=600,
        )

    async def _verify_agent_ready(self, environment: BaseEnvironment) -> None:
        node_check = await environment.exec("command -v node >/dev/null", timeout_sec=30)
        if _return_code(node_check) != 0:
            output = _output_text(node_check).strip()
            details = f" Output: {output}" if output else ""
            raise RuntimeError(
                "Node is required to run the current Sigma agent CLI artifact in Harbor task containers. "
                "Install Node in the task container or publish a future bundled-node artifact before running "
                f"this agent.{details}"
            )

        help_check = await environment.exec("/usr/local/bin/agent --help", timeout_sec=30)
        if _return_code(help_check) != 0:
            output = _output_text(help_check).strip()
            details = f" Output: {output}" if output else ""
            raise RuntimeError(f"agent CLI was installed, but /usr/local/bin/agent --help failed.{details}")

    async def _upload_instruction(self, environment: BaseEnvironment, instruction: str) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            instruction_path = pathlib.Path(tmp_dir) / "instruction.md"
            instruction_path.write_text(instruction, encoding="utf-8")
            await environment.upload_file(instruction_path, "/tmp/agent/instruction.md")

    def _agent_env(self) -> dict[str, str]:
        env_vars: dict[str, str] = {}
        extra_env = getattr(self, "extra_env", {})
        if isinstance(extra_env, dict):
            env_vars.update({key: str(value) for key, value in extra_env.items()})
        env_vars.update({key: os.environ[key] for key in ENV_KEYS if os.environ.get(key)})
        return env_vars

    async def _download_if_present(
        self,
        environment: BaseEnvironment,
        remote_path: str,
        filename: str,
    ) -> pathlib.Path | None:
        exists = await environment.exec(f"test -f {shlex.quote(remote_path)}", timeout_sec=30)
        if _return_code(exists) != 0:
            return None
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        target_path = self.logs_dir / filename
        await environment.download_file(remote_path, target_path)
        return target_path

    def _read_summary(self, summary_path: pathlib.Path | None) -> dict[str, Any]:
        if summary_path is None or not summary_path.is_file():
            return {}
        try:
            value = json.loads(summary_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _populate_context(
        self,
        context: AgentContext,
        result: Any | None,
        summary: dict[str, Any],
        error_message: str | None,
    ) -> None:
        exit_code = 1 if result is None and error_message else _return_code(result)
        if not error_message:
            last_error = summary.get("last_error")
            if isinstance(last_error, str) and last_error:
                error_message = last_error
        if not error_message and exit_code != 0 and result is not None:
            error_message = _output_text(result).strip() or f"agent exited with code {exit_code}"

        values = {
            "exit_code": exit_code,
            "error_message": error_message,
            "commands_executed": _json_number(summary, "commands_executed"),
            "n_input_tokens": _json_number(summary, "input_tokens"),
            "n_output_tokens": _json_number(summary, "output_tokens"),
            "n_cache_tokens": _json_number(summary, "cache_tokens"),
            "cost_usd": summary.get("cost_usd"),
        }
        for key, value in values.items():
            self._set_context_value(context, key, value)

    def _set_context_value(self, context: AgentContext, key: str, value: Any) -> None:
        try:
            setattr(context, key, value)
            return
        except Exception:
            pass

        try:
            object.__setattr__(context, key, value)
        except Exception:
            pass

        metadata = getattr(context, "metadata", None)
        if not isinstance(metadata, dict):
            metadata = {}
        metadata[key] = value
        try:
            setattr(context, "metadata", metadata)
        except Exception:
            pass

    def _mirror_bench_artifacts(
        self,
        context: AgentContext,
        result: Any | None,
        summary_path: pathlib.Path | None,
        trace_path: pathlib.Path | None,
    ) -> None:
        run_dir = os.environ.get("SIGMA_BENCH_RUN_DIR")
        if not run_dir:
            return

        task_id = self._context_task_id(context) or str(uuid.uuid4())
        safe_task_id = re.sub(r"[^A-Za-z0-9._-]+", "-", task_id).strip("-") or "task"
        task_dir = self._unique_task_dir(pathlib.Path(run_dir) / "tasks" / safe_task_id)
        task_dir.mkdir(parents=True, exist_ok=True)

        if summary_path is not None and summary_path.is_file():
            shutil.copy2(summary_path, task_dir / "summary.json")
        if trace_path is not None and trace_path.is_file():
            shutil.copy2(trace_path, task_dir / "trace.jsonl")

        output = _output_text(result).strip() if result is not None else ""
        if output:
            (task_dir / "agent.log").write_text(f"{output}\n", encoding="utf-8")

        metadata = {
            "task_id": task_id,
            "source_logs_dir": str(self.logs_dir),
            "exit_code": getattr(context, "exit_code", None),
            "error_message": getattr(context, "error_message", None),
            "commands_executed": getattr(context, "commands_executed", 0),
            "n_input_tokens": getattr(context, "n_input_tokens", 0),
            "n_output_tokens": getattr(context, "n_output_tokens", 0),
            "n_cache_tokens": getattr(context, "n_cache_tokens", 0),
            "cost_usd": getattr(context, "cost_usd", None),
        }
        (task_dir / "metadata.json").write_text(f"{json.dumps(metadata, indent=2)}\n", encoding="utf-8")

    def _context_task_id(self, context: AgentContext) -> str | None:
        for attr in ("task_id", "task_name", "benchmark_task_id", "id", "name"):
            value = getattr(context, attr, None)
            if isinstance(value, str) and value:
                return value

        metadata = getattr(context, "metadata", None)
        if isinstance(metadata, dict):
            for key in ("task_id", "task_name", "benchmark_task_id", "id", "name"):
                value = metadata.get(key)
                if isinstance(value, str) and value:
                    return value

        return None

    def _unique_task_dir(self, base_dir: pathlib.Path) -> pathlib.Path:
        if not base_dir.exists() or not any(base_dir.iterdir()):
            return base_dir

        for index in range(2, 1000):
            candidate = pathlib.Path(f"{base_dir}-{index}")
            if not candidate.exists() or not any(candidate.iterdir()):
                return candidate

        return pathlib.Path(f"{base_dir}-{uuid.uuid4()}")
