import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { bashExecutable, runBashCommand } from "../command-runner.js";
import { requestToolPermission, resolveWorkspacePath } from "../policy.js";

type ServiceAction = "start" | "status" | "logs" | "stop";

interface ServiceArgs {
  action?: unknown;
  name?: unknown;
  command?: unknown;
  cwd?: unknown;
  port?: unknown;
  readinessCommand?: unknown;
  logPath?: unknown;
  keepAliveAfterRun?: unknown;
  readinessTimeoutSec?: unknown;
  maxLogChars?: unknown;
}

export interface ServiceRecord {
  name: string;
  pid: number;
  command: string;
  cwd: string;
  port?: number;
  readinessCommand?: string;
  logPath: string;
  keepAliveAfterRun: boolean;
  startedAt: string;
}

export interface ServiceCleanupResult {
  stopped: string[];
  kept: string[];
  missing: string[];
  errors: string[];
}

const DEFAULT_READINESS_TIMEOUT_SEC = 15;
const DEFAULT_LOG_CHARS = 4000;

function registryPath(): string {
  return path.resolve(process.env.AGENT_SERVICE_REGISTRY ?? "/tmp/agent/services.json");
}

function serviceLogDir(workspacePath: string): string {
  if (process.env.AGENT_SERVICE_LOG_DIR) {
    try {
      return resolveWorkspacePath(workspacePath, process.env.AGENT_SERVICE_LOG_DIR);
    } catch {
      return path.join(workspacePath, ".agent", "services");
    }
  }
  return path.join(workspacePath, ".agent", "services");
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "service";
}

function asAction(value: unknown): ServiceAction | null {
  return value === "start" || value === "status" || value === "logs" || value === "stop" ? value : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asOptionalBool(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return undefined;
}

function defaultKeepAliveAfterRun(args: ServiceArgs, port: number | undefined, readinessCommand: string | undefined): boolean {
  const explicit = asOptionalBool(args.keepAliveAfterRun);
  if (explicit !== undefined) return explicit;
  return port !== undefined || readinessCommand !== undefined;
}

function serviceUrl(port: number | undefined): string | undefined {
  return port ? `http://127.0.0.1:${port}` : undefined;
}

async function readRegistry(): Promise<ServiceRecord[]> {
  try {
    const value = JSON.parse(await readFile(registryPath(), "utf8"));
    return Array.isArray(value?.services) ? value.services.filter(isServiceRecord) : [];
  } catch {
    return [];
  }
}

async function writeRegistry(services: ServiceRecord[]): Promise<void> {
  const target = registryPath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ services }, null, 2)}\n`, "utf8");
}

function isServiceRecord(value: unknown): value is ServiceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ServiceRecord>;
  return typeof record.name === "string" && typeof record.pid === "number" && typeof record.logPath === "string";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPidGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to signaling the recorded process below.
    }
  }
  process.kill(pid, signal);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(500);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

async function readinessPassed(record: ServiceRecord, timeoutSec: number): Promise<boolean> {
  if (!record.port && !record.readinessCommand) return true;
  const deadline = Date.now() + Math.max(1, Math.floor(timeoutSec * 1000));
  while (Date.now() <= deadline) {
    if (!isAlive(record.pid)) return false;
    const portReady = record.port ? await connectPort(record.port) : true;
    let commandReady = true;
    if (record.readinessCommand) {
      const result = await runBashCommand({
        command: record.readinessCommand,
        cwd: record.cwd,
        env: process.env,
        timeoutMs: 2000,
        detachedProcessGroup: false
      });
      commandReady = !result.timedOut && result.exitCode === 0;
    }
    if (portReady && commandReady) return true;
    await sleep(100);
  }
  return false;
}

async function stopRecord(record: ServiceRecord): Promise<"stopped" | "missing"> {
  if (!isAlive(record.pid)) return "missing";
  killPidGroup(record.pid, "SIGTERM");
  for (let index = 0; index < 10; index += 1) {
    await sleep(100);
    if (!isAlive(record.pid)) return "stopped";
  }
  killPidGroup(record.pid, "SIGKILL");
  return "stopped";
}

function resolveOptionalPath(value: unknown, workspacePath: string, cwd: string): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const candidate = path.isAbsolute(text) ? path.resolve(text) : path.resolve(cwd, text);
  return resolveWorkspacePath(workspacePath, candidate);
}

async function startService(args: ServiceArgs, context: ToolExecutionContext): Promise<ToolResult> {
  const name = asString(args.name);
  const command = asString(args.command);
  if (!name || !command) {
    return { ok: false, content: "service.start requires name and command" };
  }

  const denied = await requestToolPermission(context, {
    toolName: "service",
    arguments: args,
    risk: "execute",
    reason: `Start background service ${name}`
  });
  if (denied) return denied;

  let cwd: string;
  try {
    cwd = typeof args.cwd === "string" ? resolveWorkspacePath(context.workspacePath, args.cwd) : context.workspacePath;
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  const port = asNumber(args.port);
  const readinessCommand = asString(args.readinessCommand);
  let logPath: string;
  try {
    logPath = resolveOptionalPath(args.logPath, context.workspacePath, cwd) ??
      path.join(serviceLogDir(context.workspacePath), `${safeName(name)}.log`);
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
  await mkdir(path.dirname(logPath), { recursive: true });
  const outFd = openSync(logPath, "a");
  let pid: number | undefined;
  try {
    const child = spawn(bashExecutable(), ["-lc", command], {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", outFd, outFd],
      windowsHide: true
    });
    child.on("error", () => {
      // Errors are reflected by readiness checks and logs; keep the detached child from emitting unhandled errors.
    });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(outFd);
  }

  if (!pid) {
    return { ok: false, content: "Failed to start service: missing child pid", metadata: { logPath } };
  }

  const record: ServiceRecord = {
    name,
    pid,
    command,
    cwd,
    ...(port ? { port } : {}),
    ...(readinessCommand ? { readinessCommand } : {}),
    logPath,
    keepAliveAfterRun: defaultKeepAliveAfterRun(args, port, readinessCommand),
    startedAt: new Date().toISOString()
  };

  const existingServices = await readRegistry();
  for (const service of existingServices.filter((item) => item.name === name)) {
    try {
      await stopRecord(service);
    } catch {
      // Starting a replacement service should not fail because an old pid is already gone.
    }
  }
  const services = existingServices.filter((service) => service.name !== name);
  services.push(record);
  await writeRegistry(services);

  const timeoutSec = asNumber(args.readinessTimeoutSec) ?? DEFAULT_READINESS_TIMEOUT_SEC;
  const ready = await readinessPassed(record, timeoutSec);
  if (!ready) {
    await stopRecord(record);
    await writeRegistry((await readRegistry()).filter((service) => service.name !== name));
    return {
      ok: false,
      content: `service ${name} did not become ready within ${timeoutSec}s; log: ${logPath}`,
      metadata: { ...record, ready: false, readinessTimeoutSec: timeoutSec }
    };
  }

  const url = serviceUrl(record.port);
  return {
    ok: true,
    content: `service ${name} started${url ? ` url=${url}` : ""} pid=${pid} log=${logPath}`,
    metadata: { ...record, ready: true, ...(url ? { url } : {}) }
  };
}

async function statusService(args: ServiceArgs): Promise<ToolResult> {
  const name = asString(args.name);
  const services = await readRegistry();
  const selected = name ? services.filter((service) => service.name === name) : services;
  const statuses = selected.map((service) => ({
    ...service,
    alive: isAlive(service.pid)
  }));
  return {
    ok: name ? statuses.length > 0 : true,
    content: JSON.stringify(statuses, null, 2),
    metadata: { services: statuses }
  };
}

async function logsService(args: ServiceArgs): Promise<ToolResult> {
  const name = asString(args.name);
  if (!name) return { ok: false, content: "service.logs requires name" };
  const record = (await readRegistry()).find((service) => service.name === name);
  if (!record) return { ok: false, content: `Unknown service: ${name}` };
  const maxLogChars = Math.max(1, Math.floor(asNumber(args.maxLogChars) ?? DEFAULT_LOG_CHARS));
  let text = "";
  try {
    text = await readFile(record.logPath, "utf8");
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error), metadata: { logPath: record.logPath } };
  }
  return {
    ok: true,
    content: text.length <= maxLogChars ? text : text.slice(-maxLogChars),
    metadata: { logPath: record.logPath, truncated: text.length > maxLogChars }
  };
}

async function stopService(args: ServiceArgs, context: ToolExecutionContext): Promise<ToolResult> {
  const name = asString(args.name);
  const denied = await requestToolPermission(context, {
    toolName: "service",
    arguments: args,
    risk: "execute",
    reason: name ? `Stop background service ${name}` : "Stop background services"
  });
  if (denied) return denied;

  const services = await readRegistry();
  const selected = name ? services.filter((service) => service.name === name) : services;
  const results: ServiceCleanupResult = { stopped: [], kept: [], missing: [], errors: [] };
  for (const service of selected) {
    try {
      const status = await stopRecord(service);
      results[status].push(service.name);
    } catch (error) {
      results.errors.push(`${service.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const stoppedNames = new Set([...results.stopped, ...results.missing]);
  await writeRegistry(services.filter((service) => !stoppedNames.has(service.name)));
  return {
    ok: results.errors.length === 0 && (!name || selected.length > 0),
    content: JSON.stringify(results, null, 2),
    metadata: { ...results }
  };
}

export async function finalizeManagedServices(): Promise<ServiceCleanupResult> {
  const services = await readRegistry();
  const result: ServiceCleanupResult = { stopped: [], kept: [], missing: [], errors: [] };
  for (const service of services) {
    if (service.keepAliveAfterRun) {
      result.kept.push(service.name);
      continue;
    }
    try {
      const status = await stopRecord(service);
      result[status].push(service.name);
    } catch (error) {
      result.errors.push(`${service.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const removed = new Set([...result.stopped, ...result.missing]);
  await writeRegistry(services.filter((service) => service.keepAliveAfterRun || !removed.has(service.name)));
  return result;
}

export async function executeServiceTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as ServiceArgs;
  const action = asAction(parsed.action);
  if (!action) {
    return { ok: false, content: "service requires action: start, status, logs, or stop" };
  }
  if (action === "start") return await startService(parsed, context);
  if (action === "status") return await statusService(parsed);
  if (action === "logs") return await logsService(parsed);
  return await stopService(parsed, context);
}
