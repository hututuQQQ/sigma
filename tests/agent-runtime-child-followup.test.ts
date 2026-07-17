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
import { createChildAgentFactory, createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { AgentSupervisor, WorkspaceIsolationManager } from "../packages/agent-supervisor/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import { createHostExecutionBroker } from "./helpers/host-execution-broker.js";
import { createApprovingReviewer } from "./helpers/approving-reviewer.js";
import { registerContentValidator, validationTurn } from "./helpers/content-validator.js";
import { typedCompletion } from "./helpers/typed-evidence.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { windowsHide: true });
}

function writeTurn(id: string, file: string, content: string): ModelResponse {
  return {
    message: { role: "assistant", content: "", toolCalls: [{ id, name: "write", arguments: { path: file, content } }] },
    finishReason: "tool_calls"
  };
}

function completeTurn(id: string, summary: string): (request: ModelRequest) => ModelResponse {
  return (request) => typedCompletion(request, { id, summary, criterion: summary });
}

type ScriptedResponse = ModelResponse | ((request: ModelRequest) => ModelResponse);

function reopenPlanTurn(): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "reopen-plan-for-follow-up",
        name: "update_plan",
        arguments: {
          expectedRevision: 2,
          goal: "Complete the accepted follow-up request.",
          activeNodeId: "root",
          nodes: [{
            id: "root",
            title: "Write second.txt for the follow-up",
            dependencies: [],
            status: "in_progress",
            owner: { kind: "root" },
            acceptanceCriteria: ["second.txt contains the requested follow-up content."],
            evidence: [],
            reopenReason: "The user accepted an additional follow-up workspace change."
          }]
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
  private requestCount = 0;

  constructor(private readonly responses: ScriptedResponse[]) {
    this.firstStarted = new Promise((resolve) => { this.startFirst = resolve; });
    this.firstGate = new Promise((resolve) => { this.releaseFirst = resolve; });
  }

  release(): void { this.releaseFirst(); }

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("The test consumes streaming responses.");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requestCount += 1;
    if (this.requestCount === 1) {
      this.startFirst();
      await this.firstGate;
    }
    const scripted = this.responses.shift();
    if (!scripted) throw new Error("No child follow-up response remains.");
    yield { type: "done", response: typeof scripted === "function" ? scripted(request) : scripted };
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
      validationTurn("validate-first", [{ path: "first.txt", expected: "first" }]),
      completeTurn("complete-first", "first run complete"),
      reopenPlanTurn(),
      writeTurn("write-second", "second.txt", "second"),
      validationTurn("validate-second", [{ path: "second.txt", expected: "second" }]),
      completeTurn("complete-second", "follow-up run complete")
    ]);
    const execution = createHostExecutionBroker();
    const storeRootDir = path.join(repository, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: registerContentValidator(registerBuiltinTools(new EffectToolRegistry(), { broker: execution })),
      reviewer: createApprovingReviewer(),
      execution,
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const parent = await runtime.createSession({ workspacePath: repository, mode: "change" });
    const supervisor = new AgentSupervisor(
      createChildAgentFactory(() => runtime),
      1,
      new WorkspaceIsolationManager(path.join(root, "worktrees"), { execution })
    );
    const instruction = `${"Write first.txt and retain the general requirements. ".repeat(3)}Preserve this trailing constraint.`;
    const child = supervisor.spawn({
      parentId: parent.sessionId,
      instruction,
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
    const childSession = (await store.listSessions()).find((item) => item.sessionId !== parent.sessionId);
    if (!childSession) throw new Error("Expected a durable child session.");
    const childEvents = [];
    for await (const event of store.events(childSession.sessionId)) childEvents.push(event);
    const initialPlan = childEvents.find((event) => event.type === "plan.updated")?.payload as {
      plan?: { goal?: string; nodes?: Array<{ title?: string }> };
    } | undefined;
    expect(initialPlan?.plan?.goal).toBe(instruction);
    expect(initialPlan?.plan?.nodes?.[0]?.title).toBe(instruction.slice(0, 80).trim());
    await execution.close();
  }, 30_000);
});
