#!/usr/bin/env python3
"""Real Linux namespace/Landlock/seccomp/PTY/process-tree release smoke test."""

import argparse
import hashlib
import json
import os
import shutil
import signal
import socket
import stat
import struct
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_tree_fingerprint(root: Path) -> str:
    """Hash a workspace tree without following symbolic links."""
    digest = hashlib.sha256()

    def visit(path: Path) -> None:
        info = path.lstat()
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(struct.pack(">I", len(relative)))
        digest.update(relative)
        digest.update(struct.pack(">I", info.st_mode))
        if stat.S_ISLNK(info.st_mode):
            digest.update(os.readlink(path).encode("utf-8"))
        elif stat.S_ISREG(info.st_mode):
            digest.update(path.read_bytes())
        elif stat.S_ISDIR(info.st_mode):
            for child in sorted(path.iterdir(), key=lambda item: item.name):
                visit(child)

    visit(root)
    return digest.hexdigest()


class Broker:
    def __init__(self, executable: Path) -> None:
        environment = dict(os.environ)
        environment["SIGMA_TEST_API_TOKEN"] = "must-not-reach-sandbox"
        self.process = subprocess.Popen(
            [str(executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=environment
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
            raise RuntimeError("sigma-exec closed before returning a response")
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


def params(root: Path, command: str, *, pty: bool = False) -> dict:
    return {
        "command": {
            "executable": "/bin/bash",
            "args": ["--noprofile", "--norc", "-c", command],
            "cwd": str(root),
            "env": {"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"},
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


def require_ok(response: dict) -> dict:
    if not response.get("ok"):
        raise RuntimeError(f"broker request failed: {response}")
    return response["result"]


def output_text(result: dict, stream: str = "stdout") -> str:
    value = result.get(stream, "")
    return value.get("data", "") if isinstance(value, dict) else str(value)


def poll_until_settled(broker: Broker, handle_id: str) -> dict:
    result: dict = {}
    for _ in range(100):
        result = require_ok(broker.request("process.poll", {
            "handleId": handle_id, "stdoutOffset": 0, "stderrOffset": 0
        }))
        if result["state"] != "running":
            return result
        time.sleep(0.05)
    raise RuntimeError(f"process did not settle: {result}")


def available_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def wait_for_http(url: str, expected: str, failure_path: Path | None = None) -> None:
    last_error: Exception | None = None
    for _ in range(100):
        try:
            with urllib.request.urlopen(url, timeout=0.25) as response:
                body = response.read().decode("utf-8")
            if body == expected:
                return
            last_error = RuntimeError(f"unexpected HTTP body: {body!r}")
        except Exception as error:  # noqa: BLE001 - retain the final probe cause
            last_error = error
        time.sleep(0.05)
    failure = failure_path.read_text(encoding="utf-8") if failure_path and failure_path.exists() else None
    raise RuntimeError(
        f"deliverable service did not become healthy: {last_error}"
        f"{f'; service error: {failure}' if failure else ''}"
    )


def verify_dangling_read_only_conformance(
    broker: Broker, workspace: Path, external: Path
) -> dict:
    root = workspace / "dangling-read-conformance"
    target_parent = external / "removed-targets"
    outside = external / "read-only-outside"
    outside_link = root / "outside-link"
    dangling: list[Path] = []
    root.mkdir()
    target_parent.mkdir()
    outside.mkdir()
    (root / "ordinary.txt").write_text("ordinary read-only content\n", encoding="utf-8")
    (outside / "secret.txt").write_text("outside\n", encoding="utf-8")
    outside_link.symlink_to(outside, target_is_directory=True)
    try:
        for seed in range(100):
            branch = root / f"case-{seed:03d}"
            depth = (seed * 37 % 5) + 1
            for level in range(depth):
                branch /= f"level-{(seed * 17 + level) % 23:02d}"
            branch.mkdir(parents=True)
            (branch / f"visible-{seed:03d}.txt").write_text(
                f"seed={seed}\n", encoding="utf-8"
            )
            target = target_parent / f"target-{seed:03d}"
            link = branch / f"unavailable-{seed:03d}"
            target.mkdir()
            link.symlink_to(target, target_is_directory=True)
            target.rmdir()
            dangling.append(link)

        before = read_tree_fingerprint(root)
        request = params(
            root,
            "test \"$(cat ordinary.txt)\" = \"ordinary read-only content\" "
            "&& ! cat outside-link/secret.txt >/dev/null 2>&1",
        )
        request["policy"]["writeRoots"] = []
        spawned = require_ok(broker.request("process.spawn", request))
        settled = poll_until_settled(broker, spawned["handleId"])
        if settled.get("exitCode") != 0:
            raise RuntimeError(
                "dangling symlink descendants blocked an unrelated read-only process or "
                f"exposed an outside target: {settled}"
            )

        direct = params(root, "true")
        direct["policy"]["writeRoots"] = []
        direct["policy"]["readRoots"].append(str(dangling[37]))
        direct_result = broker.request("exec", {**direct, "timeoutMs": 10000})
        if direct_result.get("ok"):
            raise RuntimeError(
                "a dangling symlink declared as a read root was not rejected: "
                f"{direct_result}"
            )
        if read_tree_fingerprint(root) != before:
            raise RuntimeError("read-only symlink conformance mutated workspace content")
        if (outside / "secret.txt").read_text(encoding="utf-8") != "outside\n":
            raise RuntimeError("read-only symlink conformance mutated the outside target")
        return {
            "deterministicSeeds": 100,
            "unrelatedSpawn": True,
            "outsideReadDenied": True,
            "directDanglingRootRejected": True,
            "workspaceUnchanged": True,
            "processSettled": True,
        }
    finally:
        for link in dangling:
            link.unlink(missing_ok=True)
        outside_link.unlink(missing_ok=True)
        shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--broker", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output:
        args.output.unlink(missing_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="sigma-linux-sandbox-ci-"))
    external = Path(tempfile.mkdtemp(prefix="sigma-linux-sandbox-external-"))
    broker = Broker(args.broker.resolve())
    handed_off_process_id: int | None = None
    try:
        for directory in (workspace / ".git", workspace / ".agent", workspace / "out"):
            directory.mkdir()
        (external / "secret.txt").write_text("host-secret", encoding="utf-8")
        setup = require_ok(broker.request("sandbox.setup"))
        hardening = setup["sandbox"].get("hardening") or {}
        if (
            not setup["sandbox"]["available"]
            or not setup["sandbox"]["selfTestPassed"]
            or int(hardening.get("landlockAbi") or 0) < 3
            or not hardening.get("noNewPrivileges")
            or not hardening.get("seccompFilter")
        ):
            raise RuntimeError(f"required Linux hardening self-test failed: {setup}")
        if setup.get("capabilities", {}).get("processHandoff") is not True:
            raise RuntimeError(f"Linux broker did not advertise process handoff: {setup}")

        dangling_read_conformance = verify_dangling_read_only_conformance(
            broker, workspace, external
        )

        scoped = require_ok(broker.request("exec", {
            **params(workspace, "printf allowed > out/allowed.txt; printf escaped > escape.txt || true"),
            "timeoutMs": 10000,
        }))
        if scoped["exitCode"] != 0 or not (workspace / "out" / "allowed.txt").exists():
            raise RuntimeError(f"declared write root failed: {scoped}")
        if (workspace / "escape.txt").exists():
            raise RuntimeError("sandbox wrote outside its declared write root")

        linked = workspace / "linked-outside"
        linked.symlink_to(external, target_is_directory=True)
        escaped = params(workspace, "printf escaped > linked-outside/escaped.txt")
        escaped["policy"]["writeRoots"] = [str(linked)]
        denied = broker.request("exec", {**escaped, "timeoutMs": 10000})
        if denied.get("ok") or (external / "escaped.txt").exists():
            raise RuntimeError(f"symbolic-link write root was not rejected: {denied}")

        outside_read = require_ok(broker.request("exec", {
            **params(workspace, f"cat {external / 'secret.txt'}"), "timeoutMs": 10000
        }))
        if outside_read["exitCode"] == 0 or "host-secret" in output_text(outside_read):
            raise RuntimeError(f"host file outside read roots was exposed: {outside_read}")

        protected = require_ok(broker.request("exec", {
            **params(workspace, "printf no > .git/leak 2>/dev/null || true; "
                                 "printf no > .agent/leak 2>/dev/null || true; "
                                 "test -z \"${SIGMA_TEST_API_TOKEN:-}\""),
            "timeoutMs": 10000,
        }))
        if protected["exitCode"] != 0 or (workspace / ".git" / "leak").exists() \
                or (workspace / ".agent" / "leak").exists():
            raise RuntimeError(f"protected path or environment isolation failed: {protected}")

        network = require_ok(broker.request("exec", {
            **params(workspace, "timeout 2 bash -c 'printf x > /dev/tcp/1.1.1.1/80'"),
            "timeoutMs": 10000,
        }))
        if network["exitCode"] == 0:
            raise RuntimeError(f"network namespace allowed an unapproved connection: {network}")

        unapproved_network = params(workspace, "true")
        unapproved_network["policy"]["network"] = "full"
        if broker.request("exec", {**unapproved_network, "timeoutMs": 10000}).get("ok"):
            raise RuntimeError("full network ran without per-call approval")

        pty = require_ok(broker.request(
            "process.spawn", params(workspace, "printf sigma-linux-pty-ok", pty=True)
        ))
        pty_result = poll_until_settled(broker, pty["handleId"])
        if "sigma-linux-pty-ok" not in output_text(pty_result):
            raise RuntimeError(f"PTY output missing: {pty_result}")

        tree = require_ok(broker.request("process.spawn", params(
            workspace, "(sleep 2; printf leaked > out/leak.txt) & sleep 30"
        )))
        time.sleep(0.3)
        require_ok(broker.request("process.terminate", {
            "handleId": tree["handleId"], "stdoutOffset": 0, "stderrOffset": 0
        }))
        time.sleep(3)
        if (workspace / "out" / "leak.txt").exists():
            raise RuntimeError("process-group termination left a descendant alive")

        service_content = "sigma-deliverable-ready\n"
        (workspace / "out" / "index.html").write_text(service_content, encoding="utf-8")
        service_error = workspace / "out" / "service-error.txt"
        service_port = available_loopback_port()
        service_request = params(
            workspace,
            f"/usr/bin/python3 -m http.server {service_port} --bind 127.0.0.1 --directory out "
            f"|| printf 'python-exit=%s' $? > out/service-error.txt",
        )
        service_request["lifecycle"] = "deliverable"
        service_request["policy"]["network"] = "full"
        service_request["policy"]["networkApproved"] = True
        service_request["policy"]["writeRoots"] = [str(workspace / "out")]
        service = require_ok(broker.request("process.spawn", service_request))
        service_url = f"http://127.0.0.1:{service_port}/index.html"
        wait_for_http(service_url, service_content, service_error)
        handed_off = require_ok(broker.request("process.handoff", {
            "handleId": service["handleId"]
        }))
        handed_off_process_id = int(handed_off["processId"])

        crashed_tree = require_ok(broker.request("process.spawn", params(
            workspace, "(sleep 2; printf leaked > out/crash-leak.txt) & sleep 30"
        )))
        if not crashed_tree.get("handleId"):
            raise RuntimeError(f"broker-crash fixture did not start: {crashed_tree}")
        broker.process.kill()
        broker.process.wait(timeout=5)
        time.sleep(3)
        if (workspace / "out" / "crash-leak.txt").exists():
            raise RuntimeError("broker crash left a descendant process alive")
        wait_for_http(service_url, service_content)

        report = {
            "schemaVersion": 1,
            "ready": True,
            "targetPlatform": "linux",
            "targetArch": "x64",
            "brokerPath": str(args.broker.resolve()),
            "brokerSha256": sha256_file(args.broker.resolve()),
            "backend": setup["sandbox"]["backend"],
            "hardening": hardening,
            "danglingReadConformance": dangling_read_conformance,
            "processHandoff": {
                "advertised": True,
                "healthCheckedBefore": True,
                "survivedBrokerExit": True,
            },
        }
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
        return 0
    finally:
        broker.close()
        if handed_off_process_id is not None:
            try:
                os.killpg(handed_off_process_id, signal.SIGKILL)
            except ProcessLookupError:
                pass
        shutil.rmtree(workspace, ignore_errors=True)
        shutil.rmtree(external, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
