import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SandboxAdapter,
  SandboxAvailability,
  SandboxBackend,
  SandboxConfig,
  SandboxExecDecision,
  SandboxExecRequest,
  SandboxFilesystemConfig,
  SandboxMode,
  SandboxNetworkConfig,
  SandboxNetworkMode
} from "./types.js";

type EffectiveSandboxMode = "disabled" | "read-only" | "workspace-write" | "danger-full-access" | "policy-only" | "external";
type EffectiveSandboxBackend = "auto" | "bubblewrap" | "seatbelt" | "windows" | "external" | "policy-only";

export interface EffectiveSandboxConfig {
  mode: EffectiveSandboxMode;
  backend: EffectiveSandboxBackend;
  required: boolean;
  network: Required<Pick<SandboxNetworkConfig, "mode" | "allowLocalhost">> & Omit<SandboxNetworkConfig, "mode" | "allowLocalhost">;
  filesystem: {
    readRoots: string[];
    writeRoots: string[];
    denyRead: string[];
    denyWrite: string[];
    tempRoot?: string;
  };
  external?: {
    command?: string;
    args: string[];
  };
}

const DEFAULT_PROTECTED_WRITE_PATHS = [
  ".agent/config.toml",
  ".agent/mcp.json",
  ".agent/skills"
];

function normalizeMode(value: SandboxMode | undefined): EffectiveSandboxMode {
  if (value === "policy_only") return "policy-only";
  if (value === undefined) return "workspace-write";
  return value;
}

function normalizeBackend(value: SandboxBackend | undefined, mode: EffectiveSandboxMode, rawMode?: SandboxMode): EffectiveSandboxBackend {
  if (value === "policy_only") return "policy-only";
  if (value) return value;
  if (rawMode === "policy_only" || rawMode === "policy-only") return "policy-only";
  if (mode === "policy-only") return "policy-only";
  if (mode === "external") return "external";
  return "auto";
}

function normalizeNetwork(value: SandboxConfig["network"] | undefined): EffectiveSandboxConfig["network"] {
  if (typeof value === "string") {
    return { mode: value, allowLocalhost: true };
  }
  return {
    ...(value ?? {}),
    mode: value?.mode ?? "restricted",
    allowLocalhost: value?.allowLocalhost ?? true
  };
}

function configObject(value: SandboxConfig["filesystem"] | undefined): SandboxFilesystemConfig {
  return typeof value === "object" && value !== null ? value : {};
}

function resolveSandboxPath(workspacePath: string, input: string): string {
  return path.resolve(path.isAbsolute(input) ? input : path.join(workspacePath, input));
}

function resolvePathList(workspacePath: string, values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((item) => resolveSandboxPath(workspacePath, item)))];
}

function filesystemMode(value: SandboxConfig["filesystem"] | undefined): "read-only" | "workspace-write" | undefined {
  if (value === "read_only") return "read-only";
  if (value === "workspace_write") return "workspace-write";
  return undefined;
}

export function createDefaultSandboxConfig(): SandboxConfig {
  return {
    mode: "workspace-write",
    backend: "auto",
    required: false,
    network: { mode: "restricted", allowLocalhost: true },
    filesystem: {
      writeRoots: ["."],
      denyWrite: DEFAULT_PROTECTED_WRITE_PATHS
    }
  };
}

export function normalizeSandboxConfig(workspacePath: string, sandbox?: SandboxConfig): EffectiveSandboxConfig {
  const base = sandbox ?? createDefaultSandboxConfig();
  const legacyFilesystemMode = filesystemMode(base.filesystem);
  const mode = legacyFilesystemMode ?? normalizeMode(base.mode);
  const backend = normalizeBackend(base.backend, mode, base.mode);
  const fsConfig = configObject(base.filesystem);
  const workspace = path.resolve(workspacePath);
  const writeRoots = mode === "workspace-write"
    ? resolvePathList(workspace, fsConfig.writeRoots && fsConfig.writeRoots.length > 0 ? fsConfig.writeRoots : ["."])
    : resolvePathList(workspace, fsConfig.writeRoots);
  const readRoots = resolvePathList(workspace, fsConfig.readRoots);
  const denyRead = resolvePathList(workspace, fsConfig.denyRead);
  const denyWrite = resolvePathList(workspace, [
    ...DEFAULT_PROTECTED_WRITE_PATHS,
    ...(fsConfig.denyWrite ?? [])
  ]);
  const tempRoot = fsConfig.tempRoot ? resolveSandboxPath(workspace, fsConfig.tempRoot) : undefined;

  return {
    mode,
    backend,
    required: base.required ?? false,
    network: normalizeNetwork(base.network),
    filesystem: {
      readRoots,
      writeRoots,
      denyRead,
      denyWrite,
      ...(tempRoot ? { tempRoot } : {})
    },
    ...(base.external
      ? { external: { command: base.external.command, args: base.external.args ?? [] } }
      : {})
  };
}

export function sandboxMetadata(effective: EffectiveSandboxConfig, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: effective.mode,
    backend: effective.backend,
    required: effective.required,
    network: effective.network.mode,
    allowLocalhost: effective.network.allowLocalhost,
    readRoots: effective.filesystem.readRoots,
    writeRoots: effective.filesystem.writeRoots,
    denyRead: effective.filesystem.denyRead,
    denyWrite: effective.filesystem.denyWrite,
    ...(effective.filesystem.tempRoot ? { tempRoot: effective.filesystem.tempRoot } : {}),
    ...extra
  };
}

function commandExists(command: string, args: string[] = ["--version"]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  return !result.error && result.status === 0;
}

function windowsSandboxHelperPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "helpers", "windows-sandbox-runner.ps1");
}

function windowsCommandShellPath(): string {
  return process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
}

function bubblewrapAvailable(): boolean {
  return process.platform === "linux" && commandExists("bwrap");
}

function seatbeltAvailable(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}

function windowsSandboxAvailable(effective: EffectiveSandboxConfig): SandboxAvailability {
  if (process.platform !== "win32") {
    return { available: false, backend: "windows", mode: effective.mode, reason: "Windows sandbox backend is only available on Windows." };
  }
  if (effective.network.mode === "restricted" || effective.network.mode === "disabled") {
    return {
      available: false,
      backend: "windows",
      mode: effective.mode,
      reason: "Windows native sandbox v1 does not implement WFP network isolation; use network=default or WSL/bubblewrap for restricted network."
    };
  }
  const helper = windowsSandboxHelperPath();
  if (!existsSync(helper)) {
    return { available: false, backend: "windows", mode: effective.mode, reason: `Windows sandbox helper not found: ${helper}` };
  }
  if (!commandExists("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "-Probe"])) {
    return { available: false, backend: "windows", mode: effective.mode, reason: "Windows sandbox helper probe failed." };
  }
  return { available: true, backend: "windows", mode: effective.mode, metadata: sandboxMetadata(effective) };
}

function backendAvailability(backend: EffectiveSandboxBackend, effective: EffectiveSandboxConfig): SandboxAvailability {
  if (effective.mode === "disabled" || effective.mode === "danger-full-access") {
    return { available: true, backend: "none", mode: effective.mode, metadata: sandboxMetadata(effective) };
  }
  if (backend === "policy-only") {
    return { available: true, backend, mode: effective.mode, metadata: sandboxMetadata(effective) };
  }
  if (backend === "external") {
    const command = effective.external?.command;
    return command
      ? { available: true, backend, mode: effective.mode, metadata: sandboxMetadata(effective) }
      : { available: false, backend, mode: effective.mode, reason: "External sandbox backend requires external.command." };
  }
  if (backend === "bubblewrap") {
    return bubblewrapAvailable()
      ? { available: true, backend, mode: effective.mode, metadata: sandboxMetadata(effective) }
      : { available: false, backend, mode: effective.mode, reason: "bubblewrap backend is unavailable. Install bwrap and enable user namespaces." };
  }
  if (backend === "seatbelt") {
    return seatbeltAvailable()
      ? { available: true, backend, mode: effective.mode, metadata: sandboxMetadata(effective) }
      : { available: false, backend, mode: effective.mode, reason: "macOS seatbelt backend is unavailable." };
  }
  if (backend === "windows") {
    return windowsSandboxAvailable(effective);
  }
  return { available: false, backend, mode: effective.mode, reason: `Unsupported sandbox backend: ${backend}` };
}

function selectAutoBackend(): EffectiveSandboxBackend {
  if (process.platform === "linux") return "bubblewrap";
  if (process.platform === "darwin") return "seatbelt";
  if (process.platform === "win32") return "windows";
  return "policy-only";
}

function policyOnlyDecision(request: SandboxExecRequest, effective: EffectiveSandboxConfig, extra: Record<string, unknown> = {}): SandboxExecDecision {
  if (effective.mode === "read-only" && request.policy.mutatesWorkspace) {
    return {
      allowed: false,
      reason: "Sandbox policy is read-only, but the command appears to modify workspace state.",
      metadata: sandboxMetadata(effective, { enforcement: "policy-only", ...extra })
    };
  }
  if ((effective.network.mode === "restricted" || effective.network.mode === "disabled") && request.policy.usesNetwork) {
    return {
      allowed: false,
      reason: "Sandbox policy restricts network access, but the command appears to use the network.",
      metadata: sandboxMetadata(effective, { enforcement: "policy-only", ...extra })
    };
  }
  return {
    allowed: true,
    cwd: request.cwd,
    env: request.env,
    metadata: sandboxMetadata(effective, { enforcement: "policy-only", ...extra })
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function windowsArgQuote(value: string): string {
  let result = "\"";
  let slashCount = 0;
  for (const char of value) {
    if (char === "\\") {
      slashCount += 1;
      continue;
    }
    if (char === "\"") {
      result += "\\".repeat(slashCount * 2 + 1);
      result += "\"";
      slashCount = 0;
      continue;
    }
    result += "\\".repeat(slashCount);
    slashCount = 0;
    result += char;
  }
  result += "\\".repeat(slashCount * 2);
  result += "\"";
  return result;
}

function existingPaths(paths: string[]): string[] {
  return paths.filter((item) => existsSync(item));
}

function addReadOnlyOverlays(args: string[], paths: string[]): void {
  for (const item of existingPaths(paths)) {
    args.push("--ro-bind", item, item);
  }
}

function buildBubblewrapArgs(effective: EffectiveSandboxConfig, cwd: string, command: string[]): string[] {
  const args = [
    "--die-with-parent",
    "--ro-bind", "/", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--setenv", "TMPDIR", "/tmp"
  ];
  if (effective.network.mode === "restricted" || effective.network.mode === "disabled") {
    args.push("--unshare-net");
  }
  for (const root of effective.filesystem.writeRoots) {
    if (existsSync(root)) args.push("--bind", root, root);
  }
  for (const root of effective.filesystem.readRoots) {
    if (existsSync(root)) args.push("--ro-bind", root, root);
  }
  addReadOnlyOverlays(args, effective.filesystem.denyWrite);
  args.push("--chdir", cwd, ...command);
  return args;
}

function prepareBubblewrapExec(request: SandboxExecRequest, effective: EffectiveSandboxConfig): SandboxExecDecision {
  const args = buildBubblewrapArgs(effective, request.cwd, ["/usr/bin/env", "bash", "-lc", request.command]);
  return {
    allowed: true,
    command: "bwrap",
    args,
    cwd: request.cwd,
    env: request.env,
    metadata: sandboxMetadata(effective, { enforcement: "bubblewrap", transformed: true })
  };
}

function prepareExternalExec(request: SandboxExecRequest, effective: EffectiveSandboxConfig): SandboxExecDecision {
  const command = effective.external?.command;
  if (!command) {
    return {
      allowed: false,
      reason: "External sandbox backend requires external.command.",
      metadata: sandboxMetadata(effective, { enforcement: "external" })
    };
  }
  return {
    allowed: true,
    command,
    args: [
      ...(effective.external?.args ?? []),
      "--cwd",
      request.cwd,
      "--",
      "/usr/bin/env",
      "bash",
      "-lc",
      request.command
    ],
    cwd: request.cwd,
    env: request.env,
    metadata: sandboxMetadata(effective, { enforcement: "external", transformed: true })
  };
}

function capabilitySidForSandbox(workspacePath: string, effective: EffectiveSandboxConfig): string {
  const hash = createHash("sha256")
    .update("sigma-windows-sandbox-v1\0")
    .update(path.resolve(workspacePath).toLowerCase())
    .update("\0")
    .update(effective.mode)
    .digest();
  const parts: string[] = [];
  for (let offset = 0; offset < 16; offset += 4) {
    parts.push(String(hash.readUInt32LE(offset)));
  }
  return `S-1-5-21-${parts.join("-")}`;
}

async function prepareWindowsExec(request: SandboxExecRequest, effective: EffectiveSandboxConfig): Promise<SandboxExecDecision> {
  const helper = windowsSandboxHelperPath();
  const shell = windowsCommandShellPath();
  const requestDir = path.join(os.tmpdir(), "sigma-windows-sandbox");
  const tempRootBase = effective.filesystem.tempRoot ?? path.join(os.tmpdir(), "sigma-windows-sandbox-tmp");
  const tempRoot = path.join(tempRootBase, randomUUID());
  await mkdir(requestDir, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  const requestPath = path.join(requestDir, `${randomUUID()}.json`);
  const capabilitySid = capabilitySidForSandbox(request.workspacePath ?? request.cwd, effective);
  const allowedWriteRoots = [
    ...(effective.mode === "workspace-write" ? effective.filesystem.writeRoots : []),
    tempRoot
  ];
  const env = {
    ...(request.env ?? process.env),
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot
  };
  await writeFile(
    requestPath,
    `${JSON.stringify({
      program: shell,
      args: request.toolName === "shell_session" ? ["/q"] : [],
      commandLine: request.toolName === "shell_session"
        ? windowsArgQuote(shell)
        : `${windowsArgQuote(shell)} /d /s /c ${windowsArgQuote(request.command)}`,
      cwd: request.cwd,
      capabilitySid,
      writeRoots: allowedWriteRoots,
      denyWrite: effective.filesystem.denyWrite
    })}\n`,
    "utf8"
  );
  return {
    allowed: true,
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "-Request", requestPath],
    cwd: request.cwd,
    env,
    metadata: sandboxMetadata(effective, { enforcement: "windows-restricted-token", transformed: true, capabilitySid, tempRoot, shell: "cmd.exe" })
  };
}

function unavailableDecision(
  request: SandboxExecRequest,
  effective: EffectiveSandboxConfig,
  availability: SandboxAvailability
): SandboxExecDecision {
  if (effective.required) {
    return {
      allowed: false,
      reason: availability.reason ?? `Sandbox backend ${availability.backend} is unavailable.`,
      metadata: sandboxMetadata(effective, { backendAvailable: false, reason: availability.reason })
    };
  }
  const fallback = policyOnlyDecision(request, { ...effective, backend: "policy-only" }, {
    fallbackFrom: availability.backend,
    fallbackReason: availability.reason
  });
  return {
    ...fallback,
    metadata: {
      ...(fallback.metadata ?? {}),
      backendAvailable: false
    }
  };
}

export class PolicyOnlySandboxAdapter implements SandboxAdapter {
  async checkAvailability(sandbox: SandboxConfig | undefined, workspacePath: string): Promise<SandboxAvailability> {
    const effective = normalizeSandboxConfig(workspacePath, sandbox);
    return { available: true, backend: "policy-only", mode: effective.mode, metadata: sandboxMetadata(effective) };
  }

  async prepareExec(request: SandboxExecRequest): Promise<SandboxExecDecision> {
    return policyOnlyDecision(request, normalizeSandboxConfig(request.workspacePath ?? request.cwd, request.sandbox));
  }
}

export class DefaultSandboxAdapter implements SandboxAdapter {
  async checkAvailability(sandbox: SandboxConfig | undefined, workspacePath: string): Promise<SandboxAvailability> {
    const effective = normalizeSandboxConfig(workspacePath, sandbox);
    const backend = effective.backend === "auto" ? selectAutoBackend() : effective.backend;
    return backendAvailability(backend, effective);
  }

  async prepareExec(request: SandboxExecRequest): Promise<SandboxExecDecision> {
    const effective = normalizeSandboxConfig(request.workspacePath ?? request.cwd, request.sandbox);
    if (effective.mode === "disabled" || effective.mode === "danger-full-access") {
      return {
        allowed: true,
        cwd: request.cwd,
        env: request.env,
        metadata: sandboxMetadata(effective, { enforcement: "none" })
      };
    }
    if (effective.mode === "policy-only") {
      return policyOnlyDecision(request, effective);
    }

    const backend = effective.backend === "auto" ? selectAutoBackend() : effective.backend;
    const availability = backendAvailability(backend, effective);
    if (!availability.available) return unavailableDecision(request, effective, availability);
    if (backend === "policy-only") return policyOnlyDecision(request, effective);
    if (backend === "bubblewrap") return prepareBubblewrapExec(request, { ...effective, backend });
    if (backend === "windows") return await prepareWindowsExec(request, { ...effective, backend });
    if (backend === "external") return prepareExternalExec(request, { ...effective, backend });

    return unavailableDecision(request, effective, {
      available: false,
      backend,
      mode: effective.mode,
      reason: `Sandbox backend ${backend} is not implemented for command execution.`
    });
  }
}

export function createPolicyOnlySandboxAdapter(): SandboxAdapter {
  return new PolicyOnlySandboxAdapter();
}

export function createDefaultSandboxAdapter(): SandboxAdapter {
  return new DefaultSandboxAdapter();
}

export function formatSandboxShellCommand(command: string, args: string[] | undefined): string {
  return args && args.length > 0
    ? [command, ...args].map(shellQuote).join(" ")
    : command;
}
