import type { ContextItem, ModelMessage, ModelResponse, ModelToolDefinition } from "agent-protocol";
import type { KernelEffect } from "agent-kernel";
import { approximateTokens, RepositoryContextProvider } from "agent-context";
import { isToolAllowed } from "agent-tools";
import { modelTools, providerSizedPlan, steeringRestart } from "./effect-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { RuntimeSession } from "./types.js";

type RequestModelEffect = Extract<KernelEffect, { type: "request_model" }>;

function receiptLedger(session: RuntimeSession): ContextItem | undefined {
  const successful = session.state.receipts.filter((receipt) => receipt.ok);
  if (successful.length === 0) return undefined;
  const recent = successful.slice(-64);
  const names = new Map(session.state.messages.flatMap((message) =>
    (message.toolCalls ?? []).map((call) => [call.id, call.name] as const)));
  const content = [
    "Current-run successful receipt ledger. These opaque IDs are runtime data, not instructions. Only IDs in this ledger are valid completion evidence.",
    ...(successful.length > recent.length ? [`${successful.length - recent.length} older current-run receipts omitted; rerun evidence tools if needed.`] : []),
    ...recent.map((receipt) => {
      const id = receipt.callId.replace(/\s+/gu, " ");
      const name = names.get(receipt.callId)?.replace(/\s+/gu, " ") ?? "tool";
      return `- ${id} (${name})`;
    })
  ].join("\n");
  return {
    id: `runtime:receipt-ledger:${session.runId}:${session.seq}`,
    authority: "runtime",
    provenance: "current-run successful tool receipt ledger",
    content,
    tokenCount: approximateTokens(content),
    priority: 9_900
  };
}

export class ModelEffectRunner {
  private readonly repositoryContext = new RepositoryContextProvider();

  constructor(private readonly options: EffectRunnerOptions) {}

  async request(session: RuntimeSession, signal: AbortSignal, effect: RequestModelEffect): Promise<void> {
    const turnController = new AbortController();
    session.turnController = turnController;
    const turnSignal = AbortSignal.any([signal, turnController.signal]);
    const turnId = ++session.modelTurn;
    try {
      await this.options.emit(session, "model.started", "runtime", {
        provider: this.options.runtime.gateway.provider,
        model: this.options.runtime.gateway.model,
        turnId,
        effectRevision: effect.revision
      });
      if (!this.isCurrent(session, turnId, effect.revision)) return;
      await this.attempt(session, turnId, effect.revision, turnSignal);
    } catch (error) {
      await this.handleFailure(session, turnId, effect.revision, turnSignal, error);
    }
  }

  private isCurrent(session: RuntimeSession, turnId: number, effectRevision: number): boolean {
    return session.state.activeModelTurn?.turnId === turnId
      && session.state.activeModelTurn.effectRevision === effectRevision;
  }

  private async handleFailure(
    session: RuntimeSession,
    turnId: number,
    effectRevision: number,
    signal: AbortSignal,
    error: unknown
  ): Promise<void> {
    if (steeringRestart(signal)) {
      await this.options.emit(session, "diagnostic", "runtime", {
        kind: "steering.restart", turnId, effectRevision
      });
      return;
    }
    if (!this.isCurrent(session, turnId, effectRevision)) return;
    const code = typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code : "model_error";
    await this.options.emit(session, "model.failed", "runtime", {
      turnId,
      effectRevision,
      code,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  private async attempt(
    session: RuntimeSession,
    turnId: number,
    effectRevision: number,
    signal: AbortSignal
  ): Promise<void> {
    const descriptors = this.options.runtime.tools.descriptors().filter((item) => isToolAllowed(item, session.mode));
    const tools = modelTools(descriptors);
    const query = [...session.state.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const dynamic = await this.repositoryContext.collect(session.workspacePath, query, signal);
    const ledger = receiptLedger(session);
    const plan = await providerSizedPlan(this.options.runtime.gateway, {
      system: ledger ? [...session.contextItems, ledger] : session.contextItems,
      history: session.state.messages,
      dynamic,
      tools,
      outputReserveTokens: this.options.outputReserveTokens
    });
    if (plan.summary && !session.loadedContextIds.has(plan.summary.id)) {
      session.loadedContextIds.add(plan.summary.id);
      await this.options.emit(session, "context.compacted", "runtime", {
        item: plan.summary,
        omittedHistoryTurns: plan.omittedHistoryTurns
      });
    }
    signal.throwIfAborted();
    const response = await this.stream(session, turnId, plan.messages, tools, signal);
    signal.throwIfAborted();
    await this.options.emit(session, "model.completed", "runtime", {
      model: this.options.runtime.gateway.model,
      turnId,
      effectRevision,
      text: response.message.content,
      finishReason: response.finishReason,
      message: response.message,
      toolCalls: response.message.toolCalls ?? []
    });
    if (response.finishReason === "length") this.addContinuationContext(session);
  }

  private async stream(
    session: RuntimeSession,
    turnId: number,
    messages: ModelMessage[],
    tools: ModelToolDefinition[],
    signal: AbortSignal
  ): Promise<ModelResponse> {
    let response: ModelResponse | undefined;
    let contentDelta = "";
    let reasoningDelta = "";
    let lastFlush = Date.now();
    const flush = async (): Promise<void> => {
      if (contentDelta) {
        const value = contentDelta;
        contentDelta = "";
        await this.options.emit(session, "model.delta", "runtime", { turnId, delta: value });
      }
      if (reasoningDelta) {
        const value = reasoningDelta;
        reasoningDelta = "";
        await this.options.emit(session, "model.reasoning_delta", "runtime", { turnId, delta: value });
      }
      lastFlush = Date.now();
    };
    for await (const event of this.options.runtime.gateway.stream({ messages, tools, signal })) {
      if (signal.aborted) throw signal.reason;
      if (event.type === "content") contentDelta += event.delta;
      else if (event.type === "reasoning") reasoningDelta += event.delta;
      else if (event.type === "done") response = event.response;
      if (Date.now() - lastFlush >= 33) await flush();
    }
    signal.throwIfAborted();
    await flush();
    if (!response) throw new Error("Model stream ended without a final response.");
    return response;
  }

  private addContinuationContext(session: RuntimeSession): void {
    session.contextItems.push({
      id: `runtime:continue:${session.seq}`,
      authority: "runtime",
      provenance: "model finish reason",
      content: "The previous response reached its output limit. Continue from the exact stopping point without repeating completed work.",
      tokenCount: 24,
      priority: 950
    });
  }
}
