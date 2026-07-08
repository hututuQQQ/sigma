import { describe, expect, it } from "vitest";
import type { AgentMessage, ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import {
  COMPACTION_MARKER,
  CompactionService,
  ContextManager,
  DeterministicCompactionStrategy,
  ModelSubSessionCompactionProvider,
  ModelSubSessionCompactionStrategy,
  type CompactionArtifact,
  type ContextManagerEvent
} from "../packages/agent-core/src/index.js";

function messagesWithHistory(): AgentMessage[] {
  return [
    { role: "system", content: "system rules" },
    { role: "user", content: "fix the project" },
    { role: "assistant", content: `old reasoning ${"a".repeat(1200)}` },
    { role: "tool", name: "bash", toolCallId: "old-tool", content: `old output ${"b".repeat(1200)}` },
    { role: "assistant", content: "recent decision" },
    { role: "tool", name: "bash", toolCallId: "recent-tool", content: "recent output" }
  ];
}

class CompactionJsonModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-compaction-model";
  readonly requests: ModelRequest[] = [];

  constructor(private readonly content: string) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    return { message: { role: "assistant", content: this.content } };
  }
}

describe("ContextManager compaction", () => {
  it("does not compact when history is below the threshold", async () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "hello" }
    ];
    const result = await new ContextManager().prepareMessages({
      messages,
      maxMessageHistoryChars: 10000
    });

    expect(result.compacted).toBe(false);
    expect(result.artifact).toBeNull();
    expect(result.messages).toBe(messages);
  });

  it("compacts while preserving the initial system/user messages", async () => {
    const messages = messagesWithHistory();
    const result = await new ContextManager().prepareMessages({
      messages,
      maxMessageHistoryChars: 500,
      messageHistoryRetain: 2,
      compactionSummaryChars: 600,
      objective: "fix the project"
    });

    expect(result.compacted).toBe(true);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[1]);
    expect(result.messages[2]).toMatchObject({ role: "user" });
    expect(result.messages[2].content).toContain(COMPACTION_MARKER);
  });

  it("keeps a retained tail without starting on an orphan tool message", async () => {
    const messages = messagesWithHistory();
    const result = await new ContextManager().prepareMessages({
      messages,
      maxMessageHistoryChars: 500,
      messageHistoryRetain: 3,
      compactionSummaryChars: 600
    });

    expect(result.messages.slice(3)).toEqual(messages.slice(4));
    expect(result.messages[3].role).toBe("assistant");
    expect(result.messages[4].role).toBe("tool");
  });

  it("generates a structured compaction artifact", async () => {
    const messages = messagesWithHistory();
    const result = await new ContextManager().prepareMessages({
      messages,
      maxMessageHistoryChars: 500,
      messageHistoryRetain: 2,
      objective: "ship the refactor",
      changedFiles: ["src/app.ts"],
      todos: [{ id: "1", text: "rerun tests", status: "pending" }],
      workflow: {
        phase: "repair",
        commands_tried: ["pnpm test"],
        changed_files: ["src/app.ts"],
        failure_patterns: [
          {
            category: "test_failure",
            count: 1,
            last_tool_name: "bash",
            last_command: "pnpm test",
            last_summary: "AssertionError"
          }
        ]
      },
      evidenceRecords: [
        {
          kind: "test",
          toolName: "bash",
          ok: false,
          executable: true,
          command: "pnpm test",
          summary: "AssertionError",
          exitCode: 1,
          timestamp: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    expect(result.artifact).toMatchObject({
      objective: "ship the refactor",
      changed_files: ["src/app.ts"],
      current_plan: ["pending: rerun tests"]
    });
    expect(result.artifact?.failed_attempts[0]).toContain("test_failure x1");
    expect(result.artifact?.validation_evidence[0]).toContain("failed: test");
    expect(result.artifact?.next_actions[0]).toContain("rerun tests");
  });

  it("keeps deterministic fallback output stable", async () => {
    const service = new CompactionService({ strategy: new DeterministicCompactionStrategy() });
    const request = {
      messages: messagesWithHistory(),
      maxMessageHistoryChars: 500,
      messageHistoryRetain: 2,
      compactionSummaryChars: 600,
      objective: "fix the project"
    };

    const first = await service.compact(request);
    const second = await service.compact(request);

    expect(first.messages).toEqual(second.messages);
    expect(first.artifact).toEqual(second.artifact);
  });

  it("allows model sub-session strategies to receive full compaction context", async () => {
    let capturedChangedFiles: string[] = [];
    const artifact: CompactionArtifact = {
      objective: "model objective",
      current_plan: ["plan"],
      changed_files: ["src/app.ts"],
      key_decisions: ["decision"],
      failed_attempts: ["failure"],
      validation_evidence: ["evidence"],
      unresolved_questions: [],
      next_actions: ["next"]
    };
    const service = new CompactionService({
      strategy: new ModelSubSessionCompactionStrategy({
        async compact(request) {
          capturedChangedFiles = request.changedFiles ?? [];
          expect(request.compactedMessages.length).toBeGreaterThan(0);
          expect(request.tailMessages.length).toBeGreaterThan(0);
          expect(request.traceTail).toBe("trace");
          return artifact;
        }
      })
    });

    const result = await service.compact({
      messages: messagesWithHistory(),
      maxMessageHistoryChars: 500,
      messageHistoryRetain: 2,
      changedFiles: ["src/app.ts"],
      traceTail: "trace"
    });

    expect(capturedChangedFiles).toEqual(["src/app.ts"]);
    expect(result.strategy).toBe("model_sub_session");
    expect(result.artifact).toEqual(artifact);
    expect(result.messages[2].content).toContain("Structured compaction artifact");
  });

  it("uses a real model sub-session provider with no tools", async () => {
    const model = new CompactionJsonModel(JSON.stringify({
      objective: "model objective",
      current_plan: ["keep going"],
      changed_files: ["src/app.ts"],
      key_decisions: ["decision"],
      failed_attempts: [],
      validation_evidence: ["pnpm test passed"],
      unresolved_questions: [],
      next_actions: ["verify"]
    }));
    const service = new CompactionService({
      strategy: new ModelSubSessionCompactionStrategy({
        provider: new ModelSubSessionCompactionProvider({ modelClient: model })
      })
    });

    const result = await service.compact({
      messages: messagesWithHistory(),
      maxMessageHistoryChars: 500,
      messageHistoryRetain: 2,
      objective: "fix the project"
    });

    expect(result.compacted).toBe(true);
    expect(result.fallbackUsed).toBe(false);
    expect(result.artifact?.objective).toBe("model objective");
    expect(model.requests[0]).toMatchObject({ tools: [], toolChoice: "none" });
    expect(model.requests[0].messages[1].content).toContain("compacted_message_history");
  });

  it("requires a provider for model_sub_session mode", () => {
    expect(() => new CompactionService({ mode: "model_sub_session" })).toThrow("requires a modelProvider");
  });

  it("falls back to deterministic compaction when model JSON is invalid", async () => {
    const model = new CompactionJsonModel("not json");
    const service = new CompactionService({
      strategy: new ModelSubSessionCompactionStrategy({
        provider: new ModelSubSessionCompactionProvider({ modelClient: model })
      })
    });

    const result = await service.compact({
      messages: messagesWithHistory(),
      maxMessageHistoryChars: 500,
      messageHistoryRetain: 2,
      objective: "fix the project"
    });

    expect(result.compacted).toBe(true);
    expect(result.strategy).toBe("model_sub_session");
    expect(result.fallbackUsed).toBe(true);
    expect(result.error).toContain("valid JSON");
    expect(result.messages[2].content).toContain(COMPACTION_MARKER);
  });

  it("falls back to deterministic compaction when the model provider throws", async () => {
    const service = new CompactionService({
      strategy: new ModelSubSessionCompactionStrategy({
        provider: {
          async compact() {
            throw new Error("provider exploded with sk-test-secret");
          }
        }
      })
    });

    const result = await service.compact({
      messages: messagesWithHistory(),
      maxMessageHistoryChars: 500,
      messageHistoryRetain: 2,
      objective: "fix the project"
    });

    expect(result.compacted).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.error).not.toContain("sk-test-secret");
    expect(result.artifact?.objective).toBe("fix the project");
  });

  it("records fallback error and end events when model compaction degrades", async () => {
    const events: ContextManagerEvent[] = [];
    const manager = new ContextManager({
      compactionService: new CompactionService({
        mode: "model_sub_session",
        modelProvider: {
          async compact() {
            throw new Error("provider exploded with sk-test-secret");
          }
        }
      })
    });

    const result = await manager.prepareMessages({
      messages: messagesWithHistory(),
      maxMessageHistoryChars: 500,
      messageHistoryRetain: 2,
      objective: "fix the project",
      emitEvent: (event) => events.push(event)
    });

    expect(result.fallbackUsed).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "context_compaction_start",
      "context_compaction_error",
      "context_compaction_end"
    ]);
    expect(events[1].metadata).toMatchObject({
      strategy: "model_sub_session",
      fallback_used: true,
      error: expect.stringContaining("provider exploded")
    });
    expect(events[1].metadata.error).not.toContain("sk-test-secret");
    expect(events[2].metadata).toMatchObject({ fallback_used: true });
  });

  it("throws and records an error event when compaction fallback is fail", async () => {
    const events: ContextManagerEvent[] = [];
    const manager = new ContextManager({
      compactionService: new CompactionService({
        mode: "model_sub_session",
        fallback: "fail",
        modelProvider: {
          async compact() {
            throw new Error("provider exploded");
          }
        }
      })
    });

    await expect(manager.prepareMessages({
      messages: messagesWithHistory(),
      maxMessageHistoryChars: 500,
      messageHistoryRetain: 2,
      objective: "fix the project",
      emitEvent: (event) => events.push(event)
    })).rejects.toThrow("Model compaction failed");

    expect(events.map((event) => event.type)).toEqual([
      "context_compaction_start",
      "context_compaction_error"
    ]);
    expect(events[1].metadata.error).toContain("Model compaction failed");
  });

  it("does not compact when compaction mode is off", async () => {
    const messages = messagesWithHistory();
    const service = new CompactionService({ mode: "off" });

    const result = await service.compact({
      messages,
      maxMessageHistoryChars: 1,
      messageHistoryRetain: 1
    });

    expect(result.compacted).toBe(false);
    expect(result.strategy).toBe("off");
    expect(result.messages).toBe(messages);
  });
});
