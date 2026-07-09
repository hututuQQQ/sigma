import { access } from "node:fs/promises";
import { createModelClient } from "agent-ai";
import { createDefaultSandboxAdapter, normalizeSandboxConfig, redactSecrets } from "agent-core";
import type { SandboxAvailability } from "agent-core";
import { loadCliConfig, parseArgs } from "../config.js";
import { maskSecret } from "../output.js";

type DoctorStatus = "ok" | "warning" | "error";
type DoctorCheckStatus = DoctorStatus | "skipped";

interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  recommendation?: string;
  detail?: unknown;
}

interface DoctorCommandDeps {
  stdout?: NodeJS.WritableStream;
}

function fallbackWarning(availability: { available: boolean; backend: string; reason?: string } | undefined, required: boolean): string | null {
  if (!availability || availability.available || required) return null;
  return `OS sandbox backend '${availability.backend}' is unavailable; commands will use policy-only checks because sandbox.required=false. Use --sandbox-required to fail closed.`;
}

function stdout(deps: DoctorCommandDeps): NodeJS.WritableStream {
  return deps.stdout ?? process.stdout;
}

function providerKeyStatus(provider: string): string {
  if (provider === "deepseek") {
    return `DEEPSEEK_API_KEY=${maskSecret(process.env.DEEPSEEK_API_KEY)}`;
  }
  return [
    `GLM_API_KEY=${maskSecret(process.env.GLM_API_KEY)}`,
    `ZAI_API_KEY=${maskSecret(process.env.ZAI_API_KEY)}`,
    `BIGMODEL_API_KEY=${maskSecret(process.env.BIGMODEL_API_KEY)}`
  ].join(" ");
}

function providerKeyStatusJson(provider: string): Record<string, string> {
  if (provider === "deepseek") {
    return { DEEPSEEK_API_KEY: maskSecret(process.env.DEEPSEEK_API_KEY) };
  }
  return {
    GLM_API_KEY: maskSecret(process.env.GLM_API_KEY),
    ZAI_API_KEY: maskSecret(process.env.ZAI_API_KEY),
    BIGMODEL_API_KEY: maskSecret(process.env.BIGMODEL_API_KEY)
  };
}

function providerKeyPresent(provider: string): boolean {
  if (provider === "deepseek") return Boolean(process.env.DEEPSEEK_API_KEY);
  return Boolean(process.env.GLM_API_KEY || process.env.ZAI_API_KEY || process.env.BIGMODEL_API_KEY);
}

function providerKeyCheck(provider: string): DoctorCheck {
  if (providerKeyPresent(provider)) {
    return {
      name: "provider_key",
      status: "ok",
      message: `Provider key is configured for ${provider}.`
    };
  }
  return {
    name: "provider_key",
    status: "warning",
    message: `Provider key is not configured for ${provider}.`,
    recommendation: provider === "deepseek"
      ? "Set DEEPSEEK_API_KEY before running against the live model."
      : "Set ZAI_API_KEY, GLM_API_KEY, or BIGMODEL_API_KEY before running against the live model."
  };
}

function workspaceCheck(accessible: boolean, workspacePath: string): DoctorCheck {
  return accessible
    ? { name: "workspace", status: "ok", message: `Workspace is accessible: ${workspacePath}` }
    : {
        name: "workspace",
        status: "error",
        message: `Workspace is not accessible: ${workspacePath}`,
        recommendation: "Create the workspace directory or pass --workspace with a valid path."
      };
}

function sandboxCheck(
  availability: SandboxAvailability | undefined,
  required: boolean,
  fallback: string | null
): DoctorCheck {
  if (!availability) {
    return {
      name: "sandbox",
      status: "warning",
      message: "Sandbox availability could not be checked.",
      recommendation: "Run with --sandbox-required in automation when OS isolation is mandatory."
    };
  }
  if (availability.available) {
    return {
      name: "sandbox",
      status: "ok",
      message: `Sandbox backend is available: ${availability.backend}.`,
      detail: availability
    };
  }
  if (required) {
    return {
      name: "sandbox",
      status: "error",
      message: `Sandbox backend is required but unavailable: ${availability.backend}.`,
      recommendation: availability.reason ?? "Install/configure the requested sandbox backend or use a supported backend.",
      detail: availability
    };
  }
  return {
    name: "sandbox",
    status: "warning",
    message: fallback ?? `Sandbox backend is unavailable: ${availability.backend}.`,
    recommendation: "Use --sandbox-required for fail-closed automation, or switch to a backend available on this OS.",
    detail: availability
  };
}

function apiCheck(requested: boolean, status: "skipped" | "ok" | "failed", message: string | null): DoctorCheck {
  if (!requested) {
    return {
      name: "api",
      status: "skipped",
      message: "API check was not requested.",
      recommendation: "Run agent doctor --check-api to verify live model connectivity."
    };
  }
  if (status === "ok") return { name: "api", status: "ok", message: `API check passed: ${message ?? "ok"}` };
  return {
    name: "api",
    status: "error",
    message: `API check failed: ${message ?? "unknown error"}`,
    recommendation: "Check provider credentials, model name, network access, and provider service status."
  };
}

function overallStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function checkLine(check: DoctorCheck): string {
  const recommendation = check.recommendation ? ` recommendation=${check.recommendation}` : "";
  return `check=${check.name} status=${check.status} message=${check.message}${recommendation}`;
}

function strictFlag(value: unknown): boolean {
  return value === true || value === "true";
}

export async function runDoctorCommand(argv: string[], deps: DoctorCommandDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(deps).write(`agent doctor [flags]

Check local Sigma configuration and product readiness.

Flags:
  --workspace <path>
  --provider <deepseek|glm>
  --model <name>
  --check-api
  --strict
  --json

Use --strict in CI or release checks to fail on warnings such as missing provider keys or sandbox fallback.
`);
    return 0;
  }
  const { flags } = parseArgs(argv);
  const config = loadCliConfig(flags);
  const json = flags.json !== undefined;
  const strict = strictFlag(flags.strict);
  const lines: string[] = [];
  let workspaceAccessible = true;
  const report = {
    status: "ok" as DoctorStatus,
    strict,
    node: process.version,
    workspace: {
      path: config.workspace,
      accessible: true
    },
    provider: config.provider,
    model: config.model ?? null,
    providerKeys: providerKeyStatusJson(config.provider),
    sandbox: {
      effective: normalizeSandboxConfig(config.workspace, config.sandbox),
      availability: await createDefaultSandboxAdapter().checkAvailability?.(config.sandbox, config.workspace),
      fallbackWarning: null as string | null
    },
    apiCheck: {
      requested: flags["check-api"] === true,
      status: "skipped" as "skipped" | "ok" | "failed",
      message: null as string | null
    },
    checks: [] as DoctorCheck[]
  };
  report.sandbox.fallbackWarning = fallbackWarning(report.sandbox.availability, report.sandbox.effective.required);

  lines.push(`readiness=pending strict=${strict}`);
  lines.push(`node=${process.version}`);
  lines.push(`provider=${config.provider}`);
  lines.push(`model=${config.model ?? "(provider default)"}`);
  lines.push(providerKeyStatus(config.provider));
  const sandboxAvailability = report.sandbox.availability;
  lines.push(
    `sandbox=${report.sandbox.effective.mode}/${report.sandbox.effective.backend}` +
      ` network=${report.sandbox.effective.network.mode}` +
      ` available=${sandboxAvailability?.available ?? false}` +
      `${sandboxAvailability?.reason ? ` reason=${sandboxAvailability.reason}` : ""}` +
      `${report.sandbox.fallbackWarning ? ` warning=${report.sandbox.fallbackWarning}` : ""}`
  );

  try {
    await access(config.workspace);
    lines.push(`workspace=${config.workspace}`);
  } catch {
    workspaceAccessible = false;
    report.workspace.accessible = false;
    lines.push(`workspace=${config.workspace} (not accessible)`);
  }

  if (flags["check-api"] === true) {
    try {
      const client = createModelClient(config.provider, { model: config.model });
      const response = await client.complete({
        messages: [
          { role: "system", content: "Reply with ok." },
          { role: "user", content: "ok?" }
        ],
        toolChoice: "none",
        maxTokens: 8,
        temperature: 0
      });
      lines.push(`api=ok (${response.message.content ?? "no content"})`);
      report.apiCheck.status = "ok";
      report.apiCheck.message = response.message.content ?? "no content";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`api=failed (${message})`);
      report.apiCheck.status = "failed";
      report.apiCheck.message = message;
    }
  }

  report.checks = [
    { name: "node", status: "ok", message: `Node runtime is available: ${process.version}` },
    workspaceCheck(workspaceAccessible, config.workspace),
    providerKeyCheck(config.provider),
    sandboxCheck(report.sandbox.availability, report.sandbox.effective.required, report.sandbox.fallbackWarning),
    apiCheck(flags["check-api"] === true, report.apiCheck.status, report.apiCheck.message)
  ];
  report.status = overallStatus(report.checks);
  lines[0] = `readiness=${report.status} strict=${strict}`;
  lines.push(...report.checks.map(checkLine));

  stdout(deps).write(json ? `${JSON.stringify(redactSecrets(report))}\n` : `${lines.join("\n")}\n`);
  if (report.status === "error") return 1;
  if (strict && report.status === "warning") return 1;
  return 0;
}
