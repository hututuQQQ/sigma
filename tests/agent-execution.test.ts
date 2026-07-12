import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { access, cp, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BoundedByteRingBuffer,
  BrokerCancelledError,
  BrokerConnectionError,
  BrokerFrameDecoder,
  BrokerOutputDecodingError,
  BrokerPolicyError,
  BrokerProcessLostError,
  BrokerProtocolError,
  BrokerToolchainEnvironmentConflictError,
  BrokerTimeoutError,
  BrokerToolchainUnavailableError,
  SandboxUnavailableError,
  SecretRedactor,
  SigmaExecBrokerClient,
  createMinimalEnvironment,
  encodeBrokerFrame,
  parseBrokerResponse,
  resolveSigmaExecBinary
} from "../packages/agent-execution/src/index.js";
import {
  parseDoctor,
  parseExecutionValue,
  parseHandleId,
  parseHello,
  parseProcessValue,
  parseSpawnedProcess
} from "../packages/agent-execution/src/values.js";
import { BrokerOutputArtifactImporter } from "../packages/agent-execution/src/output-artifact-import.js";
import type {
  ExecutionPolicy,
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
const handle = request => {
  if (request.method === "hello") {
    ok(request, {
      protocolVersion: 1, instanceId: "fixture-instance",
      ...(artifactRoot ? { artifactRoot } : {})
    });
  } else if (request.method === "doctor") {
    const available = mode !== "unavailable";
    ok(request, {
      protocolVersion: 1, brokerVersion: "fixture", platform: process.platform, architecture: process.arch,
      sandbox: { available, backend: "fixture", selfTestPassed: available, setupRequired: !available, reason: available ? undefined : "missing sandbox" },
      capabilities: { foreground: true, background: true, stdin: true, pty: false, networkModes: ["none", "full"] }
    });
  } else if (request.method === "sandbox.setup") {
    ok(request, {
      protocolVersion: 1, brokerVersion: "fixture", platform: process.platform, architecture: process.arch,
      sandbox: { available: true, backend: "fixture", selfTestPassed: true, setupRequired: false },
      capabilities: { foreground: true, background: true, stdin: true, pty: true, networkModes: ["none", "full"] }
    });
  } else if (request.method === "exec" && mode === "hang") {
    // cancellation request remains readable while this logical request is pending
  } else if (request.method === "exec" && mode === "cancel-ack") {
    pendingExec = request;
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
  } else if (request.method === "exec") {
    ok(request, { ...terminal("secret-value"), timedOut: false, idleTimedOut: false, cancelled: false });
  } else if (request.method === "process.spawn") {
    if (mode === "toolchain-check" && (
      !request.params.policy.executionRoots.some(root => path.resolve(root) === path.resolve(process.execPath))
      || request.params.command.env.NODE_OPTIONS !== "--preserve-symlinks-main"
    )) {
      fail(request, "policy_denied", "trusted toolchain policy was not forwarded");
    } else if (mode === "toolchain-alias-check" && (
      path.resolve(request.params.command.executable) !== path.resolve(process.execPath)
      || !request.params.policy.executionRoots.some(root => path.resolve(root) === path.resolve(process.execPath))
    )) {
      fail(request, "policy_denied", "trusted toolchain alias was not resolved exactly");
    } else if (mode === "pty-check" && (request.params.pty !== true || request.params.ptyColumns !== 90 || request.params.ptyRows !== 20)) {
      fail(request, "broker_protocol_error", "PTY request was not forwarded");
    } else if (mode === "slow-spawn") {
      setTimeout(() => ok(request, { handleId: "fixture-process" }), 50);
    } else ok(request, { handleId: "fixture-process" });
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
      sandbox: { ...doctor.sandbox, hardening: { ...doctor.sandbox.hardening, landlockAbi: undefined } }
    }).sandbox.hardening).not.toHaveProperty("landlockAbi");
    expect(() => parseDoctor({ ...doctor, protocolVersion: 2 })).toThrow(BrokerProtocolError);
    expect(() => parseDoctor({ ...doctor, capabilities: { ...doctor.capabilities, networkModes: ["domain"] } })).toThrow(BrokerProtocolError);
    expect(() => parseDoctor({
      ...doctor,
      capabilities: { ...doctor.capabilities, shells: [{ kind: "powershell", executable: "powershell.exe", verified: false }] }
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
    expect(parseExecutionValue({ ...processValue, timedOut: false, idleTimedOut: false, cancelled: false })).toMatchObject({ state: "exited" });
    expect(() => parseExecutionValue({ ...processValue, timedOut: "false", idleTimedOut: false, cancelled: false }))
      .toThrow(BrokerProtocolError);
    expect(() => parseExecutionValue({ ...processValue, state: "running", timedOut: false, idleTimedOut: false, cancelled: false })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({ ...processValue, state: "lost" })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({ ...processValue, exitCode: 1.5 })).toThrow(BrokerProtocolError);
    expect(() => parseProcessValue({ ...processValue, durationMs: -1 })).toThrow(BrokerProtocolError);
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
    await client.close();
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
        environment: { NODE_OPTIONS: "--preserve-symlinks-main" }
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
        environment: { overrides: { NODE_OPTIONS: "--preserve-symlinks-main" } }
      }
    })).resolves.toMatchObject({ id: "fixture-process" });
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
    })).rejects.toBeInstanceOf(BrokerPolicyError);
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
    })).rejects.toBeInstanceOf(BrokerPolicyError);
    await expect(client.spawn({
      ...request,
      policy: { ...request.policy, executionRoots: [request.command.cwd], writeRoots: [request.command.cwd] }
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

  it("fails closed when the required sandbox self-test fails", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("unavailable"));
    await expect(client.connect()).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("requires explicit network and unsafe-host approvals", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions());
    await client.connect();
    const request = spawnRequest();
    await expect(client.spawn({ ...request, policy: { ...request.policy, network: "full" } })).rejects.toBeInstanceOf(BrokerPolicyError);
    await expect(client.spawn({
      ...request, policy: { ...request.policy, sandbox: "unsafe", unsafeHostExecApproved: true }
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

  it("permits the explicit two-key unsafe escape and blocks required calls on unavailable backends", async () => {
    const allowed = new SigmaExecBrokerClient(fixtureOptions("normal", {
      sandboxMode: "unsafe", allowUnsafeHostExec: true
    }));
    await allowed.connect();
    await expect(allowed.spawn({
      ...spawnRequest(), policy: { ...requiredPolicy(), sandbox: "unsafe", unsafeHostExecApproved: true }
    })).resolves.toMatchObject({ id: "fixture-process" });
    await allowed.close();
    const unavailable = new SigmaExecBrokerClient(fixtureOptions("unavailable", { sandboxMode: "unsafe" }));
    await unavailable.connect();
    await expect(unavailable.spawn(spawnRequest())).rejects.toBeInstanceOf(SandboxUnavailableError);
    await unavailable.close();
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
    const client = new SigmaExecBrokerClient(fixtureOptions("cancel-ack", {}, artifactRoot));
    await client.connect();
    const controller = new AbortController();
    const result = client.execute({ ...spawnRequest(), timeoutMs: 5_000 }, { signal: controller.signal });
    controller.abort(new Error("stop safely"));
    await expect(result).rejects.toBeInstanceOf(BrokerCancelledError);
    await expect(access(path.join(artifactRoot, "cancel-settled"))).resolves.toBeUndefined();
    await expect(client.doctor()).resolves.toMatchObject({ sandbox: { available: true } });
    await client.close();
  });

  it("enforces transport deadlines", async () => {
    const client = new SigmaExecBrokerClient(fixtureOptions("hang"));
    await client.connect();
    await expect(client.execute({ ...spawnRequest(), timeoutMs: 5_000 }, { timeoutMs: 20 })).rejects.toBeInstanceOf(BrokerTimeoutError);
    await client.close();
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
