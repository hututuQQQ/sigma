import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_BUDGET,
  defaultSkillRoots,
  discoverSkills,
  freezeAgentProfile,
  restoreSessionCustomization,
  type HookDefinition,
  type HookRunnerRequest,
  type ResolvedAgentProfile
} from "../packages/agent-extensions/src/index.js";
import type {
  AgentEventEnvelope,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/index.js";
import { ContentAddressedArtifactStore, SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

const usage = {
  inputTokens: 100,
  outputTokens: 10,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  providerReported: true,
  costMicroUsd: 0,
  latencyMs: 1,
  retryAttempt: 0
};

class LoadSkillGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "frozen-customization";
  readonly capabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate" as const
  };
  readonly requests: ModelRequest[] = [];

  async complete(_request: ModelRequest): Promise<ModelResponse> { throw new Error("stream only"); }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length > 1) throw new Error("stop after frozen skill load");
    yield {
      type: "done",
      response: {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "load-frozen-review",
            name: "load_skill",
            arguments: { qualifiedName: "workspace:review" }
          }]
        },
        finishReason: "tool_calls",
        usage
      }
    };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return Math.ceil(JSON.stringify({ messages, tools }).length / 4);
  }
}

function profile(hookId: string): ResolvedAgentProfile {
  return {
    id: "frozen",
    roleRoutes: { orchestrator: "main" },
    toolAllow: null,
    toolDeny: [],
    skills: ["workspace:review"],
    hooks: [hookId],
    permissionMode: "auto",
    budget: { ...DEFAULT_PROFILE_BUDGET },
    mutationPolicy: {
      requirePlanBeforeMutation: true,
      checkpointBeforeMutation: true,
      reviewNonDocumentationChanges: true
    },
    allowedChildProfiles: []
  };
}

async function events(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

describe("durable session customization", () => {
  it("loads frozen skill text and hook definitions after live customization is deleted or changed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-frozen-customization-"));
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    const storeRoot = path.join(root, "state");
    await mkdir(workspace, { recursive: true });
    const skillRoot = path.join(workspace, ".agent", "skills", "review");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), [
      "---",
      "name: review",
      "description: Review frozen code",
      "---",
      "ORIGINAL FROZEN INSTRUCTIONS",
      ""
    ].join("\n"));

    const originalHook: HookDefinition = {
      id: "frozen-policy",
      event: "pre_model",
      kind: "command",
      command: "old-policy-command",
      args: ["--old"],
      required: true,
      timeoutMs: 5_000
    };
    const changedHook: HookDefinition = {
      ...originalHook,
      command: "new-policy-command",
      args: ["--new"]
    };
    const store = new SegmentedJsonlStore({ rootDir: storeRoot });
    const skills = await discoverSkills(defaultSkillRoots(home, workspace));
    const frozenProfile = freezeAgentProfile(profile(originalHook.id));
    const inertGateway = new LoadSkillGateway();
    const first = createRuntime({
      gateway: inertGateway,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      store,
      storeRootDir: storeRoot,
      profile: frozenProfile,
      profileSource: "workspace",
      skills,
      hooks: [originalHook],
      hookRunner: { run: async () => ({ ok: true, output: { decision: "allow" }, durationMs: 1 }) }
    });

    try {
      const session = await first.createSession({ workspacePath: workspace, mode: "analyze" });
      const createdEvents = await events(store, session.sessionId);
      const frozenEvent = createdEvents.find((event) => event.type === "customization.frozen");
      expect(frozenEvent?.payload).toMatchObject({ skillCount: 1, hookCount: 1 });
      const reference = frozenEvent?.payload as { artifactId: string; digest: string };
      const artifact = await new ContentAddressedArtifactStore(storeRoot).get(session.sessionId, reference.artifactId);
      const frozen = restoreSessionCustomization(artifact.toString("utf8"), reference.digest);
      expect(frozen.skills[0]).toMatchObject({
        qualifiedName: "workspace:review"
      });
      expect(frozen.skills[0]?.instructions).toContain("ORIGINAL FROZEN INSTRUCTIONS");
      expect(frozen.hooks[0]?.definition).toMatchObject({ command: "old-policy-command", args: ["--old"] });
      await first.releaseSession(session.sessionId);

      await rm(skillRoot, { recursive: true, force: true });
      const currentSkills = await discoverSkills(defaultSkillRoots(home, workspace));
      const hookRequests: HookRunnerRequest[] = [];
      const gateway = new LoadSkillGateway();
      const second = createRuntime({
        gateway,
        tools: registerBuiltinTools(new EffectToolRegistry()),
        store,
        storeRootDir: storeRoot,
        skills: currentSkills,
        hooks: [changedHook],
        hookRunner: {
          run: async (request) => {
            hookRequests.push(request);
            return { ok: true, output: { decision: "allow", context: ["FROZEN HOOK CONTEXT"] }, durationMs: 1 };
          }
        }
      });
      await second.command({ type: "resume", sessionId: session.sessionId });
      await second.command({ type: "submit", sessionId: session.sessionId, text: "Load the review skill." });
      await second.waitForOutcome(session.sessionId);

      expect(hookRequests.length).toBeGreaterThan(0);
      expect(hookRequests.every((request) => request.hook.kind === "command"
        && request.hook.command === "old-policy-command"
        && request.hook.args[0] === "--old")).toBe(true);
      expect(gateway.requests[0]?.messages.some((message) =>
        message.content.includes("Available skill workspace:review: Review frozen code"))).toBe(true);
      expect(gateway.requests[0]?.messages.some((message) => message.content.includes("FROZEN HOOK CONTEXT"))).toBe(true);

      const resumedEvents = await events(store, session.sessionId);
      const loaded = resumedEvents.findLast((event) => event.type === "tool.completed"
        && (event.payload as { callId?: string }).callId === "load-frozen-review");
      expect(loaded, JSON.stringify(resumedEvents.map((event) => ({ type: event.type, payload: event.payload })))).toBeDefined();
      expect((loaded?.payload as { output?: string } | undefined)?.output).toContain("ORIGINAL FROZEN INSTRUCTIONS");
      expect(resumedEvents.some((event) => event.type === "skill.loaded"
        && (event.payload as { qualifiedName?: string }).qualifiedName === "workspace:review")).toBe(true);
      await second.releaseSession(session.sessionId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
