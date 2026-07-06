import { describe, expect, it } from "vitest";
import {
  createModelClient,
  normalizeAssistantMessage,
  normalizeToolCalls,
  normalizeUsage
} from "../packages/agent-ai/src/index.js";

describe("agent-ai normalization", () => {
  it("normalizes DeepSeek-style tool calls and reasoning content", () => {
    const message = normalizeAssistantMessage({
      content: "",
      reasoning_content: "thinking",
      tool_calls: [
        {
          id: "deepseek-call",
          type: "function",
          function: {
            name: "bash",
            arguments: "{\"command\":\"pwd\"}"
          }
        }
      ]
    });

    expect(message.reasoningContent).toBe("thinking");
    expect(message.toolCalls?.[0]).toMatchObject({
      id: "deepseek-call",
      type: "function",
      function: {
        name: "bash",
        arguments: { command: "pwd" }
      }
    });
  });

  it("normalizes GLM/OpenAI-style tool calls", () => {
    const calls = normalizeToolCalls([
      {
        id: "glm-call",
        function: {
          name: "write",
          arguments: "{\"path\":\"hello.txt\",\"content\":\"hi\"}"
        }
      }
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].function.arguments).toEqual({ path: "hello.txt", content: "hi" });
  });

  it("keeps invalid JSON arguments as strings", () => {
    const calls = normalizeToolCalls([
      {
        id: "bad-json",
        function: {
          name: "bash",
          arguments: "{not json"
        }
      }
    ]);

    expect(calls[0].function.arguments).toBe("{not json");
  });

  it("normalizes usage token fields", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 10,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 3 },
        total_tokens: 14
      })
    ).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheTokens: 3,
      totalTokens: 14
    });
  });

  it("creates normalized provider clients with default models", () => {
    const deepseek = createModelClient("deepseek");
    const glm = createModelClient("glm");

    expect(deepseek.provider).toBe("deepseek");
    expect(deepseek.model).toBe("deepseek-v4-pro");
    expect(glm.provider).toBe("glm");
    expect(glm.model).toBe("glm-5.2");
  });
});
