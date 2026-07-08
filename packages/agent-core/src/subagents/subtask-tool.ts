import type { RegisteredTool, SubagentRunSummary, SubagentType, ToolExecutionContext, ToolResult } from "../types.js";
import { runSubagent } from "./subagent-runner.js";
import type { SubagentRunRequest, SubagentRunnerOptions, SubagentToolOptions } from "./subagent-types.js";

interface SubtaskArgs {
  description?: unknown;
  prompt?: unknown;
  subagentType?: unknown;
  relatedFiles?: unknown;
  maxTurns?: unknown;
  maxOutputChars?: unknown;
  background?: unknown;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function subagentType(value: unknown): SubagentType | null {
  return value === "investigator" || value === "reviewer" ? value : null;
}

function parseRequest(args: unknown): { request?: SubagentRunRequest; error?: string } {
  const parsed = (args && typeof args === "object" ? args : {}) as SubtaskArgs;
  if (typeof parsed.description !== "string" || parsed.description.trim().length === 0) {
    return { error: "task requires a non-empty description" };
  }
  if (typeof parsed.prompt !== "string" || parsed.prompt.trim().length === 0) {
    return { error: "task requires a non-empty prompt" };
  }
  const type = subagentType(parsed.subagentType);
  if (!type) {
    return { error: "task subagentType must be investigator or reviewer" };
  }
  if (parsed.background === true) {
    return { error: "background subagents are not supported yet" };
  }
  return {
    request: {
      description: parsed.description.trim(),
      prompt: parsed.prompt,
      subagentType: type,
      relatedFiles: stringArray(parsed.relatedFiles),
      maxTurns: optionalNumber(parsed.maxTurns),
      maxOutputChars: optionalNumber(parsed.maxOutputChars),
      background: false
    }
  };
}

function contentFromReport(report: SubagentRunSummary): string {
  return JSON.stringify({ subagent_report: report }, null, 2);
}

export async function executeSubtaskTool(
  args: unknown,
  context: ToolExecutionContext,
  options: SubagentRunnerOptions
): Promise<ToolResult> {
  if (context.subagentsEnabled !== true) {
    return {
      ok: true,
      content: contentFromReport({
        id: "subagent-disabled",
        subagent_type: "investigator",
        description: "disabled",
        status: "error",
        summary: "Subagents are disabled for this run.",
        findings: [],
        relevant_files: [],
        validation_suggestions: [],
        risks: [],
        tool_calls: 0,
        duration_ms: 0,
        error: "Subagents are disabled for this run."
      }),
      metadata: { subagentRun: { status: "error", summary: "Subagents are disabled for this run." } }
    };
  }
  const parsed = parseRequest(args);
  if (parsed.error || !parsed.request) {
    return { ok: false, content: parsed.error ?? "invalid task request" };
  }
  const report = await runSubagent({ request: parsed.request, context, options });
  return {
    ok: true,
    content: contentFromReport(report),
    metadata: { subagentRun: report }
  };
}

export function createSubtaskTool(options: SubagentToolOptions): RegisteredTool {
  const toolName = options.toolName ?? "task";
  return {
    definition: {
      type: "function",
      function: {
        name: toolName,
        description:
          "Delegate a foreground read-only investigation or review to a constrained Sigma subagent. The subagent returns a compact JSON report and cannot modify files.",
        parameters: {
          type: "object",
          properties: {
            description: { type: "string" },
            prompt: { type: "string" },
            subagentType: { type: "string", enum: ["investigator", "reviewer"] },
            relatedFiles: { type: "array", items: { type: "string" } },
            maxTurns: { type: "number" },
            maxOutputChars: { type: "number" },
            background: { type: "boolean", enum: [false] }
          },
          required: ["description", "prompt", "subagentType"],
          additionalProperties: false
        }
      }
    },
    execute: async (args, context) => await executeSubtaskTool(args, context, options),
    risk: "read"
  };
}

