import { access } from "node:fs/promises";
import { discoverLanguageServers, type LanguageServerPreset } from "agent-code-intel";
import { SIGMA_PROJECT_FACTS } from "agent-config";
import { LazyExecutionBroker, type ExecutionBroker } from "agent-execution";
import { checkProviderHealth, type ProviderHealthReport } from "agent-model";
import { loadCliConfig, parseArgs } from "../config.js";

export const DOCTOR_REPORT_SCHEMA_VERSION = 1 as const;

interface DoctorDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  executionBroker?: ExecutionBroker;
  createExecutionBroker?: () => ExecutionBroker;
  languageServers?: LanguageServerPreset[];
}

async function sandboxCheck(broker: ExecutionBroker, workspace: string): Promise<SandboxProbe> {
  try {
    const report = await broker.doctor();
    const lease = broker.sandboxLeaseStatus
      ? await broker.sandboxLeaseStatus(workspace).catch(() => undefined) : undefined;
    const ready = report.sandbox.available && report.sandbox.selfTestPassed;
    return {
      report,
      lease,
      check: {
        name: "sandbox",
        status: ready ? "ok" : "warning",
        message: ready
          ? `${report.sandbox.backend} ready; network=${report.capabilities.networkModes.join("|")}; `
            + `pty=${String(report.capabilities.pty)}; handoff=${String(report.capabilities.processHandoff === true)}; `
            + (lease ? `lease=${lease.state}/g${lease.generation}` : "lease=inactive")
          : `${report.sandbox.backend} unavailable: ${report.sandbox.reason ?? "self-test failed"}`
      }
    };
  } catch (error) {
    return {
      check: { name: "sandbox", status: "warning", message: error instanceof Error ? error.message : String(error) }
    };
  }
}

function languageServerChecks(presets: LanguageServerPreset[]): DoctorCheck[] {
  return presets.map((preset) => ({
    name: `lsp_${preset.id}`,
    status: preset.available ? "ok" : preset.id === "typescript" || preset.id === "python" ? "error" : "skipped",
    message: preset.available
      ? `${preset.source}: ${preset.executable}`
      : preset.unavailableReason ?? "language server unavailable"
  }));
}

interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error" | "skipped";
  message: string;
  provider?: string;
  model?: string;
  endpoint_host?: string;
  elapsed_ms?: number;
  failure_kind?: "api_error" | "network_error";
  error_category?: string;
}

type BrokerDoctorReport = Awaited<ReturnType<ExecutionBroker["doctor"]>>;

interface SandboxProbe {
  check: DoctorCheck;
  report?: BrokerDoctorReport;
  lease?: Awaited<ReturnType<NonNullable<ExecutionBroker["sandboxLeaseStatus"]>>>;
}

function configuredKey(provider: "deepseek" | "glm"): boolean {
  return provider === "deepseek"
    ? Boolean(process.env.DEEPSEEK_API_KEY)
    : Boolean(process.env.GLM_API_KEY || process.env.ZAI_API_KEY || process.env.BIGMODEL_API_KEY);
}

function nodeCheck(): DoctorCheck {
  const expected = SIGMA_PROJECT_FACTS.toolchains.node;
  return process.versions.node === expected
    ? { name: "node", status: "ok", message: `Node ${process.versions.node}` }
    : { name: "node", status: "warning", message: `Node ${process.versions.node}; release runtime is pinned to ${expected}.` };
}

async function apiCheck(provider: "deepseek" | "glm", model: string, enabled: boolean): Promise<DoctorCheck> {
  if (!enabled) return { name: "api", status: "skipped", message: "Pass --check-api to verify the provider." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("API check timed out.")), 15_000);
  try {
    const result = await checkProviderHealth({
      provider,
      model,
      signal: controller.signal,
      requestTimeoutMs: 10_000
    });
    if (typeof result === "string") {
      return { name: "api", status: "ok", message: result };
    }
    return apiDoctorCheck(result);
  } catch (error) {
    return { name: "api", status: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function apiDoctorCheck(result: ProviderHealthReport): DoctorCheck {
  const details = `provider=${result.provider} model=${result.model} endpoint=${result.endpointHost} elapsed_ms=${result.latencyMs}`;
  return {
    name: "api",
    status: result.ok ? "ok" : "error",
    message: `${details}: ${result.message}`,
    provider: result.provider,
    model: result.model,
    endpoint_host: result.endpointHost,
    elapsed_ms: result.latencyMs,
    ...(result.failureKind ? { failure_kind: result.failureKind } : {}),
    ...(result.errorCategory ? { error_category: result.errorCategory } : {})
  };
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

async function executeDoctor(
  argv: string[],
  deps: DoctorDeps,
  stdout: NodeJS.WritableStream
): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = loadCliConfig(flags);
  const ownedBroker = deps.executionBroker ? undefined : (deps.createExecutionBroker?.() ?? new LazyExecutionBroker({
    sandboxMode: "required"
  }));
  try {
    const broker = deps.executionBroker ?? ownedBroker!;
    const checks: DoctorCheck[] = [nodeCheck(), await workspaceCheck(config.workspace), providerKeyCheck(config.provider)];
    const sandbox = await sandboxCheck(broker, config.workspace);
    checks.push(sandbox.check);
    checks.push(...languageServerChecks(deps.languageServers ?? discoverLanguageServers()));
    checks.push(await apiCheck(config.provider, config.model, flags["check-api"] === true));
    const strict = flags.strict === true;
    const outcome = reportStatus(checks, strict);
    const report = {
      doctorSchemaVersion: DOCTOR_REPORT_SCHEMA_VERSION,
      status: outcome.status,
      strict,
      ...(sandbox.report ? {
        protocolVersion: sandbox.report.protocolVersion,
        brokerVersion: sandbox.report.brokerVersion,
        platform: sandbox.report.platform,
        architecture: sandbox.report.architecture,
        sandbox: sandbox.report.sandbox,
        capabilities: sandbox.report.capabilities,
        workspaceLease: sandbox.lease ?? null,
        container: {
          available: false,
          backend: "oci",
          reason: "No OCI backend is installed in this Sigma build. Container mode fails with container_unavailable."
        }
      } : {}),
      checks
    };
    writeReport(stdout, report, checks, flags.json === true);
    return outcome.failed ? 1 : 0;
  } finally {
    await ownedBroker?.close();
  }
}

export async function runDoctorCommand(argv: string[], deps: DoctorDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write("agent doctor [--workspace <path>] [--check-api] [--strict] [--json]\n");
    return 0;
  }
  try {
    return await executeDoctor(argv, deps, stdout);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
