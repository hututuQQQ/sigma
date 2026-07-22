import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrokerFrameDecoder,
  ContainerAttestationInvalidError,
  ContainerUnavailableError,
  SigmaExecBrokerClient,
  encodeBrokerFrame,
  fixedContainerAttestationDigest,
  parseFixedContainerAttestation
} from "../packages/agent-execution/src/index.js";

const fixtures: string[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true });
});

function doctor() {
  return {
    protocolVersion: 1,
    brokerVersion: "oci-fixture",
    platform: "linux",
    architecture: "x64",
    sandbox: {
      available: true,
      backend: "oci",
      selfTestPassed: true,
      setupRequired: false
    },
    container: {
      available: true,
      backend: "oci",
      engine: "docker",
      target: "managed",
      targetId: "main-1",
      targetStartedAt: "2026-07-19T00:00:00Z",
      imageId: "image-1",
      imageDigest: `sha256:${"1".repeat(64)}`,
      attestationDigest: `sha256:${"2".repeat(64)}`
    },
    capabilities: {
      foreground: true,
      background: true,
      stdin: true,
      pty: false,
      processHandoff: false,
      networkModes: ["none"],
      executionRoots: true,
      runtimeCommands: ["python", "git"],
      runtimeCommandSnapshotComplete: true,
      executableSearchPaths: ["/usr/bin", "/bin"],
      managedEnvironment: { available: true, prepare: true },
      shells: [{
        kind: "bash",
        executable: "/bin/bash",
        verified: true,
        supportsChildProcesses: true
      }]
    }
  };
}

function send(socket: Socket, requestId: number, result: unknown): void {
  socket.write(encodeBrokerFrame({ protocolVersion: 1, requestId, ok: true, result }));
}

function sendError(socket: Socket, requestId: number, code: string): void {
  socket.write(encodeBrokerFrame({
    protocolVersion: 1,
    requestId,
    ok: false,
    error: { code, message: `fixture ${code}` }
  }));
}

describe("trusted OCI socket transport", () => {
  it("accepts a product-owned duplex stream without exposing an engine path", async () => {
    const requests = new PassThrough();
    const responses = new PassThrough();
    const stream = Duplex.from({ writable: requests, readable: responses });
    const decoder = new BrokerFrameDecoder();
    requests.on("data", (chunk: Buffer) => {
      for (const raw of decoder.push(chunk)) {
        const request = raw as { requestId: number; method: string };
        const result = request.method === "hello"
          ? { protocolVersion: 1, instanceId: "owned-stream-fixture" }
          : request.method === "doctor" ? doctor() : { shutdown: true };
        responses.write(encodeBrokerFrame({
          protocolVersion: 1, requestId: request.requestId, ok: true, result
        }));
        if (request.method === "shutdown") responses.end();
      }
    });
    const client = new SigmaExecBrokerClient({
      trustedStream: stream,
      sandboxMode: "required",
      executionBackend: "oci",
      trustedToolchains: []
    });
    await expect(client.connect()).resolves.toMatchObject({ brokerVersion: "oci-fixture" });
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("uses the framed broker protocol without starting a local helper", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-oci-socket-"));
    fixtures.push(root);
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\sigma-oci-${randomUUID()}` : path.join(root, "broker.sock");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const server = createServer((socket) => {
      const decoder = new BrokerFrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
          const request = raw as { requestId: number; method: string; params: Record<string, unknown> };
          requests.push({ method: request.method, params: request.params });
          if (request.method === "hello") {
            send(socket, request.requestId, { protocolVersion: 1, instanceId: "oci-socket-fixture" });
          } else if (request.method === "doctor") {
            send(socket, request.requestId, doctor());
          } else if (request.method === "exec") {
            send(socket, request.requestId, {
              state: "exited", exitCode: 0, signal: null, durationMs: 2,
              stdout: { data: "socket-ok", nextOffset: 9, droppedBytes: 0 },
              stderr: { data: "", nextOffset: 0, droppedBytes: 0 },
              timedOut: false, idleTimedOut: false, cancelled: false
            });
          } else if (request.method === "environment.prepare") {
            send(socket, request.requestId, {
              protocolVersion: 1,
              status: "prepared",
              sessionId: request.params.sessionId,
              requestedExecutable: request.params.requestedExecutable,
              packages: request.params.packages,
              installedPackages: [{
                name: "fixture-package", version: "1.0", source: "signed-fixture",
                digest: `sha256:${"3".repeat(64)}`
              }],
              packageManager: "apt-get",
              signaturePolicy: "trusted-system-package-manager-defaults",
              attemptDigest: `sha256:${"4".repeat(64)}`,
              installedEvidenceDigest: `sha256:${"5".repeat(64)}`,
              previousRuntimeClosureDigest: `sha256:${"6".repeat(64)}`,
              runtimeClosure: {
                protocolVersion: 1,
                digest: `sha256:${"7".repeat(64)}`,
                complete: true,
                platform: "linux",
                architecture: "x64",
                executableSearchPathsDigest: `sha256:${"8".repeat(64)}`,
                runtimeCommandsDigest: `sha256:${"9".repeat(64)}`,
                targetAttestationDigest: `sha256:${"a".repeat(64)}`
              },
              receiptDigest: `sha256:${"b".repeat(64)}`
            });
          } else if (request.method === "scratch.acquire") {
            send(socket, request.requestId, {
              protocolVersion: 1,
              sessionId: request.params.sessionId,
              leaseId: "scratch-1",
              lifetime: "runtime_session",
              isolation: "private",
              persistentAcrossCalls: true,
              home: "/home/sigma",
              temp: "/tmp"
            });
          } else if (request.method === "scratch.release") {
            send(socket, request.requestId, { released: true });
          } else if (request.method === "process.spawn") {
            send(socket, request.requestId, { handleId: "socket-process-1", processId: 42 });
          } else if (request.method === "process.write") {
            send(socket, request.requestId, {});
          } else if (request.method === "process.terminate") {
            send(socket, request.requestId, {
              state: "terminated", exitCode: null, signal: "SIGTERM", durationMs: 3,
              stdout: { data: "", nextOffset: 0, droppedBytes: 0 },
              stderr: { data: "", nextOffset: 0, droppedBytes: 0 }
            });
          } else if (request.method === "process.release") {
            send(socket, request.requestId, { released: true });
          } else if (request.method === "shutdown") {
            send(socket, request.requestId, { shutdown: true });
            socket.end();
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const client = new SigmaExecBrokerClient({
      socketPath,
      sandboxMode: "required",
      executionBackend: "oci",
      trustedToolchains: []
    });
    try {
      await expect(client.connect()).resolves.toMatchObject({
        container: { engine: "docker", targetId: "main-1" },
        capabilities: { runtimeCommands: ["python", "git"] }
      });
      await expect(client.prepareManagedEnvironment({
        protocolVersion: 1,
        sessionId: "session-1",
        requestedExecutable: "fixture-tool",
        packages: ["fixture-package"]
      })).resolves.toMatchObject({
        status: "prepared",
        installedPackages: [{ name: "fixture-package", version: "1.0" }]
      });
      await expect(client.acquireScratchLease({
        protocolVersion: 1, sessionId: "session-1"
      })).resolves.toMatchObject({ leaseId: "scratch-1", persistentAcrossCalls: true });
      await expect(client.releaseScratchLease("session-1")).resolves.toBeUndefined();
      await expect(client.execute({
        command: { executable: "/bin/bash", args: ["-lc", "true"], cwd: "/workspace" },
        policy: {
          sandbox: "required",
          network: "none",
          readRoots: ["/workspace"],
          writeRoots: ["/workspace"]
        }
      })).resolves.toMatchObject({ stdout: "socket-ok", exitCode: 0 });
      const handle = await client.spawn({
        command: { executable: "/bin/bash", args: ["-lc", "read value"], cwd: "/workspace" },
        policy: {
          sandbox: "required",
          network: "none",
          readRoots: ["/workspace"],
          writeRoots: []
        }
      });
      await expect(client.write(handle, "done\n")).resolves.toBeUndefined();
      await expect(client.terminate(handle)).resolves.toMatchObject({
        state: "terminated", signal: "SIGTERM"
      });
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(requests.map((request) => request.method)).toEqual([
      "hello", "doctor", "environment.prepare", "scratch.acquire", "scratch.release",
      "exec", "process.spawn", "process.write", "process.terminate",
      "process.release", "shutdown"
    ]);
    const policy = requests.find((request) => request.method === "exec")?.params.policy as {
      protectedPaths: string[];
    };
    expect(policy.protectedPaths.some((item) => path.basename(item) === ".agent")).toBe(true);
    expect(policy.protectedPaths.some((item) => path.basename(item) === ".git")).toBe(true);
  });

  it("parses the fixed launcher proof with a canonical digest and rejects extensions", () => {
    const payload = {
      protocolVersion: 1 as const,
      engine: "podman" as const,
      selector: "project/main",
      targetId: "main-1",
      targetStartedAt: "2026-07-19T00:00:00Z",
      imageId: "image-1",
      labelsDigest: `sha256:${"3".repeat(64)}`,
      helperDigest: `sha256:${"4".repeat(64)}`
    };
    const source = JSON.stringify({
      ...payload,
      attestationDigest: fixedContainerAttestationDigest(payload),
      workspace: "/workspace"
    });
    expect(parseFixedContainerAttestation(source)).toMatchObject({
      engine: "podman", targetId: "main-1", workspace: "/workspace"
    });
    expect(() => parseFixedContainerAttestation(JSON.stringify({
      ...JSON.parse(source), injectedSelector: "other"
    }))).toThrow(/Unknown fixed OCI attestation field/u);
  });

  it.each([
    ["container_unavailable", ContainerUnavailableError],
    ["container_attestation_invalid", ContainerAttestationInvalidError]
  ] as const)("maps %s from the socket broker to its typed error", async (code, ErrorType) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-oci-socket-error-"));
    fixtures.push(root);
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\sigma-oci-error-${randomUUID()}` : path.join(root, "broker.sock");
    const server = createServer((socket) => {
      const decoder = new BrokerFrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
          const request = raw as { requestId: number; method: string };
          if (request.method === "hello") {
            send(socket, request.requestId, { protocolVersion: 1, instanceId: "oci-error-fixture" });
          } else if (request.method === "doctor") {
            sendError(socket, request.requestId, code);
          } else if (request.method === "shutdown") {
            send(socket, request.requestId, { shutdown: true });
            socket.end();
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const client = new SigmaExecBrokerClient({ socketPath, sandboxMode: "required" });
    await expect(client.connect()).rejects.toBeInstanceOf(ErrorType);
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
