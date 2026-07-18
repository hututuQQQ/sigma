import { LazyExecutionBroker, type ExecutionBroker } from "agent-execution";
import { loadCliConfig, parseArgs } from "../config.js";

interface SandboxCommandDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  executionBroker?: ExecutionBroker;
}

function requestedCommand(argv: string[]): "help" | "setup" | "status" | "repair" | "revoke" {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  const command = argv[0] ?? "status";
  if (!["setup", "status", "repair", "revoke"].includes(command)) {
    throw new Error(`Unknown sandbox command '${command}'.`);
  }
  return command as "setup" | "status" | "repair" | "revoke";
}

function writeResult(
  report: Awaited<ReturnType<ExecutionBroker["doctor"]>>,
  json: boolean,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream
): boolean {
  const ready = report.sandbox.available && report.sandbox.selfTestPassed;
  const result = {
    ready,
    platform: report.platform,
    architecture: report.architecture,
    backend: report.sandbox.backend,
    hardening: report.sandbox.hardening ?? null,
    setupRequired: report.sandbox.setupRequired,
    reason: report.sandbox.reason ?? null
  };
  if (json) stdout.write(`${JSON.stringify(result)}\n`);
  else if (ready) stdout.write(`sandbox ready: ${report.sandbox.backend}\n`);
  else stderr.write(`sandbox setup is required but no safe automatic setup is available: ${report.sandbox.reason ?? "self-test failed"}\n`);
  return ready;
}

async function prepareSandbox(broker: ExecutionBroker): Promise<Awaited<ReturnType<ExecutionBroker["doctor"]>>> {
  const current = await broker.doctor();
  if (current.sandbox.available && current.sandbox.selfTestPassed) return current;
  return broker.setupSandbox ? await broker.setupSandbox() : current;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reportSandboxStatus(
  broker: ExecutionBroker,
  workspace: string,
  json: boolean,
  stdout: NodeJS.WritableStream
): Promise<number> {
  const report = await broker.doctor();
  const lease = broker.sandboxLeaseStatus
    ? await broker.sandboxLeaseStatus(workspace).catch(() => undefined) : undefined;
  if (json) stdout.write(`${JSON.stringify({ sandbox: report.sandbox, lease: lease ?? null })}\n`);
  else {
    stdout.write(`sandbox ${report.sandbox.available ? "ready" : "unavailable"}: ${report.sandbox.backend}\n`);
    stdout.write(lease
      ? `lease ${lease.state}: generation=${lease.generation} principal=${lease.principalId}\n`
      : "lease inactive: it will be created by the first read-only command\n");
  }
  return report.sandbox.available && report.sandbox.selfTestPassed ? 0 : 1;
}

async function revokeSandboxLease(
  broker: ExecutionBroker,
  workspace: string,
  json: boolean,
  stdout: NodeJS.WritableStream
): Promise<number> {
  if (!broker.revokeSandboxLease) throw Object.assign(new Error("Sandbox lease revoke is unavailable."), {
    code: "sandbox_recovery_required"
  });
  const revoked = await broker.revokeSandboxLease(workspace);
  stdout.write(json ? `${JSON.stringify(revoked)}\n`
    : `sandbox lease revoked; next generation=${revoked.generation}\n`);
  return 0;
}

export async function runSandboxCommand(argv: string[], deps: SandboxCommandDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  let command: "help" | "setup" | "status" | "repair" | "revoke";
  try { command = requestedCommand(argv); } catch (error) {
    stderr.write(`${errorText(error)}\n`);
    return 1;
  }
  if (command === "help") {
    stdout.write("agent sandbox <status|setup|repair|revoke> [--workspace <path>] [--json]\n");
    return 0;
  }
  const owned = deps.executionBroker ? undefined : new LazyExecutionBroker({
    sandboxMode: "required"
  });
  const broker = deps.executionBroker ?? owned!;
  try {
    const { flags } = parseArgs(argv.slice(1));
    const config = loadCliConfig(flags);
    const json = argv.includes("--json");
    if (command === "status") return await reportSandboxStatus(broker, config.workspace, json, stdout);
    if (command === "revoke") return await revokeSandboxLease(broker, config.workspace, json, stdout);
    const report = command === "repair" && broker.repairSandbox
      ? await broker.repairSandbox() : await prepareSandbox(broker);
    return writeResult(report, json, stdout, stderr) ? 0 : 1;
  } catch (error) {
    stderr.write(`${errorText(error)}\n`);
    return 1;
  } finally {
    await owned?.close();
  }
}
