import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "../packages/agent-protocol/src/index.js";
import { createRuntime, restoreStoredSession } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import {
  fakeToolCall,
  fakeToolTurn,
  SmokeFakeGateway
} from "../scripts/smoke-fake-model.mjs";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-no-change-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 20
  })));
});

async function events(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

describe("runtime exact no-change convergence", () => {
  it.each([
    ["write", { path: "same.txt", content: "same\n" }],
    ["edit", { path: "same.txt", oldText: "same", newText: "same" }]
  ] as const)("completes a same-byte %s under the trusted pre-check without a checkpoint or delta", async (toolName, toolArguments) => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    const storeRootDir = path.join(root, "state");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "same.txt"), "same\n", "utf8");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall(`same-${toolName}`, toolName, toolArguments)]),
        fakeToolTurn([fakeToolCall("stop", "request_user_input", { message: "No-change receipt recorded." })])
      ]),
      tools: registerBuiltinTools(new EffectToolRegistry(), { atomicPatchStateRootDir: storeRootDir }),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Keep the exact existing bytes." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "needs_input", requestId: "stop"
    });

    const stored = await events(store, session.sessionId);
    expect(stored.some((event) => event.type.startsWith("checkpoint."))).toBe(false);
    expect(stored).toContainEqual(expect.objectContaining({
      type: "tool.completed",
      payload: expect.objectContaining({
        callId: `same-${toolName}`,
        result: { status: "no_change", path: "same.txt" },
        actualEffects: ["filesystem.read"]
      })
    }));
    expect(stored.some((event) => event.type === "evidence.recorded"
      && ["checkpoint", "workspace_delta"].includes(String(
        (event.payload as { kind?: unknown }).kind
      )))).toBe(false);
    expect(stored).toContainEqual(expect.objectContaining({
      type: "evidence.recorded",
      payload: expect.objectContaining({
        kind: "diagnostic",
        status: "informational",
        summary: expect.stringContaining("made no changes"),
        data: expect.objectContaining({ diagnostic: { status: "no_change", path: "same.txt" } })
      })
    }));

    const restored = await restoreStoredSession(store, session.sessionId, 10_000);
    expect(restored.state.checkpointHead).toBeUndefined();
    expect(restored.state.mutationEvidence).toEqual([]);
    expect(restored.state.receipts).toContainEqual(expect.objectContaining({
      callId: `same-${toolName}`,
      result: { status: "no_change", path: "same.txt" },
      actualEffects: ["filesystem.read"]
    }));
  });

  it("does not use the no-change optimization to bypass analyze-mode write denial", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    const storeRootDir = path.join(root, "state");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "same.txt"), "same\n", "utf8");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("denied-write", "write", { path: "same.txt", content: "same\n" })]),
        fakeToolTurn([fakeToolCall("stop", "request_user_input", { message: "Write denial recorded." })])
      ]),
      tools: registerBuiltinTools(new EffectToolRegistry(), { atomicPatchStateRootDir: storeRootDir }),
      store,
      storeRootDir,
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Attempt a same-byte write." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ requestId: "stop" });

    const stored = await events(store, session.sessionId);
    expect(stored).toContainEqual(expect.objectContaining({
      type: "tool.failed",
      payload: expect.objectContaining({
        callId: "denied-write",
        diagnostics: ["model_tool_policy_violation"]
      })
    }));
    expect(stored.some((event) => event.type.startsWith("checkpoint."))).toBe(false);
    expect(stored.some((event) => event.type === "tool.completed"
      && (event.payload as { callId?: unknown }).callId === "denied-write")).toBe(false);
  });
});
