import type { ModelToolCall, ToolCallPlan, ToolDescriptor, ToolReceipt } from "agent-protocol";
import { isToolAllowed, prepareToolCallPlan } from "agent-tools";
import { failed } from "./effect-helpers.js";
import { turnPayload, type ToolAttempt } from "./effect-runner-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import { profileAllowsTool } from "./profile-policy.js";
import {
  parseReadBatchMembers,
  readBatchPlanAllowed,
  readBatchReceipt,
  type ReadBatchMember
} from "./read-batch-tool.js";
import { toolRuntimeContext } from "./repository-recovery-context.js";
import type { ToolReceiptRecorder } from "./tool-receipt-recorder.js";
import type { ToolTransactionRunner } from "./tool-transaction-runner.js";
import type { RuntimeSession } from "./types.js";

export type ReadBatchInstructionLoader = (
  session: RuntimeSession,
  call: ModelToolCall,
  descriptor: ToolDescriptor
) => Promise<{ failure?: ToolReceipt }>;

function errorCode(error: unknown, fallback: string): string {
  return typeof (error as { code?: unknown } | undefined)?.code === "string"
    ? (error as { code: string }).code
    : fallback;
}

export class ReadBatchExecutor {
  constructor(
    private readonly options: EffectRunnerOptions,
    private readonly transactions: ToolTransactionRunner,
    private readonly receipts: ToolReceiptRecorder,
    private readonly loadInstructions: ReadBatchInstructionLoader
  ) {}

  async execute(
    session: RuntimeSession,
    outer: ToolAttempt,
    modelDescriptors: readonly ToolDescriptor[],
    signal: AbortSignal
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    await this.options.emit(session, "tool.requested", "runtime", {
      callId: outer.call.id,
      name: outer.call.name,
      arguments: outer.call.arguments,
      ...turnPayload(outer.modelTurn)
    });
    const offered = modelDescriptors.filter((descriptor) =>
      isToolAllowed(descriptor, session.durable.mode)
      && profileAllowsTool(session, descriptor));
    let members: ReadBatchMember[];
    try {
      members = parseReadBatchMembers(outer.call, offered);
    } catch (error) {
      await this.receipts.record(session, failed(
        outer.call,
        startedAt,
        error instanceof Error ? error.message : String(error),
        errorCode(error, "tool_arguments_invalid")
      ), outer.modelTurn);
      return;
    }

    const memberReceipts: ToolReceipt[] = new Array(members.length);
    const pending = members.map((member, index) => ({ member, index }));
    while (pending.length > 0) {
      const batch = pending.splice(0, this.options.maxParallelTools);
      await Promise.all(batch.map(async ({ member, index }) => {
        memberReceipts[index] = await this.executeMember(
          session, outer, member, startedAt, signal
        );
      }));
    }
    await this.receipts.record(
      session,
      readBatchReceipt(outer.call, members, memberReceipts, startedAt),
      outer.modelTurn
    );
  }

  private async preparePlan(
    session: RuntimeSession,
    member: ReadBatchMember
  ): Promise<ToolCallPlan> {
    const context = {
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      workspacePath: session.identity.workspacePath,
      runMode: session.durable.mode,
      ...toolRuntimeContext(session),
      runtimeControl: this.options.control.forSession(session)
    } as const;
    return this.options.runtime.tools.prepare
      ? await this.options.runtime.tools.prepare({
        callId: member.call.id,
        name: member.call.name,
        arguments: member.call.arguments
      }, context)
      : await prepareToolCallPlan(member.descriptor, member.call.arguments, context);
  }

  private async executeMember(
    session: RuntimeSession,
    outer: ToolAttempt,
    member: ReadBatchMember,
    startedAt: string,
    signal: AbortSignal
  ): Promise<ToolReceipt> {
    const attempt: ToolAttempt = { call: member.call, modelTurn: outer.modelTurn };
    const instruction = await this.loadInstructions(session, member.call, member.descriptor);
    let receipt = instruction.failure;
    if (!receipt) {
      try {
        const plan = await this.preparePlan(session, member);
        receipt = readBatchPlanAllowed(plan)
          ? await this.transactions.execute(session, attempt, signal)
          : failed(
              member.call,
              startedAt,
              "This call requires mutation, external access, validation, network, or control authority and must be issued directly.",
              "batch_member_requires_individual_call"
            );
      } catch (error) {
        receipt = failed(
          member.call,
          startedAt,
          error instanceof Error ? error.message : String(error),
          errorCode(error, "batch_member_invalid")
        );
      }
    }
    await this.receipts.record(session, receipt, outer.modelTurn, member.call.name);
    return receipt;
  }
}
