import { randomUUID } from "node:crypto";
import type { AgentEvent, SubagentRunSummary, ToolExecutionContext } from "../types.js";
import type {
  SubagentExecution,
  SubagentJobManager,
  SubagentJobStatus,
  SubagentJobSummary,
  SubagentRunRequest,
  SubagentRunnerOptions
} from "./subagent-types.js";
import { runSubagent } from "./subagent-runner.js";

interface InternalJob {
  summary: SubagentJobSummary;
  request: SubagentRunRequest;
  context: ToolExecutionContext;
  options: SubagentRunnerOptions;
  controller: AbortController;
  promise: Promise<SubagentJobSummary>;
  lastActivityAtMs: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  cleanup?: () => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function event(context: ToolExecutionContext, type: AgentEvent["type"], metadata: Record<string, unknown>): AgentEvent {
  return {
    id: randomUUID(),
    timestamp: nowIso(),
    type,
    runId: context.runId ?? "subagent-job",
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    provider: context.provider ?? context.modelClient?.provider,
    model: context.model ?? context.modelClient?.model,
    metadata
  };
}

async function emit(context: ToolExecutionContext, type: AgentEvent["type"], metadata: Record<string, unknown>): Promise<void> {
  await context.emitEvent?.(event(context, type, metadata));
}

function unrefTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

function cloneForJob(
  context: ToolExecutionContext,
  controller: AbortController,
  onActivity: () => void
): { context: ToolExecutionContext; cleanup: () => void } {
  const parentSignal = context.abortSignal;
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  const onAbort = () => controller.abort(parentSignal?.reason ?? new Error("Parent run aborted."));
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    cleanup: () => parentSignal?.removeEventListener("abort", onAbort),
    context: {
      ...context,
      abortSignal: controller.signal,
      subagentJobManager: undefined,
      emitEvent: async (agentEvent) => {
        onActivity();
        await context.emitEvent?.(agentEvent);
      }
    }
  };
}

function attachJobFields(report: SubagentRunSummary, job: SubagentJobSummary): SubagentRunSummary {
  const finishedAt = nowIso();
  return {
    ...report,
    job_id: job.job_id,
    background: true,
    started_at: report.started_at ?? job.created_at,
    finished_at: report.finished_at ?? finishedAt
  };
}

function settleStatus(report: SubagentRunSummary): SubagentJobStatus {
  return report.status === "ok" ? "completed" : "error";
}

function compactJob(job: InternalJob): SubagentJobSummary {
  return { ...job.summary };
}

function heartbeatTimeoutMs(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.floor(value * 1000));
}

function clearHeartbeat(job: InternalJob): void {
  if (!job.heartbeatTimer) return;
  clearInterval(job.heartbeatTimer);
  job.heartbeatTimer = undefined;
}

function touch(job: InternalJob): void {
  if (job.summary.status !== "running") return;
  job.lastActivityAtMs = Date.now();
  job.summary = {
    ...job.summary,
    updated_at: nowIso()
  };
}

function recordReport(context: ToolExecutionContext, report: SubagentRunSummary): void {
  const key = report.job_id ?? report.id;
  const exists = (item: SubagentRunSummary) => (item.job_id ?? item.id) === key;
  context.runState.subagentRuns = [...(context.runState.subagentRuns ?? []).filter((item) => !exists(item)), report];
}

function timeoutReport(job: InternalJob, message: string): SubagentRunSummary {
  const finishedAt = nowIso();
  const startedAt = job.summary.created_at;
  return {
    id: `subagent-job-${job.summary.job_id}`,
    job_id: job.summary.job_id,
    subagent_type: job.request.subagentType,
    description: job.request.description,
    status: "error",
    background: true,
    summary: message,
    findings: [],
    relevant_files: job.request.relatedFiles ?? [],
    evidence: [],
    validation_suggestions: [],
    risks: [],
    blockers: [message],
    tool_calls: job.summary.report?.tool_calls ?? 0,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    started_at: startedAt,
    finished_at: finishedAt,
    error: message
  };
}

export class InMemorySubagentJobManager implements SubagentJobManager {
  private readonly jobs = new Map<string, InternalJob>();

  private async timeoutJob(job: InternalJob, timeoutMs: number): Promise<void> {
    if (job.summary.status !== "running") return;
    const seconds = Math.max(0.001, timeoutMs / 1000);
    const message = `Subagent heartbeat timeout after ${seconds}s without activity.`;
    clearHeartbeat(job);
    job.cleanup?.();
    job.controller.abort(new Error(message));
    const report = timeoutReport(job, message);
    job.summary = {
      ...job.summary,
      status: "interrupted",
      updated_at: report.finished_at ?? nowIso(),
      report,
      error: message
    };
    recordReport(job.context, report);
    await emit(job.context, "subagent_progress", {
      job_id: job.summary.job_id,
      status: job.summary.status,
      error: message,
      report
    });
    await emit(job.context, "subagent_error", {
      job_id: job.summary.job_id,
      subagent_id: report.id,
      report
    });
  }

  private startHeartbeat(job: InternalJob): void {
    const timeoutMs = heartbeatTimeoutMs(job.options.heartbeatTimeoutSec);
    if (timeoutMs === null) return;
    const intervalMs = Math.max(1, Math.min(timeoutMs, 1000));
    job.heartbeatTimer = setInterval(() => {
      if (job.summary.status !== "running") {
        clearHeartbeat(job);
        return;
      }
      if (Date.now() - job.lastActivityAtMs < timeoutMs) return;
      void this.timeoutJob(job, timeoutMs).catch(() => undefined);
    }, intervalMs);
    unrefTimer(job.heartbeatTimer);
  }

  private finishJob(job: InternalJob, update: (job: InternalJob) => void): SubagentJobSummary {
    if (job.summary.status === "running") {
      clearHeartbeat(job);
      job.cleanup?.();
      update(job);
    }
    return compactJob(job);
  }

  create(request: SubagentRunRequest, context: ToolExecutionContext, options: SubagentRunnerOptions): SubagentJobSummary {
    const jobId = randomUUID();
    const createdAt = nowIso();
    const controller = new AbortController();
    const jobSummary: SubagentJobSummary = {
      job_id: jobId,
      status: "running",
      subagent_type: request.subagentType,
      description: request.description,
      background: true,
      created_at: createdAt,
      updated_at: createdAt
    };
    const job: InternalJob = {
      summary: jobSummary,
      request: { ...request, background: true },
      context,
      options,
      controller,
      promise: Promise.resolve(jobSummary),
      lastActivityAtMs: Date.now()
    };
    const cloned = cloneForJob(context, controller, () => touch(job));
    job.cleanup = cloned.cleanup;
    const execution: SubagentExecution = {
      request: { ...request, background: false },
      context: cloned.context,
      options
    };
    job.promise = (async () => {
      touch(job);
      await emit(context, "subagent_progress", {
        job_id: jobId,
        status: "running",
        message: `Subagent ${request.subagentType} started.`
      });
      const report = attachJobFields(await runSubagent(execution), jobSummary);
      const summary = this.finishJob(job, () => {
        job.summary = {
          ...job.summary,
          status: controller.signal.aborted && report.status !== "ok" ? "interrupted" : settleStatus(report),
          updated_at: report.finished_at ?? nowIso(),
          report,
          ...(report.error ? { error: report.error } : {})
        };
        recordReport(context, report);
      });
      await emit(context, "subagent_progress", {
        job_id: jobId,
        status: job.summary.status,
        report
      });
      return summary;
    })().catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const summary = this.finishJob(job, () => {
        job.summary = {
          ...job.summary,
          status: controller.signal.aborted ? "interrupted" : "error",
          updated_at: nowIso(),
          error: message
        };
      });
      await emit(context, "subagent_progress", {
        job_id: jobId,
        status: job.summary.status,
        error: message
      });
      return summary;
    });
    this.jobs.set(jobId, job);
    this.startHeartbeat(job);
    void emit(context, "subagent_job_created", { job: compactJob(job) });
    return compactJob(job);
  }

  list(): SubagentJobSummary[] {
    return [...this.jobs.values()].map(compactJob);
  }

  async wait(jobId: string, timeoutMs = 30000): Promise<SubagentJobSummary | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.summary.status !== "running") return compactJob(job);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SubagentJobSummary>((resolve) => {
      timer = setTimeout(() => resolve(compactJob(job)), Math.max(0, timeoutMs));
      unrefTimer(timer);
    });
    try {
      return await Promise.race([job.promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async followup(jobId: string, prompt: string): Promise<SubagentJobSummary> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Subagent job not found: ${jobId}`);
    if (job.summary.status === "running") {
      touch(job);
      await emit(job.context, "subagent_progress", {
        job_id: jobId,
        status: job.summary.status,
        message: "Follow-up recorded; running foreground subagent transcripts cannot be edited in place."
      });
      return compactJob(job);
    }

    const followupRequest: SubagentRunRequest = {
      ...job.request,
      prompt: [
        job.summary.report ? `Previous report:\n${JSON.stringify(job.summary.report)}` : "",
        "Follow-up:",
        prompt
      ].filter(Boolean).join("\n\n"),
      background: true
    };
    return this.create(followupRequest, job.context, job.options);
  }

  async interrupt(jobId: string, reason = "interrupted"): Promise<SubagentJobSummary> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Subagent job not found: ${jobId}`);
    if (job.summary.status === "running") {
      clearHeartbeat(job);
      job.cleanup?.();
      job.controller.abort(new Error(reason));
      job.summary = {
        ...job.summary,
        status: "interrupted",
        updated_at: nowIso(),
        error: reason
      };
      await emit(job.context, "subagent_progress", { job_id: jobId, status: "interrupted", error: reason });
    }
    return compactJob(job);
  }

  async close(jobId?: string): Promise<SubagentJobSummary[]> {
    const jobs = jobId ? [...(this.jobs.get(jobId) ? [this.jobs.get(jobId) as InternalJob] : [])] : [...this.jobs.values()];
    const closed: SubagentJobSummary[] = [];
    for (const job of jobs) {
      if (job.summary.status === "running") {
        clearHeartbeat(job);
        job.cleanup?.();
        job.controller.abort(new Error("closed"));
      }
      job.summary = {
        ...job.summary,
        status: "closed",
        updated_at: nowIso()
      };
      await emit(job.context, "subagent_job_closed", { job: compactJob(job) });
      closed.push(compactJob(job));
    }
    return closed;
  }
}
