import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import { redactSecrets, runAgent } from "../packages/agent-core/src/index.js";

class SecretModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-secret-model";

  constructor(private readonly secret: string) {}

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    return { message: { role: "assistant", content: `token=${this.secret}` } };
  }
}

describe("secret redaction", () => {
  it("keeps token usage counters while redacting real token fields", () => {
    const redacted = redactSecrets({
      input_tokens: 12,
      output_tokens: 5,
      token: "sigma-secret-value-abcdef",
      nested: { auth_token: "sigma-secret-value-ghijkl" }
    });
    expect(redacted).toMatchObject({
      input_tokens: 12,
      output_tokens: 5,
      token: "[REDACTED]",
      nested: { auth_token: "[REDACTED]" }
    });
  });

  it("redacts env-shaped secrets from summaries and traces", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-redaction-"));
    const secret = "sigma-secret-value-123456";
    process.env.SIGMA_TEST_TOKEN = secret;
    const summaryPath = path.join(dir, "summary.json");
    const tracePath = path.join(dir, "trace.jsonl");
    try {
      await runAgent({
        instruction: "finish",
        workspacePath: dir,
        modelClient: new SecretModel(secret),
        summaryJsonPath: summaryPath,
        traceJsonlPath: tracePath
      });

      const summary = await readFile(summaryPath, "utf8");
      const trace = await readFile(tracePath, "utf8");
      expect(summary).not.toContain(secret);
      expect(trace).not.toContain(secret);
      expect(summary).toContain("[REDACTED]");
      expect(trace).toContain("[REDACTED]");
    } finally {
      delete process.env.SIGMA_TEST_TOKEN;
    }
  });
});
