import type { ModelToolCall, ToolReceipt } from "agent-protocol";
import { failed } from "./effect-helpers.js";
import { failureCode } from "./tool-transaction-support.js";
import type { RuntimeSession } from "./types.js";

const CAPABILITY_FAILURE_CODES = new Set([
  "filesystem_acl_unsupported", "external_read_required", "write_scope_invalid",
  "network_capability_unavailable", "network_unavailable", "toolchain_unavailable",
  "executable_unavailable",
  "container_unavailable", "sandbox_recovery_required", "sandbox_unavailable",
  "sandbox_recovery_failed"
]);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function capabilityFailureKey(code: string, call: ModelToolCall): string {
  return `${code}:${call.name}:${canonical(call.arguments)}`;
}

export function convergedToolFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  startedAt: string,
  error: unknown,
  signal: AbortSignal
): ToolReceipt {
  if ((error as { code?: unknown })?.code === "approval_needs_input") throw error;
  const code = failureCode(error, signal);
  if (CAPABILITY_FAILURE_CODES.has(code)) {
    const key = capabilityFailureKey(code, call);
    const attempts = (session.interaction.capabilityFailures.get(key) ?? 0) + 1;
    session.interaction.capabilityFailures.set(key, attempts);
    if (attempts >= 2) {
      return failed(
        call,
        startedAt,
        `Execution capability '${code}' failed twice. Runtime retries are exhausted; a weaker validation is not an acceptable substitute.`,
        "capability_retry_exhausted"
      );
    }
  }
  return failed(call, startedAt, error instanceof Error ? error.message : String(error), code);
}
