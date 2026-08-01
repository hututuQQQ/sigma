import * as acp from "@agentclientprotocol/sdk";
import {
  isAgentEventOf,
  type AgentEventEnvelope,
  type AgentEventOf
} from "agent-protocol";
import type { ForwardState, ResolvedSession } from "./sigma-acp-shared.js";

interface SigmaStructuredQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

interface SigmaAskUserQuestionResponse {
  outcome?: unknown;
  answers?: unknown;
  annotations?: unknown;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonempty(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function structuredQuestions(value: unknown): SigmaStructuredQuestion[] {
  const input = object(value);
  const declared = Array.isArray(input?.questions) ? input.questions : [];
  const questions = declared.flatMap((entry, index) => {
    const question = object(entry);
    const text = nonempty(question?.question);
    if (!text) return [];
    const options = Array.isArray(question?.options)
      ? question.options.flatMap((candidate) => {
          const option = object(candidate);
          const label = nonempty(option?.label);
          if (!label) return [];
          return [{ label, description: nonempty(option?.description) ?? label }];
        })
      : [];
    return [{
      id: nonempty(question?.id) ?? `question_${index + 1}`,
      header: nonempty(question?.header) ?? "Question",
      question: text,
      options,
      multiSelect: question?.multiSelect === true
    }];
  });
  if (questions.length > 0) return questions.slice(0, 3);
  const message = nonempty(input?.message);
  return message
    ? [{ id: "message", header: "Question", question: message, options: [], multiSelect: false }]
    : [];
}

function structuredAnswerText(
  response: SigmaAskUserQuestionResponse,
  questions: readonly SigmaStructuredQuestion[]
): string | undefined {
  if (response.outcome !== "accepted") return undefined;
  const answers = object(response.answers) ?? {};
  const annotations = object(response.annotations) ?? {};
  const answered = questions.map((question) => {
    const annotation = object(annotations[question.question]);
    const notes = nonempty(annotation?.notes);
    const rawAnswer = answers[question.question];
    const values = Array.isArray(rawAnswer)
      ? rawAnswer.flatMap((value: unknown) => {
          const text = nonempty(value);
          return text && text !== "Other" ? [text] : [];
        })
      : [];
    const answer = notes ?? (values.length > 0 ? values.join(", ") : "No answer provided");
    return { question: question.question, answer };
  });
  return answered.length === 1
    ? answered[0]!.answer
    : `User answers:\n${answered.map(({ question, answer }) =>
        `- ${question}: ${answer}`).join("\n")}`;
}

function toolKind(name: string, effects: readonly string[] = []): acp.ToolKind {
  if (effects.some((effect) => effect === "filesystem.write" || effect === "repository.write")) {
    return "edit";
  }
  if (effects.some((effect) => effect.startsWith("process."))) return "execute";
  if (effects.includes("network")) return "fetch";
  if (/search|find|grep/iu.test(name)) return "search";
  if (/read|list|inspect|status/iu.test(name)) return "read";
  return "other";
}

function textContent(text: string): acp.ToolCallContent[] {
  return text ? [{ type: "content", content: { type: "text", text } }] : [];
}

function payloadText(value: unknown, keys: readonly string[]): string {
  const data = object(value);
  for (const key of keys) {
    const text = nonempty(data?.[key]);
    if (text) return text;
  }
  return "";
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Operation aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function approvalDecision(
  response: acp.RequestPermissionResponse
): "allow" | "always_allow" | "deny" {
  if (response.outcome.outcome !== "selected") return "deny";
  if (response.outcome.optionId === "always_allow") return "always_allow";
  return response.outcome.optionId === "allow" ? "allow" : "deny";
}

export class SigmaAcpEventForwarder {
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
    if (await this.forwardRuntimeLifecycleEvent(resolved, event, client, replay)) return;
    if (await this.forwardToolRequestEvent(resolved, event, client, state, replay, signal)) return;
    await this.forwardToolResultEvent(resolved, event, client, replay);
  }

  private async forwardRuntimeLifecycleEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean
  ): Promise<boolean> {
    if (await this.forwardChildLifecycleEvent(resolved, event, client, replay)) return true;
    return await this.forwardHookLifecycleEvent(resolved, event, client, replay);
  }

  private async forwardChildLifecycleEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean
  ): Promise<boolean> {
    const sessionId = resolved.record.sessionId;
    if (!isAgentEventOf(event, "child.spawned")
      && !isAgentEventOf(event, "child.message")
      && !isAgentEventOf(event, "child.completed")) return false;
    const detail = object(event.payload.payload);
    const title = `Agent ${event.payload.childId.slice(0, 8)}`;
    const text = payloadText(detail, ["message", "summary", "kind", "error", "instruction"]);
    const raw = { childId: event.payload.childId, payload: event.payload.payload };
    if (event.type === "child.spawned") {
      await this.notify(client, sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: `child:${event.payload.childId}`,
        title,
        name: "subagent",
        kind: "other",
        status: "pending",
        rawInput: raw,
        _meta: { "sigma.event": event.type, "sigma.payload": raw }
      }, replay);
    } else {
      const status = event.type === "child.completed"
        ? detail?.status === "completed" ? "completed" : "failed"
        : "in_progress";
      await this.notify(client, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: `child:${event.payload.childId}`,
        title,
        name: "subagent",
        kind: "other",
        status,
        content: textContent(text),
        rawOutput: raw,
        _meta: { "sigma.event": event.type, "sigma.payload": raw }
      }, replay);
    }
    return true;
  }

  private async forwardHookLifecycleEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean
  ): Promise<boolean> {
    if (!isAgentEventOf(event, "hook.started")
      && !isAgentEventOf(event, "hook.completed")
      && !isAgentEventOf(event, "hook.failed")) return false;
    const settled = event.type === "hook.started" ? undefined : event.payload;
    const title = `Hook ${event.payload.event}`;
    const text = settled?.outcome.reason
      ?? (settled ? `${settled.outcome.status} (${Math.round(settled.durationMs)}ms)` : "");
    const raw = event.payload;
    if (event.type === "hook.started") {
      await this.notify(client, resolved.record.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: `hook:${event.payload.hookId}`,
        title,
        name: "hook",
        kind: "execute",
        status: "pending",
        rawInput: raw,
        _meta: { "sigma.event": event.type, "sigma.payload": raw }
      }, replay);
    } else {
      await this.notify(client, resolved.record.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: `hook:${event.payload.hookId}`,
        title,
        name: "hook",
        kind: "execute",
        status: event.type === "hook.failed" ? "failed" : "completed",
        content: textContent(text),
        rawOutput: raw,
        _meta: { "sigma.event": event.type, "sigma.payload": raw }
      }, replay);
    }
    return true;
  }

  async forwardMcpStatus(
    sessionId: string,
    server: acp.McpServer,
    client: acp.AgentContext,
    status: "connected" | "disconnected"
  ): Promise<void> {
    const transport = "type" in server ? server.type : "stdio";
    const payload = { status: { name: server.name, status, transport } };
    await this.notify(client, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: `mcp:${server.name}`,
      title: `MCP ${server.name}`,
      name: "mcp_status",
      kind: "other",
      status: status === "connected" ? "completed" : "failed",
      rawOutput: payload,
      _meta: { "sigma.event": "mcp.status.updated", "sigma.payload": payload }
    }, false);
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
        state.userInputContinuation = this.requestStructuredUserInput(
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
      await this.requestToolApproval(resolved, event, client, signal);
    }
    return true;
  }

  private async requestStructuredUserInput(
    resolved: ResolvedSession,
    event: AgentEventOf<"tool.requested">,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<boolean> {
    const questions = structuredQuestions(event.payload.arguments);
    if (questions.length === 0) return false;
    try {
      const response = await client.request<
        SigmaAskUserQuestionResponse,
        {
          sessionId: string;
          toolCallId: string;
          questions: SigmaStructuredQuestion[];
          mode: "default" | "plan";
        }
      >("_x.ai/ask_user_question", {
        sessionId: resolved.record.sessionId,
        toolCallId: event.payload.callId,
        questions,
        mode: resolved.record.mode === "analyze" ? "plan" : "default"
      }, { cancellationSignal: signal });
      const text = structuredAnswerText(response, questions);
      if (!text) return false;
      await resolved.handle.runtime.command({
        type: "follow_up",
        sessionId: resolved.record.runtimeSessionId,
        text
      });
      return true;
    } catch (error) {
      if (signal.aborted) throw error;
      // The extension is optional ACP surface area. Clients without it retain
      // the ordinary needs_input outcome instead of failing the whole prompt.
      return false;
    }
  }

  private async requestToolApproval(
    resolved: ResolvedSession,
    event: AgentEventOf<"tool.approval_requested">,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<void> {
    const effects = event.payload.effects;
    const request = client.request(acp.methods.client.session.requestPermission, {
      sessionId: resolved.record.sessionId,
      toolCall: {
        toolCallId: event.payload.callId,
        title: event.payload.toolName,
        name: event.payload.toolName,
        kind: toolKind(event.payload.toolName, effects),
        status: "pending",
        rawInput: event.payload.arguments
      },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "always_allow", name: "Always allow this tool", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" }
      ]
    }, { cancellationSignal: signal });
    const permission = await abortable(request, signal);
    await resolved.handle.runtime.command({
      type: "approve",
      sessionId: resolved.record.runtimeSessionId,
      requestId: event.payload.requestId,
      decision: approvalDecision(permission)
    });
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
