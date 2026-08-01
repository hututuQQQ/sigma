import * as acp from "@agentclientprotocol/sdk";
import type { AgentEventEnvelope, AgentEventOf, RunCommand, RuntimeClient } from "agent-protocol";
import { describe, expect, it } from "vitest";
import {
  nonempty,
  object,
  payloadText,
  textContent,
  toolKind
} from "../packages/agent-cli/src/acp/sigma-acp-event-content.js";
import { SigmaAcpInteractionForwarder } from
  "../packages/agent-cli/src/acp/sigma-acp-interactions.js";
import { SigmaAcpLifecycleEventForwarder } from
  "../packages/agent-cli/src/acp/sigma-acp-lifecycle-events.js";
import type { ResolvedSession } from "../packages/agent-cli/src/acp/sigma-acp-shared.js";

function event<T extends AgentEventEnvelope["type"]>(
  type: T,
  payload: AgentEventOf<T>["payload"]
): AgentEventOf<T> {
  return {
    schemaVersion: 1,
    seq: 1,
    eventId: "event-1",
    sessionId: "runtime-session",
    runId: "run-1",
    occurredAt: "2026-08-02T00:00:00.000Z",
    type,
    authority: "runtime",
    payload
  } as AgentEventOf<T>;
}

function resolvedSession(mode: "analyze" | "change" = "change"): {
  resolved: ResolvedSession;
  commands: RunCommand[];
} {
  const commands: RunCommand[] = [];
  const runtime = {
    command: async (command: RunCommand): Promise<void> => {
      commands.push(command);
    }
  } as unknown as RuntimeClient;
  return {
    resolved: {
      record: {
        sessionId: "acp-session",
        runtimeSessionId: "runtime-session",
        cwd: "D:/workspace",
        modelId: "provider/model",
        mode,
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        started: true,
        lastSeq: 1
      },
      handle: {
        runtime,
        workspace: "D:/workspace",
        storeRootDir: "D:/state",
        close: async (): Promise<void> => undefined
      }
    },
    commands
  };
}

function clientWith(
  request: (...arguments_: unknown[]) => Promise<unknown>,
  notifications: unknown[] = []
): acp.AgentContext {
  return {
    request,
    notify: async (_method: unknown, params: unknown): Promise<void> => {
      notifications.push(params);
    }
  } as unknown as acp.AgentContext;
}

function toolRequest(arguments_: Record<string, unknown>): AgentEventOf<"tool.requested"> {
  return event("tool.requested", {
    callId: "ask-1",
    name: "request_user_input",
    arguments: arguments_,
    turnId: 1,
    effectRevision: 0
  });
}

function approvalRequest(): AgentEventOf<"tool.approval_requested"> {
  return event("tool.approval_requested", {
    requestId: "approval-1",
    callId: "call-1",
    toolName: "write_file",
    arguments: { path: "README.md" },
    effects: ["filesystem.write"],
    reason: "Write access is required.",
    approvalMode: "human",
    turnId: 1,
    effectRevision: 0
  });
}

describe("Sigma ACP helper branches", () => {
  it("normalizes payloads and classifies every ACP tool kind", () => {
    expect(object({ value: 1 })).toEqual({ value: 1 });
    expect(object(null)).toBeUndefined();
    expect(object([])).toBeUndefined();
    expect(nonempty("  value  ")).toBe("value");
    expect(nonempty("   ")).toBeUndefined();
    expect(nonempty(1)).toBeUndefined();
    expect(toolKind("write_file", ["filesystem.write"])).toBe("edit");
    expect(toolKind("commit", ["repository.write"])).toBe("edit");
    expect(toolKind("shell", ["process.spawn"])).toBe("execute");
    expect(toolKind("browser", ["network"])).toBe("fetch");
    expect(toolKind("grep_files")).toBe("search");
    expect(toolKind("inspect_status")).toBe("read");
    expect(toolKind("custom_tool")).toBe("other");
    expect(textContent("hello")).toEqual([{ type: "content", content: { type: "text", text: "hello" } }]);
    expect(textContent("")).toEqual([]);
    expect(payloadText({ summary: " done " }, ["message", "summary"])).toBe("done");
    expect(payloadText([], ["message"])).toBe("");
  });

  it("forwards child, hook, and MCP lifecycle variants", async () => {
    const forwarder = new SigmaAcpLifecycleEventForwarder();
    const { resolved } = resolvedSession();
    const notifications: unknown[] = [];
    const client = clientWith(async () => ({}), notifications);

    await expect(forwarder.forwardEvent(
      resolved,
      event("model.delta", { turnId: 1, delta: "text" }),
      client,
      false
    )).resolves.toBe(false);
    await forwarder.forwardEvent(resolved, event("child.spawned", {
      childId: "child-123456789",
      payload: { instruction: "Inspect the repository" }
    }), client, true);
    await forwarder.forwardEvent(resolved, event("child.message", {
      childId: "child-123456789",
      payload: { summary: "Inspection running" }
    }), client, false);
    await forwarder.forwardEvent(resolved, event("child.completed", {
      childId: "child-123456789",
      payload: { status: "completed", summary: "Inspection complete" }
    }), client, false);
    await forwarder.forwardEvent(resolved, event("child.completed", {
      childId: "child-failed",
      payload: { status: "failed", error: "Inspection failed" }
    }), client, false);

    const hookBase = { hookId: "hook-1", event: "pre_tool", required: true };
    await forwarder.forwardEvent(resolved, event("hook.started", {
      ...hookBase,
      kind: "command"
    }), client, false);
    await forwarder.forwardEvent(resolved, event("hook.completed", {
      ...hookBase,
      durationMs: 1.6,
      outcome: { ...hookBase, status: "allowed", durationMs: 1.6 }
    }), client, false);
    await forwarder.forwardEvent(resolved, event("hook.failed", {
      ...hookBase,
      durationMs: 2,
      outcome: { ...hookBase, status: "failed", durationMs: 2, reason: "Hook failed" }
    }), client, false);
    await forwarder.forwardMcpStatus("acp-session", {
      name: "stdio-server",
      command: "server",
      args: [],
      env: []
    }, client, "connected");
    await forwarder.forwardMcpStatus("acp-session", {
      type: "http",
      name: "http-server",
      url: "https://example.test/mcp",
      headers: []
    }, client, "disconnected");

    expect(notifications).toHaveLength(9);
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ _meta: { isReplay: true } }),
      expect.objectContaining({
        update: expect.objectContaining({ status: "failed", toolCallId: "child:child-failed" })
      }),
      expect.objectContaining({
        update: expect.objectContaining({ status: "failed", toolCallId: "hook:hook-1" })
      }),
      expect.objectContaining({
        update: expect.objectContaining({ rawOutput: { status: expect.objectContaining({ transport: "stdio" }) } })
      }),
      expect.objectContaining({
        update: expect.objectContaining({ rawOutput: { status: expect.objectContaining({ transport: "http" }) } })
      })
    ]));
  });

  it("maps structured questions, annotations, fallbacks, and unsupported clients", async () => {
    const forwarder = new SigmaAcpInteractionForwarder();
    const { resolved, commands } = resolvedSession("analyze");
    const signal = new AbortController().signal;

    await expect(forwarder.requestStructuredUserInput(
      resolved,
      toolRequest({ questions: [null, { question: " " }] }),
      clientWith(async () => ({ outcome: "accepted" })),
      signal
    )).resolves.toBe(false);

    const captured: unknown[] = [];
    const complexClient = clientWith(async (...arguments_) => {
      captured.push(arguments_);
      return {
        outcome: "accepted",
        answers: {
          "Pick tools": ["TypeScript", "Other", "Rust"],
          "No selection": []
        },
        annotations: {
          "Release name": { notes: "v0.1.4" }
        }
      };
    });
    await expect(forwarder.requestStructuredUserInput(resolved, toolRequest({
      questions: [
        null,
        { question: " " },
        {
          question: " Pick tools ",
          options: [null, { label: " " }, { label: "TypeScript" }, { label: "Rust", description: "Use Rust" }],
          multiSelect: true
        },
        { id: "release", header: "Release", question: "Release name", options: "invalid" },
        { question: "No selection", options: [] },
        { question: "Sliced question" }
      ]
    }), complexClient, signal)).resolves.toBe(true);
    expect(captured[0]).toEqual(expect.arrayContaining([
      "_x.ai/ask_user_question",
      expect.objectContaining({
        mode: "plan",
        questions: expect.arrayContaining([
          expect.objectContaining({
            id: "question_3",
            header: "Question",
            multiSelect: true,
            options: [
              { label: "TypeScript", description: "TypeScript" },
              { label: "Rust", description: "Use Rust" }
            ]
          })
        ])
      })
    ]));
    expect(commands.at(-1)).toEqual({
      type: "follow_up",
      sessionId: "runtime-session",
      text: "User answers:\n- Pick tools: TypeScript, Rust\n- Release name: v0.1.4\n- No selection: No answer provided"
    });

    await expect(forwarder.requestStructuredUserInput(
      resolved,
      toolRequest({ message: " Continue? " }),
      clientWith(async () => ({
        outcome: "accepted",
        answers: { "Continue?": ["Yes"] }
      })),
      signal
    )).resolves.toBe(true);
    expect(commands.at(-1)).toMatchObject({ text: "Yes" });

    await expect(forwarder.requestStructuredUserInput(
      resolved,
      toolRequest({ message: "Continue?" }),
      clientWith(async () => ({ outcome: "cancelled" })),
      signal
    )).resolves.toBe(false);
    await expect(forwarder.requestStructuredUserInput(
      resolved,
      toolRequest({ message: "Continue?" }),
      clientWith(async () => { throw new Error("Extension unavailable"); }),
      signal
    )).resolves.toBe(false);

    const aborted = new AbortController();
    aborted.abort(new Error("Prompt cancelled"));
    await expect(forwarder.requestStructuredUserInput(
      resolved,
      toolRequest({ message: "Continue?" }),
      clientWith(async () => { throw aborted.signal.reason; }),
      aborted.signal
    )).rejects.toThrow("Prompt cancelled");
  });

  it("maps every approval response and honors cancellation", async () => {
    const forwarder = new SigmaAcpInteractionForwarder();
    const { resolved, commands } = resolvedSession();
    const approval = approvalRequest();
    const activeSignal = new AbortController().signal;

    for (const [outcome, expected] of [
      [{ outcome: { outcome: "selected", optionId: "always_allow" } }, "always_allow"],
      [{ outcome: { outcome: "selected", optionId: "allow" } }, "allow"],
      [{ outcome: { outcome: "selected", optionId: "unexpected" } }, "deny"],
      [{ outcome: { outcome: "cancelled" } }, "deny"]
    ] as const) {
      await forwarder.requestToolApproval(
        resolved,
        approval,
        clientWith(async () => outcome),
        activeSignal
      );
      expect(commands.at(-1)).toMatchObject({ type: "approve", decision: expected });
    }

    await expect(forwarder.requestToolApproval(
      resolved,
      approval,
      clientWith(async () => { throw new Error("Permission request failed"); }),
      activeSignal
    )).rejects.toThrow("Permission request failed");

    const preAborted = new AbortController();
    preAborted.abort(new Error("Already cancelled"));
    await expect(forwarder.requestToolApproval(
      resolved,
      approval,
      clientWith(async () => ({ outcome: { outcome: "cancelled" } })),
      preAborted.signal
    )).rejects.toThrow("Already cancelled");

    const pendingAbort = new AbortController();
    const pending = forwarder.requestToolApproval(
      resolved,
      approval,
      clientWith(async () => await new Promise<never>(() => undefined)),
      pendingAbort.signal
    );
    pendingAbort.abort(new Error("Cancelled while waiting"));
    await expect(pending).rejects.toThrow("Cancelled while waiting");
  });
});
