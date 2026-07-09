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

function cloneForJob(context: ToolExecutionContext, controller: AbortController): ToolExecutionContext {
  const parentSignal = context.abortSignal;
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  const onAbort = () => controller.abort(parentSignal?.reason ?? new Error("Parent run aborted."));
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    ...context,
    abortSignal: controller.signal,
    subagentJobManager: undefined
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

export class InMemorySubagentJobManager implements SubagentJobManager {
  private readonly jobs = new Map<string, InternalJob>();

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
    const jobContext = cloneForJob(context, controller);
    const execution: SubagentExecution = {
      request: { ...request, background: false },
      context: jobContext,
      options
    };
    const job: InternalJob = {
      summary: jobSummary,
      request: { ...request, background: true },
      context,
      options,
      controller,
      promise: Promise.resolve(jobSummary)
    };
    job.promise = (async () => {
      await emit(context, "subagent_progress", {
        job_id: jobId,
        status: "running",
        message: `Subagent ${request.subagentType} started.`
      });
      const report = attachJobFields(await runSubagent(execution), jobSummary);
      job.summary = {
        ...job.summary,
        status: controller.signal.aborted && report.status !== "ok" ? "interrupted" : settleStatus(report),
        updated_at: report.finished_at ?? nowIso(),
        report,
        ...(report.error ? { error: report.error } : {})
      };
      context.runState.subagentRuns = [...(context.runState.subagentRuns ?? []), report];
      await emit(context, "subagent_progress", {
        job_id: jobId,
        status: job.summary.status,
        report
      });
      return compactJob(job);
    })().catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      job.summary = {
        ...job.summary,
        status: controller.signal.aborted ? "interrupted" : "error",
        updated_at: nowIso(),
        error: message
      };
      await emit(context, "subagent_progress", {
        job_id: jobId,
        status: job.summary.status,
        error: message
      });
      return compactJob(job);
    });
    this.jobs.set(jobId, job);
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
    const timeout = new Promise<SubagentJobSummary>((resolve) => {
      setTimeout(() => resolve(compactJob(job)), Math.max(0, timeoutMs));
    });
    return await Promise.race([job.promise, timeout]);
  }

  async followup(jobId: string, prompt: string): Promise<SubagentJobSummary> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Subagent job not found: ${jobId}`);
    if (job.summary.status === "running") {
      job.summary = {
        ...job.summary,
        updated_at: nowIso()
      };
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
      if (job.summary.status === "running") job.controller.abort(new Error("closed"));
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
