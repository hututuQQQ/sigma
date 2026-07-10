export const fakeToolCall = (id, name, args) => ({ id, name, arguments: args });

export function fakeToolTurn(toolCalls) {
  return {
    message: { role: "assistant", content: "", toolCalls },
    finishReason: "tool_calls",
    inputTokens: 1,
    outputTokens: 1
  };
}

export function fakeFinalTurn(content = "done", evidenceCallIds = []) {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [fakeToolCall("complete-smoke", "complete_task", {
        summary: content,
        criteria: [{
          criterion: "The requested smoke workflow completed.",
          status: "met",
          evidenceCallIds,
          rationale: "Cited current-run receipts demonstrate the result."
        }]
      })]
    },
    finishReason: "tool_calls",
    inputTokens: 1,
    outputTokens: 1
  };
}

export class SmokeFakeGateway {
  provider = "fake";
  model = "smoke-fake-model";
  capabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };

  constructor(responses = [fakeFinalTurn()]) {
    this.responses = [...responses];
    this.requests = [];
  }

  async complete(request) {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("The generic fake gateway has no scripted response remaining.");
    return response;
  }

  async *stream(request) {
    const response = await this.complete(request);
    if (response.message.content) yield { type: "content", delta: response.message.content };
    yield { type: "done", response };
  }

  async countTokens(messages, tools = []) {
    return Math.ceil(JSON.stringify({ messages, tools }).length / 4);
  }
}

export const SmokeFakeModel = SmokeFakeGateway;
