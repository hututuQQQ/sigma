#!/usr/bin/env python3
"""Exercise the packaged TUI through a real POSIX PTY or Windows ConPTY."""

from __future__ import annotations

import argparse
import errno
import os
from pathlib import Path
import queue
import shutil
import signal
import struct
import sys
import tempfile
import threading
import time
from typing import Protocol


READY_TEXT = "New session. Type a request and press Enter."
READY_TOKENS = ("New", "session.", "Type", "a", "request", "and", "press", "Enter.")
REQUIRED_MARKERS = (
    "\x1b[?25l",
    "\x1b[?1049h",
    "\x1b[?2004h",
    "\x1b[?2004l",
    "\x1b[?1049l",
    "\x1b[?25h",
)


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
        fcntl.ioctl(descriptor, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        if not os.isatty(descriptor):
            self.terminate()
            raise RuntimeError("POSIX PTY master is not a terminal.")

    def read(self) -> str:
        try:
            return os.read(self.descriptor, 4096).decode("utf-8", errors="replace")
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
        if not self.alive():
            return
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
        try:
            from winpty import Backend, PtyProcess
        except ImportError as error:
            raise RuntimeError("pywinpty is required for the Windows ConPTY smoke.") from error
        self.process = PtyProcess.spawn(
            command,
            cwd=str(cwd),
            env=env,
            dimensions=(30, 100),
            backend=Backend.ConPTY,
        )

    def read(self) -> str:
        return self.process.read(4096)

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


def escaped_tail(transcript: str, limit: int = 4_000) -> str:
    return transcript[-limit:].encode("unicode_escape", errors="backslashreplace").decode("ascii")


def contains_ready_frame(transcript: str) -> bool:
    """Match text painted in separate cursor-positioned OpenTUI spans."""
    cursor = max(0, transcript.rfind(READY_TOKENS[0]))
    start = cursor
    for token in READY_TOKENS:
        cursor = transcript.find(token, cursor)
        if cursor < 0 or cursor - start > 20_000:
            return False
        cursor += len(token)
    return True


def exercise(terminal: Terminal, timeout: float) -> tuple[int, str]:
    chunks: queue.Queue[str | None] = queue.Queue()
    thread = threading.Thread(target=reader, args=(terminal, chunks), daemon=True)
    thread.start()
    transcript = ""
    sent_quit = False
    reader_done = False
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            try:
                chunk = chunks.get(timeout=0.05)
                if chunk is None:
                    reader_done = True
                else:
                    transcript += chunk
                    if len(transcript) > 2_000_000:
                        raise RuntimeError("TUI emitted more than 2 MB during the /quit smoke.")
            except queue.Empty:
                pass
            if not sent_quit and contains_ready_frame(transcript):
                terminal.write("/quit\r")
                sent_quit = True
            if not terminal.alive() and reader_done:
                break
        else:
            raise TimeoutError(f"TUI did not exit within {timeout:.0f}s; output={escaped_tail(transcript)}")
        return terminal.wait(), transcript
    finally:
        if terminal.alive():
            terminal.terminate()
        terminal.close()
        thread.join(timeout=1)


def isolated_environment(home: Path, state_home: Path) -> dict[str, str]:
    env = os.environ.copy()
    env.update({
        "CI": "1",
        "HOME": str(home),
        "USERPROFILE": str(home),
        "SIGMA_STATE_HOME": str(state_home),
        "NO_COLOR": "1",
        "SIGMA_NO_COLOR": "1",
        "TERM": "xterm-256color",
    })
    for key in ("DEEPSEEK_API_KEY", "ZAI_API_KEY", "GLM_API_KEY", "BIGMODEL_API_KEY"):
        env.pop(key, None)
    return env


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=root)
    parser.add_argument("--node", type=Path, default=Path(shutil.which("node") or "node"))
    parser.add_argument("--cli", type=Path, default=root / "packages" / "agent-cli" / "dist" / "index.js")
    parser.add_argument("--timeout", type=float, default=30)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = args.root.resolve()
    node = args.node.resolve()
    cli = args.cli.resolve()
    if not node.is_file() or not cli.is_file():
        raise FileNotFoundError(f"Missing smoke entry: node={node}, cli={cli}")
    with tempfile.TemporaryDirectory(prefix="sigma-tui-terminal-") as temporary:
        temporary_path = Path(temporary)
        workspace = temporary_path / "workspace"
        home = temporary_path / "home"
        state_home = temporary_path / "state"
        workspace.mkdir()
        home.mkdir()
        command = [str(node), "--experimental-ffi", "--disable-warning=ExperimentalWarning", str(cli), "tui", "--workspace", str(workspace), "--permission-mode", "deny"]
        terminal = terminal_for(command, root, isolated_environment(home, state_home))
        code, transcript = exercise(terminal, args.timeout)
        missing = [marker for marker in REQUIRED_MARKERS if marker not in transcript]
        ready = contains_ready_frame(transcript)
        if code != 0 or not ready or missing or not (state_home / "workspaces").is_dir():
            raise RuntimeError(
                f"TUI terminal smoke failed: exit={code}, ready={ready}, "
                f"missing={missing}, store={(state_home / 'workspaces').is_dir()}, output={escaped_tail(transcript)}"
            )
        print(f"PASS real terminal /quit smoke backend={terminal.backend} bytes={len(transcript.encode('utf-8'))}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL real terminal /quit smoke: {error}", file=sys.stderr)
        raise
