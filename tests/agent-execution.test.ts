import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { access, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BoundedByteRingBuffer,
  BrokerCancelledError,
  BrokerConnectionError,
  BrokerExecutableUnavailableError,
  BrokerFrameDecoder,
  BrokerOutputDecodingError,
  BrokerPolicyError,
  BrokerProcessLostError,
  BrokerProtocolError,
  BrokerToolchainEnvironmentConflictError,
  BrokerTimeoutError,
  BrokerToolchainUnavailableError,
  LazyExecutionBroker,
  SandboxUnavailableError,
  SecretRedactor,
  SigmaExecBrokerClient,
  createMinimalEnvironment,
  encodeBrokerFrame,
  isBrokerGenerationTerminalError,
  parseBrokerResponse,
  resolveSigmaExecBinary
} from "../packages/agent-execution/src/index.js";
import {
  parseDoctor,
  parseExecutionValue,
  parseHandleId,
  parseHello,
  parseProcessHandoff,
  parseProcessValue,
  parseSpawnedProcess
} from "../packages/agent-execution/src/values.js";
import { BrokerOutputArtifactImporter } from "../packages/agent-execution/src/output-artifact-import.js";
import {
  defaultBrokerStartupTimeoutMs,
  defaultSandboxSetupTimeoutMs,
  reserveProcessId
} from "../packages/agent-execution/src/broker-client-support.js";
import type {
  BrokerDoctorReport,
  ExecutionBroker,
  ExecutionPolicy,
  ExecutionRequest,
  ExecutionResult,
  ProcessHandle,
  ProcessPollResult,
  ProcessSpawnRequest,
  SigmaExecBrokerClientOptions
} from "../packages/agent-execution/src/index.js";

const BROKER_FIXTURE = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const mode = process.argv[1] || "normal";
const artifactRootArgument = process.argv.slice(2).find(value =>
  path.basename(value).startsWith("sigma-exec-artifacts-")
);
const artifactRoot = artifactRootArgument ? path.resolve(artifactRootArgument) : undefined;
if (artifactRoot) fs.mkdirSync(artifactRoot, { recursive: true });
let input = Buffer.alloc(0);
let pollCount = 0;
let execCount = 0;
let doctorCount = 0;
let spawnCount = 0;
let pendingExec;
const send = value => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
};
const ok = (request, result) => send({ protocolVersion: 1, requestId: request.requestId, ok: true, result });
const fail = (request, code, message) => send({ protocolVersion: 1, requestId: request.requestId, ok: false, error: { code, message } });
const output = (data, nextOffset, droppedBytes = 0) => ({ data, nextOffset, droppedBytes });
const terminal = (stdout = "", stderr = "") => ({
  state: "exited", exitCode: 0, signal: null, durationMs: 5,
  stdout: output(stdout, Buffer.byteLength(stdout)),
  stderr: output(stderr, Buffer.byteLength(stderr))
});
const nextHandleId = () => {
  spawnCount += 1;
  return mode === "duplicate-handle" || spawnCount === 1
    ? "fixture-process"
    : "fixture-process-" + spawnCount;
};
const handle = request => {
  if (request.method === "hello") {
    ok(request, {
      protocolVersion: 1, instanceId: "fixture-instance",
      ...(artifactRoot ? { artifactRoot } : {})
    });
  } else if (request.method === "doctor") {
    doctorCount += 1;
    if (artifactRoot) fs.writeFileSync(path.join(artifactRoot, "doctor-" + doctorCount), "yes");
    if (mode === "transport-protocol-failure" && doctorCount > 1) {
      send({ protocolVersion: 999, requestId: request.requestId, ok: true, result: {} });
      return;
    }
    const available = mode !== "unavailable";
    const respond = () => ok(request, {
      protocolVersion: 1, brokerVersion: "fixture", platform: process.platform, architecture: process.arch,
      sandbox: { available, backend: "fixture", selfTestPassed: available, setupRequired: !available, reason: available ? undefined : "missing sandbox" },
      capabilities: {
        foreground: true, background: true, stdin: true, pty: false,
        processHandoff: true, networkModes: ["none", "full"]
      }
    });
    if (mode === "slow-doctor") setTimeout(respond, 50);
    else respond();
  } else if (request.method === "sandbox.setup") {
    ok(request, {
      protocolVersion: 1, brokerVersion: "fixture", platform: process.platform, architecture: process.arch,
      sandbox: { available: true, backend: "fixture", selfTestPassed: true, setupRequired: false },
      capabilities: {
        foreground: true, background: true, stdin: true, pty: true,
        processHandoff: true, networkModes: ["none", "full"]
      }
    });
  } else if (request.method === "exec" && mode === "hang") {
    // cancellation request remains readable while this logical request is pending
    execCount += 1;
    if (artifactRoot) fs.writeFileSync(path.join(artifactRoot, "exec-received-" + execCount), "yes");
  } else if (request.method === "exec" && mode === "cancel-ack") {
    pendingExec = request;
    if (artifactRoot) fs.writeFileSync(path.join(artifactRoot, "exec-received-1"), "yes");
  } else if (request.method === "exec" && mode === "overflow") {
    const content = Buffer.from("prefix [REDACTED:provider] suffix\n", "utf8");
    const artifactPath = path.join(artifactRoot, "stdout-output.log");
    fs.writeFileSync(artifactPath, content, { mode: 0o600 });
    ok(request, {
      ...terminal("tail"),
      stdout: output("tail", content.length, content.length - Buffer.byteLength("tail")),
      outputArtifacts: [{
        artifactId: "stdout-output", name: "stdout-output.log", stream: "stdout",
        path: artifactPath, sha256: crypto.createHash("sha256").update(content).digest("hex"),
        sizeBytes: content.length, complete: true, redacted: true, redactionLossy: false
      }],
      timedOut: false, idleTimedOut: false, cancelled: false
    });
  } else if (request.method === "exec" && mode === "decoding-error") {
    ok(request, {
      ...terminal(),
      stdout: { ...output("", 0), decodingError: {
        code: "invalid_output_encoding", message: "unsupported process output bytes"
      } },
      timedOut: false, idleTimedOut: false, cancelled: false
    });
  } else if (request.method === "exec" && (mode === "decoding-error-artifact" || mode === "bad-artifact")) {
    const content = Buffer.from("broker-redacted output\n", "utf8");
    const artifactPath = path.join(artifactRoot, "stdout-output.log");
    fs.writeFileSync(artifactPath, content, { mode: 0o600 });
    ok(request, {
      ...terminal(),
      stdout: mode === "decoding-error-artifact"
        ? { ...output("", content.length, content.length), decodingError: {
          code: "invalid_output_encoding", message: "unsupported process output bytes"
        } }
        : output("tail", content.length, content.length - Buffer.byteLength("tail")),
      outputArtifacts: [{
        artifactId: "stdout-output", name: "stdout-output.log", stream: "stdout",
        path: artifactPath,
        sha256: mode === "bad-artifact"
          ? "0".repeat(64)
          : crypto.createHash("sha256").update(content).digest("hex"),
        sizeBytes: content.length, complete: true, redacted: true, redactionLossy: false
      }],
      timedOut: false, idleTimedOut: false, cancelled: false
    });
  } else if (request.method === "exec" && mode === "launch-failure") {
    ok(request, {
      ...terminal("", "@@SIGMA_EXEC_INTERNAL_LAUNCH_FAILURE_V1@@private-nonce:{}"),
      exitCode: 125,
      failure: {
        phase: "sandbox_launch", code: "sandbox_reparse_target_unresolvable",
        message: "cannot resolve secret-value"
      },
      timedOut: false, idleTimedOut: false, cancelled: false
    });
  } else if (request.method === "exec") {
    ok(request, { ...terminal("secret-value"), timedOut: false, idleTimedOut: false, cancelled: false });
  } else if (request.method === "process.spawn") {
    if (mode === "malformed-spawn") {
      ok(request, { handleId: "" });
    } else if (mode === "toolchain-digest-check" && (
      request.params.policy.executableSha256 !== crypto.createHash("sha256")
        .update(fs.readFileSync(request.params.command.executable)).digest("hex")
    )) {
      fail(request, "broker_protocol_error", "trusted executable digest was not forwarded");
    } else if (mode === "toolchain-check" && (
      !request.params.policy.executionRoots.some(root => path.resolve(root) === path.resolve(process.execPath))
      || request.params.command.env.NODE_OPTIONS !== "--preserve-symlinks --preserve-symlinks-main"
    )) {
      fail(request, "policy_denied", "trusted toolchain policy was not forwarded");
    } else if (mode === "toolchain-alias-check" && (
      path.resolve(request.params.command.executable) !== path.resolve(process.execPath)
      || !request.params.policy.executionRoots.some(root => path.resolve(root) === path.resolve(process.execPath))
    )) {
      fail(request, "policy_denied", "trusted toolchain alias was not resolved exactly");
    } else if (mode === "pty-check" && (request.params.pty !== true || request.params.ptyColumns !== 90 || request.params.ptyRows !== 20)) {
      fail(request, "broker_protocol_error", "PTY request was not forwarded");
    } else if (mode === "handoff-check" && request.params.lifecycle !== "deliverable") {
      fail(request, "broker_protocol_error", "deliverable lifecycle was not forwarded");
    } else if (mode === "slow-spawn") {
      const handleId = nextHandleId();
      setTimeout(() => ok(request, { handleId }), 50);
    } else ok(request, { handleId: nextHandleId() });
  } else if (request.method === "process.poll" && mode === "crash-poll") {
    process.exit(9);
  } else if (request.method === "process.poll" && mode === "framed-secret") {
    const message = {
      jsonrpc: "2.0", id: 7,
      result: { plain: "abcdef", numeric: 1234, escaped: "a\"b\\c\n", padding: "" }
    };
    const initial = JSON.stringify(message);
    message.result.padding = "x".repeat(1234 - Buffer.byteLength(initial));
    const body = JSON.stringify(message);
    ok(request, terminal("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body));
  } else if (request.method === "process.poll" && mode === "serialized-poll") {
    pollCount += 1;
    if (pollCount === 1) {
      if (request.params.stdoutOffset !== 0) {
        fail(request, "broker_protocol_error", "initial poll cursor was not zero");
      } else {
        setTimeout(() => ok(request, {
          state: "running", exitCode: null, signal: null, durationMs: 2,
          stdout: output("abc", 3), stderr: output("", 0)
        }), 50);
      }
    } else if (request.params.stdoutOffset !== 3) {
      fail(request, "broker_protocol_error", "poll operations were not serialized");
    } else {
      ok(request, {
        state: "exited", exitCode: 0, signal: null, durationMs: 4,
        stdout: output("def", 6), stderr: output("", 0)
      });
    }
  } else if (request.method === "process.poll") {
    pollCount += 1;
    if (pollCount === 1) ok(request, {
      state: "running", exitCode: null, signal: null, durationMs: 2,
      stdout: output("abc", 3), stderr: output("", 0)
    });
    else ok(request, {
      state: "exited", exitCode: 0, signal: null, durationMs: 4,
      stdout: output("def", 6), stderr: output("", 0)
    });
  } else if (request.method === "cancel" && mode === "cancel-ack") {
    ok(request, { cancelled: true });
    setTimeout(() => {
      if (artifactRoot) fs.writeFileSync(path.join(artifactRoot, "cancel-settled"), "yes");
      ok(pendingExec, { ...terminal(), timedOut: false, idleTimedOut: false, cancelled: true });
      pendingExec = undefined;
    }, 50);
  } else if (request.method === "process.handoff") {
    ok(request, { handoffId: "handoff:" + request.params.handleId, processId: 4321 });
  } else if (request.method === "process.write" || request.method === "process.release" || request.method === "cancel") {
    ok(request, {});
  } else if (request.method === "artifact.release") {
    for (const artifactId of request.params.artifactIds || []) {
      if (artifactRoot && artifactId === "stdout-output") {
        fs.rmSync(path.join(artifactRoot, "stdout-output.log"), { force: true });
      }
    }
    ok(request, { released: true });
  } else if (request.method === "process.terminate") {
    if (mode === "slow-spawn" && artifactRoot) fs.writeFileSync(path.join(artifactRoot, "terminated"), "yes");
    ok(request, { ...terminal(), state: "terminated", signal: "SIGTERM" });
  } else if (request.method === "shutdown") {
    ok(request, { shutdown: true });
    if (artifactRoot) fs.rmSync(artifactRoot, { recursive: true, force: true });
    setTimeout(() => process.exit(0), 25);
  }
};
process.stdin.on("data", chunk => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (input.length < 4 + length) break;
    const request = JSON.parse(input.subarray(4, 4 + length).toString("utf8"));
    input = input.subarray(4 + length);
    handle(request);
  }
});
`;

const requiredPolicy = (): ExecutionPolicy => ({
  sandbox: "required",
  network: "none",
  readRoots: [process.cwd()],
  writeRoots: [],
  executionRoots: [process.execPath]
});

const spawnRequest = (): ProcessSpawnRequest => ({
  command: { executable: process.execPath, args: ["--version"], cwd: process.cwd() },
  policy: requiredPolicy()
});

function fixtureOptions(
  mode = "normal",
  extra: Partial<SigmaExecBrokerClientOptions> = {},
  artifactRoot?: string
): SigmaExecBrokerClientOptions {
  return {
    helperPath: process.execPath,
    helperArgs: ["-e", BROKER_FIXTURE, mode, ...(artifactRoot ? [artifactRoot] : [])],
    requestTimeoutMs: 1_000,
    shutdownGraceMs: 250,
    cancellationGraceMs: 250,
    trustedToolchains: [],
    ...extra
  };
}

describe("agent-execution framing and bounded output", () => {
  it("reserves unique process identifiers without yielding registration", () => {
    const seen = new Set<string>();
    expect(reserveProcessId("process", seen)).toBeUndefined();
    expect(reserveProcessId("process", seen)).toBeInstanceOf(BrokerProtocolError);
  });

  it("limits non-Windows startup while preserving bounded Windows recovery time", () => {
    expect(defaultBrokerStartupTimeoutMs("linux")).toBe(15_000);
    expect(defaultBrokerStartupTimeoutMs("darwin")).toBe(15_000);
    expect(defaultSandboxSetupTimeoutMs("linux")).toBe(60_000);
    expect(defaultBrokerStartupTimeoutMs("win32")).toBe(600_000);
    expect(defaultSandboxSetupTimeoutMs("win32")).toBe(600_000);
  });

  it("decodes fragmented length-prefixed frames", () => {
    const frame = encodeBrokerFrame({ value: "✓" });
    const decoder = new BrokerFrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([{ value: "✓" }]);
    expect(() => decoder.end()).not.toThrow();
  });

  it("rejects malformed or incomplete frames", () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(101);
    expect(() => new BrokerFrameDecoder(100).push(oversized)).toThrow(/invalid payload length/i);
    const decoder = new BrokerFrameDecoder();
    decoder.push(encodeBrokerFrame({ ok: true }).subarray(0, 5));
    expect(() => decoder.end()).toThrow(/inside a frame/i);
    const invalidJson = Buffer.from([0, 0, 0, 1, 123]);
    expect(() => new BrokerFrameDecoder().push(invalidJson)).toThrow(BrokerProtocolError);
    expect(() => new BrokerFrameDecoder(0)).toThrow(RangeError);
    expect(() => encodeBrokerFrame(undefined)).toThrow(BrokerProtocolError);
    expect(() => encodeBrokerFrame({ large: "xx" }, 2)).toThrow(BrokerProtocolError);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => encodeBrokerFrame(circular)).toThrow(BrokerProtocolError);
  });

  it("retains a byte-bounded tail", () => {
    const ring = new BoundedByteRingBuffer(5);
    ring.append("abc");
    ring.append("defg");
    expect(ring.text()).toBe("cdefg");
    expect(ring.droppedBytes).toBe(2);
    expect(ring.byteLength).toBe(5);
    expect(ring.bytes()).toEqual(Buffer.from("cdefg"));
    ring.clear();
    expect(ring.text()).toBe("");
    expect(() => new BoundedByteRingBuffer(0)).toThrow(RangeError);
  });
});

describe("agent-execution environment and redaction", () => {
  it("copies only allowed variables and blocks secret keys", () => {
    const source = { PATH: "bin", SAFE_EXTRA: "yes", DEEPSEEK_API_KEY: "hidden" };
    expect(createMinimalEnvironment({ passthrough: ["SAFE_EXTRA"] }, source)).toEqual({ PATH: "bin", SAFE_EXTRA: "yes" });
    expect(() => createMinimalEnvironment({ passthrough: ["DEEPSEEK_API_KEY"] }, source)).toThrow(BrokerPolicyError);
    expect(() => createMinimalEnvironment({ overrides: { ACCESS_TOKEN: "hidden" } }, source)).toThrow(BrokerPolicyError);
    expect(() => createMinimalEnvironment({ overrides: { "": "bad" } }, source)).toThrow(BrokerPolicyError);
    expect(() => createMinimalEnvironment({ overrides: { "A=B": "bad" } }, source)).toThrow(BrokerPolicyError);
    expect(() => createMinimalEnvironment({ overrides: { SAFE: "bad\0value" } }, source)).toThrow(BrokerPolicyError);
    expect(createMinimalEnvironment(
      { passthrough: ["PATH"], overrides: { path: "override" } },
      { Path: "mixed-case" },
      "win32"
    )).toMatchObject({ path: "override" });
    expect(createMinimalEnvironment({ passthrough: ["SHELL"] }, { SHELL: "/bin/sh" }, "linux"))
      .toMatchObject({ SHELL: "/bin/sh" });
    expect(createMinimalEnvironment({ passthrough: ["MISSING"] }, { missing: undefined }, "win32"))
      .not.toHaveProperty("MISSING");
  });

  it("redacts values and secret-named object members", () => {
    const redactor = new SecretRedactor({ provider: "secret-value" });
    expect(redactor.redactUnknown({ text: "x secret-value y", apiKey: "other" })).toEqual({
      text: "x [REDACTED:provider] y", apiKey: "[REDACTED]"
    });
    const stream = new SecretRedactor({ provider: "abcdef" }).createStream();
    expect(stream.push("prefix abc")).toBe("prefix ");
    expect(stream.push("def suffix")).toBe("[REDACTED:provider] suffix");
    expect(stream.push("abc", { final: true })).toBe("[REDACTED:partial]");
    expect(stream.push("abc", { discontinuity: true })).toBe("[REDACTED:truncated-output]");
    const framed = new SecretRedactor({ provider: "密钥abcd" }).createStream("length_preserving");
    const framedInput = "prefix 密钥abcd suffix";
    const framedOutput = framed.push(framedInput, { final: true });
    expect(framedOutput).not.toContain("密钥abcd");
    expect(Buffer.byteLength(framedOutput, "utf8")).toBe(Buffer.byteLength(framedInput, "utf8"));
    const structured = new SecretRedactor({ numeric: "1234", token: "abcd" });
    expect(structured.redactJsonValue({
      unchangedNumber: 7,
      redactedNumber: 1234,
      values: [true, null, "abcd"],
      apiKey: "visible"
    })).toEqual({
      unchangedNumber: 7,
      redactedNumber: "[REDACTED:numeric]",
      values: [true, null, "[REDACTED:token]"],
      apiKey: "[REDACTED]"
    });
    const preservingPartial = new SecretRedactor({ token: "abcdef" }).createStream("length_preserving");
    expect(preservingPartial.push("abc", { final: true })).toBe("***");
    expect(preservingPartial.push("abc", { discontinuity: true })).toBe("***");
  });

  it("validates and redacts every JSON-RPC structural string", () => {
    const stream = new SecretRedactor({ secret: "secret-value" }).createFramedJsonRpcStream();
    const framed = (value: unknown): string => {
      const body = Buffer.from(JSON.stringify(value), "utf8");
      return `Content-Length: ${body.byteLength}\r\n\r\n${body.toString("utf8")}`;
    };
    const output = stream.push(framed({
      jsonrpc: "2.0", id: "secret-value", method: "workspace/secret-value", params: {}
    }), { final: true });
    expect(output).not.toContain("secret-value");
    expect(output).toContain("[REDACTED:secret]");
    for (const invalid of [
      { jsonrpc: "1.0", id: 1, result: null },
      { jsonrpc: "2.0", id: { secret: "secret-value" }, result: null },
      { jsonrpc: "2.0", method: { secret: "secret-value" }, params: {} },
      { jsonrpc: "2.0", id: 1, error: { code: "secret-value", message: "failure" } }
    ]) {
      expect(() => new SecretRedactor({ secret: "secret-value" })
        .createFramedJsonRpcStream().push(framed(invalid), { final: true }))
        .toThrow(BrokerProtocolError);
    }
  });
});

describe("BrokerOutputArtifactImporter", () => {
  it("commits a multi-artifact import only after the whole batch validates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-batch-"));
    const stdoutPath = path.join(root, "stdout.log");
    const stderrPath = path.join(root, "stderr.log");
    await writeFile(stdoutPath, "stdout", "utf8");
    await writeFile(stderrPath, "stderr", "utf8");
    const value = (artifactId: string, stream: "stdout" | "stderr", filePath: string, content: string) => ({
      artifactId, name: `${stream}.log`, stream, path: filePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: Buffer.byteLength(content), complete: true, redacted: true, redactionLossy: false
    });
    const stdout = value("stdout-id", "stdout", stdoutPath, "stdout");
    const invalidStderr = { ...value("stderr-id", "stderr", stderrPath, "stderr"), sha256: "0".repeat(64) };
    const importer = new BrokerOutputArtifactImporter(new SecretRedactor({}), async () => undefined);
    await importer.configureRoot(root);
    await expect(importer.consume([stdout, invalidStderr])).rejects.toThrow(/checksum/u);
    await expect(importer.consume([stdout])).resolves.toMatchObject([{ brokerArtifactId: "stdout-id" }]);
    await importer.cleanup();
  });
});

describe("agent-execution protocol validation", () => {
  it("rejects malformed response envelopes", () => {
    const base = { protocolVersion: 1, requestId: 1 };
    expect(parseBrokerResponse({ ...base, ok: true, result: {} })).toMatchObject({ ok: true });
    expect(parseBrokerResponse({ ...base, ok: false, error: { code: "denied", message: "no" } })).toMatchObject({ ok: false });
    for (const value of [null, [], { ...base, protocolVersion: 2, ok: true }, { ...base, requestId: 0, ok: true },
      { ...base, ok: "yes" }, { ...base, ok: true, error: {} }, { ...base, ok: false, result: {}, error: {} },
      { ...base, ok: false, error: { code: 1, message: "no" } }]) {
      expect(() => parseBrokerResponse(value)).toThrow(BrokerProtocolError);
    }
  });

  it("validates typed hello, doctor, process, and execution values", () => {
    expect(parseHello({ protocolVersion: 1, instanceId: "instance" })).toEqual({ instanceId: "instance" });
    expect(() => parseHello({ protocolVersion: 2, instanceId: "instance" })).toThrow(BrokerProtocolError);
    expect(() => parseHello({ protocolVersion: 1, instanceId: "" })).toThrow(BrokerProtocolError);
    expect(() => parseHello({ protocolVersion: 1, instanceId: 1 })).toThrow(BrokerProtocolError);
    expect(() => parseHello({ protocolVersion: 1, instanceId: "instance", artifactRoot: 1 })).toThrow(BrokerProtocolError);
    expect(parseHandleId({ handleId: "process" })).toBe("process");
    expect(() => parseHandleId({ handleId: "" })).toThrow(BrokerProtocolError);
    const doctor = {
      protocolVersion: 1, brokerVersion: "3", platform: "linux", architecture: "x64",
      sandbox: {
        available: true, backend: "test", selfTestPassed: true, setupRequired: false,
        hardening: {
          landlockAbi: 4,
          noNewPrivileges: true,
          seccompFilter: true,
          lessPrivilegedAppContainer: false,
          mountNamespace: true,
          pidNamespace: true,
          networkNamespace: true
        }
      },
      capabilities: {
        foreground: true, background: true, stdin: true, pty: false, networkModes: ["none"],
        executionRoots: true,
        shells: [{ kind: "bash", executable: "/bin/bash", verified: true }]
      }
    };
    const parsedDoctor = parseDoctor(doctor);
    expect(parsedDoctor.sandbox.reason).toBeUndefined();
    expect(parsedDoctor.sandbox.hardening).toEqual({
      landlockAbi: 4,
      noNewPrivileges: true,
      seccompFilter: true,
      lessPrivilegedAppContainer: false,
      mountNamespace: true,
      pidNamespace: true,
      networkNamespace: true
    });
    expect(parsedDoctor.capabilities).toMatchObject({
      executionRoots: true,
      shells: [{ kind: "bash", executable: "/bin/bash", verified: true }]
    });
    expect(parseDoctor({
      ...doctor,
      platform: "windows",
      capabilities: {
        ...doctor.capabilities,
        shells: [{ kind: "cmd", executable: "C:\\Windows\\System32\\cmd.exe", verified: true }]
      }
    }).capabilities.shells).toEqual([
      { kind: "cmd", executable: "C:\\Windows\\System32\\cmd.exe", verified: true }
    ]);
    expect(parseDoctor({
      ...doctor,
      capabilities: {
        ...doctor.capabilities,
        shells: [{ kind: "bash", executable: "/bin/bash", verified: true, supportsChildProcesses: true }]
      }
    }).capabilities.shells).toEqual([
      { kind: "bash", executable: "/bin/bash", verified: true, supportsChildProcesses: true }
    ]);
    expect(parseDoctor({
      ...doctor,
      sandbox: { ...doctor.sandbox, hardening: { ...doctor.sandbox.hardening, landlockAbi: undefined } }
    }).sandbox.hardening).not.toHaveProperty("landlockAbi");
    expect(() => parseDoctor({ ...doctor, protocolVersion: 2 })).toThrow(BrokerProtocolError);
    for (const platform of ["unknown", "linux\nforged"]) {
      expect(() => parseDoctor({ ...doctor, platform })).toThrow(BrokerProtocolError);
    }
    for (const architecture of ["", "x64\nforged", "x".repeat(65)]) {
      expect(() => parseDoctor({ ...doctor, architecture })).toThrow(BrokerProtocolError);
    }
    expect(() => parseDoctor({ ...doctor, capabilities: { ...doctor.capabilities, networkModes: ["domain"] } })).toThrow(BrokerProtocolError);
    expect(() => parseDoctor({
      ...doctor,
      capabilities: { ...doctor.capabilities, shells: [{ kind: "powershell", executable: "powershell.exe", verified: false }] }
    })).toThrow(BrokerProtocolError);
    expect(() => parseDoctor({
      ...doctor,
      capabilities: { ...doctor.capabilities, shells: {} }
    })).toThrow(BrokerProtocolError);
    expect(() => parseDoctor({
      ...doctor,
      capabilities: { ...doctor.capabilities, shells: [{ kind: "fish", executable: "/bin/fish", verified: true }] }
    })).toThrow(BrokerProtocolError);
    expect(() => parseDoctor({
      ...doctor,
      capabilities: {
        ...doctor.capabilities,
        shells: [{ kind: "bash", executable: "/bin/bash", verified: true, supportsChildProcesses: "yes" }]
      }
    })).toThrow(BrokerProtocolError);
    expect(() => parseDoctor({
      ...doctor,
      capabilities: { ...doctor.capabilities, shells: [{ kind: "bash", executable: "bin/bash", verified: true }] }
    })).toThrow(BrokerProtocolError);
    expect(() => parseDoctor({
      ...doctor,
      platform: "windows",
      capabilities: { ...doctor.capabilities, shells: [{ kind: "cmd", executable: "cmd.exe", verified: true }] }
    })).toThrow(BrokerProtocolError);
    expect(() => parseDoctor({
      ...doctor,
      capabilities: { ...doctor.capabilities, shells: [{ kind: "bash", executable: "/bin/bash\0", verified: true }] }
    })).toThrow(BrokerProtocolError);
    expect(() => parseDoctor({
      ...doctor,
      capabilities: {
        ...doctor.capabilities,
        shells: [
          { kind: "bash", executable: "/bin/bash", verified: true },
          { kind: "bash", executable: "/usr/bin/bash", verified: true }
        ]
      }
    })).toThrow(BrokerProtocolError);
    expect(() => parseDoctor({
      ...doctor, sandbox: { ...doctor.sandbox, hardening: { ...doctor.sandbox.hardening, landlockAbi: 0 } }
    })).toThrow(BrokerProtocolError);
    const processValue = {
      state: "exited", exitCode: -1, signal: "SIGTERM", durationMs: 4,
      stdout: { data: "out", nextOffset: 3, droppedBytes: 0 },
      stderr: { data: "", nextOffset: 0, droppedBytes: 0 }
    };
    expect(parseProcessValue(processValue)).toMatchObject({ state: "exited", signal: "SIGTERM" });
    expect(parseProcessValue({
      ...processValue,
      failure: {
        phase: "sandbox_launch",
        code: "sandbox_reparse_target_unresolvable",
        message: "sandbox launch failed"
      }
    })).toMatchObject({
      failure: {
        phase: "sandbox_launch",
        code: "sandbox_reparse_target_unresolvable"
      }
    });
    expect(() => parseProcessValue({
      ...processValue,
      failure: { phase: "process", code: "sandbox_unavailable", message: "bad phase" }
    })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({
      ...processValue,
      failure: { phase: "sandbox_launch", code: "", message: "missing code" }
    })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({
      ...processValue,
      failure: { phase: "sandbox_launch", code: "policy-denied\nforged", message: "bad code" }
    })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({
      ...processValue,
      failure: { phase: "sandbox_launch", code: "sandbox_unavailable", message: "bad\0message" }
    })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({
      ...processValue,
      state: "running",
      failure: { phase: "sandbox_launch", code: "sandbox_unavailable", message: "failed" }
    })).toThrow(BrokerProtocolError);
    expect(parseExecutionValue({ ...processValue, timedOut: false, idleTimedOut: false, cancelled: false })).toMatchObject({ state: "exited" });
    expect(() => parseExecutionValue({ ...processValue, timedOut: "false", idleTimedOut: false, cancelled: false }))
      .toThrow(BrokerProtocolError);
    expect(() => parseExecutionValue({ ...processValue, state: "running", timedOut: false, idleTimedOut: false, cancelled: false })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({ ...processValue, state: "lost" })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({ ...processValue, exitCode: 1.5 })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({ ...processValue, durationMs: -1 })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({
      ...processValue,
      stdout: {
        ...processValue.stdout,
        decodingError: { code: "unknown_encoding_error", message: "invalid" }
      }
    })).toThrow(BrokerProtocolError);
    const outputArtifact = {
      artifactId: "stdout-1", name: "stdout.log", stream: "stdout", path: "/tmp/stdout.log",
      sha256: "a".repeat(64), sizeBytes: 12, complete: true, redacted: true, redactionLossy: false
    };
    expect(parseProcessValue({ ...processValue, outputArtifacts: [outputArtifact] }).outputArtifacts)
      .toHaveLength(1);
    expect(() => parseProcessValue({ ...processValue, state: "running", outputArtifacts: [outputArtifact] }))
      .toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({ ...processValue, outputArtifacts: [{ ...outputArtifact, sha256: "bad" }] }))
      .toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({ ...processValue, outputArtifacts: {} })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({ ...processValue, outputArtifacts: [outputArtifact, outputArtifact, outputArtifact] }))
      .toThrow(BrokerProtocolError);
    for (const invalid of [
      { ...outputArtifact, artifactId: "bad/id" },
      { ...outputArtifact, name: "" },
      { ...outputArtifact, name: "bad/name" },
      { ...outputArtifact, name: "bad\\name" },
      { ...outputArtifact, name: "bad\0name" },
      { ...outputArtifact, stream: "combined" },
      { ...outputArtifact, redacted: false }
    ]) {
      expect(() => parseProcessValue({ ...processValue, outputArtifacts: [invalid] })).toThrow(BrokerProtocolError);
    }
    expect(() => parseProcessValue({
      ...processValue,
      outputArtifacts: [outputArtifact, { ...outputArtifact, artifactId: "stdout-2", name: "stdout-2.log" }]
    })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({
      ...processValue,
      outputArtifacts: [outputArtifact, { ...outputArtifact, stream: "stderr" }]
    })).toThrow(BrokerProtocolError);

    expect(parseSpawnedProcess({ handleId: "spawned" })).toEqual({ id: "spawned" });
    expect(parseSpawnedProcess({ handleId: "spawned", processId: 42 })).toEqual({ id: "spawned", systemProcessId: 42 });
    expect(() => parseSpawnedProcess({ handleId: "spawned", processId: 1.5 })).toThrow(BrokerProtocolError);
    expect(() => parseSpawnedProcess({ handleId: "spawned", processId: 0 })).toThrow(BrokerProtocolError);
    expect(parseProcessHandoff({ handoffId: "handoff" })).toEqual({ handoffId: "handoff" });
    expect(parseProcessHandoff({ handoffId: "handoff", processId: 42 })).toEqual({
      handoffId: "handoff", systemProcessId: 42
    });
    expect(() => parseProcessHandoff({ handoffId: "" })).toThrow(BrokerProtocolError);
    expect(() => parseProcessHandoff({ handoffId: "handoff", processId: 1.5 })).toThrow(BrokerProtocolError);
    expect(() => parseProcessHandoff({ handoffId: "handoff", processId: 0 })).toThrow(BrokerProtocolError);
  });

  it("resolves platform-specific helper names", () => {
    expect(resolveSigmaExecBinary("/tmp/bin", "linux")).toMatch(/sigma-exec$/);
    expect(resolveSigmaExecBinary("C:/bin", "win32")).toMatch(/sigma-exec\.exe$/);
  });
});

describe("SigmaExecBrokerClient", () => {
  it("rejects an invalid acknowledged-cancellation grace period", () => {
    expect(() => new SigmaExecBrokerClient(fixtureOptions("normal", {
      cancellationGraceMs: 0
    }))).toThrow("cancellationGraceMs must be a positive integer");
  });

  it("handshakes, redacts foreground output, and manages background handles", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("normal", {
      secrets: { provider: "secret-value", stream: "abcdef" }
    }));
    await expect(client.connect()).resolves.toMatchObject({ sandbox: { available: true } });
    await expect(client.setupSandbox()).resolves.toMatchObject({ capabilities: { pty: true } });
    await expect(client.execute({ ...spawnRequest(), timeoutMs: 500 })).resolves.toMatchObject({
      state: "exited", stdout: "[REDACTED:provider]", exitCode: 0
    });
    const handle = await client.spawn({ ...spawnRequest(), outputRedaction: "length_preserving" });
    await expect(client.poll(handle)).resolves.toMatchObject({ state: "running", stdout: "" });
    await client.write(handle, "input\n");
    await expect(client.poll(handle)).resolves.toMatchObject({ state: "exited", stdout: "******" });
    await expect(client.terminate(handle)).rejects.toBeInstanceOf(BrokerProcessLostError);
    await client.close();
  });

  it("hands off only deliverable handles and releases client ownership", async () => {
    const sessionClient = new SigmaExecBrokerClient(fixtureOptions("normal"));
    await sessionClient.connect();
    const sessionHandle = await sessionClient.spawn(spawnRequest());
    await expect(sessionClient.handoff(sessionHandle)).rejects.toBeInstanceOf(BrokerPolicyError);
    await expect(sessionClient.terminate(sessionHandle)).resolves.toMatchObject({ state: "terminated" });
    await sessionClient.close();

    const client = new SigmaExecBrokerClient(fixtureOptions("handoff-check"));
    await expect(client.connect()).resolves.toMatchObject({
      capabilities: { processHandoff: true }
    });
    const deliverable = await client.spawn({ ...spawnRequest(), lifecycle: "deliverable" });
    expect(deliverable.lifecycle).toBe("deliverable");
    await expect(client.handoff(deliverable)).resolves.toMatchObject({
      handle: deliverable,
      handoffId: `handoff:${deliverable.id}`,
      systemProcessId: 4321
    });
    await expect(client.poll(deliverable)).rejects.toBeInstanceOf(BrokerProcessLostError);
    await client.close();
  });

  it("propagates launch failure metadata without exposing its internal marker", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("launch-failure", {
      secrets: { provider: "secret-value" }
    }));
    await client.connect();
    const result = await client.execute({ ...spawnRequest(), timeoutMs: 500 });
    expect(result).toMatchObject({
      exitCode: 125,
      failure: {
        phase: "sandbox_launch",
        code: "sandbox_reparse_target_unresolvable",
        message: "cannot resolve [REDACTED:provider]"
      }
    });
    expect(result.stderr).toBe(
      "sigma-exec sandbox launch failed [sandbox_reparse_target_unresolvable]: cannot resolve [REDACTED:provider]"
    );
    expect(result.stderr).not.toContain("private-nonce");
    await client.close();
  });

  it("redacts framed JSON-RPC payloads without changing headers or JSON structure", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("framed-secret", {
      secrets: { stream: "abcdef", numeric: "1234", escaped: "a\"b\\c\n" }
    }));
    await client.connect();
    const handle = await client.spawn({ ...spawnRequest(), outputRedaction: "framed_jsonrpc" });
    const result = await client.poll(handle);
    const separator = result.stdout.indexOf("\r\n\r\n");
    const header = result.stdout.slice(0, separator);
    const body = result.stdout.slice(separator + 4);
    const length = Number(/Content-Length:\s*(\d+)/u.exec(header)?.[1]);
    expect(header).not.toContain("*");
    expect(Buffer.byteLength(body, "utf8")).toBe(length);
    expect(JSON.parse(body)).toMatchObject({
      id: 7,
      result: {
        plain: "[REDACTED:stream]",
        numeric: "[REDACTED:numeric]",
        escaped: "[REDACTED:escaped]"
      }
    });
    await client.close();
  });

  it("receives and terminates a background handle when cancellation races with spawn", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-slow-spawn-"));
    const client = new SigmaExecBrokerClient(fixtureOptions("slow-spawn", {}, artifactRoot));
    await client.connect();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancel spawn")), 10).unref();
    await expect(client.spawn(spawnRequest(), { signal: controller.signal }))
      .rejects.toMatchObject({ code: "broker_cancelled" });
    await expect(access(path.join(artifactRoot, "terminated"))).resolves.toBeUndefined();
    expect(client.lostProcessHandles).toEqual([]);
    await expect(client.doctor()).resolves.toMatchObject({ sandbox: { available: true } });
    await client.close();
  });

  it("does not return a background handle after direct client close begins", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-close-spawn-"));
    const client = new SigmaExecBrokerClient(fixtureOptions("slow-spawn", {}, artifactRoot));
    await client.connect();
    const spawning = client.spawn(spawnRequest());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closing = client.close();
    await expect(spawning).rejects.toBeInstanceOf(BrokerConnectionError);
    await closing;
    expect(client.lostProcessHandles).toEqual([]);
  });

  it("closes the broker fail-closed when a background spawn exceeds its deadline", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-spawn-timeout-"));
    const client = new SigmaExecBrokerClient(fixtureOptions("slow-spawn", {}, artifactRoot));
    await client.connect();
    await expect(client.spawn(spawnRequest(), { timeoutMs: 10 }))
      .rejects.toMatchObject({ code: "broker_timeout" });
    await expect(access(artifactRoot)).rejects.toThrow();
    await expect(client.doctor()).rejects.toThrow(/closed/u);
  });

  it("retires the broker when a successful spawn response has no usable handle", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-malformed-spawn-"));
    const client = new SigmaExecBrokerClient(fixtureOptions("malformed-spawn", {}, artifactRoot));
    await client.connect();
    await expect(client.spawn(spawnRequest())).rejects.toBeInstanceOf(BrokerProtocolError);
    await expect(client.doctor()).rejects.toThrow(/closed/u);
    await expect(access(artifactRoot)).rejects.toThrow();
  });

  it("marks a transport-wide protocol failure terminal and cleans its spool", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-bad-transport-"));
    const client = new SigmaExecBrokerClient(fixtureOptions("transport-protocol-failure", {}, artifactRoot));
    await client.connect();
    const transport = (client as unknown as {
      transport: { waitForChildClose(): Promise<boolean> };
    }).transport;
    let confirmed = false;
    transport.waitForChildClose = async () => confirmed;
    const error = await client.doctor().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BrokerProtocolError);
    expect(isBrokerGenerationTerminalError(error)).toBe(true);
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    confirmed = true;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(client.close()).resolves.toBeUndefined();
    await expect(access(artifactRoot)).rejects.toThrow();
  });

  it("keeps the broker spool until the caller acknowledges durable artifact import", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-fixture-"));
    const artifactPath = path.join(artifactRoot, "stdout-output.log");
    const client = new SigmaExecBrokerClient(fixtureOptions("overflow", {
      secrets: { provider: "secret-value" }
    }, artifactRoot));
    await client.connect();
    const result = await client.execute({ ...spawnRequest(), timeoutMs: 500 });
    expect(result).toMatchObject({ stdout: "[REDACTED:truncated-output]", outputTruncated: true });
    expect(result.outputArtifacts).toHaveLength(1);
    expect(Buffer.from(result.outputArtifacts![0]!.content).toString("utf8"))
      .toBe("prefix [REDACTED:provider] suffix\n");
    await expect(access(artifactPath)).resolves.toBeUndefined();
    await client.releaseOutputArtifacts(result.outputArtifacts!.map((item) => item.brokerArtifactId));
    await expect(access(artifactPath)).rejects.toThrow();
    await client.close();
    await expect(access(artifactRoot)).rejects.toThrow();
  });

  it("forwards an explicit PTY request and dimensions to the broker", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("pty-check"));
    await client.connect();
    await expect(client.spawn({ ...spawnRequest(), pty: true, ptyColumns: 90, ptyRows: 20 }))
      .resolves.toMatchObject({ id: "fixture-process" });
    await expect(client.spawn({ ...spawnRequest(), pty: true, ptyColumns: 65_536 }))
      .rejects.toBeInstanceOf(BrokerPolicyError);
    await client.close();
  });

  it("enforces manifest toolchain roots, PATH, and descendant environment on every command", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("toolchain-check", {
      sandboxMode: "unsafe",
      trustedToolchains: [{
        id: "bundled-runtime",
        executable: process.execPath,
        aliases: ["node"],
        environment: { NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main" }
      }]
    }));
    await client.connect();
    const request = spawnRequest();
    await expect(client.spawn({
      ...request,
      command: { ...request.command, executable: process.platform === "win32" ? "cmd" : "bash" }
    })).resolves.toMatchObject({ id: "fixture-process" });
    const conflict = await client.spawn({
      ...request,
      command: {
        ...request.command,
        environment: { overrides: { NODE_OPTIONS: "--test-isolation=none" } }
      }
    }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(BrokerToolchainEnvironmentConflictError);
    expect(conflict).toMatchObject({
      code: "toolchain_environment_conflict",
      data: { name: "NODE_OPTIONS", toolchainId: "bundled-runtime" }
    });
    await expect(client.spawn({
      ...request,
      command: {
        ...request.command,
        environment: { overrides: { NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main" } }
      }
    })).resolves.toMatchObject({ id: "fixture-process-2" });
    await client.close();
  });

  it("resolves manifest aliases to one exact executable without trusting sibling binaries", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("toolchain-alias-check", {
      sandboxMode: "unsafe",
      trustedToolchains: [{
        id: "bundled-runtime",
        runtime: "node",
        executable: process.execPath,
        aliases: process.platform === "win32" ? ["node", "node.exe"] : ["node"],
        executionRoots: [process.execPath],
        pathEntries: []
      }]
    }));
    await client.connect();
    const request = spawnRequest();
    await expect(client.spawn({
      ...request,
      command: { ...request.command, executable: "node" }
    })).resolves.toMatchObject({ id: "fixture-process" });
    await expect(client.spawn({
      ...request,
      command: { ...request.command, executable: path.join(path.dirname(process.execPath), "sibling.exe") }
    })).rejects.toBeInstanceOf(BrokerExecutableUnavailableError);
    expect(() => new SigmaExecBrokerClient(fixtureOptions("normal", {
      trustedToolchains: [
        { id: "one", executable: process.execPath, aliases: ["node"] },
        { id: "two", executable: process.execPath, aliases: [process.platform === "win32" ? "NODE" : "node"] }
      ]
    }))).toThrow(/alias.*duplicated/iu);
    expect(() => new SigmaExecBrokerClient(fixtureOptions("normal", {
      trustedToolchains: [{
        id: "broad-node",
        runtime: "node",
        executable: process.execPath,
        executionRoots: [path.dirname(process.execPath)],
        pathEntries: []
      }]
    }))).toThrow(/trust only its exact executable/iu);
    expect(() => new SigmaExecBrokerClient(fixtureOptions("normal", {
      trustedToolchains: [{
        id: "path-node",
        runtime: "node",
        executable: process.execPath,
        executionRoots: [process.execPath],
        pathEntries: [path.dirname(process.execPath)]
      }]
    }))).toThrow(/cannot add a directory to PATH/iu);
    await client.close();
  });

  it("does not create an implicit current-runtime toolchain when the manifest is omitted", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("toolchain-alias-check", {
      sandboxMode: "unsafe",
      trustedToolchains: undefined
    }));
    await client.connect();
    const request = spawnRequest();
    await expect(client.spawn({
      ...request,
      command: { ...request.command, executable: "node" }
    })).rejects.toBeInstanceOf(BrokerPolicyError);
    await client.close();
  });

  it.runIf(process.platform === "win32")(
    "fails closed before broker startup when an explicit required Node toolchain lacks compatibility proof",
    async () => {
      const client = new SigmaExecBrokerClient(fixtureOptions("normal", {
        trustedToolchains: [{
          id: "unpatched-node",
          runtime: "generic",
          executable: process.execPath,
          aliases: [],
          executionRoots: [process.execPath],
          pathEntries: []
        }]
      }));
      const error = await client.connect().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(BrokerToolchainUnavailableError);
      expect(error).toMatchObject({ code: "toolchain_unavailable" });
    }
  );

  it.runIf(process.platform === "win32")(
    "detects a renamed Node executable instead of accepting it as a generic required toolchain",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sigma-renamed-node-"));
      const renamed = path.join(root, "runtime.bin");
      await cp(process.execPath, renamed);
      const client = new SigmaExecBrokerClient(fixtureOptions("normal", {
        trustedToolchains: [{
          id: "renamed-node",
          runtime: "generic",
          executable: renamed,
          aliases: [],
          executionRoots: [renamed],
          pathEntries: []
        }]
      }));
      const error = await client.connect().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(BrokerToolchainUnavailableError);
      expect(error).toMatchObject({ code: "toolchain_unavailable" });
    }
  );

  it.runIf(process.platform === "win32")(
    "binds each required Windows toolchain request to its connection-time executable digest",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sigma-generic-toolchain-digest-"));
      const executable = path.join(root, "generic-tool.exe");
      await writeFile(executable, "stable generic tool bytes");
      const client = new SigmaExecBrokerClient(fixtureOptions("toolchain-digest-check", {
        trustedToolchains: [{
          id: "generic-tool",
          runtime: "generic",
          executable,
          aliases: ["generic-tool"],
          executionRoots: [executable],
          pathEntries: []
        }]
      }));
      try {
        await client.connect();
        const request = spawnRequest();
        await expect(client.spawn({
          ...request,
          command: { ...request.command, executable: "generic-tool" }
        })).resolves.toMatchObject({ id: "fixture-process" });
        await writeFile(executable, "replacement generic tool bytes");
        await expect(client.spawn({
          ...request,
          command: { ...request.command, executable: "generic-tool" }
        })).rejects.toBeInstanceOf(BrokerToolchainUnavailableError);
      } finally {
        await client.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("allows relative verified primaries with child roots and rejects untrusted absolute primaries", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("normal"));
    await client.connect();
    const request = spawnRequest();
    await expect(client.spawn({
      ...request,
      command: { ...request.command, executable: "node" },
      policy: { ...request.policy, executionRoots: [path.dirname(process.execPath)] }
    })).resolves.toMatchObject({ id: "fixture-process" });
    const outside = path.join(request.command.cwd, "untrusted-primary.exe");
    await expect(client.spawn({
      ...request,
      command: { ...request.command, executable: outside }
    })).rejects.toBeInstanceOf(BrokerExecutableUnavailableError);
    await expect(client.spawn({
      ...request,
      policy: {
        ...request.policy,
        executionRoots: [process.execPath, request.command.cwd],
        writeRoots: [request.command.cwd]
      }
    })).rejects.toBeInstanceOf(BrokerPolicyError);
    await client.close();
  });

  it("rejects undecodable foreground output without closing the healthy broker", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("decoding-error"));
    await client.connect();
    const error = await client.execute({ ...spawnRequest(), timeoutMs: 500 }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BrokerOutputDecodingError);
    expect(error).toMatchObject({
      code: "invalid_output_encoding",
      data: { stream: "stdout", diagnosticCode: "invalid_output_encoding" }
    });
    await expect(client.doctor()).resolves.toMatchObject({ brokerVersion: "fixture" });
    await client.close();
  });

  it("releases overflow artifacts before rejecting undecodable foreground output", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-decode-release-"));
    const artifactPath = path.join(artifactRoot, "stdout-output.log");
    const client = new SigmaExecBrokerClient(fixtureOptions("decoding-error-artifact", {}, artifactRoot));
    await client.connect();
    await expect(client.execute({ ...spawnRequest(), timeoutMs: 500 }))
      .rejects.toBeInstanceOf(BrokerOutputDecodingError);
    await expect(access(artifactPath)).rejects.toThrow();
    await expect(client.doctor()).resolves.toMatchObject({ brokerVersion: "fixture" });
    await client.close();
  });

  it("contains artifact trust failures before returning the original protocol error", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-bad-import-"));
    const client = new SigmaExecBrokerClient(fixtureOptions("bad-artifact", {}, artifactRoot));
    await client.connect();
    const error = await client.execute({ ...spawnRequest(), timeoutMs: 500 })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BrokerProtocolError);
    expect(error).toMatchObject({ code: "broker_protocol_error" });
    await expect(client.doctor()).rejects.toThrow(/closed/u);
    await expect(access(artifactRoot)).rejects.toThrow();
  });

  it("fails closed when the required sandbox self-test fails", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("unavailable"));
    await expect(client.connect()).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("uses the configured request deadline for the broker doctor probe", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("slow-doctor", {
      requestTimeoutMs: 10
    }));
    await expect(client.connect()).rejects.toBeInstanceOf(BrokerTimeoutError);
  });

  it("requires explicit network approval and rejects unsafe-host policy", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions());
    await client.connect();
    const request = spawnRequest();
    await expect(client.spawn({ ...request, policy: { ...request.policy, network: "full" } })).rejects.toBeInstanceOf(BrokerPolicyError);
    await expect(client.spawn({
      ...request, policy: { ...request.policy, sandbox: "unsafe" }
    })).rejects.toBeInstanceOf(BrokerPolicyError);
    await client.close();
  });

  it("rejects malformed requests before they reach the broker", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions());
    await expect(client.doctor()).rejects.toBeInstanceOf(BrokerConnectionError);
    await client.connect();
    await expect(client.connect()).rejects.toBeInstanceOf(BrokerConnectionError);
    const request = spawnRequest();
    await expect(client.spawn({ ...request, command: { ...request.command, cwd: "relative" } })).rejects.toBeInstanceOf(BrokerPolicyError);
    await expect(client.spawn({ ...request, command: { ...request.command, args: ["bad\0arg"] } })).rejects.toBeInstanceOf(BrokerPolicyError);
    await expect(client.spawn({ ...request, command: { ...request.command, stdin: "bad\0input" } })).rejects.toBeInstanceOf(BrokerPolicyError);
    await expect(client.spawn({ ...request, policy: { ...request.policy, readRoots: [] } })).rejects.toBeInstanceOf(BrokerPolicyError);
    await expect(client.execute({ ...request, timeoutMs: 0 })).rejects.toBeInstanceOf(BrokerPolicyError);
    const closingStarted = performance.now();
    await client.close();
    expect(performance.now() - closingStarted).toBeGreaterThanOrEqual(15);
    await client.close();
  });

  it("has no unsafe-host escape and blocks unavailable required backends", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("normal"));
    await client.connect();
    await expect(client.spawn({
      ...spawnRequest(), policy: { ...requiredPolicy(), sandbox: "unsafe" }
    })).rejects.toThrow(/removed in V5/u);
    await client.close();
    const unavailable = new SigmaExecBrokerClient(fixtureOptions("unavailable"));
    await expect(unavailable.connect()).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("serializes cursor-changing operations for the same background handle", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("serialized-poll"));
    await client.connect();
    const handle = await client.spawn(spawnRequest());
    const [first, second] = await Promise.all([client.poll(handle), client.poll(handle)]);
    expect(first).toMatchObject({ state: "running", stdout: "abc" });
    expect(second).toMatchObject({ state: "exited", stdout: "def" });
    await client.close();
  });

  it("retires the broker when it reuses an active process identifier", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("duplicate-handle"));
    await client.connect();
    const first = await client.spawn(spawnRequest());
    await expect(client.spawn(spawnRequest())).rejects.toBeInstanceOf(BrokerProtocolError);
    expect(client.lostProcessHandles).toEqual([first]);
    await expect(client.poll(first)).rejects.toBeInstanceOf(BrokerProcessLostError);
    await client.close();
  });

  it("cancels requests through the broker protocol", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("hang"));
    await client.connect();
    const controller = new AbortController();
    const result = client.execute({ ...spawnRequest(), timeoutMs: 5_000 }, { signal: controller.signal });
    controller.abort(new Error("stop now"));
    await expect(result).rejects.toBeInstanceOf(BrokerCancelledError);
    await client.close();
  });

  it("preserves a stable runtime deadline code through acknowledged broker cancellation", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("hang"));
    await client.connect();
    const controller = new AbortController();
    const deadline = Object.assign(new Error("run deadline reached"), { code: "run_deadline" });
    const result = client.execute({ ...spawnRequest(), timeoutMs: 5_000 }, { signal: controller.signal });
    controller.abort(deadline);
    await expect(result).rejects.toMatchObject({ code: "run_deadline", cause: deadline });
    await client.close();
  });

  it("does not release an exec cancellation until the broker confirms terminal settlement", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-cancel-ack-"));
    const client = new SigmaExecBrokerClient(fixtureOptions("cancel-ack", {
      cancellationGraceMs: 2_000
    }, artifactRoot));
    await client.connect();
    const controller = new AbortController();
    const result = client.execute({ ...spawnRequest(), timeoutMs: 5_000 }, { signal: controller.signal });
    await expect.poll(async () => await access(path.join(artifactRoot, "exec-received-1"))
      .then(() => true, () => false)).toBe(true);
    controller.abort(new Error("stop safely"));
    await expect(result).rejects.toBeInstanceOf(BrokerCancelledError);
    await expect(access(path.join(artifactRoot, "cancel-settled"))).resolves.toBeUndefined();
    await expect(client.doctor()).resolves.toMatchObject({ sandbox: { available: true } });
    await client.close();
  });

  it("does not dispatch a queued request after its cancellation settles", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-queued-cancel-"));
    const client = new SigmaExecBrokerClient(fixtureOptions("normal", {}, artifactRoot));
    await client.connect();
    const input = (client as unknown as {
      transport: { child?: { stdin: { write: (...args: unknown[]) => boolean } } };
    }).transport.child!.stdin;
    const originalWrite = input.write.bind(input);
    let delayNextCallback = true;
    input.write = ((chunk: unknown, callback: (error?: Error | null) => void): boolean =>
      originalWrite(chunk, (error?: Error | null) => {
        if (!delayNextCallback) return callback(error);
        delayNextCallback = false;
        setTimeout(() => callback(error), 50);
      })) as typeof input.write;

    const first = client.doctor();
    const controller = new AbortController();
    const queued = client.doctor(controller.signal);
    controller.abort(new Error("cancel while queued"));
    await expect(queued).rejects.toBeInstanceOf(BrokerCancelledError);
    await expect(first).resolves.toMatchObject({ sandbox: { available: true } });
    await new Promise((resolve) => setTimeout(resolve, 75));
    await expect(access(path.join(artifactRoot, "doctor-2"))).resolves.toBeUndefined();
    await expect(access(path.join(artifactRoot, "doctor-3"))).rejects.toThrow();
    await client.close();
  });

  it("enforces transport deadlines", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("hang"));
    await client.connect();
    await expect(client.execute({ ...spawnRequest(), timeoutMs: 5_000 }, { timeoutMs: 20 })).rejects.toBeInstanceOf(BrokerTimeoutError);
    await client.close();
  });

  it("keeps pre-dispatch retry safety local to its request", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-dispatch-state-"));
    const client = new SigmaExecBrokerClient(fixtureOptions("hang", {}, artifactRoot));
    await client.connect();
    const inFlight = client.execute({ ...spawnRequest(), timeoutMs: 5_000 });
    await expect.poll(async () => await access(path.join(artifactRoot, "exec-received-1"))
      .then(() => true, () => false)).toBe(true);

    const input = (client as unknown as {
      transport: { child?: { stdin: { destroy(): void; writable: boolean } } };
    }).transport.child?.stdin;
    expect(input).toBeDefined();
    input!.destroy();
    expect(input!.writable).toBe(false);

    const preDispatch = client.doctor();
    const [unknownOutcome, safeOutcome] = await Promise.allSettled([inFlight, preDispatch]);
    expect(unknownOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "broker_connection_error", retrySafe: false }
    });
    expect(safeOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "broker_connection_error", retrySafe: true }
    });
    await client.close();
  });

  it("never applies cancellation-frame retry safety to other in-flight requests", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-cancel-dispatch-"));
    const client = new SigmaExecBrokerClient(fixtureOptions("hang", {}, artifactRoot));
    await client.connect();
    const first = client.execute({ ...spawnRequest(), timeoutMs: 5_000 });
    const controller = new AbortController();
    const cancelled = client.execute(
      { ...spawnRequest(), timeoutMs: 5_000 }, { signal: controller.signal }
    );
    await expect.poll(async () => await access(path.join(artifactRoot, "exec-received-2"))
      .then(() => true, () => false)).toBe(true);

    const input = (client as unknown as {
      transport: { child?: { stdin: { destroy(): void; writable: boolean } } };
    }).transport.child?.stdin;
    expect(input).toBeDefined();
    input!.destroy();
    controller.abort(new Error("cancel after dispatch"));

    const [unknownOutcome, cancelledOutcome] = await Promise.allSettled([first, cancelled]);
    expect(unknownOutcome).toMatchObject({
      status: "rejected",
      reason: { code: "broker_connection_error", retrySafe: false }
    });
    expect(cancelledOutcome).toMatchObject({
      status: "rejected", reason: { code: "broker_cancelled" }
    });
    await client.close();
  });

  it("settles a cancelled exec when helper shutdown cannot be confirmed", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-close-failure-"));
    const client = new SigmaExecBrokerClient(fixtureOptions("hang", {
      cancellationGraceMs: 10,
      shutdownGraceMs: 10
    }, artifactRoot));
    await client.connect();
    const transport = (client as unknown as {
      transport: { waitForChildClose(): Promise<boolean> };
    }).transport;
    transport.waitForChildClose = async () => false;

    const controller = new AbortController();
    const execution = client.execute(
      { ...spawnRequest(), timeoutMs: 5_000 }, { signal: controller.signal }
    );
    await expect.poll(async () => await access(path.join(artifactRoot, "exec-received-1"))
      .then(() => true, () => false)).toBe(true);
    controller.abort(new Error("cancel and contain"));
    const failure = await execution.catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "broker_cancelled" });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "broker_connection_error" })
    ]));
    await expect(client.close()).rejects.toMatchObject({ code: "broker_connection_error" });
    await rm(artifactRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  it("marks background handles lost after a broker crash", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-fixture-"));
    await writeFile(path.join(artifactRoot, "stale-output.log"), "redacted output");
    const client = new SigmaExecBrokerClient(fixtureOptions("crash-poll", {}, artifactRoot));
    await client.connect();
    const handle = await client.spawn(spawnRequest());
    await expect(client.poll(handle)).rejects.toThrow(/exited unexpectedly/i);
    expect(client.lostProcessHandles).toEqual([handle]);
    await expect(client.poll(handle)).rejects.toBeInstanceOf(BrokerProcessLostError);
    await client.close();
    await expect(access(artifactRoot)).rejects.toThrow();
  });
});

const healthyDoctorReport: BrokerDoctorReport = {
  protocolVersion: 1,
  brokerVersion: "test",
  platform: process.platform,
  architecture: process.arch,
  sandbox: {
    available: true,
    backend: "test",
    selfTestPassed: true,
    setupRequired: false
  },
  capabilities: {
    foreground: true,
    background: true,
    stdin: true,
    pty: false,
    networkModes: ["none"]
  }
};

const healthyExecutionResult = (): ExecutionResult => ({
  state: "exited",
  exitCode: 0,
  signal: null,
  durationMs: 1,
  timedOut: false,
  idleTimedOut: false,
  cancelled: false,
  stdout: "ok",
  stderr: "",
  stdoutDroppedBytes: 0,
  stderrDroppedBytes: 0,
  outputTruncated: false
});

class LifecycleBrokerFixture implements ExecutionBroker {
  readonly lostProcessHandles: ProcessHandle[] = [];
  connectCalls = 0;
  executeCalls = 0;
  spawnCalls = 0;
  pollCalls = 0;
  releaseCalls = 0;
  closeCalls = 0;

  constructor(
    private readonly run: () => Promise<ExecutionResult>,
    private readonly hooks: {
      connect?: () => Promise<BrokerDoctorReport>;
      spawn?: () => Promise<ProcessHandle>;
      poll?: (handle: ProcessHandle) => Promise<ProcessPollResult>;
      release?: (artifactIds: string[]) => Promise<void>;
      close?: () => Promise<void>;
    } = {}
  ) {}

  async connect(): Promise<BrokerDoctorReport> {
    this.connectCalls += 1;
    return this.hooks.connect ? await this.hooks.connect() : healthyDoctorReport;
  }
  async doctor(): Promise<BrokerDoctorReport> { return healthyDoctorReport; }
  async setupSandbox(): Promise<BrokerDoctorReport> { return healthyDoctorReport; }
  async execute(_request: ExecutionRequest): Promise<ExecutionResult> {
    this.executeCalls += 1;
    return await this.run();
  }
  async spawn(): Promise<ProcessHandle> {
    this.spawnCalls += 1;
    if (!this.hooks.spawn) throw new Error("unused");
    return await this.hooks.spawn();
  }
  async poll(handle: ProcessHandle): Promise<ProcessPollResult> {
    this.pollCalls += 1;
    if (!this.hooks.poll) throw new Error("unused");
    return await this.hooks.poll(handle);
  }
  async write(): Promise<void> { throw new Error("unused"); }
  async terminate(_handle: ProcessHandle): Promise<ProcessPollResult> { throw new Error("unused"); }
  async releaseOutputArtifacts(artifactIds: string[]): Promise<void> {
    this.releaseCalls += 1;
    await this.hooks.release?.(artifactIds);
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.hooks.close?.();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("LazyExecutionBroker generations", () => {
  const executionRequest = (): ExecutionRequest => ({ ...spawnRequest(), timeoutMs: 500 });

  it("rebuilds once and retries only a request rejected before dispatch", async () => {
    const stale = new LifecycleBrokerFixture(async () => {
      throw new BrokerConnectionError("closed before dispatch", { retrySafe: true });
    });
    const healthy = new LifecycleBrokerFixture(async () => healthyExecutionResult());
    const clients = [stale, healthy];
    let factories = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factories++]!
    });

    await expect(broker.execute(executionRequest())).resolves.toMatchObject({ stdout: "ok" });
    expect(factories).toBe(2);
    expect(stale.executeCalls).toBe(1);
    expect(stale.closeCalls).toBe(1);
    expect(healthy.connectCalls).toBe(1);
    expect(healthy.executeCalls).toBe(1);
    await broker.close();
  });

  it("does not replay an operation whose dispatch result is unknown", async () => {
    const failed = new LifecycleBrokerFixture(async () => {
      throw new BrokerConnectionError("connection ended after dispatch");
    });
    const healthy = new LifecycleBrokerFixture(async () => healthyExecutionResult());
    const clients = [failed, healthy];
    let factories = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factories++]!
    });

    await expect(broker.execute(executionRequest())).rejects.toMatchObject({
      code: "broker_connection_error",
      retrySafe: false
    });
    expect(failed.executeCalls).toBe(1);
    expect(healthy.executeCalls).toBe(0);
    await expect(broker.execute(executionRequest())).resolves.toMatchObject({ stdout: "ok" });
    expect(factories).toBe(2);
    await broker.close();
  });

  it("singleflights replacement for concurrent callers of one stale generation", async () => {
    const stale = new LifecycleBrokerFixture(async () => {
      throw new BrokerConnectionError("closed before dispatch", { retrySafe: true });
    });
    const healthy = new LifecycleBrokerFixture(async () => healthyExecutionResult());
    const clients = [stale, healthy];
    let factories = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factories++]!
    });

    await expect(Promise.all(Array.from({ length: 8 }, async () =>
      await broker.execute(executionRequest())
    ))).resolves.toHaveLength(8);
    expect(factories).toBe(2);
    expect(stale.closeCalls).toBe(1);
    expect(healthy.connectCalls).toBe(1);
    expect(healthy.executeCalls).toBe(8);
    await broker.close();
  });

  it("does not let one cancelled connection waiter poison the shared generation", async () => {
    const connection = deferred<BrokerDoctorReport>();
    const client = new LifecycleBrokerFixture(async () => healthyExecutionResult(), {
      connect: async () => await connection.promise
    });
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => client
    });
    const controller = new AbortController();
    const cancelled = broker.connect(controller.signal);
    controller.abort(new Error("caller left"));
    await expect(cancelled).rejects.toBeInstanceOf(BrokerCancelledError);

    const surviving = broker.connect();
    connection.resolve(healthyDoctorReport);
    await expect(surviving).resolves.toEqual(healthyDoctorReport);
    expect(client.connectCalls).toBe(1);
    await broker.close();
  });

  it("replaces a generation when its handshake fails before the user operation", async () => {
    const stale = new LifecycleBrokerFixture(async () => {
      throw new Error("the user operation must not reach the stale client");
    }, {
      connect: async () => { throw new BrokerConnectionError("doctor response was lost"); }
    });
    const healthy = new LifecycleBrokerFixture(async () => healthyExecutionResult());
    const clients = [stale, healthy];
    let factories = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factories++]!
    });

    await expect(broker.execute(executionRequest())).resolves.toMatchObject({ stdout: "ok" });
    expect(factories).toBe(2);
    expect(stale.executeCalls).toBe(0);
    expect(healthy.executeCalls).toBe(1);
    await broker.close();
  });

  it("fails closed without creating a new client when retirement cannot be confirmed", async () => {
    const original = new BrokerConnectionError("result is unknown");
    const retirement = new Error("process handle is still live");
    const stale = new LifecycleBrokerFixture(async () => { throw original; }, {
      close: async () => { throw retirement; }
    });
    let factories = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => { factories += 1; return stale; }
    });

    const failure = await broker.execute(executionRequest()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BrokerConnectionError);
    expect(failure).toBe(original);
    expect(failure).toMatchObject({ message: original.message, retrySafe: false });
    expect((failure as Error).cause).toMatchObject({
      errors: [expect.objectContaining({ code: "broker_connection_error", cause: retirement })]
    });
    expect(factories).toBe(1);
    await expect(broker.execute(executionRequest())).rejects.toBeInstanceOf(BrokerConnectionError);
    expect(stale.executeCalls).toBe(1);
    expect(factories).toBe(1);
    await expect(broker.close()).rejects.toThrow(/process handle is still live/i);
  });

  it("blocks later calls from dispatching into a generation while it retires", async () => {
    const retirementStarted = deferred<void>();
    const allowRetirement = deferred<void>();
    const stale = new LifecycleBrokerFixture(async () => {
      throw new BrokerConnectionError("connection ended after dispatch");
    }, {
      close: async () => {
        retirementStarted.resolve();
        await allowRetirement.promise;
      }
    });
    const healthy = new LifecycleBrokerFixture(async () => healthyExecutionResult());
    const clients = [stale, healthy];
    let factories = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factories++]!
    });

    const first = broker.execute(executionRequest());
    await retirementStarted.promise;
    const second = broker.execute(executionRequest());
    await Promise.resolve();
    expect(stale.executeCalls).toBe(1);
    allowRetirement.resolve();
    await expect(first).rejects.toMatchObject({ code: "broker_connection_error" });
    await expect(second).resolves.toMatchObject({ stdout: "ok" });
    expect(stale.executeCalls).toBe(1);
    expect(healthy.executeCalls).toBe(1);
    await broker.close();
  });

  it("rechecks generation state after a shared connection wait and immediately before dispatch", async () => {
    const firstStarted = deferred<void>();
    const firstResult = deferred<ExecutionResult>();
    const retirementStarted = deferred<void>();
    const allowRetirement = deferred<void>();
    let runs = 0;
    const stale = new LifecycleBrokerFixture(async () => {
      runs += 1;
      if (runs === 1) {
        firstStarted.resolve();
        return await firstResult.promise;
      }
      return healthyExecutionResult();
    }, {
      close: async () => {
        retirementStarted.resolve();
        await allowRetirement.promise;
      }
    });
    const healthy = new LifecycleBrokerFixture(async () => healthyExecutionResult());
    const clients = [stale, healthy];
    let factories = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factories++]!
    });
    await broker.connect();

    const first = broker.execute(executionRequest());
    await firstStarted.promise;
    // B enters the already-resolved shared connection wait. Rejecting A now
    // makes its retirement continuation race B's post-connect continuation.
    const second = broker.execute(executionRequest());
    firstResult.reject(new BrokerConnectionError("first result is unknown"));
    await retirementStarted.promise;
    expect(stale.executeCalls).toBe(1);
    allowRetirement.resolve();
    await expect(first).rejects.toMatchObject({ code: "broker_connection_error" });
    await expect(second).resolves.toMatchObject({ stdout: "ok" });
    expect(stale.executeCalls).toBe(1);
    expect(healthy.executeCalls).toBe(1);
    await broker.close();
  });

  it("singleflights close until the underlying client has actually stopped", async () => {
    const closing = deferred<void>();
    const client = new LifecycleBrokerFixture(async () => healthyExecutionResult(), {
      close: async () => await closing.promise
    });
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => client
    });
    await broker.connect();

    let firstDone = false;
    let secondDone = false;
    const first = broker.close().then(() => { firstDone = true; });
    const second = broker.close().then(() => { secondDone = true; });
    await Promise.resolve();
    expect(client.closeCalls).toBe(1);
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);
    closing.resolve();
    await Promise.all([first, second]);
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(true);
  });

  it("never sends an old process handle to a replacement generation", async () => {
    const handle: ProcessHandle = { id: "background-1", brokerInstanceId: "stale-instance" };
    const stale = new LifecycleBrokerFixture(async () => {
      throw new BrokerConnectionError("unrelated request lost its result");
    }, {
      spawn: async () => handle,
      poll: async () => { throw new BrokerConnectionError("broker ended"); }
    });
    const healthy = new LifecycleBrokerFixture(async () => healthyExecutionResult(), {
      poll: async () => { throw new Error("old handle reached the replacement"); }
    });
    const clients = [stale, healthy];
    let factories = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factories++]!
    });

    const publicHandle = await broker.spawn(spawnRequest());
    expect(publicHandle).not.toEqual(handle);
    await expect(broker.poll(publicHandle)).rejects.toBeInstanceOf(BrokerProcessLostError);
    expect(healthy.pollCalls).toBe(0);
    expect(broker.lostProcessHandles).toContainEqual(publicHandle);
    await broker.close();
  });

  it("does not return a spawned handle when close wins the completion race", async () => {
    const spawned = deferred<ProcessHandle>();
    const handle: ProcessHandle = { id: "late-background", brokerInstanceId: "closing-instance" };
    const client = new LifecycleBrokerFixture(async () => healthyExecutionResult(), {
      spawn: async () => await spawned.promise
    });
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => client
    });

    const pendingSpawn = broker.spawn(spawnRequest());
    while (client.spawnCalls === 0) await Promise.resolve();
    await broker.close();
    spawned.resolve(handle);
    await expect(pendingSpawn).rejects.toBeInstanceOf(BrokerProcessLostError);
    expect(broker.lostProcessHandles).toEqual([
      expect.objectContaining({ id: "process:1" })
    ]);
    expect(broker.lostProcessHandles).not.toContainEqual(handle);
  });

  it("does not replay a late spawn after its generation is concurrently retired", async () => {
    const spawned = deferred<ProcessHandle>();
    const stale = new LifecycleBrokerFixture(async () => {
      throw new BrokerConnectionError("concurrent result is unknown");
    }, {
      spawn: async () => await spawned.promise
    });
    const healthy = new LifecycleBrokerFixture(async () => healthyExecutionResult());
    const clients = [stale, healthy];
    let factories = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factories++]!
    });

    const pendingSpawn = broker.spawn(spawnRequest());
    while (stale.spawnCalls === 0) await Promise.resolve();
    await expect(broker.execute(executionRequest())).rejects.toBeInstanceOf(BrokerConnectionError);
    spawned.resolve({ id: "late-background", brokerInstanceId: "retired-instance" });
    await expect(pendingSpawn).rejects.toBeInstanceOf(BrokerProcessLostError);
    expect(healthy.spawnCalls).toBe(0);
    await broker.close();
  });

  it("retires but never replays an artifact acknowledgement with an unknown result", async () => {
    const stale = new LifecycleBrokerFixture(async () => healthyExecutionResult(), {
      release: async () => { throw new BrokerConnectionError("ack result is unknown"); }
    });
    const healthy = new LifecycleBrokerFixture(async () => healthyExecutionResult());
    const clients = [stale, healthy];
    let factories = 0;
    const broker = new LazyExecutionBroker({
      sandboxMode: "required",
      clientFactory: () => clients[factories++]!
    });

    await expect(broker.releaseOutputArtifacts(["artifact-1"]))
      .rejects.toMatchObject({ code: "broker_connection_error" });
    expect(stale.releaseCalls).toBe(1);
    expect(healthy.releaseCalls).toBe(0);
    await expect(broker.execute(executionRequest())).resolves.toMatchObject({ stdout: "ok" });
    expect(stale.executeCalls).toBe(0);
    expect(healthy.executeCalls).toBe(1);
    await broker.close();
  });
});
