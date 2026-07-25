import type {
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
  ReviewerToolReceiptV1,
  ToolCallPlan,
  ToolDescriptor
} from "agent-protocol";
import { prepareToolCallPlan } from "agent-tools";
import {
  DisposableOverlay,
  parentWorkspaceDigest
} from "./reviewer-overlay.js";
import {
  assertReviewerPlan,
  catalogAllowed,
  modelDefinition,
  needsOverlay,
  reviewerExecutionCall,
  SPECIAL_ARTIFACT_TOOL,
  SPECIAL_CHANGE_SET_TOOL,
  specialPlan
} from "./reviewer-tool-policy.js";
import {
  checkFor,
  type DurableReviewerReceipt,
  materializeLargeOutput,
  normalizedReceipt,
  reviewerToolFailure,
  syntheticCheckEvidence,
  toolMessage
} from "./reviewer-tool-receipts.js";
import {
  readReviewerArtifact,
  readReviewerChangeSet
} from "./reviewer-special-tools.js";
import type {
  ReviewerInput,
  ReviewerToolCheckV1,
  ReviewerToolEnvironment,
  ReviewerToolSessionPort
} from "./reviewer-contracts.js";
import {
  sha256,
  type ActiveReviewerToolEnvironmentOptions
} from "./reviewer-tool-shared.js";
import { projectReviewerCallToOverlay } from "./reviewer-overlay-paths.js";

class ActiveReviewerToolSession implements ReviewerToolSessionPort {
  private readonly descriptors: Map<string, ToolDescriptor>;
  private readonly overlay: DisposableOverlay;
  private readonly initialParentDigest: Promise<string>;
  private readonly scratchSessionId: string;
  private closed = false;
  private readonly changeSet: Promise<{ content: Buffer; artifactId: string }>;

  constructor(
    private readonly options: ActiveReviewerToolEnvironmentOptions,
    private readonly input: ReviewerInput,
    private readonly reviewRequestId: string
  ) {
    const descriptors = options.tools.modelDescriptors?.() ?? options.tools.descriptors();
    this.descriptors = new Map(descriptors.filter(catalogAllowed)
      .map((descriptor) => [descriptor.name, descriptor]));
    this.overlay = new DisposableOverlay(options.session.identity.workspacePath);
    this.initialParentDigest = parentWorkspaceDigest(options.session);
    this.scratchSessionId = `review-${sha256([
      options.session.identity.sessionId,
      options.session.durable.runId,
      reviewRequestId
    ].join("\0")).slice(0, 64)}`;
    this.changeSet = this.buildChangeSet();
  }

  private async buildChangeSet(): Promise<{ content: Buffer; artifactId: string }> {
    let consolidated: unknown;
    try {
      consolidated = await this.options.control.consolidatedReviewMaterial(
        this.options.session,
        64 * 1024 * 1024
      );
    } catch (error) {
      consolidated = {
        unavailable: true,
        message: error instanceof Error ? error.message : String(error)
      };
    }
    const content = Buffer.from(JSON.stringify({
      frontierRevision: this.input.frontierRevision,
      stateDigest: this.input.stateDigest,
      consolidated,
      environmentMutations: this.input.environmentMutations ?? [],
      processSettlements: this.input.processSettlements ?? [],
      repositoryAndCompatibilityDeltas: this.input.workspaceDeltas.filter((item) =>
        !this.options.session.durable.state.mutationFrontier.sourceCheckpointIds
          .includes(item.data.checkpointId))
    }), "utf8");
    const artifactId = await this.options.createArtifact(
      this.options.session.identity.sessionId,
      content
    );
    return { content, artifactId };
  }

  definitions(): readonly ModelToolDefinition[] {
    const ordinary = [...this.descriptors.values()].map(modelDefinition);
    return [
      ...ordinary.filter((item) =>
        item.name !== SPECIAL_ARTIFACT_TOOL.name
        && item.name !== SPECIAL_CHANGE_SET_TOOL.name),
      SPECIAL_ARTIFACT_TOOL,
      SPECIAL_CHANGE_SET_TOOL
    ].sort((left, right) => left.name.localeCompare(right.name));
  }

  async execute(call: ModelToolCall, signal: AbortSignal): Promise<{
    message: ModelMessage;
    check: ReviewerToolCheckV1;
  }> {
    if (this.closed) throw new Error("Verification tool session is already closed.");
    const prior = this.options.session.durable.state.reviewReceipts.find((item) =>
      item.reviewRequestId === this.reviewRequestId && item.call.id === call.id);
    if (prior) {
      if (prior.call.name !== call.name
        || JSON.stringify(prior.call.arguments) !== JSON.stringify(call.arguments)) {
        throw Object.assign(new Error(
          "A recovered verification tool call changed after its durable receipt."
        ), { code: "review_tool_replay_mismatch" });
      }
      return {
        message: toolMessage(call, prior.receipt),
        check: checkFor(call, prior.receipt)
      };
    }
    const startedAt = new Date().toISOString();
    let plan: ToolCallPlan;
    let receipt: DurableReviewerReceipt;
    try {
      ({ plan, receipt } = await this.executeFresh(call, signal));
    } catch (error) {
      if (signal.aborted) throw error;
      plan = specialPlan();
      receipt = reviewerToolFailure(
        this.options.session,
        call,
        startedAt,
        error
      );
    }
    const durable: ReviewerToolReceiptV1 = {
      schemaVersion: 1,
      reviewRequestId: this.reviewRequestId,
      call,
      plan,
      receipt
    };
    await this.options.emit(
      this.options.session,
      "review.tool_completed",
      "runtime",
      durable
    );
    for (const evidence of receipt.evidence ?? []) {
      await this.options.emit(
        this.options.session,
        "evidence.recorded",
        "tool",
        evidence
      );
    }
    return {
      message: toolMessage(call, receipt),
      check: checkFor(call, receipt)
    };
  }

  private async executeFresh(
    call: ModelToolCall,
    signal: AbortSignal
  ): Promise<{ plan: ToolCallPlan; receipt: DurableReviewerReceipt }> {
    if (call.name === SPECIAL_ARTIFACT_TOOL.name) {
      return {
        plan: specialPlan(),
        receipt: await readReviewerArtifact(this.options, call)
      };
    }
    if (call.name === SPECIAL_CHANGE_SET_TOOL.name) {
      return {
        plan: specialPlan(),
        receipt: await readReviewerChangeSet(
          this.options,
          this.input,
          call,
          await this.changeSet
        )
      };
    }
    const descriptor = this.descriptors.get(call.name);
    if (!descriptor) {
      throw Object.assign(new Error(
        `Tool '${call.name}' is unavailable to independent verification.`
      ), { code: "review_tool_unavailable" });
    }
    const prepared = await this.prepareOrdinaryCall(call, descriptor);
    return {
      plan: prepared.plan,
      receipt: await this.executePreparedTool(
        call,
        prepared.effective,
        prepared.workspacePath,
        prepared.plan,
        signal
      )
    };
  }

  private async prepareOrdinaryCall(
    call: ModelToolCall,
    descriptor: ToolDescriptor
  ): Promise<{
    effective: ModelToolCall;
    plan: ToolCallPlan;
    workspacePath: string;
  }> {
    const requested = {
      callId: call.id,
      name: call.name,
      arguments: call.arguments
    };
    let workspacePath = this.options.session.identity.workspacePath;
    let plan = this.options.tools.prepare
      ? await this.options.tools.prepare(requested, this.preparation(workspacePath))
      : await prepareToolCallPlan(
          descriptor,
          call.arguments,
          this.preparation(workspacePath)
        );
    let effective = reviewerExecutionCall(call, descriptor);
    if (needsOverlay(plan) || effective !== call) {
      const logicalWorkspace = this.options.session.identity.workspacePath;
      workspacePath = await this.overlay.ensure();
      effective = projectReviewerCallToOverlay(
        effective,
        descriptor,
        logicalWorkspace,
        workspacePath
      );
      const overlayRequest = {
        callId: effective.id,
        name: effective.name,
        arguments: effective.arguments
      };
      plan = this.options.tools.prepare
        ? await this.options.tools.prepare(
            overlayRequest,
            this.preparation(workspacePath)
          )
        : await prepareToolCallPlan(
            descriptor,
            effective.arguments,
            this.preparation(workspacePath)
          );
    }
    assertReviewerPlan(
      descriptor,
      plan,
      workspacePath !== this.options.session.identity.workspacePath,
      this.externalReadAllowed()
    );
    return { effective, plan, workspacePath };
  }

  private preparation(workspacePath: string) {
    return {
      sessionId: this.scratchSessionId,
      runId: this.options.session.durable.runId,
      workspacePath,
      runMode: "change" as const,
      goalEpoch: this.options.session.durable.state.longHorizon.goalEpoch,
      mutationFrontierRevision: this.input.frontierRevision,
      mutationFrontierStateDigest: this.input.stateDigest
    };
  }

  private async executePreparedTool(
    original: ModelToolCall,
    effective: ModelToolCall,
    workspacePath: string,
    plan: ToolCallPlan,
    signal: AbortSignal
  ): Promise<DurableReviewerReceipt> {
    const request = {
      callId: effective.id,
      name: effective.name,
      arguments: effective.arguments
    };
    const raw = await this.options.tools.execute(request, {
      ...this.preparation(workspacePath),
      callPlan: plan,
      approval: {
        callId: original.id,
        authority: "runtime",
        networkApproved: this.options.networkMode === "full"
          || this.options.networkMode === "loopback",
        externalReadApproved: this.externalReadAllowed(),
        processHandoffApproved: false,
        openWorldApproved: false
      },
      signal,
      heartbeat() {},
      progress: async () => undefined,
      createArtifact: async ({ content }) => await this.options.createArtifact(
        this.options.session.identity.sessionId,
        content
      )
    });
    const materialized = normalizedReceipt(await materializeLargeOutput(
      this.options,
      original,
      raw
    ));
    return {
      ...materialized,
      evidence: [syntheticCheckEvidence(
        this.options.session,
        original,
        materialized
      )]
    };
  }

  private externalReadAllowed(): boolean {
    return this.options.allowEnclosingContainerRead
      && (this.input.environmentMutations?.length ?? 0) > 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let overlayFailure: unknown;
    try {
      await this.overlay.close();
    } catch (error) {
      overlayFailure = error;
    }
    const before = await this.initialParentDigest;
    const after = await parentWorkspaceDigest(this.options.session);
    if (before !== after) {
      throw Object.assign(new Error(
        "Independent verification changed the parent workspace; completion is blocked."
      ), { code: "review_parent_workspace_changed" });
    }
    if (overlayFailure) throw overlayFailure;
  }
}

export class ActiveReviewerToolEnvironment implements ReviewerToolEnvironment {
  constructor(private readonly options: ActiveReviewerToolEnvironmentOptions) {}

  definitions(): readonly ModelToolDefinition[] {
    const descriptors = this.options.tools.modelDescriptors?.()
      ?? this.options.tools.descriptors();
    const ordinary = descriptors.filter(catalogAllowed).map(modelDefinition);
    return [
      ...ordinary.filter((item) =>
        item.name !== SPECIAL_ARTIFACT_TOOL.name
        && item.name !== SPECIAL_CHANGE_SET_TOOL.name),
      SPECIAL_ARTIFACT_TOOL,
      SPECIAL_CHANGE_SET_TOOL
    ].sort((left, right) => left.name.localeCompare(right.name));
  }

  async open(
    input: ReviewerInput,
    reviewRequestId: string,
    signal: AbortSignal
  ): Promise<ReviewerToolSessionPort> {
    signal.throwIfAborted();
    return new ActiveReviewerToolSession(this.options, input, reviewRequestId);
  }
}
