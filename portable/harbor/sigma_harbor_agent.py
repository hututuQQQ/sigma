"""Portable Harbor runtime for the Sigma agent CLI."""

from __future__ import annotations

import asyncio
import base64
import hashlib
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
FAILURE_KINDS = {
    "needs_input", "timeout", "tool_error", "api_error", "agent_failure", "verifier_failure",
    "validation_blocked", "convergence_no_progress", "runtime_invariant_failure",
}
DOCTOR_REPORT_SCHEMA_VERSION = 1
BROKER_PROTOCOL_VERSION = 1
SUPPORTED_NETWORK_MODES = {"none", "full"}
MAX_CONTEXT_TEXT_CHARS = 8_192
MAX_PARTIAL_ARTIFACT_CHARS = 1_048_576
MAX_TRACE_ARTIFACT_BYTES = 4 * 1_048_576
MAX_STREAM_LINE_CHARS = 65_536
MAX_STREAM_RECORD_BYTES = 16 * 1_048_576
PROCESS_CLEANUP_TIMEOUT_SEC = 8
PROCESS_TERM_GRACE_SEC = 1


def _failure_kind_for_code(code: Any, payload: dict[str, Any] | None = None) -> str | None:
    normalized = code.lower() if isinstance(code, str) else ""
    if not normalized:
        return None
    diagnostics = (payload or {}).get("diagnostics")
    category = diagnostics.get("category") if isinstance(diagnostics, dict) else None
    if normalized == "convergence_no_progress":
        return "convergence_no_progress"
    if normalized.startswith("validation_"):
        return "validation_blocked"
    if normalized.startswith("runtime_") or normalized in {
        "effect_plan_violation", "tool_receipt_identity_mismatch", "validation_frontier_missing"
    }:
        return "runtime_invariant_failure"
    # Model protocol/convergence failures are agent outcomes, not provider API
    # failures. A provider category or an unambiguous transport/API prefix is
    # required before Harbor reports api_error.
    if category in {"network", "timeout", "authentication", "rate_limit", "server"}:
        return "api_error"
    if normalized.startswith(("api_", "provider_", "network_")):
        return "api_error"
    if normalized.startswith(("tool_", "execution_", "process_")):
        return "tool_error"
    return None


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


def _is_timeout_error(error: BaseException) -> bool:
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return True
    code = getattr(error, "code", None)
    if isinstance(code, str) and code.lower() in {
        "timeout", "timed_out", "process_timed_out", "broker_timeout", "process_deadline"
    }:
        return True
    return "timed out" in str(error).lower() or "timeout" in str(error).lower()


def _bounded_text(value: str, maximum: int = MAX_CONTEXT_TEXT_CHARS) -> str:
    if len(value) <= maximum:
        return value
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    marker = f"\n...[omitted {len(value) - maximum} chars; sha256={digest}]...\n"
    available = max(0, maximum - len(marker))
    head = available // 2
    tail = available - head
    return f"{value[:head]}{marker}{value[-tail:] if tail else ''}"


def _bounded_utf8_text(value: str, maximum: int) -> str:
    """Bound an artifact by encoded bytes while preserving valid UTF-8."""
    if maximum <= 0:
        return ""
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum:
        return value
    digest = hashlib.sha256(encoded).hexdigest()
    marker = f"\n...[truncated original_chars={len(value)} original_bytes={len(encoded)}; sha256={digest}]...\n"
    marker_bytes = marker.encode("utf-8")
    if len(marker_bytes) >= maximum:
        return marker_bytes[:maximum].decode("utf-8", errors="ignore")
    payload_budget = maximum - len(marker_bytes)
    head_budget = payload_budget // 2
    tail_budget = payload_budget - head_budget
    head = encoded[:head_budget].decode("utf-8", errors="ignore")
    tail = encoded[-tail_budget:].decode("utf-8", errors="ignore") if tail_budget else ""
    return f"{head}{marker}{tail}"


def _write_utf8_artifact(path: pathlib.Path, value: str) -> None:
    """Write an artifact without platform newline expansion."""
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write(value)


def _append_bounded_jsonl(path: pathlib.Path, record: dict[str, Any], maximum: int) -> None:
    line = (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")
    existing_size = path.stat().st_size if path.is_file() else 0
    if existing_size + len(line) <= maximum:
        with path.open("ab") as handle:
            handle.write(line)
        return
    existing = path.read_bytes() if path.is_file() else b""
    content = existing + line
    digest = hashlib.sha256(content).hexdigest()
    marker = (json.dumps({
        "type": "trace_truncated",
        "omitted_bytes_sha256": digest,
    }, ensure_ascii=False) + "\n").encode("utf-8")
    if len(marker) >= maximum:
        bounded = marker[:maximum]
    else:
        tail = content[-(maximum - len(marker)):].decode("utf-8", errors="ignore").encode("utf-8")
        bounded = marker + tail
        if len(bounded) > maximum:
            bounded = bounded[:maximum]
    with path.open("wb") as handle:
        handle.write(bounded)


def _text_artifact_summary(value: str) -> dict[str, Any]:
    encoded = value.encode("utf-8")
    return {
        "chars": len(value),
        "bytes": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "head": value[:512],
        "tail": value[-512:] if value else "",
        "truncated": len(value) > 1_024,
    }


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


def _bounded_event(event: dict[str, Any], maximum: int = 32_768) -> dict[str, Any]:
    raw = json.dumps(event, ensure_ascii=False, sort_keys=True)
    if len(raw) <= maximum:
        return event
    return {
        "type": event.get("type"),
        "eventId": event.get("eventId"),
        "sessionId": event.get("sessionId"),
        "seq": event.get("seq"),
        "payload_summary": _text_artifact_summary(raw),
        "truncated": True,
    }


def _decode_stream_line(
    line: str,
    chunks: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return []
    if not isinstance(value, dict) or value.get("kind") != "chunk":
        return [value] if isinstance(value, dict) else []
    if value.get("encoding") != "base64-json-utf8":
        return []
    record_id = value.get("recordId")
    index = value.get("index")
    total = value.get("total")
    data = value.get("data")
    if (
        not isinstance(record_id, str)
        or not isinstance(index, int)
        or not isinstance(total, int)
        or not isinstance(data, str)
        or total < 1
        or total > 100_000
        or index < 0
        or index >= total
    ):
        return []
    state = chunks.setdefault(record_id, {"total": total, "parts": {}})
    if state["total"] != total:
        chunks.pop(record_id, None)
        return []
    state["parts"][index] = data
    if len(state["parts"]) != total:
        return []
    encoded = "".join(state["parts"][part] for part in range(total))
    chunks.pop(record_id, None)
    if len(encoded) > MAX_STREAM_RECORD_BYTES * 2:
        raise ValueError("chunked stream record exceeds the adapter size limit")
    decoded = base64.b64decode(encoded, validate=True)
    if len(decoded) > MAX_STREAM_RECORD_BYTES:
        raise ValueError("chunked stream record exceeds the adapter size limit")
    restored = json.loads(decoded.decode("utf-8"))
    return [restored] if isinstance(restored, dict) else []


class _OutputRecorder:
    """Bounded, callback-driven accounting for a streaming agent command."""

    def __init__(self, logs_dir: pathlib.Path) -> None:
        self.logs_dir = logs_dir
        self.stdout_path = logs_dir / "stdout.partial.log"
        self.stderr_path = logs_dir / "stderr.partial.log"
        self.trace_path = logs_dir / "trace.jsonl"
        self.state_path = logs_dir / "runtime.partial.json"
        self._buffers = {"stdout": "", "stderr": ""}
        self._pending_stdout = ""
        self._stream_chunks: dict[str, dict[str, Any]] = {}
        self._seen: set[tuple[str, ...]] = set()
        self.events: list[dict[str, Any]] = []
        self.output_result: dict[str, Any] = {}
        self.last_event: dict[str, Any] | None = None
        self.model_turns = 0
        self.tool_calls = 0
        self.usage: dict[str, Any] = {}
        self.retry_count = 0
        self.last_retry: dict[str, Any] | None = None
        self.length_finish_count = 0
        self.converge_turns = 0
        logs_dir.mkdir(parents=True, exist_ok=True)
        for path in (self.stdout_path, self.stderr_path, self.trace_path):
            path.write_text("", encoding="utf-8")
        self._write_state()

    async def callback(self, text: str, stream: str) -> None:
        self.record(text, stream)

    def record(self, text: str, stream: str) -> None:
        if stream not in self._buffers:
            stream = "stdout"
        self._buffers[stream] = _bounded_utf8_text(
            self._buffers[stream] + (text or ""), MAX_PARTIAL_ARTIFACT_CHARS
        )
        path = self.stdout_path if stream == "stdout" else self.stderr_path
        _write_utf8_artifact(path, self._buffers[stream])
        if stream == "stdout" and text:
            lines = (self._pending_stdout + text).splitlines(keepends=True)
            self._pending_stdout = ""
            if lines and not lines[-1].endswith(("\n", "\r")):
                self._pending_stdout = _bounded_text(lines.pop(), MAX_STREAM_LINE_CHARS)
            for line in lines:
                self._consume_line(line)

    def _consume_line(self, line: str) -> None:
        for value in _decode_stream_line(line, self._stream_chunks):
            self._consume_value(value)

    def _consume_value(self, value: dict[str, Any]) -> None:
        if value.get("kind") == "event" and isinstance(value.get("event"), dict):
            event = value["event"]
        elif isinstance(value.get("type"), str) and value.get("payload") is not None:
            event = value
        else:
            event = None
        if isinstance(event, dict) and isinstance(event.get("type"), str):
            identity = _event_identity(event)
            if identity in self._seen:
                return
            self._seen.add(identity)
            self.events.append(event)
            self.last_event = event
            event_type = str(event.get("type"))
            if event_type == "model.started":
                self.model_turns += 1
            if event_type in {"tool.requested", "tool.started"}:
                self.tool_calls += 1
            payload = _event_payload(event)
            if event_type == "model.completed" and payload.get("finishReason") == "length":
                self.length_finish_count += 1
            if (event_type == "diagnostic" and payload.get("kind") == "deadline.stage"
                    and payload.get("stage") == "converge"):
                self.converge_turns += 1
            if event_type == "usage.recorded":
                self.usage = {
                    **self.usage,
                    **payload,
                    "cacheTokens": payload.get(
                        "cacheTokens",
                        _as_int(payload.get("cacheReadTokens"), 0)
                        + _as_int(payload.get("cacheWriteTokens"), 0),
                    ),
                }
            if "retry" in event_type.lower() or "retry" in str(payload.get("status", "")).lower():
                self.retry_count += 1
                self.last_retry = _bounded_event(event)
            _append_bounded_jsonl(self.trace_path, {
                "type": "event",
                "seq": event.get("seq"),
                "occurredAt": event.get("occurredAt"),
                "metadata": {"event_type": event_type},
                "sigma_event": _bounded_event(event),
            }, MAX_TRACE_ARTIFACT_BYTES)
            self._write_state()
            return
        if value.get("kind") == "result" or value.get("type") == "result":
            candidate = value.get("result")
            self.output_result = dict(candidate) if isinstance(candidate, dict) else dict(value)
            self._write_state()
            return
        if value.get("kind") == "error":
            error = value.get("error")
            error_record = error if isinstance(error, dict) else value
            code = error_record.get("code")
            failure = _failure_kind_for_code(code, error_record)
            self.output_result = {
                "status": "error",
                "message": str(error_record.get("message") or "agent CLI returned an error"),
                **({"failureKind": failure} if failure else {}),
            }
            self._write_state()

    def snapshot(self) -> dict[str, Any]:
        return {
            "last_event": _bounded_event(self.last_event) if self.last_event else None,
            "model_turns": self.model_turns,
            "tool_calls": self.tool_calls,
            "usage": dict(self.usage),
            "retry_count": self.retry_count,
            "last_retry": self.last_retry,
            "length_finish_count": self.length_finish_count,
            "converge_turns": self.converge_turns,
        }

    def _write_state(self) -> None:
        state = self.snapshot()
        self.state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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
        network_mode: str = "full",
        execution_mode: str = "sandboxed",
        max_wall_time_sec: int = 7200,
        agent_timeout_grace_sec: int = 120,
        outer_trial_deadline_sec: int | float | None = None,
        check_api: bool = True,
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
        if network_mode not in {"none", "full"}:
            raise ValueError("network_mode must be one of: none, full")
        self.network_mode = network_mode
        if execution_mode not in {"sandboxed", "disposable-container"}:
            raise ValueError(
                "execution_mode must be one of: sandboxed, disposable-container"
            )
        self.execution_mode = execution_mode
        self.effective_network_mode: str | None = network_mode
        self.available_network_modes: list[str] = []
        self.effective_read_scope = "host"
        self.process_handoff_available = False
        self.agent_timeout_grace_sec = max(0, _as_int(agent_timeout_grace_sec, 120))
        env_outer_deadline = os.environ.get("SIGMA_HARBOR_OUTER_TRIAL_DEADLINE_SEC")
        parsed_outer_deadline = _as_int(
            outer_trial_deadline_sec if outer_trial_deadline_sec is not None else env_outer_deadline,
            0,
        )
        self.outer_trial_deadline_sec = parsed_outer_deadline if parsed_outer_deadline > 0 else None
        requested_wall_time = max(1, _as_int(max_wall_time_sec, 7200))
        if self.outer_trial_deadline_sec is not None:
            requested_wall_time = min(
                requested_wall_time,
                max(1, self.outer_trial_deadline_sec - self.agent_timeout_grace_sec),
            )
        self.max_wall_time_sec = requested_wall_time
        self.check_api = bool(check_api)
        self._output_recorder: _OutputRecorder | None = None
        self._process_cleanup: dict[str, Any] | None = None
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
        await self._configure_execution_mode(environment)
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

    async def _configure_execution_mode(self, environment: BaseEnvironment) -> None:
        """Create an isolated home opt-in for an explicitly disposable run.

        The adapter never infers this mode from a task or environment. Keeping
        the opt-in under a dedicated HOME also prevents a workspace config from
        granting itself host execution privileges.
        """
        if self.execution_mode != "disposable-container":
            return
        command = (
            "umask 077; mkdir -p /tmp/agent/disposable-home/.sigma; "
            "printf '[security]\\nallow_unsafe_host_exec = true\\n' "
            "> /tmp/agent/disposable-home/.sigma/config.toml"
        )
        configured = await environment.exec(command, timeout_sec=30)
        if _return_code(configured) != 0:
            raise RuntimeError(
                "agent_setup_failed: could not create the disposable-container home opt-in"
            )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        recorder = _OutputRecorder(self.logs_dir)
        self._output_recorder = recorder
        env_vars = self._agent_env()
        result: Any | None = None
        error_message: str | None = None
        failure_kind: str | None = None
        timed_out = False
        cancelled_error: asyncio.CancelledError | None = None
        artifact_warnings: list[str] = []
        events: list[dict[str, Any]] = []
        output_result: dict[str, Any] = {}
        summary_path: pathlib.Path | None = None
        trace_path: pathlib.Path | None = None
        protocol_failure: dict[str, Any] | None = None
        try:
            await environment.exec("mkdir -p /tmp/agent", timeout_sec=30)
            await self._upload_instruction(environment, instruction)
            result = await self._run_agent_once(environment, env_vars, context, recorder)
            events, output_result = self._merge_recorded_output(result, recorder)
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
            reported_failure = output_result.get("failureKind") or output_result.get("failure_kind")
            if reported_failure not in FAILURE_KINDS:
                reported_failure = None
            event_failure = self._failure_kind_from_events(events, output_result)
            protocol_failure = self._incomplete_terminal_protocol(result, events, output_result)
            # needs_input is a terminal protocol state, even when the CLI uses
            # a non-zero status to make Harbor stop waiting for user input.
            if protocol_failure is not None:
                error_message = self._protocol_failure_message(protocol_failure)
                failure_kind = "agent_failure"
            elif output_result.get("status") == "needs_input":
                error_message = str(output_result.get("finalMessage") or output_result.get("message") or "agent requires external input")
                failure_kind = "needs_input"
            elif reported_failure is not None:
                error_message = str(output_result.get("message") or output_result.get("finalMessage") or reported_failure)
                failure_kind = reported_failure
            elif event_failure is not None and (
                output_result.get("status") not in {None, "completed"} or _return_code(result) != 0
            ):
                error_message = str(output_result.get("message") or output_result.get("finalMessage") or event_failure)
                failure_kind = event_failure
            elif output_result.get("status") in {"error", "failed", "cancelled"}:
                error_message = str(
                    output_result.get("finalMessage")
                    or output_result.get("message")
                    or f"agent returned terminal status {output_result.get('status')}"
                )
                failure_kind = "agent_failure"
            elif _return_code(result) != 0 and failure_kind is None:
                error_message = _output_text(result).strip() or f"agent exited with code {_return_code(result)}"
                failure_kind = "agent_failure"
        except asyncio.CancelledError as exc:
            cancelled_error = exc
            timed_out = True
            failure_kind = "timeout"
            error_message = "agent execution cancelled by the Harbor outer trial deadline"
            events, output_result = self._merge_recorded_output(result, recorder)
            self._process_cleanup = await self._cleanup_remote_process(environment)
            if self._process_cleanup.get("error"):
                artifact_warnings.append(str(self._process_cleanup["error"]))
            summary_path, trace_path = self._persist_timeout_artifacts(
                result,
                events,
                None,
                recorder.trace_path,
                error_message,
                recorder=recorder,
                process_cleanup=self._process_cleanup,
            )
        except Exception as exc:
            partial = getattr(exc, "result", None)
            if partial is None and (_stdout_text(exc) or _stderr_text(exc)):
                partial = exc
            if partial is not None:
                result = partial
            events, output_result = self._merge_recorded_output(result, recorder)
            if _is_timeout_error(exc):
                timed_out = True
                error_message = str(exc) or "agent execution timed out"
                failure_kind = "timeout"
                self._process_cleanup = await self._cleanup_remote_process(environment)
                if self._process_cleanup.get("error"):
                    artifact_warnings.append(str(self._process_cleanup["error"]))
                summary_path, trace_path = self._persist_timeout_artifacts(
                    result,
                    events,
                    None,
                    recorder.trace_path,
                    error_message,
                    recorder=recorder,
                    process_cleanup=self._process_cleanup,
                )
            else:
                error_message = str(exc)
                failure_kind = "agent_crash"
        finally:
            if cancelled_error is None and not timed_out:
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
                if trace_path == recorder.trace_path:
                    trace_path = None

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
        if protocol_failure is not None:
            summary.update({
                "status": "error",
                "finish_reason": "agent_protocol_incomplete",
                "failure_kind": "agent_failure",
                "last_error": error_message,
                "protocol_failure": protocol_failure,
            })
        if failure_kind is None and summary.get("failure_kind") in FAILURE_KINDS:
            failure_kind = summary["failure_kind"]
        if failure_kind is not None:
            summary["failure_kind"] = failure_kind
        summary["network_mode_requested"] = self.network_mode
        summary["network_mode_effective"] = self.effective_network_mode
        summary["execution_mode"] = self.execution_mode
        summary["read_scope_effective"] = self.effective_read_scope
        summary["process_handoff_available"] = self.process_handoff_available
        if self._process_cleanup is not None:
            summary["process_cleanup"] = self._process_cleanup
        self._populate_context(context, result, summary, error_message)
        if timed_out or protocol_failure is not None:
            self._set_context_value(context, "exit_code", 1)
        self._set_context_value(context, "failure_kind", failure_kind)
        self._set_context_value(context, "artifact_warnings", artifact_warnings)
        if protocol_failure is not None and summary_path is not None:
            summary_path.write_text(
                json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        self._mirror_bench_artifacts(context, result, summary_path, trace_path, summary)

        if cancelled_error is not None:
            raise cancelled_error

        if failure_kind == "agent_crash":
            raise RuntimeError(f"agent_crash: {error_message or 'agent execution raised an exception.'}")
        if failure_kind in {"agent_failure", "checkpoint_recovery_required", *FAILURE_KINDS}:
            raise RuntimeError(f"{failure_kind}: {error_message or 'agent exited unsuccessfully.'}")

    def _agent_command(self, context: AgentContext | None = None) -> list[str]:
        if self._workspace is None:
            raise RuntimeError("agent_setup_failed: workspace was not resolved")
        command = []
        if self.execution_mode == "disposable-container":
            command.extend(["env", "HOME=/tmp/agent/disposable-home"])
        command.extend([
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
            "--network",
            self.network_mode,
            "--read-scope",
            self.effective_read_scope,
            "--process-handoff",
            "allow",
            "--permission-mode",
            "auto",
            "--output-format",
            "stream-json",
            "--output-schema",
            "3",
            "--stream-json-max-line-bytes",
            "49152",
        ])
        if self.execution_mode == "disposable-container":
            command.extend(["--execution-mode", "disposable-container"])
        if self.reviewer_waiver_reason:
            command.append("--waive-reviewer")
        return command

    def _agent_command_with_process_record(self, command: list[str]) -> str:
        """Start only this agent in a private process group and wait for it.

        util-linux ``setsid`` forks when its caller is already a process-group
        leader. Without ``--wait`` that parent reports exit code zero while the
        actual agent is still running, truncating the runtime protocol. A
        setsid implementation without wait support is therefore less safe than
        the pid-only fallback.
        """
        process_file = "/tmp/agent/agent-process.json"
        command_text = shlex.join(command)
        group_body = (
            "pid=$$; "
            "pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' '); "
            "case \"$pgid\" in ''|*[!0-9]*) pgid=0;; esac; "
            f"printf '{{\"pid\":%s,\"pgid\":%s}}\\n' \"$pid\" \"$pgid\" > {shlex.quote(process_file)}; "
            f"exec {command_text}"
        )
        pid_only_body = (
            "pid=$$; "
            f"printf '{{\"pid\":%s,\"pgid\":0}}\\n' \"$pid\" > {shlex.quote(process_file)}; "
            f"exec {command_text}"
        )
        return "if command -v setsid >/dev/null 2>&1 && setsid --help 2>&1 | grep -q -- '--wait'; then " + (
            f"exec setsid --wait /bin/sh -c {shlex.quote(group_body)}; "
            f"else exec /bin/sh -c {shlex.quote(pid_only_body)}; fi"
        )

    async def _cleanup_remote_process(self, environment: BaseEnvironment) -> dict[str, Any]:
        """Terminate the recorded agent process/group without touching the container."""
        command = f"""
set +e
pid_file=/tmp/agent/agent-process.json
if test ! -f "$pid_file"; then
  printf '%s\n' '{{"pid_recorded":false,"status":"missing"}}'
  exit 0
fi
pid=$(sed -n 's/.*\"pid\":\\([0-9][0-9]*\\).*/\\1/p' "$pid_file")
pgid=$(sed -n 's/.*\"pgid\":\\([0-9][0-9]*\\).*/\\1/p' "$pid_file")
term_target=pid
if test -n "$pgid" && test "$pgid" -gt 1; then
  kill -TERM -- -"$pgid" 2>/dev/null
  term_target=group
else
  kill -TERM "$pid" 2>/dev/null
fi
term_status=$?
sleep {PROCESS_TERM_GRACE_SEC}
if test "$term_target" = group; then
  kill -0 -- -"$pgid" 2>/dev/null
  alive=$?
  if test "$alive" -eq 0; then kill -KILL -- -"$pgid" 2>/dev/null; fi
else
  kill -0 "$pid" 2>/dev/null
  alive=$?
  if test "$alive" -eq 0; then kill -KILL "$pid" 2>/dev/null; fi
fi
kill_status=$?
if test "$term_status" -ne 0 && test "$alive" -ne 0; then status=already_exited; else status=terminated; fi
printf '{{"pid_recorded":true,"pid":%s,"pgid":%s,"target":"%s","term_status":%s,"kill_status":%s,"alive_after_grace":%s,"status":"%s"}}\n' "$pid" "${{pgid:-0}}" "$term_target" "$term_status" "$kill_status" "$alive" "$status"
""".strip()
        try:
            result = await asyncio.wait_for(
                environment.exec(command, timeout_sec=PROCESS_CLEANUP_TIMEOUT_SEC),
                timeout=PROCESS_CLEANUP_TIMEOUT_SEC,
            )
        except asyncio.CancelledError:
            return {
                "status": "cleanup_cancelled",
                "error": "remote process cleanup was cancelled",
                "command": _bounded_text(command),
            }
        except Exception as exc:
            return {
                "status": "cleanup_failed",
                "error": _bounded_text(str(exc)),
                "command": _bounded_text(command),
            }
        output = _stdout_text(result).strip()
        if output:
            try:
                value = json.loads(output.splitlines()[-1])
                if isinstance(value, dict):
                    value.setdefault("command", _bounded_text(command))
                    return value
            except json.JSONDecodeError:
                pass
        return {
            "status": "cleanup_failed",
            "return_code": _return_code(result),
            "command": _bounded_text(command),
            "stdout": _bounded_text(output),
            "stderr": _bounded_text(_stderr_text(result)),
        }

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

    def _merge_recorded_output(
        self,
        result: Any | None,
        recorder: _OutputRecorder,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        parsed_events, parsed_result = self._parse_stream_output(result)
        events = self._merge_events(recorder.events, parsed_events)
        output_result = {**recorder.output_result, **parsed_result}
        return events, output_result

    async def _run_agent_once(
        self,
        environment: BaseEnvironment,
        env_vars: dict[str, str],
        context: AgentContext,
        recorder: _OutputRecorder | None = None,
    ) -> Any:
        command = self._agent_command(context)
        command_text = self._agent_command_with_process_record(command)
        kwargs = {
            "env": env_vars or None,
            "timeout_sec": self.max_wall_time_sec + self.agent_timeout_grace_sec,
        }
        callback_scope = getattr(environment, "scoped_output_callback", None)
        if recorder is not None and callable(callback_scope):
            with callback_scope(recorder.callback):
                return await environment.exec(command_text, **kwargs)
        return await environment.exec(command_text, **kwargs)

    def _parse_stream_output(self, result: Any | None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        events: list[dict[str, Any]] = []
        output_result: dict[str, Any] = {}
        chunks: dict[str, dict[str, Any]] = {}
        for line in _stdout_text(result).splitlines() if result is not None else []:
            for value in _decode_stream_line(line, chunks):
                if value.get("kind") == "event" and isinstance(value.get("event"), dict):
                    event = value["event"]
                    if isinstance(event.get("type"), str):
                        events.append(event)
                    continue
                if value.get("kind") == "result" or value.get("type") == "result":
                    candidate = value.get("result")
                    output_result = dict(candidate) if isinstance(candidate, dict) else dict(value)
                    continue
                if value.get("kind") == "error":
                    error = value.get("error")
                    error_record = error if isinstance(error, dict) else value
                    code = error_record.get("code")
                    failure = _failure_kind_for_code(code, error_record)
                    output_result = {
                        "status": "error",
                        "message": str(error_record.get("message") or "agent CLI returned an error"),
                        **({"failureKind": failure} if failure else {}),
                    }
                    continue
                if isinstance(value.get("status"), str):
                    output_result = dict(value)
                    continue
                if isinstance(value.get("type"), str) and value.get("payload") is not None:
                    events.append(value)
        return events, output_result

    def _failure_kind_from_events(
        self,
        events: list[dict[str, Any]],
        output_result: dict[str, Any],
    ) -> str | None:
        # A durable run terminal is the Agent/runtime outcome. Earlier model or
        # tool failures remain diagnostic causes, but must not override the
        # completed runtime lifecycle classification.
        terminal = next((event for event in reversed(events)
                         if event.get("type") in {"run.failed", "run.cancelled"}), None)
        if terminal is not None:
            payload = _event_payload(terminal)
            explicit = payload.get("failureKind") or payload.get("failure_kind")
            if explicit in FAILURE_KINDS:
                return explicit
            classified = _failure_kind_for_code(
                payload.get("code") or payload.get("diagnosticCode") or payload.get("failureCode"),
                payload,
            )
            return classified or "agent_failure"
        finish_reason = output_result.get("finishReason") or output_result.get("finish_reason")
        if finish_reason in {"timeout", "timed_out", "max_wall_time"}:
            return "timeout"
        for event in reversed(events):
            event_type = event.get("type")
            payload = _event_payload(event)
            explicit = payload.get("failureKind") or payload.get("failure_kind")
            if explicit in FAILURE_KINDS:
                return explicit
            code = payload.get("code") or payload.get("diagnosticCode") or payload.get("failureCode")
            if isinstance(code, str):
                classified = _failure_kind_for_code(code, payload)
                if classified:
                    return classified
            if event_type == "model.failed":
                return "api_error"
            if event_type == "tool.failed":
                return "tool_error"
            if event_type in {"run.failed", "run.cancelled"}:
                return "agent_failure"
        return None

    def _incomplete_terminal_protocol(
        self,
        result: Any,
        events: list[dict[str, Any]],
        output_result: dict[str, Any],
    ) -> dict[str, Any] | None:
        if _return_code(result) != 0:
            return None
        terminal_event = next(
            (event for event in reversed(events) if event.get("type") in TERMINAL_EVENT_TYPES),
            None,
        )
        result_status = output_result.get("status")
        has_result_status = isinstance(result_status, str) and result_status in {
            "completed", "needs_input", "cancelled", "error", "failed"
        }
        if terminal_event is not None or has_result_status:
            return None

        model_start = next(
            (event for event in reversed(events) if event.get("type") == "model.started"),
            None,
        )
        model_payload = _event_payload(model_start) if model_start is not None else {}
        model_failure = next(
            (event for event in reversed(events) if event.get("type") == "model.failed"),
            None,
        )
        failure_diagnostics = _event_payload(model_failure).get("diagnostics") \
            if model_failure is not None else None
        diagnostics = failure_diagnostics if isinstance(failure_diagnostics, dict) else {}
        return {
            "process_exit_code": 0,
            "terminal_event_received": False,
            "result_status_received": False,
            "result_finish_reason": output_result.get("finishReason") or output_result.get("finish_reason"),
            "last_event_type": events[-1].get("type") if events else None,
            "provider": diagnostics.get("provider") or model_payload.get("provider"),
            "model": diagnostics.get("model") or model_payload.get("model"),
            "http_status": diagnostics.get("httpStatus"),
            "done_received": diagnostics.get("doneReceived"),
            "has_content": diagnostics.get("hasContent", any(
                event.get("type") == "model.delta" for event in events
            )),
            "has_reasoning": diagnostics.get("hasReasoning", any(
                event.get("type") == "model.reasoning_delta" for event in events
            )),
            "has_tool_call": diagnostics.get("hasToolCall", any(
                event.get("type") == "tool.requested" for event in events
            )),
            "retry_attempts": diagnostics.get("retryAttempts"),
            "retry_count": sum(
                "retry" in str(event.get("type", "")).lower()
                or "retry" in str(_event_payload(event).get("status", "")).lower()
                for event in events
            ),
        }

    def _protocol_failure_message(self, diagnostics: dict[str, Any]) -> str:
        return "agent protocol incomplete: " + ", ".join([
            f"exit_code={diagnostics.get('process_exit_code')}",
            f"terminal_event_received={diagnostics.get('terminal_event_received')}",
            f"result_status_received={diagnostics.get('result_status_received')}",
            f"last_event_type={diagnostics.get('last_event_type')}",
            f"provider={diagnostics.get('provider')}",
            f"model={diagnostics.get('model')}",
            f"done_received={diagnostics.get('done_received')}",
            f"has_content={diagnostics.get('has_content')}",
            f"has_tool_call={diagnostics.get('has_tool_call')}",
            f"retry_attempts={diagnostics.get('retry_attempts')}",
        ])

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
        reasoning_tokens = sum(_as_int(item.get("reasoningTokens"), 0) for item in usage)
        cache_read_tokens = sum(_as_int(item.get("cacheReadTokens"), 0) for item in usage)
        cache_write_tokens = sum(_as_int(item.get("cacheWriteTokens"), 0) for item in usage)
        cache_tokens = cache_read_tokens + cache_write_tokens
        length_finish_count = sum(
            event.get("type") == "model.completed" and _event_payload(event).get("finishReason") == "length"
            for event in events
        )
        converge_turns = sum(
            event.get("type") == "diagnostic"
            and _event_payload(event).get("kind") == "deadline.stage"
            and _event_payload(event).get("stage") == "converge"
            for event in events
        )
        cost_micro_usd = sum(_as_int(item.get("costMicroUsd"), 0) for item in usage)
        model_failure_event = next(
            (event for event in reversed(events) if event.get("type") == "model.failed"),
            None,
        )
        model_failure_payload = _event_payload(model_failure_event) if model_failure_event is not None else {}
        model_diagnostics = model_failure_payload.get("diagnostics")
        model_failure = None
        if model_failure_event is not None:
            model_failure = {
                "code": model_failure_payload.get("code"),
                "diagnostics": model_diagnostics if isinstance(model_diagnostics, dict) else {},
            }
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
            "reasoning_tokens": reasoning_tokens,
            "cache_tokens": cache_tokens,
            "cache_read_tokens": cache_read_tokens,
            "cache_write_tokens": cache_write_tokens,
            "cache_read_ratio": cache_read_tokens / input_tokens if input_tokens > 0 else None,
            "reasoning_output_ratio": reasoning_tokens / output_tokens if output_tokens > 0 else None,
            "length_finish_count": length_finish_count,
            "converge_turns": converge_turns,
            "cost_usd": cost_micro_usd / 1_000_000,
            "last_event": _bounded_event(events[-1]) if events else None,
            "retry_count": sum(
                "retry" in str(event.get("type", "")).lower()
                or "retry" in str(_event_payload(event).get("status", "")).lower()
                for event in events
            ),
            "model_failure": model_failure,
            "network_mode_requested": self.network_mode,
            "network_mode_effective": self.effective_network_mode,
            "read_scope_effective": self.effective_read_scope,
            "process_handoff_available": self.process_handoff_available,
        }

    def _persist_timeout_artifacts(
        self,
        result: Any | None,
        events: list[dict[str, Any]],
        summary_path: pathlib.Path | None,
        trace_path: pathlib.Path | None,
        error_message: str | None,
        recorder: _OutputRecorder | None = None,
        process_cleanup: dict[str, Any] | None = None,
    ) -> tuple[pathlib.Path, pathlib.Path]:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        stdout = _bounded_utf8_text(_stdout_text(result), MAX_PARTIAL_ARTIFACT_CHARS)
        stderr = _bounded_utf8_text(_stderr_text(result), MAX_PARTIAL_ARTIFACT_CHARS)
        if recorder is not None:
            if not stdout and recorder.stdout_path.is_file():
                stdout = _bounded_utf8_text(recorder.stdout_path.read_text(encoding="utf-8"), MAX_PARTIAL_ARTIFACT_CHARS)
            if not stderr and recorder.stderr_path.is_file():
                stderr = _bounded_utf8_text(recorder.stderr_path.read_text(encoding="utf-8"), MAX_PARTIAL_ARTIFACT_CHARS)
        _write_utf8_artifact(self.logs_dir / "stdout.partial.log", stdout)
        _write_utf8_artifact(self.logs_dir / "stderr.partial.log", stderr)
        live_state = recorder.snapshot() if recorder is not None else {}
        last_event = live_state.get("last_event") or (events[-1] if events else self._last_trace_event(trace_path))
        state = {
            "status": "timeout",
            "timed_out": True,
            "failure_kind": "timeout",
            "message": error_message or "agent execution timed out",
            "network_mode_requested": self.network_mode,
            "network_mode_effective": self.effective_network_mode,
            "read_scope_effective": self.effective_read_scope,
            "process_handoff_available": self.process_handoff_available,
            "last_event": last_event,
            "model_turns": live_state.get("model_turns", sum(event.get("type") == "model.started" for event in events)),
            "tool_calls": live_state.get("tool_calls", sum(event.get("type") in {"tool.requested", "tool.started"} for event in events)),
            "usage": live_state.get("usage", {}),
            "retry_count": live_state.get("retry_count", 0),
            "last_retry": live_state.get("last_retry"),
            "length_finish_count": live_state.get("length_finish_count", 0),
            "converge_turns": live_state.get("converge_turns", 0),
            "stdout": _text_artifact_summary(stdout),
            "stderr": _text_artifact_summary(stderr),
            "process_cleanup": process_cleanup,
            "recorded_at": time.time(),
        }
        (self.logs_dir / "timeout.json").write_text(
            json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

        summary_target = summary_path or (self.logs_dir / "summary.json")
        summary = self._read_summary(summary_target)
        summary.update({
            "schema_version": max(1, _as_int(summary.get("schema_version"), 1)),
            "status": "timeout",
            "failure_kind": "timeout",
            "last_error": error_message or "agent execution timed out",
            "timeout": state,
            "last_event": last_event,
            "model_turns": state["model_turns"],
            "tool_calls": state["tool_calls"],
            "usage": state["usage"],
            "retry_count": state["retry_count"],
            "last_retry": state["last_retry"],
            "length_finish_count": state["length_finish_count"],
            "converge_turns": state["converge_turns"],
            "process_cleanup": process_cleanup,
            "network_mode_requested": self.network_mode,
            "network_mode_effective": self.effective_network_mode,
            "read_scope_effective": self.effective_read_scope,
            "process_handoff_available": self.process_handoff_available,
        })
        summary_target.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        trace_target = trace_path or (self.logs_dir / "trace.jsonl")
        existing = trace_target.read_text(encoding="utf-8") if trace_target.is_file() else ""
        if '"type": "run_timeout"' not in existing:
            _append_bounded_jsonl(trace_target, {
                "type": "run_timeout",
                "occurredAt": time.time(),
                "metadata": {"timeout": state},
                "sigma_event": last_event,
            }, MAX_TRACE_ARTIFACT_BYTES)
        return summary_target, trace_target

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
                        "reasoning_tokens": summary.get("reasoning_tokens", 0),
                        "cache_tokens": summary.get("cache_tokens", 0),
                        "cache_read_tokens": summary.get("cache_read_tokens", 0),
                        "length_finish_count": summary.get("length_finish_count", 0),
                        "converge_turns": summary.get("converge_turns", 0),
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
                *( ["--check-api"] if self.check_api else [] ),
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
        doctor_json = doctor_record["doctor_json"]
        contract_error = self._doctor_contract_error(doctor_json)
        if contract_error is not None:
            doctor_record["doctor_contract_error"] = contract_error
            self._write_setup_checks(checks, "agent_setup_failed")
            raise RuntimeError(
                self._setup_failure_message("strict_doctor_contract", doctor_check, doctor_json, contract_error)
            )
        capabilities = doctor_json["capabilities"]
        modes = capabilities["networkModes"]
        self.available_network_modes = list(modes)
        if self.network_mode not in self.available_network_modes:
            self._write_setup_checks(checks, "agent_setup_failed")
            raise RuntimeError(
                f"agent_setup_failed: requested network_mode={self.network_mode} is not supported by the broker"
            )
        self.effective_network_mode = self.network_mode
        self.process_handoff_available = capabilities["processHandoff"]
        self._write_setup_checks(checks, "passed")

    def _setup_check_record(self, stage: str, result: Any) -> dict[str, Any]:
        return {
            "stage": stage,
            "exit_code": _return_code(result),
            "stdout": _bounded_text(_stdout_text(result)),
            "stderr": _bounded_text(_stderr_text(result)),
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

    def _doctor_contract_error(self, doctor_json: Any) -> str | None:
        if not isinstance(doctor_json, dict):
            return "doctor response is not a JSON object"
        if doctor_json.get("doctorSchemaVersion") != DOCTOR_REPORT_SCHEMA_VERSION:
            return "doctorSchemaVersion is missing or unsupported"
        if doctor_json.get("protocolVersion") != BROKER_PROTOCOL_VERSION:
            return "protocolVersion is missing or unsupported"
        if doctor_json.get("strict") is not True:
            return "doctor strict mode was not confirmed"
        if doctor_json.get("status") != "ok":
            return "doctor status is not ok"
        broker_version = doctor_json.get("brokerVersion")
        if not isinstance(broker_version, str) or not broker_version:
            return "brokerVersion is missing"
        capabilities = doctor_json.get("capabilities")
        if not isinstance(capabilities, dict):
            return "capabilities are missing"
        modes = capabilities.get("networkModes")
        if not isinstance(modes, list) or any(mode not in SUPPORTED_NETWORK_MODES for mode in modes):
            return "capabilities.networkModes are missing or invalid"
        if not isinstance(capabilities.get("processHandoff"), bool):
            return "capabilities.processHandoff is missing or invalid"
        return None

    def _write_setup_checks(self, checks: list[dict[str, Any]], status: str) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": 1,
            "classification": status,
            "network_mode_requested": self.network_mode,
            "network_mode_effective": self.effective_network_mode,
            "available_network_modes": list(self.available_network_modes),
            "read_scope_effective": self.effective_read_scope,
            "process_handoff_available": self.process_handoff_available,
            "checks": checks,
        }
        (self.logs_dir / "setup-check.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _setup_failure_message(
        self,
        stage: str,
        result: Any,
        doctor_json: Any = None,
        reason: str | None = None,
    ) -> str:
        details = [
            f"agent_setup_failed: stage={stage} exit_code={_return_code(result)}",
            f"stdout:\n{_stdout_text(result) or '<empty>'}",
            f"stderr:\n{_stderr_text(result) or '<empty>'}",
        ]
        if reason is not None:
            details.append(f"reason: {reason}")
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

    def _last_trace_event(self, trace_path: pathlib.Path | None) -> dict[str, Any] | None:
        if trace_path is None or not trace_path.is_file():
            return None
        try:
            lines = trace_path.read_text(encoding="utf-8")[-65_536:].splitlines()
        except OSError:
            return None
        for line in reversed(lines):
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict):
                continue
            event = value.get("sigma_event")
            return event if isinstance(event, dict) else value
        return None

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
        if error_message:
            error_message = _bounded_text(error_message)

        values = {
            "exit_code": exit_code,
            "error_message": error_message,
            "agent_stdout": _bounded_text(_stdout_text(result)),
            "agent_stderr": _bounded_text(_stderr_text(result)),
            "agent_stdout_summary": _text_artifact_summary(_stdout_text(result)),
            "agent_stderr_summary": _text_artifact_summary(_stderr_text(result)),
            "commands_executed": _json_number(summary, "commands_executed"),
            "tool_calls": _json_number(summary, "tool_calls"),
            "model_turns": _json_number(summary, "model_turns"),
            "n_tool_calls": _json_number(summary, "tool_calls"),
            "n_model_turns": _json_number(summary, "model_turns"),
            "n_input_tokens": _json_number(summary, "input_tokens"),
            "n_output_tokens": _json_number(summary, "output_tokens"),
            "n_reasoning_tokens": _json_number(summary, "reasoning_tokens"),
            "n_cache_tokens": _json_number(summary, "cache_tokens"),
            "n_cache_read_tokens": _json_number(summary, "cache_read_tokens"),
            "length_finish_count": _json_number(summary, "length_finish_count"),
            "converge_turns": _json_number(summary, "converge_turns"),
            "cost_usd": summary.get("cost_usd"),
            "network_mode_requested": summary.get("network_mode_requested", self.network_mode),
            "network_mode_effective": summary.get("network_mode_effective", self.effective_network_mode),
            "read_scope_effective": summary.get("read_scope_effective", self.effective_read_scope),
            "process_handoff_available": summary.get("process_handoff_available", self.process_handoff_available),
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

        output = _bounded_text(_output_text(result).strip()) if result is not None else ""
        if output:
            (task_dir / "agent.log").write_text(f"{output}\n", encoding="utf-8")

        metadata = {
            "task_id": task_id,
            "source_logs_dir": str(self.logs_dir),
            "agent_setup_ok": True,
            "exit_code": getattr(context, "exit_code", None),
            "error_message": getattr(context, "error_message", None),
            "failure_kind": getattr(context, "failure_kind", None),
            "network_mode_requested": getattr(context, "network_mode_requested", self.network_mode),
            "network_mode_effective": getattr(context, "network_mode_effective", self.effective_network_mode),
            "read_scope_effective": getattr(context, "read_scope_effective", self.effective_read_scope),
            "process_handoff_available": getattr(context, "process_handoff_available", self.process_handoff_available),
            "artifact_warnings": getattr(context, "artifact_warnings", []),
            "commands_executed": getattr(context, "commands_executed", 0),
            "tool_calls": getattr(context, "tool_calls", 0),
            "model_turns": getattr(context, "model_turns", 0),
            "n_input_tokens": getattr(context, "n_input_tokens", 0),
            "n_output_tokens": getattr(context, "n_output_tokens", 0),
            "n_reasoning_tokens": getattr(context, "n_reasoning_tokens", 0),
            "n_cache_tokens": getattr(context, "n_cache_tokens", 0),
            "n_cache_read_tokens": getattr(context, "n_cache_read_tokens", 0),
            "length_finish_count": getattr(context, "length_finish_count", 0),
            "converge_turns": getattr(context, "converge_turns", 0),
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
        failure_kind = summary.get("failure_kind")
        if isinstance(failure_kind, str) and failure_kind in FAILURE_KINDS:
            add(failure_kind)
        if isinstance(summary.get("timeout"), dict):
            add("partial_trace_saved")
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
