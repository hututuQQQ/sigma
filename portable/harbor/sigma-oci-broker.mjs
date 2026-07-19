#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const API_PREFIX = "/v1.40";
const ENGINE_SOCKET = "/var/run/docker.sock";
const BROKER_DIRECTORY = "/run/sigma-oci";
const BROKER_SOCKET = `${BROKER_DIRECTORY}/broker.sock`;
const ATTESTATION_PATH = `${BROKER_DIRECTORY}/attestation.json`;
const ARTIFACT_DIRECTORY = `${BROKER_DIRECTORY}/artifacts`;
const HELPER_ROOT = "/opt/sigma-helper";
const TARGET_HELPER = `${HELPER_ROOT}/bin/sigma-exec`;
const AGENT_CLI_PACKAGE = "/opt/sigma-package/agent-cli.tgz";
const EXPECTED_AGENT_CLI_SHA256 = "__SIGMA_AGENT_CLI_SHA256__";
const TARGET_SERVICE = "main";
const CONTROL_SERVICE = "sigma-control";
const BROKER_SERVICE = "sigma-oci-broker";
const TARGET_PROOF_LABEL = "com.sigma.oci-target";
const TARGET_PROOF_VALUE = "managed-main-v1";
const CONTROL_PROOF_LABEL = "com.sigma.control-plane";
const CONTROL_PROOF_VALUE = "v1";
const BROKER_PROOF_LABEL = "com.sigma.oci-broker";
const BROKER_PROOF_VALUE = "v1";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const REPORTED_METHODS = new Set(["doctor", "sandbox.setup", "sandbox.repair"]);
const SENSITIVE_CONTROL_ENVIRONMENT = /^(?:DEEPSEEK|GLM|ZAI|BIGMODEL|OPENAI|ANTHROPIC)_API_KEY$/iu;
const ENGINE_ENVIRONMENT = /^(?:DOCKER|CONTAINER|PODMAN)_HOST$/iu;
const HARBOR_MAIN_BIND_DESTINATIONS = new Set([
  "/logs/agent",
  "/logs/artifacts",
  "/logs/verifier"
]);
const BIND_SOURCE_IDENTITY_EXACT = "exact";
const BIND_SOURCE_IDENTITY_DOCKER_DESKTOP_WINDOWS = "docker-desktop-windows";

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function fileSha256(target) {
  return await new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(target);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(digest.digest("hex")));
  });
}

async function runTrusted(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C" }
    });
    const errors = [];
    let errorBytes = 0;
    child.stderr.on("data", (chunk) => {
      if (errorBytes >= 16 * 1024) return;
      const bounded = chunk.subarray(0, 16 * 1024 - errorBytes);
      errors.push(bounded);
      errorBytes += bounded.byteLength;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `${executable} failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}): `
        + Buffer.concat(errors).toString("utf8").trim().slice(0, 16 * 1024)
      ));
    });
  });
}

async function copyRegularTree(source, destination) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const name of (await readdir(source)).sort()) {
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) throw new Error(`trusted helper package contains symlink '${name}'`);
    if (info.isDirectory()) await copyRegularTree(sourcePath, destinationPath);
    else if (info.isFile()) await copyFile(sourcePath, destinationPath);
    else throw new Error(`trusted helper package contains unsupported file '${name}'`);
  }
}

async function sealHelperTree(root) {
  for (const name of await readdir(root)) {
    const target = path.join(root, name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`trusted helper contains symlink '${name}'`);
    if (info.isDirectory()) await sealHelperTree(target);
    else if (!info.isFile()) throw new Error(`trusted helper contains unsupported file '${name}'`);
    await chown(target, 0, 0);
    await chmod(target, 0o555);
  }
}

async function makeHelperPathRemovable(target) {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  // The broker intentionally removes CAP_DAC_OVERRIDE. Restore owner write on
  // sealed 0555 directories before unlinking a prior failed/startup publish.
  await chmod(target, 0o700);
  for (const name of await readdir(target)) {
    await makeHelperPathRemovable(path.join(target, name));
  }
}

/** Content, ownership and permissions are all part of the helper identity.
 * This deliberately rejects symlinks, hard links, writable paths and extra
 * top-level payloads before any Docker exec can attach to the target. */
export async function trustedHelperTreeDigest(root = HELPER_ROOT) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || rootInfo.uid !== 0 || rootInfo.gid !== 0 || (rootInfo.mode & 0o7777) !== 0o755) {
    throw new Error("trusted helper root must be a root-owned 0755 directory");
  }
  const topLevel = (await readdir(root)).sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(["bin", "lib"])) {
    throw new Error(`trusted helper inventory is invalid (${topLevel.join(",") || "empty"})`);
  }
  const bin = (await readdir(path.join(root, "bin"))).sort();
  if (JSON.stringify(bin) !== JSON.stringify(["bwrap", "sigma-exec"])) {
    throw new Error(`trusted helper executable inventory is invalid (${bin.join(",") || "empty"})`);
  }
  const entries = [];
  let entryCount = 0;
  let totalBytes = 0;
  const visit = async (directory, relativeDirectory = "") => {
    for (const name of (await readdir(directory)).sort()) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const target = path.join(directory, name);
      const info = await lstat(target);
      entryCount += 1;
      if (entryCount > 2_048) throw new Error("trusted helper contains too many entries");
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error(`trusted helper contains unsupported path '${relative}'`);
      }
      const expectedMode = 0o555;
      if (info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== expectedMode) {
        throw new Error(`trusted helper path '${relative}' has invalid ownership or mode`);
      }
      if (info.isDirectory()) {
        entries.push({ path: relative, type: "directory", uid: info.uid, gid: info.gid, mode: expectedMode });
        await visit(target, relative);
      } else {
        if (info.nlink !== 1) throw new Error(`trusted helper file '${relative}' must not be hard-linked`);
        totalBytes += info.size;
        if (totalBytes > 512 * 1024 * 1024) throw new Error("trusted helper exceeds 512 MiB");
        entries.push({
          path: relative,
          type: "file",
          uid: info.uid,
          gid: info.gid,
          mode: expectedMode,
          size: info.size,
          sha256: await fileSha256(target)
        });
      }
    }
  };
  await visit(root);
  if (!entries.some((entry) => entry.path.startsWith("lib/") && entry.type === "file")) {
    throw new Error("trusted helper library inventory is empty");
  }
  return sha256(JSON.stringify(entries));
}

export async function installTrustedHelper() {
  if (!/^[a-f0-9]{64}$/u.test(EXPECTED_AGENT_CLI_SHA256)) {
    throw new Error("trusted agent CLI package digest was not embedded by the launcher");
  }
  const packageInfo = await lstat(AGENT_CLI_PACKAGE);
  if (!packageInfo.isFile() || packageInfo.isSymbolicLink()) {
    throw new Error("trusted agent CLI package is not a regular file");
  }
  const observedPackageDigest = await fileSha256(AGENT_CLI_PACKAGE);
  if (observedPackageDigest !== EXPECTED_AGENT_CLI_SHA256) {
    throw new Error("trusted agent CLI package digest does not match the launcher pin");
  }
  const unpack = await mkdtemp("/tmp/sigma-helper-unpack-");
  let stage;
  try {
    await runTrusted("/bin/tar", [
      "--no-same-owner", "--no-same-permissions", "-xzf", AGENT_CLI_PACKAGE,
      "-C", unpack, "--strip-components=1"
    ]);
    for (const target of ["bin/sigma-exec", "bin/bwrap", "lib"]) {
      const info = await lstat(path.join(unpack, target));
      if (target === "lib" ? !info.isDirectory() : !info.isFile()) {
        throw new Error(`trusted agent CLI package is missing helper '${target}'`);
      }
    }
    const helperInfo = await lstat(HELPER_ROOT);
    if (!helperInfo.isDirectory() || helperInfo.isSymbolicLink()) {
      throw new Error("trusted helper mount is not a directory");
    }
    await chown(HELPER_ROOT, 0, 0);
    await chmod(HELPER_ROOT, 0o755);
    for (const name of await readdir(HELPER_ROOT)) {
      const existing = path.join(HELPER_ROOT, name);
      await makeHelperPathRemovable(existing);
      await rm(existing, { recursive: true, force: true });
    }
    stage = await mkdtemp(`${HELPER_ROOT}/.sigma-stage-`);
    await mkdir(path.join(stage, "bin"), { mode: 0o700 });
    await copyFile(path.join(unpack, "bin/sigma-exec"), path.join(stage, "bin/sigma-exec"));
    await copyFile(path.join(unpack, "bin/bwrap"), path.join(stage, "bin/bwrap"));
    await copyRegularTree(path.join(unpack, "lib"), path.join(stage, "lib"));
    await rename(path.join(stage, "bin"), path.join(HELPER_ROOT, "bin"));
    await rename(path.join(stage, "lib"), path.join(HELPER_ROOT, "lib"));
    await rm(stage, { recursive: true, force: true });
    stage = undefined;
    await sealHelperTree(HELPER_ROOT);
    return await trustedHelperTreeDigest();
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await rm(unpack, { recursive: true, force: true }).catch(() => undefined);
  }
}

function stableObject(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

export function labelsDigest(labels) {
  return sha256(JSON.stringify(stableObject(labels)));
}

export function attestationPreimage(value) {
  return JSON.stringify({
    protocolVersion: 1,
    engine: value.engine,
    selector: value.selector,
    targetId: value.targetId,
    targetStartedAt: value.targetStartedAt,
    imageId: value.imageId,
    imageDigest: value.imageDigest ?? null,
    labelsDigest: value.labelsDigest,
    helperDigest: value.helperDigest
  });
}

export function completeAttestation(value) {
  const base = {
    protocolVersion: 1,
    engine: value.engine,
    selector: value.selector,
    targetId: value.targetId,
    targetStartedAt: value.targetStartedAt,
    imageId: value.imageId,
    ...(value.imageDigest ? { imageDigest: value.imageDigest } : {}),
    labelsDigest: value.labelsDigest,
    helperDigest: value.helperDigest
  };
  return { ...base, attestationDigest: sha256(attestationPreimage(base)) };
}

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`broker frame must be between 1 and ${MAX_FRAME_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

class FrameDecoder {
  buffer = Buffer.alloc(0);

  push(chunk) {
    this.buffer = this.buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_QUEUED_BYTES) throw new Error("broker frame queue exceeded its bound");
    const messages = [];
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw new Error(`invalid broker frame length ${length}`);
      if (this.buffer.byteLength < length + 4) break;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      messages.push(JSON.parse(payload.toString("utf8")));
    }
    return messages;
  }
}

class DockerStreamDecoder {
  buffer = Buffer.alloc(0);

  push(chunk) {
    this.buffer = this.buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const streams = [];
    while (this.buffer.byteLength >= 8) {
      const stream = this.buffer[0];
      const length = this.buffer.readUInt32BE(4);
      if (length > MAX_FRAME_BYTES + 4) throw new Error(`Docker exec stream chunk is too large (${length})`);
      if (this.buffer.byteLength < length + 8) break;
      streams.push({ stream, value: this.buffer.subarray(8, length + 8) });
      this.buffer = this.buffer.subarray(length + 8);
    }
    return streams;
  }
}

class DockerApi {
  constructor(socketPath = ENGINE_SOCKET) {
    this.socketPath = socketPath;
  }

  async json(method, path, body) {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    return await new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        method,
        path: `${API_PREFIX}${path}`,
        headers: payload ? {
          "Content-Type": "application/json",
          "Content-Length": String(payload.byteLength)
        } : undefined
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.byteLength;
          if (bytes > 8 * 1024 * 1024) {
            request.destroy(new Error("Docker API response exceeded 8 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(new Error(`Docker API ${method} ${path} failed (${response.statusCode}): ${text.slice(0, 2048)}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (error) {
            reject(new Error(`Docker API ${method} ${path} returned invalid JSON`, { cause: error }));
          }
        });
      });
      request.once("error", reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  async hijackExec(execId) {
    return await new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }), "utf8");
      const request = http.request({
        socketPath: this.socketPath,
        method: "POST",
        path: `${API_PREFIX}/exec/${encodeURIComponent(execId)}/start`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(payload.byteLength),
          Connection: "Upgrade",
          Upgrade: "tcp"
        }
      });
      let settled = false;
      request.once("upgrade", (response, socket, head) => {
        settled = true;
        if (response.statusCode !== 101) {
          socket.destroy();
          reject(new Error(`Docker exec attach returned ${response.statusCode}`));
          return;
        }
        if (head.byteLength > 0) socket.unshift(head);
        resolve(socket);
      });
      request.once("response", (response) => {
        if (settled) return;
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => reject(new Error(
          `Docker exec attach did not upgrade (${response.statusCode}): ${Buffer.concat(chunks).toString("utf8").slice(0, 2048)}`
        )));
      });
      request.once("error", reject);
      request.write(payload);
      request.end();
    });
  }
}

function dockerFilters(labels) {
  return encodeURIComponent(JSON.stringify({ label: labels }));
}

function containerPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return "";
  return value.length > 1 ? value.replace(/\/+$/u, "") : value;
}

function mounts(container) {
  return Array.isArray(container?.Mounts) ? container.Mounts : [];
}

function mountAt(container, destination, service) {
  const expected = containerPath(destination);
  const matches = mounts(container).filter((mount) => containerPath(mount?.Destination) === expected);
  if (matches.length !== 1) {
    throw new Error(`${service} must have exactly one mount at ${expected}; observed ${matches.length}`);
  }
  return matches[0];
}

function assertMount(mount, service, destination, expected) {
  if (expected.type && mount?.Type !== expected.type) {
    throw new Error(`${service} mount ${destination} must use ${expected.type}, observed ${String(mount?.Type)}`);
  }
  if (typeof expected.writable === "boolean" && mount?.RW !== expected.writable) {
    throw new Error(`${service} mount ${destination} must be ${expected.writable ? "writable" : "read-only"}`);
  }
  return mount;
}

function mountIdentity(mount, service, destination) {
  const identity = mount?.Type === "volume" ? mount?.Name ?? mount?.Source : mount?.Source;
  return nonEmptyString(identity, `${service} mount source for ${destination}`);
}

function bindSourceIdentity(source, mode) {
  const value = String(source ?? "");
  if (mode === BIND_SOURCE_IDENTITY_EXACT) return value;
  if (mode !== BIND_SOURCE_IDENTITY_DOCKER_DESKTOP_WINDOWS) {
    throw new Error(`unsupported bind source identity mode: ${String(mode)}`);
  }

  const driveSource = /^([A-Za-z]):[\\/](.*)$/u.exec(value);
  if (driveSource) {
    return JSON.stringify([
      BIND_SOURCE_IDENTITY_DOCKER_DESKTOP_WINDOWS,
      driveSource[1].toLowerCase(),
      driveSource[2].replaceAll("\\", "/")
    ]);
  }

  const desktopSource = /^\/run\/desktop\/mnt\/host\/([A-Za-z])(?:\/(.*))?$/u.exec(value)
    ?? /^\/host_mnt\/([A-Za-z])(?:\/(.*))?$/u.exec(value);
  if (desktopSource && !String(desktopSource[2] ?? "").includes("\\")) {
    return JSON.stringify([
      BIND_SOURCE_IDENTITY_DOCKER_DESKTOP_WINDOWS,
      desktopSource[1].toLowerCase(),
      desktopSource[2] ?? ""
    ]);
  }
  return value;
}

function assertSameVolume(left, right, description) {
  if (left?.Type !== "volume" || right?.Type !== "volume"
    || mountIdentity(left, "left", description) !== mountIdentity(right, "right", description)) {
    throw new Error(`${description} is not the same named volume across services`);
  }
}

function assertSameBind(left, right, description, bindSourceIdentityMode) {
  if (left?.Type !== "bind" || right?.Type !== "bind"
    || bindSourceIdentity(mountIdentity(left, "left", description), bindSourceIdentityMode)
      !== bindSourceIdentity(mountIdentity(right, "right", description), bindSourceIdentityMode)) {
    throw new Error(`${description} is not the same host bind across services`);
  }
}

function assertExactMountDestinations(container, service, expected) {
  const observed = mounts(container).map((mount) => containerPath(mount?.Destination));
  if (observed.some((destination) => !destination) || new Set(observed).size !== observed.length) {
    throw new Error(`${service} has an invalid or duplicate mount destination`);
  }
  const extras = observed.filter((destination) => !expected.has(destination));
  const missing = [...expected].filter((destination) => !observed.includes(destination));
  if (extras.length > 0 || missing.length > 0) {
    throw new Error(`${service} mount inventory differs from the trusted topology`
      + ` (extra=${extras.join(",") || "none"}; missing=${missing.join(",") || "none"})`);
  }
}

function environmentKeys(container) {
  const entries = Array.isArray(container?.Config?.Env) ? container.Config.Env : [];
  return entries.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const separator = entry.indexOf("=");
    return [separator < 0 ? entry : entry.slice(0, separator)];
  });
}

function assertNoSensitiveEnvironment(container, service) {
  const forbidden = environmentKeys(container).filter((key) =>
    SENSITIVE_CONTROL_ENVIRONMENT.test(key) || ENGINE_ENVIRONMENT.test(key));
  if (forbidden.length > 0) {
    throw new Error(`${service} contains forbidden control/engine environment keys: ${forbidden.join(",")}`);
  }
}

function assertNoEngineEnvironment(container, service) {
  const forbidden = environmentKeys(container).filter((key) => ENGINE_ENVIRONMENT.test(key));
  if (forbidden.length > 0) {
    throw new Error(`${service} contains forbidden engine environment keys: ${forbidden.join(",")}`);
  }
}

function assertNoEngineMount(container, service, engineSource, bindSourceIdentityMode) {
  const engineIdentity = bindSourceIdentity(engineSource, bindSourceIdentityMode);
  for (const mount of mounts(container)) {
    const source = String(mount?.Source ?? "");
    const sourceIdentity = bindSourceIdentity(source, bindSourceIdentityMode);
    const socketComparableSource = source.replaceAll("\\", "/").toLowerCase();
    const destination = containerPath(mount?.Destination).toLowerCase();
    if ((engineIdentity && sourceIdentity === engineIdentity)
      || /(?:^|\/)(?:docker\.sock|podman\.sock)$/u.test(socketComparableSource)
      || /(?:^|\/)(?:docker\.sock|podman\.sock)$/u.test(destination)) {
      throw new Error(`${service} must not receive a Docker/Podman engine socket`);
    }
  }
}

function labels(container) {
  return container?.Config?.Labels ?? {};
}

function assertServiceProof(container, proof, service, proofLabel, proofValue) {
  const observed = labels(container);
  if (observed["com.docker.compose.project"] !== proof.project
    || observed["com.docker.compose.service"] !== service
    || observed["com.sigma.harbor-run"] !== proof.runId
    || observed[proofLabel] !== proofValue) {
    throw new Error(`${service} labels do not match the trusted Compose launcher proof`);
  }
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`container inspection is missing ${name}`);
  return value;
}

function imageDigest(image) {
  const digests = Array.isArray(image?.RepoDigests) ? image.RepoDigests : [];
  for (const value of digests) {
    const match = typeof value === "string" ? value.match(/@(sha256:[a-f0-9]{64})$/iu) : null;
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

function detectEngine(version) {
  return JSON.stringify(version).toLowerCase().includes("podman") ? "podman" : "docker";
}

function detectBindSourceIdentityMode(version, engine) {
  const platformName = version?.Platform?.Name;
  return engine === "docker" && typeof platformName === "string"
    && platformName.toLowerCase().includes("docker desktop")
    ? BIND_SOURCE_IDENTITY_DOCKER_DESKTOP_WINDOWS
    : BIND_SOURCE_IDENTITY_EXACT;
}

function proofBindSourceIdentityMode(proof) {
  const mode = proof?.bindSourceIdentityMode;
  if (mode !== BIND_SOURCE_IDENTITY_EXACT
    && mode !== BIND_SOURCE_IDENTITY_DOCKER_DESKTOP_WINDOWS) {
    throw new Error("managed launcher proof has an invalid bind source identity mode");
  }
  if (mode === BIND_SOURCE_IDENTITY_DOCKER_DESKTOP_WINDOWS && proof?.engine !== "docker") {
    throw new Error("Docker Desktop bind source aliases require a Docker engine proof");
  }
  return mode;
}

function assertContainerHardening(container, service, options = {}) {
  if (container?.HostConfig?.Privileged === true) {
    throw new Error(`${service} must not be privileged`);
  }
  if (options.readOnlyRoot === true && container?.HostConfig?.ReadonlyRootfs !== true) {
    throw new Error(`${service} must use a read-only root filesystem`);
  }
  if (options.networkNone === true && container?.HostConfig?.NetworkMode !== "none") {
    throw new Error(`${service} must use an independent disabled network namespace`);
  }
}

function assertMainSensitiveMounts(target, forbiddenSources, bindSourceIdentityMode) {
  const allowedSigmaMount = "/run/sigma-oci/artifacts";
  const forbiddenIdentities = new Set(
    [...forbiddenSources].map((source) => bindSourceIdentity(source, bindSourceIdentityMode))
  );
  for (const mount of mounts(target)) {
    const destination = containerPath(mount?.Destination);
    const source = String(mount?.Source ?? "");
    if (mount?.Type === "bind" && !HARBOR_MAIN_BIND_DESTINATIONS.has(destination)) {
      throw new Error(`main received an unexpected host bind mount (${destination})`);
    }
    if ((destination === "/run/sigma-oci" || destination.startsWith("/run/sigma-oci/"))
      && destination !== allowedSigmaMount) {
      throw new Error(`main must not receive OCI control-plane mount ${destination}`);
    }
    if (destination === "/opt/sigma-control" || destination.startsWith("/opt/sigma-control/")
      || destination === "/opt/sigma-package" || destination.startsWith("/opt/sigma-package/")) {
      throw new Error(`main must not receive control-plane package mount ${destination}`);
    }
    if (forbiddenIdentities.has(bindSourceIdentity(source, bindSourceIdentityMode))) {
      throw new Error(`main mount ${destination} aliases a control-plane-only source`);
    }
  }
}

/** Fail-closed validation for Compose merge results. Task-authored Compose
 * files may precede this overlay, so the live mount/environment inventory is
 * the security authority rather than the YAML template. */
export function assertManagedBoundaryTopology(
  { target, control, broker },
  { bindSourceIdentityMode = BIND_SOURCE_IDENTITY_EXACT } = {}
) {
  if (bindSourceIdentityMode !== BIND_SOURCE_IDENTITY_EXACT
    && bindSourceIdentityMode !== BIND_SOURCE_IDENTITY_DOCKER_DESKTOP_WINDOWS) {
    throw new Error("invalid bind source identity mode for managed topology inspection");
  }
  const brokerExpected = new Set([
    "/var/run/docker.sock",
    "/opt/sigma-broker/sigma-oci-broker.mjs",
    "/opt/sigma-package/agent-cli.tgz",
    "/opt/sigma-helper",
    "/run/sigma-oci",
    "/run/sigma-oci/artifacts"
  ]);
  const controlExpected = new Set([
    "/opt/sigma-package/agent-cli.tgz",
    "/app",
    "/var/lib/sigma",
    "/opt/sigma-control",
    "/opt/sigma-helper",
    "/run/sigma-oci",
    "/run/sigma-oci/artifacts"
  ]);
  assertExactMountDestinations(broker, BROKER_SERVICE, brokerExpected);
  assertExactMountDestinations(control, CONTROL_SERVICE, controlExpected);

  const engine = assertMount(
    mountAt(broker, "/var/run/docker.sock", BROKER_SERVICE),
    BROKER_SERVICE,
    "/var/run/docker.sock",
    { type: "bind", writable: true }
  );
  const brokerSource = assertMount(
    mountAt(broker, "/opt/sigma-broker/sigma-oci-broker.mjs", BROKER_SERVICE),
    BROKER_SERVICE,
    "/opt/sigma-broker/sigma-oci-broker.mjs",
    { type: "bind", writable: false }
  );
  const brokerIpc = assertMount(
    mountAt(broker, "/run/sigma-oci", BROKER_SERVICE),
    BROKER_SERVICE,
    "/run/sigma-oci",
    { type: "volume", writable: true }
  );
  const brokerArtifacts = assertMount(
    mountAt(broker, "/run/sigma-oci/artifacts", BROKER_SERVICE),
    BROKER_SERVICE,
    "/run/sigma-oci/artifacts",
    { type: "volume", writable: true }
  );
  const brokerPackage = assertMount(
    mountAt(broker, "/opt/sigma-package/agent-cli.tgz", BROKER_SERVICE),
    BROKER_SERVICE,
    "/opt/sigma-package/agent-cli.tgz",
    { type: "bind", writable: false }
  );
  const brokerHelper = assertMount(
    mountAt(broker, "/opt/sigma-helper", BROKER_SERVICE),
    BROKER_SERVICE,
    "/opt/sigma-helper",
    { type: "volume", writable: true }
  );

  const controlPackage = assertMount(
    mountAt(control, "/opt/sigma-package/agent-cli.tgz", CONTROL_SERVICE),
    CONTROL_SERVICE,
    "/opt/sigma-package/agent-cli.tgz",
    { type: "bind", writable: false }
  );
  const controlWorkspace = assertMount(
    mountAt(control, "/app", CONTROL_SERVICE), CONTROL_SERVICE, "/app",
    { type: "volume", writable: true }
  );
  const controlState = assertMount(
    mountAt(control, "/var/lib/sigma", CONTROL_SERVICE), CONTROL_SERVICE, "/var/lib/sigma",
    { type: "volume", writable: true }
  );
  const controlRuntime = assertMount(
    mountAt(control, "/opt/sigma-control", CONTROL_SERVICE), CONTROL_SERVICE, "/opt/sigma-control",
    { type: "volume", writable: true }
  );
  const controlHelper = assertMount(
    mountAt(control, "/opt/sigma-helper", CONTROL_SERVICE), CONTROL_SERVICE, "/opt/sigma-helper",
    { type: "volume", writable: false }
  );
  const controlIpc = assertMount(
    mountAt(control, "/run/sigma-oci", CONTROL_SERVICE), CONTROL_SERVICE, "/run/sigma-oci",
    { type: "volume", writable: false }
  );
  const controlArtifacts = assertMount(
    mountAt(control, "/run/sigma-oci/artifacts", CONTROL_SERVICE),
    CONTROL_SERVICE,
    "/run/sigma-oci/artifacts",
    { type: "volume", writable: true }
  );

  const targetWorkspace = assertMount(
    mountAt(target, "/app", TARGET_SERVICE), TARGET_SERVICE, "/app",
    { type: "volume", writable: true }
  );
  const targetHelper = assertMount(
    mountAt(target, "/opt/sigma-helper", TARGET_SERVICE), TARGET_SERVICE, "/opt/sigma-helper",
    { type: "volume", writable: false }
  );
  const targetArtifacts = assertMount(
    mountAt(target, "/run/sigma-oci/artifacts", TARGET_SERVICE),
    TARGET_SERVICE,
    "/run/sigma-oci/artifacts",
    { type: "volume", writable: true }
  );

  assertSameVolume(targetWorkspace, controlWorkspace, "workspace /app");
  assertSameVolume(targetHelper, controlHelper, "read-only target helper");
  assertSameVolume(targetHelper, brokerHelper, "broker-published target helper");
  assertSameBind(
    controlPackage,
    brokerPackage,
    "pinned agent CLI package",
    bindSourceIdentityMode
  );
  assertSameVolume(targetArtifacts, controlArtifacts, "OCI output artifacts");
  assertSameVolume(targetArtifacts, brokerArtifacts, "OCI output artifacts");
  assertSameVolume(controlIpc, brokerIpc, "OCI broker IPC");

  const engineSource = nonEmptyString(engine.Source, "engine socket source");
  assertNoEngineMount(target, TARGET_SERVICE, engineSource, bindSourceIdentityMode);
  assertNoEngineMount(control, CONTROL_SERVICE, engineSource, bindSourceIdentityMode);
  assertMainSensitiveMounts(target, new Set([
    String(controlPackage.Source ?? ""),
    String(controlState.Source ?? ""),
    String(controlRuntime.Source ?? ""),
    String(controlIpc.Source ?? ""),
    String(brokerSource.Source ?? ""),
    String(brokerPackage.Source ?? ""),
    engineSource
  ].filter(Boolean)), bindSourceIdentityMode);
  assertNoSensitiveEnvironment(target, TARGET_SERVICE);
  assertNoSensitiveEnvironment(broker, BROKER_SERVICE);
  assertNoEngineEnvironment(control, CONTROL_SERVICE);
  assertContainerHardening(target, TARGET_SERVICE);
  assertContainerHardening(control, CONTROL_SERVICE, { readOnlyRoot: true });
  assertContainerHardening(broker, BROKER_SERVICE, { readOnlyRoot: true, networkNone: true });
}

export class TargetAttestor {
  constructor(api, helperAttestation) {
    this.api = api;
    if (!helperAttestation || typeof helperAttestation.digest !== "string"
      || typeof helperAttestation.verify !== "function") {
      throw new Error("managed target attestor requires a trusted helper verifier");
    }
    this.helperAttestation = helperAttestation;
  }

  async verifyHelper() {
    const observed = await this.helperAttestation.verify();
    if (observed !== this.helperAttestation.digest) {
      throw new Error("trusted target helper digest changed after launcher attestation");
    }
    return observed;
  }

  selectService(containers, service, proofLabel, proofValue) {
    const selected = Array.isArray(containers) ? containers.filter((container) => {
      const observed = container?.Labels ?? {};
      return observed["com.docker.compose.service"] === service
        && observed[proofLabel] === proofValue;
    }) : [];
    if (selected.length !== 1) {
      if (service === TARGET_SERVICE) {
        throw new Error(`managed target selection resolved ${selected.length} containers, expected exactly one`);
      }
      throw new Error(`${service} selection resolved ${selected.length} containers, expected exactly one`);
    }
    return nonEmptyString(selected[0].Id, `${service} container ID`);
  }

  async topology(project, runId) {
    const containers = await this.api.json(
      "GET",
      `/containers/json?all=1&filters=${dockerFilters([
        `com.docker.compose.project=${project}`,
        `com.sigma.harbor-run=${runId}`
      ])}`
    );
    return {
      targetId: this.selectService(containers, TARGET_SERVICE, TARGET_PROOF_LABEL, TARGET_PROOF_VALUE),
      controlId: this.selectService(containers, CONTROL_SERVICE, CONTROL_PROOF_LABEL, CONTROL_PROOF_VALUE),
      brokerId: this.selectService(containers, BROKER_SERVICE, BROKER_PROOF_LABEL, BROKER_PROOF_VALUE)
    };
  }

  async discover() {
    const [self, version] = await Promise.all([
      this.api.json("GET", `/containers/${encodeURIComponent(nonEmptyString(process.env.HOSTNAME, "broker hostname"))}/json`),
      this.api.json("GET", "/version")
    ]);
    const selfLabels = self?.Config?.Labels ?? {};
    const project = nonEmptyString(selfLabels["com.docker.compose.project"], "Compose project label");
    const service = nonEmptyString(selfLabels["com.docker.compose.service"], "Compose service label");
    const runId = nonEmptyString(selfLabels["com.sigma.harbor-run"], "Harbor run label");
    if (service !== BROKER_SERVICE) throw new Error(`broker service proof is '${service}', expected '${BROKER_SERVICE}'`);
    if (selfLabels[BROKER_PROOF_LABEL] !== BROKER_PROOF_VALUE) {
      throw new Error("broker launcher proof label is missing or invalid");
    }
    const ids = await this.topology(project, runId);
    const selfId = nonEmptyString(self.Id, "broker container ID");
    if (ids.brokerId !== selfId) throw new Error("broker hostname identity differs from its unique Compose proof");
    const engine = detectEngine(version);
    const proof = {
      project,
      runId,
      engine,
      bindSourceIdentityMode: detectBindSourceIdentityMode(version, engine),
      ...ids
    };
    return await this.inspectBoundary(proof, false);
  }

  async inspectBoundary(proof, requireControlRunning) {
    const bindSourceIdentityMode = proofBindSourceIdentityMode(proof);
    const [helperDigest, version] = await Promise.all([
      this.verifyHelper(),
      this.api.json("GET", "/version")
    ]);
    const observedEngine = detectEngine(version);
    const observedBindSourceIdentityMode = detectBindSourceIdentityMode(version, observedEngine);
    if (proof?.engine !== observedEngine) {
      throw new Error("managed launcher engine proof differs from the current Engine /version response");
    }
    if (bindSourceIdentityMode !== observedBindSourceIdentityMode) {
      throw new Error(
        "managed bind source identity proof differs from the current Engine /version response"
      );
    }
    const ids = await this.topology(proof.project, proof.runId);
    for (const key of ["targetId", "controlId", "brokerId"]) {
      if (ids[key] !== proof[key]) throw new Error(`managed topology ${key} changed after launcher attestation`);
    }
    const [target, control, broker] = await Promise.all([
      this.api.json("GET", `/containers/${encodeURIComponent(proof.targetId)}/json`),
      this.api.json("GET", `/containers/${encodeURIComponent(proof.controlId)}/json`),
      this.api.json("GET", `/containers/${encodeURIComponent(proof.brokerId)}/json`)
    ]);
    assertServiceProof(target, proof, TARGET_SERVICE, TARGET_PROOF_LABEL, TARGET_PROOF_VALUE);
    assertServiceProof(control, proof, CONTROL_SERVICE, CONTROL_PROOF_LABEL, CONTROL_PROOF_VALUE);
    assertServiceProof(broker, proof, BROKER_SERVICE, BROKER_PROOF_LABEL, BROKER_PROOF_VALUE);
    if (target?.State?.Running !== true) throw new Error("managed target is not running");
    if (broker?.State?.Running !== true) throw new Error("OCI broker proof container is not running");
    if (requireControlRunning && control?.State?.Running !== true) {
      throw new Error("sigma-control proof container is not running");
    }
    assertManagedBoundaryTopology(
      { target, control, broker },
      { bindSourceIdentityMode }
    );
    const observedId = nonEmptyString(target.Id, "target ID");
    const startedAt = nonEmptyString(target?.State?.StartedAt, "target start time");
    const observedImageId = nonEmptyString(target.Image, "target image ID");
    const image = await this.api.json("GET", `/images/${encodeURIComponent(observedImageId)}/json`);
    const selector = `compose:${proof.project}/service:${TARGET_SERVICE}/run:${proof.runId}`;
    const attestation = completeAttestation({
      engine: proof.engine,
      selector,
      targetId: observedId,
      targetStartedAt: startedAt,
      imageId: observedImageId,
      imageDigest: imageDigest(image),
      labelsDigest: labelsDigest(labels(target)),
      helperDigest
    });
    return { attestation, proof, workspace: "/app" };
  }

  async reattest(pinned) {
    const observed = await this.inspectBoundary(pinned.proof, true);
    if (JSON.stringify(observed.attestation) !== JSON.stringify(pinned.attestation)) {
      throw new Error("managed target identity changed after launcher attestation");
    }
    return observed;
  }
}

function rpcFailure(requestId, code, message) {
  return {
    protocolVersion: 1,
    requestId,
    ok: false,
    error: { code, message }
  };
}

function patchedReport(value, pinned) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sigma-exec report is not an object");
  const sandbox = value.sandbox && typeof value.sandbox === "object" && !Array.isArray(value.sandbox)
    ? value.sandbox : {};
  return {
    ...value,
    brokerVersion: `oci-proxy/${String(value.brokerVersion ?? "unknown")}`,
    sandbox: { ...sandbox, innerBackend: sandbox.backend ?? null, backend: "oci" },
    container: { available: true, backend: "oci", target: "managed", ...pinned.attestation }
  };
}

export function targetBrokerExecSpec(pinned) {
  return {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: [TARGET_HELPER],
    Env: [`TMPDIR=${ARTIFACT_DIRECTORY}`],
    User: "0:0",
    WorkingDir: pinned.workspace,
    Privileged: false
  };
}

async function createTargetBroker(api, pinned) {
  const created = await api.json(
    "POST",
    `/containers/${encodeURIComponent(pinned.attestation.targetId)}/exec`,
    targetBrokerExecSpec(pinned)
  );
  return await api.hijackExec(nonEmptyString(created?.Id, "Docker exec ID"));
}

function rejectFirstRequestBeforeAttach(client, error) {
  const decoder = new FrameDecoder();
  let settled = false;
  const timer = setTimeout(() => client.destroy(), 5_000);
  timer.unref?.();
  const cleanup = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    client.removeListener("data", onData);
  };
  const reject = (request) => {
    if (settled) return;
    const requestId = Number.isSafeInteger(request?.requestId) ? request.requestId : 1;
    cleanup();
    client.end(encodeFrame(rpcFailure(
      requestId,
      "container_attestation_invalid",
      error instanceof Error ? error.message : String(error)
    )));
  };
  const onData = (chunk) => {
    try {
      const requests = decoder.push(chunk);
      if (requests.length > 0) reject(requests[0]);
    } catch {
      reject(undefined);
    }
  };
  client.on("data", onData);
  client.once("close", cleanup);
  client.once("error", cleanup);
}

export async function handleClient(client, api, attestor, pinned) {
  // Re-attest before Docker creates or attaches the target-side root process;
  // a stale boundary still receives one typed response without creating an
  // exec in the untrusted target.
  try {
    await attestor.reattest(pinned);
  } catch (error) {
    rejectFirstRequestBeforeAttach(client, error);
    return;
  }
  const helper = await createTargetBroker(api, pinned);
  const clientDecoder = new FrameDecoder();
  const responseFrames = new FrameDecoder();
  const dockerStreams = new DockerStreamDecoder();
  const methods = new Map();
  const queue = [];
  let processing = false;
  let closing = false;

  const close = () => {
    if (closing) return;
    closing = true;
    helper.destroy();
    client.destroy();
  };
  const failRequest = (request, error) => {
    const requestId = Number.isSafeInteger(request?.requestId) ? request.requestId : 1;
    client.write(encodeFrame(rpcFailure(
      requestId,
      "container_attestation_invalid",
      error instanceof Error ? error.message : String(error)
    )), close);
  };
  const drain = async () => {
    if (processing || closing) return;
    processing = true;
    try {
      while (queue.length > 0 && !closing) {
        const request = queue.shift();
        if (!request || typeof request !== "object" || Array.isArray(request)
          || !Number.isSafeInteger(request.requestId) || typeof request.method !== "string") {
          failRequest(request, new Error("invalid broker request envelope"));
          return;
        }
        try {
          await attestor.reattest(pinned);
        } catch (error) {
          failRequest(request, error);
          return;
        }
        methods.set(request.requestId, request.method);
        helper.write(encodeFrame(request));
      }
    } finally {
      processing = false;
    }
  };

  client.on("data", (chunk) => {
    try {
      queue.push(...clientDecoder.push(chunk));
      void drain();
    } catch (error) {
      failRequest(undefined, error);
    }
  });
  client.once("error", close);
  client.once("close", () => helper.destroy());
  helper.on("data", (chunk) => {
    try {
      for (const stream of dockerStreams.push(chunk)) {
        if (stream.stream === 2) {
          const text = stream.value.toString("utf8").trim();
          if (text) process.stderr.write(`[target sigma-exec] ${text.slice(0, 4096)}\n`);
          continue;
        }
        if (stream.stream !== 1) continue;
        for (const response of responseFrames.push(stream.value)) {
          const method = methods.get(response?.requestId);
          methods.delete(response?.requestId);
          const patched = response?.ok === true && REPORTED_METHODS.has(method)
            ? { ...response, result: patchedReport(response.result, pinned) }
            : response;
          client.write(encodeFrame(patched));
          if (method === "shutdown") client.end();
        }
      }
    } catch (error) {
      process.stderr.write(`OCI broker response failure: ${error instanceof Error ? error.message : String(error)}\n`);
      close();
    }
  });
  helper.once("error", close);
  helper.once("close", () => client.end());
}

async function writeAttestation(pinned) {
  const temporary = `${ATTESTATION_PATH}.tmp-${process.pid}`;
  const payload = `${JSON.stringify({ ...pinned.attestation, workspace: pinned.workspace })}\n`;
  await writeFile(temporary, payload, { encoding: "utf8", mode: 0o444, flag: "wx" });
  await chmod(temporary, 0o444);
  await rename(temporary, ATTESTATION_PATH);
  await chmod(ATTESTATION_PATH, 0o444);
}

export async function main() {
  await mkdir(BROKER_DIRECTORY, { recursive: true, mode: 0o755 });
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true, mode: 0o700 });
  await chmod(BROKER_DIRECTORY, 0o755);
  await chmod(ARTIFACT_DIRECTORY, 0o700);
  await rm(BROKER_SOCKET, { force: true });
  const helperDigest = await installTrustedHelper();
  const api = new DockerApi();
  const attestor = new TargetAttestor(api, {
    digest: helperDigest,
    verify: async () => await trustedHelperTreeDigest()
  });
  const pinned = await attestor.discover();
  await writeAttestation(pinned);
  const server = net.createServer((client) => {
    void handleClient(client, api, attestor, pinned).catch((error) => {
      process.stderr.write(`OCI broker client setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      client.destroy();
    });
  });
  server.on("error", (error) => {
    process.stderr.write(`OCI broker server failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(BROKER_SOCKET, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(BROKER_SOCKET, 0o660);
  process.stdout.write(`${JSON.stringify({
    status: "ready",
    socket: BROKER_SOCKET,
    selector: pinned.attestation.selector,
    targetId: pinned.attestation.targetId,
    imageId: pinned.attestation.imageId,
    imageDigest: pinned.attestation.imageDigest ?? null,
    helperDigest: pinned.attestation.helperDigest
  })}\n`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
