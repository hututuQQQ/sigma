"""Harbor integration for the Sigma agent CLI."""

from __future__ import annotations

import json
import os
import pathlib
import re
import shlex
import shutil
import tempfile
import time
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


def _truncate_text(text: str, limit: int = 4000) -> str:
    if len(text) <= limit:
        return text
    half = max(1, (limit - 20) // 2)
    return f"{text[:half]}\n...[truncated]...\n{text[-half:]}"


def _tail_text(text: str, limit: int = 4000) -> str:
    if len(text) <= limit:
        return text
    return text[-limit:]


def _normalize_globs(value: str | list[str] | tuple[str, ...] | None) -> tuple[bool, list[str]]:
    if value is None:
        return False, []
    if isinstance(value, str):
        return True, [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, (list, tuple)):
        return True, [str(item).strip() for item in value if str(item).strip()]
    return True, []


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
        self.cleanup_globs_explicit, self.cleanup_globs = _normalize_globs(pre_verifier_cleanup_globs)
        self.precheck_command = precheck_command.strip() if isinstance(precheck_command, str) else None
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
        self._last_cleanup_result: dict[str, Any] | None = None
        self._last_precheck_results: list[dict[str, Any]] = []
        self._last_snapshot_results: list[dict[str, Any]] = []
        self._retry_decisions: list[dict[str, Any]] = []
        self._snapshot_extra_paths: set[str] = set()
        self._last_changed_app_files: list[str] = []

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
        self._last_cleanup_result = None
        self._last_precheck_results = []
        self._last_snapshot_results = []
        self._retry_decisions = []
        self._snapshot_extra_paths = set()
        self._last_changed_app_files = []
        run_started_at = time.monotonic()

        try:
            active_instruction = instruction
            retry_count = 0
            while True:
                app_manifest_before: dict[str, dict[str, str]] = {}
                app_manifest_error_before: str | None = None
                if self.generic_validation_enabled:
                    try:
                        app_manifest_before = await self._list_app_manifest(environment)
                    except Exception as exc:
                        app_manifest_error_before = str(exc)
                await self._upload_instruction(environment, active_instruction)
                result = await self._run_agent_once(environment, env_vars)

                if _return_code(result) != 0:
                    break

                agent_summary = await self._read_remote_json_if_present(environment, "/tmp/agent/summary.json")
                trace_tail = await self._read_remote_file_tail(environment, "/tmp/agent/trace.jsonl", max_bytes=16000)
                checks = await self._run_post_agent_checks(
                    environment,
                    env_vars,
                    attempt=retry_count + 1,
                    app_manifest_before=app_manifest_before,
                    app_manifest_error_before=app_manifest_error_before,
                    agent_summary=agent_summary,
                    trace_tail=trace_tail,
                )
                failed_checks = [check for check in checks if _as_int(check.get("exit_code"), 0) != 0]
                if not failed_checks:
                    break

                failure_number = len([check for check in self._last_precheck_results if _as_int(check.get("exit_code"), 0) != 0])
                self._last_snapshot_results.append(
                    await self._download_workspace_snapshot(
                        environment,
                        reason=f"harness-validation-failed-{failure_number}",
                    )
                )

                if retry_count >= self.precheck_retry_limit:
                    error_message = str(failed_checks[-1].get("message") or "harness validation failed")
                    break

                retry_decision = self._retry_budget_decision(
                    retry_number=retry_count + 1,
                    run_started_at=run_started_at,
                    result=result,
                    agent_summary=agent_summary,
                    trace_tail=trace_tail,
                )
                retry_decision["trigger"] = self._retry_trigger(failed_checks)
                self._retry_decisions.append(retry_decision)
                if retry_decision["action"] == "skipped":
                    failed_checks[-1]["retry_decision"] = retry_decision
                    error_message = (
                        f"{failed_checks[-1].get('message')}; retry skipped because Harbor budget remaining "
                        f"({retry_decision.get('remaining_harbor_budget_sec')}s) is below "
                        f"{retry_decision.get('minimum_retry_budget_sec')}s"
                    )
                    break

                retry_count += 1
                active_instruction = self._instruction_with_precheck_feedback(instruction, self._last_precheck_results)
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
                self._last_snapshot_results.append(
                    await self._download_workspace_snapshot(environment, reason="final")
                )
            except Exception as exc:
                self._last_snapshot_results.append(
                    {
                        "reason": "final",
                        "success": False,
                        "patterns": self._snapshot_patterns(),
                        "files": [],
                        "warning": str(exc),
                    }
                )
            try:
                self._last_cleanup_result = await self._cleanup_before_verifier(environment, context)
            except Exception as exc:
                self._last_cleanup_result = {
                    "patterns": self._cleanup_globs_for_context(context),
                    "exit_code": 1,
                    "warning": str(exc),
                }

        summary = self._read_summary(summary_path)
        self._populate_context(context, result, summary, error_message)
        self._mirror_bench_artifacts(context, result, summary_path, trace_path)

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
            "--no-stream-ui",
        ]
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
        return await environment.exec(
            " ".join(shlex.quote(part) for part in command),
            env=env_vars or None,
            timeout_sec=self.max_wall_time_sec + 60,
        )

    async def _run_post_agent_checks(
        self,
        environment: BaseEnvironment,
        env_vars: dict[str, str],
        attempt: int,
        app_manifest_before: dict[str, dict[str, str]],
        app_manifest_error_before: str | None,
        agent_summary: dict[str, Any],
        trace_tail: str,
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        summary_feedback = self._summary_feedback(agent_summary)
        trace_feedback = self._trace_tail_key_info(trace_tail)

        if self.generic_validation_enabled:
            changed_files: list[str] = []
            manifest_error = app_manifest_error_before
            if manifest_error is None:
                try:
                    app_manifest_after = await self._list_app_manifest(environment)
                    changed_files = self._changed_app_files(app_manifest_before, app_manifest_after)
                    self._last_changed_app_files = changed_files
                    self._snapshot_extra_paths.update(changed_files)
                except Exception as exc:
                    manifest_error = str(exc)

            if manifest_error:
                results.append(
                    {
                        "kind": "validation",
                        "source": "manifest",
                        "command": "list /app manifest",
                        "attempt": attempt,
                        "exit_code": 1,
                        "output": "",
                        "stdout_tail": "",
                        "stderr_tail": manifest_error,
                        "related_files": [],
                        "timeout_sec": self.validation_timeout_sec,
                        "message": f"harness validation manifest collection failed: {manifest_error}",
                    }
                )
            else:
                for index, spec in enumerate(
                    self._validation_command_specs(agent_summary, changed_files),
                    start=1,
                ):
                    results.append(
                        await self._run_validation_command(
                            environment,
                            env_vars,
                            attempt=attempt,
                            index=index,
                            spec=spec,
                        )
                    )

        if self.precheck_command:
            results.append(await self._run_precheck(environment, env_vars))

        for result in results:
            result["agent_summary"] = summary_feedback
            result["trace_tail"] = trace_feedback
            self._last_precheck_results.append(result)
        return results

    async def _list_app_manifest(self, environment: BaseEnvironment) -> dict[str, dict[str, str]]:
        script = r"""
if [ -d /app ]; then
  find /app \( -path '/app/.git' -o -path '/app/.git/*' -o -path '/app/node_modules' -o -path '/app/node_modules/*' \) -prune -o -type f -print 2>/dev/null |
  while IFS= read -r path; do
    size=$(wc -c < "$path" 2>/dev/null || echo "")
    mtime=$(stat -c %Y "$path" 2>/dev/null || stat -f %m "$path" 2>/dev/null || echo "")
    printf '%s\t%s\t%s\n' "$path" "$size" "$mtime"
  done
fi
""".strip()
        result = await environment.exec(script, timeout_sec=30)
        if _return_code(result) != 0:
            raise RuntimeError(_output_text(result).strip() or "/app manifest command failed")

        manifest: dict[str, dict[str, str]] = {}
        for raw_line in _stdout_text(result).splitlines():
            parts = raw_line.rstrip("\n").split("\t", 2)
            if len(parts) != 3:
                continue
            path, size, mtime = parts
            if path.startswith("/app/"):
                manifest[path] = {"size": size, "mtime": mtime}
        return manifest

    def _changed_app_files(
        self,
        before: dict[str, dict[str, str]],
        after: dict[str, dict[str, str]],
    ) -> list[str]:
        changed: list[str] = []
        for path, metadata in after.items():
            if before.get(path) != metadata:
                changed.append(path)
        return sorted(changed)

    def _validation_command_specs(
        self,
        agent_summary: dict[str, Any],
        changed_files: list[str],
    ) -> list[dict[str, Any]]:
        specs: list[dict[str, Any]] = []
        seen: set[str] = set()

        def add(command: str, source: str, related_files: list[str] | None = None) -> None:
            command_text = command.strip()
            if not command_text or command_text in seen:
                return
            seen.add(command_text)
            specs.append(
                {
                    "command": command_text,
                    "source": source,
                    "related_files": sorted(set(related_files or [])),
                }
            )

        for item in self._summary_validation_commands(agent_summary):
            add(
                str(item.get("command") or ""),
                "summary",
                [path for path in item.get("related_files", []) if isinstance(path, str)],
            )

        for path in changed_files:
            suffix = pathlib.PurePosixPath(path).suffix.lower()
            quoted = shlex.quote(path)
            if suffix == ".py":
                add(f"python -m py_compile {quoted}", "generic", [path])
            elif suffix == ".sh":
                add(f"bash -n {quoted}", "generic", [path])
            elif suffix == ".js":
                add(f"{self._node_command_prefix()} --check {quoted}", "generic", [path])

            script_command = self._generic_script_run_command(path)
            if script_command:
                add(script_command, "generic-script", [path])

        return specs

    def _summary_validation_commands(self, agent_summary: dict[str, Any]) -> list[dict[str, Any]]:
        candidates: list[Any] = [
            agent_summary.get("validation_commands"),
            agent_summary.get("validationCommands"),
        ]
        harness = agent_summary.get("harness")
        if isinstance(harness, dict):
            candidates.extend([harness.get("validation_commands"), harness.get("validationCommands")])

        commands: list[dict[str, Any]] = []
        for candidate in candidates:
            if not isinstance(candidate, list):
                continue
            for item in candidate:
                if isinstance(item, str):
                    commands.append({"command": item, "related_files": []})
                elif isinstance(item, dict) and isinstance(item.get("command"), str):
                    related = item.get("related_files") or item.get("relatedFiles") or []
                    if not isinstance(related, list):
                        related = []
                    commands.append({"command": item["command"], "related_files": related})
        return commands

    def _node_command_prefix(self) -> str:
        return (
            "if command -v node >/dev/null 2>&1; then NODE=$(command -v node); "
            "elif [ -x /opt/agent-cli/bin/node ]; then NODE=/opt/agent-cli/bin/node; "
            "else echo 'node not found for validation' >&2; exit 127; fi; \"$NODE\""
        )

    def _generic_script_run_command(self, path: str) -> str | None:
        name = pathlib.PurePosixPath(path).name
        if not re.match(r"^(check|verify|validate|test)(?:[_\-.].*|$)", name):
            return None

        quoted = shlex.quote(path)
        suffix = pathlib.PurePosixPath(path).suffix.lower()
        if suffix == ".py":
            return f"cd /app && python {quoted}"
        if suffix == ".sh":
            return f"cd /app && bash {quoted}"
        if suffix == ".js":
            return f"cd /app && {self._node_command_prefix()} {quoted}"
        return f"if [ -x {quoted} ]; then cd /app && {quoted}; else echo 'validation script is not executable: {path}' >&2; fi"

    async def _run_validation_command(
        self,
        environment: BaseEnvironment,
        env_vars: dict[str, str],
        attempt: int,
        index: int,
        spec: dict[str, Any],
    ) -> dict[str, Any]:
        command = str(spec.get("command") or "")
        stdout_log = f"/tmp/sigma-validation-{attempt}-{index}.stdout.log"
        stderr_log = f"/tmp/sigma-validation-{attempt}-{index}.stderr.log"
        self._snapshot_extra_paths.update([stdout_log, stderr_log])
        for path in spec.get("related_files", []):
            if isinstance(path, str):
                self._snapshot_extra_paths.add(path)

        command_log = shlex.quote(f"[sigma-validation] command: {command}")
        wrapped_command = f"""
set +e
rm -f {shlex.quote(stdout_log)} {shlex.quote(stderr_log)}
({command}) >{shlex.quote(stdout_log)} 2>{shlex.quote(stderr_log)}
code=$?
printf '%s\n' {command_log} >&2
echo "[sigma-validation] exit_code=${{code}}" >&2
if [ -s {shlex.quote(stdout_log)} ]; then
  echo "[sigma-validation] stdout tail:" >&2
  tail -c 4000 {shlex.quote(stdout_log)}
fi
if [ -s {shlex.quote(stderr_log)} ]; then
  echo "[sigma-validation] stderr tail:" >&2
  tail -c 4000 {shlex.quote(stderr_log)} >&2
fi
exit "${{code}}"
""".strip()

        base_result = {
            "kind": "validation",
            "source": spec.get("source") or "generic",
            "command": command,
            "attempt": attempt,
            "index": index,
            "stdout_log": stdout_log,
            "stderr_log": stderr_log,
            "timeout_sec": self.validation_timeout_sec,
            "related_files": spec.get("related_files", []),
        }
        try:
            result = await environment.exec(
                wrapped_command,
                env=env_vars or None,
                timeout_sec=self.validation_timeout_sec,
            )
            exit_code = _return_code(result)
            stdout_tail = _tail_text((await self._read_remote_file_tail(environment, stdout_log)).strip())
            stderr_tail = _tail_text((await self._read_remote_file_tail(environment, stderr_log)).strip())
            output = _truncate_text(_output_text(result).strip())
            message = (
                "validation command passed"
                if exit_code == 0
                else f"validation command failed with exit code {exit_code}"
            )
            if output and exit_code != 0:
                message = f"{message}: {output}"
            return {
                **base_result,
                "exit_code": exit_code,
                "output": output,
                "stdout_tail": stdout_tail,
                "stderr_tail": stderr_tail,
                "message": message,
            }
        except Exception as exc:
            stdout_tail = await self._safe_read_remote_file_tail(environment, stdout_log)
            stderr_tail = await self._safe_read_remote_file_tail(environment, stderr_log)
            return {
                **base_result,
                "exit_code": 1,
                "output": "",
                "stdout_tail": stdout_tail,
                "stderr_tail": stderr_tail,
                "message": f"validation command failed: {exc}",
            }

    async def _run_precheck(self, environment: BaseEnvironment, env_vars: dict[str, str]) -> dict[str, Any]:
        assert self.precheck_command is not None
        attempt = len(self._last_precheck_results) + 1
        stdout_log = f"/tmp/sigma-precheck-{attempt}.stdout.log"
        stderr_log = f"/tmp/sigma-precheck-{attempt}.stderr.log"
        wrapped_command = f"""
set +e
rm -f {shlex.quote(stdout_log)} {shlex.quote(stderr_log)}
({self.precheck_command}) >{shlex.quote(stdout_log)} 2>{shlex.quote(stderr_log)}
code=$?
echo "[sigma-precheck] exit_code=${{code}}" >&2
if [ -s {shlex.quote(stdout_log)} ]; then
  echo "[sigma-precheck] stdout tail:" >&2
  tail -c 4000 {shlex.quote(stdout_log)}
fi
if [ -s {shlex.quote(stderr_log)} ]; then
  echo "[sigma-precheck] stderr tail:" >&2
  tail -c 4000 {shlex.quote(stderr_log)} >&2
fi
exit "${{code}}"
""".strip()
        try:
            result = await environment.exec(
                wrapped_command,
                env=env_vars or None,
                timeout_sec=self.precheck_timeout_sec,
            )
            exit_code = _return_code(result)
            stdout_tail = _tail_text((await self._read_remote_file_tail(environment, stdout_log)).strip())
            stderr_tail = _tail_text((await self._read_remote_file_tail(environment, stderr_log)).strip())
            output = _truncate_text(_output_text(result).strip())
            message = "precheck command passed" if exit_code == 0 else f"precheck command failed with exit code {exit_code}"
            if output and exit_code != 0:
                message = f"{message}: {output}"
            return {
                "kind": "precheck",
                "source": "task-specific",
                "command": self.precheck_command,
                "attempt": attempt,
                "exit_code": exit_code,
                "output": output,
                "stdout_tail": stdout_tail,
                "stderr_tail": stderr_tail,
                "stdout_log": stdout_log,
                "stderr_log": stderr_log,
                "timeout_sec": self.precheck_timeout_sec,
                "message": message,
            }
        except Exception as exc:
            stdout_tail = await self._safe_read_remote_file_tail(environment, stdout_log)
            stderr_tail = await self._safe_read_remote_file_tail(environment, stderr_log)
            return {
                "kind": "precheck",
                "source": "task-specific",
                "command": self.precheck_command,
                "attempt": attempt,
                "exit_code": 1,
                "output": "",
                "stdout_tail": stdout_tail,
                "stderr_tail": stderr_tail,
                "stdout_log": stdout_log,
                "stderr_log": stderr_log,
                "timeout_sec": self.precheck_timeout_sec,
                "message": f"precheck command failed: {exc}",
            }

    def _instruction_with_precheck_feedback(
        self,
        instruction: str,
        precheck_results: list[dict[str, Any]],
    ) -> str:
        feedback = ["The previous attempt failed harness validation. Fix the issue and rerun validation."]
        failed_results = [result for result in precheck_results if _as_int(result.get("exit_code"), 0) != 0]
        for index, result in enumerate(failed_results, start=1):
            kind = str(result.get("kind") or "precheck")
            label = "Validation" if kind == "validation" else "Precheck"
            feedback.append(f"\n{label} failure {index}:")
            feedback.append(str(result.get("message") or "precheck failed"))
            command = result.get("command")
            if command:
                feedback.append(f"\nCommand: {command}")
            if result.get("exit_code") is not None:
                feedback.append(f"Exit code: {result.get('exit_code')}")
            related_files = result.get("related_files")
            if isinstance(related_files, list) and related_files:
                feedback.append("\nRelated files:")
                feedback.append("\n".join(str(path) for path in related_files[:20]))
            agent_summary = result.get("agent_summary")
            if agent_summary:
                feedback.append("\nPrevious agent summary:")
                feedback.append(str(agent_summary))
            stdout_tail = result.get("stdout_tail")
            if stdout_tail:
                feedback.append(f"\n{label} stdout tail:")
                feedback.append(str(stdout_tail))
            stderr_tail = result.get("stderr_tail")
            if stderr_tail:
                feedback.append(f"\n{label} stderr tail:")
                feedback.append(str(stderr_tail))
            trace_tail = result.get("trace_tail")
            if trace_tail:
                feedback.append("\nTrace tail key events:")
                feedback.append(str(trace_tail))
        feedback_text = "\n".join(feedback)
        return f"{instruction.rstrip()}\n\n---\n\n{feedback_text}\n"

    async def _read_remote_file_tail(
        self,
        environment: BaseEnvironment,
        remote_path: str,
        max_bytes: int = 4000,
    ) -> str:
        command = f"if [ -f {shlex.quote(remote_path)} ]; then tail -c {int(max_bytes)} {shlex.quote(remote_path)}; fi"
        result = await environment.exec(command, timeout_sec=30)
        return _stdout_text(result)

    async def _safe_read_remote_file_tail(
        self,
        environment: BaseEnvironment,
        remote_path: str,
        max_bytes: int = 4000,
    ) -> str:
        try:
            return _tail_text((await self._read_remote_file_tail(environment, remote_path, max_bytes=max_bytes)).strip())
        except Exception:
            return ""

    async def _read_remote_json_if_present(
        self,
        environment: BaseEnvironment,
        remote_path: str,
    ) -> dict[str, Any]:
        text = await self._safe_read_remote_file_tail(environment, remote_path, max_bytes=20000)
        if not text.strip():
            return {}
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return {}
        return value if isinstance(value, dict) else {}

    def _summary_feedback(self, summary: dict[str, Any]) -> str:
        if not summary:
            return ""
        keys = [
            "status",
            "finish_reason",
            "finishReason",
            "commands_executed",
            "commandsExecuted",
            "duration_ms",
            "durationMs",
            "last_error",
            "lastError",
        ]
        compact = {key: summary.get(key) for key in keys if summary.get(key) not in (None, "")}
        return _truncate_text(json.dumps(compact or summary, ensure_ascii=False, sort_keys=True), 3000)

    def _trace_tail_key_info(self, trace_tail: str) -> str:
        lines = [line for line in trace_tail.splitlines() if line.strip()]
        if not lines:
            return ""

        selected: list[str] = []
        for line in lines[-80:]:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                selected.append(line)
                continue

            event_type = event.get("type")
            if event_type in {"run_end", "error", "tool_end"}:
                selected.append(json.dumps(event, ensure_ascii=False, sort_keys=True))

        if not selected:
            selected = lines[-12:]
        return _truncate_text("\n".join(selected[-12:]), 6000)

    def _is_max_wall_time(
        self,
        result: Any | None,
        agent_summary: dict[str, Any],
        trace_tail: str,
    ) -> bool:
        finish_reason = agent_summary.get("finish_reason") or agent_summary.get("finishReason")
        if finish_reason == "max_wall_time":
            return True
        haystack = "\n".join(
            [
                _output_text(result) if result is not None else "",
                json.dumps(agent_summary, ensure_ascii=False, sort_keys=True) if agent_summary else "",
                trace_tail,
            ]
        )
        return bool(
            re.search(r"finish[_ ]?reason\"?\s*[:=]\s*\"?max_wall_time", haystack, flags=re.IGNORECASE)
            or re.search(r"finishReason\"?\s*[:=]\s*\"?max_wall_time", haystack)
            or re.search(r"agent execution timed out|timed out after|max wall time", haystack, flags=re.IGNORECASE)
        )

    def _minimum_retry_budget_sec(self) -> int:
        if self.retry_min_budget_sec is not None:
            return self.retry_min_budget_sec
        short_retry_floor = self.precheck_timeout_sec + 60
        command_floor = min(self.max_wall_time_sec, self.command_timeout_sec)
        return max(1, int(max(short_retry_floor, command_floor)))

    def _remaining_harbor_budget_sec(self, run_started_at: float) -> int | None:
        if self.harbor_agent_timeout_sec is None:
            return None
        elapsed = max(0.0, time.monotonic() - run_started_at)
        return max(0, int(self.harbor_agent_timeout_sec - elapsed))

    def _retry_budget_decision(
        self,
        retry_number: int,
        run_started_at: float,
        result: Any | None,
        agent_summary: dict[str, Any],
        trace_tail: str,
    ) -> dict[str, Any]:
        remaining = self._remaining_harbor_budget_sec(run_started_at)
        minimum = self._minimum_retry_budget_sec()
        first_run_max_wall = retry_number == 1 and self._is_max_wall_time(result, agent_summary, trace_tail)
        if remaining is not None and remaining < minimum:
            return {
                "retry_number": retry_number,
                "action": "skipped",
                "reason": (
                    "insufficient_harbor_budget_after_max_wall_time"
                    if first_run_max_wall
                    else "insufficient_harbor_budget_for_retry"
                ),
                "remaining_harbor_budget_sec": remaining,
                "minimum_retry_budget_sec": minimum,
            }
        return {
            "retry_number": retry_number,
            "action": "started",
            "reason": "budget_available",
            "remaining_harbor_budget_sec": remaining,
            "minimum_retry_budget_sec": minimum,
        }

    def _retry_trigger(self, failed_checks: list[dict[str, Any]]) -> str:
        kinds = {str(check.get("kind") or "") for check in failed_checks}
        if "validation" in kinds and "precheck" in kinds:
            return "validation+precheck"
        if "validation" in kinds:
            return "validation"
        if "precheck" in kinds:
            return "precheck"
        return "harness"

    def _cleanup_globs_for_context(self, context: AgentContext) -> list[str]:
        if self.cleanup_globs_explicit:
            return list(self.cleanup_globs)

        task_hint = f"{self._context_task_id(context) or ''} {self.logs_dir}".lower()
        if "make-mips-interpreter" in task_hint:
            return ["/tmp/frame*.bmp"]
        return []

    async def _cleanup_before_verifier(
        self,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> dict[str, Any] | None:
        patterns = self._cleanup_globs_for_context(context)
        if not patterns:
            return None

        script = f"""
python3 - <<'PY'
import glob
import json
import os

patterns = {json.dumps(patterns)}
removed = []
skipped = []
for pattern in patterns:
    for path in glob.glob(pattern):
        try:
            if os.path.isfile(path) or os.path.islink(path):
                os.remove(path)
                removed.append(path)
            else:
                skipped.append(path)
        except OSError as exc:
            skipped.append(f"{{path}}: {{exc}}")
print(json.dumps({{"removed": removed, "skipped": skipped}}, sort_keys=True))
PY
""".strip()
        result = await environment.exec(script, timeout_sec=30)
        output = _output_text(result).strip()
        cleanup_result: dict[str, Any] = {
            "patterns": patterns,
            "exit_code": _return_code(result),
            "output": _truncate_text(output, 2000),
        }
        if cleanup_result["exit_code"] != 0:
            cleanup_result["warning"] = output or "pre-verifier cleanup command failed"
        return cleanup_result

    def _snapshot_patterns(self) -> list[str]:
        patterns = ["/app/vm.js", "/tmp/frame*.bmp", "/tmp/sigma-precheck-*", "/tmp/sigma-validation-*"]
        patterns.extend(sorted(self._snapshot_extra_paths))
        return list(dict.fromkeys(patterns))

    def _snapshot_relative_path(self, remote_path: str) -> pathlib.Path:
        normalized = remote_path.replace("\\", "/")
        if normalized.startswith("/app/"):
            relative = normalized[len("/app/") :]
            return pathlib.Path("workspace") / pathlib.PurePosixPath(relative)
        if normalized.startswith("/tmp/"):
            return pathlib.Path("workspace") / "tmp" / pathlib.PurePosixPath(normalized).name
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", normalized).strip("-") or "snapshot-file"
        return pathlib.Path("workspace") / safe_name

    async def _list_snapshot_files(self, environment: BaseEnvironment, patterns: list[str]) -> list[dict[str, Any]]:
        script = f"""
python3 - <<'PY'
import glob
import json
import os

patterns = {json.dumps(patterns)}
files = []
seen = set()
for pattern in patterns:
    for path in glob.glob(pattern):
        if path in seen or not os.path.isfile(path):
            continue
        seen.add(path)
        try:
            size = os.path.getsize(path)
        except OSError:
            size = None
        files.append({{"remote_path": path, "size": size}})
print(json.dumps(sorted(files, key=lambda item: item["remote_path"])))
PY
""".strip()
        result = await environment.exec(script, timeout_sec=30)
        if _return_code(result) != 0:
            raise RuntimeError(_output_text(result).strip() or "snapshot file listing failed")
        text = _stdout_text(result).strip()
        if not text:
            return []
        value = json.loads(text)
        return value if isinstance(value, list) else []

    async def _download_workspace_snapshot(
        self,
        environment: BaseEnvironment,
        reason: str,
    ) -> dict[str, Any]:
        patterns = self._snapshot_patterns()
        snapshot: dict[str, Any] = {
            "reason": reason,
            "patterns": patterns,
            "success": True,
            "files": [],
        }
        try:
            remote_files = await self._list_snapshot_files(environment, patterns)
        except Exception as exc:
            snapshot["success"] = False
            snapshot["warning"] = str(exc)
            return snapshot

        self.logs_dir.mkdir(parents=True, exist_ok=True)
        warnings: list[str] = []
        snapshot_prefix = pathlib.Path()
        if reason != "final":
            safe_reason = re.sub(r"[^A-Za-z0-9._-]+", "-", reason).strip("-") or "snapshot"
            snapshot_prefix = pathlib.Path("snapshots") / safe_reason
        for item in remote_files:
            remote_path = str(item.get("remote_path") or "")
            if not remote_path:
                continue
            relative_path = snapshot_prefix / self._snapshot_relative_path(remote_path)
            target_path = self.logs_dir / relative_path
            record = {
                "remote_path": remote_path,
                "artifact_path": str(relative_path).replace("\\", "/"),
                "size": item.get("size"),
                "downloaded": False,
            }
            try:
                target_path.parent.mkdir(parents=True, exist_ok=True)
                await environment.download_file(remote_path, target_path)
                record["downloaded"] = True
            except Exception as exc:
                record["warning"] = str(exc)
                warnings.append(f"{remote_path}: {exc}")
            snapshot["files"].append(record)

        snapshot["downloaded_count"] = sum(1 for item in snapshot["files"] if item.get("downloaded"))
        if warnings:
            snapshot["success"] = False
            snapshot["warnings"] = warnings
        return snapshot

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

        for dirname in ("workspace", "snapshots"):
            source_dir = self.logs_dir / dirname
            if source_dir.is_dir():
                target_dir = task_dir / dirname
                try:
                    if source_dir.resolve() == target_dir.resolve():
                        continue
                except OSError:
                    pass
                shutil.copytree(source_dir, target_dir, dirs_exist_ok=True)

        output = _output_text(result).strip() if result is not None else ""
        if output:
            (task_dir / "agent.log").write_text(f"{output}\n", encoding="utf-8")

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
            "precheck_results": self._last_precheck_results,
            "validation_results": [
                result for result in self._last_precheck_results if result.get("kind") == "validation"
            ],
            "generic_validation_enabled": self.generic_validation_enabled,
            "validation_timeout_sec": self.validation_timeout_sec,
            "precheck_timeout_sec": self.precheck_timeout_sec,
            "retry_decisions": self._retry_decisions,
            "changed_app_files": sorted(path for path in self._snapshot_extra_paths if path.startswith("/app/")),
            "workspace_snapshots": self._last_snapshot_results,
            "pre_verifier_cleanup": self._last_cleanup_result,
            "failure_signals": self._failure_signals_for_metadata(result),
        }
        (task_dir / "metadata.json").write_text(f"{json.dumps(metadata, indent=2)}\n", encoding="utf-8")

    def _failure_signals_for_metadata(self, result: Any | None) -> list[str]:
        signals: list[str] = []

        def add(signal: str) -> None:
            if signal not in signals:
                signals.append(signal)

        add("agent_setup_ok")

        for precheck in self._last_precheck_results:
            if _as_int(precheck.get("exit_code"), 0) != 0:
                if precheck.get("kind") == "validation":
                    add("validation_failed")
                else:
                    add("precheck_failed")
                text = json.dumps(precheck, ensure_ascii=False).lower()
                if "/tmp/frame.bmp" in text:
                    add("missing_artifact:/tmp/frame.bmp")

        for decision in self._retry_decisions:
            if decision.get("action") == "skipped":
                add("retry_cut_short_by_harbor")
            if decision.get("action") == "started" and "validation" in str(decision.get("trigger") or ""):
                add("validation_retry_used")

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
