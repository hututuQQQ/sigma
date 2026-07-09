import { randomUUID } from "node:crypto";
import type { JsonValue, RunOutcome, SupervisorPort, ToolEffect } from "agent-protocol";
import { AsyncMailbox } from "./mailbox.js";
import {
  WorkspaceIsolationManager,
  type ChildRunIntent,
  type ChildWorkspaceIsolation,
  type WorkspaceAllocation
} from "./workspace-isolation.js";

export interface ChildMessage {
  type: "follow_up" | "cancel";
  text?: string;
}

export interface ChildAgentContext {
  childId: string;
  parentId: string;
  instruction: string;
  intent: ChildRunIntent;
  workspacePath: string;
  sourceWorkspacePath: string;
  isolation: ChildWorkspaceIsolation;
  writeScope: string[];
  delegatedEffects: ToolEffect[];
  signal: AbortSignal;
  mailbox: AsyncIterable<ChildMessage>;
  metadata: JsonValue;
  started(sessionId: string): Promise<void>;
  notify(payload: JsonValue): Promise<void>;
}

export interface SpawnChildInput {
  parentId: string;
  instruction: string;
  workspacePath: string;
  intent?: ChildRunIntent;
  writeScope?: string[];
  delegatedEffects?: ToolEffect[];
  detached?: boolean;
  metadata?: JsonValue;
}

export interface ChildAgentResult {
  childId: string;
  outcome: RunOutcome;
  report: JsonValue;
}

export type ChildAgentFactory = (context: ChildAgentContext) => Promise<ChildAgentResult>;

export interface ChildSupervisorEvent {
  type: "child.spawned" | "child.message" | "child.completed";
  parentId: string;
  childId: string;
  payload: JsonValue;
}

export type ChildEventSink = (event: ChildSupervisorEvent) => Promise<void>;

export interface ChildJob {
  id: string;
  parentId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  detached: boolean;
  writeScope: string[];
  isolation?: ChildWorkspaceIsolation;
  sessionId?: string;
  result?: ChildAgentResult;
  error?: string;
}

interface InternalJob {
  public: ChildJob;
  input: SpawnChildInput;
  intent: ChildRunIntent;
  mailbox: AsyncMailbox<ChildMessage>;
  controller: AbortController;
  allocation?: WorkspaceAllocation;
  preparing: boolean;
  launched: boolean;
  settled: boolean;
  completion: Promise<ChildJob>;
  finish(value: ChildJob): void;
}

function intentOf(input: SpawnChildInput): ChildRunIntent {
  if (input.intent) return input.intent;
  if (input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) && input.metadata.mode === "change") {
    return "write";
  }
  return "analyze";
}

function cloneJob(job: ChildJob): ChildJob {
  return { ...job, writeScope: [...job.writeScope], isolation: job.isolation ? { ...job.isolation } : undefined };
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export class AgentSupervisor implements SupervisorPort {
  private readonly jobs = new Map<string, InternalJob>();
  private running = 0;

  constructor(
    private readonly factory: ChildAgentFactory,
    private readonly maxConcurrency = 4,
    private readonly isolationManager = new WorkspaceIsolationManager(),
    private readonly eventSink?: ChildEventSink
  ) {
    if (maxConcurrency < 1) throw new Error("Supervisor concurrency must be positive.");
  }

  spawn(input: SpawnChildInput): ChildJob {
    const internal = this.createJob(input);
    void this.publish(internal, "child.spawned", this.spawnPayload(internal))
      .catch((error) => { internal.public.error = error instanceof Error ? error.message : String(error); });
    void this.prepare(internal);
    return cloneJob(internal.public);
  }

  async spawnDurable(input: SpawnChildInput): Promise<ChildJob> {
    const internal = this.createJob(input);
    try {
      await this.publish(internal, "child.spawned", this.spawnPayload(internal));
    } catch (error) {
      internal.preparing = false;
      internal.public.status = "failed";
      internal.public.error = error instanceof Error ? error.message : String(error);
      this.complete(internal);
      throw error;
    }
    void this.prepare(internal);
    return cloneJob(internal.public);
  }

  private createJob(input: SpawnChildInput): InternalJob {
    const id = randomUUID();
    const mailbox = new AsyncMailbox<ChildMessage>();
    const controller = new AbortController();
    const job: ChildJob = {
      id,
      parentId: input.parentId,
      status: "queued",
      detached: input.detached === true,
      writeScope: [...(input.writeScope ?? [])]
    };
    let finish!: (value: ChildJob) => void;
    const completion = new Promise<ChildJob>((resolve) => { finish = resolve; });
    const internal: InternalJob = {
      public: job,
      input,
      intent: intentOf(input),
      mailbox,
      controller,
      preparing: true,
      launched: false,
      settled: false,
      completion,
      finish
    };
    this.jobs.set(id, internal);
    return internal;
  }

  private spawnPayload(job: InternalJob): JsonValue {
    return {
      instruction: job.input.instruction,
      intent: job.intent,
      writeScope: job.public.writeScope,
      delegatedEffects: job.input.delegatedEffects ?? [],
      detached: job.public.detached
    };
  }

  followUp(childId: string, text: string): void {
    const job = this.required(childId);
    if (job.public.status !== "running") throw new Error(`Child ${childId} is not running.`);
    job.mailbox.send({ type: "follow_up", text });
  }

  cancel(childId: string, reason = "parent cancelled child"): void {
    const job = this.required(childId);
    if (job.public.status === "completed" || job.public.status === "failed" || job.public.status === "cancelled") return;
    if (job.public.status === "queued") {
      job.public.status = "cancelled";
      job.controller.abort(new Error(reason));
      job.mailbox.close();
      if (job.allocation) {
        void job.allocation.release().then((isolation) => {
          job.public.isolation = isolation;
          this.complete(job);
        });
      } else if (!job.preparing) this.complete(job);
      return;
    }
    try {
      job.mailbox.send({ type: "cancel", text: reason });
    } finally {
      job.controller.abort(new Error(reason));
    }
  }

  cancelParent(parentId: string, reason = "parent cancelled children"): void {
    for (const job of this.jobs.values()) {
      if (job.public.parentId === parentId && !job.public.detached) this.cancel(job.public.id, reason);
    }
  }

  async join(childId: string): Promise<ChildJob> {
    return await this.required(childId).completion;
  }

  async joinParent(parentId: string, signal?: AbortSignal): Promise<ChildJob[]> {
    const jobs = [...this.jobs.values()].filter((job) => job.public.parentId === parentId && !job.public.detached);
    if (!signal) return await Promise.all(jobs.map((job) => job.completion));
    return await new Promise<ChildJob[]>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        const message = signal.reason instanceof Error ? signal.reason.message : "Parent run was cancelled.";
        for (const job of jobs) {
          try {
            this.cancel(job.public.id, message);
          } catch {
            job.controller.abort(signal.reason ?? new Error(message));
          }
        }
        reject(signal.reason ?? new Error(message));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      void Promise.all(jobs.map((job) => job.completion)).then((completed) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(completed);
      });
    });
  }

  async integrate(childId: string, signal?: AbortSignal): Promise<ChildJob> {
    const job = this.required(childId);
    await job.completion;
    if (job.public.status !== "completed" || !job.public.isolation) {
      throw new Error(`Child ${childId} did not complete successfully and cannot be integrated.`);
    }
    job.public.isolation = await this.isolationManager.integrateWorktree(job.public.isolation, job.public.writeScope, signal);
    await this.publish(job, "child.message", jsonValue({ kind: "integrated", isolation: job.public.isolation }));
    return cloneJob(job.public);
  }

  list(parentId?: string): ChildJob[] {
    return [...this.jobs.values()]
      .filter((job) => !parentId || job.public.parentId === parentId)
      .map((job) => cloneJob(job.public));
  }

  private required(id: string): InternalJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown child '${id}'.`);
    return job;
  }

  private async prepare(job: InternalJob): Promise<void> {
    try {
      const allocation = await this.isolationManager.allocate({
        childId: job.public.id,
        workspacePath: job.input.workspacePath,
        intent: job.intent,
        signal: job.controller.signal
      });
      job.preparing = false;
      job.allocation = allocation;
      job.public.isolation = { ...allocation.isolation };
      if (job.controller.signal.aborted || job.public.status === "cancelled") {
        job.public.isolation = await allocation.release();
        this.complete(job);
        return;
      }
      this.schedule();
    } catch (error) {
      job.preparing = false;
      job.public.status = job.controller.signal.aborted ? "cancelled" : "failed";
      if (!job.controller.signal.aborted) job.public.error = error instanceof Error ? error.message : String(error);
      this.complete(job);
    }
  }

  private schedule(): void {
    while (this.running < this.maxConcurrency) {
      const next = [...this.jobs.values()].find((job) =>
        job.public.status === "queued" && !job.launched && job.allocation !== undefined
      );
      if (!next) return;
      this.run(next);
    }
  }

  private run(job: InternalJob): void {
    const allocation = job.allocation!;
    job.launched = true;
    job.public.status = "running";
    this.running += 1;
    void this.factory({
      childId: job.public.id,
      parentId: job.input.parentId,
      instruction: job.input.instruction,
      intent: job.intent,
      workspacePath: allocation.workspacePath,
      sourceWorkspacePath: allocation.isolation.sourceWorkspacePath,
      isolation: allocation.isolation,
      writeScope: job.public.writeScope,
      delegatedEffects: [...(job.input.delegatedEffects ?? [])],
      signal: job.controller.signal,
      mailbox: job.mailbox,
      metadata: job.input.metadata ?? null,
      started: async (sessionId) => {
        job.public.sessionId = sessionId;
        await this.publish(job, "child.message", { kind: "started", sessionId });
      },
      notify: async (payload) => await this.publish(job, "child.message", payload)
    }).then(
      (result) => {
        job.public.result = result;
        job.public.status = result.outcome.kind === "completed" ? "completed"
          : result.outcome.kind === "cancelled" ? "cancelled" : "failed";
      },
      (error) => {
        job.public.status = job.controller.signal.aborted ? "cancelled" : "failed";
        job.public.error = error instanceof Error ? error.message : String(error);
      }
    ).finally(async () => {
      job.mailbox.close();
      job.public.isolation = await allocation.release();
      this.running -= 1;
      await this.publish(job, "child.completed", jsonValue({
        status: job.public.status,
        outcome: job.public.result?.outcome ?? null,
        isolation: job.public.isolation ?? null,
        error: job.public.error ?? null
      })).catch((error) => { job.public.error = error instanceof Error ? error.message : String(error); });
      this.complete(job);
      this.schedule();
    });
  }

  private complete(job: InternalJob): void {
    if (job.settled) return;
    job.settled = true;
    job.finish(cloneJob(job.public));
  }

  private async publish(job: InternalJob, type: ChildSupervisorEvent["type"], payload: JsonValue): Promise<void> {
    if (!this.eventSink) return;
    await this.eventSink({ type, parentId: job.public.parentId, childId: job.public.id, payload });
  }
}
