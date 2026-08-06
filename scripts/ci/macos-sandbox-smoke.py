#!/usr/bin/env python3
"""Native macOS Seatbelt, PTY, network, timeout, and process-tree smoke test."""

import argparse
import hashlib
import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import time
from pathlib import Path


class Broker:
    def __init__(self, executable: Path) -> None:
        environment = dict(os.environ)
        environment["SIGMA_TEST_API_TOKEN"] = "must-not-reach-sandbox"
        self.process = subprocess.Popen(
            [str(executable)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )
        self.request_id = 0

    def request(self, method: str, params: dict | None = None) -> dict:
        self.request_id += 1
        request = json.dumps({
            "protocolVersion": 1,
            "requestId": self.request_id,
            "method": method,
            "params": params or {},
        }, separators=(",", ":")).encode()
        assert self.process.stdin and self.process.stdout
        self.process.stdin.write(struct.pack(">I", len(request)) + request)
        self.process.stdin.flush()
        header = self.process.stdout.read(4)
        if len(header) != 4:
            stderr = self.process.stderr.read().decode() if self.process.stderr else ""
            raise RuntimeError(f"sigma-exec closed before returning a response: {stderr}")
        return json.loads(self.process.stdout.read(struct.unpack(">I", header)[0]))

    def close(self) -> None:
        if self.process.poll() is not None:
            return
        try:
            self.request("shutdown")
            self.process.wait(timeout=5)
        finally:
            if self.process.poll() is None:
                self.process.kill()


def require_ok(response: dict) -> dict:
    if not response.get("ok"):
        raise RuntimeError(f"broker request failed: {response}")
    return response["result"]


def output_text(result: dict, stream: str = "stdout") -> str:
    value = result.get(stream, "")
    return value.get("data", "") if isinstance(value, dict) else str(value)


def request_params(root: Path, command: str, *, network: str = "none", approved: bool = False,
                   pty: bool = False, write_workspace: bool = False) -> dict:
    return {
        "command": {
            "executable": "/bin/zsh",
            "args": ["-f", "-c", command],
            "cwd": str(root),
            "env": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"},
        },
        "policy": {
            "sandbox": "required",
            "network": network,
            "networkApproved": approved,
            "readRoots": [str(root)],
            "writeRoots": [str(root if write_workspace else root / "out")],
            "protectedPaths": [str(root / ".git"), str(root / ".agent")],
        },
        "maxOutputBytes": 65536,
        "pty": pty,
        "ptyColumns": 100,
        "ptyRows": 25,
    }


def poll_until_settled(broker: Broker, handle_id: str) -> dict:
    for _ in range(200):
        result = require_ok(broker.request("process.poll", {
            "handleId": handle_id, "stdoutOffset": 0, "stderrOffset": 0,
        }))
        if result["state"] != "running":
            return result
        time.sleep(0.05)
    raise RuntimeError("process did not settle")


def sha256_file(file_path: Path) -> str:
    return hashlib.sha256(file_path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--broker", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    workspace = Path(tempfile.mkdtemp(prefix="sigma-macos-sandbox-ci-"))
    outside = Path(tempfile.mkdtemp(prefix="sigma-macos-sandbox-outside-"))
    broker = Broker(args.broker.resolve())
    listener: socket.socket | None = None
    try:
        for directory in (workspace / ".git", workspace / ".agent", workspace / "out"):
            directory.mkdir()
        (outside / "secret.txt").write_text("host-secret", encoding="utf-8")

        setup = require_ok(broker.request("sandbox.setup"))
        if setup.get("platform") != "macos" or setup.get("architecture") != "aarch64":
            raise RuntimeError(f"unexpected broker target: {setup}")
        sandbox = setup.get("sandbox", {})
        capabilities = setup.get("capabilities", {})
        shells = capabilities.get("shells") or []
        if (sandbox.get("backend") != "seatbelt+sandbox-exec+forkpty"
                or not sandbox.get("available") or not sandbox.get("selfTestPassed")):
            raise RuntimeError(f"required macOS Seatbelt self-test failed: {setup}")
        enclosing_container = capabilities.get("enclosingContainerRoot") or {}
        if (not capabilities.get("pty") or capabilities.get("processHandoff")
                or enclosing_container.get("available")):
            raise RuntimeError(f"macOS capability boundary is incorrect: {setup}")
        if capabilities.get("networkModes") != ["none", "full"]:
            raise RuntimeError(f"macOS network capability report is incorrect: {setup}")
        if not any(shell.get("kind") == "zsh" and shell.get("verified") for shell in shells):
            raise RuntimeError(f"verified /bin/zsh is missing: {setup}")

        scoped = require_ok(broker.request("exec", {
            **request_params(workspace, "print -n allowed > out/allowed.txt; "
                                           "print -n escaped > escape.txt 2>/dev/null || true"),
            "timeoutMs": 10000,
        }))
        if scoped.get("exitCode") != 0 or not (workspace / "out" / "allowed.txt").exists():
            raise RuntimeError(f"declared write root failed: {scoped}")
        if (workspace / "escape.txt").exists():
            raise RuntimeError("sandbox wrote outside its declared write root")

        protected = require_ok(broker.request("exec", {
            **request_params(workspace, "print -n allowed > ordinary-write.txt; "
                                           "print -n no > .git/leak 2>/dev/null || true; "
                                           "print -n no > .agent/leak 2>/dev/null || true; "
                                           "test -z ${SIGMA_TEST_API_TOKEN:-}",
                             write_workspace=True),
            "timeoutMs": 10000,
        }))
        if protected.get("exitCode") != 0 or not (workspace / "ordinary-write.txt").exists() \
                or (workspace / ".git" / "leak").exists() \
                or (workspace / ".agent" / "leak").exists():
            raise RuntimeError(f"protected path or environment isolation failed: {protected}")

        outside_read = require_ok(broker.request("exec", {
            **request_params(workspace, f"cat {outside / 'secret.txt'}"), "timeoutMs": 10000,
        }))
        if outside_read.get("exitCode") == 0 or "host-secret" in output_text(outside_read):
            raise RuntimeError(f"host file outside read roots was exposed: {outside_read}")

        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(2)
        port = int(listener.getsockname()[1])
        no_network = require_ok(broker.request("exec", {
            **request_params(workspace, f"/usr/bin/nc -G 1 -z 127.0.0.1 {port}"),
            "timeoutMs": 5000,
        }))
        if no_network.get("exitCode") == 0:
            raise RuntimeError(f"network=none reached loopback: {no_network}")
        loopback = require_ok(broker.request("exec", {
            **request_params(workspace, f"/usr/bin/nc -G 1 -z 127.0.0.1 {port}", network="loopback"),
            "timeoutMs": 5000,
        }))
        if loopback.get("exitCode") != 0:
            raise RuntimeError(f"network=loopback could not reach loopback: {loopback}")
        if broker.request("exec", {
            **request_params(workspace, "true", network="full"), "timeoutMs": 5000,
        }).get("ok"):
            raise RuntimeError("network=full ran without per-call approval")
        full_network = require_ok(broker.request("exec", {
            **request_params(
                workspace,
                f"/usr/bin/nc -G 1 -z 127.0.0.1 {port}",
                network="full",
                approved=True,
            ),
            "timeoutMs": 5000,
        }))
        if full_network.get("exitCode") != 0:
            raise RuntimeError(f"approved network=full could not reach loopback: {full_network}")

        pty = require_ok(broker.request("process.spawn", request_params(
            workspace, "test -t 0 && test -t 1 && print -n sigma-macos-pty-ok", pty=True,
        )))
        pty_result = poll_until_settled(broker, pty["handleId"])
        if "sigma-macos-pty-ok" not in output_text(pty_result):
            raise RuntimeError(f"PTY output missing: {pty_result}")

        timed = require_ok(broker.request("exec", {
            **request_params(workspace, "sleep 5"), "timeoutMs": 200,
        }))
        if not timed.get("timedOut"):
            raise RuntimeError(f"timeout did not terminate the command: {timed}")

        tree = require_ok(broker.request("process.spawn", request_params(
            workspace, "(sleep 1; print -n leaked > out/leak.txt) & sleep 30",
        )))
        time.sleep(0.2)
        require_ok(broker.request("process.terminate", {
            "handleId": tree["handleId"], "stdoutOffset": 0, "stderrOffset": 0,
        }))
        time.sleep(1.5)
        if (workspace / "out" / "leak.txt").exists():
            raise RuntimeError("process-group termination left a descendant alive")

        report = {
            "schemaVersion": 1,
            "ready": True,
            "targetPlatform": "darwin",
            "targetArch": "arm64",
            "minimumSystemVersion": "13.5",
            "brokerPath": str(args.broker.resolve()),
            "brokerSha256": sha256_file(args.broker.resolve()),
            "backend": sandbox["backend"],
            "checks": {
                "readWriteIsolation": True,
                "protectedPaths": True,
                "networkNoneLoopbackFull": True,
                "pty": True,
                "timeout": True,
                "processGroupTermination": True,
                "processHandoffDisabled": True,
            },
        }
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
        return 0
    finally:
        if listener:
            listener.close()
        broker.close()
        shutil.rmtree(workspace, ignore_errors=True)
        shutil.rmtree(outside, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
