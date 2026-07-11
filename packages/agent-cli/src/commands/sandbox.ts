import type { ExecutionBroker } from "agent-execution";
import { LazyExecutionBroker } from "agent-runtime";

interface SandboxCommandDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  executionBroker?: ExecutionBroker;
}

function requestedCommand(argv: string[]): "help" | "setup" {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  const command = argv[0] ?? "setup";
  if (command !== "setup") throw new Error(`Unknown sandbox command '${command}'.`);
  return command;
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

export async function runSandboxCommand(argv: string[], deps: SandboxCommandDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  let command: "help" | "setup";
  try { command = requestedCommand(argv); } catch (error) {
    stderr.write(`${errorText(error)}\n`);
    return 1;
  }
  if (command === "help") {
    stdout.write("agent sandbox setup [--json]\n");
    return 0;
  }
  const owned = deps.executionBroker ? undefined : new LazyExecutionBroker({
    sandboxMode: "unsafe",
    allowUnsafeHostExec: false
  });
  const broker = deps.executionBroker ?? owned!;
  try {
    const report = await prepareSandbox(broker);
    return writeResult(report, argv.includes("--json"), stdout, stderr) ? 0 : 1;
  } catch (error) {
    stderr.write(`${errorText(error)}\n`);
    return 1;
  } finally {
    await owned?.close();
  }
}
