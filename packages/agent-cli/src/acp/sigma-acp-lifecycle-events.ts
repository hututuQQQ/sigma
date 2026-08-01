import * as acp from "@agentclientprotocol/sdk";
import { isAgentEventOf, type AgentEventEnvelope } from "agent-protocol";
import { object, payloadText, textContent } from "./sigma-acp-event-content.js";
import type { ResolvedSession } from "./sigma-acp-shared.js";

export class SigmaAcpLifecycleEventForwarder {
  async forwardEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean
  ): Promise<boolean> {
    if (await this.forwardChildLifecycleEvent(resolved, event, client, replay)) return true;
    return await this.forwardHookLifecycleEvent(resolved, event, client, replay);
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

  private async forwardChildLifecycleEvent(
    resolved: ResolvedSession,
    event: AgentEventEnvelope,
    client: acp.AgentContext,
    replay: boolean
  ): Promise<boolean> {
    const sessionId = resolved.record.sessionId;
    if (
      !isAgentEventOf(event, "child.spawned")
      && !isAgentEventOf(event, "child.message")
      && !isAgentEventOf(event, "child.completed")
    ) return false;
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
    if (
      !isAgentEventOf(event, "hook.started")
      && !isAgentEventOf(event, "hook.completed")
      && !isAgentEventOf(event, "hook.failed")
    ) return false;
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
