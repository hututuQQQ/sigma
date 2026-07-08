import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "agent-ai";
import { truncateMiddle } from "./compaction.js";
import type {
  AgentEvent,
  RegisteredTool,
  ToolArtifactSummary,
  ToolExecutionContext,
  ToolRegistry,
  ToolResult,
  ToolRisk,
  ToolRuntimeMetadata,
  ToolRuntimeSummary
} from "./types.js";

export interface ToolRuntimeExecution<T> {
  call: ToolCall;
  index: number;
  result: ToolResult;
  value: T;
  metadata: Required<Pick<ToolRuntimeMetadata, "readOnly" | "supportsParallel">> & ToolRuntimeMetadata;
}

export interface ToolRuntimeCallbacks<T> {
  execute(call: ToolCall, metadata: ToolRuntimeExecution<T>["metadata"]): Promise<{ result: ToolResult; value: T; eventMetadata?: Record<string, unknown> }>;
  emit(type: AgentEvent["type"], metadata: Record<string, unknown>, parentId?: string): Promise<AgentEvent | void>;
}

interface RuntimeCall {
  call: ToolCall;
  index: number;
  tool?: RegisteredTool;
  metadata: ToolRuntimeExecution<unknown>["metadata"];
}

function defaultRuntimeForRisk(risk: ToolRisk | undefined): Required<Pick<ToolRuntimeMetadata, "readOnly" | "supportsParallel">> & ToolRuntimeMetadata {
  const readOnly = risk === "read";
  return {
    readOnly,
    supportsParallel: readOnly,
    waitsForCancellation: false,
    approval: risk === "read" ? "auto" : "prompt",
    sandbox: "default"
  };
}

function mergeRuntimeMetadata(tool: RegisteredTool | undefined): RuntimeCall["metadata"] {
  const base = defaultRuntimeForRisk(tool?.risk);
  const runtime = tool?.runtime ?? {};
  const readOnly = runtime.readOnly ?? base.readOnly;
  return {
    ...base,
    ...runtime,
    readOnly,
    supportsParallel: runtime.supportsParallel ?? (readOnly && base.supportsParallel)
  };
}

function isAbortResult(result: ToolResult): boolean {
  return result.metadata?.cancelled === true || /cancelled|aborted/i.test(result.content);
}

function artifactSafeName(toolName: string): string {
  return toolName.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 48) || "tool";
}

export class ToolRuntime {
  private readonly artifacts: ToolArtifactSummary[] = [];
  private queued = 0;
  private started = 0;
  private completed = 0;
  private aborted = 0;
  private failed = 0;
  private parallelBatches = 0;
  private serialBatches = 0;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly context: ToolExecutionContext
  ) {}

  summary(): ToolRuntimeSummary {
    return {
      queued: this.queued,
      started: this.started,
      completed: this.completed,
      aborted: this.aborted,
      failed: this.failed,
      parallel_batches: this.parallelBatches,
      serial_batches: this.serialBatches,
      artifacts: [...this.artifacts]
    };
  }

  async executeBatch<T>(calls: ToolCall[], callbacks: ToolRuntimeCallbacks<T>): Promise<ToolRuntimeExecution<T>[]> {
    const planned = calls.map((call, index): RuntimeCall => {
      const tool = this.registry.getTool?.(call.function.name);
      return {
        call,
        index,
        tool,
        metadata: mergeRuntimeMetadata(tool)
      };
    });

    for (const item of planned) {
      this.queued += 1;
      await callbacks.emit("tool_queued", {
        toolCallId: item.call.id,
        toolName: item.call.function.name,
        index: item.index,
        runtime: item.metadata
      });
    }

    const executions = new Array<ToolRuntimeExecution<T>>(planned.length);
    let cursor = 0;
    while (cursor < planned.length) {
      const first = planned[cursor];
      if (first.metadata.supportsParallel) {
        const batch: RuntimeCall[] = [];
        while (cursor < planned.length && planned[cursor].metadata.supportsParallel) {
          batch.push(planned[cursor]);
          cursor += 1;
        }
        this.parallelBatches += 1;
        await callbacks.emit("tool_progress", {
          phase: "parallel_batch_start",
          size: batch.length,
          toolNames: batch.map((item) => item.call.function.name)
        });
        const batchResults = await Promise.all(batch.map((item) => this.executeOne(item, callbacks)));
        for (const result of batchResults) executions[result.index] = result;
      } else {
        this.serialBatches += 1;
        cursor += 1;
        executions[first.index] = await this.executeOne(first, callbacks);
      }
    }
    return executions;
  }

  private async executeOne<T>(item: RuntimeCall, callbacks: ToolRuntimeCallbacks<T>): Promise<ToolRuntimeExecution<T>> {
    if (this.context.abortSignal?.aborted) {
      const result: ToolResult = {
        ok: false,
        content: "Tool call aborted before execution.",
        metadata: { cancelled: true }
      };
      this.aborted += 1;
      await callbacks.emit("tool_aborted", {
        toolCallId: item.call.id,
        toolName: item.call.function.name,
        index: item.index,
        reason: "abort_signal"
      });
      return {
        call: item.call,
        index: item.index,
        result,
        value: undefined as T,
        metadata: item.metadata
      };
    }

    this.started += 1;
    const started = await callbacks.emit("tool_start", {
      toolCall: item.call,
      toolCallId: item.call.id,
      toolName: item.call.function.name,
      index: item.index,
      runtime: item.metadata
    });
    const parentId = started?.id;
    let result: ToolResult;
    let value: T;
    let eventMetadata: Record<string, unknown> = {};
    try {
      const executed = await callbacks.execute(item.call, item.metadata as ToolRuntimeExecution<T>["metadata"]);
      result = await this.applyOutputBudget(item.call, executed.result, item.metadata);
      value = executed.value;
      eventMetadata = executed.eventMetadata ?? {};
    } catch (error) {
      result = {
        ok: false,
        content: error instanceof Error ? error.message : String(error)
      };
      value = undefined as T;
    }

    if (isAbortResult(result)) {
      this.aborted += 1;
      await callbacks.emit("tool_aborted", {
        toolCallId: item.call.id,
        toolName: item.call.function.name,
        index: item.index,
        reason: result.content
      }, parentId);
    }
    if (result.ok) this.completed += 1;
    else this.failed += 1;

    await callbacks.emit("tool_end", {
      toolCallId: item.call.id,
      toolName: item.call.function.name,
      index: item.index,
      result,
      runtime: item.metadata,
      ...eventMetadata,
      artifact: result.metadata?.toolArtifact
    }, parentId);

    return {
      call: item.call,
      index: item.index,
      result,
      value,
      metadata: item.metadata
    };
  }

  private async applyOutputBudget(call: ToolCall, result: ToolResult, metadata: ToolRuntimeMetadata): Promise<ToolResult> {
    const budget = Math.max(1, Math.floor(metadata.outputBudget ?? this.context.maxToolOutputChars));
    if (result.content.length <= budget) return result;
    const runId = this.context.runId ?? "run";
    const artifactId = randomUUID();
    const artifactDir = path.join(this.context.workspacePath, ".agent", "artifacts", runId);
    const artifactPath = path.join(artifactDir, `${artifactSafeName(call.function.name)}-${artifactId}.txt`);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(artifactPath, result.content, "utf8");
    const truncated = truncateMiddle(result.content, budget);
    const summary: ToolArtifactSummary = {
      id: artifactId,
      tool_call_id: call.id,
      tool_name: call.function.name,
      path: path.relative(this.context.workspacePath, artifactPath).split(path.sep).join("/"),
      bytes: Buffer.byteLength(result.content, "utf8"),
      original_chars: result.content.length,
      retained_chars: truncated.text.length
    };
    this.artifacts.push(summary);
    this.context.runState.toolArtifacts = [...(this.context.runState.toolArtifacts ?? []), summary];
    return {
      ...result,
      content: `${truncated.text}\n\n[Full output saved to ${summary.path}]`,
      metadata: {
        ...result.metadata,
        truncated: true,
        toolArtifact: summary
      }
    };
  }
}
