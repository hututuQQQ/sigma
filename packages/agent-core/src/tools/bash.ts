import type { ToolExecutionContext, ToolResult } from "../types.js";
import { truncateMiddle } from "../compaction.js";
import { isProbablyMutatingCommand, requestToolPermission, resolveWorkspacePath } from "../policy.js";
import { runBashCommand } from "../command-runner.js";

interface BashArgs {
  command?: unknown;
  cwd?: unknown;
  timeoutSec?: unknown;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatOutput(exitCode: number | null, stdout: string, stderr: string, timedOut: boolean, cancelled?: boolean): string {
  const parts = [`exitCode: ${exitCode === null ? "null" : exitCode}`];
  if (timedOut) parts.push("timedOut: true");
  if (cancelled) parts.push("cancelled: true");
  parts.push("stdout:");
  parts.push(stdout);
  parts.push("stderr:");
  parts.push(stderr);
  return parts.join("\n");
}

function looksLikeLongRunningServerCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
  const patterns = [
    /(?:^|[;&|()]\s*)(?:npm|pnpm|yarn|bun) (?:run )?dev(?:\s|$)/,
    /(?:^|[;&|()]\s*)(?:npx )?vite(?:\s|$)/,
    /(?:^|[;&|()]\s*)(?:npm exec |pnpm exec |yarn )?vite(?:\s|$)/,
    /(?:^|[;&|()]\s*)(?:npx )?next dev(?:\s|$)/,
    /(?:^|[;&|()]\s*)(?:npx )?astro dev(?:\s|$)/,
    /(?:^|[;&|()]\s*)(?:npx )?nuxt dev(?:\s|$)/
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

export async function executeBashTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as BashArgs;
  const command = typeof parsed.command === "string" ? parsed.command : "";
  if (!command.trim()) {
    return { ok: false, content: "bash requires a non-empty command string" };
  }

  if (looksLikeLongRunningServerCommand(command)) {
    return {
      ok: false,
      content:
        "This looks like a long-running dev server command. Use service.start instead of bash so the run can continue after the server is ready.",
      metadata: { blockedReason: "long_running_service_command" }
    };
  }

  if (isProbablyMutatingCommand(command)) {
    const denied = await requestToolPermission(context, {
      toolName: "bash",
      arguments: args,
      risk: "execute",
      reason: `Command appears to mutate files, install packages, change git state, or execute arbitrary code: ${command}`
    });
    if (denied) return denied;
  }

  let cwd: string;
  try {
    cwd = typeof parsed.cwd === "string" ? resolveWorkspacePath(context.workspacePath, parsed.cwd) : context.workspacePath;
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  const timeoutSec = asNumber(parsed.timeoutSec) ?? context.commandTimeoutSec;
  const timeoutMs = Math.max(1, Math.floor(timeoutSec * 1000));
  const result = await runBashCommand({
    command,
    cwd,
    env: process.env,
    timeoutMs,
    abortSignal: context.abortSignal
  });

  if (result.error) {
    return {
      ok: false,
      content: `Failed to start bash: ${result.error.message}`,
      metadata: {
        durationMs: result.durationMs,
        settledOn: result.settledOn,
        signal: result.signal,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        truncated: false
      }
    };
  }

  const content = formatOutput(
    result.exitCode,
    result.stdout.toString("utf8"),
    result.stderr.toString("utf8"),
    result.timedOut,
    result.cancelled
  );
  const truncated = truncateMiddle(content, context.maxToolOutputChars);
  return {
    ok: !result.timedOut && !result.cancelled && result.exitCode === 0,
    content: truncated.text,
    metadata: {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutBytes: result.stdout.byteLength,
      stderrBytes: result.stderr.byteLength,
      truncated: truncated.truncated,
      settledOn: result.settledOn,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled
    }
  };
}
