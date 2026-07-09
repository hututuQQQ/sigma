import type { RegisteredTool, SubagentRunSummary, SubagentType, ToolExecutionContext, ToolResult } from "../types.js";
import { runSubagent } from "./subagent-runner.js";
import type { SubagentJobManager, SubagentRunRequest, SubagentRunnerOptions, SubagentToolOptions } from "./subagent-types.js";

interface SubtaskArgs {
  description?: unknown;
  prompt?: unknown;
  subagentType?: unknown;
  relatedFiles?: unknown;
  maxTurns?: unknown;
  maxOutputChars?: unknown;
  background?: unknown;
}

interface SubagentJobArgs {
  action?: unknown;
  jobId?: unknown;
  prompt?: unknown;
  reason?: unknown;
  timeoutSec?: unknown;
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
  return value === "investigator" || value === "reviewer" || value === "planner" ? value : null;
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
    return { error: "task subagentType must be investigator, reviewer, or planner" };
  }
  return {
    request: {
      description: parsed.description.trim(),
      prompt: parsed.prompt,
      subagentType: type,
      relatedFiles: stringArray(parsed.relatedFiles),
      maxTurns: optionalNumber(parsed.maxTurns),
      maxOutputChars: optionalNumber(parsed.maxOutputChars),
      background: parsed.background === true
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
  if (parsed.request.background === true) {
    if (context.subagentBackgroundEnabled === false || options.backgroundEnabled === false) {
      return { ok: false, content: "background subagents are disabled for this run" };
    }
    const manager = context.subagentJobManager as SubagentJobManager | undefined;
    if (!manager) return { ok: false, content: "background subagent job manager is unavailable" };
    const job = manager.create(parsed.request, context, options);
    return {
      ok: true,
      content: JSON.stringify({ subagent_job: job }, null, 2),
      metadata: { subagentJob: job }
    };
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
            subagentType: { type: "string", enum: ["investigator", "reviewer", "planner"] },
            relatedFiles: { type: "array", items: { type: "string" } },
            maxTurns: { type: "number" },
            maxOutputChars: { type: "number" },
            background: { type: "boolean" }
          },
          required: ["description", "prompt", "subagentType"],
          additionalProperties: false
        }
      }
    },
    execute: async (args, context) => await executeSubtaskTool(args, context, options),
    risk: "read",
    runtime: { readOnly: true, supportsParallel: false, approval: "auto", sandbox: "bypass" }
  };
}

function subagentJobAction(value: unknown): "list" | "wait" | "followup" | "interrupt" | "close" {
  if (value === "wait" || value === "followup" || value === "interrupt" || value === "close") return value;
  return "list";
}

function jobContent(value: unknown): string {
  return JSON.stringify({ subagent_job: value }, null, 2);
}

export function createSubagentJobTool(): RegisteredTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "subagent_job",
        description: "List, wait for, follow up, interrupt, or close read-only background Sigma subagent jobs.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "wait", "followup", "interrupt", "close"] },
            jobId: { type: "string" },
            prompt: { type: "string" },
            reason: { type: "string" },
            timeoutSec: { type: "number" }
          },
          required: ["action"],
          additionalProperties: false
        }
      }
    },
    execute: async (args, context) => {
      const manager = context.subagentJobManager as SubagentJobManager | undefined;
      if (!manager) return { ok: false, content: "subagent job manager is unavailable" };
      const parsed = (args && typeof args === "object" ? args : {}) as SubagentJobArgs;
      const action = subagentJobAction(parsed.action);
      try {
        if (action === "list") {
          const jobs = manager.list();
          return { ok: true, content: JSON.stringify({ subagent_jobs: jobs }, null, 2), metadata: { subagentJobs: jobs } };
        }
        const jobId = typeof parsed.jobId === "string" && parsed.jobId.trim() ? parsed.jobId.trim() : "";
        if (!jobId) return { ok: false, content: `subagent_job.${action} requires jobId` };
        if (action === "wait") {
          const timeoutMs = typeof parsed.timeoutSec === "number" && Number.isFinite(parsed.timeoutSec)
            ? Math.max(0, parsed.timeoutSec * 1000)
            : undefined;
          const job = await manager.wait(jobId, timeoutMs);
          if (!job) return { ok: false, content: `Subagent job not found: ${jobId}` };
          return {
            ok: true,
            content: jobContent(job),
            metadata: {
              subagentJob: job,
              ...(job.report ? { subagentRun: job.report } : {})
            }
          };
        }
        if (action === "followup") {
          if (typeof parsed.prompt !== "string" || parsed.prompt.trim().length === 0) {
            return { ok: false, content: "subagent_job.followup requires prompt" };
          }
          const job = await manager.followup(jobId, parsed.prompt);
          return { ok: true, content: jobContent(job), metadata: { subagentJob: job } };
        }
        if (action === "interrupt") {
          const job = await manager.interrupt(jobId, typeof parsed.reason === "string" ? parsed.reason : undefined);
          return { ok: true, content: jobContent(job), metadata: { subagentJob: job } };
        }
        const jobs = await manager.close(jobId);
        return { ok: true, content: JSON.stringify({ subagent_jobs: jobs }, null, 2), metadata: { subagentJobs: jobs } };
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    },
    risk: "read",
    runtime: { readOnly: true, supportsParallel: false, approval: "auto", sandbox: "bypass" }
  };
}
