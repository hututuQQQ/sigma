import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_BUDGET, freezeAgentProfile, type ResolvedAgentProfile } from "../packages/agent-extensions/src/index.js";
import { createKernelState } from "../packages/agent-kernel/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STORE_LAYOUT_VERSION,
  type BudgetLimits,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent
} from "../packages/agent-protocol/src/index.js";
import { createRuntime, restoreStoredSession } from "../packages/agent-runtime/src/index.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry } from "../packages/agent-tools/src/index.js";

class IdleGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "idle";
  readonly capabilities = {
    contextWindowTokens: 32_000, maxOutputTokens: 4_096, tools: true, parallelTools: true,
    reasoning: false, structuredOutput: false, promptCache: false, tokenizer: "approximate" as const
  };
  async complete(_request: ModelRequest): Promise<ModelResponse> { throw new Error("unused"); }
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield await Promise.reject(new Error("unused"));
  }
  async countTokens(): Promise<number> { return 1; }
}

function profile(id: string, overrides: Partial<ResolvedAgentProfile> = {}): ResolvedAgentProfile {
  return {
    id,
    roleRoutes: {
      orchestrator: "main", reviewer: "main", child_analyze: "analysis", child_write: "write"
    },
    toolAllow: ["read_plan"],
    toolDeny: [],
    skills: [],
    hooks: [],
    permissionMode: "ask",
    budget: { ...DEFAULT_PROFILE_BUDGET },
    mutationPolicy: {
      requirePlanBeforeMutation: true, checkpointBeforeMutation: true, reviewNonDocumentationChanges: true
    },
    allowedChildProfiles: [],
    ...overrides
  };
}

const allocation: BudgetLimits = {
  inputTokens: 1_000, outputTokens: 500, costMicroUsd: 1_000,
  modelTurns: 10, toolCalls: 20, children: 2, maxDepth: 2
};

describe("runtime Agent Profile binding", () => {
  it("applies an allowed narrowing to the child session and binds its model role", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-profile-"));
    try {
      const parent = freezeAgentProfile(profile("parent", { allowedChildProfiles: ["child", "wide"] }));
      const child = freezeAgentProfile(profile("child", {
        permissionMode: "deny",
        budget: { ...DEFAULT_PROFILE_BUDGET, maxInputTokens: 800 },
        allowedChildProfiles: []
      }));
      const wide = freezeAgentProfile(profile("wide", { permissionMode: "auto" }));
      const selections: Array<{ role: string; profileId?: string }> = [];
      const gateway = new IdleGateway();
      const runtime = createRuntime({
        gateway,
        gatewayForRole: (role, selected) => {
          selections.push({ role, profileId: selected?.profile.id });
          return gateway;
        },
        tools: new EffectToolRegistry(),
        store: new SegmentedJsonlStore({ rootDir: root }),
        storeRootDir: root,
        profile: parent,
        profileSource: "home",
        availableProfiles: [
          { profile: child, source: "home" },
          { profile: wide, source: "home" }
        ]
      });
      const parentRef = await runtime.createSession({ workspacePath: root, mode: "change" });
      const childRef = await runtime.createChildSession(parentRef.sessionId, {
        workspacePath: root, mode: "analyze"
      }, allocation, "child");
      expect(selections).toContainEqual({ role: "child_analyze", profileId: "child" });
      expect(runtime.sessionBudget(childRef.sessionId).limits.inputTokens).toBe(800);
      const events = [];
      for await (const event of runtime.sessionEvents(childRef.sessionId)) events.push(event);
      expect(events.find((event) => event.type === "session.created")?.payload).toMatchObject({ modelRole: "child_analyze" });
      expect(events.find((event) => event.type === "profile.resolved")?.payload).toMatchObject({ profileId: "child" });
      await expect(runtime.createChildSession(parentRef.sessionId, {
        workspacePath: root, mode: "analyze"
      }, allocation, "wide")).rejects.toMatchObject({ code: "child_profile_widening" });
      await expect(runtime.createChildSession(parentRef.sessionId, {
        workspacePath: root, mode: "analyze"
      }, allocation, "missing")).rejects.toMatchObject({ code: "child_profile_denied" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads the frozen CAS profile on resume instead of current profile files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-profile-resume-"));
    try {
      const gateway = new IdleGateway();
      const frozen = freezeAgentProfile(profile("frozen"));
      const current = freezeAgentProfile(profile("current", { toolAllow: null }));
      const first = createRuntime({
        gateway, tools: new EffectToolRegistry(), store: new SegmentedJsonlStore({ rootDir: root }),
        storeRootDir: root, profile: frozen, profileSource: "home"
      });
      const session = await first.createSession({ workspacePath: root, mode: "analyze" });
      await first.releaseSession(session.sessionId);
      const restoredProfiles: Array<string | undefined> = [];
      const second = createRuntime({
        gateway,
        gatewayForRole: (_role, selected) => { restoredProfiles.push(selected?.profile.id); return gateway; },
        tools: new EffectToolRegistry(), store: new SegmentedJsonlStore({ rootDir: root }),
        storeRootDir: root, profile: current, profileSource: "home"
      });
      await second.command({ type: "resume", sessionId: session.sessionId });
      expect(restoredProfiles.at(-1)).toBe("frozen");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the frozen allowed child profile after the live profile catalog is removed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-child-profile-resume-"));
    try {
      const store = new SegmentedJsonlStore({ rootDir: root });
      const gateway = new IdleGateway();
      const parent = freezeAgentProfile(profile("parent", { allowedChildProfiles: ["child"] }));
      const child = freezeAgentProfile(profile("child", {
        permissionMode: "deny",
        budget: { ...DEFAULT_PROFILE_BUDGET, maxInputTokens: 777 }
      }));
      const first = createRuntime({
        gateway, tools: new EffectToolRegistry(), store, storeRootDir: root,
        profile: parent, profileSource: "home",
        availableProfiles: [{ profile: child, source: "workspace" }]
      });
      const parentRef = await first.createSession({ workspacePath: root, mode: "change" });
      await first.releaseSession(parentRef.sessionId);

      const selected: string[] = [];
      const second = createRuntime({
        gateway, tools: new EffectToolRegistry(), store, storeRootDir: root,
        gatewayForRole: (_role, resolved) => {
          if (resolved) selected.push(resolved.profile.id);
          return gateway;
        },
        availableProfiles: []
      });
      await second.command({ type: "resume", sessionId: parentRef.sessionId });
      const childRef = await second.createChildSession(parentRef.sessionId, {
        workspacePath: root, mode: "analyze"
      }, allocation, "child");
      expect(selected).toContain("child");
      expect(second.sessionBudget(childRef.sessionId).limits.inputTokens).toBe(777);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves frozen customization, plan, and budget across replayed follow-up runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-profile-follow-up-"));
    try {
      const store = new SegmentedJsonlStore({ rootDir: root });
      const sessionId = "profile-follow-up";
      const firstRunId = "first-run";
      const secondRunId = "second-run";
      const startedAt = new Date().toISOString();
      const deadlineAt = new Date(Date.now() + 60_000).toISOString();
      await store.append({
        schemaVersion: EVENT_SCHEMA_VERSION,
        seq: 1,
        eventId: "created",
        sessionId,
        runId: firstRunId,
        occurredAt: startedAt,
        type: "session.created",
        authority: "runtime",
        payload: { workspacePath: root, mode: "analyze", modelRole: "child_analyze" }
      }, 0);
      const state = createKernelState({
        sessionId, runId: firstRunId, mode: "analyze", startedAt, deadlineAt
      });
      state.phase = "terminal";
      state.lastSeq = 1;
      state.revision = 1;
      state.plan = { ...state.plan, revision: 7, goal: "frozen goal" };
      state.budget.limits.inputTokens = 123;
      state.frozenProfile = {
        artifactId: "artifact-profile", digest: "a".repeat(64), source: "home", qualifiedName: "frozen"
      };
      state.frozenSkills = [{
        artifactId: "artifact-skill", digest: "b".repeat(64), source: "workspace", qualifiedName: "workspace:review"
      }];
      state.outcome = { kind: "completed", message: "done", evidence: [] };
      await store.writeSnapshot({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        storeLayoutVersion: STORE_LAYOUT_VERSION,
        sessionId,
        seq: 1,
        createdAt: startedAt,
        state
      });
      await store.append({
        schemaVersion: EVENT_SCHEMA_VERSION,
        seq: 2,
        eventId: "follow-up-run",
        sessionId,
        runId: secondRunId,
        occurredAt: startedAt,
        type: "run.started",
        authority: "runtime",
        payload: { mode: "analyze", deadlineAt }
      }, 1);
      const restored = await restoreStoredSession(store, sessionId, 60_000);
      expect(restored.state).toMatchObject({
        runId: secondRunId,
        frozenProfile: { qualifiedName: "frozen" },
        frozenSkills: [{ qualifiedName: "workspace:review" }],
        plan: { revision: 7, goal: "frozen goal" },
        budget: { limits: { inputTokens: 123 } }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
