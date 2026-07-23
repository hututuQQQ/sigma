import { describe, expect, it, vi } from "vitest";
import type {
  ModelToolCall,
  ToolCallPlan,
  ToolDescriptor,
  ToolEffect
} from "../packages/agent-protocol/src/index.js";
import { ToolApprovalCoordinator } from "../packages/agent-runtime/src/tool-approval-coordinator.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const call: ModelToolCall = {
  id: "call",
  name: "tool",
  arguments: {}
};

function descriptor(
  effects: ToolEffect[],
  approval: ToolDescriptor["approval"] = "prompt",
  maximumEffects?: ToolEffect[]
): ToolDescriptor {
  return {
    name: call.name,
    description: "Approval test tool.",
    inputSchema: { type: "object" },
    possibleEffects: effects,
    ...(maximumEffects ? { maximumEffects } : {}),
    executionMode: "sequential",
    resourceKeys: ["workspace"],
    approval,
    idempotent: true,
    timeoutMs: 5_000
  };
}

function plan(effects: ToolEffect[], network: ToolCallPlan["network"] = "none"): ToolCallPlan {
  return {
    exactEffects: effects,
    readPaths: [],
    writePaths: effects.includes("filesystem.write") ? ["src/file.ts"] : [],
    network,
    processMode: "none",
    checkpointScope: effects.includes("filesystem.write") ? ["src/file.ts"] : [],
    idempotence: effects.includes("filesystem.write") ? "non_replayable" : "read_only"
  };
}

function prepared(tool: ToolDescriptor, callPlan: ToolCallPlan) {
  return {
    call,
    modelTurn: { turnId: 1, effectRevision: 1 },
    descriptor: tool,
    plan: callPlan
  };
}

describe("permission-only tool approval", () => {
  it("allows pure explicit terminal tools in deny mode without granting external authority", async () => {
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "deny" } as never,
      emit: vi.fn() as never
    });
    const session = runtimeSessionFixture();
    for (const effect of ["outcome.request_input", "outcome.report_blocked"] as const) {
      await expect(coordinator.decision(
        session,
        prepared(descriptor([effect]), plan([effect])),
        new AbortController().signal
      )).resolves.toBe("allow");
    }
    await expect(coordinator.decision(
      session,
      prepared(descriptor(["filesystem.read"]), plan(["filesystem.read"])),
      new AbortController().signal
    )).resolves.toBe("deny");
  });

  it("uses maximum and planned effects when checking authority", async () => {
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "deny" } as never,
      emit: vi.fn() as never
    });
    const session = runtimeSessionFixture();
    await expect(coordinator.decision(
      session,
      prepared(
        descriptor(["outcome.request_input"], "prompt", ["outcome.request_input", "filesystem.write"]),
        plan(["outcome.request_input"])
      ),
      new AbortController().signal
    )).resolves.toBe("deny");
    await expect(coordinator.decision(
      session,
      prepared(
        descriptor(["outcome.request_input"]),
        plan(["outcome.request_input", "network"], "full")
      ),
      new AbortController().signal
    )).resolves.toBe("deny");
  });

  it("keeps descriptor approval=deny authoritative", async () => {
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "auto" } as never,
      emit: vi.fn() as never
    });
    await expect(coordinator.decision(
      runtimeSessionFixture(),
      prepared(
        descriptor(["outcome.request_input"], "deny"),
        plan(["outcome.request_input"])
      ),
      new AbortController().signal
    )).resolves.toBe("deny");
  });

  it("allows local workspace writes in workspace-auto but requests approval for authority expansion", async () => {
    const emit = vi.fn(async () => ({}));
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "workspace-auto", interactiveApprovals: true } as never,
      emit: emit as never,
      finish: vi.fn() as never
    });
    const session = runtimeSessionFixture();
    await expect(coordinator.decision(
      session,
      prepared(descriptor(["filesystem.write"]), plan(["filesystem.write"])),
      new AbortController().signal
    )).resolves.toBe("allow");

    const pending = coordinator.decision(
      session,
      prepared(descriptor(["repository.write"]), plan(["repository.write"])),
      new AbortController().signal
    );
    await expect.poll(() => emit.mock.calls.length).toBeGreaterThan(0);
    const request = emit.mock.calls.find((args) => args[1] === "tool.approval_requested");
    expect(request).toBeDefined();
    session.interaction.approvals.get(request![3].requestId)!.resolve("deny");
    await expect(pending).resolves.toBe("deny");
  });

  it("does not auto-approve repository recovery from inferred semantic state", async () => {
    const finish = vi.fn(async () => true);
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "workspace-auto", interactiveApprovals: false } as never,
      emit: vi.fn() as never,
      finish: finish as never
    });
    const session = runtimeSessionFixture();
    await expect(coordinator.decision(
      session,
      prepared(descriptor(["repository.write"]), plan(["repository.write"])),
      new AbortController().signal
    )).rejects.toMatchObject({ code: "approval_needs_input" });
    expect(finish).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ kind: "needs_input" }),
      undefined,
      expect.any(Object)
    );
  });
});
