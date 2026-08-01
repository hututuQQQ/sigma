import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventEnvelope, ModelMessage } from "../packages/agent-protocol/src/index.js";
import { createRuntime, restoreStoredSession } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry } from "../packages/agent-tools/src/index.js";
import { fakeFinalTurn, SmokeFakeGateway } from "../scripts/smoke-fake-model.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    await rm(directory, { recursive: true, force: true })
  ));
});

async function collect(source: AsyncIterable<AgentEventEnvelope>): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of source) result.push(event);
  return result;
}

function userMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => message.role === "user");
}

describe("runtime conversation rollback", () => {
  it("retains images and replaces rolled-back user turns without rewriting the event log", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-history-rollback-"));
    temporaryDirectories.push(workspace);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const gateway = new SmokeFakeGateway([
      fakeFinalTurn("first response"),
      fakeFinalTurn("response to remove"),
      fakeFinalTurn("replacement response")
    ]);
    gateway.capabilities.imageInput = true;
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: new EffectToolRegistry(),
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });

    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Keep this turn",
      images: [{ mimeType: "image/png", data: "AQ==" }],
      mode: "analyze"
    });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed"
    });
    await runtime.command({
      type: "follow_up",
      sessionId: session.sessionId,
      text: "Remove this turn",
      images: [{ mimeType: "image/jpeg", data: "Ag==" }]
    });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed"
    });

    const rollback = await runtime.rollbackTurns(session.sessionId, 1);
    expect(rollback.removedTurns).toBe(1);
    await runtime.command({
      type: "follow_up",
      sessionId: session.sessionId,
      text: "Replacement turn"
    });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "completed"
    });

    const firstUsers = userMessages(gateway.requests[0]?.messages ?? []);
    expect(firstUsers.at(-1)).toMatchObject({
      content: "Keep this turn",
      images: [{ mimeType: "image/png", data: "AQ==" }]
    });
    const replacementUsers = userMessages(gateway.requests[2]?.messages ?? []);
    expect(replacementUsers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: "Keep this turn",
        images: [{ mimeType: "image/png", data: "AQ==" }]
      }),
      expect.objectContaining({ content: "Replacement turn" })
    ]));
    expect(replacementUsers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "Remove this turn" })
    ]));

    const rawEvents = await collect(store.events(session.sessionId));
    expect(rawEvents).toContainEqual(expect.objectContaining({
      type: "session.history_rolled_back",
      authority: "user",
      payload: { numTurns: 1 }
    }));
    expect(rawEvents).toContainEqual(expect.objectContaining({
      type: "user.follow_up",
      payload: expect.objectContaining({ text: "Remove this turn", status: "delivered" })
    }));

    const effectiveEvents = await collect(runtime.sessionEvents(session.sessionId));
    expect(effectiveEvents).toContainEqual(expect.objectContaining({
      type: "session.history_rolled_back",
      payload: { numTurns: 1 }
    }));
    expect(effectiveEvents).not.toContainEqual(expect.objectContaining({
      type: "user.follow_up",
      payload: expect.objectContaining({ text: "Remove this turn" })
    }));
    expect(effectiveEvents).toContainEqual(expect.objectContaining({
      type: "user.follow_up",
      payload: expect.objectContaining({ text: "Replacement turn", status: "delivered" })
    }));

    const restored = await restoreStoredSession(store, session.sessionId, 10_000);
    const restoredUsers = userMessages(restored.state.messages);
    expect(restoredUsers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: "Keep this turn",
        images: [{ mimeType: "image/png", data: "AQ==" }]
      }),
      expect.objectContaining({ content: "Replacement turn" })
    ]));
    expect(restoredUsers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "Remove this turn" })
    ]));
  });
});
