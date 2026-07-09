import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import {
  buildResumeInstruction,
  listSessions,
  loadSessionMeta,
  loadSessionResumeContext,
  runAgent,
  searchSessions
} from "../packages/agent-core/src/index.js";

class FinalModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-session-model";

  constructor(private readonly content = "all set") {}

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    return { message: { role: "assistant", content: this.content } };
  }
}

async function workspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sigma-session-"));
}

describe("durable sessions", () => {
  it("writes a durable session index, meta, events, and redacted summary by default", async () => {
    const dir = await workspace();
    const secret = "session-secret-value-123456";
    process.env.SIGMA_SESSION_TOKEN = secret;
    try {
      const result = await runAgent({
        instruction: "Fix the login flow",
        workspacePath: dir,
        modelClient: new FinalModel(`all set token=${secret}`)
      });

      expect(result.sessionId).toEqual(expect.any(String));
      const sessions = await listSessions({ workspacePath: dir });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId: result.sessionId,
        title: "Fix the login flow",
        status: "completed",
        provider: "deepseek",
        model: "fake-session-model"
      });

      const meta = await loadSessionMeta({ sessionId: result.sessionId as string, workspacePath: dir });
      expect(meta?.eventsPath).toContain(path.join(".agent", "sessions"));
      expect(meta?.artifactManifestPath).toContain(path.join(".agent", "sessions"));
      const indexText = await readFile(path.join(dir, ".agent", "sessions", "index.jsonl"), "utf8");
      const eventsText = await readFile(meta?.eventsPath as string, "utf8");
      const summaryText = await readFile(meta?.summaryPath as string, "utf8");
      const artifactsText = await readFile(meta?.artifactManifestPath as string, "utf8");
      expect(indexText).not.toContain(secret);
      expect(eventsText).not.toContain(secret);
      expect(summaryText).not.toContain(secret);
      expect(artifactsText).not.toContain(secret);
      expect(summaryText).toContain("[REDACTED]");
      expect(JSON.parse(artifactsText)).toMatchObject({
        schemaVersion: 1,
        sessionId: result.sessionId,
        artifacts: {
          manifest: meta?.artifactManifestPath,
          meta: expect.stringContaining("meta.json"),
          summary: meta?.summaryPath,
          events: meta?.eventsPath,
          checkpoints: meta?.checkpointsDir
        },
        evidence: {
          validation: { total: expect.any(Number), failed: expect.any(Number) },
          precheck: { total: expect.any(Number), failed: expect.any(Number) }
        }
      });

      const found = await searchSessions({ query: "login all set", workspacePath: dir });
      expect(found[0]?.session.sessionId).toBe(result.sessionId);
    } finally {
      delete process.env.SIGMA_SESSION_TOKEN;
    }
  });

  it("builds resume/fork context without replaying provider-specific tool messages", async () => {
    const dir = await workspace();
    const result = await runAgent({
      instruction: "Investigate parser bug",
      workspacePath: dir,
      modelClient: new FinalModel("Parser bug is isolated.")
    });

    const context = await loadSessionResumeContext({ sessionId: result.sessionId as string, workspacePath: dir });
    expect(context?.session.sessionId).toBe(result.sessionId);
    const instruction = buildResumeInstruction({
      context: context!,
      instruction: "Continue with a fix",
      mode: "fork"
    });

    expect(instruction).toContain(`sessionId: ${result.sessionId}`);
    expect(instruction).toContain("Parser bug is isolated.");
    expect(instruction).toContain("New instruction:");
    expect(instruction).toContain("Continue with a fix");
  });

  it("records linked parent and fork metadata on new sessions", async () => {
    const dir = await workspace();
    const parent = await runAgent({
      instruction: "Parent run",
      workspacePath: dir,
      modelClient: new FinalModel("parent done")
    });
    const child = await runAgent({
      instruction: "Child run",
      workspacePath: dir,
      modelClient: new FinalModel("child done"),
      parentSessionId: parent.sessionId,
      forkedFromSessionId: parent.sessionId
    });

    const childMeta = await loadSessionMeta({ sessionId: child.sessionId as string, workspacePath: dir });
    expect(childMeta).toMatchObject({
      parentSessionId: parent.sessionId,
      forkedFromSessionId: parent.sessionId
    });
  });
});
