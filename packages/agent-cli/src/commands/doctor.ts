import { access } from "node:fs/promises";
import { discoverLanguageServers, type LanguageServerPreset } from "agent-code-intel";
import type { ExecutionBroker } from "agent-execution";
import { checkProviderHealth, LazyExecutionBroker } from "agent-runtime";
import { loadCliConfig, parseArgs } from "../config.js";

interface DoctorDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  executionBroker?: ExecutionBroker;
  languageServers?: LanguageServerPreset[];
}

async function sandboxCheck(broker: ExecutionBroker): Promise<DoctorCheck> {
  try {
    const report = await broker.doctor();
    const ready = report.sandbox.available && report.sandbox.selfTestPassed;
    return {
      name: "sandbox",
      status: ready ? "ok" : "warning",
      message: ready
        ? `${report.sandbox.backend} ready; network=${report.capabilities.networkModes.join("|")}; pty=${String(report.capabilities.pty)}`
        : `${report.sandbox.backend} unavailable: ${report.sandbox.reason ?? "self-test failed"}`
    };
  } catch (error) {
    return { name: "sandbox", status: "warning", message: error instanceof Error ? error.message : String(error) };
  }
}

function languageServerChecks(presets: LanguageServerPreset[]): DoctorCheck[] {
  return presets.map((preset) => ({
    name: `lsp_${preset.id}`,
    status: preset.available ? "ok" : preset.id === "typescript" || preset.id === "python" ? "error" : "warning",
    message: preset.available
      ? `${preset.source}: ${preset.executable}`
      : preset.unavailableReason ?? "language server unavailable"
  }));
}

interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error" | "skipped";
  message: string;
}

function configuredKey(provider: "deepseek" | "glm"): boolean {
  return provider === "deepseek"
    ? Boolean(process.env.DEEPSEEK_API_KEY)
    : Boolean(process.env.GLM_API_KEY || process.env.ZAI_API_KEY || process.env.BIGMODEL_API_KEY);
}

function nodeCheck(): DoctorCheck {
  return process.versions.node === "26.4.0"
    ? { name: "node", status: "ok", message: `Node ${process.versions.node}` }
    : { name: "node", status: "warning", message: `Node ${process.versions.node}; release runtime is pinned to 26.4.0.` };
}

async function apiCheck(provider: "deepseek" | "glm", model: string, enabled: boolean): Promise<DoctorCheck> {
  if (!enabled) return { name: "api", status: "skipped", message: "Pass --check-api to verify the provider." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("API check timed out.")), 30_000);
  try {
    const message = await checkProviderHealth({ provider, model, signal: controller.signal });
    return { name: "api", status: "ok", message };
  } catch (error) {
    return { name: "api", status: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function workspaceCheck(workspace: string): Promise<DoctorCheck> {
  try {
    await access(workspace);
    return { name: "workspace", status: "ok", message: workspace };
  } catch {
    return { name: "workspace", status: "error", message: `Workspace is not accessible: ${workspace}` };
  }
}

function providerKeyCheck(provider: "deepseek" | "glm"): DoctorCheck {
  return configuredKey(provider)
    ? { name: "provider_key", status: "ok", message: `${provider} credentials are configured.` }
    : { name: "provider_key", status: "warning", message: `${provider} credentials are not configured.` };
}

function reportStatus(checks: DoctorCheck[], strict: boolean): { failed: boolean; status: "ok" | "warning" | "error" } {
  const hasError = checks.some((item) => item.status === "error");
  const hasWarning = checks.some((item) => item.status === "warning");
  const failed = hasError || (strict && hasWarning);
  return { failed, status: failed ? "error" : hasWarning ? "warning" : "ok" };
}

function writeReport(stdout: NodeJS.WritableStream, report: object, checks: DoctorCheck[], json: boolean): void {
  if (json) {
    stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  for (const check of checks) stdout.write(`${check.name}=${check.status} ${check.message}\n`);
}

export async function runDoctorCommand(argv: string[], deps: DoctorDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write("agent doctor [--workspace <path>] [--check-api] [--strict] [--json]\n");
    return 0;
  }
  try {
    const { flags } = parseArgs(argv);
    const config = loadCliConfig(flags);
    const ownedBroker = deps.executionBroker ? undefined : new LazyExecutionBroker({
      sandboxMode: "unsafe",
      allowUnsafeHostExec: false
    });
    const broker = deps.executionBroker ?? ownedBroker!;
    const checks: DoctorCheck[] = [nodeCheck(), await workspaceCheck(config.workspace), providerKeyCheck(config.provider)];
    checks.push(await sandboxCheck(broker));
    checks.push(...languageServerChecks(deps.languageServers ?? discoverLanguageServers()));
    checks.push(await apiCheck(config.provider, config.model, flags["check-api"] === true));
    const strict = flags.strict === true;
    const outcome = reportStatus(checks, strict);
    const report = { status: outcome.status, strict, checks };
    writeReport(stdout, report, checks, flags.json === true);
    await ownedBroker?.close();
    return outcome.failed ? 1 : 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
