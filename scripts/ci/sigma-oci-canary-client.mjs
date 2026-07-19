#!/usr/bin/env node
import net from "node:net";
import { spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const socketPath = process.env.SIGMA_OCI_CANARY_SOCKET ?? "/run/sigma-oci/broker.sock";
const workspace = process.env.SIGMA_OCI_CANARY_WORKSPACE ?? "/app";
const scenario = process.env.SIGMA_OCI_CANARY_SCENARIO ?? "functional";
const workspaceFile = `${workspace}/.sigma-oci-canary-workspace`;
const systemFile = "/etc/.sigma-oci-canary-system";
const atomicWriteFile = `${workspace}/.sigma-oci-atomic-write.txt`;
const atomicPatchFile = `${workspace}/.sigma-oci-atomic-patch.txt`;
const atomicRollbackFirst = `${workspace}/.sigma-oci-atomic-rollback-first.txt`;
const atomicRollbackSecond = `${workspace}/.sigma-oci-atomic-rollback-second.txt`;
const controlPackageRoot = "/opt/sigma-control/agent-cli-package";
const controlStateRoot = "/var/lib/sigma/oci-atomic-canary-state";
const maximumFrameBytes = 8 * 1024 * 1024;
const requestTimeoutMs = 20_000;
const shellEnvironment = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > maximumFrameBytes) {
    throw new Error("OCI canary frame is outside the protocol bound.");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

class Client {
  constructor() {
    this.socket = net.createConnection(socketPath);
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.on("data", (chunk) => {
      try { this.read(chunk); }
      catch (error) {
        this.rejectAll(error);
        this.socket.destroy();
      }
    });
    this.socket.on("error", (error) => this.rejectAll(error));
    this.socket.on("close", () => this.rejectAll(new Error("OCI canary broker disconnected.")));
  }

  async connect() {
    if (this.socket.readyState === "open") return;
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
  }

  beginRequest(method, params = {}) {
    const requestId = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = Object.assign(new Error(
          `OCI canary broker request '${method}' exceeded ${requestTimeoutMs} ms.`
        ), { code: "oci_canary_request_timeout" });
        reject(error);
        this.socket.destroy(error);
      }, requestTimeoutMs);
      this.pending.set(requestId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
    this.socket.write(frame({ protocolVersion: 1, requestId, method, params }), (error) => {
      if (!error) return;
      const pending = this.pending.get(requestId);
      this.pending.delete(requestId);
      pending?.reject(error);
    });
    return { requestId, result };
  }

  request(method, params = {}) {
    return this.beginRequest(method, params).result;
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > maximumFrameBytes) throw new Error(`Invalid OCI canary frame ${length}.`);
      if (this.buffer.byteLength < length + 4) return;
      const response = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8"));
      this.buffer = this.buffer.subarray(length + 4);
      const pending = this.pending.get(response.requestId);
      if (!pending) throw new Error(`Unexpected OCI canary response ${String(response.requestId)}.`);
      this.pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(Object.assign(new Error(response.error?.message ?? "OCI broker error"), {
        code: response.error?.code
      }));
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() { this.socket.end(); }
}

function policy(network, writeRoots = []) {
  return {
    sandbox: "required",
    network,
    networkApproved: network === "full",
    readRoots: [workspace, "/etc"],
    writeRoots,
    executionRoots: [],
    protectedPaths: []
  };
}

function processParams(script, options = {}) {
  return {
    command: {
      executable: "/bin/sh",
      args: ["-c", script],
      cwd: workspace,
      env: shellEnvironment
    },
    policy: policy(options.network ?? "none", options.writeRoots ?? []),
    maxOutputBytes: 1024 * 1024,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.pty === true ? { pty: true, ptyColumns: 91, ptyRows: 27 } : {})
  };
}

function bareProcessParams(executable, args, searchPaths) {
  if (!Array.isArray(searchPaths) || searchPaths.length === 0
    || searchPaths.some((entry) => typeof entry !== "string" || !entry.startsWith("/"))) {
    throw new Error("OCI target did not report an absolute executable search path.");
  }
  return {
    command: {
      executable,
      args,
      cwd: workspace,
      env: { PATH: searchPaths.join(":") }
    },
    policy: policy("none"),
    maxOutputBytes: 1024 * 1024,
    timeoutMs: 10_000
  };
}

function assertExited(result, label) {
  if (result?.state !== "exited" || result?.exitCode !== 0) {
    throw new Error(`${label} failed: ${JSON.stringify(result)}`);
  }
}

async function runLocal(executable, args, timeoutMs = 30_000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`OCI canary local process '${executable}' exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8");
      const diagnostic = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve(output);
      else reject(new Error(`OCI canary local process '${executable}' failed (${String(code)}): ${diagnostic || output}`));
    });
  });
}

function packagedAtomicCanarySource(packageRoot) {
  return `
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = ${JSON.stringify(packageRoot)};
const workspace = ${JSON.stringify(workspace)};
const stateRootDir = ${JSON.stringify(controlStateRoot)};
const writeTarget = ${JSON.stringify(atomicWriteFile)};
const patchTarget = ${JSON.stringify(atomicPatchFile)};
const rollbackFirst = ${JSON.stringify(atomicRollbackFirst)};
const rollbackSecond = ${JSON.stringify(atomicRollbackSecond)};
const probeSource = path.join(workspace, ".sigma-oci-cross-mount-probe");
const probeTarget = path.join(stateRootDir, "cross-mount-probe");

const atomicPatch = await import(pathToFileURL(
  path.join(packageRoot, "node_modules", "agent-tools", "dist", "atomic-patch.js")
).href);
await rm(stateRootDir, { recursive: true, force: true });
await mkdir(stateRootDir, { recursive: true, mode: 0o700 });
let crossMountCode;
try {
  await writeFile(probeSource, "probe\\n", { encoding: "utf8", flag: "wx" });
  try { await rename(probeSource, probeTarget); }
  catch (error) { crossMountCode = error?.code; }
  if (crossMountCode !== "EXDEV") {
    throw new Error("OCI atomic canary did not cross an actual rename mount boundary.");
  }
  const [workspaceInfo, stateInfo] = await Promise.all([lstat(workspace), lstat(stateRootDir)]);
  await atomicPatch.replaceWorkspaceTextFile(workspace, path.basename(writeTarget), {
    stateRootDir,
    transform: () => "atomic-write-ok\\n"
  });
  await atomicPatch.applyUnifiedPatch(workspace, [
    "--- a/.sigma-oci-atomic-patch.txt", "+++ b/.sigma-oci-atomic-patch.txt",
    "@@ -1 +1 @@", "-atomic-patch-before", "+atomic-patch-ok"
  ].join("\\n"), { stateRootDir });

  let injected = false;
  try {
    await atomicPatch.applyUnifiedPatch(workspace, [
      "diff --git a/.sigma-oci-atomic-rollback-first.txt b/.sigma-oci-atomic-rollback-first.txt",
      "--- a/.sigma-oci-atomic-rollback-first.txt", "+++ b/.sigma-oci-atomic-rollback-first.txt",
      "@@ -1 +1 @@", "-rollback-first-before", "+rollback-first-after",
      "diff --git a/.sigma-oci-atomic-rollback-second.txt b/.sigma-oci-atomic-rollback-second.txt",
      "--- a/.sigma-oci-atomic-rollback-second.txt", "+++ b/.sigma-oci-atomic-rollback-second.txt",
      "@@ -1 +1 @@", "-rollback-second-before", "+rollback-second-after"
    ].join("\\n"), {
      stateRootDir,
      beforeMutation: async (operation) => {
        if (operation.direction === "commit" && operation.phase === "backup_source"
          && operation.changeIndex === 1) {
          injected = true;
          throw new Error("intentional OCI rollback canary fault");
        }
      }
    });
    throw new Error("OCI rollback canary fault was not surfaced.");
  } catch (error) {
    if (!injected || error?.name === "AtomicPatchRollbackError") throw error;
  }

  const expected = new Map([
    [writeTarget, "atomic-write-ok\\n"],
    [patchTarget, "atomic-patch-ok\\n"],
    [rollbackFirst, "rollback-first-before\\n"],
    [rollbackSecond, "rollback-second-before\\n"]
  ]);
  for (const [target, contents] of expected) {
    if (await readFile(target, "utf8") !== contents) {
      throw new Error("OCI atomic workspace transaction produced an unexpected postimage.");
    }
  }
  const stateEntries = await readdir(stateRootDir);
  if (stateEntries.length !== 0) {
    throw new Error("OCI atomic workspace transaction left recovery state behind.");
  }
  process.stdout.write(JSON.stringify({
    status: "passed", crossMountCode, workspaceDev: workspaceInfo.dev, stateDev: stateInfo.dev
  }) + "\\n");
} finally {
  await rm(probeSource, { force: true });
  await rm(probeTarget, { force: true });
  await rm(stateRootDir, { recursive: true, force: true });
}
`;
}

async function runPackagedAtomicCanary() {
  await rm(controlPackageRoot, { recursive: true, force: true });
  await mkdir(controlPackageRoot, { recursive: true, mode: 0o700 });
  try {
    await runLocal("/bin/tar", [
      "--extract", "--gzip", "--file", "/opt/sigma-package/agent-cli.tgz",
      "--directory", controlPackageRoot, "--strip-components=1", "--no-same-owner", "--no-same-permissions"
    ], 60_000);
    const bundledNode = path.join(controlPackageRoot, "bin", "node");
    const atomicPatchModule = path.join(
      controlPackageRoot, "node_modules", "agent-tools", "dist", "atomic-patch.js"
    );
    await Promise.all([access(bundledNode), access(atomicPatchModule)]);
    const script = path.join(controlPackageRoot, "oci-atomic-canary.mjs");
    await writeFile(script, packagedAtomicCanarySource(controlPackageRoot), { encoding: "utf8", flag: "wx" });
    const output = await runLocal(bundledNode, [script], 60_000);
    const value = JSON.parse(output.trim().split(/\r?\n/gu).at(-1) ?? "null");
    if (value?.status !== "passed" || value?.crossMountCode !== "EXDEV") {
      throw new Error("Packaged atomic workspace canary returned an invalid report.");
    }
    return value;
  } finally {
    await rm(controlPackageRoot, { recursive: true, force: true });
  }
}

async function pollUntilFinished(client, handleId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let stdout = "";
  let stderr = "";
  while (Date.now() < deadline) {
    const result = await client.request("process.poll", { handleId, stdoutOffset, stderrOffset });
    stdout += result?.stdout?.data ?? "";
    stderr += result?.stderr?.data ?? "";
    stdoutOffset = result?.stdout?.nextOffset ?? stdoutOffset;
    stderrOffset = result?.stderr?.nextOffset ?? stderrOffset;
    if (result?.state !== "running") return { ...result, stdoutText: stdout, stderrText: stderr };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Background process ${handleId} did not finish within ${timeoutMs} ms.`);
}

async function runFunctional() {
  const client = new Client();
  await client.connect();
  const cases = [];
  try {
    const hello = await client.request("hello", { clientVersion: "oci-canary-v1", redactionSecrets: [] });
    const doctor = await client.request("doctor");
    if (doctor?.sandbox?.backend !== "oci" || doctor?.container?.available !== true
      || doctor?.container?.target !== "managed") {
      throw new Error("OCI canary did not receive a managed OCI doctor report.");
    }
    const targetPath = doctor?.capabilities?.executableSearchPaths;
    const bare = await client.request("exec", bareProcessParams(
      "sh", ["-c", "printf target-path-ok"], targetPath
    ));
    assertExited(bare, "attested target PATH canary");
    if (bare?.stdout?.data !== "target-path-ok") {
      throw new Error(`Attested target PATH output mismatch: ${JSON.stringify(bare)}`);
    }
    cases.push({ name: "attested_target_path_resolution", status: "passed" });

    const foreground = await client.request("exec", processParams(
      `set -eu; test -f ${workspace}/.sigma-oci-main-seed; `
      + "test ! -e /var/run/docker.sock; test ! -e /run/sigma-oci/broker.sock; "
      + "test \"$" + "{SIGMA_OCI_CANARY_SECRET+x}\" != x; "
      + `printf workspace-ok > ${workspaceFile}; printf system-ok > ${systemFile}; `
      + `printf 'atomic-patch-before\\n' > ${atomicPatchFile}; `
      + `printf 'rollback-first-before\\n' > ${atomicRollbackFirst}; `
      + `printf 'rollback-second-before\\n' > ${atomicRollbackSecond}`,
      { writeRoots: [workspace, "/etc"], timeoutMs: 30_000 }
    ));
    assertExited(foreground, "foreground/shared-state/isolation canary");
    cases.push({ name: "foreground_shared_state_isolation", status: "passed" });

    const atomic = await runPackagedAtomicCanary();
    cases.push({
      name: "cross_mount_atomic_workspace_transaction",
      status: "passed",
      crossMountCode: atomic.crossMountCode,
      sameDeviceNumber: atomic.workspaceDev === atomic.stateDev
    });

    for (const network of ["none", "loopback", "full"]) {
      let namespaceCheck = network === "full"
        ? "test \"$(readlink /proc/self/ns/net)\" = \"$(cat /app/.sigma-oci-main-netns)\""
        : "test \"$(readlink /proc/self/ns/net)\" != \"$(cat /app/.sigma-oci-main-netns)\"";
      if (network === "loopback") {
        namespaceCheck += "; test \"$(awk '/^CapEff:/ {print $2}' /proc/self/status)\" = 0000000000000000";
      }
      const result = await client.request("exec", processParams(`${namespaceCheck}; printf network-ok`, {
        network, timeoutMs: 10_000
      }));
      assertExited(result, `${network} network policy canary`);
      cases.push({ name: `network_${network}`, status: "passed" });
    }

    const spawned = await client.request("process.spawn", processParams(
      "IFS= read -r value; printf 'stdin:%s' \"$value\""
    ));
    if (typeof spawned?.handleId !== "string" || !spawned.handleId) {
      throw new Error(`Background spawn returned an invalid handle: ${JSON.stringify(spawned)}`);
    }
    await client.request("process.write", { handleId: spawned.handleId, data: "canary-input\n" });
    const background = await pollUntilFinished(client, spawned.handleId);
    assertExited(background, "background/stdin canary");
    if (!background.stdoutText.includes("stdin:canary-input")) {
      throw new Error(`Background/stdin output mismatch: ${JSON.stringify(background)}`);
    }
    cases.push({ name: "background_stdin", status: "passed" });

    const ptySpawned = await client.request("process.spawn", processParams(
      "test -t 0 && test -t 1 && printf pty-ok", { pty: true }
    ));
    if (typeof ptySpawned?.handleId !== "string" || !ptySpawned.handleId) {
      throw new Error(`PTY spawn returned an invalid handle: ${JSON.stringify(ptySpawned)}`);
    }
    const pty = await pollUntilFinished(client, ptySpawned.handleId);
    assertExited(pty, "PTY canary");
    if (!pty.stdoutText.includes("pty-ok")) throw new Error(`PTY output mismatch: ${JSON.stringify(pty)}`);
    cases.push({ name: "pty", status: "passed" });

    const timedOut = await client.request("exec", processParams("sleep 5", { timeoutMs: 100 }));
    if (timedOut?.timedOut !== true || timedOut?.state !== "terminated") {
      throw new Error(`Timeout canary did not terminate: ${JSON.stringify(timedOut)}`);
    }
    cases.push({ name: "timeout_process_tree", status: "passed" });

    const cancellable = client.beginRequest("exec", processParams("sleep 5", { timeoutMs: 10_000 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.request("cancel", { targetRequestId: cancellable.requestId });
    const cancelled = await cancellable.result;
    if (cancelled?.cancelled !== true || cancelled?.state !== "terminated") {
      throw new Error(`Cancellation canary did not terminate: ${JSON.stringify(cancelled)}`);
    }
    cases.push({ name: "cancel_process_tree", status: "passed" });

    await client.request("shutdown");
    client.close();
    return {
      scenario,
      status: "passed",
      protocolVersion: hello.protocolVersion,
      artifactRoot: hello.artifactRoot,
      container: doctor.container,
      workspaceFile,
      systemFile,
      execution: foreground,
      cases
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

async function runStaleAttestation() {
  const client = new Client();
  await client.connect();
  try {
    await client.request("hello", { clientVersion: "oci-canary-stale-v1", redactionSecrets: [] });
  } catch (error) {
    client.close();
    if (error?.code !== "container_attestation_invalid") throw error;
    return {
      scenario,
      status: "passed",
      expectedError: "container_attestation_invalid",
      cases: [{ name: "stale_attestation_fail_closed", status: "passed" }]
    };
  }
  client.close();
  throw new Error("A stale target attestation was accepted.");
}

export async function main() {
  if (scenario !== "functional" && scenario !== "stale-attestation") {
    throw new Error(`Unknown OCI canary scenario '${scenario}'.`);
  }
  const result = scenario === "functional" ? await runFunctional() : await runStaleAttestation();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
