#!/usr/bin/env python3
"""Drive Sigma's real TUI for evaluation without exposing evaluator data to it."""

from __future__ import annotations

import base64
import errno
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import struct
import sys
import threading
import time
from typing import Any, Protocol


READY_TOKENS = ("New", "session.", "Type", "a", "request", "and", "press", "Enter.")
TERMINAL_TYPES = {"run.completed", "run.failed", "run.cancelled"}
RUN_BOUNDARY_TYPES = TERMINAL_TYPES | {"run.started", "run.suspended"}
SUBJECT_ENVIRONMENT_BRIDGE = "SIGMA_TUI_SUBJECT_ENVIRONMENT_B64"


def subject_environment() -> dict[str, str]:
    encoded = os.environ.get(SUBJECT_ENVIRONMENT_BRIDGE, "")
    if not encoded:
        raise RuntimeError("TUI controller did not receive the prepared subject environment.")
    try:
        value = json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("TUI subject environment bridge is invalid.") from error
    if not isinstance(value, dict) or any(not isinstance(key, str) or not isinstance(item, str)
                                          for key, item in value.items()):
        raise RuntimeError("TUI subject environment must contain only string entries.")
    value.pop(SUBJECT_ENVIRONMENT_BRIDGE, None)
    return value


class Terminal(Protocol):
    backend: str

    def read(self) -> str: ...
    def write(self, value: str) -> None: ...
    def alive(self) -> bool: ...
    def wait(self) -> int: ...
    def terminate(self) -> None: ...
    def close(self) -> None: ...


class PosixTerminal:
    backend = "posix-pty"

    def __init__(self, command: list[str], cwd: Path, env: dict[str, str]) -> None:
        import fcntl
        import pty
        import termios

        pid, descriptor = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.execvpe(command[0], command, env)
        self.pid = pid
        self.descriptor = descriptor
        self.status: int | None = None
        fcntl.ioctl(descriptor, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))

    def read(self) -> str:
        try:
            return os.read(self.descriptor, 8192).decode("utf-8", errors="replace")
        except OSError as error:
            if error.errno == errno.EIO:
                raise EOFError from error
            raise

    def write(self, value: str) -> None:
        os.write(self.descriptor, value.encode("utf-8"))

    def alive(self) -> bool:
        if self.status is not None:
            return False
        child, status = os.waitpid(self.pid, os.WNOHANG)
        if child:
            self.status = status
            return False
        return True

    def wait(self) -> int:
        if self.status is None:
            _, self.status = os.waitpid(self.pid, 0)
        return os.waitstatus_to_exitcode(self.status)

    def terminate(self) -> None:
        if self.alive():
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                os.kill(self.pid, signal.SIGKILL)

    def close(self) -> None:
        try:
            os.close(self.descriptor)
        except OSError:
            pass


class WindowsTerminal:
    backend = "windows-conpty"

    def __init__(self, command: list[str], cwd: Path, env: dict[str, str]) -> None:
        os.environ["PYWINPTY_BLOCK"] = "0"
        from winpty import Backend, PtyProcess

        self.process = PtyProcess.spawn(
            command,
            cwd=str(cwd),
            env=env,
            dimensions=(30, 110),
            backend=Backend.ConPTY,
        )

    def read(self) -> str:
        return self.process.read(8192)

    def write(self, value: str) -> None:
        self.process.write(value)

    def alive(self) -> bool:
        return self.process.isalive()

    def wait(self) -> int:
        return int(self.process.wait() or 0)

    def terminate(self) -> None:
        if self.process.isalive():
            self.process.terminate(force=True)

    def close(self) -> None:
        self.process.close(force=True)


def terminal_for(command: list[str], cwd: Path, env: dict[str, str]) -> Terminal:
    return WindowsTerminal(command, cwd, env) if os.name == "nt" else PosixTerminal(command, cwd, env)


def reader(terminal: Terminal, output: queue.Queue[str | None]) -> None:
    try:
        while True:
            chunk = terminal.read()
            if chunk:
                output.put(chunk)
            elif not terminal.alive():
                break
            else:
                time.sleep(0.01)
    except (EOFError, OSError):
        pass
    finally:
        output.put(None)


def contains_ready_frame(transcript: str) -> bool:
    cursor = max(0, transcript.rfind(READY_TOKENS[0]))
    start = cursor
    for token in READY_TOKENS:
        cursor = transcript.find(token, cursor)
        if cursor < 0 or cursor - start > 30_000:
            return False
        cursor += len(token)
    return True


def workspace_digest(workspace: Path) -> str:
    identity = str(workspace.resolve())
    if os.name == "nt":
        identity = identity.lower()
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def long_path(value: Path) -> str:
    resolved = str(value.resolve())
    return f"\\\\?\\{resolved}" if os.name == "nt" and not resolved.startswith("\\\\?\\") else resolved


class EventTail:
    def __init__(self, state_home: Path, workspace: Path, store_layout_version: int) -> None:
        self.store_layout_version = store_layout_version
        self.stores_root = state_home / "workspaces" / workspace_digest(workspace) / "stores"
        self.sessions_root = self.stores_root / f"v{store_layout_version}" / "sessions"
        self.offsets: dict[Path, int] = {}
        self.seen: set[str] = set()

    def version_mismatch(self) -> dict[str, Any] | None:
        if not self.stores_root.is_dir():
            return None
        observed = sorted(
            entry.name for entry in self.stores_root.iterdir()
            if entry.is_dir() and entry.name.startswith("v") and entry.name[1:].isdigit()
        )
        expected = f"v{self.store_layout_version}"
        if observed and expected not in observed:
            return {
                "code": "event_store_version_mismatch",
                "expectedStoreLayoutVersion": self.store_layout_version,
                "observedStoreVersions": observed,
            }
        return None

    def read(self) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        if not self.sessions_root.is_dir():
            return events
        for event_file in sorted(self.sessions_root.glob("*/events/*.jsonl")):
            offset = self.offsets.get(event_file, 0)
            try:
                with open(long_path(event_file), "rb") as handle:
                    handle.seek(offset)
                    data = handle.read()
                    complete_end = data.rfind(b"\n")
                    if complete_end < 0:
                        continue
                    complete = data[:complete_end + 1]
                    self.offsets[event_file] = offset + complete_end + 1
                    for raw_line in complete.splitlines():
                        try:
                            value = json.loads(raw_line.decode("utf-8"))
                        except (UnicodeDecodeError, json.JSONDecodeError):
                            continue
                        event = value.get("event") if isinstance(value, dict) else None
                        event_id = event.get("eventId") if isinstance(event, dict) else None
                        if event_id and event_id not in self.seen:
                            self.seen.add(event_id)
                            events.append(event)
            except (FileNotFoundError, OSError):
                continue
        return events


def trigger_satisfied(trigger: dict[str, Any], elapsed_ms: int, events: list[dict[str, Any]]) -> bool:
    kind = trigger.get("kind")
    if kind == "elapsed_ms":
        return elapsed_ms >= int(trigger.get("value", 0))
    if kind == "event_count":
        event_type = str(trigger.get("eventType", "tool.requested"))
        return sum(event.get("type") == event_type for event in events) >= int(trigger.get("count", 1))
    if kind == "first_mutation":
        return any(
            event.get("type") in {"tool.completed", "tool.failed"}
            and isinstance(event.get("payload"), dict)
            and event["payload"].get("workspaceDelta")
            for event in events
        )
    return False


def budget_breach(events: list[dict[str, Any]], elapsed_ms: int, budget: dict[str, Any]) -> dict[str, Any] | None:
    checks = [
        ("wallTime", elapsed_ms, int(budget["wallTimeSec"]) * 1000),
        ("modelTurns", sum(event.get("type") == "model.started" for event in events), int(budget["modelTurns"])),
        ("toolCalls", sum(event.get("type") == "tool.requested" for event in events), int(budget["toolCalls"])),
        ("costMicroUsd", sum(
            int((event.get("payload") or {}).get("costMicroUsd", 0))
            for event in events if event.get("type") == "usage.recorded"
        ), int(float(budget["costUsd"]) * 1_000_000)),
    ]
    for dimension, actual, limit in checks:
        if actual > limit:
            return {"dimension": dimension, "actual": actual, "limit": limit}
    return None


def clean_text(value: str) -> str:
    return value.replace("\r", " ").replace("\n", " ")


def event_request_id(event: dict[str, Any]) -> str | None:
    payload = event.get("payload") or {}
    value = payload.get("requestId") or payload.get("callId")
    return str(value) if value else None


def unresolved_approvals(events: list[dict[str, Any]]) -> set[str]:
    unresolved: set[str] = set()
    for event in events:
        request_id = event_request_id(event)
        if not request_id:
            continue
        if event.get("type") == "tool.approval_requested":
            unresolved.add(request_id)
        elif event.get("type") == "tool.approval_resolved":
            unresolved.discard(request_id)
    return unresolved


def quit_boundary(
    events: list[dict[str, Any]],
    interactions_done: set[int],
    interaction_count: int,
    last_interaction_sent_at: float | None,
    now: float,
) -> dict[str, Any] | None:
    if len(interactions_done) < interaction_count or unresolved_approvals(events):
        return None
    if last_interaction_sent_at is not None and now - last_interaction_sent_at < 1.0:
        return None
    boundary = next((event for event in reversed(events) if event.get("type") in RUN_BOUNDARY_TYPES), None)
    if not boundary or boundary.get("type") not in TERMINAL_TYPES | {"run.suspended"}:
        return None
    if boundary.get("type") == "run.suspended":
        boundary_seq = int(boundary.get("seq", 0))
        if any(
            int(event.get("seq", 0)) > boundary_seq
            and event.get("type") in {
                "user.message",
                "user.steer",
                "user.follow_up",
                "tool.approval_resolved",
                "tool.requested",
                "tool.completed",
                "tool.failed",
                "model.started",
                "model.completed",
                "run.started",
            }
            for event in events
        ):
            return None
    return boundary


def run(config: dict[str, Any]) -> dict[str, Any]:
    workspace = Path(config["workspace"]).resolve()
    state_home = Path(config["stateHome"]).resolve()
    transcript_path = Path(config["transcriptPath"]).resolve()
    terminal = terminal_for(list(config["command"]), workspace, subject_environment())
    chunks: queue.Queue[str | None] = queue.Queue()
    thread = threading.Thread(target=reader, args=(terminal, chunks), daemon=True)
    thread.start()
    store_layout_version = int(config["storeLayoutVersion"])
    event_stream_timeout_ms = int(config.get("eventStreamTimeoutMs", 10_000))
    if store_layout_version <= 0 or event_stream_timeout_ms <= 0:
        raise ValueError("TUI event stream version and timeout must be positive integers.")
    tail = EventTail(state_home, workspace, store_layout_version)
    transcript = ""
    events: list[dict[str, Any]] = []
    approvals: set[str] = set()
    interactions_done: set[int] = set()
    initial_sent = False
    initial_sent_at: float | None = None
    quit_sent = False
    cancel_sent = False
    cancellation: dict[str, Any] | None = None
    infrastructure_error: dict[str, Any] | None = None
    reader_done = False
    started = time.monotonic()
    hard_deadline = started + int(config["budget"]["wallTimeSec"]) + 35
    terminal_seen_at: float | None = None
    terminal_boundary_id: str | None = None
    settled_terminal_type: str | None = None
    last_interaction_sent_at: float | None = None
    try:
        while time.monotonic() < hard_deadline:
            try:
                chunk = chunks.get(timeout=0.05)
                if chunk is None:
                    reader_done = True
                else:
                    transcript += chunk
                    if len(transcript) > 16_000_000:
                        transcript = transcript[:8_000_000] + "\n[TUI transcript middle omitted]\n" + transcript[-8_000_000:]
            except queue.Empty:
                pass

            events.extend(tail.read())
            elapsed_ms = int((time.monotonic() - started) * 1000)
            if not initial_sent and contains_ready_frame(transcript):
                terminal.write(f"{clean_text(config['initialMessage'])}\r")
                initial_sent = True
                initial_sent_at = time.monotonic()

            if initial_sent and not events:
                mismatch = tail.version_mismatch()
                stream_wait_ms = int((time.monotonic() - (initial_sent_at or time.monotonic())) * 1000)
                if mismatch or stream_wait_ms >= event_stream_timeout_ms:
                    infrastructure_error = mismatch or {
                        "code": "event_stream_unavailable",
                        "expectedStoreLayoutVersion": store_layout_version,
                        "timeoutMs": event_stream_timeout_ms,
                    }
                    terminal.terminate()
                    break

            for event in events:
                if event.get("type") != "tool.approval_requested":
                    continue
                payload = event.get("payload") or {}
                request_id = str(payload.get("requestId") or payload.get("callId") or event.get("eventId"))
                if request_id in approvals:
                    continue
                approvals.add(request_id)
                time.sleep(0.12)
                terminal.write("a" if config.get("permissionPolicy") == "always_allow" else "y")

            if initial_sent:
                for index, interaction in enumerate(config.get("interactions", [])):
                    if index in interactions_done:
                        continue
                    triggers = interaction.get("triggers") or [interaction.get("trigger", {})]
                    if not any(trigger_satisfied(trigger, elapsed_ms, events) for trigger in triggers):
                        continue
                    text = clean_text(str(interaction.get("text", "")))
                    action = interaction.get("action", "steer")
                    terminal.write(f"/followup {text}\r" if action == "follow_up" else f"{text}\r")
                    interactions_done.add(index)
                    last_interaction_sent_at = time.monotonic()

            if not cancel_sent:
                breach = budget_breach(events, elapsed_ms, config["budget"])
                if breach:
                    cancellation = {"reason": "experience_budget_exceeded", **breach}
                    terminal.write("\x03")
                    cancel_sent = True

            boundary = quit_boundary(
                events,
                interactions_done,
                len(config.get("interactions", [])),
                last_interaction_sent_at,
                time.monotonic(),
            )
            if boundary:
                boundary_id = str(boundary.get("eventId") or f"{boundary.get('type')}:{boundary.get('seq')}")
                if boundary_id != terminal_boundary_id:
                    terminal_boundary_id = boundary_id
                    terminal_seen_at = time.monotonic()
                if not quit_sent and time.monotonic() - terminal_seen_at >= 0.25:
                    terminal.write("/quit\r")
                    quit_sent = True
                    settled_terminal_type = str(boundary.get("type"))
            else:
                terminal_boundary_id = None
                terminal_seen_at = None

            if not terminal.alive() and reader_done:
                break
        else:
            cancellation = cancellation or {"reason": "tui_driver_timeout"}
            terminal.terminate()
        exit_code = terminal.wait()
        # Close can race the polling interval after the final durable event.
        # Re-read once and enforce the frozen budget at the terminal boundary.
        events.extend(tail.read())
        finished_elapsed_ms = int((time.monotonic() - started) * 1000)
        final_breach = budget_breach(events, finished_elapsed_ms, config["budget"])
        if cancellation is None and final_breach:
            cancellation = {
                "reason": "experience_budget_exceeded",
                **final_breach,
                "observedAtTerminal": True,
            }
    finally:
        if terminal.alive():
            terminal.terminate()
        terminal.close()
        thread.join(timeout=1)
        transcript_path.parent.mkdir(parents=True, exist_ok=True)
        secret = os.environ.get("DEEPSEEK_API_KEY", "")
        safe_transcript = transcript.replace(secret, "[REDACTED]") if secret else transcript
        transcript_path.write_text(safe_transcript, encoding="utf-8", errors="replace")

    session_id = next((event.get("sessionId") for event in events if event.get("sessionId")), None)
    return {
        "exitCode": exit_code,
        "backend": terminal.backend,
        "sessionId": session_id,
        "eventCount": len(events),
        "durationMs": int((time.monotonic() - started) * 1000),
        "approvalCount": len(approvals),
        "interactionsDelivered": len(interactions_done),
        "settledTerminalType": settled_terminal_type,
        "cancellation": cancellation,
        "infrastructureError": infrastructure_error,
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: tui-driver.py <config.json>")
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    print(json.dumps(run(config), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise
