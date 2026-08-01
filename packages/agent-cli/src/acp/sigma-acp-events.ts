import * as acp from "@agentclientprotocol/sdk";
import {
  isAgentEventOf,
  type AgentEventEnvelope,
  type AgentEventOf
} from "agent-protocol";
import { textContent, toolKind } from "./sigma-acp-event-content.js";
import { SigmaAcpInteractionForwarder } from "./sigma-acp-interactions.js";
import { SigmaAcpLifecycleEventForwarder } from "./sigma-acp-lifecycle-events.js";
import type { ForwardState, ResolvedSession } from "./sigma-acp-shared.js";

export class SigmaAcpEventForwarder {
  private readonly lifecycle = new SigmaAcpLifecycleEventForwarder();
  private readonly interactions = new SigmaAcpInteractionForwarder();

  async forwardLive(
    resolved: ResolvedSession,
    client: acp.AgentContext,
    state: ForwardState,
    signal: AbortSignal
  ): Promise<void> {
    for await (const event of resolved.handle.runtime.subscribe(
      resolved.record.runtimeSessionId,
      signal
    )) {
      if (event.seq <= resolved.record.lastSeq) continue;
      await this.forwardEvent(resolved, event, client, state, false, signal);
      resolved.record.lastSeq = event.seq;
    }
  }

  async forwardEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    state: ForwardState,
    replay: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    if (await this.forwardUserEvent(resolved, event, client, replay)) return;
    if (await this.forwardModelEvent(resolved, event, client, state, replay)) return;
    if (await this.forwardPlanEvent(resolved, event, client, replay)) return;
    if (await this.lifecycle.forwardEvent(resolved, event, client, replay)) return;
    if (await this.forwardToolRequestEvent(resolved, event, client, state, replay, signal)) return;
    await this.forwardToolResultEvent(resolved, event, client, replay);
  }

  async forwardMcpStatus(
    sessionId: string,
    server: acp.McpServer,
    client: acp.AgentContext,
    status: "connected" | "disconnected"
  ): Promise<void> {
    await this.lifecycle.forwardMcpStatus(sessionId, server, client, status);
  }

  private async forwardUserEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean
  ): Promise<boolean> {
    const sessionId = resolved.record.sessionId;
    if (isAgentEventOf(event, "user.message") || isAgentEventOf(event, "user.steer")) {
      if (replay) {
        if (event.payload.text) {
          await this.notify(client, sessionId, {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: event.payload.text }
          }, true);
        }
        if (isAgentEventOf(event, "user.message")) {
          for (const image of event.payload.images ?? []) {
            await this.notify(client, sessionId, {
              sessionUpdate: "user_message_chunk",
              content: { type: "image", data: image.data, mimeType: image.mimeType }
            }, true);
          }
        }
      }
      return true;
    }
    if (!isAgentEventOf(event, "user.follow_up")) return false;
    if (replay && event.payload.status === "delivered") {
      if (event.payload.text) {
        await this.notify(client, sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: event.payload.text }
        }, true);
      }
      for (const image of event.payload.images ?? []) {
        await this.notify(client, sessionId, {
          sessionUpdate: "user_message_chunk",
          content: { type: "image", data: image.data, mimeType: image.mimeType }
        }, true);
      }
    }
    return true;
  }

  private async forwardModelEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    state: ForwardState,
    replay: boolean
  ): Promise<boolean> {
    const sessionId = resolved.record.sessionId;
    if (isAgentEventOf(event, "model.delta")) {
      state.modelText.set(
        event.payload.turnId,
        `${state.modelText.get(event.payload.turnId) ?? ""}${event.payload.delta}`
      );
      await this.notify(client, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: event.payload.delta }
      }, replay);
      return true;
    }
    if (isAgentEventOf(event, "model.reasoning_delta")) {
      state.reasoningText.set(
        event.payload.turnId,
        `${state.reasoningText.get(event.payload.turnId) ?? ""}${event.payload.delta}`
      );
      await this.notify(client, sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: event.payload.delta }
      }, replay);
      return true;
    }
    if (!isAgentEventOf(event, "model.completed")) return false;
    await this.forwardCompletedModelEvent(resolved, event, client, state, replay);
    return true;
  }

  private async forwardCompletedModelEvent(
    resolved: ResolvedSession,
    event: AgentEventOf<"model.completed">,
    client: acp.AgentContext,
    state: ForwardState,
    replay: boolean
  ): Promise<void> {
    const sessionId = resolved.record.sessionId;
    const streamed = state.modelText.get(event.payload.turnId) ?? "";
    const remaining = event.payload.text.startsWith(streamed)
      ? event.payload.text.slice(streamed.length)
      : streamed ? "" : event.payload.text;
    if (remaining) {
      await this.notify(client, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: remaining }
      }, replay);
    }
    const reasoning = event.payload.message.reasoningContent ?? "";
    const streamedReasoning = state.reasoningText.get(event.payload.turnId) ?? "";
    const reasoningRemaining = reasoning.startsWith(streamedReasoning)
      ? reasoning.slice(streamedReasoning.length)
      : streamedReasoning ? "" : reasoning;
    if (reasoningRemaining) {
      await this.notify(client, sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: reasoningRemaining }
      }, replay);
    }
    const usage = event.payload.usage;
    await this.notify(client, sessionId, {
      sessionUpdate: "usage_update",
      size: event.payload.contextWindowTokens ?? 0,
      used: Math.max(0, Math.trunc(usage.inputTokens + usage.outputTokens)),
      _meta: {
        "sigma.inputTokens": usage.inputTokens,
        "sigma.cachedInputTokens": usage.cacheReadTokens,
        "sigma.outputTokens": usage.outputTokens,
        "sigma.reasoningOutputTokens": usage.reasoningTokens,
        "sigma.durationMs": Math.max(0, Math.trunc(usage.latencyMs)),
        "sigma.compactsAutomatically": true
      }
    }, replay);
    state.modelText.delete(event.payload.turnId);
    state.reasoningText.delete(event.payload.turnId);
  }

  private async forwardPlanEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean
  ): Promise<boolean> {
    if (!isAgentEventOf(event, "plan.updated")) return false;
    await this.notify(client, resolved.record.sessionId, {
      sessionUpdate: "plan",
      entries: event.payload.plan.nodes.map((node) => ({
        content: node.title,
        priority: event.payload.plan.activeNodeId === node.id ? "high" : "medium",
        status: node.status === "completed"
          ? "completed"
          : node.status === "in_progress" ? "in_progress" : "pending",
        _meta: {
          "sigma.nodeId": node.id,
          "sigma.status": node.status,
          "sigma.dependencies": node.dependencies
        }
      }))
    }, replay);
    return true;
  }

  private async forwardToolRequestEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    state: ForwardState,
    replay: boolean,
    signal?: AbortSignal
  ): Promise<boolean> {
    const sessionId = resolved.record.sessionId;
    if (isAgentEventOf(event, "tool.requested")) {
      await this.notify(client, sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: event.payload.callId,
        title: event.payload.name,
        name: event.payload.name,
        kind: toolKind(event.payload.name),
        status: "pending",
        rawInput: event.payload.arguments
      }, replay);
      if (!replay && event.payload.name === "request_user_input") {
        if (!signal) throw new Error("Live Sigma user-input forwarding requires an abort signal.");
        state.userInputContinuation = this.interactions.requestStructuredUserInput(
          resolved,
          event,
          client,
          signal
        );
      }
      return true;
    }
    if (!isAgentEventOf(event, "tool.approval_requested")) return false;
    const effects = event.payload.effects;
    await this.notify(client, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.payload.callId,
      title: event.payload.toolName,
      name: event.payload.toolName,
      kind: toolKind(event.payload.toolName, effects),
      status: "pending",
      rawInput: event.payload.arguments,
      rawOutput: { approvalReason: event.payload.reason, effects }
    }, replay);
    if (!replay && event.payload.approvalMode === "human" && event.payload.delegated !== true) {
      if (!signal) throw new Error("Live Sigma approval forwarding requires an abort signal.");
      await this.interactions.requestToolApproval(resolved, event, client, signal);
    }
    return true;
  }

  private async forwardToolResultEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean
  ): Promise<boolean> {
    const sessionId = resolved.record.sessionId;
    if (isAgentEventOf(event, "tool.started")) {
      await this.notify(client, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: event.payload.callId,
        title: event.payload.name,
        name: event.payload.name,
        kind: toolKind(event.payload.name),
        status: "in_progress"
      }, replay);
      return true;
    }
    if (isAgentEventOf(event, "tool.progress")) {
      await this.notify(client, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: event.payload.callId,
        title: event.payload.name,
        name: event.payload.name,
        status: "in_progress",
        content: textContent(event.payload.message),
        rawOutput: {
          message: event.payload.message,
          ...(event.payload.percent === undefined ? {} : { percent: event.payload.percent })
        }
      }, replay);
      return true;
    }
    if (!isAgentEventOf(event, "tool.completed") && !isAgentEventOf(event, "tool.failed")) {
      return false;
    }
    await this.notify(client, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.payload.callId,
      title: event.payload.name,
      name: event.payload.name,
      status: event.type === "tool.completed" ? "completed" : "failed",
      content: textContent(event.payload.output),
      rawOutput: {
        ok: event.payload.ok,
        output: event.payload.output,
        outcome: event.payload.outcome,
        ...(event.payload.result === undefined ? {} : { result: event.payload.result }),
        diagnostics: event.payload.diagnostics
      }
    }, replay);
    return true;
  }

  private async notify(
    client: acp.AgentContext,
    sessionId: string,
    update: acp.SessionUpdate,
    replay: boolean
  ): Promise<void> {
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update,
      ...(replay ? { _meta: { isReplay: true } } : {})
    });
  }
}
