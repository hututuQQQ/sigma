"""Harbor integration for the agent-cli MVP.

This file is intentionally defensive because Harbor and Terminal-Bench wrappers
have changed names across releases. The custom agent expects an `agent` binary
at /usr/local/bin/agent inside the task container, or a Harbor environment that
can upload a local AGENT_CLI_DIR/AGENT_CLI_TARBALL during setup().
"""

from __future__ import annotations

import base64
import json
import os
import pathlib
import shlex
from typing import Any, Dict, Optional

try:  # Preferred shape.
    from harbor import AgentContext, BaseAgent, BaseEnvironment  # type: ignore
except Exception:  # pragma: no cover - depends on Harbor installation.
    try:
        from harbor.agents import AgentContext, BaseAgent, BaseEnvironment  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise ImportError(
            "Harbor is not installed or its BaseAgent/BaseEnvironment imports changed. "
            "Install Harbor, then adjust integrations/harbor/agent.py imports for your version."
        ) from exc


ENV_KEYS = [
    "DEEPSEEK_API_KEY",
    "GLM_API_KEY",
    "ZAI_API_KEY",
    "BIGMODEL_API_KEY",
    "DEEPSEEK_BASE_URL",
    "GLM_BASE_URL",
    "ZAI_BASE_URL",
]


def _call_first(obj: Any, names: list[str], *args: Any, **kwargs: Any) -> Any:
    for name in names:
        method = getattr(obj, name, None)
        if callable(method):
            return method(*args, **kwargs)
    raise AttributeError(f"{type(obj).__name__} does not expose any of: {', '.join(names)}")


def _command_output(result: Any) -> str:
    if isinstance(result, str):
        return result
    for attr in ("stdout", "output", "text"):
        value = getattr(result, attr, None)
        if isinstance(value, str):
            return value
    if isinstance(result, dict):
        for key in ("stdout", "output", "text"):
            value = result.get(key)
            if isinstance(value, str):
                return value
    return ""


def _exit_code(result: Any) -> int:
    if isinstance(result, int):
        return result
    for attr in ("exit_code", "returncode", "code"):
        value = getattr(result, attr, None)
        if isinstance(value, int):
            return value
    if isinstance(result, dict):
        for key in ("exit_code", "returncode", "code"):
            value = result.get(key)
            if isinstance(value, int):
                return value
    return 0


class AgentCliHarborAgent(BaseAgent):  # type: ignore[misc]
    """Run the Node agent CLI as a Harbor custom agent."""

    def __init__(
        self,
        provider: str = "deepseek",
        model: Optional[str] = None,
        max_turns: int = 40,
        command_timeout_sec: int = 120,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.provider = provider
        self.model = model or ("glm-5.2" if provider == "glm" else "deepseek-v4-pro")
        self.max_turns = max_turns
        self.command_timeout_sec = command_timeout_sec

    def setup(self, env: BaseEnvironment) -> None:  # type: ignore[override]
        self._run(env, "mkdir -p /tmp/agent")
        if _exit_code(self._run(env, "command -v /usr/local/bin/agent >/dev/null 2>&1")) == 0:
            return

        tarball = os.environ.get("AGENT_CLI_TARBALL")
        cli_dir = os.environ.get("AGENT_CLI_DIR")
        if tarball:
            self._upload(env, tarball, "/tmp/agent/agent-cli.tgz")
            self._run(env, "npm install -g /tmp/agent/agent-cli.tgz")
            return

        if cli_dir:
            self._upload(env, cli_dir, "/tmp/agent/agent-cli-src")
            self._run(
                env,
                "cd /tmp/agent/agent-cli-src && corepack enable && pnpm install && pnpm build && npm link packages/agent-cli",
            )
            return

        raise RuntimeError(
            "agent CLI is not installed in the task container. Build it first, then either install "
            "/usr/local/bin/agent in your Harbor image or set AGENT_CLI_DIR/AGENT_CLI_TARBALL for setup()."
        )

    def run(self, env: BaseEnvironment, instruction: str, context: AgentContext) -> AgentContext:  # type: ignore[override]
        self._run(env, "mkdir -p /tmp/agent")
        encoded_instruction = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        self._run(
            env,
            f"python3 - <<'PY'\n"
            f"import base64, pathlib\n"
            f"pathlib.Path('/tmp/agent/instruction.md').write_bytes(base64.b64decode('{encoded_instruction}'))\n"
            f"PY",
        )

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
            "--permission-mode",
            "yolo",
            "--trace-jsonl",
            "/tmp/agent/trace.jsonl",
            "--summary-json",
            "/tmp/agent/summary.json",
            "--no-stream-ui",
        ]
        env_vars = {key: os.environ[key] for key in ENV_KEYS if os.environ.get(key)}
        result = self._run(env, " ".join(shlex.quote(part) for part in command), env_vars=env_vars)

        summary = self._read_json_if_exists(env, "/tmp/agent/summary.json")
        logs_dir = getattr(context, "logs_dir", None) or getattr(context, "log_dir", None)
        if logs_dir:
            pathlib.Path(logs_dir).mkdir(parents=True, exist_ok=True)
            self._download_if_exists(env, "/tmp/agent/trace.jsonl", pathlib.Path(logs_dir) / "trace.jsonl")
            self._download_if_exists(env, "/tmp/agent/summary.json", pathlib.Path(logs_dir) / "summary.json")

        self._fill_context(context, result, summary)
        return context

    def _run(self, env: BaseEnvironment, command: str, env_vars: Optional[Dict[str, str]] = None) -> Any:
        try:
            result = _call_first(env, ["run", "exec", "execute", "run_command"], command, env=env_vars)
        except TypeError:
            result = _call_first(env, ["run", "exec", "execute", "run_command"], command)
        if not hasattr(result, "exit_code"):
            try:
                setattr(result, "exit_code", _exit_code(result))
            except Exception:
                pass
        return result

    def _upload(self, env: BaseEnvironment, local_path: str, remote_path: str) -> None:
        _call_first(env, ["upload", "copy_to", "put"], local_path, remote_path)

    def _download_if_exists(self, env: BaseEnvironment, remote_path: str, local_path: pathlib.Path) -> None:
        check = self._run(env, f"test -f {shlex.quote(remote_path)}")
        if _exit_code(check) != 0:
            return
        _call_first(env, ["download", "copy_from", "get"], remote_path, str(local_path))

    def _read_json_if_exists(self, env: BaseEnvironment, remote_path: str) -> Dict[str, Any]:
        result = self._run(
            env,
            f"test -f {shlex.quote(remote_path)} && cat {shlex.quote(remote_path)} || true",
        )
        output = _command_output(result).strip()
        if not output:
            return {}
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            return {}

    def _fill_context(self, context: AgentContext, result: Any, summary: Dict[str, Any]) -> None:
        mapping = {
            "exit_code": _exit_code(result),
            "error_message": summary.get("last_error"),
            "commands_executed": summary.get("commands_executed"),
            "n_input_tokens": summary.get("input_tokens"),
            "n_output_tokens": summary.get("output_tokens"),
            "n_cache_tokens": summary.get("cache_tokens"),
            "cost_usd": summary.get("cost_usd"),
        }
        for key, value in mapping.items():
            if value is not None:
                try:
                    setattr(context, key, value)
                except Exception:
                    pass
