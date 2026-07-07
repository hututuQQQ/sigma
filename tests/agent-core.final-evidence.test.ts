import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import { runAgent } from "../packages/agent-core/src/index.js";

class SequenceModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-evidence-model";
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response;
  }
}

function writeResponse(filePath: string, content: string): ModelResponse {
  return {
    message: {
      role: "assistant",
      toolCalls: [
        { id: `write-${filePath}`, type: "function", function: { name: "write", arguments: { path: filePath, content } } }
      ]
    }
  };
}

function bashResponse(command: string): ModelResponse {
  return {
    message: {
      role: "assistant",
      toolCalls: [{ id: `bash-${command}`, type: "function", function: { name: "bash", arguments: { command } } }]
    }
  };
}

function finalResponse(content = "done"): ModelResponse {
  return { message: { role: "assistant", content } };
}

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sigma-final-evidence-"));
}

describe("final evidence gate", () => {
  it("nudges once when a code-change task finalizes without verification", async () => {
    const dir = await tempWorkspace();
    const model = new SequenceModel([
      writeResponse("app.js", "const answer = 42;\n"),
      finalResponse("done without checks"),
      bashResponse("node --check app.js"),
      finalResponse("done with checks")
    ]);

    const result = await runAgent({
      instruction: "implement a small JavaScript file",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      finalEvidenceMode: "auto"
    });

    expect(result.status).toBe("completed");
    expect(result.finalGate).toMatchObject({ nudged: true, status: "satisfied" });
    expect(result.evidenceRecords).toEqual([expect.objectContaining({ executable: true, command: "node --check app.js" })]);
    expect(model.requests[2].messages.some((message) => message.role === "user" && String(message.content).includes("Before giving the final answer"))).toBe(true);
  });

  it("allows final after executable verification evidence", async () => {
    const dir = await tempWorkspace();
    const model = new SequenceModel([bashResponse("printf ok # test"), finalResponse("verified")]);

    const result = await runAgent({
      instruction: "run a test command",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      finalEvidenceMode: "auto"
    });

    expect(result.status).toBe("completed");
    expect(result.finalGate).toMatchObject({ nudged: false, status: "satisfied" });
    expect(model.requests).toHaveLength(2);
  });

  it("does not get stuck on simple text-file tasks", async () => {
    const dir = await tempWorkspace();
    const model = new SequenceModel([writeResponse("note.txt", "hello\n"), finalResponse("created")]);

    const result = await runAgent({
      instruction: "create a text file with a greeting",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      finalEvidenceMode: "auto"
    });

    expect(result.status).toBe("completed");
    expect(result.finalGate).toMatchObject({ nudged: false, status: "not-needed" });
    expect(model.requests).toHaveLength(2);
  });

  it("writes evidence records to summary JSON", async () => {
    const dir = await tempWorkspace();
    const summaryPath = path.join(dir, "summary.json");
    const model = new SequenceModel([bashResponse("printf ok # test"), finalResponse("verified")]);

    await runAgent({
      instruction: "run tests",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "yolo",
      finalEvidenceMode: "auto",
      summaryJsonPath: summaryPath
    });

    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.evidence).toEqual([expect.objectContaining({ executable: true })]);
    expect(summary.final_gate).toMatchObject({ status: "satisfied" });
  });
});
