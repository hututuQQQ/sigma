#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANARY_LABEL = "com.sigma.oci-canary";
export const DEFAULT_IMAGE = "node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const RUN_ID = /^sigma-oci-canary-[a-z0-9](?:[a-z0-9-]{6,46}[a-z0-9])$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function diagnostic(error) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/gu, " ").slice(0, 2048);
}

export function assertSafeRunId(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) {
    throw new Error("OCI canary run ID must be a narrow 'sigma-oci-canary-*' lowercase identifier.");
  }
  return value;
}

export function createRunId(now = Date.now(), entropy = randomBytes(5).toString("hex")) {
  return assertSafeRunId(`sigma-oci-canary-${now.toString(36)}-${entropy.toLowerCase()}`);
}

export function engineCandidates(mode) {
  if (mode === "auto") return ["docker", "podman"];
  if (mode === "docker" || mode === "podman") return [mode];
  throw new Error("--engine must be auto, docker, or podman.");
}

export function parseArguments(argv) {
  const options = {
    engine: "auto",
    runId: undefined,
    agentCliTarball: path.join(ROOT, ".artifacts", "agent-cli-linux-x64.tgz"),
    image: DEFAULT_IMAGE,
    targetImage: undefined,
    brokerSource: path.join(ROOT, ".artifacts", "harbor-runtime", "sigma-oci-broker.mjs"),
    clientSource: path.join(ROOT, "scripts", "ci", "sigma-oci-canary-client.mjs"),
    output: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--engine", "--run-id", "--agent-cli-tarball", "--image", "--target-image", "--broker-source", "--client-source", "--output"]
      .includes(flag)) throw new Error(`Unknown OCI canary argument '${flag}'.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    index += 1;
    if (flag === "--engine") options.engine = value;
    else if (flag === "--run-id") options.runId = assertSafeRunId(value);
    else if (flag === "--agent-cli-tarball") options.agentCliTarball = path.resolve(value);
    else if (flag === "--image") options.image = value;
    else if (flag === "--target-image") options.targetImage = value;
    else if (flag === "--broker-source") options.brokerSource = path.resolve(value);
    else if (flag === "--client-source") options.clientSource = path.resolve(value);
    else options.output = path.resolve(value);
  }
  engineCandidates(options.engine);
  for (const [flag, image] of [["--image", options.image], ["--target-image", options.targetImage ?? options.image]]) {
    if (typeof image !== "string" || !image.trim() || /[\r\n\0]/u.test(image)) {
      throw new Error(`${flag} must be a non-empty single-line image reference.`);
    }
  }
  options.targetImage ??= options.image;
  return options;
}

function labels(runId, service, role) {
  return {
    [CANARY_LABEL]: runId,
    "com.sigma.harbor-run": runId,
    "com.docker.compose.project": runId.replaceAll("-", ""),
    "com.docker.compose.service": service,
    "com.sigma.oci-canary-role": role
  };
}

function labelArguments(values) {
  return Object.entries(values).flatMap(([name, value]) => ["--label", `${name}=${value}`]);
}

function mount(kind, source, target, readOnly = false) {
  if ([source, target].some((value) => typeof value !== "string" || !value || /[,\r\n\0]/u.test(value))) {
    throw new Error("OCI canary mount paths must be non-empty and cannot contain commas or control characters.");
  }
  return `type=${kind},source=${source},target=${target}${readOnly ? ",readonly" : ""}`;
}

export function buildResourcePlan(options) {
  const runId = assertSafeRunId(options.runId);
  const suffix = sha256(runId).slice(0, 12);
  const names = {
    target: `sigma-oci-target-${suffix}`,
    broker: `sigma-oci-broker-${suffix}`,
    control: `sigma-oci-control-${suffix}`,
    controlSeed: `sigma-oci-control-seed-${suffix}`,
    workspace: `sigma_oci_workspace_${suffix}`,
    controlState: `sigma_oci_control_state_${suffix}`,
    controlRuntime: `sigma_oci_control_runtime_${suffix}`,
    ipc: `sigma_oci_ipc_${suffix}`,
    artifacts: `sigma_oci_artifacts_${suffix}`,
    helper: `sigma_oci_helper_${suffix}`
  };
  const volumeLabels = { [CANARY_LABEL]: runId, "com.sigma.harbor-run": runId };
  const targetLabels = {
    ...labels(runId, "main", "target"),
    "com.sigma.oci-target": "managed-main-v1"
  };
  const brokerLabels = {
    ...labels(runId, "sigma-oci-broker", "broker"),
    "com.sigma.oci-broker": "v1"
  };
  const controlLabels = {
    ...labels(runId, "sigma-control", "control"),
    "com.sigma.control-plane": "v1"
  };
  const targetImage = options.targetImage ?? options.image;
  const runtimeImage = options.runtimeImage ?? options.image;
  const harborBindMounts = options.harborBindRoot ? [
    ["verifier", "/logs/verifier"],
    ["agent", "/logs/agent"],
    ["artifacts", "/logs/artifacts"]
  ].flatMap(([source, target]) => [
    "--mount", mount("bind", path.join(options.harborBindRoot, source), target)
  ]) : [];
  const target = [
    "run", "--detach", "--name", names.target, "--hostname", names.target,
    ...labelArguments(targetLabels), "--network", "none", "--cap-add", "SYS_ADMIN",
    "--security-opt", "seccomp=unconfined",
    "--mount", mount("volume", names.workspace, "/app"),
    "--mount", mount("volume", names.helper, "/opt/sigma-helper", true),
    "--mount", mount("volume", names.artifacts, "/run/sigma-oci/artifacts"),
    ...harborBindMounts,
    targetImage, "/bin/sh", "-c",
    "set -eu; printf main-seed > /app/.sigma-oci-main-seed; readlink /proc/self/ns/net > /app/.sigma-oci-main-netns; exec tail -f /dev/null"
  ];
  const broker = [
    "create", "--name", names.broker, "--hostname", names.broker,
    ...labelArguments(brokerLabels), "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=1777",
    "--mount", mount("bind", options.socket, "/var/run/docker.sock"),
    "--mount", mount("bind", options.brokerSource, "/opt/sigma-broker/sigma-oci-broker.mjs", true),
    "--mount", mount("bind", options.agentCliTarball, "/opt/sigma-package/agent-cli.tgz", true),
    "--mount", mount("volume", names.helper, "/opt/sigma-helper"),
    "--mount", mount("volume", names.ipc, "/run/sigma-oci"),
    "--mount", mount("volume", names.artifacts, "/run/sigma-oci/artifacts"),
    runtimeImage, "node", "/opt/sigma-broker/sigma-oci-broker.mjs"
  ];
  const controlContainer = [
    "create", "--name", names.control, "--hostname", names.control,
    ...labelArguments(controlLabels), "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=1777",
    "--env", `SIGMA_OCI_CANARY_SECRET=${options.secret}`,
    "--mount", mount("bind", options.agentCliTarball, "/opt/sigma-package/agent-cli.tgz", true),
    "--mount", mount("volume", names.workspace, "/app"),
    "--mount", mount("volume", names.controlState, "/var/lib/sigma"),
    "--mount", mount("volume", names.controlRuntime, "/opt/sigma-control"),
    "--mount", mount("volume", names.helper, "/opt/sigma-helper", true),
    "--mount", mount("volume", names.ipc, "/run/sigma-oci", true),
    "--mount", mount("volume", names.artifacts, "/run/sigma-oci/artifacts"),
    runtimeImage, "tail", "-f", "/dev/null"
  ];
  const controlSeed = [
    "run", "--rm", "--name", names.controlSeed,
    ...labelArguments(labels(runId, "sigma-control-seed", "initializer")),
    "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=1777",
    "--mount", mount("bind", options.clientSource, "/opt/sigma-package/client.mjs", true),
    "--mount", mount("volume", names.controlRuntime, "/opt/sigma-control"),
    runtimeImage, "node", "-e",
    "const fs=require('node:fs');fs.copyFileSync('/opt/sigma-package/client.mjs','/opt/sigma-control/client.mjs');"
      + "fs.chmodSync('/opt/sigma-control/client.mjs',0o444);"
  ];
  const control = (stale = false) => [
    "exec", "--env", `SIGMA_OCI_CANARY_SCENARIO=${stale ? "stale-attestation" : "functional"}`,
    names.control, "node", "/opt/sigma-control/client.mjs"
  ];
  return {
    runId,
    names,
    volumes: Object.values({
      workspace: names.workspace,
      controlState: names.controlState,
      controlRuntime: names.controlRuntime,
      ipc: names.ipc,
      artifacts: names.artifacts,
      helper: names.helper
    })
      .map((name) => ["volume", "create", ...labelArguments(volumeLabels), name]),
    target,
    broker,
    controlContainer,
    controlSeed,
    control,
    expected: {
      target: {
        labels: targetLabels, engineSocket: false, ipc: false, secret: false, workspace: true, helper: "read_only"
      },
      broker: {
        labels: brokerLabels, engineSocket: true, ipc: true, secret: false, workspace: false, helper: "read_write"
      },
      control: {
        labels: controlLabels, engineSocket: false, ipc: true, secret: true, workspace: true, helper: "read_only"
      }
    }
  };
}

function labelsFromInspection(kind, value) {
  return kind === "volume" ? value?.Labels : value?.Config?.Labels;
}

export function selectExactCleanupTargets(kind, values, runId) {
  assertSafeRunId(runId);
  if (!["container", "image", "volume"].includes(kind)) {
    throw new Error("Cleanup kind must be container, image, or volume.");
  }
  return values.map((value) => {
    const identifier = kind === "volume" ? value?.Name : value?.Id;
    if (typeof identifier !== "string" || !identifier) throw new Error(`Inspected ${kind} has no stable identifier.`);
    if (labelsFromInspection(kind, value)?.[CANARY_LABEL] !== runId) {
      throw new Error(`Refusing to clean ${kind} '${identifier}' without the exact run label.`);
    }
    return identifier;
  });
}

function mountTargets(inspection) {
  return new Set((Array.isArray(inspection?.Mounts) ? inspection.Mounts : []).map((item) => item?.Destination));
}

export function verifyRoleIsolation(role, inspection, expected, secret) {
  const actualLabels = inspection?.Config?.Labels ?? {};
  for (const [name, value] of Object.entries(expected.labels)) {
    if (actualLabels[name] !== value) throw new Error(`${role} lost launcher label '${name}'.`);
  }
  const mounts = mountTargets(inspection);
  const helperMount = (Array.isArray(inspection?.Mounts) ? inspection.Mounts : [])
    .find((item) => item?.Destination === "/opt/sigma-helper");
  const helperAccess = helperMount ? helperMount.RW === true ? "read_write" : "read_only" : "absent";
  const environment = Array.isArray(inspection?.Config?.Env) ? inspection.Config.Env : [];
  const hasSecret = environment.includes(`SIGMA_OCI_CANARY_SECRET=${secret}`);
  const assertions = [
    [mounts.has("/var/run/docker.sock"), expected.engineSocket, "engine socket"],
    [mounts.has("/run/sigma-oci"), expected.ipc, "broker IPC"],
    [mounts.has("/app"), expected.workspace, "workspace"],
    [hasSecret, expected.secret, "control secret"],
    [helperAccess, expected.helper, "trusted helper access"]
  ];
  for (const [actual, wanted, label] of assertions) {
    if (actual !== wanted) throw new Error(`${role} ${label} isolation mismatch.`);
  }
  return true;
}

async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, windowsHide: true, env: process.env });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedForOutput = false;
    const capture = (target, chunk, stream) => {
      const length = Buffer.byteLength(chunk);
      if (stream === "stdout") stdoutBytes += length;
      else stderrBytes += length;
      if (stdoutBytes + stderrBytes > MAX_CAPTURE_BYTES) {
        killedForOutput = true;
        child.kill();
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk) => capture(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => capture(stderr, chunk, "stderr"));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", stderr: error.message, error, timedOut: false });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut: signal !== null && !killedForOutput,
        outputExceeded: killedForOutput
      });
    });
  });
}

async function checked(engine, args, options) {
  const result = await run(engine, args, options);
  if (result.code !== 0) {
    throw new Error(`${engine} ${args.slice(0, 3).join(" ")} failed (${String(result.code)}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const READONLY_CONTAINER_ROOTS = [
  "app",
  "opt/sigma-broker",
  "opt/sigma-control",
  "opt/sigma-helper",
  "opt/sigma-package",
  "run/sigma-oci/artifacts",
  "var/lib/sigma"
];

function runtimeImageName(runId) {
  return `sigma-oci-canary-runtime:${sha256(assertSafeRunId(runId)).slice(0, 12)}`;
}

async function buildReadonlyRuntimeImage(engine, baseImage, runId) {
  const contextRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-oci-canary-image-"));
  const image = runtimeImageName(runId);
  try {
    const roots = READONLY_CONTAINER_ROOTS.map((value) => `/${value}`).join(" ");
    await writeFile(path.join(contextRoot, "Dockerfile"), [
      "ARG SIGMA_BASE_IMAGE",
      "FROM ${SIGMA_BASE_IMAGE}",
      `RUN mkdir -p ${roots}`,
      ""
    ].join("\n"), { encoding: "utf8", flag: "wx" });
    await checked(engine, [
      "build", "--network", "none", "--pull=false",
      "--build-arg", `SIGMA_BASE_IMAGE=${baseImage}`,
      "--label", `${CANARY_LABEL}=${runId}`,
      "--tag", image, contextRoot
    ], { timeoutMs: 120_000 });
    const inspection = await inspect(engine, image);
    if (labelsFromInspection("image", inspection)?.[CANARY_LABEL] !== runId) {
      throw new Error("OCI canary runtime image lost its exact cleanup label.");
    }
    return image;
  } finally {
    await rm(contextRoot, { recursive: true, force: true });
  }
}

async function prepareHarborBindRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-oci-canary-harbor-"));
  try {
    for (const directory of ["agent", "artifacts", "verifier"]) {
      await mkdir(path.join(root, directory), { recursive: false });
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function inspect(engine, identifier, kind = "container") {
  const text = await checked(engine, kind === "volume"
    ? ["volume", "inspect", identifier] : ["inspect", identifier]);
  const values = JSON.parse(text);
  if (!Array.isArray(values) || values.length !== 1) throw new Error(`Engine inspection for '${identifier}' was ambiguous.`);
  return values[0];
}

async function listIds(engine, kind, runId) {
  const args = kind === "container"
    ? ["ps", "-a", "--filter", `label=${CANARY_LABEL}=${runId}`, "--format", "{{.ID}}"]
    : kind === "image"
      ? ["image", "ls", "--filter", `label=${CANARY_LABEL}=${runId}`, "--format", "{{.ID}}"]
      : ["volume", "ls", "--filter", `label=${CANARY_LABEL}=${runId}`, "--format", "{{.Name}}"];
  const output = await checked(engine, args);
  return output.split(/\r?\n/gu).map((item) => item.trim()).filter(Boolean);
}

async function cleanup(engine, runId) {
  const containerIds = await listIds(engine, "container", runId);
  const containerInspections = await Promise.all(containerIds.map((identifier) => inspect(engine, identifier)));
  for (const identifier of selectExactCleanupTargets("container", containerInspections, runId)) {
    await checked(engine, ["rm", "--force", identifier]);
  }
  const volumeNames = await listIds(engine, "volume", runId);
  const volumeInspections = await Promise.all(volumeNames.map((identifier) => inspect(engine, identifier, "volume")));
  for (const identifier of selectExactCleanupTargets("volume", volumeInspections, runId)) {
    await checked(engine, ["volume", "rm", identifier]);
  }
  const imageIds = await listIds(engine, "image", runId);
  const imageInspections = await Promise.all(imageIds.map((identifier) => inspect(engine, identifier)));
  for (const identifier of selectExactCleanupTargets("image", imageInspections, runId)) {
    await checked(engine, ["image", "rm", "--force", identifier]);
  }
  const remainder = [
    ...(await listIds(engine, "container", runId)),
    ...(await listIds(engine, "volume", runId)),
    ...(await listIds(engine, "image", runId))
  ];
  if (remainder.length > 0) throw new Error(`OCI canary cleanup left ${remainder.length} run-labeled resources.`);
  return { containers: containerIds.length, volumes: volumeNames.length, images: imageIds.length };
}

function unavailable(engine, code, reason) {
  return { engine, status: "capability_unavailable", failure: { code, reason } };
}

async function probe(engine, env = process.env) {
  const version = await run(engine, ["--version"], { timeoutMs: 10_000 });
  if (version.code !== 0) return unavailable(engine, "container_engine_unavailable", diagnostic(version.stderr || version.error));
  const info = await run(engine, ["info"], { timeoutMs: 20_000 });
  if (info.code !== 0) return unavailable(engine, "container_engine_unavailable", diagnostic(info.stderr || info.stdout));
  let socket;
  if (engine === "docker") socket = env.SIGMA_DOCKER_SOCKET ?? "/var/run/docker.sock";
  else if (env.SIGMA_PODMAN_SOCKET) socket = env.SIGMA_PODMAN_SOCKET;
  else if (process.platform !== "win32" && env.XDG_RUNTIME_DIR) socket = `${env.XDG_RUNTIME_DIR}/podman/podman.sock`;
  else return unavailable(engine, "container_engine_socket_unavailable",
    "Set SIGMA_PODMAN_SOCKET to a bind-mountable Podman API socket.");
  return { engine, status: "available", socket, version: version.stdout.trim() };
}

async function fileSha256(filename) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(filename);
    input.on("data", (chunk) => digest.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return digest.digest("hex");
}

async function assertInputs(options, engine) {
  for (const [name, value] of [
    ["agent CLI archive", options.agentCliTarball],
    ["broker", options.brokerSource], ["client", options.clientSource]
  ]) {
    try {
      const metadata = await stat(value);
      if (!metadata.isFile() || metadata.size === 0) throw new Error("not a non-empty file");
    } catch (error) {
      throw new Error(`OCI canary ${name} input is unavailable at '${value}': ${diagnostic(error)}`, { cause: error });
    }
  }
  const archiveSha256 = await fileSha256(options.agentCliTarball);
  const brokerText = await readFile(options.brokerSource, "utf8");
  if (!brokerText.includes(`const EXPECTED_AGENT_CLI_SHA256 = "${archiveSha256}";`)) {
    throw new Error("OCI canary broker source is not bound to the selected agent CLI archive SHA-256.");
  }
  for (const image of new Set([options.image, options.targetImage ?? options.image])) {
    await checked(engine, ["image", "inspect", image]);
  }
}

function parseCanaryOutput(text, scenario) {
  const lines = text.split(/\r?\n/gu).map((item) => item.trim()).filter(Boolean);
  const value = JSON.parse(lines.at(-1) ?? "null");
  if (value?.status !== "passed" || value?.scenario !== scenario) {
    throw new Error(`OCI canary ${scenario} returned an invalid report.`);
  }
  return value;
}

async function waitForBroker(engine, name, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const logs = await run(engine, ["logs", name], { timeoutMs: 5_000 });
    last = logs.stdout || logs.stderr;
    if (logs.code === 0 && last.includes('"status":"ready"')) return;
    const inspected = await run(engine, ["inspect", name, "--format", "{{.State.Running}}"], { timeoutMs: 5_000 });
    if (inspected.code === 0 && inspected.stdout.trim() === "false") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`OCI broker did not become ready: ${last.slice(-2048)}`);
}

async function runMatrix(engine, probeResult, options, runId) {
  const secret = `canary-${sha256(runId).slice(0, 32)}`;
  const targetImage = options.targetImage ?? options.image;
  const runtimeImage = runtimeImageName(runId);
  const harborBindRoot = await prepareHarborBindRoot();
  const startedAt = new Date().toISOString();
  let cleanupResult;
  let outcome;
  try {
    const plan = buildResourcePlan({
      runId,
      agentCliTarball: options.agentCliTarball,
      image: options.image,
      targetImage,
      brokerSource: options.brokerSource,
      clientSource: options.clientSource,
      socket: probeResult.socket,
      secret,
      runtimeImage,
      harborBindRoot
    });
    await assertInputs(options, engine);
    await buildReadonlyRuntimeImage(engine, options.image, runId);
    for (const command of plan.volumes) await checked(engine, command);
    await checked(engine, plan.controlSeed);
    const targetId = await checked(engine, plan.target);
    const controlId = await checked(engine, plan.controlContainer);
    const brokerId = await checked(engine, plan.broker);
    await checked(engine, ["start", controlId]);
    await checked(engine, ["start", brokerId]);
    await waitForBroker(engine, plan.names.broker);
    const functionalOutput = await checked(engine, plan.control(false), { timeoutMs: 90_000 });
    const functional = parseCanaryOutput(functionalOutput, "functional");

    const [targetInspection, brokerInspection, controlInspection] = await Promise.all([
      inspect(engine, targetId), inspect(engine, brokerId), inspect(engine, controlId)
    ]);
    verifyRoleIsolation("target", targetInspection, plan.expected.target, secret);
    verifyRoleIsolation("broker", brokerInspection, plan.expected.broker, secret);
    verifyRoleIsolation("control", controlInspection, plan.expected.control, secret);
    await checked(engine, ["exec", targetId, "/bin/sh", "-c",
      "set -eu; test \"$(cat /app/.sigma-oci-canary-workspace)\" = workspace-ok; "
      + "test \"$(cat /etc/.sigma-oci-canary-system)\" = system-ok; "
      + "test \"$(cat /app/.sigma-oci-atomic-write.txt)\" = atomic-write-ok; "
      + "test \"$(cat /app/.sigma-oci-atomic-patch.txt)\" = atomic-patch-ok; "
      + "test \"$(cat /app/.sigma-oci-atomic-rollback-first.txt)\" = rollback-first-before; "
      + "test \"$(cat /app/.sigma-oci-atomic-rollback-second.txt)\" = rollback-second-before; "
      + "test ! -e /var/run/docker.sock; test ! -e /run/sigma-oci/broker.sock; "
      + "test \"${SIGMA_OCI_CANARY_SECRET+x}\" != x"]);

    await checked(engine, ["restart", targetId], { timeoutMs: 30_000 });
    const staleOutput = await checked(engine, plan.control(true), { timeoutMs: 30_000 });
    const stale = parseCanaryOutput(staleOutput, "stale-attestation");
    outcome = {
      engine,
      status: "passed",
      engineVersion: probeResult.version,
      image: options.image,
      runtimeBaseImage: options.image,
      runtimeImageId: controlInspection.Image,
      targetImage,
      targetImageId: targetInspection.Image,
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      cases: [
        ...functional.cases,
        { name: "independent_target_verifier", status: "passed" },
        { name: "role_mount_and_secret_isolation", status: "passed" },
        ...stale.cases
      ]
    };
  } finally {
    try {
      cleanupResult = await cleanup(engine, runId);
    } finally {
      await rm(harborBindRoot, { recursive: true, force: true });
    }
  }
  return {
    ...outcome,
    cleanup: cleanupResult,
    cases: [...outcome.cases, { name: "exact_run_labeled_cleanup", status: "passed" }]
  };
}

export async function executeMatrix(options, dependencies = {}) {
  const runId = options.runId ?? createRunId();
  const probeEngine = dependencies.probe ?? probe;
  const runner = dependencies.runMatrix ?? runMatrix;
  const results = [];
  for (const engine of engineCandidates(options.engine)) {
    const capability = await probeEngine(engine);
    if (capability.status !== "available") {
      results.push(capability);
      continue;
    }
    try {
      results.push(await runner(engine, capability, options, runId));
    } catch (error) {
      results.push({ engine, status: "failed", failure: { code: "oci_canary_failed", reason: diagnostic(error) } });
    }
  }
  const passed = results.filter((item) => item.status === "passed").length;
  const failed = results.filter((item) => item.status === "failed").length;
  return {
    schemaVersion: 1,
    kind: "sigma.oci-canary-matrix",
    runId,
    status: failed > 0 ? "failed" : passed > 0 ? "passed" : "capability_unavailable",
    results
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const report = await executeMatrix(options);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await access(path.dirname(options.output));
    await writeFile(options.output, payload, { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(payload);
  process.exitCode = report.status === "passed" ? 0 : report.status === "capability_unavailable" ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
