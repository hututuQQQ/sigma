import type { AgentMessage } from "agent-ai";
import {
  compactErrorSummary,
  CompactionService,
  type CompactionArtifact,
  type CompactionRequest,
  type CompactionPlan,
  type CompactionResult,
  type CompactionServiceOptions,
  messageHistoryChars,
  planCompaction
} from "./compaction-service.js";
import type { ContextCompactionSummary } from "../types.js";

export interface ContextManagerOptions {
  compactionService?: CompactionService;
  compaction?: CompactionServiceOptions;
}

export interface PrepareMessagesRequest extends Omit<CompactionRequest, "messages"> {
  messages: AgentMessage[];
  emitEvent?: (event: ContextManagerEvent) => void | Promise<void>;
}

export interface PrepareMessagesResult extends CompactionResult {
  artifact: CompactionArtifact | null;
  snapshot: ContextSnapshot;
}

export interface ContextSnapshot {
  messageCount: number;
  messageChars: number;
  compaction: CompactionPlan;
}

export interface ContextManagerEvent {
  type: "context_compaction_start" | "context_compaction_end" | "context_compaction_error";
  metadata: ContextCompactionSummary;
}

export class ContextManager {
  private readonly compactionService: CompactionService;

  constructor(options: ContextManagerOptions = {}) {
    this.compactionService = options.compactionService ?? new CompactionService(options.compaction);
  }

  buildContextSnapshot(request: Pick<PrepareMessagesRequest, "messages" | "maxMessageHistoryChars" | "messageHistoryRetain">): ContextSnapshot {
    return {
      messageCount: request.messages.length,
      messageChars: messageHistoryChars(request.messages),
      compaction: planCompaction(request)
    };
  }

  async prepareMessages(request: PrepareMessagesRequest): Promise<PrepareMessagesResult> {
    const snapshot = this.buildContextSnapshot(request);
    return await this.maybeCompact(request, snapshot);
  }

  async maybeCompact(request: PrepareMessagesRequest, snapshot = this.buildContextSnapshot(request)): Promise<PrepareMessagesResult> {
    if (!snapshot.compaction.shouldCompact) {
      const result = await this.compactionService.compact(request);
      return { ...result, snapshot };
    }

    const startedAt = Date.now();
    const baseMetadata = (): ContextCompactionSummary => ({
      strategy: this.compactionService.strategyName,
      before_message_count: snapshot.compaction.beforeMessageCount,
      after_message_count: request.messages.length,
      compacted_message_count: snapshot.compaction.compactedMessageCount,
      fallback_used: false,
      duration_ms: Date.now() - startedAt
    });

    await this.recordContextEvents(request, {
      type: "context_compaction_start",
      metadata: baseMetadata()
    });

    try {
      const result = await this.compactionService.compact(request);
      const metadata: ContextCompactionSummary = {
        ...baseMetadata(),
        after_message_count: result.messages.length,
        fallback_used: result.fallbackUsed === true,
        ...(result.artifact ? { artifact: result.artifact } : {}),
        ...(result.error ? { error: result.error } : {})
      };
      if (result.error) {
        await this.recordContextEvents(request, {
          type: "context_compaction_error",
          metadata
        });
      }
      await this.recordContextEvents(request, {
        type: "context_compaction_end",
        metadata
      });
      return { ...result, snapshot };
    } catch (error) {
      const metadata: ContextCompactionSummary = {
        ...baseMetadata(),
        error: compactErrorSummary(error)
      };
      await this.recordContextEvents(request, {
        type: "context_compaction_error",
        metadata
      });
      throw error;
    }
  }

  async recordContextEvents(request: PrepareMessagesRequest, event: ContextManagerEvent): Promise<void> {
    await request.emitEvent?.(event);
  }
}
