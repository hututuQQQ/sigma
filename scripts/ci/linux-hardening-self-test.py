#!/usr/bin/env python3
"""Run the native broker's real bubblewrap/Landlock/seccomp self-test."""

import argparse
import json
import struct
import subprocess
from pathlib import Path


def request(process: subprocess.Popen[bytes], request_id: int, method: str) -> dict:
    payload = json.dumps({
        "protocolVersion": 1,
        "requestId": request_id,
        "method": method,
        "params": {},
    }, separators=(",", ":")).encode()
    assert process.stdin and process.stdout
    process.stdin.write(struct.pack(">I", len(payload)) + payload)
    process.stdin.flush()
    header = process.stdout.read(4)
    if len(header) != 4:
        raise RuntimeError("sigma-exec closed before returning the hardening report")
    return json.loads(process.stdout.read(struct.unpack(">I", header)[0]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--broker", required=True, type=Path)
    args = parser.parse_args()
    process = subprocess.Popen(
        [str(args.broker.resolve())],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        setup = request(process, 1, "sandbox.setup")
        if not setup.get("ok"):
            raise RuntimeError(f"sandbox.setup failed: {setup}")
        sandbox = setup["result"]["sandbox"]
        hardening = sandbox.get("hardening") or {}
        required = [
            "noNewPrivileges", "seccompFilter", "mountNamespace",
            "pidNamespace", "networkNamespace",
        ]
        if not sandbox.get("available") or not sandbox.get("selfTestPassed") \
                or not isinstance(hardening.get("landlockAbi"), int) \
                or hardening["landlockAbi"] <= 0 \
                or not all(hardening.get(name) is True for name in required):
            raise RuntimeError(f"required Linux hardening assertions failed: {setup}")
        print("PASS real Linux hardening self-test")
        return 0
    finally:
        if process.poll() is None:
            try:
                request(process, 2, "shutdown")
                process.wait(timeout=5)
            except Exception:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
