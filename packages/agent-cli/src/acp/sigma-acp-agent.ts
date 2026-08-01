import * as acp from "@agentclientprotocol/sdk";
import { isAgentEventOf } from "agent-protocol";
import { cancelResolvedSession } from "./sigma-acp-cancellation.js";
import { SigmaAcpEventForwarder } from "./sigma-acp-events.js";
import { SigmaAcpPromptController } from "./sigma-acp-prompt-controller.js";
import { SigmaAcpSessionRegistry } from "./sigma-acp-session-registry.js";
import { SigmaAcpSessionService } from "./sigma-acp-session-service.js";
import {
  parseHealthRequest,
  parseSigmaCapabilitiesRequest,
  parseSigmaRollbackCommand,
  parseSigmaSessionRequest,
  parseSigmaTextCommand,
  type SigmaAcpAgentOptions
} from "./sigma-acp-shared.js";

export type {
  SigmaAcpAgentOptions,
  SigmaAcpModelCatalog,
  SigmaAcpModelOption,
  SigmaAcpRuntimeHandle
} from "./sigma-acp-shared.js";

export class SigmaAcpAgent {
  private readonly sessions: SigmaAcpSessionRegistry;
  private readonly events = new SigmaAcpEventForwarder();
  private readonly prompts: SigmaAcpPromptController;
  private readonly sessionService: SigmaAcpSessionService;

  constructor(private readonly options: SigmaAcpAgentOptions) {
    this.sessions = new SigmaAcpSessionRegistry(options);
    this.prompts = new SigmaAcpPromptController(options, this.sessions, this.events);
    this.sessionService = new SigmaAcpSessionService(
      options,
      this.sessions,
      this.events,
      (sessionId) => this.prompts.hasActivePrompt(sessionId)
    );
  }

  app(): acp.AgentApp {
    return acp.agent({ name: "sigma" })
      .onRequest(acp.methods.agent.initialize, () => this.initialize())
      .onRequest(acp.methods.agent.session.new, (context) =>
        this.sessionService.newSession(context.params, context.client))
      .onRequest(acp.methods.agent.session.load, (context) =>
        this.sessionService.loadSession(context.params, context.client))
      .onRequest(acp.methods.agent.session.list, (context) =>
        this.sessionService.listSessions(context.params))
      .onRequest(acp.methods.agent.session.resume, (context) =>
        this.sessionService.resumeSession(context.params, context.client))
      .onRequest(acp.methods.agent.session.close, (context) =>
        this.closeSession(context.params, context.client))
      .onRequest(acp.methods.agent.session.setMode, (context) =>
        this.sessionService.setMode(context.params))
      .onRequest(acp.methods.agent.session.setConfigOption, (context) =>
        this.sessionService.setConfigOption(context.params))
      .onRequest(acp.methods.agent.session.prompt, (context) =>
        this.prompts.prompt(context.params, context.client, context.signal))
      .onNotification(acp.methods.agent.session.cancel, (context) =>
        this.prompts.cancel(context.params))
      .onRequest("_sigma/steer", parseSigmaTextCommand, (context) =>
        this.prompts.steer(context.params))
      .onRequest("_sigma/rollback", parseSigmaRollbackCommand, (context) =>
        this.prompts.rollback(context.params))
      .onRequest("_sigma/capabilities", parseSigmaCapabilitiesRequest, async (context) => ({
        skills: this.options.skillCatalog
          ? await this.options.skillCatalog(context.params.cwd)
          : [],
        // T3 owns /model, /plan, and /default. Do not advertise provider
        // commands until Sigma ACP can execute them authoritatively.
        slashCommands: []
      }))
      .onRequest("_sigma/thread/read", parseSigmaSessionRequest, (context) =>
        this.readThread(context.params.sessionId))
      .onRequest("_sigma/health", parseHealthRequest, () => ({
        ok: true,
        name: "Sigma",
        protocolVersion: acp.PROTOCOL_VERSION,
        version: this.options.agentVersion
      }));
  }

  async close(): Promise<void> {
    await this.prompts.close();
    await this.sessions.close();
  }

  private initialize(): acp.InitializeResponse {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, resume: {}, close: {} }
      },
      agentInfo: {
        name: "Sigma",
        title: "Sigma Runtime",
        version: this.options.agentVersion
      }
    };
  }

  private async closeSession(
    params: acp.CloseSessionRequest,
    client: acp.AgentContext
  ): Promise<void> {
    const resolved = this.prompts.activeRuntimeSession(params.sessionId)
      ?? await this.sessions.resolveSession(params.sessionId);
    this.prompts.abortPrompt(params.sessionId, new Error("ACP session closed."));
    await this.sessions.ensureAttached(resolved);
    await cancelResolvedSession(resolved, "ACP session closed.");
    await resolved.handle.runtime.releaseSession?.(resolved.record.runtimeSessionId);
    for (const server of this.sessions.mcpServers(params.sessionId)) {
      await this.events.forwardMcpStatus(params.sessionId, server, client, "disconnected");
    }
    this.sessions.detach(resolved.record);
    this.sessions.forgetMcpServers(params.sessionId);
  }

  private async readThread(sessionId: string): Promise<object> {
    const resolved = await this.sessions.resolveSession(sessionId);
    const turns: Array<{ id: string; items: unknown[] }> = [];
    let current: { id: string; items: unknown[] } | undefined;
    for await (const event of resolved.handle.runtime.sessionEvents(
      resolved.record.runtimeSessionId
    )) {
      if (
        isAgentEventOf(event, "user.message")
        || isAgentEventOf(event, "user.steer")
        || (isAgentEventOf(event, "user.follow_up") && event.payload.status === "delivered")
      ) {
        current = { id: `sigma-turn:${event.seq}`, items: [] };
        turns.push(current);
        current.items.push({
          role: "user",
          text: event.payload.text,
          ...(isAgentEventOf(event, "user.message") || isAgentEventOf(event, "user.follow_up")
            ? { images: event.payload.images ?? [] }
            : {})
        });
        continue;
      }
      if (!current) continue;
      if (isAgentEventOf(event, "model.completed")) {
        current.items.push({
          role: "assistant",
          text: event.payload.text,
          ...(event.payload.message.reasoningContent
            ? { reasoningContent: event.payload.message.reasoningContent }
            : {}),
          usage: event.payload.usage
        });
        continue;
      }
      if (isAgentEventOf(event, "tool.completed") || isAgentEventOf(event, "tool.failed")) {
        current.items.push({
          type: "tool",
          name: event.payload.name,
          callId: event.payload.callId,
          ok: event.payload.ok,
          output: event.payload.output
        });
      }
    }
    return { turns };
  }
}
