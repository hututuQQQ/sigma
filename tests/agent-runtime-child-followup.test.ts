import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import { createChildAgentFactory, createRuntime } from "../packages/agent-runtime/src/index.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { AgentSupervisor, WorkspaceIsolationManager } from "../packages/agent-supervisor/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { windowsHide: true });
}

function writeTurn(id: string, file: string, content: string): ModelResponse {
  return {
    message: { role: "assistant", content: "", toolCalls: [{ id, name: "write", arguments: { path: file, content } }] },
    finishReason: "tool_calls"
  };
}

function completeTurn(id: string, summary: string, evidenceCallId: string): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id,
        name: "complete_task",
        arguments: {
          summary,
          criteria: [{ criterion: summary, status: "met", evidenceCallIds: [evidenceCallId] }]
        }
      }]
    },
    finishReason: "tool_calls"
  };
}

class FollowUpGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "child-follow-up";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };
  readonly firstStarted: Promise<void>;
  private startFirst!: () => void;
  private releaseFirst!: () => void;
  private readonly firstGate: Promise<void>;

  constructor(private readonly responses: ModelResponse[]) {
    this.firstStarted = new Promise((resolve) => { this.startFirst = resolve; });
    this.firstGate = new Promise((resolve) => { this.releaseFirst = resolve; });
  }

  release(): void { this.releaseFirst(); }

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("The test consumes streaming responses.");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (this.responses.length === 4) {
      this.startFirst();
      await this.firstGate;
    }
    const response = this.responses.shift();
    if (!response) throw new Error("No child follow-up response remains.");
    yield { type: "done", response };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length / 4;
  }
}

describe("child follow-up lifecycle", () => {
  it("keeps a writer worktree until every accepted follow-up run is idle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-followup-"));
    const repository = path.join(root, "repository");
    await mkdir(repository);
    git(repository, "init");
    git(repository, "config", "user.email", "sigma-tests@example.invalid");
    git(repository, "config", "user.name", "Sigma Tests");
    await writeFile(path.join(repository, "tracked.txt"), "base\n", "utf8");
    git(repository, "add", "tracked.txt");
    git(repository, "commit", "-m", "initial");

    const gateway = new FollowUpGateway([
      writeTurn("write-first", "first.txt", "first"),
      completeTurn("complete-first", "first run complete", "write-first"),
      writeTurn("write-second", "second.txt", "second"),
      completeTurn("complete-second", "follow-up run complete", "write-second")
    ]);
    const storeRootDir = path.join(repository, ".agent");
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      runDeadlineMs: 10_000
    });
    const supervisor = new AgentSupervisor(
      createChildAgentFactory(() => runtime),
      1,
      new WorkspaceIsolationManager(path.join(root, "worktrees"))
    );
    const child = supervisor.spawn({
      parentId: "parent",
      instruction: "write first.txt",
      workspacePath: repository,
      intent: "write",
      writeScope: ["first.txt", "second.txt"],
      delegatedEffects: ["filesystem.read", "filesystem.write", "process.spawn", "validation"],
      metadata: { mode: "change" }
    });
    await gateway.firstStarted;
    supervisor.followUp(child.id, "also write second.txt before finishing");
    gateway.release();

    const completed = await supervisor.join(child.id);
    expect(completed).toMatchObject({
      status: "completed",
      result: { outcome: { kind: "completed", message: "follow-up run complete" } },
      isolation: { cleanup: "retained" }
    });
    const worktree = completed.isolation?.worktreePath;
    if (!worktree) throw new Error("Expected a retained writer worktree.");
    expect(existsSync(worktree)).toBe(true);
    await expect(readFile(path.join(worktree, "first.txt"), "utf8")).resolves.toBe("first");
    await expect(readFile(path.join(worktree, "second.txt"), "utf8")).resolves.toBe("second");

    await expect(supervisor.integrate(child.id)).resolves.toMatchObject({ isolation: { cleanup: "integrated" } });
    await expect(readFile(path.join(repository, "first.txt"), "utf8")).resolves.toBe("first");
    await expect(readFile(path.join(repository, "second.txt"), "utf8")).resolves.toBe("second");
  });
});
