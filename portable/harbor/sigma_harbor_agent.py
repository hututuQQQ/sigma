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
from collections import deque
from collections.abc import Iterator
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
SUCCESS_STATUSES = {"completed", "completed_with_limitations"}
FAILURE_KINDS = {
    "needs_input", "timeout", "tool_error", "api_error", "agent_failure", "verifier_failure",
    "validation_blocked", "convergence_no_progress", "runtime_invariant_failure",
    "external_cancel",
}
DOCTOR_REPORT_SCHEMA_VERSION = 1
BROKER_PROTOCOL_VERSION = 1
SUPPORTED_NETWORK_MODES = {"none", "loopback", "full"}
CONTROL_SERVICE = "sigma-control"
CONTROL_PACKAGE_PATH = "/opt/sigma-package/agent-cli.tgz"
CONTROL_RUNTIME_ROOT = "/opt/sigma-control/agent-cli"
CONTROL_AGENT_PATH = f"{CONTROL_RUNTIME_ROOT}/bin/agent"
CONTROL_ATTESTATION_PATH = "/run/sigma-oci/attestation.json"
SANDBOX_AGENT_PATH = "/usr/local/bin/agent"
SHARED_HELPER_ROOT = "/opt/sigma-helper"
WORKSPACE_PATH = "/app"
MAX_CONTEXT_TEXT_CHARS = 8_192
MAX_PARTIAL_ARTIFACT_CHARS = 1_048_576
MAX_TRACE_ARTIFACT_BYTES = 4 * 1_048_576
MAX_RECORDER_EVENT_BYTES = 512 * 1_024
MAX_RECORDER_EVENT_COUNT = 512
MAX_SEEN_EVENT_IDENTITIES = 2_048
MAX_STREAM_CHUNK_STATES = 4
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


class _BoundedJsonlSpool:
    """Persist a bounded JSONL head plus a rolling tail while the run is live.

    Ordinary records are appended directly. Once the tail reaches its high
    water mark, the oldest tail records are discarded down to a low water mark
    and the bounded head/marker/tail view is atomically materialized. This
    keeps recent convergence evidence visible even if the process is killed
    before finalization, without rewriting the growing artifact per event.
    """

    def __init__(self, path: pathlib.Path, maximum: int) -> None:
        if maximum <= 0:
            raise ValueError("maximum must be positive")
        self.path = path
        self.maximum = maximum
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(b"")
        self._marker_reserve = min(maximum, 512, max(96, maximum // 8))
        usable = max(0, maximum - self._marker_reserve)
        self._head_limit = usable // 2
        self._tail_limit = usable - self._head_limit
        self._tail_low_water = self._tail_limit // 2
        self._head = bytearray()
        self._head_size = 0
        self._head_closed = False
        self._tail: deque[bytes] = deque()
        self._tail_size = 0
        self._omitted_records = 0
        self._omitted_bytes = 0
        self._omitted_digest = hashlib.sha256()
        self._finalized = False

    @property
    def retained_bytes(self) -> int:
        return self._head_size + self._tail_size

    @property
    def omitted_records(self) -> int:
        return self._omitted_records

    def append(self, record: dict[str, Any]) -> None:
        if self._finalized:
            raise RuntimeError("cannot append to a finalized JSONL spool")
        line = self._encoded_record(record)
        if not self._head_closed and self._head_size + len(line) <= self._head_limit:
            with self.path.open("ab") as handle:
                handle.write(line)
            self._head.extend(line)
            self._head_size += len(line)
            return
        self._head_closed = True
        if len(line) > self._tail_limit:
            self._omit(line)
            self._materialize()
            return
        if self._tail_size + len(line) > self._tail_limit:
            while self._tail and self._tail_size + len(line) > self._tail_low_water:
                removed = self._tail.popleft()
                self._tail_size -= len(removed)
                self._omit(removed)
            self._tail.append(line)
            self._tail_size += len(line)
            self._materialize()
            return
        self._tail.append(line)
        self._tail_size += len(line)
        with self.path.open("ab") as handle:
            handle.write(line)

    def finalize(self) -> pathlib.Path:
        if self._finalized:
            return self.path
        self._materialize()
        self._finalized = True
        return self.path

    def _materialize(self) -> None:
        marker = self._omission_marker()
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("wb") as target:
                target.write(self._head)
                if marker:
                    target.write(marker)
                for line in self._tail:
                    target.write(line)
            if temporary.stat().st_size > self.maximum:
                raise RuntimeError("bounded JSONL spool exceeded its artifact limit")
            temporary.replace(self.path)
        finally:
            if temporary.exists():
                temporary.unlink()

    def _encoded_record(self, record: dict[str, Any]) -> bytes:
        line = (
            json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8")
        if len(line) <= self.maximum:
            return line
        digest = hashlib.sha256(line).hexdigest()
        replacement = {
            "type": "trace_record_omitted",
            "original_type": record.get("type"),
            "original_bytes": len(line),
            "original_sha256": digest,
        }
        return (
            json.dumps(replacement, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8")

    def _omit(self, line: bytes) -> None:
        self._omitted_records += 1
        self._omitted_bytes += len(line)
        self._omitted_digest.update(line)

    def _omission_marker(self) -> bytes:
        if self._omitted_records == 0:
            return b""
        candidates = (
            {
                "type": "trace_truncated",
                "omitted_records": self._omitted_records,
                "omitted_bytes": self._omitted_bytes,
                "omitted_bytes_sha256": self._omitted_digest.hexdigest(),
            },
            {
                "type": "trace_truncated",
                "omitted_records": self._omitted_records,
                "omitted_bytes": self._omitted_bytes,
            },
            {"type": "trace_truncated", "omitted_records": self._omitted_records},
            {"type": "trace_truncated"},
        )
        for candidate in candidates:
            marker = (
                json.dumps(candidate, ensure_ascii=False, separators=(",", ":")) + "\n"
            ).encode("utf-8")
            if len(marker) <= self._marker_reserve:
                return marker
        return b""


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


def _positive_int(value: Any, name: str) -> int:
    parsed = _as_int(value, 0)
    if parsed <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return parsed


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
    raw = json.dumps(event, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return ("raw-sha256", hashlib.sha256(raw).hexdigest())


def _bounded_event(event: dict[str, Any], maximum: int = 32_768) -> dict[str, Any]:
    raw = json.dumps(event, ensure_ascii=False, sort_keys=True)
    if len(raw.encode("utf-8")) <= maximum:
        return event
    return {
        "type": event.get("type"),
        "eventId": event.get("eventId"),
        "sessionId": event.get("sessionId"),
        "seq": event.get("seq"),
        "payload_summary": _text_artifact_summary(raw),
        "truncated": True,
    }


def _selected_scalars(payload: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {
        key: payload[key]
        for key in keys
        if key in payload and (
            payload[key] is None
            or isinstance(payload[key], (str, int, float, bool))
        )
    }


def _trace_record(
    event: dict[str, Any],
    summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build one trace record without duplicating the raw Sigma payload."""
    event_type = str(event.get("type") or "event")
    payload = _event_payload(event)
    trace_type = event_type
    metadata: dict[str, Any] = {"event_type": event_type}
    if event_type == "usage.recorded":
        trace_type = "usage"
        metadata.update(_selected_scalars(payload, (
            "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens",
            "cacheWriteTokens", "costMicroUsd", "latencyMs", "attempt",
            "cacheTokens", "costUsd",
        )))
        metadata.setdefault(
            "cacheTokens",
            _as_int(payload.get("cacheReadTokens"), 0)
            + _as_int(payload.get("cacheWriteTokens"), 0),
        )
        metadata.setdefault(
            "costUsd", _as_int(payload.get("costMicroUsd"), 0) / 1_000_000
        )
    elif event_type == "tool.started":
        trace_type = "tool_start"
        metadata.update(_selected_scalars(payload, (
            "callId", "toolCallId", "toolName", "name", "executionId", "status",
        )))
        tool_name = payload.get("toolName") or payload.get("name")
        if isinstance(tool_name, (str, int, float, bool)) or tool_name is None:
            metadata["toolName"] = tool_name
    elif event_type in {"tool.completed", "tool.failed"}:
        trace_type = "tool_end"
        metadata.update(_selected_scalars(payload, (
            "callId", "toolCallId", "toolName", "name", "executionId", "status",
            "durationMs", "exitCode", "code",
        )))
        tool_name = payload.get("toolName") or payload.get("name")
        if isinstance(tool_name, (str, int, float, bool)) or tool_name is None:
            metadata["toolName"] = tool_name
    elif event_type == "model.started":
        trace_type = "model_start"
        metadata.update(_selected_scalars(payload, (
            "requestId", "turnId", "role", "routeId", "modelId", "attempt",
        )))
    elif event_type in {"model.completed", "model.failed"}:
        trace_type = "model_end"
        metadata.update(_selected_scalars(payload, (
            "requestId", "turnId", "role", "routeId", "modelId", "attempt",
            "finishReason", "status", "code", "latencyMs",
        )))
    elif event_type == "diagnostic":
        metadata.update(_selected_scalars(payload, (
            "kind", "stage", "budgetStage", "remainingMs", "nextModelEstimateMs",
            "nextConvergenceModelEstimateMs", "outputReserveTokens", "code", "message",
        )))
    elif event_type in TERMINAL_EVENT_TYPES:
        trace_type = "run_end"
        metadata.update(_selected_scalars(payload, (
            "status", "finishReason", "failureKind", "message", "finalMessage",
            "terminationSource", "terminalOrigin",
        )))
        if summary is not None:
            metadata.update(_selected_scalars(summary, (
                "status", "finish_reason", "commands_executed", "input_tokens",
                "output_tokens", "reasoning_tokens", "cache_tokens", "cache_read_tokens",
                "length_finish_count", "converge_turns", "deadline_converge_turns",
                "budget_converge_turns", "terminal_budget_turns", "manual_stop_count",
                "cost_usd", "duration_ms", "suspension_to_exit_ms", "terminal_origin",
                "termination_source", "execution_mode", "execution_backend", "container_engine",
                "container_target", "target_image_id", "task_image_digest", "agent_profile",
                "harbor_deadline_sec", "sigma_deadline_sec", "limitation_count",
            )))
    elif event_type in {"error", "run_timeout"}:
        metadata.update(_selected_scalars(payload, (
            "status", "code", "message", "failure_kind", "termination_source",
        )))
    metadata = {
        key: value for key, value in metadata.items()
        if value is None or isinstance(value, (str, int, float, bool))
    }
    return {
        "type": trace_type,
        "seq": event.get("seq"),
        "occurredAt": event.get("occurredAt"),
        "metadata": metadata,
        "sigma_event": _bounded_event(event),
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
    if record_id not in chunks and len(chunks) >= MAX_STREAM_CHUNK_STATES:
        chunks.pop(next(iter(chunks)))
    state = chunks.setdefault(record_id, {"total": total, "parts": {}, "encoded_bytes": 0})
    if state["total"] != total:
        chunks.pop(record_id, None)
        return []
    previous = state["parts"].get(index)
    previous_size = len(previous) if isinstance(previous, str) else 0
    encoded_bytes = _as_int(state.get("encoded_bytes"), 0) - previous_size + len(data)
    if encoded_bytes > MAX_STREAM_RECORD_BYTES * 2:
        chunks.pop(record_id, None)
        raise ValueError("chunked stream record exceeds the adapter size limit")
    state["parts"][index] = data
    state["encoded_bytes"] = encoded_bytes
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


def _bounded_protocol_event(event: dict[str, Any]) -> dict[str, Any]:
    """Retain protocol fields while dropping large diagnostic payloads."""
    bounded = _bounded_event(event, 128 * 1_024)
    if not bounded.get("truncated"):
        return bounded
    payload = _event_payload(event)
    essential = _selected_scalars(payload, (
        "kind", "status", "finishReason", "failureKind", "failure_kind", "code",
        "message", "finalMessage", "terminationSource", "terminalOrigin", "checkpointId",
    ))
    for key in ("message", "finalMessage"):
        value = essential.get(key)
        if isinstance(value, str):
            essential[key] = _bounded_text(value, 4_096)
    limitations = payload.get("limitations")
    if isinstance(limitations, list):
        encoded = json.dumps(limitations, ensure_ascii=False).encode("utf-8")
        if len(encoded) <= 16_384:
            essential["limitations"] = limitations
    return {
        key: value for key, value in event.items()
        if key in {"type", "eventId", "sessionId", "runId", "seq", "occurredAt"}
    } | {"payload": essential, "truncated": True}


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
        self._seen_order: deque[tuple[str, ...]] = deque()
        self._highest_seq: dict[str, int] = {}
        self.events: list[dict[str, Any]] = []
        self._event_sizes: deque[int] = deque()
        self._event_bytes = 0
        self.total_events = 0
        self.output_result: dict[str, Any] = {}
        self.last_event: dict[str, Any] | None = None
        self.session_id: str | None = None
        self.model_turns = 0
        self.tool_calls = 0
        self.commands_executed = 0
        self.usage: dict[str, Any] = {}
        self.input_tokens = 0
        self.output_tokens = 0
        self.reasoning_tokens = 0
        self.cache_read_tokens = 0
        self.cache_write_tokens = 0
        self.cost_micro_usd = 0
        self.retry_count = 0
        self.last_retry: dict[str, Any] | None = None
        self.model_failure: dict[str, Any] | None = None
        self.length_finish_count = 0
        self.converge_turns = 0
        self.deadline_converge_turns = 0
        self.budget_converge_turns = 0
        self.terminal_budget_turns = 0
        self._started_monotonic = time.monotonic()
        self._suspended_monotonic: float | None = None
        self._process_exit_monotonic: float | None = None
        logs_dir.mkdir(parents=True, exist_ok=True)
        for path in (self.stdout_path, self.stderr_path):
            path.write_text("", encoding="utf-8")
        self._trace_spool = _BoundedJsonlSpool(
            self.trace_path, MAX_TRACE_ARTIFACT_BYTES
        )
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

    def finish_stream(self) -> None:
        if self._pending_stdout:
            pending = self._pending_stdout
            self._pending_stdout = ""
            self._consume_line(pending)

    def consume_event(self, event: dict[str, Any]) -> None:
        self._consume_value({"kind": "event", "event": event})

    def finalize_trace(self) -> pathlib.Path:
        return self._trace_spool.finalize()

    def _remember_identity(
        self, event: dict[str, Any], identity: tuple[str, ...]
    ) -> bool:
        session_id = event.get("sessionId")
        seq = event.get("seq")
        if isinstance(session_id, str) and isinstance(seq, int):
            highest = self._highest_seq.get(session_id)
            if highest is not None and seq <= highest:
                return False
            self._highest_seq[session_id] = seq
            while len(self._highest_seq) > 64:
                self._highest_seq.pop(next(iter(self._highest_seq)))
        if identity in self._seen:
            return False
        self._seen.add(identity)
        self._seen_order.append(identity)
        while len(self._seen_order) > MAX_SEEN_EVENT_IDENTITIES:
            self._seen.discard(self._seen_order.popleft())
        return True

    def _remember_event(self, event: dict[str, Any]) -> None:
        bounded = _bounded_protocol_event(event)
        size = len(json.dumps(bounded, ensure_ascii=False).encode("utf-8"))
        self.events.append(bounded)
        self._event_sizes.append(size)
        self._event_bytes += size
        while (
            len(self.events) > MAX_RECORDER_EVENT_COUNT
            or self._event_bytes > MAX_RECORDER_EVENT_BYTES
        ) and self.events:
            self.events.pop(0)
            self._event_bytes -= self._event_sizes.popleft()

    def _consume_value(self, value: dict[str, Any]) -> None:
        if value.get("kind") == "event" and isinstance(value.get("event"), dict):
            event = value["event"]
        elif isinstance(value.get("type"), str) and value.get("payload") is not None:
            event = value
        else:
            event = None
        if isinstance(event, dict) and isinstance(event.get("type"), str):
            identity = _event_identity(event)
            if not self._remember_identity(event, identity):
                return
            self.total_events += 1
            self._remember_event(event)
            self.last_event = _bounded_protocol_event(event)
            session_id = event.get("sessionId")
            if isinstance(session_id, str) and session_id:
                self.session_id = session_id
            event_type = str(event.get("type"))
            if event_type == "model.started":
                self.model_turns += 1
            if event_type == "tool.requested":
                self.tool_calls += 1
            if event_type in {"tool.completed", "tool.failed"}:
                self.commands_executed += 1
            if event_type == "run.suspended" and self._suspended_monotonic is None:
                self._suspended_monotonic = time.monotonic()
            payload = _event_payload(event)
            if event_type == "model.completed" and payload.get("finishReason") == "length":
                self.length_finish_count += 1
            if event_type == "diagnostic" and payload.get("kind") == "deadline.stage":
                deadline_converge = payload.get("stage") == "converge"
                budget_converge = payload.get("budgetStage") == "converge"
                terminal_budget = payload.get("budgetStage") == "terminal"
                self.deadline_converge_turns += int(deadline_converge)
                self.budget_converge_turns += int(budget_converge)
                self.terminal_budget_turns += int(terminal_budget)
                self.converge_turns += int(deadline_converge or budget_converge)
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
                self.input_tokens += _as_int(payload.get("inputTokens"), 0)
                self.output_tokens += _as_int(payload.get("outputTokens"), 0)
                self.reasoning_tokens += _as_int(payload.get("reasoningTokens"), 0)
                self.cache_read_tokens += _as_int(payload.get("cacheReadTokens"), 0)
                self.cache_write_tokens += _as_int(payload.get("cacheWriteTokens"), 0)
                self.cost_micro_usd += _as_int(payload.get("costMicroUsd"), 0)
            if event_type == "model.failed":
                diagnostics = payload.get("diagnostics")
                self.model_failure = {
                    "code": payload.get("code"),
                    "diagnostics": diagnostics if isinstance(diagnostics, dict) else {},
                }
            if "retry" in event_type.lower() or "retry" in str(payload.get("status", "")).lower():
                self.retry_count += 1
                self.last_retry = _bounded_event(event)
            self._trace_spool.append(_trace_record(event))
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
            "session_id": self.session_id,
            "events_retained": len(self.events),
            "events_retained_bytes": self._event_bytes,
            "events_observed": self.total_events,
            "model_turns": self.model_turns,
            "tool_calls": self.tool_calls,
            "commands_executed": self.commands_executed,
            "usage": dict(self.usage),
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "cache_tokens": self.cache_read_tokens + self.cache_write_tokens,
            "cost_micro_usd": self.cost_micro_usd,
            "retry_count": self.retry_count,
            "last_retry": self.last_retry,
            "model_failure": self.model_failure,
            "length_finish_count": self.length_finish_count,
            "converge_turns": self.converge_turns,
            "deadline_converge_turns": self.deadline_converge_turns,
            "budget_converge_turns": self.budget_converge_turns,
            "terminal_budget_turns": self.terminal_budget_turns,
            **self.timing_snapshot(),
        }

    def mark_process_exit(self) -> None:
        self._process_exit_monotonic = time.monotonic()

    def timing_snapshot(self) -> dict[str, Any]:
        ended = self._process_exit_monotonic or time.monotonic()
        return {
            "duration_ms": max(1, round((ended - self._started_monotonic) * 1000)),
            "suspension_to_exit_ms": (
                max(0, round((ended - self._suspended_monotonic) * 1000))
                if self._suspended_monotonic is not None and self._process_exit_monotonic is not None
                else None
            ),
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
        agent_profile: str = "standard",
        network_mode: str = "full",
        execution_mode: str = "sandboxed",
        managed_provenance: bool = False,
        container_engine: str = "docker",
        max_turns: int = 256,
        command_timeout_sec: int = 600,
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
        if agent_profile not in {"standard", "strict"}:
            raise ValueError("agent_profile must be one of: standard, strict")
        self.agent_profile = agent_profile
        if network_mode not in {"none", "loopback", "full"}:
            raise ValueError("network_mode must be one of: none, loopback, full")
        self.network_mode = network_mode
        if execution_mode not in {"sandboxed", "container"}:
            raise ValueError(
                "execution_mode must be one of: sandboxed, container"
            )
        self.execution_mode = execution_mode
        if not isinstance(managed_provenance, bool):
            raise ValueError("managed_provenance must be a boolean")
        self.managed_provenance = managed_provenance
        if container_engine not in {"docker", "podman"}:
            raise ValueError("container_engine must be one of: docker, podman")
        self.container_engine = container_engine
        self.max_turns = _positive_int(max_turns, "max_turns")
        self.command_timeout_sec = _positive_int(
            command_timeout_sec, "command_timeout_sec"
        )
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
                self.outer_trial_deadline_sec,
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
        self.execution_backend: str | None = None
        self.container_metadata: dict[str, Any] = {}

    @staticmethod
    def name() -> str:
        return "sigma-agent-cli"

    def version(self) -> str | None:
        return "0.1.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        if self.execution_mode == "container":
            await self._setup_container_runtime(environment)
            return

        self._workspace = await self._resolve_workspace(environment)
        identity_check = await self._observe_managed_target_identity(environment)
        initial_checks = [identity_check] if identity_check is not None else []
        await environment.exec("mkdir -p /tmp/agent", timeout_sec=30)
        installed = await environment.exec("command -v /usr/local/bin/agent >/dev/null 2>&1", timeout_sec=30)
        if _return_code(installed) == 0:
            await self._verify_agent_ready(environment, initial_checks)
            return

        tarball = self.agent_cli_tarball or self._tarball_from_env()
        if tarball is not None:
            await self._install_tarball(environment, tarball)
            await self._verify_agent_ready(environment, initial_checks)
            return

        message = (
            "agent_setup_failed: agent CLI is not installed in the task container. Pass "
            "agent_cli_tarball in the Harbor JobConfig, set AGENT_CLI_TARBALL, or bake "
            "/usr/local/bin/agent into the Harbor task image."
        )
        self._write_setup_checks([], "agent_setup_failed")
        raise RuntimeError(message)

    async def _observe_managed_target_identity(self, environment: BaseEnvironment) -> dict[str, Any] | None:
        """Collect launcher-requested provenance without changing sandboxed execution."""
        if not self.managed_provenance:
            return None
        service_exec = getattr(environment, "service_exec", None)
        if not callable(service_exec):
            self._write_setup_checks([], "agent_setup_failed")
            raise RuntimeError(
                "agent_setup_failed: managed provenance requires Harbor compose service_exec"
            )
        try:
            result = await service_exec(
                f"cat {CONTROL_ATTESTATION_PATH}", service=CONTROL_SERVICE, timeout_sec=30
            )
        except Exception as error:
            check = {
                "stage": "managed_target_identity",
                "exit_code": None,
                "stdout": "",
                "stderr": _bounded_text(str(error)),
                "status": "failed",
                "reason": "control service could not provide managed attestation",
            }
            self._write_setup_checks([check], "agent_setup_failed")
            raise RuntimeError(
                "agent_setup_failed: managed provenance control service is unavailable"
            ) from error
        check = self._setup_check_record("managed_target_identity", result)
        if _return_code(result) != 0:
            check.update({
                "status": "failed",
                "reason": "control service could not provide managed attestation",
            })
            self._write_setup_checks([check], "agent_setup_failed")
            raise RuntimeError(self._setup_failure_message("managed_target_identity", result))
        try:
            attestation = json.loads(_stdout_text(result))
        except json.JSONDecodeError:
            check.update({"status": "failed", "reason": "attestation is not valid JSON"})
            self._write_setup_checks([check], "agent_setup_failed")
            raise RuntimeError(self._setup_failure_message(
                "managed_target_identity", result, reason=check["reason"]
            ))
        required = (
            "selector", "targetId", "targetStartedAt", "imageId", "labelsDigest",
            "helperDigest", "attestationDigest",
        )
        valid = isinstance(attestation, dict) and attestation.get("protocolVersion") == 1 \
            and attestation.get("engine") == self.container_engine \
            and all(isinstance(attestation.get(field), str) and attestation[field] for field in required)
        if not valid:
            check.update({"status": "failed", "reason": "attestation identity fields are invalid"})
            self._write_setup_checks([check], "agent_setup_failed")
            raise RuntimeError(self._setup_failure_message(
                "managed_target_identity", result, reason=check["reason"]
            ))
        self.container_metadata = {
            "available": True,
            "backend": "oci",
            "target": "managed",
            **{key: value for key, value in attestation.items() if key != "workspace"},
        }
        return check

    @property
    def _agent_path(self) -> str:
        return CONTROL_AGENT_PATH if self.execution_mode == "container" else SANDBOX_AGENT_PATH

    async def _runtime_exec(
        self,
        environment: BaseEnvironment,
        command: str,
        **kwargs: Any,
    ) -> Any:
        if self.execution_mode != "container":
            return await environment.exec(command, **kwargs)
        service_exec = getattr(environment, "service_exec", None)
        if not callable(service_exec):
            raise RuntimeError(
                "agent_setup_failed: container mode requires Harbor compose service_exec; "
                "execution in main or on the host is not an allowed fallback"
            )
        return await service_exec(command, service=CONTROL_SERVICE, **kwargs)

    async def _runtime_download_file(
        self,
        environment: BaseEnvironment,
        remote_path: str,
        target_path: pathlib.Path,
    ) -> None:
        if self.execution_mode != "container":
            await environment.download_file(remote_path, target_path)
            return
        service_download = getattr(environment, "service_download_file", None)
        if not callable(service_download):
            raise RuntimeError(
                "agent_setup_failed: container mode requires Harbor compose service_download_file; "
                "artifact collection from main or the host is not an allowed fallback"
            )
        await service_download(remote_path, target_path, service=CONTROL_SERVICE)

    async def _setup_container_runtime(self, environment: BaseEnvironment) -> None:
        if not callable(getattr(environment, "service_exec", None)):
            self._write_setup_checks([], "agent_setup_failed")
            raise RuntimeError(
                "agent_setup_failed: container mode requires Harbor compose service_exec; "
                "execution in main or on the host is not an allowed fallback"
            )
        if not callable(getattr(environment, "service_download_file", None)):
            self._write_setup_checks([], "agent_setup_failed")
            raise RuntimeError(
                "agent_setup_failed: container mode requires Harbor compose service_download_file; "
                "artifact collection from main or the host is not an allowed fallback"
            )

        checks: list[dict[str, Any]] = []
        package_check = await self._runtime_exec(
            environment,
            f"""
set -eu
umask 022
test -r {CONTROL_PACKAGE_PATH}
rm -rf {CONTROL_RUNTIME_ROOT}.next
mkdir -p {CONTROL_RUNTIME_ROOT}.next
tar --no-same-owner --no-same-permissions -xzf {CONTROL_PACKAGE_PATH} -C {CONTROL_RUNTIME_ROOT}.next --strip-components=1
test -x {CONTROL_RUNTIME_ROOT}.next/bin/agent
test -x {CONTROL_RUNTIME_ROOT}.next/bin/node
test -x {CONTROL_RUNTIME_ROOT}.next/bin/sigma-exec
test -x {CONTROL_RUNTIME_ROOT}.next/bin/bwrap
test -d {CONTROL_RUNTIME_ROOT}.next/lib
rm -rf {CONTROL_RUNTIME_ROOT}
mv {CONTROL_RUNTIME_ROOT}.next {CONTROL_RUNTIME_ROOT}
chmod 0755 {CONTROL_RUNTIME_ROOT}/bin/agent {CONTROL_RUNTIME_ROOT}/bin/node
test -x {SHARED_HELPER_ROOT}/bin/sigma-exec
test -x {SHARED_HELPER_ROOT}/bin/bwrap
test ! -e {SHARED_HELPER_ROOT}/agent
test ! -e {SHARED_HELPER_ROOT}/node
test ! -e {SHARED_HELPER_ROOT}/node_modules
test "$(stat -c '%u:%g:%a' {SHARED_HELPER_ROOT}/bin/sigma-exec)" = "0:0:555"
test "$(stat -c '%u:%g:%a' {SHARED_HELPER_ROOT}/bin/bwrap)" = "0:0:555"
# Keep the redirection inside a child shell. In dash, a redirection failure on
# the special builtin ':' exits the current non-interactive shell even when it
# appears as an if condition; the subshell turns that failure into an ordinary
# false condition for the parent running with `set -e`.
if ( : > {SHARED_HELPER_ROOT}/.sigma-control-write-probe ) 2>/dev/null; then
  rm -f {SHARED_HELPER_ROOT}/.sigma-control-write-probe
  echo "control unexpectedly has write access to the trusted helper" >&2
  exit 1
fi
""".strip(),
            timeout_sec=180,
        )
        checks.append(self._setup_check_record("control_package", package_check))
        if _return_code(package_check) != 0:
            self._write_setup_checks(checks, "agent_setup_failed")
            raise RuntimeError(self._setup_failure_message("control_package", package_check))

        # This is the only container-mode setup executed directly in Harbor's
        # main service. The broker has already published the read-only helper;
        # main only links bwrap and returns the shared workspace identity.
        main_check = await environment.exec(
            f"""
set -eu
test "$(pwd -P)" = {WORKSPACE_PATH}
test -d {WORKSPACE_PATH} && test -r {WORKSPACE_PATH} && test -x {WORKSPACE_PATH}
test -x {SHARED_HELPER_ROOT}/bin/sigma-exec
test -x {SHARED_HELPER_ROOT}/bin/bwrap
test "$(stat -c '%u:%g:%a' {SHARED_HELPER_ROOT}/bin/sigma-exec)" = "0:0:555"
test "$(stat -c '%u:%g:%a' {SHARED_HELPER_ROOT}/bin/bwrap)" = "0:0:555"
mkdir -p /usr/local/bin
ln -sfn {SHARED_HELPER_ROOT}/bin/bwrap /usr/local/bin/bwrap
test "$(readlink /usr/local/bin/bwrap)" = {SHARED_HELPER_ROOT}/bin/bwrap
stat -c '%d:%i' {WORKSPACE_PATH}
""".strip(),
            timeout_sec=60,
        )
        checks.append(self._setup_check_record("main_boundary", main_check))
        if _return_code(main_check) != 0:
            self._write_setup_checks(checks, "agent_setup_failed")
            raise RuntimeError(self._setup_failure_message("main_boundary", main_check))

        control_workspace = await self._runtime_exec(
            environment,
            f"""
set -eu
test "$(pwd -P)" = {WORKSPACE_PATH}
test -d {WORKSPACE_PATH} && test -r {WORKSPACE_PATH} && test -x {WORKSPACE_PATH}
i=0
while test ! -S /run/sigma-oci/broker.sock || test ! -f /run/sigma-oci/attestation.json; do
  i=$((i + 1))
  test "$i" -le 30
  sleep 1
done
stat -c '%d:%i' {WORKSPACE_PATH}
""".strip(),
            timeout_sec=45,
        )
        checks.append(self._setup_check_record("control_workspace", control_workspace))
        if _return_code(control_workspace) != 0:
            self._write_setup_checks(checks, "agent_setup_failed")
            raise RuntimeError(self._setup_failure_message("control_workspace", control_workspace))
        main_identity = _stdout_text(main_check).strip().splitlines()[-1:]
        control_identity = _stdout_text(control_workspace).strip().splitlines()[-1:]
        if not main_identity or main_identity != control_identity:
            checks[-1]["workspace_identity_error"] = {
                "main": main_identity[0] if main_identity else None,
                "control": control_identity[0] if control_identity else None,
            }
            self._write_setup_checks(checks, "agent_setup_failed")
            raise RuntimeError(
                "agent_setup_failed: sigma-control and main do not share the same /app workspace mount"
            )

        self._workspace = WORKSPACE_PATH
        await self._verify_agent_ready(environment, checks)

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
        cancellation_source: str | None = None
        artifact_warnings: list[str] = []
        events: list[dict[str, Any]] = []
        output_result: dict[str, Any] = {}
        summary_path: pathlib.Path | None = None
        trace_path: pathlib.Path | None = None
        protocol_failure: dict[str, Any] | None = None
        try:
            await self._runtime_exec(environment, "mkdir -p /tmp/agent", timeout_sec=30)
            await self._upload_instruction(environment, instruction)
            result = await self._run_agent_once(environment, env_vars, context, recorder)
            events, output_result = self._merge_recorded_output(result, recorder)
            session_id = self._session_id(events, output_result)
            if session_id:
                recovery = await self._recover_external_checkpoint(
                    environment, session_id, events, env_vars
                )
                events = recovery[0]
                for recovered_event in events:
                    recorder.consume_event(recovered_event)
                events = list(recorder.events)
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
                output_result.get("status") not in {None, *SUCCESS_STATUSES} or _return_code(result) != 0
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
            events, output_result = self._merge_recorded_output(result, recorder)
            recorded_terminal = self._recorded_terminal_result(events, output_result)
            self._process_cleanup = await self._cleanup_remote_process(environment)
            if self._process_cleanup.get("error"):
                artifact_warnings.append(str(self._process_cleanup["error"]))
            if recorded_terminal is not None:
                output_result = recorded_terminal
                result = self._result_with_payload(result, recorded_terminal)
                status = recorded_terminal.get("status")
                if status == "needs_input":
                    failure_kind = "needs_input"
                    error_message = str(
                        recorded_terminal.get("finalMessage")
                        or recorded_terminal.get("message")
                        or "agent requires external input"
                    )
                elif status not in SUCCESS_STATUSES:
                    reported_failure = (
                        recorded_terminal.get("failureKind")
                        or recorded_terminal.get("failure_kind")
                    )
                    failure_kind = (
                        reported_failure
                        if reported_failure in FAILURE_KINDS
                        else "agent_failure"
                    )
                    error_message = str(
                        recorded_terminal.get("finalMessage")
                        or recorded_terminal.get("message")
                        or f"agent returned terminal status {status}"
                    )
            else:
                cancelled_error = exc
                cancellation_source = "external_cancel"
                failure_kind = "external_cancel"
                error_message = (
                    "agent execution was cancelled by an external controller; "
                    "no adapter deadline origin was established"
                )
                summary_path, trace_path = self._persist_timeout_artifacts(
                    result,
                    events,
                    None,
                    recorder.trace_path,
                    error_message,
                    recorder=recorder,
                    process_cleanup=self._process_cleanup,
                    status="cancelled",
                    failure_kind="external_cancel",
                    timed_out=False,
                    termination_source="external_cancel",
                    artifact_name="interruption.json",
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
            recorder.mark_process_exit()
            if cancelled_error is None and not timed_out:
                for remote_path, filename in (
                    ("/tmp/agent/summary.json", "summary.json"),
                ):
                    try:
                        downloaded = await self._download_if_present(environment, remote_path, filename)
                        if filename == "summary.json":
                            summary_path = downloaded
                    except Exception as exc:
                        artifact_warnings.append(f"{filename}: {exc}")
                try:
                    artifact_warnings.extend(await self._download_attempt_artifacts(environment))
                except Exception as exc:
                    artifact_warnings.append(f"attempts: {exc}")
                summary_path = summary_path or self._latest_downloaded_artifact("summary.json")
            trace_path = recorder.finalize_trace()

        derived_summary = self._summary_from_events(
            events, output_result, recorder.snapshot()
        )
        derived_summary.update(recorder.timing_snapshot())
        derived_summary["terminal_origin"] = (
            "adapter_timeout" if timed_out
            else cancellation_source if cancellation_source is not None
            else "runtime_result" if output_result.get("status") is not None
            else "runtime_event" if any(
                event.get("type") in {*TERMINAL_EVENT_TYPES, "run.suspended"} for event in events
            )
            else None
        )
        derived_summary["termination_source"] = derived_summary["terminal_origin"]
        if events and summary_path is None:
            derived_summary_path, _ = self._write_accounting_artifacts(
                events,
                derived_summary,
                write_summary=summary_path is None,
                write_trace=False,
            )
            summary_path = summary_path or derived_summary_path
        summary = {**derived_summary, **self._read_result(result)}
        downloaded_summary = self._read_summary(summary_path)
        if downloaded_summary:
            summary = {**summary, **downloaded_summary}
        # Adapter-observed timing and terminal provenance describe the Harbor
        # process boundary itself, so a runtime-produced summary must not
        # replace them with stale or zero-valued placeholders.
        summary.update(recorder.timing_snapshot())
        summary["terminal_origin"] = derived_summary["terminal_origin"]
        summary["termination_source"] = derived_summary["termination_source"]
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
        summary.update(self._runtime_metadata())
        summary["agent_profile"] = self.agent_profile
        summary["read_scope_effective"] = self.effective_read_scope
        summary["process_handoff_available"] = self.process_handoff_available
        if self._process_cleanup is not None:
            summary["process_cleanup"] = self._process_cleanup
        self._populate_context(context, result, summary, error_message)
        if timed_out or cancelled_error is not None or protocol_failure is not None:
            self._set_context_value(context, "exit_code", 1)
        self._set_context_value(context, "failure_kind", failure_kind)
        self._set_context_value(context, "artifact_warnings", artifact_warnings)
        if summary_path is not None:
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
        command = [
            self._agent_path,
            "run",
            "--workspace",
            self._workspace,
            "--prompt-file",
            "/tmp/agent/instruction.md",
            "--provider",
            self.provider,
            "--model",
            self.model,
            "--agent-profile",
            self.agent_profile,
            "--run-deadline-sec",
            str(self.max_wall_time_sec),
            "--max-model-turns",
            str(self.max_turns),
            "--command-timeout-sec",
            str(self.command_timeout_sec),
            "--network",
            self.network_mode,
            "--read-scope",
            self.effective_read_scope,
            "--process-handoff",
            "allow",
            "--permission-mode",
            "auto",
            "--execution-mode",
            self.execution_mode,
            "--output-format",
            "stream-json",
            "--output-schema",
            "3",
            "--stream-json-max-line-bytes",
            "49152",
        ]
        if self.reviewer_waiver_reason:
            command.append("--waive-reviewer")
        if self.execution_mode == "container":
            command.extend(["--container-engine", self.container_engine, "--container-target", "managed"])
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
                self._runtime_exec(
                    environment,
                    command,
                    timeout_sec=PROCESS_CLEANUP_TIMEOUT_SEC,
                ),
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
        recorder.finish_stream()
        parsed_events, parsed_result = self._parse_stream_output(
            result,
            event_consumer=recorder.consume_event,
            collect_events=False,
        )
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
                return await self._runtime_exec(environment, command_text, **kwargs)
        return await self._runtime_exec(environment, command_text, **kwargs)

    def _parse_stream_output(
        self,
        result: Any | None,
        event_consumer: Any | None = None,
        collect_events: bool = True,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        events: list[dict[str, Any]] = []
        event_sizes: deque[int] = deque()
        event_bytes = 0
        output_result: dict[str, Any] = {}
        chunks: dict[str, dict[str, Any]] = {}

        def collect(event: dict[str, Any]) -> None:
            nonlocal event_bytes
            bounded = _bounded_protocol_event(event)
            size = len(json.dumps(bounded, ensure_ascii=False).encode("utf-8"))
            events.append(bounded)
            event_sizes.append(size)
            event_bytes += size
            while (
                len(events) > MAX_RECORDER_EVENT_COUNT
                or event_bytes > MAX_RECORDER_EVENT_BYTES
            ) and events:
                events.pop(0)
                event_bytes -= event_sizes.popleft()

        for line in _stdout_text(result).splitlines() if result is not None else []:
            for value in _decode_stream_line(line, chunks):
                if value.get("kind") == "event" and isinstance(value.get("event"), dict):
                    event = value["event"]
                    if isinstance(event.get("type"), str):
                        if callable(event_consumer):
                            event_consumer(event)
                        elif collect_events:
                            collect(event)
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
                    if callable(event_consumer):
                        event_consumer(value)
                    elif collect_events:
                        collect(value)
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
        recorded = self._recorded_terminal_result(events, output_result)
        if recorded is not None and isinstance(recorded.get("protocolError"), str):
            return {
                "process_exit_code": 0,
                "protocol_error": recorded["protocolError"],
                "terminal_event_received": any(
                    event.get("type") in TERMINAL_EVENT_TYPES for event in events
                ),
                "result_status_received": isinstance(output_result.get("status"), str),
                "result_finish_reason": output_result.get("finishReason")
                or output_result.get("finish_reason"),
                "last_event_type": events[-1].get("type") if events else None,
            }
        terminal_event = next(
            (event for event in reversed(events) if event.get("type") in TERMINAL_EVENT_TYPES),
            None,
        )
        result_status = output_result.get("status")
        has_result_status = isinstance(result_status, str) and result_status in {
            *SUCCESS_STATUSES, "needs_input", "cancelled", "error", "failed"
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
        protocol_error = diagnostics.get("protocol_error")
        if isinstance(protocol_error, str) and protocol_error:
            return f"agent protocol incomplete: {protocol_error}"
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

    def _limitation_payload_error(self, limitations: Any) -> str | None:
        if not isinstance(limitations, list) or not limitations:
            return "completed_with_limitations requires a non-empty limitations list"
        required = {
            "kind", "claim", "attemptedCommandSummary", "capabilityEvidenceId", "reason"
        }
        claims = {"probe", "syntax", "typecheck", "lint", "unit", "integration", "acceptance"}
        for index, limitation in enumerate(limitations):
            if not isinstance(limitation, dict) or set(limitation) != required:
                return f"limitation[{index}] does not match CompletionLimitationV1"
            if limitation.get("kind") != "validation_capability_unavailable":
                return f"limitation[{index}] has an unsupported kind"
            if limitation.get("claim") not in claims:
                return f"limitation[{index}] has an invalid validation claim"
            for field in ("attemptedCommandSummary", "capabilityEvidenceId", "reason"):
                value = limitation.get(field)
                if not isinstance(value, str) or not value.strip():
                    return f"limitation[{index}].{field} must be a non-empty string"
        return None

    def _completion_output_error(self, result: dict[str, Any]) -> str | None:
        status = result.get("status")
        if status not in SUCCESS_STATUSES:
            return None
        if result.get("finishReason") != status:
            return f"successful result status '{status}' must use the same finishReason"
        if status == "completed_with_limitations":
            return self._limitation_payload_error(result.get("limitations"))
        if "limitations" in result:
            return "ordinary completed result must not carry completion limitations"
        return None

    def _protocol_terminal_result(self, message: str, session_id: str) -> dict[str, Any]:
        return {
            "status": "failed",
            "finishReason": "agent_protocol_invalid",
            "failureKind": "agent_failure",
            "sessionId": session_id,
            "finalMessage": message,
            "protocolError": message,
        }

    def _recorded_terminal_result(
        self,
        events: list[dict[str, Any]],
        output_result: dict[str, Any],
    ) -> dict[str, Any] | None:
        session_id = self._session_id(events, output_result) or ""
        terminal = self._terminal_result(events, session_id)
        if terminal is not None and terminal.get("protocolError"):
            return terminal
        status = output_result.get("status")
        if status in {*SUCCESS_STATUSES, "needs_input", "cancelled", "error", "failed"}:
            output_error = self._completion_output_error(output_result)
            if output_error is not None:
                return self._protocol_terminal_result(output_error, session_id)
            if status in SUCCESS_STATUSES:
                if terminal is None:
                    return self._protocol_terminal_result(
                        f"{status} requires its matching run.completed event",
                        session_id,
                    )
                if terminal.get("status") != status:
                    return self._protocol_terminal_result(
                        "terminal event and output result disagree about completion status",
                        session_id,
                    )
                if status == "completed_with_limitations" and (
                    terminal.get("limitations") != output_result.get("limitations")
                ):
                    return self._protocol_terminal_result(
                        "terminal event and output result disagree about completion limitations",
                        session_id,
                    )
            return dict(output_result)
        if terminal is not None:
            return terminal
        if self._pending_checkpoint(events) is not None:
            return None
        suspended = next((event for event in reversed(events) if event.get("type") == "run.suspended"), None)
        if suspended is None:
            return None
        payload = _event_payload(suspended)
        message = payload.get("message")
        return {
            **payload,
            "status": "needs_input",
            "finishReason": "needs_input",
            "sessionId": session_id,
            **({"finalMessage": message} if isinstance(message, str) else {}),
        }

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
            if event_type == "run.completed":
                kind = payload.get("kind")
                if kind not in SUCCESS_STATUSES:
                    return self._protocol_terminal_result(
                        "run.completed must declare kind completed or completed_with_limitations",
                        session_id,
                    )
                limitation_error = self._limitation_payload_error(payload.get("limitations")) \
                    if kind == "completed_with_limitations" else None
                if limitation_error is not None:
                    return self._protocol_terminal_result(limitation_error, session_id)
                if kind == "completed" and "limitations" in payload:
                    return self._protocol_terminal_result(
                        "ordinary run.completed must not carry completion limitations",
                        session_id,
                    )
            status = {
                "run.completed": "completed_with_limitations"
                if payload.get("kind") == "completed_with_limitations" else "completed",
                "run.cancelled": "cancelled",
                "run.failed": "failed",
            }[event_type]
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
        command: list[str] = [
            self._agent_path,
            "session",
            subcommand,
            session_id,
            "--workspace",
            self._workspace,
            "--provider",
            self.provider,
            "--model",
            self.model,
            "--agent-profile",
            self.agent_profile,
            "--permission-mode",
            "auto",
            "--max-model-turns",
            str(self.max_turns),
            "--command-timeout-sec",
            str(self.command_timeout_sec),
            "--execution-mode",
            self.execution_mode,
            "--network",
            self.network_mode,
            "--read-scope",
            self.effective_read_scope,
            "--process-handoff",
            "allow",
        ]
        if self.execution_mode == "container":
            command.extend(["--container-engine", self.container_engine, "--container-target", "managed"])
        return command

    async def _read_session_events(
        self,
        environment: BaseEnvironment,
        session_id: str,
        env_vars: dict[str, str],
    ) -> tuple[list[dict[str, Any]], str | None]:
        command = self._session_command("show", session_id) + ["--json"]
        result = await self._runtime_exec(
            environment,
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
                recovery = await self._runtime_exec(
                    environment,
                    " ".join(shlex.quote(part) for part in command),
                    env=env_vars or None,
                    timeout_sec=30,
                )
                if _return_code(recovery) != 0:
                    detail = _output_text(recovery).strip() or "session recover failed"
                    return merged, None, f"external checkpoint recovery failed: {detail}"
                resume_command = self._session_command("resume", session_id)
                resumed = await self._runtime_exec(
                    environment,
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
            "return_code": 0 if status in SUCCESS_STATUSES else 1,
            "stdout": f"{_stdout_text(base_result)}\n{json.dumps(payload, ensure_ascii=False)}\n",
            "stderr": _stderr_text(base_result),
        }

    def _summary_from_events(
        self,
        events: list[dict[str, Any]],
        output_result: dict[str, Any],
        accounting: dict[str, Any] | None = None,
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
        deadline_stage_events = [
            _event_payload(event)
            for event in events
            if event.get("type") == "diagnostic"
            and _event_payload(event).get("kind") == "deadline.stage"
        ]
        deadline_converge_turns = sum(
            payload.get("stage") == "converge" for payload in deadline_stage_events
        )
        budget_converge_turns = sum(
            payload.get("budgetStage") == "converge" for payload in deadline_stage_events
        )
        terminal_budget_turns = sum(
            payload.get("budgetStage") == "terminal" for payload in deadline_stage_events
        )
        converge_turns = sum(
            payload.get("stage") == "converge" or payload.get("budgetStage") == "converge"
            for payload in deadline_stage_events
        )
        terminal_source = (
            output_result.get("terminationSource")
            or output_result.get("termination_source")
        )
        manual_stop_count = int(terminal_source == "manual_stop")
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
        if accounting is not None:
            input_tokens = _as_int(accounting.get("input_tokens"), input_tokens)
            output_tokens = _as_int(accounting.get("output_tokens"), output_tokens)
            reasoning_tokens = _as_int(accounting.get("reasoning_tokens"), reasoning_tokens)
            cache_read_tokens = _as_int(accounting.get("cache_read_tokens"), cache_read_tokens)
            cache_write_tokens = _as_int(accounting.get("cache_write_tokens"), cache_write_tokens)
            cache_tokens = cache_read_tokens + cache_write_tokens
            length_finish_count = _as_int(
                accounting.get("length_finish_count"), length_finish_count
            )
            deadline_converge_turns = _as_int(
                accounting.get("deadline_converge_turns"), deadline_converge_turns
            )
            budget_converge_turns = _as_int(
                accounting.get("budget_converge_turns"), budget_converge_turns
            )
            terminal_budget_turns = _as_int(
                accounting.get("terminal_budget_turns"), terminal_budget_turns
            )
            converge_turns = _as_int(accounting.get("converge_turns"), converge_turns)
            cost_micro_usd = _as_int(accounting.get("cost_micro_usd"), cost_micro_usd)
            recorded_model_failure = accounting.get("model_failure")
            if isinstance(recorded_model_failure, dict):
                model_failure = recorded_model_failure
        limitations = output_result.get("limitations")
        if not isinstance(limitations, list):
            terminal = next((event for event in reversed(events)
                             if event.get("type") == "run.completed"), None)
            terminal_limitations = _event_payload(terminal).get("limitations") \
                if terminal is not None else None
            limitations = terminal_limitations if isinstance(terminal_limitations, list) else []
        return {
            "schema_version": 1,
            "status": output_result.get("status"),
            "finish_reason": output_result.get("finishReason"),
            "limitations": limitations,
            "limitation_count": len(limitations),
            "session_id": (
                output_result.get("sessionId")
                or (accounting or {}).get("session_id")
                or self._session_id(events, output_result)
            ),
            "commands_executed": (
                _as_int(accounting.get("commands_executed"), 0)
                if accounting is not None
                else sum(event.get("type") in {"tool.completed", "tool.failed"} for event in events)
            ),
            "tool_calls": (
                _as_int(accounting.get("tool_calls"), 0)
                if accounting is not None
                else sum(event.get("type") == "tool.requested" for event in events)
            ),
            "model_turns": (
                _as_int(accounting.get("model_turns"), 0)
                if accounting is not None
                else sum(event.get("type") == "model.started" for event in events)
            ),
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
            "deadline_converge_turns": deadline_converge_turns,
            "budget_converge_turns": budget_converge_turns,
            "terminal_budget_turns": terminal_budget_turns,
            "manual_stop_count": manual_stop_count,
            "cost_usd": cost_micro_usd / 1_000_000,
            "last_event": (
                accounting.get("last_event")
                if accounting is not None
                else _bounded_event(events[-1]) if events else None
            ),
            "retry_count": (
                _as_int(accounting.get("retry_count"), 0)
                if accounting is not None
                else sum(
                    "retry" in str(event.get("type", "")).lower()
                    or "retry" in str(_event_payload(event).get("status", "")).lower()
                    for event in events
                )
            ),
            "model_failure": model_failure,
            "network_mode_requested": self.network_mode,
            "network_mode_effective": self.effective_network_mode,
            "execution_mode": self.execution_mode,
            **self._runtime_metadata(),
            "agent_profile": self.agent_profile,
            "harbor_deadline_sec": self.outer_trial_deadline_sec,
            "sigma_deadline_sec": self.max_wall_time_sec,
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
        status: str = "timeout",
        failure_kind: str = "timeout",
        timed_out: bool = True,
        termination_source: str = "adapter_timeout",
        artifact_name: str = "timeout.json",
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
            "status": status,
            "timed_out": timed_out,
            "failure_kind": failure_kind,
            "message": error_message or (
                "agent execution timed out" if timed_out else "agent execution was cancelled"
            ),
            "network_mode_requested": self.network_mode,
            "network_mode_effective": self.effective_network_mode,
            "read_scope_effective": self.effective_read_scope,
            "process_handoff_available": self.process_handoff_available,
            **self._runtime_metadata(),
            "last_event": last_event,
            "model_turns": live_state.get("model_turns", sum(event.get("type") == "model.started" for event in events)),
            "tool_calls": live_state.get(
                "tool_calls",
                sum(event.get("type") == "tool.requested" for event in events),
            ),
            "usage": live_state.get("usage", {}),
            "retry_count": live_state.get("retry_count", 0),
            "last_retry": live_state.get("last_retry"),
            "length_finish_count": live_state.get("length_finish_count", 0),
            "converge_turns": live_state.get("converge_turns", 0),
            "deadline_converge_turns": live_state.get("deadline_converge_turns", 0),
            "budget_converge_turns": live_state.get("budget_converge_turns", 0),
            "terminal_budget_turns": live_state.get("terminal_budget_turns", 0),
            "manual_stop_count": 0,
            "duration_ms": live_state.get("duration_ms", 0),
            "suspension_to_exit_ms": live_state.get("suspension_to_exit_ms"),
            "terminal_origin": termination_source,
            "termination_source": termination_source,
            "harbor_deadline_sec": self.outer_trial_deadline_sec,
            "sigma_deadline_sec": self.max_wall_time_sec,
            "stdout": _text_artifact_summary(stdout),
            "stderr": _text_artifact_summary(stderr),
            "process_cleanup": process_cleanup,
            "recorded_at": time.time(),
        }
        (self.logs_dir / artifact_name).write_text(
            json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

        summary_target = summary_path or (self.logs_dir / "summary.json")
        summary = self._read_summary(summary_target)
        summary.update({
            "schema_version": max(1, _as_int(summary.get("schema_version"), 1)),
            "status": status,
            "failure_kind": failure_kind,
            "last_error": state["message"],
            ("timeout" if timed_out else "interruption"): state,
            "last_event": last_event,
            "model_turns": state["model_turns"],
            "tool_calls": state["tool_calls"],
            "usage": state["usage"],
            "retry_count": state["retry_count"],
            "last_retry": state["last_retry"],
            "length_finish_count": state["length_finish_count"],
            "converge_turns": state["converge_turns"],
            "deadline_converge_turns": state["deadline_converge_turns"],
            "budget_converge_turns": state["budget_converge_turns"],
            "terminal_budget_turns": state["terminal_budget_turns"],
            "manual_stop_count": state["manual_stop_count"],
            "duration_ms": state["duration_ms"],
            "suspension_to_exit_ms": state["suspension_to_exit_ms"],
            "terminal_origin": state["terminal_origin"],
            "termination_source": state["termination_source"],
            "harbor_deadline_sec": state["harbor_deadline_sec"],
            "sigma_deadline_sec": state["sigma_deadline_sec"],
            "process_cleanup": process_cleanup,
            "network_mode_requested": self.network_mode,
            "network_mode_effective": self.effective_network_mode,
            "read_scope_effective": self.effective_read_scope,
            "process_handoff_available": self.process_handoff_available,
            **self._runtime_metadata(),
        })
        summary_target.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        trace_target = trace_path or (self.logs_dir / "trace.jsonl")
        timeout_event = {
            "type": "run_timeout" if timed_out else "run_cancelled",
            "occurredAt": time.time(),
            "payload": {
                "status": status,
                "message": state["message"],
                "failure_kind": failure_kind,
                "termination_source": termination_source,
            },
        }
        if recorder is not None:
            recorder.consume_event(timeout_event)
            trace_target = recorder.finalize_trace()
        else:
            trace_spool = _BoundedJsonlSpool(
                trace_target, MAX_TRACE_ARTIFACT_BYTES
            )
            for event in events:
                trace_spool.append(_trace_record(event))
            trace_spool.append(_trace_record(timeout_event))
            trace_spool.finalize()
        return summary_target, trace_target

    def _trace_records(
        self,
        events: list[dict[str, Any]],
        summary: dict[str, Any] | None = None,
    ) -> Iterator[dict[str, Any]]:
        for event in events:
            yield _trace_record(event, summary)

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
            trace_spool = _BoundedJsonlSpool(
                trace_path, MAX_TRACE_ARTIFACT_BYTES
            )
            for record in self._trace_records(events, summary):
                trace_spool.append(record)
            trace_spool.finalize()
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

    async def _verify_agent_ready(
        self,
        environment: BaseEnvironment,
        initial_checks: list[dict[str, Any]] | None = None,
    ) -> None:
        if self._workspace is None:
            raise RuntimeError("agent_setup_failed: workspace was not resolved")
        checks: list[dict[str, Any]] = list(initial_checks or [])
        help_check = await self._runtime_exec(
            environment,
            f"{self._agent_path} --help",
            timeout_sec=30,
        )
        checks.append(self._setup_check_record("help", help_check))
        self._write_setup_checks(checks, "running")
        if _return_code(help_check) != 0:
            self._write_setup_checks(checks, "agent_setup_failed")
            raise RuntimeError(self._setup_failure_message("help", help_check))

        doctor_parts = [
            self._agent_path,
            "doctor",
            "--workspace",
            self._workspace,
            "--json",
            "--strict",
            *(["--check-api"] if self.check_api else []),
        ]
        if self.execution_mode == "container":
            doctor_parts.extend([
                "--execution-mode", "container",
                "--container-engine", self.container_engine,
                "--container-target", "managed",
            ])
        doctor_check = await self._runtime_exec(
            environment,
            shlex.join(doctor_parts),
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
        sandbox = doctor_json.get("sandbox")
        sandbox_backend = sandbox.get("backend") if isinstance(sandbox, dict) else None
        if self.execution_mode == "container":
            container = doctor_json["container"]
            self.container_metadata = {
                key: container.get(key)
                for key in (
                    "backend", "engine", "target", "targetId", "targetStartedAt",
                    "imageId", "imageDigest", "helperDigest", "attestationDigest",
                )
                if container.get(key) is not None
            }
            self.execution_backend = f"oci:{container['engine']}"
        else:
            self.execution_backend = (
                f"sandbox:{sandbox_backend}" if isinstance(sandbox_backend, str) and sandbox_backend
                else "sandbox:unknown"
            )
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
        if self.execution_mode == "container":
            container = doctor_json.get("container")
            if not isinstance(container, dict):
                return "container report is missing"
            if container.get("available") is not True:
                return "container.available was not confirmed"
            if container.get("backend") != "oci":
                return "container.backend is not oci"
            if container.get("engine") not in {"docker", "podman"}:
                return "container.engine is missing or invalid"
            if container.get("target") != "managed":
                return "container.target is not managed"
            for field in ("targetId", "targetStartedAt", "imageId", "helperDigest", "attestationDigest"):
                value = container.get(field)
                if not isinstance(value, str) or not value:
                    return f"container.{field} is missing or invalid"
        return None

    def _write_setup_checks(self, checks: list[dict[str, Any]], status: str) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": 1,
            "classification": status,
            "network_mode_requested": self.network_mode,
            "network_mode_effective": self.effective_network_mode,
            "execution_mode": self.execution_mode,
            "managed_provenance": self.managed_provenance,
            "execution_backend": self.execution_backend,
            "container": dict(self.container_metadata),
            "container_engine": self.container_metadata.get("engine"),
            "container_target": self.container_metadata.get("target"),
            "target_image_id": self.container_metadata.get("imageId"),
            "task_image_digest": self.container_metadata.get("imageDigest"),
            "agent_profile": self.agent_profile,
            "max_turns": self.max_turns,
            "command_timeout_sec": self.command_timeout_sec,
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
        if self.execution_mode == "container":
            encoded = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
            result = await self._runtime_exec(
                environment,
                " ".join([
                    "set -eu; umask 077; mkdir -p /tmp/agent; printf %s",
                    shlex.quote(encoded),
                    "| base64 -d > /tmp/agent/instruction.md; chmod 0600 /tmp/agent/instruction.md",
                ]),
                timeout_sec=30,
            )
            if _return_code(result) != 0:
                raise RuntimeError(self._setup_failure_message("instruction_upload", result))
            return
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

    def _runtime_metadata(self) -> dict[str, Any]:
        container = self.container_metadata
        return {
            "execution_backend": self.execution_backend,
            "container_engine": container.get("engine"),
            "container_target": container.get("target"),
            "container_target_id": container.get("targetId"),
            "container_target_started_at": container.get("targetStartedAt"),
            "target_image_id": container.get("imageId"),
            "target_image_digest": container.get("imageDigest"),
            "task_image_digest": container.get("imageDigest"),
            "max_turns": self.max_turns,
            "command_timeout_sec": self.command_timeout_sec,
            "container_helper_digest": container.get("helperDigest"),
            "container_attestation_digest": container.get("attestationDigest"),
            "container_metadata": dict(container),
        }

    async def _download_if_present(
        self,
        environment: BaseEnvironment,
        remote_path: str,
        filename: str,
    ) -> pathlib.Path | None:
        exists = await self._runtime_exec(
            environment,
            f"test -f {shlex.quote(remote_path)}",
            timeout_sec=30,
        )
        if _return_code(exists) != 0:
            return None
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        target_path = self.logs_dir / filename
        await self._runtime_download_file(environment, remote_path, target_path)
        return target_path

    async def _download_attempt_artifacts(self, environment: BaseEnvironment) -> list[str]:
        warnings: list[str] = []
        exists = await self._runtime_exec(
            environment,
            "test -d /tmp/agent/attempts",
            timeout_sec=30,
        )
        if _return_code(exists) != 0:
            return warnings
        listing = await self._runtime_exec(
            environment,
            "find /tmp/agent/attempts -type f 2>/dev/null",
            timeout_sec=30,
        )
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
                await self._runtime_download_file(environment, remote_path, target_path)
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
            "deadline_converge_turns": _json_number(summary, "deadline_converge_turns"),
            "budget_converge_turns": _json_number(summary, "budget_converge_turns"),
            "terminal_budget_turns": _json_number(summary, "terminal_budget_turns"),
            "manual_stop_count": _json_number(summary, "manual_stop_count"),
            "cost_usd": summary.get("cost_usd"),
            "duration_ms": _json_number(summary, "duration_ms"),
            "suspension_to_exit_ms": summary.get("suspension_to_exit_ms"),
            "terminal_origin": summary.get("terminal_origin"),
            "execution_mode": summary.get("execution_mode", self.execution_mode),
            "execution_backend": summary.get("execution_backend", self.execution_backend),
            "container_engine": summary.get("container_engine", self.container_metadata.get("engine")),
            "container_target": summary.get("container_target", self.container_metadata.get("target")),
            "container_target_id": summary.get("container_target_id", self.container_metadata.get("targetId")),
            "container_target_started_at": summary.get(
                "container_target_started_at", self.container_metadata.get("targetStartedAt")
            ),
            "target_image_id": summary.get("target_image_id", self.container_metadata.get("imageId")),
            "target_image_digest": summary.get("target_image_digest", self.container_metadata.get("imageDigest")),
            "task_image_digest": summary.get("task_image_digest", self.container_metadata.get("imageDigest")),
            "container_helper_digest": summary.get(
                "container_helper_digest", self.container_metadata.get("helperDigest")
            ),
            "container_attestation_digest": summary.get(
                "container_attestation_digest", self.container_metadata.get("attestationDigest")
            ),
            "container_metadata": summary.get("container_metadata", dict(self.container_metadata)),
            "agent_profile": summary.get("agent_profile", self.agent_profile),
            "network_mode_requested": summary.get("network_mode_requested", self.network_mode),
            "network_mode_effective": summary.get("network_mode_effective", self.effective_network_mode),
            "read_scope_effective": summary.get("read_scope_effective", self.effective_read_scope),
            "process_handoff_available": summary.get("process_handoff_available", self.process_handoff_available),
            "completion_limitations": summary.get("limitations", []),
            "completion_limitation_count": _json_number(summary, "limitation_count"),
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
            "duration_ms": getattr(context, "duration_ms", 0),
            "suspension_to_exit_ms": getattr(context, "suspension_to_exit_ms", None),
            "terminal_origin": getattr(context, "terminal_origin", None),
            "execution_mode": getattr(context, "execution_mode", self.execution_mode),
            "execution_backend": getattr(context, "execution_backend", self.execution_backend),
            "container_engine": getattr(context, "container_engine", self.container_metadata.get("engine")),
            "container_target": getattr(context, "container_target", self.container_metadata.get("target")),
            "container_target_id": getattr(
                context, "container_target_id", self.container_metadata.get("targetId")
            ),
            "container_target_started_at": getattr(
                context, "container_target_started_at", self.container_metadata.get("targetStartedAt")
            ),
            "target_image_id": getattr(context, "target_image_id", self.container_metadata.get("imageId")),
            "target_image_digest": getattr(
                context, "target_image_digest", self.container_metadata.get("imageDigest")
            ),
            "task_image_digest": getattr(
                context, "task_image_digest", self.container_metadata.get("imageDigest")
            ),
            "container_helper_digest": getattr(
                context, "container_helper_digest", self.container_metadata.get("helperDigest")
            ),
            "container_attestation_digest": getattr(
                context, "container_attestation_digest", self.container_metadata.get("attestationDigest")
            ),
            "agent_profile": getattr(context, "agent_profile", self.agent_profile),
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
            "deadline_converge_turns": getattr(context, "deadline_converge_turns", 0),
            "budget_converge_turns": getattr(context, "budget_converge_turns", 0),
            "terminal_budget_turns": getattr(context, "terminal_budget_turns", 0),
            "manual_stop_count": getattr(context, "manual_stop_count", 0),
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
