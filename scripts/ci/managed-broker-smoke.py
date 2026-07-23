#!/usr/bin/env python3
"""Exercise the fixed managed broker protocol without benchmark inputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import struct
from typing import Any


def stable_sha256(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def verify_attestation(socket_path: str) -> None:
    boundary = os.path.dirname(socket_path)
    attestation_path = os.path.join(boundary, "attestation.json")
    with open(attestation_path, "r", encoding="utf-8") as handle:
        attestation = json.load(handle)
    payload = {
        "protocolVersion": attestation["protocolVersion"],
        "engine": attestation["engine"],
        "selector": attestation["selector"],
        "targetId": attestation["targetId"],
        "targetStartedAt": attestation["targetStartedAt"],
        "imageId": attestation["imageId"],
        "imageDigest": attestation.get("imageDigest"),
        "labelsDigest": attestation["labelsDigest"],
        "helperDigest": attestation["helperDigest"],
    }
    assert attestation["attestationDigest"] == stable_sha256(payload)
    proof = dict(attestation["managedEnvironment"])
    proof_digest = proof.pop("proofDigest")
    assert proof_digest == stable_sha256(proof)
    assert proof["targetAttestationDigest"] == attestation["attestationDigest"]
    for path, forbidden in ((boundary, 0o022), (attestation_path, 0o222), (socket_path, 0o002)):
        status = os.lstat(path)
        assert status.st_uid == 0
        assert status.st_mode & forbidden == 0


class Broker:
    def __init__(self, socket_path: str) -> None:
        self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._socket.connect(socket_path)
        self._next_id = 1

    def close(self) -> None:
        self._socket.close()

    def request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        request_id = self._next_id
        self._next_id += 1
        payload = json.dumps(
            {
                "protocolVersion": 1,
                "requestId": request_id,
                "method": method,
                "params": params or {},
            },
            separators=(",", ":"),
        ).encode("utf-8")
        self._socket.sendall(struct.pack(">I", len(payload)) + payload)
        header = self._read_exact(4)
        length = struct.unpack(">I", header)[0]
        response = json.loads(self._read_exact(length))
        if response.get("requestId") != request_id:
            raise RuntimeError("managed broker response requestId mismatch")
        if response.get("ok") is not True:
            raise RuntimeError(f"managed broker request failed: {response.get('error')}")
        return response.get("result")

    def _read_exact(self, length: int) -> bytes:
        output = bytearray()
        while len(output) < length:
            chunk = self._socket.recv(length - len(output))
            if not chunk:
                raise RuntimeError("managed broker socket closed before a complete frame")
            output.extend(chunk)
        return bytes(output)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--session", default="managed-smoke")
    parser.add_argument("--executable")
    parser.add_argument("--package", action="append", default=[])
    args = parser.parse_args()
    if bool(args.executable) != bool(args.package):
        parser.error("--executable and at least one --package must be supplied together")

    verify_attestation(args.socket)
    broker = Broker(args.socket)
    try:
        hello = broker.request("hello")
        doctor = broker.request("doctor")
        assert hello["protocolVersion"] == 1
        assert doctor["container"]["backend"] == "oci"
        assert doctor["container"]["target"] == "managed"
        assert doctor["capabilities"]["managedEnvironment"] == {
            "available": True,
            "prepare": True,
        }
        before_data = doctor["capabilities"]["runtimeDataDigest"]
        scratch = broker.request(
            "scratch.acquire",
            {"protocolVersion": 1, "sessionId": args.session},
        )
        if args.executable:
            prepared = broker.request(
                "environment.prepare",
                {
                    "protocolVersion": 1,
                    "sessionId": args.session,
                    "requestedExecutable": args.executable,
                    "packages": args.package,
                },
            )
            assert prepared["status"] == "prepared"
            assert prepared["runtimeClosure"]["runtimeDataDigest"] != before_data
            refreshed = broker.request("doctor")
            assert refreshed["capabilities"]["runtimeDataDigest"] == prepared["runtimeClosure"]["runtimeDataDigest"]
        broker.request(
            "scratch.release",
            {
                "protocolVersion": 1,
                "sessionId": args.session,
                "leaseId": scratch["leaseId"],
            },
        )
        broker.request("shutdown")
    finally:
        broker.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
