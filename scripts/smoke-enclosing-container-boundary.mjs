#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

const brokerPath = path.resolve(process.argv[2] ?? "/opt/sigma/sigma-exec");
const workspacePath = path.resolve(process.argv[3] ?? "/task");
const externalRoot = path.resolve(process.argv[4] ?? "/etc/sigma-enclosing-boundary-smoke");
const protectedFile = path.join(workspacePath, "protected.txt");
const externalFile = path.join(externalRoot, "written.txt");
const backgroundFile = path.join(externalRoot, "background-written.txt");
const runtimeRoot = path.dirname(brokerPath);
const runtimeTamper = path.join(runtimeRoot, "tamper.txt");

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

class BrokerProbe {
  #child;
  #nextId = 1;
  #pending = new Map();
  #stdout = Buffer.alloc(0);
  #stderr = "";

  constructor(executable) {
    this.#child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {}
    });
    this.#child.stdout.on("data", (chunk) => {
      this.#stdout = Buffer.concat([this.#stdout, chunk]);
      this.#drain();
    });
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr += chunk.toString("utf8");
    });
    this.#child.on("exit", (code, signal) => {
      const error = new Error(
        `sigma-exec exited before replying (code=${String(code)} signal=${String(signal)}): ${this.#stderr}`
      );
      for (const request of this.#pending.values()) request.reject(error);
      this.#pending.clear();
    });
  }

  #drain() {
    while (this.#stdout.length >= 4) {
      const length = this.#stdout.readUInt32BE(0);
      if (this.#stdout.length < 4 + length) return;
      const response = JSON.parse(this.#stdout.subarray(4, 4 + length).toString("utf8"));
      this.#stdout = this.#stdout.subarray(4 + length);
      const request = this.#pending.get(response.requestId);
      if (!request) throw new Error(`Unexpected broker response ${String(response.requestId)}.`);
      this.#pending.delete(response.requestId);
      if (response.ok) request.resolve(response.result);
      else request.reject(Object.assign(
        new Error(`${response.error?.code ?? "broker_error"}: ${response.error?.message ?? "unknown error"}`),
        { brokerError: response.error }
      ));
    }
  }

  request(method, params = {}) {
    const requestId = this.#nextId++;
    const response = new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });
    this.#child.stdin.write(frame({
      protocolVersion: 1,
      requestId,
      method,
      params
    }));
    return response;
  }

  async close() {
    if (this.#child.exitCode !== null) return;
    await this.request("shutdown");
  }
}

async function main() {
  await mkdir(workspacePath, { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await writeFile(protectedFile, "original\n", "utf8");
  await rm(externalFile, { force: true });
  await rm(backgroundFile, { force: true });
  await rm(runtimeTamper, { force: true }).catch(() => undefined);

  const broker = new BrokerProbe(brokerPath);
  try {
    await broker.request("hello", { redactionSecrets: [] });
    const doctor = await broker.request("doctor");
    const boundary = doctor?.capabilities?.enclosingContainerRoot;
    if (boundary?.available !== true || boundary?.rootKind !== "container_cow") {
      throw new Error(`Enclosing-container boundary is unavailable: ${JSON.stringify(boundary)}`);
    }

    const result = await broker.request("exec", {
      command: {
        executable: "/bin/sh",
        args: [
          "-c",
          [
            "set -eu",
            `printf 'outer\\n' > ${JSON.stringify(externalFile)}`,
            `if printf 'hacked\\n' > ${JSON.stringify(protectedFile)} 2>/dev/null; then exit 41; fi`,
            `if printf 'tampered\\n' > ${JSON.stringify(runtimeTamper)} 2>/dev/null; then exit 42; fi`,
            "if printf 'tampered\\n' > /usr/local/bin/bwrap 2>/dev/null; then exit 43; fi"
          ].join("; ")
        ],
        cwd: workspacePath,
        env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }
      },
      policy: {
        sandbox: "required",
        network: "none",
        networkApproved: false,
        readRoots: ["/"],
        writeRoots: ["/"],
        executionRoots: [],
        protectedPaths: [workspacePath, runtimeRoot],
        enclosingContainerRoot: true
      },
      maxOutputBytes: 1048576,
      timeoutMs: 30000,
      idleTimeoutMs: 30000,
      lifecycle: "session"
    });
    if (result.exitCode !== 0) {
      throw new Error(`Boundary probe command failed: ${JSON.stringify(result)}`);
    }
    if (await readFile(externalFile, "utf8") !== "outer\n") {
      throw new Error("The enclosing-container mutation did not persist.");
    }
    if (await readFile(protectedFile, "utf8") !== "original\n") {
      throw new Error("The protected workspace was mutated.");
    }
    await readFile(runtimeTamper).then(
      () => { throw new Error("The protected runtime was mutated."); },
      (error) => {
        if (error?.code !== "ENOENT") throw error;
      }
    );

    const spawned = await broker.request("process.spawn", {
      command: {
        executable: "/bin/sh",
        args: [
          "-c",
          [
            "set -eu",
            `if printf 'hacked\\n' > ${JSON.stringify(protectedFile)} 2>/dev/null; then exit 51; fi`,
            `if printf 'tampered\\n' > ${JSON.stringify(runtimeTamper)} 2>/dev/null; then exit 52; fi`,
            "if printf 'tampered\\n' > /usr/local/bin/bwrap 2>/dev/null; then exit 53; fi",
            "sleep 0.25",
            `printf 'background\\n' > ${JSON.stringify(backgroundFile)}`,
            "sleep 0.25"
          ].join("; ")
        ],
        cwd: workspacePath,
        env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }
      },
      policy: {
        sandbox: "required",
        network: "none",
        networkApproved: false,
        readRoots: ["/"],
        writeRoots: ["/"],
        executionRoots: [],
        protectedPaths: [workspacePath, runtimeRoot],
        enclosingContainerRoot: true
      },
      maxOutputBytes: 1048576,
      lifecycle: "deliverable"
    });
    if (typeof spawned?.handleId !== "string" || spawned.handleId.length === 0) {
      throw new Error(`Boundary process spawn did not return a handle: ${JSON.stringify(spawned)}`);
    }
    const handedOff = await broker.request("process.handoff", { handleId: spawned.handleId });
    if (typeof handedOff?.handoffId !== "string" || handedOff.handoffId.length === 0) {
      throw new Error(`Boundary process handoff failed: ${JSON.stringify(handedOff)}`);
    }
    await broker.close();

    const markerDeadline = Date.now() + 5_000;
    while (true) {
      const marker = await readFile(backgroundFile, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      });
      if (marker !== undefined) {
        if (marker !== "background\n") {
          throw new Error(`Unexpected background marker: ${JSON.stringify(marker)}`);
        }
        break;
      }
      if (Date.now() >= markerDeadline) {
        throw new Error("The handed-off process did not persist its enclosing-container mutation.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (await readFile(protectedFile, "utf8") !== "original\n") {
      throw new Error("The handed-off process mutated the protected workspace.");
    }
    await readFile(runtimeTamper).then(
      () => { throw new Error("The handed-off process mutated the protected runtime."); },
      (error) => {
        if (error?.code !== "ENOENT") throw error;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.stdout.write(
      `PASS enclosing-container foreground and handed-off background boundary (${boundary.attestationDigest})\n`
    );
  } finally {
    await broker.close();
    await rm(externalRoot, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
