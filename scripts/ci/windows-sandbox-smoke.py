#!/usr/bin/env python3
"""Real Windows AppContainer/ConPTY/Job Object release smoke test."""

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import tempfile
import time
from pathlib import Path


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Broker:
    def __init__(self, executable: Path) -> None:
        self.process = subprocess.Popen(
            [str(executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        self.request_id = 0

    def request(self, method: str, params: dict | None = None) -> dict:
        self.request_id += 1
        request = json.dumps(
            {
                "protocolVersion": 1,
                "requestId": self.request_id,
                "method": method,
                "params": params or {},
            },
            separators=(",", ":"),
        ).encode()
        assert self.process.stdin and self.process.stdout
        self.process.stdin.write(struct.pack(">I", len(request)) + request)
        self.process.stdin.flush()
        header = self.process.stdout.read(4)
        if len(header) != 4:
            raise RuntimeError("sigma-exec closed before returning a response")
        response = json.loads(self.process.stdout.read(struct.unpack(">I", header)[0]))
        return response

    def close(self) -> None:
        if self.process.poll() is not None:
            return
        try:
            self.request("shutdown")
            self.process.wait(timeout=5)
        finally:
            if self.process.poll() is None:
                self.process.kill()


def environment() -> dict[str, str]:
    return {
        key: os.environ[key]
        for key in ("SystemRoot", "WINDIR", "PATH", "PATHEXT", "ComSpec")
        if key in os.environ
    }


def params(root: Path, command: str, *, pty: bool = False) -> dict:
    return {
        "command": {
            "executable": os.environ["COMSPEC"],
            "args": ["/d", "/s", "/c", command],
            "cwd": str(root),
            "env": environment(),
        },
        "policy": {
            "sandbox": "required",
            "network": "none",
            "networkApproved": False,
            "readRoots": [str(root)],
            "writeRoots": [str(root / "out")],
            "protectedPaths": [str(root / ".git"), str(root / ".agent")],
            "unsafeHostExecApproved": False,
        },
        "maxOutputBytes": 65536,
        "pty": pty,
        "ptyColumns": 100,
        "ptyRows": 25,
    }


def node_params(root: Path, node: Path, node_args: list[str]) -> dict:
    request = params(root, "")
    request["command"] = {
        "executable": str(node),
        "args": node_args,
        "cwd": str(root),
        "env": environment(),
    }
    request["policy"]["readRoots"] = [str(root), str(node.parent.parent)]
    request["policy"]["writeRoots"] = []
    return request


def require_ok(response: dict) -> dict:
    if not response.get("ok"):
        raise RuntimeError(f"broker request failed: {response}")
    return response["result"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--broker", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output:
        args.output.unlink(missing_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="sigma-windows-sandbox-ci-"))
    external = Path(tempfile.mkdtemp(prefix="sigma-windows-sandbox-external-"))
    node = args.node.resolve()
    if not node.is_file():
        raise RuntimeError(f"bundled Node executable is missing: {node}")
    broker = Broker(args.broker.resolve())
    try:
        for directory in (workspace / ".git", workspace / ".agent", workspace / "out"):
            directory.mkdir()
        setup = require_ok(broker.request("sandbox.setup"))
        if not setup["sandbox"]["available"] or not setup["sandbox"]["selfTestPassed"]:
            raise RuntimeError(f"required sandbox self-test failed: {setup}")
        hardening = setup["sandbox"].get("hardening") or {}
        if not hardening.get("lessPrivilegedAppContainer"):
            raise RuntimeError(f"LPAC token self-test failed: {setup}")

        node_version = require_ok(
            broker.request("exec", {**node_params(workspace, node, ["--version"]), "timeoutMs": 10000})
        )
        if node_version["exitCode"] != 0 or not node_version["stdout"]["data"].startswith("v"):
            raise RuntimeError(f"bundled Node failed to initialize inside LPAC: {node_version}")
        node_boundary_script = r"""
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
let workspaceDenied = false;
try {
  fs.writeFileSync(path.join(process.cwd(), "node-write-escape.txt"), "denied");
} catch (error) {
  workspaceDenied = error && ["EACCES", "EPERM"].includes(error.code);
}
const temporary = path.join(os.tmpdir(), `sigma-node-temp-${process.pid}`);
fs.writeFileSync(temporary, "ok");
const tempWritable = fs.readFileSync(temporary, "utf8") === "ok";
fs.unlinkSync(temporary);
const socket = net.connect({ host: "127.0.0.1", port: 9 });
socket.on("connect", () => process.exit(3));
socket.on("error", (error) => {
  const networkDenied = error && error.code === "EACCES";
  console.log(JSON.stringify({ tempWritable, workspaceDenied, networkDenied }));
  process.exit(tempWritable && workspaceDenied && networkDenied ? 0 : 2);
});
setTimeout(() => process.exit(4), 3000);
""".strip()
        node_boundary = require_ok(
            broker.request(
                "exec",
                {
                    **node_params(workspace, node, ["-e", node_boundary_script]),
                    "timeoutMs": 10000,
                },
            )
        )
        node_boundary_output = node_boundary["stdout"]["data"]
        if node_boundary["exitCode"] != 0 or '"networkDenied":true' not in node_boundary_output:
            raise RuntimeError(f"bundled Node LPAC boundary failed: {node_boundary}")
        if (workspace / "node-write-escape.txt").exists():
            raise RuntimeError("bundled Node wrote to a read-only workspace")

        scoped = require_ok(
            broker.request(
                "exec",
                {
                    **params(
                        workspace,
                        "echo allowed>out\\allowed.txt & (echo escaped>escape.txt) 2>nul & exit /b 0",
                    ),
                    "timeoutMs": 10000,
                },
            )
        )
        if scoped["exitCode"] != 0 or not (workspace / "out" / "allowed.txt").exists():
            raise RuntimeError(f"declared write root failed: {scoped}")
        if (workspace / "escape.txt").exists():
            raise RuntimeError("AppContainer wrote outside its declared write root")

        junction = workspace / "linked-outside"
        subprocess.run(
            [os.environ["COMSPEC"], "/d", "/c", "mklink", "/J", str(junction), str(external)],
            check=True,
            capture_output=True,
        )
        escaped = params(workspace, "echo escaped>linked-outside\\escaped.txt")
        escaped["policy"]["writeRoots"] = [str(junction)]
        denied = broker.request("exec", {**escaped, "timeoutMs": 10000})
        if denied.get("ok") or (external / "escaped.txt").exists():
            raise RuntimeError(f"reparse-point write root was not rejected: {denied}")

        nested_escape = params(workspace, "echo escaped>linked-outside\\nested-escaped.txt")
        nested_escape["policy"]["writeRoots"] = [str(workspace)]
        nested_denied = broker.request("exec", {**nested_escape, "timeoutMs": 10000})
        if nested_denied.get("ok") or (external / "nested-escaped.txt").exists():
            raise RuntimeError(
                f"junction nested inside a writable root was not rejected before ACL changes: {nested_denied}"
            )

        non_git = workspace / "non-git"
        non_git.mkdir()
        non_git_request = params(
            non_git,
            "echo ordinary>ordinary.txt & "
            "(echo blocked>.git\\blocked.txt) 2>nul & "
            "(echo blocked>.agent\\blocked.txt) 2>nul & exit /b 0",
        )
        non_git_request["policy"]["writeRoots"] = [str(non_git)]
        non_git_result = require_ok(
            broker.request("exec", {**non_git_request, "timeoutMs": 10000})
        )
        if non_git_result["exitCode"] != 0 or not (non_git / "ordinary.txt").exists():
            raise RuntimeError(f"non-Git writable workspace failed: {non_git_result}")
        if (non_git / ".git" / "blocked.txt").exists() or (non_git / ".agent" / "blocked.txt").exists():
            raise RuntimeError("missing protected metadata path became writable in a non-Git workspace")
        if (non_git / ".git").exists() or (non_git / ".agent").exists():
            raise RuntimeError("transient protected-path guards were not cleaned after sandbox exit")

        pty = require_ok(
            broker.request("process.spawn", params(workspace, "echo sigma-conpty-release-ok", pty=True))
        )
        pty_output = ""
        for _ in range(50):
            polled = require_ok(
                broker.request(
                    "process.poll",
                    {"handleId": pty["handleId"], "stdoutOffset": 0, "stderrOffset": 0},
                )
            )
            pty_output = polled["stdout"]["data"]
            if polled["state"] != "running":
                break
            time.sleep(0.1)
        if "sigma-conpty-release-ok" not in pty_output:
            raise RuntimeError(f"ConPTY output missing: {pty_output!r}")

        tree = require_ok(
            broker.request(
                "process.spawn",
                params(
                    workspace,
                    'start "" /b cmd.exe /d /s /c "ping -n 4 127.0.0.1 >nul & echo leaked>out\\leak.txt" '
                    "& ping -n 20 127.0.0.1 >nul",
                ),
            )
        )
        time.sleep(0.3)
        require_ok(
            broker.request(
                "process.terminate",
                {"handleId": tree["handleId"], "stdoutOffset": 0, "stderrOffset": 0},
            )
        )
        time.sleep(4)
        if (workspace / "out" / "leak.txt").exists():
            raise RuntimeError("Job Object termination left a descendant process alive")

        crashed_tree = require_ok(
            broker.request(
                "process.spawn",
                params(
                    workspace,
                    'start "" /b cmd.exe /d /s /c "ping -n 4 127.0.0.1 >nul & echo leaked>out\\crash-leak.txt" '
                    "& ping -n 20 127.0.0.1 >nul",
                ),
            )
        )
        if not crashed_tree.get("handleId"):
            raise RuntimeError(f"broker-crash fixture did not start: {crashed_tree}")
        broker.process.kill()
        broker.process.wait(timeout=5)
        time.sleep(4)
        if (workspace / "out" / "crash-leak.txt").exists():
            raise RuntimeError("broker crash left a descendant process alive")
        report = {
            "schemaVersion": 1,
            "ready": True,
            "targetPlatform": "win32",
            "targetArch": "x64",
            "brokerPath": str(args.broker.resolve()),
            "brokerSha256": sha256_file(args.broker.resolve()),
            "bundledNodePath": str(node),
            "bundledNodeSha256": sha256_file(node),
            "backend": setup["sandbox"]["backend"],
            "hardening": hardening,
            "nodeLpac": {
                "version": node_version["stdout"]["data"].strip(),
                "tempWritable": True,
                "workspaceReadOnly": True,
                "networkDenied": True,
            },
        }
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
        return 0
    finally:
        broker.close()
        shutil.rmtree(workspace, ignore_errors=True)
        shutil.rmtree(external, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
