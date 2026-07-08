import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import {
  ContextManager,
  DEFAULT_COMPACTION_MODE,
  DEFAULT_FINAL_EVIDENCE_MODE,
  DEFAULT_MAX_MESSAGE_HISTORY_CHARS,
  DEFAULT_SUBAGENTS_ENABLED,
  runConfiguredAgent,
  type AgentRunConfig,
  type ToolRegistry
} from "../packages/agent-core/src/index.js";

class SequenceModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(
    private readonly responses: ModelResponse[],
    readonly model = "fake-run-configured-model",
    private readonly compactionResponse: ModelResponse = { message: { role: "assistant", content: "not json" } }
  ) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    if (req.toolChoice === "none") return this.compactionResponse;
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response;
  }
}

function finalResponse(content = "done"): ModelResponse {
  return { message: { role: "assistant", content } };
}

function toolResponse(id: string, name = "big_output"): ModelResponse {
  return {
    message: {
      role: "assistant",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name, arguments: {} }
        }
      ]
    }
  };
}

function bigOutputRegistry(): ToolRegistry {
  return {
    definitions: [
      {
        type: "function",
        function: {
          name: "big_output",
          description: "Return a large deterministic payload for context compaction tests.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false
          }
        }
      }
    ],
    async execute() {
      return { ok: true, content: "X".repeat(6000), metadata: {} };
    }
  };
}

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sigma-run-configured-"));
}

describe("runConfiguredAgent direct API defaults", () => {
  it("defaults into the harness and passes resolved run defaults", async () => {
    const dir = await tempWorkspace();
    const model = new SequenceModel([finalResponse("all set")]);
    let capturedConfig: AgentRunConfig | undefined;

    const { result } = await runConfiguredAgent({
      instruction: "summarize the empty workspace",
      workspacePath: dir,
      provider: "deepseek",
      modelClient: model,
      permissionMode: "yolo",
      durableSession: false,
      contextManagerFactory: ({ config, compactionService }) => {
        capturedConfig = config;
        return new ContextManager({ compactionService });
      }
    });

    expect(result.status).toBe("completed");
    expect(result.harness?.attempts).toHaveLength(1);
    expect(result.validationPlan?.candidates).toEqual([]);
    expect(result.validationPlan?.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: expect.stringContaining("No changed files or configured validation commands")
        })
      ])
    );
    expect(result.reviewFindings?.[0]).toMatchObject({ gate: "anti_gaming", status: "clean" });
    expect(capturedConfig).toMatchObject({
      compactionMode: DEFAULT_COMPACTION_MODE,
      finalEvidenceMode: DEFAULT_FINAL_EVIDENCE_MODE,
      maxMessageHistoryChars: DEFAULT_MAX_MESSAGE_HISTORY_CHARS,
      reviewAntiGaming: true,
      subagentsEnabled: DEFAULT_SUBAGENTS_ENABLED
    });
  });

  it("defaults compaction to model_sub_session and reuses the main model client", async () => {
    const dir = await tempWorkspace();
    const model = new SequenceModel([toolResponse("big-1"), toolResponse("big-2"), finalResponse("done")]);

    const { result } = await runConfiguredAgent({
      instruction: "keep concise notes",
      workspacePath: dir,
      provider: "deepseek",
      modelClient: model,
      permissionMode: "yolo",
      durableSession: false,
      validationMode: "off",
      finalEvidenceMode: "off",
      maxTurns: 3,
      maxMessageHistoryChars: 1000,
      messageHistoryRetain: 2,
      compactionSummaryChars: 500,
      toolRegistry: bigOutputRegistry()
    });

    expect(result.status).toBe("completed");
    expect(model.requests.some((request) => request.toolChoice === "none")).toBe(true);
    expect(result.contextCompactions?.[0]).toMatchObject({
      strategy: "model_sub_session",
      fallback_used: true
    });
  });

  it("defaults subagents on for direct runs", async () => {
    const dir = await tempWorkspace();

    const { result } = await runConfiguredAgent({
      instruction: "summarize the empty workspace",
      workspacePath: dir,
      provider: "deepseek",
      modelClient: new SequenceModel([finalResponse("all set")]),
      permissionMode: "yolo",
      durableSession: false,
      validationMode: "off",
      finalEvidenceMode: "off"
    });

    expect(result.status).toBe("completed");
    expect(result.toolsAvailable).toEqual(expect.arrayContaining(["task", "subtask"]));
  });

  it("honors explicit off and deterministic overrides", async () => {
    const offDir = await tempWorkspace();
    const { result: offResult } = await runConfiguredAgent({
      instruction: "summarize the empty workspace",
      workspacePath: offDir,
      provider: "deepseek",
      modelClient: new SequenceModel([finalResponse("all set")]),
      permissionMode: "yolo",
      durableSession: false,
      validationMode: "off",
      finalEvidenceMode: "off",
      subagentsEnabled: false
    });

    expect(offResult.harness).toBeUndefined();
    expect(offResult.toolsAvailable).not.toEqual(expect.arrayContaining(["task", "subtask"]));

    const compactionDir = await tempWorkspace();
    const compactionModel = new SequenceModel([toolResponse("big-1"), toolResponse("big-2"), finalResponse("done")]);
    const { result: compactionResult } = await runConfiguredAgent({
      instruction: "keep concise notes",
      workspacePath: compactionDir,
      provider: "deepseek",
      modelClient: compactionModel,
      permissionMode: "yolo",
      durableSession: false,
      validationMode: "off",
      finalEvidenceMode: "off",
      compactionMode: "deterministic",
      maxTurns: 3,
      maxMessageHistoryChars: 1000,
      messageHistoryRetain: 2,
      compactionSummaryChars: 500,
      toolRegistry: bigOutputRegistry()
    });

    expect(compactionResult.status).toBe("completed");
    expect(compactionModel.requests.some((request) => request.toolChoice === "none")).toBe(false);
    expect(compactionResult.contextCompactions?.[0]).toMatchObject({
      strategy: "deterministic",
      fallback_used: false
    });
  });
});
