#!/usr/bin/env python3
"""Real Windows AppContainer/ConPTY/Job Object release smoke test."""

import argparse
import ctypes
import hashlib
import json
import os
import shutil
import stat
import struct
import subprocess
import tempfile
import time
from pathlib import Path

NODE_LPAC_OPTIONS = "--preserve-symlinks --preserve-symlinks-main"


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_tree_fingerprint(root: Path) -> str:
    """Hash names, types, attributes, and file bytes without following reparse points."""
    digest = hashlib.sha256()

    def visit(path: Path) -> None:
        info = path.stat(follow_symlinks=False)
        attributes = getattr(info, "st_file_attributes", 0)
        is_reparse = bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(struct.pack(">I", len(relative)))
        digest.update(relative)
        digest.update(struct.pack(">II", stat.S_IFMT(info.st_mode), attributes))
        if stat.S_ISREG(info.st_mode) and not is_reparse:
            digest.update(path.read_bytes())
        if stat.S_ISDIR(info.st_mode) and not is_reparse:
            for child in sorted(path.iterdir(), key=lambda item: item.name):
                visit(child)

    visit(root)
    return digest.hexdigest()


def create_junction(link: Path, target: Path) -> None:
    subprocess.run(
        [os.environ["COMSPEC"], "/d", "/c", "mklink", "/J", str(link), str(target)],
        check=True,
        capture_output=True,
    )


def appcontainer_sid_string(profile_name: str) -> str:
    userenv = ctypes.WinDLL("userenv", use_last_error=True)
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    derive = userenv.DeriveAppContainerSidFromAppContainerName
    derive.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_void_p)]
    derive.restype = ctypes.c_long
    convert = advapi32.ConvertSidToStringSidW
    convert.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
    convert.restype = ctypes.c_int
    free_sid = advapi32.FreeSid
    free_sid.argtypes = [ctypes.c_void_p]
    free_sid.restype = ctypes.c_void_p
    local_free = kernel32.LocalFree
    local_free.argtypes = [ctypes.c_void_p]
    local_free.restype = ctypes.c_void_p
    sid = ctypes.c_void_p()
    result = derive(profile_name, ctypes.byref(sid))
    if result < 0 or not sid.value:
        raise RuntimeError(
            f"DeriveAppContainerSidFromAppContainerName failed for {profile_name}: 0x{result & 0xffffffff:08x}"
        )
    text = ctypes.c_wchar_p()
    try:
        if not convert(sid, ctypes.byref(text)) or not text.value:
            raise ctypes.WinError(ctypes.get_last_error())
        return text.value
    finally:
        if text:
            local_free(ctypes.cast(text, ctypes.c_void_p))
        free_sid(sid)


def acl_contains_sid(path: Path, sid: str) -> bool:
    result = subprocess.run(
        ["icacls", str(path)],
        check=False,
        capture_output=True,
        text=True,
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"icacls failed for recovery target {path}: {result.stderr}")
    return sid.lower() in result.stdout.lower()


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
    command_env = environment()
    command_env["NODE_OPTIONS"] = NODE_LPAC_OPTIONS
    request["command"] = {
        "executable": str(node),
        "args": node_args,
        "cwd": str(root),
        "env": command_env,
    }
    request["policy"]["readRoots"] = [str(root), str(node.parent.parent)]
    request["policy"]["writeRoots"] = []
    request["policy"]["executionRoots"] = [str(node.parent)]
    return request


def shell_node_params(root: Path, node: Path, node_args: str) -> dict:
    request = params(root, f"node {node_args}")
    command_env = environment()
    command_env["NODE_OPTIONS"] = NODE_LPAC_OPTIONS
    command_env["PATH"] = os.pathsep.join(
        [str(node.parent), command_env.get("PATH", "")]
    ).rstrip(os.pathsep)
    request["command"]["env"] = command_env
    request["policy"]["readRoots"] = [str(root), str(node.parent.parent)]
    request["policy"]["writeRoots"] = []
    request["policy"]["executionRoots"] = [str(node.parent)]
    return request


def require_ok(response: dict) -> dict:
    if not response.get("ok"):
        raise RuntimeError(f"broker request failed: {response}")
    return response["result"]


def poll_until_settled(broker: Broker, handle_id: str) -> dict:
    result: dict = {}
    for _ in range(300):
        result = require_ok(
            broker.request(
                "process.poll",
                {"handleId": handle_id, "stdoutOffset": 0, "stderrOffset": 0},
            )
        )
        if result["state"] != "running":
            return result
        time.sleep(0.05)
    raise RuntimeError(f"process did not settle: {result}")


def verify_dangling_read_only_conformance(
    broker: Broker,
    workspace: Path,
    external: Path,
    packages_directory: Path,
    preexisting_profiles: set[str],
) -> dict:
    root = workspace / "dangling-read-conformance"
    target_parent = external / "removed-targets"
    outside = external / "read-only-outside"
    ordinary = root / "ordinary.txt"
    outside_link = root / "outside-link"
    dangling: list[Path] = []
    root.mkdir()
    target_parent.mkdir()
    outside.mkdir()
    ordinary.write_text("ordinary read-only content\n", encoding="utf-8")
    (outside / "secret.txt").write_text("outside\n", encoding="utf-8")
    create_junction(outside_link, outside)
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
            create_junction(link, target)
            target.rmdir()
            dangling.append(link)

        before = read_tree_fingerprint(root)
        probe_request = params(
            root,
            "type ordinary.txt >nul && "
            "if exist outside-link\\secret.txt (exit /b 93) else (exit /b 0)",
        )
        probe_request["policy"]["writeRoots"] = []
        spawned = require_ok(broker.request("process.spawn", probe_request))
        probe = poll_until_settled(broker, spawned["handleId"])
        if probe["exitCode"] != 0:
            raise RuntimeError(
                "dangling descendants blocked an unrelated read-only process or exposed "
                f"an outside target: {probe}"
            )

        direct = params(root, "exit /b 0")
        direct["policy"]["writeRoots"] = []
        direct["policy"]["readRoots"].append(str(dangling[37]))
        direct_result = broker.request("exec", {**direct, "timeoutMs": 10000})
        direct_code = (direct_result.get("error") or {}).get("code")
        if direct_result.get("ok") or direct_code != "sandbox_reparse_target_unresolvable":
            raise RuntimeError(
                "a dangling junction declared as a read root did not fail with the stable code: "
                f"{direct_result}"
            )
        if read_tree_fingerprint(root) != before:
            raise RuntimeError("read-only reparse conformance mutated workspace content")
        if (outside / "secret.txt").read_text(encoding="utf-8") != "outside\n":
            raise RuntimeError("read-only reparse conformance mutated the outside target")

        leaked_profiles = [
            profile
            for profile in packages_directory.glob("sigmacode.exec.*")
            if profile.name.lower() not in preexisting_profiles
        ]
        if leaked_profiles:
            raise RuntimeError(
                f"read-only reparse conformance left AppContainer profiles: {leaked_profiles}"
            )
        return {
            "deterministicSeeds": 100,
            "unrelatedSpawn": True,
            "outsideReadDenied": True,
            "directDanglingRootStableCode": True,
            "workspaceUnchanged": True,
            "processSettled": True,
            "profilesRemoved": True,
        }
    finally:
        for link in dangling:
            try:
                os.rmdir(link)
            except FileNotFoundError:
                pass
        try:
            os.rmdir(outside_link)
        except FileNotFoundError:
            pass
        shutil.rmtree(root, ignore_errors=True)


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
    local_app_data = Path(os.environ["LOCALAPPDATA"])
    packages_directory = local_app_data / "Packages"
    preexisting_profiles = {
        profile.name.lower()
        for profile in packages_directory.glob("sigmacode.exec.*")
    }
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

        dangling_read_conformance = verify_dangling_read_only_conformance(
            broker,
            workspace,
            external,
            packages_directory,
            preexisting_profiles,
        )

        node_version = require_ok(
            broker.request("exec", {**node_params(workspace, node, ["--version"]), "timeoutMs": 10000})
        )
        if node_version["exitCode"] != 0 or not node_version["stdout"]["data"].startswith("v"):
            raise RuntimeError(f"bundled Node failed to initialize inside LPAC: {node_version}")
        shell_node_version = require_ok(
            broker.request(
                "exec",
                {**shell_node_params(workspace, node, "--version"), "timeoutMs": 10000},
            )
        )
        if shell_node_version["exitCode"] != 0 or not shell_node_version["stdout"]["data"].startswith("v"):
            raise RuntimeError(
                f"bundled Node was not resolvable through the authorized sandbox PATH: {shell_node_version}"
            )

        module_file = workspace / "runtime-smoke.mjs"
        module_file.write_text(
            "export const add = (left, right) => left + right;\n",
            encoding="utf-8",
        )
        test_file = workspace / "runtime-smoke.test.mjs"
        test_file.write_text(
            'import test from "node:test";\n'
            'import assert from "node:assert/strict";\n'
            'import { add } from "./runtime-smoke.mjs";\n'
            'test("bundled runtime", () => assert.equal(add(2, 2), 4));\n',
            encoding="utf-8",
        )
        node_test = require_ok(
            broker.request(
                "exec",
                {**node_params(workspace, node, ["--test", test_file.name]), "timeoutMs": 10000},
            )
        )
        if node_test["exitCode"] != 0 or "bundled runtime" not in node_test["stdout"]["data"]:
            raise RuntimeError(f"bundled Node test runner failed inside LPAC: {node_test}")

        child_script = (
            'const {spawnSync}=require("node:child_process");'
            'const child=spawnSync(process.execPath,'
            '["-e","process.stdout.write(\\"sigma-node-child-ok\\")"],{encoding:"utf8"});'
            'process.stdout.write(JSON.stringify({status:child.status,stdout:child.stdout,error:child.error?.code}));'
            'process.exit(child.status===0&&child.stdout==="sigma-node-child-ok"?0:2);'
        )
        node_child = require_ok(
            broker.request(
                "exec",
                {**node_params(workspace, node, ["-e", child_script]), "timeoutMs": 10000},
            )
        )
        if node_child["exitCode"] != 0 or "sigma-node-child-ok" not in node_child["stdout"]["data"]:
            raise RuntimeError(f"bundled Node child process failed inside LPAC: {node_child}")

        cjs_target = workspace / "runtime-entry-target"
        cjs_target.mkdir()
        cjs_entry = cjs_target / "runtime-entry.cjs"
        cjs_entry.write_text(
            'console.log(JSON.stringify({kind:"cjs",filename:__filename,main:require.main.filename}));\n',
            encoding="utf-8",
        )
        esm_entry = workspace / "runtime-entry.mjs"
        esm_entry.write_text(
            'console.log(JSON.stringify({kind:"esm",url:import.meta.url}));\n',
            encoding="utf-8",
        )
        linked_directory = workspace / "runtime-linked-main"
        subprocess.run(
            [os.environ["COMSPEC"], "/d", "/c", "mklink", "/J", str(linked_directory), str(cjs_target)],
            check=True,
            capture_output=True,
        )
        symlinked_entry = linked_directory / cjs_entry.name

        entry_reports = {}
        for kind, entry in (("cjs", cjs_entry), ("esm", esm_entry), ("symlink", symlinked_entry)):
            result = require_ok(
                broker.request(
                    "exec",
                    {
                        **node_params(workspace, node, [str(entry.relative_to(workspace))]),
                        "timeoutMs": 10000,
                    },
                )
            )
            if result["exitCode"] != 0:
                raise RuntimeError(f"bundled Node {kind} entry failed inside LPAC: {result}")
            try:
                entry_reports[kind] = json.loads(result["stdout"]["data"].strip())
            except json.JSONDecodeError as error:
                raise RuntimeError(f"bundled Node {kind} entry returned invalid JSON: {result}") from error
        if entry_reports["cjs"].get("kind") != "cjs" or entry_reports["esm"].get("kind") != "esm":
            raise RuntimeError(f"bundled Node CJS/ESM entry compatibility failed: {entry_reports}")
        linked_filename_parent = Path(entry_reports["symlink"].get("filename", "")).parent.name
        linked_main_parent = Path(entry_reports["symlink"].get("main", "")).parent.name
        if linked_filename_parent != linked_directory.name or linked_main_parent != linked_directory.name:
            raise RuntimeError(
                "trusted runtime constraint did not preserve the symlinked main path: "
                f"{entry_reports['symlink']}"
            )

        ipc_child_file = workspace / "runtime-ipc-child.cjs"
        ipc_child_file.write_text(
            '"use strict";\n'
            'const {execFileSync}=require("node:child_process");\n'
            'const containment=()=>JSON.parse(execFileSync(process.env.SIGMA_CONTAINMENT_PROBE,'
            '["--internal-appcontainer-containment-probe"],{encoding:"utf8"}));\n'
            'process.on("message",message=>{if(message?.type!=="ping")return;'
            'process.stdout.write("sigma-ipc-child-stdout");'
            'process.send?.({type:"pong",nonce:message.nonce,containment:containment()});'
            'process.disconnect();});\n',
            encoding="utf-8",
        )
        ipc_parent_script = r'''
const {execFileSync, fork} = require("node:child_process");
const path = require("node:path");
const containment = () => JSON.parse(execFileSync(
  process.env.SIGMA_CONTAINMENT_PROBE,
  ["--internal-appcontainer-containment-probe"],
  {encoding: "utf8"}
));
const parentContainment = containment();
let child;
try {
  child = fork(path.join(process.cwd(), "runtime-ipc-child.cjs"), [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    parentContainment,
    error: {code: error?.code, message: error?.message}
  }));
  process.exit(2);
}
let stdout = "";
let stderr = "";
let pong;
child.stdout.on("data", chunk => stdout += chunk);
child.stderr.on("data", chunk => stderr += chunk);
child.on("message", message => { if (message?.type === "pong") pong = message; });
child.on("error", error => { console.error(error); process.exit(3); });
child.on("close", code => {
  const contained = value => value?.isAppContainer && value?.tokenHasLpacAttribute && value?.inJob;
  const ok = code === 0
    && pong?.nonce === "sigma-ipc-nonce"
    && stdout === "sigma-ipc-child-stdout"
    && contained(parentContainment)
    && contained(pong?.containment);
  console.log(JSON.stringify({
    ok, code, stdout, stderr, parentContainment,
    childContainment: pong?.containment, pong: pong?.type
  }));
  process.exit(ok ? 0 : 2);
});
child.send({type: "ping", nonce: "sigma-ipc-nonce"});
setTimeout(() => { console.error("ipc timeout"); child.kill(); process.exit(4); }, 5000).unref();
'''.strip()
        ipc_request = node_params(workspace, node, ["-e", ipc_parent_script])
        broker_path = args.broker.resolve()
        ipc_request["command"]["env"]["SIGMA_CONTAINMENT_PROBE"] = str(broker_path)
        ipc_request["policy"]["readRoots"].append(str(broker_path))
        ipc_request["policy"]["executionRoots"].append(str(broker_path))
        ipc_result = require_ok(
            broker.request("exec", {**ipc_request, "timeoutMs": 10000})
        )
        try:
            ipc_report = json.loads(ipc_result["stdout"]["data"].strip())
        except json.JSONDecodeError as error:
            raise RuntimeError(f"bundled Node IPC returned invalid JSON: {ipc_result}") from error
        ipc_channel_available = ipc_result["exitCode"] == 0 and ipc_report.get("ok")
        ipc_unavailable_reason = None
        if not ipc_channel_available:
            ipc_error = ipc_report.get("error", {})
            if ipc_error.get("code") != "EPERM":
                raise RuntimeError(f"bundled Node IPC/containment failed inside LPAC: {ipc_result}")
            ipc_unavailable_reason = ipc_error.get("message", "spawn EPERM")
            stdio_child_file = workspace / "runtime-stdio-child.cjs"
            stdio_child_file.write_text(
                '"use strict";\n'
                'const {execFileSync}=require("node:child_process");\n'
                'const containment=()=>JSON.parse(execFileSync(process.env.SIGMA_CONTAINMENT_PROBE,'
                '["--internal-appcontainer-containment-probe"],{encoding:"utf8"}));\n'
                'let input="";process.stdin.setEncoding("utf8");'
                'process.stdin.on("data",chunk=>input+=chunk);'
                'process.stdin.on("end",()=>{const message=JSON.parse(input);'
                'process.stdout.write(JSON.stringify({type:"pong",nonce:message.nonce,'
                'stdout:"sigma-ipc-child-stdout",containment:containment()}));});\n',
                encoding="utf-8",
            )
            stdio_parent_script = r'''
const {execFileSync, spawn} = require("node:child_process");
const path = require("node:path");
const containment = () => JSON.parse(execFileSync(
  process.env.SIGMA_CONTAINMENT_PROBE,
  ["--internal-appcontainer-containment-probe"],
  {encoding: "utf8"}
));
const parentContainment = containment();
const child = spawn(process.execPath, [path.join(process.cwd(), "runtime-stdio-child.cjs")], {
  stdio: ["pipe", "pipe", "pipe"]
});
let stdout = "";
let stderr = "";
child.stdout.on("data", chunk => stdout += chunk);
child.stderr.on("data", chunk => stderr += chunk);
child.on("error", error => { console.error(error); process.exit(3); });
child.on("close", code => {
  let pong;
  try { pong = JSON.parse(stdout); } catch {}
  const contained = value => value?.isAppContainer && value?.tokenHasLpacAttribute && value?.inJob;
  const ok = code === 0
    && pong?.nonce === "sigma-ipc-nonce"
    && pong?.stdout === "sigma-ipc-child-stdout"
    && contained(parentContainment)
    && contained(pong?.containment);
  console.log(JSON.stringify({
    ok, code, stdout: pong?.stdout, stderr, parentContainment,
    childContainment: pong?.containment, pong: pong?.type
  }));
  process.exit(ok ? 0 : 2);
});
child.stdin.end(JSON.stringify({type: "ping", nonce: "sigma-ipc-nonce"}));
setTimeout(() => { console.error("stdio timeout"); child.kill(); process.exit(4); }, 5000).unref();
'''.strip()
            stdio_request = node_params(workspace, node, ["-e", stdio_parent_script])
            stdio_request["command"]["env"]["SIGMA_CONTAINMENT_PROBE"] = str(broker_path)
            stdio_request["policy"]["readRoots"].append(str(broker_path))
            stdio_request["policy"]["executionRoots"].append(str(broker_path))
            stdio_result = require_ok(
                broker.request("exec", {**stdio_request, "timeoutMs": 10000})
            )
            try:
                ipc_report = json.loads(stdio_result["stdout"]["data"].strip())
            except json.JSONDecodeError as error:
                raise RuntimeError(
                    f"bundled Node stdio fallback returned invalid JSON: {stdio_result}"
                ) from error
            if stdio_result["exitCode"] != 0 or not ipc_report.get("ok"):
                raise RuntimeError(
                    f"bundled Node stdio/containment fallback failed inside LPAC: {stdio_result}"
                )
        if ipc_report.get("pong") != "pong":
            raise RuntimeError(f"bundled Node child ping-pong failed inside LPAC: {ipc_report}")

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

        recovery_directory = local_app_data / "SigmaCode" / "sandbox-recovery"
        preexisting_journals = (
            list(recovery_directory.glob("sigmacode.exec.*.json"))
            if recovery_directory.exists()
            else []
        )
        if preexisting_journals:
            raise RuntimeError(f"stale recovery journals existed before crash fixture: {preexisting_journals}")
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
        crash_journal_ready = False
        for _ in range(100):
            crash_journals = list(recovery_directory.glob("sigmacode.exec.*.json"))
            if len(crash_journals) == 1:
                try:
                    candidate_journal = json.loads(
                        crash_journals[0].read_text(encoding="utf-8")
                    )
                except (OSError, json.JSONDecodeError):
                    candidate_journal = {}
                if not isinstance(candidate_journal, dict):
                    candidate_journal = {}
                candidate_entries = candidate_journal.get("entries")
                if (
                    isinstance(candidate_journal.get("profileName"), str)
                    and isinstance(candidate_entries, list)
                    and candidate_entries
                ):
                    crash_journal_ready = True
                    break
            time.sleep(0.05)
        if not crash_journal_ready:
            raise RuntimeError(
                f"broker-crash fixture did not reach a durably journaled ACL state: {crash_journals}"
            )
        broker.process.kill()
        broker.process.wait(timeout=5)
        time.sleep(4)
        if (workspace / "out" / "crash-leak.txt").exists():
            raise RuntimeError("broker crash left a descendant process alive")
        crash_journals = list(recovery_directory.glob("sigmacode.exec.*.json"))
        if len(crash_journals) != 1:
            raise RuntimeError(f"broker crash did not leave exactly one recoverable journal: {crash_journals}")
        crash_journal_path = crash_journals[0]
        crash_journal = json.loads(crash_journal_path.read_text(encoding="utf-8"))
        crash_profile_name = crash_journal.get("profileName")
        crash_entries = crash_journal.get("entries")
        if not isinstance(crash_profile_name, str) or not isinstance(crash_entries, list) or not crash_entries:
            raise RuntimeError(f"broker crash recovery journal is incomplete: {crash_journal}")
        crash_sid = appcontainer_sid_string(crash_profile_name)
        crash_profile_directory = local_app_data / "Packages" / crash_profile_name.lower()
        if not crash_profile_directory.exists():
            raise RuntimeError(f"crashed AppContainer profile was not present for recovery: {crash_profile_name}")

        recovery_broker = Broker(args.broker.resolve())
        try:
            recovered_setup = require_ok(recovery_broker.request("sandbox.setup"))
            if not recovered_setup["sandbox"]["selfTestPassed"]:
                raise RuntimeError(f"post-crash recovery broker self-test failed: {recovered_setup}")
        finally:
            recovery_broker.close()
        if crash_journal_path.exists():
            raise RuntimeError(f"post-crash recovery did not remove journal: {crash_journal_path}")
        remaining_journal_files = (
            [path for path in recovery_directory.iterdir() if path.is_file()]
            if recovery_directory.exists()
            else []
        )
        if remaining_journal_files:
            raise RuntimeError(f"post-crash recovery left journal artifacts: {remaining_journal_files}")
        if crash_profile_directory.exists():
            raise RuntimeError(f"post-crash recovery did not delete profile: {crash_profile_name}")
        remaining_profiles = [
            profile
            for profile in packages_directory.glob("sigmacode.exec.*")
            if profile.name.lower() not in preexisting_profiles
        ]
        if remaining_profiles:
            raise RuntimeError(
                f"post-crash recovery left new Sigma ephemeral profiles: {remaining_profiles}"
            )
        recovered_paths = {
            Path(entry["path"])
            for entry in crash_entries
            if isinstance(entry, dict) and isinstance(entry.get("path"), str)
        }
        uncleared = [path for path in recovered_paths if path.exists() and acl_contains_sid(path, crash_sid)]
        if uncleared:
            raise RuntimeError(f"post-crash recovery left exact AppContainer ACEs: {uncleared}")
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
                "shellPathVersion": shell_node_version["stdout"]["data"].strip(),
                "testRunner": True,
                "childProcess": True,
                "ipcPingPong": ipc_channel_available,
                "stdioPingPong": True,
                "ipcUnavailableReason": ipc_unavailable_reason,
                "ipcCapturedStdout": (
                    ipc_channel_available
                    and ipc_report["stdout"] == "sigma-ipc-child-stdout"
                ),
                "stdioCapturedStdout": ipc_report["stdout"] == "sigma-ipc-child-stdout",
                "parentContainment": ipc_report["parentContainment"],
                "childContainment": ipc_report["childContainment"],
                "cjsEntry": True,
                "esmEntry": True,
                "symlinkMainPreserved": True,
                "sandboxRuntimeEnvironment": {"NODE_OPTIONS": NODE_LPAC_OPTIONS},
                "danglingReadConformance": dangling_read_conformance,
                "crashRecovery": {
                    "journalDurable": True,
                    "exactAceRemoved": True,
                    "profileRemoved": True,
                    "journalRemoved": True,
                },
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
