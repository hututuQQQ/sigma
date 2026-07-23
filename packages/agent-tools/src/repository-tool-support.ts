import { createHash } from "node:crypto";
import path from "node:path";
import type {
  InputAccessEvidence,
  JsonValue,
  ToolCallPlan,
  ToolDescriptor,
  ToolExecutionContext,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";

export function objectArgument(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function textArgument(
  input: Record<string, JsonValue>,
  key: string,
  fallback = ""
): string {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`Tool argument '${key}' must be a string.`);
  return value;
}

export function integerArgument(
  input: Record<string, JsonValue>,
  key: string,
  fallback: number,
  maximum: number
): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Tool argument '${key}' must be a number.`);
  }
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

export function repositoryToolSchema(
  input: Omit<ToolDescriptor, "inputSchema"> & {
    properties: Record<string, JsonValue>;
    required?: string[];
  }
): ToolDescriptor {
  return {
    ...input,
    inputSchema: {
      type: "object",
      properties: input.properties,
      required: input.required ?? [],
      additionalProperties: false
    }
  };
}

export function repositoryToolResult(
  request: ToolRequest,
  startedAt: string,
  output: string,
  ok = true,
  diagnostics: string[] = [],
  artifacts: string[] = [],
  evidence: InputAccessEvidence[] = [],
  structuredResult?: JsonValue
): ToolReceipt {
  return {
    callId: request.callId,
    ok,
    output,
    ...(structuredResult === undefined ? {} : { result: structuredResult }),
    observedEffects: ["filesystem.read"],
    artifacts,
    diagnostics,
    evidence,
    startedAt,
    completedAt: new Date().toISOString()
  };
}

export function normalizedRepositoryAccessPath(value: string): string {
  const portable = value.replaceAll("\\", "/");
  const normalized = path.posix.normalize(portable);
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(value)
    || normalized === ".." || normalized.startsWith("../")) {
    throw Object.assign(new Error(`Repository provider returned an invalid access path: ${value}`), {
      code: "repository_access_path_invalid"
    });
  }
  return normalized === "" ? "." : normalized;
}

export function repositoryReadPlan(accessPath: string): ToolCallPlan {
  return {
    exactEffects: ["filesystem.read"],
    readPaths: [normalizedRepositoryAccessPath(accessPath)],
    writePaths: [],
    network: "none",
    processMode: "none",
    checkpointScope: [],
    idempotence: "read_only"
  };
}

export function structuredReadEvidence(
  request: ToolRequest,
  context: Pick<ToolExecutionContext, "sessionId" | "runId">,
  accessPath: string,
  output: string,
  summary: string
): InputAccessEvidence {
  const sha256 = createHash("sha256").update(output, "utf8").digest("hex");
  const byteLength = Buffer.byteLength(output, "utf8");
  return {
    evidenceId: `input-access:${request.callId}`,
    sessionId: context.sessionId,
    runId: context.runId,
    kind: "input_access",
    status: "passed",
    createdAt: new Date().toISOString(),
    producer: { authority: "tool", id: request.callId },
    summary,
    data: {
      path: normalizedRepositoryAccessPath(accessPath),
      scope: "workspace",
      sha256,
      byteLength
    }
  };
}
