"""Portable Harbor runtime for the Sigma agent CLI."""

from __future__ import annotations

import asyncio
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

CHECKPOINT_RECOVERY_POLICIES = {"restore", "keep", "ask"}
MAX_EXTERNAL_RECOVERIES = 8
RECOVERY_POLL_INTERVAL_SEC = 0.25
TERMINAL_EVENT_TYPES = {"run.completed", "run.cancelled", "run.failed"}


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


def _event_payload(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("payload")
    return payload if isinstance(payload, dict) else {}


def _event_identity(event: dict[str, Any]) -> tuple[str, ...]:
    event_id = event.get("eventId")
    if isinstance(event_id, str) and event_id:
        return ("event", event_id)
    seq = event.get("seq")
    session_id = event.get("sessionId")
    event_type = event.get("type")
    if isinstance(seq, int) and isinstance(session_id, str) and isinstance(event_type, str):
        return ("seq", session_id, str(seq), event_type)
    return ("raw", json.dumps(event, sort_keys=True, ensure_ascii=False))


class SigmaCliHarborAgent(BaseAgent):
    """Run Sigma's packaged Node CLI as a Harbor external agent."""

    SUPPORTS_ATIF = False
    SUPPORTS_WINDOWS = False

    def __init__(
        self,
        logs_dir: pathlib.Path | str | None = None,
        agent_cli_tarball: pathlib.Path | str | None = None,
        provider: str = "deepseek",
        model: str | None = None,
        max_wall_time_sec: int = 7200,
        agent_timeout_grace_sec: int = 120,
        **kwargs: Any,
    ) -> None:
        resolved_logs_dir = pathlib.Path(logs_dir) if logs_dir is not None else pathlib.Path.cwd() / ".agent" / "harbor"
        harbor_model_name = kwargs.pop("model_name", None)
        recovery_policy = kwargs.pop(
            "checkpoint_recovery",
            os.environ.get("SIGMA_CHECKPOINT_RECOVERY", "restore"),
        )
        reviewer_waiver_reason = kwargs.pop(
            "reviewer_waiver_reason",
            os.environ.get("SIGMA_REVIEWER_WAIVER_REASON"),
        )
        if not isinstance(recovery_policy, str) or recovery_policy not in CHECKPOINT_RECOVERY_POLICIES:
            raise ValueError(
                "checkpoint_recovery must be one of: restore, keep, ask"
            )
        resolved_model = model or harbor_model_name or _default_model(provider)
        super().__init__(logs_dir=resolved_logs_dir, model_name=resolved_model, **kwargs)
        self.agent_cli_tarball = pathlib.Path(agent_cli_tarball) if agent_cli_tarball is not None else None
        self.provider = provider
        self.model = resolved_model
        self.max_wall_time_sec = max_wall_time_sec
        self.agent_timeout_grace_sec = max(0, _as_int(agent_timeout_grace_sec, 120))
        self.checkpoint_recovery = recovery_policy
        self.reviewer_waiver_reason = (
            str(reviewer_waiver_reason).strip() if reviewer_waiver_reason else None
        )
        self._workspace: str | None = None

    @staticmethod
    def name() -> str:
        return "sigma-agent-cli"

    def version(self) -> str | None:
        return "0.1.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        self._workspace = await self._resolve_workspace(environment)
        await environment.exec("mkdir -p /tmp/agent", timeout_sec=30)
        installed = await environment.exec("command -v /usr/local/bin/agent >/dev/null 2>&1", timeout_sec=30)
        if _return_code(installed) == 0:
            await self._verify_agent_ready(environment)
            return

        tarball = self.agent_cli_tarball or self._tarball_from_env()
        if tarball is not None:
            await self._install_tarball(environment, tarball)
            await self._verify_agent_ready(environment)
            return

        message = (
            "agent_setup_failed: agent CLI is not installed in the task container. Pass "
            "agent_cli_tarball in the Harbor JobConfig, set AGENT_CLI_TARBALL, or bake "
            "/usr/local/bin/agent into the Harbor task image."
        )
        self._write_setup_checks([], "agent_setup_failed")
        raise RuntimeError(message)

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
        failure_kind: str | None = None
        artifact_warnings: list[str] = []
        events: list[dict[str, Any]] = []
        output_result: dict[str, Any] = {}
        summary_path: pathlib.Path | None = None
        trace_path: pathlib.Path | None = None
        try:
            await self._upload_instruction(environment, instruction)
            result = await self._run_agent_once(environment, env_vars, context)
            events, output_result = self._parse_stream_output(result)
            session_id = self._session_id(events, output_result)
            if session_id:
                recovery = await self._recover_external_checkpoint(
                    environment, session_id, events, env_vars
                )
                events = recovery[0]
                if recovery[1] is not None:
                    output_result = recovery[1]
                    result = self._result_with_payload(result, output_result)
                    error_message = None
                    failure_kind = None
                if recovery[2]:
                    error_message = recovery[2]
                    failure_kind = "checkpoint_recovery_required"
            if _return_code(result) != 0 and failure_kind is None:
                error_message = _output_text(result).strip() or f"agent exited with code {_return_code(result)}"
                failure_kind = "agent_failure"
            if output_result.get("status") == "needs_input" and failure_kind is None:
                error_message = str(output_result.get("finalMessage") or output_result.get("message") or "agent requires external input")
                failure_kind = "needs_input"
        except Exception as exc:
            error_message = str(exc)
            failure_kind = "agent_crash"
        finally:
            for remote_path, filename in (
                ("/tmp/agent/summary.json", "summary.json"),
                ("/tmp/agent/trace.jsonl", "trace.jsonl"),
            ):
                try:
                    downloaded = await self._download_if_present(environment, remote_path, filename)
                    if filename == "summary.json":
                        summary_path = downloaded
                    else:
                        trace_path = downloaded
                except Exception as exc:
                    artifact_warnings.append(f"{filename}: {exc}")
            try:
                artifact_warnings.extend(await self._download_attempt_artifacts(environment))
            except Exception as exc:
                artifact_warnings.append(f"attempts: {exc}")
            summary_path = summary_path or self._latest_downloaded_artifact("summary.json")
            trace_path = trace_path or self._latest_downloaded_artifact("trace.jsonl")

        derived_summary = self._summary_from_events(events, output_result)
        if events and (summary_path is None or trace_path is None):
            derived_summary_path, derived_trace_path = self._write_accounting_artifacts(
                events,
                derived_summary,
                write_summary=summary_path is None,
                write_trace=trace_path is None,
            )
            summary_path = summary_path or derived_summary_path
            trace_path = trace_path or derived_trace_path
        summary = {**derived_summary, **self._read_result(result)}
        downloaded_summary = self._read_summary(summary_path)
        if downloaded_summary:
            summary = {**summary, **downloaded_summary}
        self._populate_context(context, result, summary, error_message)
        self._set_context_value(context, "failure_kind", failure_kind)
        self._set_context_value(context, "artifact_warnings", artifact_warnings)
        self._mirror_bench_artifacts(context, result, summary_path, trace_path, summary)

        if failure_kind == "agent_crash":
            raise RuntimeError(f"agent_crash: {error_message or 'agent execution raised an exception.'}")
        if failure_kind in {"agent_failure", "checkpoint_recovery_required", "needs_input"}:
            raise RuntimeError(f"agent_failure: {error_message or 'agent exited unsuccessfully.'}")

    def _agent_command(self, context: AgentContext | None = None) -> list[str]:
        if self._workspace is None:
            raise RuntimeError("agent_setup_failed: workspace was not resolved")
        command = [
            "/usr/local/bin/agent",
            "run",
            "--workspace",
            self._workspace,
            "--prompt-file",
            "/tmp/agent/instruction.md",
            "--provider",
            self.provider,
            "--model",
            self.model,
            "--run-deadline-sec",
            str(self.max_wall_time_sec),
            "--permission-mode",
            "auto",
            "--output-format",
            "stream-json",
            "--output-schema",
            "3",
        ]
        if self.reviewer_waiver_reason:
            command.append("--waive-reviewer")
        return command

    async def _resolve_workspace(self, environment: BaseEnvironment) -> str:
        result = await environment.exec("pwd -P", timeout_sec=30)
        stdout = _stdout_text(result).strip()
        workspace = stdout.splitlines()[-1].strip() if stdout else ""
        if _return_code(result) != 0 or not workspace.startswith("/"):
            raise RuntimeError(self._setup_failure_message("workspace_discovery", result))

        accessible = await environment.exec(
            f"test -d {shlex.quote(workspace)} && test -r {shlex.quote(workspace)} && test -x {shlex.quote(workspace)}",
            cwd="/",
            timeout_sec=30,
        )
        if _return_code(accessible) != 0:
            raise RuntimeError(self._setup_failure_message("workspace_access", accessible))
        return workspace

    async def _run_agent_once(self, environment: BaseEnvironment, env_vars: dict[str, str], context: AgentContext) -> Any:
        command = self._agent_command(context)
        return await environment.exec(
            " ".join(shlex.quote(part) for part in command),
            env=env_vars or None,
            timeout_sec=self.max_wall_time_sec + self.agent_timeout_grace_sec,
        )

    def _parse_stream_output(self, result: Any | None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        events: list[dict[str, Any]] = []
        output_result: dict[str, Any] = {}
        for line in _stdout_text(result).splitlines() if result is not None else []:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict):
                continue
            if value.get("kind") == "event" and isinstance(value.get("event"), dict):
                event = value["event"]
                if isinstance(event.get("type"), str):
                    events.append(event)
                continue
            if value.get("kind") == "result" or value.get("type") == "result":
                candidate = value.get("result")
                output_result = dict(candidate) if isinstance(candidate, dict) else dict(value)
                continue
            if isinstance(value.get("type"), str) and value.get("payload") is not None:
                events.append(value)
        return events, output_result

    def _session_id(self, events: list[dict[str, Any]], output_result: dict[str, Any]) -> str | None:
        value = output_result.get("sessionId")
        if isinstance(value, str) and value:
            return value
        for event in events:
            value = event.get("sessionId")
            if isinstance(value, str) and value:
                return value
        return None

    def _pending_checkpoint(self, events: list[dict[str, Any]]) -> tuple[str, dict[str, Any]] | None:
        resolved: set[str] = set()
        for event in events:
            if event.get("type") != "checkpoint.recovery_resolved":
                continue
            checkpoint_id = _event_payload(event).get("checkpointId")
            payload = _event_payload(event)
            if isinstance(checkpoint_id, str) and checkpoint_id and (
                payload.get("sourceSessionId") is None or payload.get("applied") is True
            ):
                resolved.add(checkpoint_id)
        for event in reversed(events):
            if event.get("type") != "run.suspended":
                continue
            payload = _event_payload(event)
            checkpoint_id = payload.get("checkpointId")
            choices = payload.get("choices")
            if not isinstance(checkpoint_id, str) or not checkpoint_id or checkpoint_id in resolved:
                continue
            if not isinstance(choices, list) or not {"restore", "keep"}.issubset({str(item) for item in choices}):
                continue
            return checkpoint_id, payload
        return None

    def _terminal_result(self, events: list[dict[str, Any]], session_id: str) -> dict[str, Any] | None:
        for event in reversed(events):
            event_type = event.get("type")
            if event_type not in TERMINAL_EVENT_TYPES:
                continue
            payload = _event_payload(event)
            status = {
                "run.completed": "completed",
                "run.cancelled": "cancelled",
                "run.failed": "failed",
            }[event_type]
            finish_reason = payload.get("finishReason")
            if not isinstance(finish_reason, str) or not finish_reason:
                finish_reason = status
            final_message = payload.get("message")
            if not isinstance(final_message, str):
                final_message = payload.get("finalMessage")
            return {
                **payload,
                "status": status,
                "finishReason": finish_reason,
                "sessionId": session_id,
                **({"finalMessage": final_message} if isinstance(final_message, str) else {}),
            }
        return None

    def _merge_events(self, current: list[dict[str, Any]], additions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        merged: dict[tuple[str, ...], dict[str, Any]] = {
            _event_identity(event): event for event in current
        }
        for event in additions:
            merged[_event_identity(event)] = event
        return sorted(
            merged.values(),
            key=lambda event: (
                event.get("seq") if isinstance(event.get("seq"), int) else 2**63,
                str(event.get("occurredAt", "")),
            ),
        )

    def _session_command(self, subcommand: str, session_id: str) -> list[str]:
        if self._workspace is None:
            raise RuntimeError("agent_setup_failed: workspace was not resolved")
        return [
            "/usr/local/bin/agent",
            "session",
            subcommand,
            session_id,
            "--workspace",
            self._workspace,
            "--provider",
            self.provider,
            "--model",
            self.model,
        ]

    async def _read_session_events(
        self,
        environment: BaseEnvironment,
        session_id: str,
        env_vars: dict[str, str],
    ) -> tuple[list[dict[str, Any]], str | None]:
        command = self._session_command("show", session_id) + ["--json"]
        result = await environment.exec(
            " ".join(shlex.quote(part) for part in command),
            env=env_vars or None,
            timeout_sec=30,
        )
        if _return_code(result) != 0:
            return [], _output_text(result).strip() or "session show failed"
        for line in reversed(_stdout_text(result).splitlines()):
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict) or not isinstance(value.get("events"), list):
                continue
            return [event for event in value["events"] if isinstance(event, dict)], None
        return [], "session show did not return an event list"

    async def _recover_external_checkpoint(
        self,
        environment: BaseEnvironment,
        session_id: str,
        events: list[dict[str, Any]],
        env_vars: dict[str, str],
    ) -> tuple[list[dict[str, Any]], dict[str, Any] | None, str | None]:
        if self._pending_checkpoint(events) is None:
            return events, None, None
        if self.checkpoint_recovery == "ask":
            checkpoint_id = self._pending_checkpoint(events)[0]  # guarded above
            return events, None, f"checkpoint recovery required for {checkpoint_id}"

        merged = list(events)
        deadline = time.monotonic() + self.max_wall_time_sec + self.agent_timeout_grace_sec
        for _ in range(MAX_EXTERNAL_RECOVERIES):
            pending = self._pending_checkpoint(merged)
            if pending is not None:
                checkpoint_id, _payload = pending
                command = self._session_command("recover", session_id) + [
                    checkpoint_id,
                    f"--{self.checkpoint_recovery}",
                ]
                recovery = await environment.exec(
                    " ".join(shlex.quote(part) for part in command),
                    env=env_vars or None,
                    timeout_sec=30,
                )
                if _return_code(recovery) != 0:
                    detail = _output_text(recovery).strip() or "session recover failed"
                    return merged, None, f"external checkpoint recovery failed: {detail}"
                resume_command = self._session_command("resume", session_id)
                resumed = await environment.exec(
                    " ".join(shlex.quote(part) for part in resume_command),
                    env=env_vars or None,
                    timeout_sec=30,
                )
                if _return_code(resumed) != 0:
                    detail = _output_text(resumed).strip() or "session resume failed"
                    return merged, None, f"external checkpoint resume failed: {detail}"

            additions, show_error = await self._read_session_events(environment, session_id, env_vars)
            if show_error is not None:
                return merged, None, f"external checkpoint recovery could not observe session progress: {show_error}"
            else:
                merged = self._merge_events(merged, additions)
                terminal = self._terminal_result(merged, session_id)
                if terminal is not None:
                    return merged, terminal, None

            if time.monotonic() >= deadline:
                return merged, None, "external checkpoint recovery timed out before the session reached a terminal state"
            await asyncio.sleep(RECOVERY_POLL_INTERVAL_SEC)
        return merged, None, "external checkpoint recovery exceeded the recovery-attempt limit"

    def _result_with_payload(self, base_result: Any, payload: dict[str, Any]) -> dict[str, Any]:
        status = payload.get("status")
        return {
            "return_code": 0 if status == "completed" else 1,
            "stdout": f"{_stdout_text(base_result)}\n{json.dumps(payload, ensure_ascii=False)}\n",
            "stderr": _stderr_text(base_result),
        }

    def _summary_from_events(
        self,
        events: list[dict[str, Any]],
        output_result: dict[str, Any],
    ) -> dict[str, Any]:
        usage = [_event_payload(event) for event in events if event.get("type") == "usage.recorded"]
        input_tokens = sum(_as_int(item.get("inputTokens"), 0) for item in usage)
        output_tokens = sum(_as_int(item.get("outputTokens"), 0) for item in usage)
        cache_tokens = sum(
            _as_int(item.get("cacheReadTokens"), 0) + _as_int(item.get("cacheWriteTokens"), 0)
            for item in usage
        )
        cost_micro_usd = sum(_as_int(item.get("costMicroUsd"), 0) for item in usage)
        return {
            "schema_version": 1,
            "status": output_result.get("status"),
            "finish_reason": output_result.get("finishReason"),
            "session_id": output_result.get("sessionId") or self._session_id(events, output_result),
            "commands_executed": sum(event.get("type") in {"tool.completed", "tool.failed"} for event in events),
            "tool_calls": sum(event.get("type") == "tool.requested" for event in events),
            "model_turns": sum(event.get("type") == "model.started" for event in events),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_tokens": cache_tokens,
            "cost_usd": cost_micro_usd / 1_000_000,
        }

    def _trace_records(
        self,
        events: list[dict[str, Any]],
        summary: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        for event in events:
            event_type = event.get("type")
            payload = _event_payload(event)
            if event_type == "usage.recorded":
                trace_type = "usage"
                metadata = {"usage": {
                    **payload,
                    "cacheTokens": payload.get("cacheTokens", _as_int(payload.get("cacheReadTokens"), 0)
                        + _as_int(payload.get("cacheWriteTokens"), 0)),
                    "costUsd": payload.get("costUsd", _as_int(payload.get("costMicroUsd"), 0) / 1_000_000),
                }}
            elif event_type == "tool.started":
                trace_type = "tool_start"
                metadata = {**payload, "toolName": payload.get("toolName") or payload.get("name")}
            elif event_type in {"tool.completed", "tool.failed"}:
                trace_type = "tool_end"
                metadata = {**payload, "toolName": payload.get("toolName") or payload.get("name")}
            elif event_type == "model.started":
                trace_type = "model_start"
                metadata = payload
            elif event_type in {"model.completed", "model.failed"}:
                trace_type = "model_end"
                metadata = payload
            elif event_type in TERMINAL_EVENT_TYPES:
                trace_type = "run_end"
                result = {
                    **payload,
                    **({
                        "status": summary.get("status"),
                        "finishReason": summary.get("finish_reason"),
                        "commands_executed": summary.get("commands_executed", 0),
                        "input_tokens": summary.get("input_tokens", 0),
                        "output_tokens": summary.get("output_tokens", 0),
                        "cache_tokens": summary.get("cache_tokens", 0),
                        "cost_usd": summary.get("cost_usd"),
                    } if summary is not None else {}),
                }
                metadata = {"result": result}
            else:
                trace_type = str(event_type or "event")
                metadata = {"payload": payload}
            records.append({
                "type": trace_type,
                "seq": event.get("seq"),
                "occurredAt": event.get("occurredAt"),
                "metadata": metadata,
                "sigma_event": event,
            })
        return records

    def _write_accounting_artifacts(
        self,
        events: list[dict[str, Any]],
        summary: dict[str, Any],
        write_summary: bool = True,
        write_trace: bool = True,
    ) -> tuple[pathlib.Path | None, pathlib.Path | None]:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        summary_path = self.logs_dir / "summary.json" if write_summary else None
        trace_path = self.logs_dir / "trace.jsonl" if write_trace else None
        if summary_path is not None:
            summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if trace_path is not None:
            trace_path.write_text(
                "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in self._trace_records(events, summary)),
                encoding="utf-8",
            )
        return summary_path, trace_path

    def _tarball_from_env(self) -> pathlib.Path | None:
        value = os.environ.get("AGENT_CLI_TARBALL")
        if not value:
            return None
        return pathlib.Path(value)

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
chmod 0755 /opt/agent-cli/bin/agent /opt/agent-cli/bin/node /opt/agent-cli/bin/sigma-exec
test -f /opt/agent-cli/bin/bwrap
chmod 0755 /opt/agent-cli/bin/bwrap
ln -sf /opt/agent-cli/bin/bwrap /usr/local/bin/bwrap
ln -sf /opt/agent-cli/bin/agent /usr/local/bin/agent
""".strip(),
            timeout_sec=180,
        )

    async def _verify_agent_ready(self, environment: BaseEnvironment) -> None:
        if self._workspace is None:
            raise RuntimeError("agent_setup_failed: workspace was not resolved")
        checks: list[dict[str, Any]] = []
        help_check = await environment.exec("/usr/local/bin/agent --help", timeout_sec=30)
        checks.append(self._setup_check_record("help", help_check))
        self._write_setup_checks(checks, "running")
        if _return_code(help_check) != 0:
            self._write_setup_checks(checks, "agent_setup_failed")
            raise RuntimeError(self._setup_failure_message("help", help_check))

        doctor_check = await environment.exec(
            " ".join([
                "/usr/local/bin/agent doctor --workspace",
                shlex.quote(self._workspace),
                "--json --strict",
            ]),
            env=self._agent_env() or None,
            timeout_sec=60,
        )
        doctor_record = self._setup_check_record("strict_doctor", doctor_check)
        doctor_record["doctor_json"] = self._parse_doctor_json(_stdout_text(doctor_check))
        checks.append(doctor_record)
        if _return_code(doctor_check) != 0:
            self._write_setup_checks(checks, "agent_setup_failed")
            raise RuntimeError(self._setup_failure_message("strict_doctor", doctor_check, doctor_record["doctor_json"]))
        self._write_setup_checks(checks, "passed")

    def _setup_check_record(self, stage: str, result: Any) -> dict[str, Any]:
        return {
            "stage": stage,
            "exit_code": _return_code(result),
            "stdout": _stdout_text(result),
            "stderr": _stderr_text(result),
        }

    def _parse_doctor_json(self, stdout: str) -> Any:
        text = stdout.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            for line in reversed(text.splitlines()):
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue
        return {"parse_error": "doctor stdout did not contain JSON", "raw_stdout": stdout}

    def _write_setup_checks(self, checks: list[dict[str, Any]], status: str) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": 1,
            "classification": status,
            "checks": checks,
        }
        (self.logs_dir / "setup-check.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _setup_failure_message(self, stage: str, result: Any, doctor_json: Any = None) -> str:
        details = [
            f"agent_setup_failed: stage={stage} exit_code={_return_code(result)}",
            f"stdout:\n{_stdout_text(result) or '<empty>'}",
            f"stderr:\n{_stderr_text(result) or '<empty>'}",
        ]
        if doctor_json is not None:
            details.append(f"doctor_json:\n{json.dumps(doctor_json, ensure_ascii=False, indent=2)}")
        return "\n".join(details)

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

    async def _download_attempt_artifacts(self, environment: BaseEnvironment) -> list[str]:
        warnings: list[str] = []
        exists = await environment.exec("test -d /tmp/agent/attempts", timeout_sec=30)
        if _return_code(exists) != 0:
            return warnings
        listing = await environment.exec("find /tmp/agent/attempts -type f 2>/dev/null", timeout_sec=30)
        if _return_code(listing) != 0:
            return warnings
        for raw_path in _stdout_text(listing).splitlines():
            remote_path = raw_path.strip()
            if not remote_path.startswith("/tmp/agent/attempts/"):
                continue
            relative = pathlib.PurePosixPath(remote_path.removeprefix("/tmp/agent/"))
            target_path = self.logs_dir / pathlib.Path(*relative.parts)
            target_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                await environment.download_file(remote_path, target_path)
            except Exception as exc:
                warnings.append(f"{relative.as_posix()}: {exc}")
        return warnings

    def _latest_downloaded_artifact(self, filename: str) -> pathlib.Path | None:
        candidates = [path for path in self.logs_dir.rglob(filename) if path.is_file()]
        return max(candidates, key=lambda path: path.stat().st_mtime_ns, default=None)

    def _read_summary(self, summary_path: pathlib.Path | None) -> dict[str, Any]:
        if summary_path is None or not summary_path.is_file():
            return {}
        try:
            value = json.loads(summary_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _read_result(self, result: Any | None) -> dict[str, Any]:
        if result is None:
            return {}
        for line in reversed(_stdout_text(result).splitlines()):
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                return value
        return {}

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
            "agent_stdout": _stdout_text(result),
            "agent_stderr": _stderr_text(result),
            "commands_executed": _json_number(summary, "commands_executed"),
            "tool_calls": _json_number(summary, "tool_calls"),
            "model_turns": _json_number(summary, "model_turns"),
            "n_tool_calls": _json_number(summary, "tool_calls"),
            "n_model_turns": _json_number(summary, "model_turns"),
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

        output = _output_text(result).strip() if result is not None else ""
        if output:
            (task_dir / "agent.log").write_text(f"{output}\n", encoding="utf-8")

        metadata = {
            "task_id": task_id,
            "source_logs_dir": str(self.logs_dir),
            "agent_setup_ok": True,
            "exit_code": getattr(context, "exit_code", None),
            "error_message": getattr(context, "error_message", None),
            "failure_kind": getattr(context, "failure_kind", None),
            "artifact_warnings": getattr(context, "artifact_warnings", []),
            "commands_executed": getattr(context, "commands_executed", 0),
            "tool_calls": getattr(context, "tool_calls", 0),
            "model_turns": getattr(context, "model_turns", 0),
            "n_input_tokens": getattr(context, "n_input_tokens", 0),
            "n_output_tokens": getattr(context, "n_output_tokens", 0),
            "n_cache_tokens": getattr(context, "n_cache_tokens", 0),
            "cost_usd": getattr(context, "cost_usd", None),
            "changed_app_files": [],
            "workspace_snapshots": [],
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
