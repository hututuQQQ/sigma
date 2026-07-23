import type {
  ModelToolCall,
  ToolCallPlan,
  ToolDescriptor,
  ToolEffect
} from "../packages/agent-protocol/src/index.js";
import { ToolApprovalCoordinator } from "../packages/agent-runtime/src/tool-approval-coordinator.js";
import { repositoryRecoveryObligation } from "../packages/agent-kernel/src/index.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";
import { describe, expect, it, vi } from "vitest";

const call: ModelToolCall = {
  id: "terminal-call",
  name: "terminal_tool",
  arguments: {}
};

function descriptor(
  possibleEffects: ToolEffect[],
  approval: ToolDescriptor["approval"] = "prompt",
  maximumEffects?: ToolEffect[]
): ToolDescriptor {
  return {
    name: call.name,
    description: "Test terminal protocol approval.",
    inputSchema: { type: "object" },
    possibleEffects,
    ...(maximumEffects ? { maximumEffects } : {}),
    executionMode: "sequential",
    resourceKeys: ["run:outcome"],
    approval,
    idempotent: true,
    timeoutMs: 5_000
  };
}

function plan(exactEffects: ToolEffect[], network: ToolCallPlan["network"] = "none"): ToolCallPlan {
  return {
    exactEffects,
    readPaths: [],
    writePaths: [],
    network,
    processMode: "none",
    checkpointScope: [],
    idempotence: "read_only"
  };
}

async function decision(
  tool: ToolDescriptor,
  callPlan: ToolCallPlan
): Promise<{ result: "allow" | "deny" | "always_allow"; emit: ReturnType<typeof vi.fn> }> {
  const emit = vi.fn(async () => ({}));
  const coordinator = new ToolApprovalCoordinator({
    runtime: { permissionMode: "deny" } as never,
    emit: emit as never
  });
  const session: RuntimeSession = runtimeSessionFixture();
  const result = await coordinator.decision(session, {
    call,
    modelTurn: { turnId: 1, effectRevision: 1 },
    descriptor: tool,
    plan: callPlan
  }, new AbortController().signal);
  return { result, emit };
}

describe("deny-mode internal terminal approval", () => {
  it.each([
    ["completion", ["outcome.propose"]],
    ["input request", ["outcome.request_input"]],
    ["combined internal protocol", ["outcome.propose", "outcome.request_input"]]
  ] as const)("allows a pure %s tool without prompting", async (_label, effects) => {
    const outcome = await decision(
      descriptor([...effects]),
      plan([...effects])
    );

    expect(outcome.result).toBe("allow");
    expect(outcome.emit).not.toHaveBeenCalled();
  });

  it.each([
    ["external", ["filesystem.read"]],
    ["mixed", ["outcome.propose", "filesystem.read"]]
  ] as const)("continues to deny a %s tool", async (_label, effects) => {
    const outcome = await decision(
      descriptor([...effects]),
      plan([...effects])
    );

    expect(outcome.result).toBe("deny");
    expect(outcome.emit).not.toHaveBeenCalled();
  });

  it("denies external authority in either the maximum or planned effects", async () => {
    const maximum = await decision(
      descriptor(["outcome.propose"], "prompt", ["outcome.propose", "filesystem.write"]),
      plan(["outcome.propose"])
    );
    const planned = await decision(
      descriptor(["outcome.propose"]),
      plan(["outcome.propose", "network"], "full")
    );

    expect(maximum.result).toBe("deny");
    expect(planned.result).toBe("deny");
    expect(maximum.emit).not.toHaveBeenCalled();
    expect(planned.emit).not.toHaveBeenCalled();
  });

  it("keeps descriptor approval=deny authoritative for a pure terminal tool", async () => {
    const outcome = await decision(
      descriptor(["outcome.request_input"], "deny"),
      plan(["outcome.request_input"])
    );

    expect(outcome.result).toBe("deny");
    expect(outcome.emit).not.toHaveBeenCalled();
  });
});

describe("sensitive external-read and handoff approval", () => {
  it("workspace-auto issues a bound automatic grant for an authenticated recovery transaction", async () => {
    const emit = vi.fn(async () => ({}));
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "workspace-auto", interactiveApprovals: false } as never,
      emit: emit as never,
      finish: vi.fn() as never
    });
    const session = runtimeSessionFixture();
    const candidateId = "c".repeat(64);
    const selectionEvidenceId = "repository-recovery-selection:selection";
    session.durable.state.taskControl = repositoryRecoveryObligation(
      session.durable.state.taskControl,
      session.durable.state.revision,
      "transact",
      { candidateId, selectionEvidenceId },
      { candidateId, selectionEvidenceId }
    );
    const recoveryCall: ModelToolCall = {
      id: "recover",
      name: "git_transaction",
      arguments: { action: "recover", candidateId, selectionEvidenceId }
    };
    const recoveryDescriptor: ToolDescriptor = {
      ...descriptor(["repository.write", "filesystem.write", "destructive"]),
      name: "git_transaction",
      brokerMutationAuthority: "repository_transaction_v2"
    };
    const recoveryPlan: ToolCallPlan = {
      ...plan(["repository.write", "filesystem.write", "destructive"]),
      mutationAuthority: "broker_repository_transaction_v2",
      writePaths: ["."],
      idempotence: "non_replayable"
    };
    const prepared = {
      call: recoveryCall,
      modelTurn: { turnId: 1, effectRevision: 1 },
      descriptor: recoveryDescriptor,
      plan: recoveryPlan
    };

    await expect(coordinator.decision(
      session, prepared, new AbortController().signal
    )).resolves.toBe("allow");
    expect(coordinator.consume(session, prepared)).toMatchObject({ authority: "runtime" });
    expect(emit).toHaveBeenCalledWith(
      session,
      "tool.approval_requested",
      "runtime",
      expect.objectContaining({ approvalMode: "automatic", toolName: "git_transaction" })
    );
  });

  it("workspace-auto automatically continues only the bound recovery conflict paths", async () => {
    const emit = vi.fn(async () => ({}));
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "workspace-auto", interactiveApprovals: false } as never,
      emit: emit as never,
      finish: vi.fn() as never
    });
    const session = runtimeSessionFixture();
    session.durable.state.taskControl = repositoryRecoveryObligation(
      session.durable.state.taskControl,
      session.durable.state.revision,
      "transact",
      { conflict: "pending" },
      { transactionId: "bound-transaction", scopePaths: ["src/conflict.ts"] }
    );
    const continuationCall: ModelToolCall = {
      id: "continue",
      name: "git_transaction",
      arguments: {
        action: "continue",
        transactionHandle: "bound-transaction",
        operations: [{ op: "add", paths: ["src/conflict.ts"] }]
      }
    };
    const continuationDescriptor: ToolDescriptor = {
      ...descriptor(["repository.write", "filesystem.write"]),
      name: "git_transaction",
      brokerMutationAuthority: "repository_transaction_v2"
    };
    const continuationPlan: ToolCallPlan = {
      ...plan(["repository.write", "filesystem.write"]),
      mutationAuthority: "broker_repository_transaction_v2",
      writePaths: ["."],
      idempotence: "non_replayable"
    };
    const prepared = {
      call: continuationCall,
      modelTurn: { turnId: 1, effectRevision: 1 },
      descriptor: continuationDescriptor,
      plan: continuationPlan
    };

    await expect(coordinator.decision(
      session, prepared, new AbortController().signal
    )).resolves.toBe("allow");
    expect(coordinator.consume(session, prepared)).toMatchObject({ authority: "runtime" });
    expect(emit).toHaveBeenCalledWith(
      session,
      "tool.approval_requested",
      "runtime",
      expect.objectContaining({ approvalMode: "automatic", toolName: "git_transaction" })
    );
  });

  it("workspace-auto does not auto-approve an off-scope recovery continuation", async () => {
    const emit = vi.fn(async () => ({}));
    const finish = vi.fn(async () => true);
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "workspace-auto", interactiveApprovals: false } as never,
      emit: emit as never,
      finish: finish as never
    });
    const session = runtimeSessionFixture();
    session.durable.state.taskControl = repositoryRecoveryObligation(
      session.durable.state.taskControl,
      session.durable.state.revision,
      "transact",
      { conflict: "pending" },
      { transactionId: "bound-transaction", scopePaths: ["src/conflict.ts"] }
    );
    const prepared = {
      call: {
        id: "continue-off-scope",
        name: "git_transaction",
        arguments: {
          action: "continue",
          transactionHandle: "bound-transaction",
          operations: [{ op: "add", paths: ["src/unrelated.ts"] }]
        }
      },
      modelTurn: { turnId: 1, effectRevision: 1 },
      descriptor: {
        ...descriptor(["repository.write", "filesystem.write"]),
        name: "git_transaction",
        brokerMutationAuthority: "repository_transaction_v2" as const
      },
      plan: {
        ...plan(["repository.write", "filesystem.write"]),
        mutationAuthority: "broker_repository_transaction_v2" as const,
        writePaths: ["."],
        idempotence: "non_replayable" as const
      }
    };

    await expect(coordinator.decision(
      session, prepared, new AbortController().signal
    )).rejects.toMatchObject({ code: "approval_needs_input" });
    expect(finish).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ kind: "needs_input" }),
      undefined,
      expect.any(Object)
    );
  });

  it("workspace-auto permits local writes but prompts for authority expansion", async () => {
    const emit = vi.fn(async () => ({}));
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "workspace-auto", interactiveApprovals: true } as never,
      emit: emit as never,
      finish: vi.fn() as never
    });
    const session = runtimeSessionFixture();
    const localWrite = {
      call,
      modelTurn: { turnId: 1, effectRevision: 1 },
      descriptor: descriptor(["filesystem.write"]),
      plan: plan(["filesystem.write"])
    };
    await expect(coordinator.decision(
      session, localWrite, new AbortController().signal
    )).resolves.toBe("allow");
    expect(emit).not.toHaveBeenCalled();

    for (const [effect, network] of [
      ["filesystem.read.external", "none"],
      ["repository.write", "none"],
      ["destructive", "none"],
      ["checkpoint.restore", "none"],
      ["process.handoff", "none"],
      ["network", "full"]
    ] as const) {
      const sensitivePlan = plan([effect], network);
      const pending = coordinator.decision(session, {
        call,
        modelTurn: { turnId: 1, effectRevision: 1 },
        descriptor: descriptor([effect]),
        plan: sensitivePlan
      }, new AbortController().signal);
      await vi.waitFor(() => expect(session.interaction.approvals.has(call.id)).toBe(true));
      const waiter = session.interaction.approvals.get(call.id)!;
      session.interaction.approvals.delete(call.id);
      waiter.resolve("deny");
      await expect(pending).resolves.toBe("deny");
    }
    expect(emit).toHaveBeenCalledWith(
      session,
      "tool.approval_requested",
      "runtime",
      expect.objectContaining({ approvalMode: "human" })
    );
  });

  it.each([
    ["external read", "filesystem.read.external", "externalReadApproved"],
    ["process handoff", "process.handoff", "processHandoffApproved"]
  ] as const)("prompts for every %s call in ask mode and consumes a fresh bound grant", async (
    _label,
    effect,
    approvalField
  ) => {
    const emit = vi.fn(async () => ({}));
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "ask", interactiveApprovals: true } as never,
      emit: emit as never,
      finish: vi.fn() as never
    });
    const session = runtimeSessionFixture();
    const sensitivePlan = plan([effect]);
    const pending = coordinator.decision(session, {
      call,
      modelTurn: { turnId: 1, effectRevision: 1 },
      descriptor: descriptor([effect]),
      plan: sensitivePlan
    }, new AbortController().signal);
    await vi.waitFor(() => expect(session.interaction.approvals.has(call.id)).toBe(true));
    const waiter = session.interaction.approvals.get(call.id)!;
    session.interaction.callApprovals.set(call.id, {
      ...waiter.binding,
      authority: "user",
      networkApproved: false,
      externalReadApproved: effect === "filesystem.read.external",
      processHandoffApproved: effect === "process.handoff",
      openWorldApproved: false
    });
    session.interaction.approvals.delete(call.id);
    waiter.resolve("allow");

    await expect(pending).resolves.toBe("allow");
    expect(coordinator.consume(session, {
      call,
      modelTurn: { turnId: 1, effectRevision: 1 },
      descriptor: descriptor([effect]),
      plan: sensitivePlan
    })).toMatchObject({ [approvalField]: true, authority: "user" });
    expect(emit).toHaveBeenCalledWith(
      session,
      "tool.approval_requested",
      "runtime",
      expect.objectContaining({ approvalMode: "human", effects: [effect] })
    );
  });

  it.each([
    ["filesystem.read.external", "externalReadApproved"],
    ["process.handoff", "processHandoffApproved"]
  ] as const)("auto mode issues a fresh runtime-bound %s grant", async (effect, approvalField) => {
    const emit = vi.fn(async () => ({}));
    const coordinator = new ToolApprovalCoordinator({
      runtime: { permissionMode: "auto" } as never,
      emit: emit as never,
      finish: vi.fn() as never
    });
    const session = runtimeSessionFixture();
    const sensitivePlan = plan([effect]);
    const prepared = {
      call,
      modelTurn: { turnId: 1, effectRevision: 1 },
      descriptor: descriptor([effect]),
      plan: sensitivePlan
    };

    await expect(coordinator.decision(
      session, prepared, new AbortController().signal
    )).resolves.toBe("allow");
    expect(coordinator.consume(session, prepared)).toMatchObject({
      [approvalField]: true,
      authority: "runtime"
    });
    expect(emit).toHaveBeenCalledWith(
      session,
      "tool.approval_requested",
      "runtime",
      expect.objectContaining({ approvalMode: "automatic", effects: [effect] })
    );
  });
});
