import { access } from "node:fs/promises";
import { discoverLanguageServers, type LanguageServerPreset } from "agent-code-intel";
import { SIGMA_PROJECT_FACTS } from "agent-config";
import {
  AttestedContainerExecutionBroker,
  assertContainerExecutionConfig,
  ContainerUnavailableError,
  LazyExecutionBroker,
  loadFixedContainerLauncher,
  loadFixedOwnedContainerLauncher,
  type BrokerContainerReport,
  type ContainerExecutionConfig,
  type ExecutionBroker,
  type TrustedContainerLauncherV1
} from "agent-execution";
import { checkProviderHealth, type ProviderHealthReport } from "agent-model";
import { loadCliConfig, parseArgs, type CliConfig } from "../config.js";

export const DOCTOR_REPORT_SCHEMA_VERSION = 1 as const;

interface DoctorDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  executionBroker?: ExecutionBroker;
  createExecutionBroker?: () => ExecutionBroker;
  containerLauncher?: TrustedContainerLauncherV1;
  languageServers?: LanguageServerPreset[];
}

async function sandboxCheck(broker: ExecutionBroker, workspace: string): Promise<SandboxProbe> {
  try {
    // Socket-backed OCI brokers begin in `new` state and must complete their
    // authenticated hello/doctor handshake before ordinary doctor requests.
    const report = await broker.connect();
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

function configuredContainer(config: CliConfig): ContainerExecutionConfig {
  return {
    engine: config.containerEngine,
    target: config.containerTarget,
    network: config.networkMode,
    ...(config.containerImage ? { image: config.containerImage } : {})
  };
}

function assertOwnedContainerConfig(config: ContainerExecutionConfig | undefined): void {
  if (config?.target === "owned") assertContainerExecutionConfig(config);
}

async function doctorBroker(config: CliConfig, deps: DoctorDeps): Promise<{
  broker: ExecutionBroker;
  owned?: ExecutionBroker;
}> {
  const container = config.executionMode === "container" ? configuredContainer(config) : undefined;
  assertOwnedContainerConfig(container);
  const fixed = config.executionMode === "container"
    ? await (config.containerTarget === "managed"
        ? loadFixedContainerLauncher(config.workspace)
        : loadFixedOwnedContainerLauncher(config.workspace, config.containerEngine)
      ).catch((error: unknown) => {
        if ((error as { code?: unknown }).code === "container_unavailable") return undefined;
        throw error;
      })
    : undefined;
  const launcher = config.executionMode === "container" ? deps.containerLauncher ?? fixed : undefined;
  if (launcher && container) {
    assertContainerExecutionConfig(container, launcher.managedAttestation);
    const managed = launcher.managedAttestation;
    const broker = new AttestedContainerExecutionBroker(launcher.createBroker({
      workspace: config.workspace,
      config: container,
      ...(managed ? { managedAttestation: managed } : {})
    }), {
      config: container,
      ...(managed ? { managedAttestation: managed } : {})
    });
    return { broker, owned: broker };
  }
  if (config.executionMode === "container") {
    const unavailable = async (): Promise<never> => {
      throw new ContainerUnavailableError(
        "No trusted OCI launcher is installed; host execution is never used as a fallback."
      );
    };
    return {
      broker: {
        lostProcessHandles: [],
        connect: unavailable,
        doctor: unavailable,
        execute: unavailable,
        spawn: unavailable,
        poll: unavailable,
        write: unavailable,
        terminate: unavailable,
        close: async () => undefined
      }
    };
  }
  if (deps.executionBroker) return { broker: deps.executionBroker };
  const owned = deps.createExecutionBroker?.() ?? new LazyExecutionBroker({ sandboxMode: "required" });
  return { broker: owned, owned };
}

function containerProbe(config: CliConfig, report: BrokerDoctorReport | undefined): {
  report: BrokerContainerReport;
  check: DoctorCheck;
} {
  const container = report?.container ?? {
    available: false,
    backend: "oci",
    target: config.containerTarget,
    reason: "No trusted OCI launcher is installed; host execution is never used as a fallback."
  };
  const selected = config.executionMode === "container";
  return {
    report: container,
    check: {
      name: "container",
      status: !selected ? "skipped" : container.available ? "ok" : "error",
      message: container.available
        ? `${container.engine}/${container.target} target=${container.targetId} image=${container.imageDigest ?? container.imageId}`
        : container.reason ?? "OCI backend unavailable"
    }
  };
}

async function executeDoctor(
  argv: string[],
  deps: DoctorDeps,
  stdout: NodeJS.WritableStream
): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = loadCliConfig(flags);
  const selectedBroker = await doctorBroker(config, deps);
  try {
    const broker = selectedBroker.broker;
    const checks: DoctorCheck[] = [nodeCheck(), await workspaceCheck(config.workspace), providerKeyCheck(config.provider)];
    const sandbox = await sandboxCheck(broker, config.workspace);
    checks.push(sandbox.check);
    const container = containerProbe(config, sandbox.report);
    checks.push(container.check);
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
        workspaceLease: sandbox.lease ?? null
      } : {}),
      container: container.report,
      checks
    };
    writeReport(stdout, report, checks, flags.json === true);
    return outcome.failed ? 1 : 0;
  } finally {
    await selectedBroker.owned?.close();
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
