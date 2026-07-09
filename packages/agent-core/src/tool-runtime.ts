import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "agent-ai";
import { truncateMiddle } from "./compaction.js";
import { isPathInside } from "./policy.js";
import type {
  AgentEvent,
  RegisteredTool,
  ThreadItem,
  ToolArtifactSummary,
  ToolArtifactInput,
  ToolExecutionContext,
  ToolProgressUpdate,
  ToolRegistry,
  ToolResult,
  ToolRisk,
  ToolRuntimeMetadata,
  ToolRuntimeSummary
} from "./types.js";
import {
  normalizeToolResult,
  toolAllMetadata,
  toolDescriptorFromDefinition,
  toolModelContent,
  toolModelMetadata
} from "./types.js";

const DEFAULT_PARALLEL_TOOL_LIMIT = 4;

export interface ToolRuntimeExecution<T> {
  call: ToolCall;
  index: number;
  result: ToolResult;
  value: T;
  metadata: Required<Pick<ToolRuntimeMetadata, "readOnly" | "supportsParallel">> & ToolRuntimeMetadata;
  startEventId?: string;
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
  const metadata = toolAllMetadata(result);
  return metadata.cancelled === true || metadata.aborted === true;
}

function abortReason(result: ToolResult): string {
  const metadata = toolAllMetadata(result);
  const reason = metadata.cancelReason ?? metadata.abortReason;
  return typeof reason === "string" && reason.trim() ? reason : "abort_signal";
}

function isAbortError(error: unknown, abortSignal?: AbortSignal): boolean {
  return abortSignal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function parallelToolLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PARALLEL_TOOL_LIMIT;
  return Math.max(1, Math.floor(value));
}

function artifactSafeName(toolName: string): string {
  return toolName.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 48) || "tool";
}

function displayArtifactPath(workspacePath: string, artifactPath: string): string {
  if (isPathInside(workspacePath, artifactPath)) {
    return path.relative(workspacePath, artifactPath).split(path.sep).join("/");
  }
  return path.resolve(artifactPath).split(path.sep).join("/");
}

function threadKind(tool: RegisteredTool | undefined): ThreadItem["kind"] {
  const descriptor = tool?.descriptor ?? (tool?.definition ? toolDescriptorFromDefinition(tool.definition, { risk: tool.risk, runtime: tool.runtime }) : undefined);
  const renderKind = descriptor?.ui?.renderKind;
  const name = descriptor?.model.function.name ?? tool?.definition.function.name;
  if (renderKind === "command" || name === "bash" || name === "shell_session" || name === "service") return "command_execution";
  if (descriptor?.ui?.group === "mcp") return "mcp_tool_call";
  return "dynamic_tool_call";
}

function threadItem(options: {
  item: RuntimeCall;
  status: ThreadItem["status"];
  title?: string;
  parentId?: string;
  result?: ToolResult;
  progress?: ToolProgressUpdate;
  artifacts?: ToolArtifactSummary[];
  resources?: ThreadItem["resources"];
}): ThreadItem {
  const now = new Date().toISOString();
  const toolName = options.item.call.function.name;
  return {
    id: options.parentId ?? `${options.item.call.id}:${options.status}`,
    kind: threadKind(options.item.tool),
    status: options.status,
    title: options.title ?? toolName,
    created_at: now,
    updated_at: now,
    parent_id: options.parentId,
    tool_call_id: options.item.call.id,
    tool_name: toolName,
    input: options.item.call.function.arguments,
    result: options.result,
    progress: options.progress,
    artifacts: options.artifacts,
    resources: options.resources
  };
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
        runtime: item.metadata,
        threadItem: threadItem({
          item,
          status: "queued",
          title: `${item.call.function.name} queued`,
          resources: item.tool?.descriptor?.permission?.resources
        })
      });
    }

    const executions = new Array<ToolRuntimeExecution<T>>(planned.length);
    let cursor = 0;
    const parallelLimit = parallelToolLimit(this.context.maxParallelToolCalls);
    while (cursor < planned.length) {
      const first = planned[cursor];
      if (first.metadata.supportsParallel) {
        const batch: RuntimeCall[] = [];
        while (cursor < planned.length && planned[cursor].metadata.supportsParallel && batch.length < parallelLimit) {
          batch.push(planned[cursor]);
          cursor += 1;
        }
        this.parallelBatches += 1;
        await callbacks.emit("tool_progress", {
          phase: "parallel_batch_start",
          size: batch.length,
          concurrencyLimit: parallelLimit,
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
        modelContent: "Tool call aborted before execution.",
        uiContent: "Tool call aborted before execution.",
        modelMetadata: { cancelled: true }
      };
      this.aborted += 1;
      await callbacks.emit("tool_aborted", {
        toolCallId: item.call.id,
        toolName: item.call.function.name,
        index: item.index,
        reason: "abort_signal",
        threadItem: threadItem({
          item,
          status: "aborted",
          title: `${item.call.function.name} aborted`,
          result
        })
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
      runtime: item.metadata,
      threadItem: threadItem({
        item,
        status: "running",
        title: `${item.call.function.name} running`,
        resources: item.tool?.descriptor?.permission?.resources
      })
    });
    const parentId = started?.id;
    let result: ToolResult;
    let value: T;
    let eventMetadata: Record<string, unknown> = {};
    const previousProgress = this.context.reportProgress;
    const previousCreateArtifact = this.context.createArtifact;
    const previousGroupResult = this.context.groupResult;
    this.context.reportProgress = async (update) => {
      await callbacks.emit("tool_progress", {
        toolCallId: item.call.id,
        toolName: item.call.function.name,
        index: item.index,
        progress: update,
        threadItem: threadItem({
          item,
          status: "running",
          parentId,
          progress: update
        })
      }, parentId);
      await previousProgress?.(update);
    };
    this.context.createArtifact = async (artifact) => {
      const summary = await this.writeArtifact(item.call, artifact);
      this.artifacts.push(summary);
      this.context.runState.toolArtifacts = [...(this.context.runState.toolArtifacts ?? []), summary];
      return summary;
    };
    this.context.groupResult = async (group) => {
      await previousGroupResult?.(group);
    };
    try {
      const executed = await callbacks.execute(item.call, item.metadata as ToolRuntimeExecution<T>["metadata"]);
      result = await this.applyOutputBudget(item.call, normalizeToolResult(executed.result), item.metadata);
      value = executed.value;
      eventMetadata = executed.eventMetadata ?? {};
    } catch (error) {
      const cancelled = isAbortError(error, this.context.abortSignal);
      result = {
        ok: false,
        modelContent: error instanceof Error ? error.message : String(error),
        ...(cancelled ? { modelMetadata: { cancelled: true, cancelReason: "abort_signal" } } : {})
      };
      value = undefined as T;
    } finally {
      this.context.reportProgress = previousProgress;
      this.context.createArtifact = previousCreateArtifact;
      this.context.groupResult = previousGroupResult;
    }
    result = normalizeToolResult(result);

    if (isAbortResult(result)) {
      this.aborted += 1;
      await callbacks.emit("tool_aborted", {
        toolCallId: item.call.id,
        toolName: item.call.function.name,
        index: item.index,
        reason: abortReason(result),
        threadItem: threadItem({
          item,
          status: "aborted",
          parentId,
          title: `${item.call.function.name} aborted`,
          result,
          artifacts: result.artifacts
        })
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
      artifact: toolModelMetadata(result).toolArtifact,
      threadItem: threadItem({
        item,
        status: result.ok ? "completed" : "failed",
        parentId,
        title: `${item.call.function.name} ${result.ok ? "completed" : "failed"}`,
        result,
        artifacts: result.artifacts,
        resources: result.actualResources
      })
    }, parentId);

    return {
      call: item.call,
      index: item.index,
      result,
      value,
      metadata: item.metadata,
      ...(parentId ? { startEventId: parentId } : {})
    };
  }

  private async applyOutputBudget(call: ToolCall, result: ToolResult, metadata: ToolRuntimeMetadata): Promise<ToolResult> {
    const budget = Math.max(1, Math.floor(metadata.outputBudget ?? this.context.maxToolOutputChars));
    const content = toolModelContent(result);
    if (content.length <= budget) return normalizeToolResult(result);
    const truncated = truncateMiddle(content, budget);
    const summary = await this.writeArtifact(call, {
      kind: "log",
      title: `${call.function.name} full output`,
      mimeType: "text/plain",
      content,
      extension: ".txt",
      modelVisible: false,
      preview: truncated.text
    }, truncated.text.length);
    this.artifacts.push(summary);
    this.context.runState.toolArtifacts = [...(this.context.runState.toolArtifacts ?? []), summary];
    const modelMetadata = {
      ...toolModelMetadata(result),
      truncated: true,
      toolArtifact: summary
    };
    return {
      ...result,
      modelContent: `${truncated.text}\n\n[Full output saved to ${summary.path}]`,
      uiContent: `${truncated.text}\n\n[Full output saved to ${summary.path}]`,
      modelMetadata,
      content: `${truncated.text}\n\n[Full output saved to ${summary.path}]`,
      metadata: modelMetadata,
      artifacts: [...(result.artifacts ?? []), summary]
    };
  }

  private async writeArtifact(call: ToolCall, input: ToolArtifactInput, retainedChars?: number): Promise<ToolArtifactSummary> {
    const runId = this.context.runId ?? "run";
    const artifactId = randomUUID();
    const artifactRoot = path.resolve(this.context.toolArtifactRootDir ?? path.join(this.context.workspacePath, ".agent", "artifacts"));
    const artifactDir = path.join(artifactRoot, runId);
    const extension = input.extension?.startsWith(".") ? input.extension : `.${input.extension ?? "txt"}`;
    const artifactPath = path.join(artifactDir, `${artifactSafeName(call.function.name)}-${artifactId}${extension}`);
    await mkdir(artifactDir, { recursive: true });
    const bytes = typeof input.content === "string" ? Buffer.byteLength(input.content, "utf8") : input.content.byteLength;
    await writeFile(artifactPath, input.content);
    const chars = typeof input.content === "string" ? input.content.length : bytes;
    return {
      id: artifactId,
      tool_call_id: call.id,
      tool_name: call.function.name,
      path: displayArtifactPath(this.context.workspacePath, artifactPath),
      absolute_path: path.resolve(artifactPath),
      bytes,
      original_chars: chars,
      retained_chars: retainedChars ?? Math.min(chars, input.preview?.length ?? chars),
      kind: input.kind ?? "text",
      title: input.title,
      mime_type: input.mimeType,
      preview: input.preview,
      model_visible: input.modelVisible === true
    };
  }
}
