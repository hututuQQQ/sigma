import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrokerProcessLostError,
  SecretRedactor,
  SigmaExecBrokerClient
} from "../packages/agent-execution/src/index.js";
import { BrokerOutputArtifactImporter } from "../packages/agent-execution/src/output-artifact-import.js";
import type { ExecutionPolicy, SigmaExecBrokerClientOptions } from "../packages/agent-execution/src/index.js";

const SHUTDOWN_SPOOL_FIXTURE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const artifactRoot = path.resolve(process.argv[1]);
const mode = process.argv[2] || "normal";
const observationPath = artifactRoot + ".shutdown-observation";
fs.mkdirSync(artifactRoot, { recursive: true });
let input = Buffer.alloc(0);
const send = value => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
};
const ok = (request, result) => send({
  protocolVersion: 1, requestId: request.requestId, ok: true, result
});
const handle = request => {
  if (request.method === "hello") {
    ok(request, { protocolVersion: 1, instanceId: "shutdown-spool-fixture", artifactRoot });
  } else if (request.method === "doctor") {
    const respond = () => ok(request, {
      protocolVersion: 1, brokerVersion: "fixture", platform: process.platform,
      architecture: process.arch,
      sandbox: { available: true, backend: "fixture", selfTestPassed: true, setupRequired: false },
      capabilities: {
        foreground: true, background: true, stdin: true, pty: false, networkModes: ["none"]
      }
    });
    if (mode === "slow-doctor") {
      fs.writeFileSync(artifactRoot + ".doctor-started", "yes");
      setTimeout(respond, 100);
    } else {
      respond();
    }
  } else if (request.method === "exec") {
    ok(request, {
      state: "exited", exitCode: 0, signal: null, durationMs: 1,
      stdout: { data: "done", nextOffset: 4, droppedBytes: 0 },
      stderr: { data: "", nextOffset: 0, droppedBytes: 0 },
      timedOut: false, idleTimedOut: false, cancelled: false
    });
  } else if (request.method === "process.spawn") {
    ok(request, { handleId: "active-process", processId: 4242 });
  } else if (request.method === "shutdown") {
    ok(request, { shutdown: true });
    setTimeout(() => {
      const rootStillPresent = fs.existsSync(artifactRoot);
      if (rootStillPresent) {
        fs.writeFileSync(path.join(artifactRoot, "late-terminal-output.log"), "terminal output");
      }
      fs.writeFileSync(observationPath, rootStillPresent ? "present" : "missing");
      process.exit(0);
    }, 40);
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

function fixtureOptions(artifactRoot: string, mode = "normal"): SigmaExecBrokerClientOptions {
  return {
    helperPath: process.execPath,
    helperArgs: ["-e", SHUTDOWN_SPOOL_FIXTURE, artifactRoot, mode],
    requestTimeoutMs: 1_000,
    shutdownGraceMs: 250,
    cancellationGraceMs: 250,
    trustedToolchains: []
  };
}

const requiredPolicy = (): ExecutionPolicy => ({
  sandbox: "required",
  network: "none",
  readRoots: [process.cwd()],
  writeRoots: [],
  executionRoots: [process.execPath]
});

async function waitForPath(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await access(filePath).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for '${filePath}'.`);
}

describe("SigmaExecBrokerClient shutdown lifecycle", () => {
  it("accepts broker spools only beneath the configured shared artifact parent", async () => {
    const trustedParent = await mkdtemp(path.join(process.cwd(), ".sigma-oci-artifacts-trusted-"));
    const untrustedParent = await mkdtemp(path.join(process.cwd(), ".sigma-oci-artifacts-untrusted-"));
    const trustedRoot = await mkdtemp(path.join(trustedParent, "sigma-exec-artifacts-"));
    const untrustedRoot = await mkdtemp(path.join(untrustedParent, "sigma-exec-artifacts-"));
    const systemTemporaryRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-untrusted-"));
    const importer = new BrokerOutputArtifactImporter(
      new SecretRedactor({}),
      async () => undefined,
      undefined,
      trustedParent
    );
    try {
      await expect(importer.configureRoot(untrustedRoot)).rejects.toThrow(
        "Broker artifactRoot resolves outside its trusted parent."
      );
      await expect(importer.configureRoot(systemTemporaryRoot)).rejects.toThrow(
        "Broker artifactRoot resolves outside its trusted parent."
      );
      await expect(importer.configureRoot(trustedRoot)).resolves.toBeUndefined();
    } finally {
      await importer.cleanup().catch(() => undefined);
      await rm(trustedParent, { recursive: true, force: true });
      await rm(untrustedParent, { recursive: true, force: true });
      await rm(systemTemporaryRoot, { recursive: true, force: true });
    }
  });

  it("marks active handles lost before waiting, then removes spool only after helper exit", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-shutdown-"));
    const observationPath = `${artifactRoot}.shutdown-observation`;
    const client = new SigmaExecBrokerClient(fixtureOptions(artifactRoot));
    try {
      await client.connect();
      const handle = await client.spawn({
        command: { executable: process.execPath, args: ["--version"], cwd: process.cwd() },
        policy: requiredPolicy()
      });

      const firstClose = client.close();
      const secondClose = client.close();
      expect(client.lostProcessHandles).toEqual([handle]);
      await expect(client.poll(handle)).rejects.toBeInstanceOf(BrokerProcessLostError);
      await Promise.all([firstClose, secondClose]);

      expect(await readFile(observationPath, "utf8")).toBe("present");
      await expect(access(artifactRoot)).rejects.toThrow();
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
      await rm(observationPath, { force: true });
    }
  });

  it("propagates and singleflights an output artifact cleanup failure", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-cleanup-"));
    const canonicalArtifactRoot = await realpath(artifactRoot);
    const cleanupFailure = new Error("artifact root removal failed");
    let removals = 0;
    const importer = new BrokerOutputArtifactImporter(
      new SecretRedactor({}),
      async () => undefined,
      async (root) => {
        removals += 1;
        expect(root).toBe(canonicalArtifactRoot);
        throw cleanupFailure;
      }
    );
    try {
      await importer.configureRoot(artifactRoot);
      const firstCleanup = importer.cleanup();
      const secondCleanup = importer.cleanup();
      await expect(firstCleanup).rejects.toBe(cleanupFailure);
      await expect(secondCleanup).rejects.toBe(cleanupFailure);
      expect(removals).toBe(1);
      await expect(importer.cleanup()).rejects.toBe(cleanupFailure);
      expect(removals).toBe(2);
      await expect(access(artifactRoot)).resolves.toBeUndefined();
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("waits for response post-processing before deleting the broker spool", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-import-close-"));
    const observationPath = `${artifactRoot}.shutdown-observation`;
    const client = new SigmaExecBrokerClient(fixtureOptions(artifactRoot));
    try {
      await client.connect();
      const importer = (client as unknown as { outputArtifacts: BrokerOutputArtifactImporter }).outputArtifacts;
      const originalConsume = importer.consume.bind(importer);
      let entered!: () => void;
      let release!: () => void;
      const consumeEntered = new Promise<void>((resolve) => { entered = resolve; });
      const consumeGate = new Promise<void>((resolve) => { release = resolve; });
      importer.consume = async (artifacts) => {
        entered();
        await consumeGate;
        return await originalConsume(artifacts);
      };

      const executing = client.execute({
        command: { executable: process.execPath, args: ["--version"], cwd: process.cwd() },
        policy: requiredPolicy(), timeoutMs: 1_000
      });
      await consumeEntered;
      let closeSettled = false;
      const closing = client.close().finally(() => { closeSettled = true; });
      await waitForPath(observationPath);
      expect(closeSettled).toBe(false);
      await expect(access(artifactRoot)).resolves.toBeUndefined();

      release();
      await expect(executing).resolves.toMatchObject({ stdout: "done", exitCode: 0 });
      await expect(closing).resolves.toBeUndefined();
      await expect(access(artifactRoot)).rejects.toThrow();
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
      await rm(observationPath, { force: true });
    }
  });

  it("retries shutdown confirmation before cleaning a previously retained spool", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-close-retry-"));
    const observationPath = `${artifactRoot}.shutdown-observation`;
    const client = new SigmaExecBrokerClient(fixtureOptions(artifactRoot));
    try {
      await client.connect();
      const transport = (client as unknown as {
        transport: { waitForChildClose(): Promise<boolean> };
      }).transport;
      let confirmed = false;
      transport.waitForChildClose = async () => confirmed;

      await expect(client.close()).rejects.toThrow(/did not release its process handle/u);
      await expect(access(artifactRoot)).resolves.toBeUndefined();
      confirmed = true;
      await expect(client.close()).resolves.toBeUndefined();
      await expect(access(artifactRoot)).rejects.toThrow();
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
      await rm(observationPath, { force: true });
    }
  });

  it("waits for pending startup to settle before completing a concurrent close", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-exec-artifacts-connect-close-"));
    const doctorStartedPath = `${artifactRoot}.doctor-started`;
    const observationPath = `${artifactRoot}.shutdown-observation`;
    const client = new SigmaExecBrokerClient(fixtureOptions(artifactRoot, "slow-doctor"));
    try {
      const connecting = client.connect();
      await waitForPath(doctorStartedPath);
      const closing = client.close();

      await expect(connecting).rejects.toThrow();
      await expect(closing).resolves.toBeUndefined();
      await expect(client.doctor()).rejects.toThrow(/closed/u);
      await expect(client.close()).resolves.toBeUndefined();
      expect(await readFile(observationPath, "utf8")).toBe("present");
      await expect(access(artifactRoot)).rejects.toThrow();
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
      await rm(doctorStartedPath, { force: true });
      await rm(observationPath, { force: true });
    }
  });
});
