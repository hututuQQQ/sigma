import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse, ToolCall } from "../packages/agent-ai/src/index.js";
import {
  AgentEventBus,
  InMemorySubagentJobManager,
  createDefaultToolRegistry,
  reviewAntiGamingDiff,
  runAgent,
  type AgentEvent,
  type ToolExecutionContext
} from "../packages/agent-core/src/index.js";

class SequenceModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-subagent-model";
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response;
  }
}

class DelayedSequenceModel extends SequenceModel {
  constructor(responses: ModelResponse[], private readonly delayMs: number) {
    super(responses);
  }

  override async complete(req: ModelRequest): Promise<ModelResponse> {
    await sleep(this.delayMs);
    return await super.complete(req);
  }
}

class AbortAwareHangingModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-hanging-subagent-model";
  readonly requests: ModelRequest[] = [];

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    return await new Promise<ModelResponse>((_resolve, reject) => {
      const abort = () => {
        const reason = req.abortSignal?.reason;
        reject(new Error(reason instanceof Error ? reason.message : "aborted"));
      };
      if (req.abortSignal?.aborted) {
        abort();
        return;
      }
      req.abortSignal?.addEventListener("abort", abort, { once: true });
    });
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function workspace(model: ModelClient): Promise<{ dir: string; context: ToolExecutionContext }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-subagents-"));
  return {
    dir,
    context: {
      workspacePath: dir,
      permissionMode: "yolo",
      commandTimeoutSec: 5,
      maxToolOutputChars: 12000,
      runState: { todos: [], nextTodoId: 1, changedFiles: new Set<string>(), contextIndexes: new Map<string, unknown>() },
      alwaysAllowTools: new Set<string>(),
      modelClient: model,
      subagentsEnabled: true,
      subagentBackgroundEnabled: true,
      subagentJobManager: new InMemorySubagentJobManager(),
      subagentDepth: 0
    }
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

function reportResponse(summary: string, relevantFiles: string[] = []): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: JSON.stringify({
        status: "ok",
        summary,
        evidence: ["observed requested files"],
        findings: [{ title: "finding", detail: summary, severity: "info" }],
        relevantFiles,
        validationSuggestions: ["run the focused project check"],
        risks: [],
        blockers: []
      })
    }
  };
}

describe("subagent task tool", () => {
  it("returns a structured foreground report and emits lifecycle events", async () => {
    const model = new SequenceModel([reportResponse("Located the parser entry point.", ["src/parser.ts"])]);
    const { context } = await workspace(model);
    const events: string[] = [];
    context.emitEvent = async (event) => {
      events.push(event.type);
    };
    const registry = createDefaultToolRegistry({ subagents: { enabled: true } });

    const result = await registry.execute(
      toolCall("task-1", "task", {
        description: "Find parser",
        prompt: "Locate the parser entry point",
        subagentType: "investigator",
        relatedFiles: ["src/parser.ts"]
      }),
      context
    );

    expect(result.ok).toBe(true);
    expect(result.metadata?.subagentRun).toMatchObject({
      status: "ok",
      subagent_type: "investigator",
      summary: "Located the parser entry point.",
      relevant_files: ["src/parser.ts"]
    });
    expect(events[0]).toBe("subagent_start");
    expect(events).toEqual(expect.arrayContaining(["subagent_progress", "subagent_end"]));
  });

  it("creates and waits for a read-only background subagent job", async () => {
    const model = new SequenceModel([reportResponse("Planned the work.", ["src/index.ts"])]);
    const { context } = await workspace(model);
    const events: string[] = [];
    context.emitEvent = async (event) => {
      events.push(event.type);
    };
    const registry = createDefaultToolRegistry({ subagents: { enabled: true, backgroundEnabled: true } });

    const created = await registry.execute(
      toolCall("task-bg", "task", {
        description: "Plan work",
        prompt: "Plan the implementation",
        subagentType: "planner",
        background: true
      }),
      context
    );
    const jobId = (created.metadata?.subagentJob as { job_id?: string } | undefined)?.job_id ?? "";
    const waited = await registry.execute(
      toolCall("wait-bg", "subagent_job", { action: "wait", jobId, timeoutSec: 2 }),
      context
    );

    expect(created.ok).toBe(true);
    expect(jobId).toBeTruthy();
    expect(waited.metadata?.subagentRun).toMatchObject({
      background: true,
      subagent_type: "planner",
      summary: "Planned the work.",
      evidence: ["observed requested files"],
      blockers: []
    });
    expect(events).toEqual(expect.arrayContaining(["subagent_job_created", "subagent_progress", "subagent_start", "subagent_end"]));
  });

  it("interrupts stalled background subagent jobs after the heartbeat timeout", async () => {
    const model = new AbortAwareHangingModel();
    const { context } = await workspace(model);
    const events: string[] = [];
    context.emitEvent = async (event) => {
      events.push(event.type);
    };
    const registry = createDefaultToolRegistry({
      subagents: { enabled: true, backgroundEnabled: true, heartbeatTimeoutSec: 0.03 }
    });

    const created = await registry.execute(
      toolCall("task-timeout", "task", {
        description: "Stalled background work",
        prompt: "Keep working until interrupted",
        subagentType: "investigator",
        background: true
      }),
      context
    );
    const jobId = (created.metadata?.subagentJob as { job_id?: string } | undefined)?.job_id ?? "";
    const waited = await registry.execute(
      toolCall("wait-timeout", "subagent_job", { action: "wait", jobId, timeoutSec: 1 }),
      context
    );

    expect(waited.ok).toBe(true);
    expect(waited.metadata?.subagentJob).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("heartbeat timeout")
    });
    expect(JSON.stringify(waited.metadata?.subagentJob)).toContain("heartbeat timeout");
    expect(context.runState.subagentRuns?.[0]).toMatchObject({
      job_id: jobId,
      status: "error",
      error: expect.stringContaining("heartbeat timeout")
    });
    expect(events).toEqual(expect.arrayContaining(["subagent_progress", "subagent_error"]));
  });

  it("does not let heartbeat timers rewrite completed background jobs", async () => {
    const model = new SequenceModel([reportResponse("Finished before the heartbeat timer.")]);
    const { context } = await workspace(model);
    const registry = createDefaultToolRegistry({
      subagents: { enabled: true, backgroundEnabled: true, heartbeatTimeoutSec: 0.03 }
    });

    const created = await registry.execute(
      toolCall("task-fast", "task", {
        description: "Fast background work",
        prompt: "Finish quickly",
        subagentType: "planner",
        background: true
      }),
      context
    );
    const jobId = (created.metadata?.subagentJob as { job_id?: string } | undefined)?.job_id ?? "";
    await expect(registry.execute(
      toolCall("wait-fast", "subagent_job", { action: "wait", jobId, timeoutSec: 1 }),
      context
    )).resolves.toMatchObject({
      ok: true,
      metadata: { subagentJob: expect.objectContaining({ status: "completed" }) }
    });

    await sleep(80);
    const listed = await registry.execute(toolCall("list-fast", "subagent_job", { action: "list" }), context);
    expect(JSON.stringify(listed.metadata?.subagentJobs)).toContain("\"status\":\"completed\"");
    expect(JSON.stringify(listed.metadata?.subagentJobs)).not.toContain("heartbeat timeout");
  });

  it("treats subagent_job.wait timeout as a wait-only timeout", async () => {
    const model = new DelayedSequenceModel([reportResponse("Finished after an early wait timeout.")], 80);
    const { context } = await workspace(model);
    const registry = createDefaultToolRegistry({
      subagents: { enabled: true, backgroundEnabled: true, heartbeatTimeoutSec: 5 }
    });

    const created = await registry.execute(
      toolCall("task-wait-timeout", "task", {
        description: "Delayed background work",
        prompt: "Finish after a short delay",
        subagentType: "reviewer",
        background: true
      }),
      context
    );
    const jobId = (created.metadata?.subagentJob as { job_id?: string } | undefined)?.job_id ?? "";
    const early = await registry.execute(
      toolCall("wait-short", "subagent_job", { action: "wait", jobId, timeoutSec: 0.01 }),
      context
    );
    const finished = await registry.execute(
      toolCall("wait-long", "subagent_job", { action: "wait", jobId, timeoutSec: 1 }),
      context
    );

    expect(early.metadata?.subagentJob).toMatchObject({ status: "running" });
    expect(finished.metadata?.subagentJob).toMatchObject({ status: "completed" });
    expect(JSON.stringify(finished.metadata?.subagentJob)).not.toContain("heartbeat timeout");
  });

  it("keeps reviewer subagents read-only even when the model asks for write", async () => {
    const model = new SequenceModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            toolCall("bad-write", "write", {
              path: "should-not-exist.txt",
              content: "nope",
              createDirs: true
            })
          ]
        }
      },
      reportResponse("The write tool was unavailable to the reviewer.")
    ]);
    const { dir, context } = await workspace(model);
    const events: AgentEvent[] = [];
    context.emitEvent = async (event) => {
      events.push(event);
    };
    const registry = createDefaultToolRegistry({ subagents: { enabled: true } });

    const result = await registry.execute(
      toolCall("review-1", "task", {
        description: "Review diff",
        prompt: "Check the diff",
        subagentType: "reviewer"
      }),
      context
    );

    expect(result.ok).toBe(true);
    await expect(readFile(path.join(dir, "should-not-exist.txt"), "utf8")).rejects.toThrow();
    expect(JSON.stringify(model.requests[1]?.messages ?? [])).toContain("Unknown tool: write");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "subagent_progress",
        metadata: expect.objectContaining({ phase: "tool_start", tool_name: "write" })
      }),
      expect.objectContaining({
        type: "subagent_progress",
        metadata: expect.objectContaining({ phase: "tool_end", tool_name: "write", ok: false })
      })
    ]));
  });

  it("forbids recursive subagent calls", async () => {
    const model = new SequenceModel([reportResponse("should not run")]);
    const { context } = await workspace(model);
    context.subagentDepth = 1;
    const registry = createDefaultToolRegistry({ subagents: { enabled: true } });

    const result = await registry.execute(
      toolCall("recursive-task", "subtask", {
        description: "Nested",
        prompt: "Try nesting",
        subagentType: "investigator"
      }),
      context
    );

    expect(result.ok).toBe(true);
    expect(result.metadata?.subagentRun).toMatchObject({ status: "error" });
    expect(JSON.stringify(result.metadata?.subagentRun)).toContain("Recursive subagent calls are disabled");
    expect(model.requests).toHaveLength(0);
  });

  it("records subagent runs in parent agent summaries", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-subagent-agent-"));
    const eventBus = new AgentEventBus();
    const events: string[] = [];
    eventBus.on((event) => events.push(event.type));
    const model = new SequenceModel([
      {
        message: {
          role: "assistant",
          toolCalls: [
            toolCall("task-from-agent", "task", {
              description: "Investigate tests",
              prompt: "Find related tests",
              subagentType: "investigator"
            })
          ]
        }
      },
      reportResponse("Found the focused tests.", ["tests/parser.test.ts"]),
      { message: { role: "assistant", content: "done" } }
    ]);

    const result = await runAgent({
      instruction: "delegate a read-only investigation",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      subagentsEnabled: true,
      eventBus
    });

    expect(result.status).toBe("completed");
    expect(result.toolsAvailable).toEqual(expect.arrayContaining(["task", "subtask"]));
    expect(result.subagentRuns?.[0]).toMatchObject({
      status: "ok",
      summary: "Found the focused tests.",
      relevant_files: ["tests/parser.test.ts"]
    });
    expect(events).toEqual(expect.arrayContaining(["subagent_start", "subagent_end"]));
  });
});

describe("anti-gaming review gate", () => {
  it("flags hardcoded task identity in product code", () => {
    const review = reviewAntiGamingDiff({
      diffText: [
        "diff --git a/packages/agent-core/src/solver.ts b/packages/agent-core/src/solver.ts",
        "--- a/packages/agent-core/src/solver.ts",
        "+++ b/packages/agent-core/src/solver.ts",
        "@@ -1,0 +1,2 @@",
        "+const task_id = \"benchmark-case-001\";",
        "+export const answer = task_id;"
      ].join("\n")
    });

    expect(review.status).toBe("blocked");
    expect(review.findings.map((finding) => finding.rule_id)).toContain("hardcoded-task-identity");
  });

  it("does not flag ordinary generic validation code", () => {
    const review = reviewAntiGamingDiff({
      diffText: [
        "diff --git a/packages/agent-core/src/validation/check.ts b/packages/agent-core/src/validation/check.ts",
        "--- a/packages/agent-core/src/validation/check.ts",
        "+++ b/packages/agent-core/src/validation/check.ts",
        "@@ -1,0 +1,3 @@",
        "+export function hasValidationCandidates(count: number): boolean {",
        "+  return count > 0;",
        "+}"
      ].join("\n")
    });

    expect(review.status).toBe("clean");
    expect(review.findings).toEqual([]);
  });

  it("allows external adapter paths to mention task fields without product-core findings", () => {
    const review = reviewAntiGamingDiff({
      diffText: [
        "diff --git a/scripts/bench-smoke.mjs b/scripts/bench-smoke.mjs",
        "--- a/scripts/bench-smoke.mjs",
        "+++ b/scripts/bench-smoke.mjs",
        "@@ -1,0 +1,2 @@",
        "+const task_id = \"adapter-smoke-case\";",
        "+console.log(task_id);"
      ].join("\n")
    });

    expect(review.status).toBe("clean");
  });
});
