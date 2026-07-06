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


def _stdout_text(result: Any) -> str:
    value = getattr(result, "stdout", None)
    if isinstance(value, str):
        return value
    if isinstance(result, dict):
        value = result.get("stdout")
        if isinstance(value, str):
            return value
    return ""


def _stderr_text(result: Any) -> str:
    value = getattr(result, "stderr", None)
    if isinstance(value, str):
        return value
    if isinstance(result, dict):
        value = result.get("stderr")
        if isinstance(value, str):
            return value
    return ""


def _json_number(data: dict[str, Any], key: str) -> int:
    value = data.get(key)
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def _as_int(value: Any, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return fallback
    return fallback


def _normalize_globs(value: str | list[str] | tuple[str, ...] | None) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, (list, tuple)):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def _as_bool(value: Any, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
    return fallback


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
        pre_verifier_cleanup_globs: str | list[str] | None = None,
        precheck_command: str | None = None,
        precheck_timeout_sec: int | None = None,
        precheck_retry_limit: int = 0,
        harbor_agent_timeout_sec: int | None = None,
        agent_timeout_grace_sec: int = 120,
        retry_min_budget_sec: int | None = None,
        max_message_history_chars: int | None = 250000,
        message_history_retain: int = 24,
        compaction_summary_chars: int = 30000,
        generic_validation_enabled: bool | str = False,
        validation_timeout_sec: int | None = None,
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
        self.cleanup_globs = _normalize_globs(pre_verifier_cleanup_globs)
        self.precheck_command = precheck_command.strip() if isinstance(precheck_command, str) and precheck_command.strip() else None
        self.precheck_timeout_sec = max(1, _as_int(precheck_timeout_sec, command_timeout_sec))
        self.precheck_retry_limit = max(0, _as_int(precheck_retry_limit, 0))
        harbor_timeout = _as_int(harbor_agent_timeout_sec, 0)
        self.harbor_agent_timeout_sec = harbor_timeout if harbor_timeout > 0 else None
        self.agent_timeout_grace_sec = max(0, _as_int(agent_timeout_grace_sec, 120))
        retry_min_budget = _as_int(retry_min_budget_sec, 0)
        self.retry_min_budget_sec = retry_min_budget if retry_min_budget > 0 else None
        self.max_message_history_chars = (
            None if max_message_history_chars is None else max(0, _as_int(max_message_history_chars, 0))
        )
        self.message_history_retain = max(0, _as_int(message_history_retain, 24))
        self.compaction_summary_chars = max(1, _as_int(compaction_summary_chars, 30000))
        self.generic_validation_enabled = _as_bool(generic_validation_enabled, False)
        self.validation_timeout_sec = max(1, _as_int(validation_timeout_sec, self.precheck_timeout_sec))

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
            "AGENT_CLI_TARBALL to .artifacts/agent-cli-linux-x64.tgz, or bake "
            "/usr/local/bin/agent into the Harbor task image."
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await environment.exec("mkdir -p /tmp/agent", timeout_sec=30)
        env_vars = self._agent_env()
        result: Any | None = None
        error_message: str | None = None
        summary_path: pathlib.Path | None = None
        trace_path: pathlib.Path | None = None

        try:
            await self._upload_instruction(environment, instruction)
            result = await self._run_agent_once(environment, env_vars)
            if _return_code(result) != 0:
                error_message = _output_text(result).strip() or f"agent exited with code {_return_code(result)}"
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
            try:
                await self._download_attempt_artifacts(environment)
            except Exception:
                pass

        summary = self._read_summary(summary_path)
        self._populate_context(context, result, summary, error_message)
        self._mirror_bench_artifacts(context, result, summary_path, trace_path, summary)

    def _agent_command(self) -> list[str]:
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
            "--attempts-dir",
            "/tmp/agent/attempts",
            "--validation-mode",
            "auto" if self.generic_validation_enabled else "off",
            "--validation-retry-limit",
            str(self.precheck_retry_limit),
            "--validation-timeout-sec",
            str(self.validation_timeout_sec),
            "--no-stream-ui",
        ]
        if self.precheck_command:
            command.extend(
                [
                    "--precheck-command",
                    self.precheck_command,
                    "--precheck-timeout-sec",
                    str(self.precheck_timeout_sec),
                ]
            )
        if self.cleanup_globs:
            command.extend(["--pre-verifier-cleanup-globs", ",".join(self.cleanup_globs)])
        if self.harbor_agent_timeout_sec is not None:
            command.extend(["--harness-timeout-sec", str(self.harbor_agent_timeout_sec)])
        if self.retry_min_budget_sec is not None:
            command.extend(["--retry-min-budget-sec", str(self.retry_min_budget_sec)])
        if self.max_message_history_chars and self.max_message_history_chars > 0:
            command.extend(
                [
                    "--max-message-history-chars",
                    str(self.max_message_history_chars),
                    "--message-history-retain",
                    str(self.message_history_retain),
                    "--compaction-summary-chars",
                    str(self.compaction_summary_chars),
                ]
            )
        return command

    async def _run_agent_once(self, environment: BaseEnvironment, env_vars: dict[str, str]) -> Any:
        command = self._agent_command()
        base_timeout = self.harbor_agent_timeout_sec or self.max_wall_time_sec
        return await environment.exec(
            " ".join(shlex.quote(part) for part in command),
            env=env_vars or None,
            timeout_sec=base_timeout + self.agent_timeout_grace_sec,
        )

    async def _install_tarball(self, environment: BaseEnvironment, tarball: pathlib.Path) -> None:
        await environment.upload_file(tarball, "/tmp/agent/agent-cli.tgz")
        await environment.exec(
            """
set -eu
rm -rf /opt/agent-cli
mkdir -p /opt/agent-cli
mkdir -p /usr/local/bin
tar -xzf /tmp/agent/agent-cli.tgz -C /opt/agent-cli --strip-components=1
test -f /opt/agent-cli/bin/agent
chmod +x /opt/agent-cli/bin/agent
if [ -f /opt/agent-cli/bin/node ]; then
  chmod +x /opt/agent-cli/bin/node
fi
ln -sf /opt/agent-cli/bin/agent /usr/local/bin/agent
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
        help_check = await environment.exec("/usr/local/bin/agent --help", timeout_sec=30)
        if _return_code(help_check) != 0:
            stdout = _stdout_text(help_check).strip()
            stderr = _stderr_text(help_check).strip()
            raise RuntimeError(
                "agent CLI was installed, but /usr/local/bin/agent --help failed."
                f"\nstdout:\n{stdout or '<empty>'}"
                f"\nstderr:\n{stderr or '<empty>'}"
            )

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

    async def _download_attempt_artifacts(self, environment: BaseEnvironment) -> None:
        exists = await environment.exec("test -d /tmp/agent/attempts", timeout_sec=30)
        if _return_code(exists) != 0:
            return
        listing = await environment.exec("find /tmp/agent/attempts -type f 2>/dev/null", timeout_sec=30)
        if _return_code(listing) != 0:
            return
        for raw_path in _stdout_text(listing).splitlines():
            remote_path = raw_path.strip()
            if not remote_path.startswith("/tmp/agent/attempts/"):
                continue
            relative = pathlib.PurePosixPath(remote_path.removeprefix("/tmp/agent/"))
            target_path = self.logs_dir / pathlib.Path(*relative.parts)
            target_path.parent.mkdir(parents=True, exist_ok=True)
            await environment.download_file(remote_path, target_path)

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
        summary: dict[str, Any],
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

        attempts_dir = self.logs_dir / "attempts"
        if attempts_dir.is_dir():
            shutil.copytree(attempts_dir, task_dir / "attempts", dirs_exist_ok=True)

        output = _output_text(result).strip() if result is not None else ""
        if output:
            (task_dir / "agent.log").write_text(f"{output}\n", encoding="utf-8")

        harness = summary.get("harness") if isinstance(summary.get("harness"), dict) else {}
        validation_results = harness.get("validation_results") if isinstance(harness, dict) else []
        precheck_results = harness.get("precheck_results") if isinstance(harness, dict) else []
        retry_decisions = harness.get("retry_decisions") if isinstance(harness, dict) else []
        cleanup = harness.get("pre_verifier_cleanup") if isinstance(harness, dict) else None

        metadata = {
            "task_id": task_id,
            "source_logs_dir": str(self.logs_dir),
            "agent_setup_ok": True,
            "exit_code": getattr(context, "exit_code", None),
            "error_message": getattr(context, "error_message", None),
            "commands_executed": getattr(context, "commands_executed", 0),
            "n_input_tokens": getattr(context, "n_input_tokens", 0),
            "n_output_tokens": getattr(context, "n_output_tokens", 0),
            "n_cache_tokens": getattr(context, "n_cache_tokens", 0),
            "cost_usd": getattr(context, "cost_usd", None),
            "precheck_results": precheck_results if isinstance(precheck_results, list) else [],
            "validation_results": validation_results if isinstance(validation_results, list) else [],
            "generic_validation_enabled": self.generic_validation_enabled,
            "validation_timeout_sec": self.validation_timeout_sec,
            "precheck_timeout_sec": self.precheck_timeout_sec,
            "retry_decisions": retry_decisions if isinstance(retry_decisions, list) else [],
            "changed_app_files": self._changed_files_from_harness(summary),
            "workspace_snapshots": [],
            "pre_verifier_cleanup": cleanup,
            "failure_signals": self._failure_signals_for_metadata(result, summary),
        }
        (task_dir / "metadata.json").write_text(f"{json.dumps(metadata, indent=2)}\n", encoding="utf-8")

    def _changed_files_from_harness(self, summary: dict[str, Any]) -> list[str]:
        harness = summary.get("harness")
        if not isinstance(harness, dict):
            return []
        files: set[str] = set()
        for key in ("validation_results", "precheck_results"):
            value = harness.get(key)
            if not isinstance(value, list):
                continue
            for item in value:
                if not isinstance(item, dict):
                    continue
                related = item.get("related_files")
                if isinstance(related, list):
                    files.update(str(path) for path in related if isinstance(path, str))
        return sorted(files)

    def _failure_signals_for_metadata(self, result: Any | None, summary: dict[str, Any]) -> list[str]:
        signals: list[str] = []

        def add(signal: str) -> None:
            if signal not in signals:
                signals.append(signal)

        add("agent_setup_ok")
        harness = summary.get("harness") if isinstance(summary.get("harness"), dict) else {}

        for key in ("validation_results", "precheck_results"):
            items = harness.get(key) if isinstance(harness, dict) else []
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict) or _as_int(item.get("exit_code"), 0) == 0:
                    continue
                add("validation_failed" if item.get("kind") == "validation" else "precheck_failed")
                text = json.dumps(item, ensure_ascii=False).lower()
                if "/tmp/frame.bmp" in text:
                    add("missing_artifact:/tmp/frame.bmp")

        decisions = harness.get("retry_decisions") if isinstance(harness, dict) else []
        if isinstance(decisions, list):
            for decision in decisions:
                if not isinstance(decision, dict):
                    continue
                if decision.get("action") == "skipped":
                    add("retry_cut_short_by_budget")
                if decision.get("action") == "started" and "validation" in str(decision.get("trigger") or ""):
                    add("validation_retry_used")

        cleanup = harness.get("pre_verifier_cleanup") if isinstance(harness, dict) else None
        if isinstance(cleanup, dict) and cleanup.get("warning"):
            add("pre_verifier_cleanup_warning")

        result_text = _output_text(result) if result is not None else ""
        if re.search(r"finish[_ ]?reason\"?\s*[:=]\s*\"?max_wall_time", result_text, flags=re.IGNORECASE) or re.search(
            r"agent execution timed out|timed out after|max wall time",
            result_text,
            flags=re.IGNORECASE,
        ):
            add("max_wall_time")

        return signals

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
