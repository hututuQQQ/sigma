import type { AgentMessage } from "agent-ai";
import {
  CompactionService,
  type CompactionArtifact,
  type CompactionRequest,
  type CompactionResult,
  type CompactionServiceOptions
} from "./compaction-service.js";

export interface ContextManagerOptions {
  compactionService?: CompactionService;
  compaction?: CompactionServiceOptions;
}

export interface PrepareMessagesRequest extends Omit<CompactionRequest, "messages"> {
  messages: AgentMessage[];
}

export interface PrepareMessagesResult extends CompactionResult {
  artifact: CompactionArtifact | null;
}

export class ContextManager {
  private readonly compactionService: CompactionService;

  constructor(options: ContextManagerOptions = {}) {
    this.compactionService = options.compactionService ?? new CompactionService(options.compaction);
  }

  async prepareMessages(request: PrepareMessagesRequest): Promise<PrepareMessagesResult> {
    return await this.compactionService.compact(request);
  }
}
