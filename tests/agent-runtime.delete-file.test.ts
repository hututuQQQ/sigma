import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "../packages/agent-protocol/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import {
  fakeToolCall,
  fakeToolTurn,
  SmokeFakeGateway
} from "../scripts/smoke-fake-model.mjs";

async function storedEvents(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

describe("delete_file runtime transaction", () => {
  it("requires approval and emits authoritative checkpoint and deletion evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-delete-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "obsolete.txt"), "obsolete", "utf8");
    const storeRootDir = path.join(root, "state");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway: new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("delete", "delete_file", { path: "obsolete.txt" })]),
        fakeToolTurn([fakeToolCall("done", "request_user_input", { message: "Deletion observed." })])
      ]),
      tools: registerBuiltinTools(new EffectToolRegistry()),
      store,
      storeRootDir,
      permissionMode: "ask",
      runDeadlineMs: 60_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    const approve = (async () => {
      for await (const event of runtime.subscribe(session.sessionId)) {
        if (event.type !== "tool.approval_requested") continue;
        const payload = event.payload as {
          requestId: string;
          effects: string[];
          plan: { writePaths: string[]; checkpointScope: string[] };
        };
        expect(payload.effects).toEqual(expect.arrayContaining([
          "filesystem.write", "destructive"
        ]));
        expect(payload.plan).toMatchObject({
          writePaths: ["obsolete.txt"],
          checkpointScope: ["obsolete.txt"]
        });
        await runtime.command({
          type: "approve",
          sessionId: session.sessionId,
          requestId: payload.requestId,
          decision: "allow"
        });
        return;
      }
    })();

    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Delete obsolete.txt." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "needs_input", requestId: "done"
    });
    await approve;
    await expect(readFile(path.join(workspace, "obsolete.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const events = await storedEvents(store, session.sessionId);
    expect(events).toContainEqual(expect.objectContaining({
      type: "execution.planned",
      payload: expect.objectContaining({
        plan: expect.objectContaining({
          writePaths: ["obsolete.txt"],
          checkpointScope: ["obsolete.txt"]
        })
      })
    }));
    expect(events.some((event) => event.type === "checkpoint.created")).toBe(true);
    expect(events.some((event) => event.type === "checkpoint.sealed")).toBe(true);
    expect(events.some((event) => event.type === "evidence.recorded"
      && (event.payload as { kind?: string; data?: { delta?: { deleted?: string[] } } }).kind === "workspace_delta"
      && (event.payload as { data?: { delta?: { deleted?: string[] } } }).data?.delta?.deleted?.includes("obsolete.txt")))
      .toBe(true);
    expect(events.some((event) => event.type === "evidence.recorded"
      && (event.payload as { kind?: string; data?: { validator?: string } }).kind === "validation"
      && (event.payload as { data?: { validator?: string } }).data?.validator === "checkpoint_postimage_integrity"))
      .toBe(true);
  });
});
