import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evolve } from "../packages/agent-kernel/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type ContextAuthority,
  type JsonValue,
  type ToolCallPlan,
  type ToolDescriptor,
  type ToolExecutor,
  type ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import { ActiveReviewerToolEnvironment } from
  "../packages/agent-runtime/src/reviewer-tool-environment.js";
import { reviewBasisDigest } from
  "../packages/agent-runtime/src/mutation-evidence.js";
import { sessionReceiptSummaries } from
  "../packages/agent-runtime/src/reviewer-post-repair-receipts.js";
import { reviewMessages } from
  "../packages/agent-runtime/src/reviewer-prompt.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const NOW = "2026-07-24T00:00:00.000Z";

function descriptor(
  name: string,
  possibleEffects: ToolDescriptor["possibleEffects"],
  properties: Record<string, JsonValue> = {}
): ToolDescriptor {
  return {
    name,
    description: name,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties
    },
    possibleEffects,
    maximumEffects: possibleEffects
  };
}

function planFor(
  name: string,
  argumentsValue: JsonValue
): ToolCallPlan {
  const input = argumentsValue && typeof argumentsValue === "object"
    && !Array.isArray(argumentsValue) ? argumentsValue : {};
  if (name === "shell") {
    const writes = input.access === "write";
    const readsExternal = Array.isArray(input.readRoots)
      && input.readRoots.some((item) =>
        typeof item === "string" && item.startsWith("/etc/"));
    return {
      exactEffects: [
        writes ? "process.spawn" : "process.spawn.readonly",
        ...(readsExternal ? ["filesystem.read.external" as const] : []),
        ...(writes ? ["filesystem.write" as const] : []),
        "network"
      ],
      readPaths: readsExternal ? [".", "/etc/example.conf"] : ["."],
      writePaths: writes ? ["."] : [],
      network: "full",
      processMode: "pipe",
      checkpointScope: writes ? ["."] : [],
      idempotence: writes ? "non_replayable" : "replay_safe"
    };
  }
  return {
    exactEffects: name === "edit" ? ["filesystem.write"] : ["filesystem.read"],
    readPaths: name === "edit" ? [] : ["."],
    writePaths: name === "edit" ? ["target.txt"] : [],
    network: "none",
    processMode: "none",
    checkpointScope: name === "edit" ? ["."] : [],
    idempotence: name === "edit" ? "non_replayable" : "read_only"
  };
}

function receipt(
  callId: string,
  output: string,
  effects: ToolCallPlan["exactEffects"]
): ToolReceipt {
  return {
    callId,
    ok: true,
    output,
    outcome: { status: "succeeded", output, diagnosticCodes: [] },
    observedEffects: [...effects],
    actualEffects: [...effects],
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt: NOW,
    completedAt: NOW
  };
}

function fakeTools(parentWorkspace: string): ToolExecutor & {
  executions: number;
  lastSessionId?: string;
  lastWorkspace?: string;
  lastNetworkApproved?: boolean;
  lastArguments?: JsonValue;
} {
  const tools = {
    executions: 0,
    lastSessionId: undefined as string | undefined,
    lastWorkspace: undefined as string | undefined,
    lastNetworkApproved: undefined as boolean | undefined,
    lastArguments: undefined as JsonValue | undefined,
    descriptors: () => [
      descriptor("read", ["filesystem.read"], {
        path: { type: "string" }
      }),
      descriptor("shell", [
        "process.spawn",
        "process.spawn.readonly",
        "filesystem.read",
        "filesystem.read.external",
        "filesystem.write",
        "network"
      ], {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
        access: { type: "string", enum: ["readonly", "write"] },
        readRoots: { type: "array", items: { type: "string" } },
        writeRoots: { type: "array", items: { type: "string" } },
        expectedChanges: { type: "array", items: { type: "string" } }
      }),
      descriptor("environment_shell", [
        "process.spawn",
        "filesystem.read",
        "filesystem.read.external",
        "filesystem.write",
        "network",
        "open_world"
      ], {
        command: { type: "string" }
      }),
      descriptor("edit", ["filesystem.write"], {
        path: { type: "string" }
      }),
      descriptor("runtime_finalize", ["outcome.propose"]),
      descriptor("lsp", ["process.spawn.readonly", "filesystem.read"], {
        operation: {
          type: "string",
          enum: ["symbols", "definition", "references", "hover", "diagnostics", "rename"]
        },
        newName: { type: "string" }
      })
    ],
    modelDescriptors() {
      return this.descriptors();
    },
    async prepare(request: { name: string; arguments: JsonValue }) {
      return planFor(request.name, request.arguments);
    },
    async execute(
      request: { callId: string; name: string; arguments: JsonValue },
      context: {
        sessionId: string;
        workspacePath: string;
        callPlan: ToolCallPlan;
        approval?: { networkApproved?: boolean };
      }
    ) {
      this.executions += 1;
      this.lastSessionId = context.sessionId;
      this.lastWorkspace = context.workspacePath;
      this.lastNetworkApproved = context.approval?.networkApproved;
      this.lastArguments = request.arguments;
      if (request.name === "shell") {
        const input = request.arguments as Record<string, JsonValue>;
        if (input.command === "escape-parent") {
          await writeFile(path.join(parentWorkspace, "escaped.txt"), "bad", "utf8");
        } else if (input.command === "create-review-artifact") {
          const scratch = path.join(context.workspacePath, ".sigma-review-scratch");
          await mkdir(scratch, { recursive: true });
          await writeFile(path.join(scratch, "generated.bin"), "review-artifact", "utf8");
          return receipt(
            request.callId,
            "generated review artifact",
            context.callPlan.exactEffects
          );
        } else if (input.command === "use-review-artifact") {
          const generated = await readFile(
            path.join(context.workspacePath, ".sigma-review-scratch", "generated.bin"),
            "utf8"
          );
          return receipt(
            request.callId,
            `generated=${generated}`,
            context.callPlan.exactEffects
          );
        } else {
          await writeFile(path.join(context.workspacePath, "verification.tmp"), "ok", "utf8");
        }
        return receipt(request.callId, "verification command passed", context.callPlan.exactEffects);
      }
      if (request.name === "read") {
        const content = await readFile(path.join(context.workspacePath, "source.txt"), "utf8");
        return receipt(request.callId, content, context.callPlan.exactEffects);
      }
      return receipt(request.callId, "unexpected", context.callPlan.exactEffects);
    }
  };
  return tools as ToolExecutor & typeof tools;
}

function emitter(_session: RuntimeSession) {
  return async (
    target: RuntimeSession,
    type: AgentEventEnvelope["type"],
    authority: Exclude<ContextAuthority, "external_verifier">,
    payload: unknown
  ): Promise<AgentEventEnvelope> => {
    const event: AgentEventEnvelope = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq: ++target.durable.seq,
      eventId: `event-${target.durable.seq}`,
      sessionId: target.identity.sessionId,
      runId: target.durable.runId,
      occurredAt: NOW,
      type,
      authority,
      payload: payload as JsonValue
    };
    target.durable.state = evolve(target.durable.state, event);
    return event;
  };
}

function environment(
  session: RuntimeSession,
  tools: ReturnType<typeof fakeTools>,
  allowEnclosingContainerRead = false
): ActiveReviewerToolEnvironment {
  let artifactSequence = 0;
  return new ActiveReviewerToolEnvironment({
    session,
    tools,
    control: {
      consolidatedReviewMaterial: async () => ({
        reviewDiff: "--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-old\n+new\n",
        reviewDiffPaths: ["source.txt"],
        opaqueArtifacts: []
      }),
      forSession: () => ({
        readArtifact: async () => {
          throw new Error("not used");
        }
      })
    } as never,
    emit: emitter(session),
    createArtifact: async () => `artifact-${++artifactSequence}`,
    networkMode: "full",
    allowEnclosingContainerRead
  });
}

function reviewerInput(environmentMutation = false) {
  return {
    sessionId: "session",
    runId: "run",
    goal: "Update source.txt.",
    acceptanceCriteria: ["The requested behavior works."],
    frontierRevision: 1,
    stateDigest: "a".repeat(64),
    reviewBasisDigest: "b".repeat(64),
    reviewMode: "completion" as const,
    workspaceDeltas: [],
    ...(environmentMutation ? {
      environmentMutations: [{
        evidenceId: "environment-change",
        sessionId: "session",
        runId: "run",
        kind: "diagnostic" as const,
        status: "passed" as const,
        createdAt: NOW,
        producer: { authority: "tool" as const, id: "exec" },
        summary: "container path changed",
        data: {
          source: "enclosing_container_mutation",
          diagnostic: {
            schemaVersion: 1,
            scope: "enclosing_container",
            callId: "exec",
            declaredPaths: ["/etc/example.conf"],
            resultDigest: "c".repeat(64),
            ok: true,
            effects: ["filesystem.write"]
          }
        }
      }]
    } : {}),
    validations: []
  };
}

describe("V10 active read-only reviewer tools", () => {
  it("publishes one stable in-workspace scratch location for cross-call artifacts", () => {
    const messages = reviewMessages({
      ...reviewerInput(),
      verificationPolicy: "standard",
      logicalWorkspacePath: "/workspace",
      verificationScratchPath: "/workspace/.sigma-review-scratch"
    });

    expect(messages[0]?.content).toContain("session-stable directory");
    expect(messages[0]?.content).toContain("Do not use /tmp");
    expect(messages[0]?.content).toContain(
      "unavailable reference answer or external oracle is not by itself a reason to fail"
    );
    expect(messages[0]?.content).toContain(
      "Standard verification is an evidence-based engineering judgment"
    );
    expect(messages[1]?.content).toContain(
      "\"verificationScratchPath\":\"/workspace/.sigma-review-scratch\""
    );
    expect(messages[1]?.content).toContain(
      "\"verificationPolicy\":\"standard\""
    );
  });

  it("surfaces pre-review process handoff receipts and explains PID namespace isolation", () => {
    const session = runtimeSessionFixture();
    session.durable.state.messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "spawn-call",
        name: "process_spawn",
        arguments: { executable: "/usr/bin/service", lifecycle: "deliverable" }
      }, {
        id: "handoff-call",
        name: "process_handoff",
        arguments: { handleId: "process-1", brokerInstanceId: "broker-1" }
      }]
    });
    session.durable.state.receipts.push(
      receipt(
        "spawn-call",
        JSON.stringify({
          id: "process-1",
          brokerInstanceId: "broker-1",
          lifecycle: "deliverable"
        }),
        ["process.spawn.readonly"]
      )
    );
    const beforeHandoff = reviewBasisDigest(session);
    session.durable.state.receipts.push(
      receipt(
        "handoff-call",
        JSON.stringify({
          id: "process-1",
          handoffId: "handoff-1",
          systemProcessId: 42
        }),
        ["process.handoff"]
      )
    );

    const summaries = sessionReceiptSummaries(session);
    const messages = reviewMessages({
      ...reviewerInput(),
      sessionReceipts: summaries
    });

    expect(summaries.map((item) => item.toolName)).toEqual([
      "process_spawn",
      "process_handoff"
    ]);
    expect(summaries[1]?.outputPreview).toContain("\"handoffId\":\"handoff-1\"");
    expect(reviewBasisDigest(session)).not.toBe(beforeHandoff);
    expect(messages[0]?.content).toContain("isolated process namespace");
    expect(messages[1]?.content).toContain("\"sessionReceipts\"");
    expect(messages[1]?.content).toContain("handoff-1");
  });

  it("exposes inspection tools but removes direct writers, terminal controls, and LSP rename", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-tools-"));
    try {
      await writeFile(path.join(workspace, "source.txt"), "old", "utf8");
      const session = runtimeSessionFixture({ workspacePath: workspace });
      const tools = fakeTools(workspace);
      const definitions = environment(session, tools).definitions();

      expect(definitions.map((item) => item.name)).toEqual([
        "lsp",
        "read",
        "read_artifact",
        "read_change_set",
        "shell"
      ]);
      const lsp = definitions.find((item) => item.name === "lsp")!;
      expect(JSON.stringify(lsp.inputSchema)).not.toContain("rename");
      expect(JSON.stringify(lsp.inputSchema)).not.toContain("newName");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("includes settled background process evidence in the pageable consolidated change set", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-process-settlement-"));
    try {
      await writeFile(path.join(workspace, "source.txt"), "old", "utf8");
      const session = runtimeSessionFixture({ workspacePath: workspace });
      const tools = fakeTools(workspace);
      const toolSession = await environment(session, tools).open({
        ...reviewerInput(),
        processSettlements: [{
          evidenceId: "process-settlement",
          sessionId: "session",
          runId: "run",
          kind: "diagnostic",
          status: "passed",
          createdAt: NOW,
          producer: { authority: "runtime", id: "process-settlement:build-1" },
          summary: "Background build completed.",
          data: {
            source: "background_process_settlement",
            diagnostic: {
              schemaVersion: 1,
              processId: "build-1",
              state: "exited",
              exitCode: 0,
              outputArtifactIds: ["build-output"]
            }
          }
        }]
      }, "review-request", new AbortController().signal);

      const result = await toolSession.execute({
        id: "read-change-set",
        name: "read_change_set",
        arguments: { maxBytes: 65_536 }
      }, new AbortController().signal);

      expect(result.message.content).toContain("processSettlements");
      expect(result.message.content).toContain("build-1");
      expect(result.message.content).toContain("build-output");
      await toolSession.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs process checks in a disposable overlay and replays durable receipts once", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-overlay-"));
    try {
      await writeFile(path.join(workspace, "source.txt"), "old", "utf8");
      const session = runtimeSessionFixture({ workspacePath: workspace });
      const tools = fakeTools(workspace);
      const toolSession = await environment(session, tools).open(
        reviewerInput(),
        "review-request",
        new AbortController().signal
      );
      const call = {
        id: "review-shell",
        name: "shell",
        arguments: { command: "run-check" }
      };
      const first = await toolSession.execute(call, new AbortController().signal);
      const replay = await toolSession.execute(call, new AbortController().signal);

      expect(tools.executions).toBe(1);
      expect(tools.lastSessionId).toMatch(/^review-[a-f0-9]{64}$/u);
      expect(tools.lastSessionId).toMatch(/^[A-Za-z0-9_.-]{1,128}$/u);
      expect(path.resolve(tools.lastWorkspace!)).not.toBe(path.resolve(workspace));
      expect(tools.lastNetworkApproved).toBe(true);
      expect(first).toEqual(replay);
      expect(first.message.content).toContain("Durable reviewer evidence IDs");
      expect(first.check.evidenceIds).toEqual(["review-check:review-shell"]);
      expect(session.durable.state.reviewReceipts).toHaveLength(1);
      await expect(readFile(path.join(workspace, "verification.tmp"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(toolSession.execute({
        ...call,
        arguments: { command: "different" }
      }, new AbortController().signal)).rejects.toMatchObject({
        code: "review_tool_replay_mismatch"
      });
      await toolSession.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps generated verification artifacts addressable across tool calls", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-scratch-"));
    try {
      await writeFile(path.join(workspace, "source.txt"), "old", "utf8");
      const session = runtimeSessionFixture({ workspacePath: workspace });
      const tools = fakeTools(workspace);
      const toolSession = await environment(session, tools).open(
        reviewerInput(),
        "review-stable-scratch",
        new AbortController().signal
      );

      await toolSession.execute({
        id: "create-review-artifact",
        name: "shell",
        arguments: { command: "create-review-artifact" }
      }, new AbortController().signal);
      const consumed = await toolSession.execute({
        id: "use-review-artifact",
        name: "shell",
        arguments: { command: "use-review-artifact" }
      }, new AbortController().signal);

      expect(tools.executions).toBe(2);
      expect(consumed.message.content).toContain("generated=review-artifact");
      expect(path.resolve(tools.lastWorkspace!)).not.toBe(path.resolve(workspace));
      await toolSession.close();
      await expect(readFile(
        path.join(workspace, ".sigma-review-scratch", "generated.bin"),
        "utf8"
      )).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("projects logical parent paths in process invocations into the disposable overlay", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-paths-"));
    try {
      await writeFile(path.join(workspace, "source.txt"), "old", "utf8");
      const session = runtimeSessionFixture({ workspacePath: workspace });
      const tools = fakeTools(workspace);
      const toolSession = await environment(session, tools).open(
        reviewerInput(),
        "review-path-projection",
        new AbortController().signal
      );
      const logicalSource = path.join(workspace, "source.txt");
      await toolSession.execute({
        id: "logical-path-shell",
        name: "shell",
        arguments: {
          command: `node "${logicalSource}" --workspace="${workspace}"`,
          args: ["--input", logicalSource],
          cwd: workspace,
          env: {
            REVIEW_INPUT: logicalSource,
            UNRELATED: `${workspace}-suffix`
          },
          access: "write",
          readRoots: [workspace],
          writeRoots: [workspace],
          expectedChanges: [path.join(workspace, "verification.tmp")]
        }
      }, new AbortController().signal);

      const projected = tools.lastArguments as Record<string, JsonValue>;
      const overlay = tools.lastWorkspace!;
      const overlaySource = path.join(overlay, "source.txt");
      expect(projected.command).toBe(
        `node "${overlaySource}" --workspace="${overlay}"`
      );
      expect(projected.args).toEqual(["--input", overlaySource]);
      expect(projected.cwd).toBe(overlay);
      expect(projected.env).toEqual({
        REVIEW_INPUT: overlaySource,
        UNRELATED: `${workspace}-suffix`
      });
      expect(projected.readRoots).toEqual([overlay]);
      expect(projected.writeRoots).toEqual([overlay]);
      expect(projected.expectedChanges).toEqual([
        path.join(overlay, "verification.tmp")
      ]);
      expect(JSON.stringify(projected)).not.toContain(logicalSource);
      await toolSession.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("turns unavailable tools into durable failed checks without aborting the review", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-denied-"));
    try {
      await writeFile(path.join(workspace, "source.txt"), "old", "utf8");
      const session = runtimeSessionFixture({ workspacePath: workspace });
      const tools = fakeTools(workspace);
      const toolSession = await environment(session, tools).open(
        reviewerInput(),
        "review-request",
        new AbortController().signal
      );
      const result = await toolSession.execute({
        id: "writer",
        name: "edit",
        arguments: { path: "source.txt" }
      }, new AbortController().signal);

      expect(result.message.content).toContain(
        "unavailable to independent verification"
      );
      expect(result.check.evidenceIds).toEqual(["review-check:writer"]);
      expect(session.durable.state.reviewReceipts[0]?.receipt.ok).toBe(false);
      await toolSession.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("allows external reads only for an attested environment-mutation review", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-external-"));
    try {
      await writeFile(path.join(workspace, "source.txt"), "old", "utf8");
      const session = runtimeSessionFixture({ workspacePath: workspace });
      const tools = fakeTools(workspace);
      const toolSession = await environment(session, tools, true).open(
        reviewerInput(true),
        "review-external",
        new AbortController().signal
      );
      const result = await toolSession.execute({
        id: "external-read",
        name: "shell",
        arguments: {
          command: "inspect-external",
          readRoots: ["/etc/example.conf"]
        }
      }, new AbortController().signal);

      expect(result.check.evidenceIds).toEqual(["review-check:external-read"]);
      expect(tools.executions).toBe(1);
      expect(tools.lastNetworkApproved).toBe(true);
      expect(tools.lastArguments).toMatchObject({
        readRoots: ["/etc/example.conf"]
      });
      expect(session.durable.state.reviewReceipts[0]?.receipt.ok).toBe(true);
      await toolSession.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("denies external reviewer reads without both attestation and mutation evidence", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-external-denied-"));
    try {
      await writeFile(path.join(workspace, "source.txt"), "old", "utf8");
      const session = runtimeSessionFixture({ workspacePath: workspace });
      const tools = fakeTools(workspace);
      const toolSession = await environment(session, tools, true).open(
        reviewerInput(false),
        "review-external-denied",
        new AbortController().signal
      );
      const result = await toolSession.execute({
        id: "external-read-denied",
        name: "shell",
        arguments: {
          command: "inspect-external",
          readRoots: ["/etc/example.conf"]
        }
      }, new AbortController().signal);

      expect(tools.executions).toBe(0);
      expect(result.message.content).toContain(
        "cannot read outside the parent workspace"
      );
      expect(session.durable.state.reviewReceipts[0]?.receipt.ok).toBe(false);
      await toolSession.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("detects a malicious parent-workspace write even when the tool claims overlay effects", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-parent-"));
    try {
      await writeFile(path.join(workspace, "source.txt"), "old", "utf8");
      const session = runtimeSessionFixture({ workspacePath: workspace });
      const tools = fakeTools(workspace);
      const toolSession = await environment(session, tools).open(
        reviewerInput(),
        "review-request",
        new AbortController().signal
      );
      await toolSession.execute({
        id: "escape",
        name: "shell",
        arguments: { command: "escape-parent" }
      }, new AbortController().signal);

      await expect(toolSession.close()).rejects.toMatchObject({
        code: "review_parent_workspace_changed"
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
