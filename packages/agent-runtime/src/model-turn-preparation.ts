import type {
  BudgetAmounts,
  ContextItem,
  ModelMessage,
  RunOutcome
} from "agent-protocol";
import {
  historyAfterArchive,
  projectReasoningSafeHistory,
  projectToolResultHistory,
  proposeReasoningTrajectoryTombstones,
  proposeToolResultPrune,
  type ContextPlan,
  type RepositoryContextProvider
} from "agent-context";
import { isToolAllowed } from "agent-tools";
import { refreshContextArchive } from "./context-archive-refresh.js";
import {
  projectModelToolDescriptors,
  sessionModelToolProjectionCapabilities
} from "./effect-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import {
  budgetFailure,
  fitPreparedBudget,
  prepareBudgetedModelTurn,
  projectedModelTurnBoundary,
  type ModelTurnBoundaryStage,
  type PreparedModelTurn,
  type TurnPreparationInput
} from "./model-budget-convergence.js";
import { availableOrchestratorBudget } from "./assurance-budget.js";
import { evidenceLedger } from "./model-evidence-ledger.js";
import type { ModelSummarizer } from "./model-summarizer.js";
import { profileAllowsTool } from "./profile-policy.js";
import { progressCheckpoints } from "./progress-checkpoint.js";
import type { RuntimeSession } from "./types.js";
import { withReadBatchDescriptor } from "./read-batch-tool.js";
import { projectHarnessToolDescriptors } from "./harness-tool-projection.js";

export interface PreparedModelAttempt {
  turn?: PreparedModelTurn;
  plan?: ContextPlan;
  failure?: RunOutcome;
}

interface ProjectedModelHistory {
  history: ModelMessage[];
  archiveProjection: ReturnType<typeof historyAfterArchive>;
}

type BudgetedModelTurn = Awaited<ReturnType<typeof prepareBudgetedModelTurn>>;

function contextBudgetExhausted(error: unknown): boolean {
  return Boolean(error && typeof error === "object"
    && (error as { code?: unknown }).code === "context_overflow");
}

function contextBudgetFailure(): PreparedModelAttempt {
  return { failure: budgetFailure(
    "The remaining input-token ledger cannot fit mandatory context and the newest user turn."
  ) };
}

async function projectedToolHistory(
  options: EffectRunnerOptions,
  session: RuntimeSession,
  history: readonly ModelMessage[],
  archiveSourceDigest: string | undefined
): Promise<ModelMessage[]> {
  const pruneProposal = proposeToolResultPrune(
    history,
    session.durable.state.toolResultPrune,
    archiveSourceDigest,
    session.durable.frozenHarness ? {
      protectedRecentToolResultTokens:
        session.durable.frozenHarness.contextPolicy.protectedRecentToolResultTokens,
      minimumToolResultPruneTokens:
        session.durable.frozenHarness.contextPolicy.minimumToolResultPruneTokens
    } : {}
  );
  if (pruneProposal.changed && pruneProposal.state) {
    await options.emit(session, "context.tool_results_pruned", "runtime", {
      state: pruneProposal.state,
      protectedTokens: pruneProposal.protectedTokens,
      prunedTokens: pruneProposal.prunedTokens
    });
  }
  return projectToolResultHistory(
    history,
    session.durable.state.toolResultPrune,
    archiveSourceDigest
  );
}

async function projectedReasoningHistory(
  options: EffectRunnerOptions,
  session: RuntimeSession,
  history: readonly ModelMessage[]
): Promise<ModelMessage[]> {
  const required = session.services.gateway.capabilities.requiresToolCallReasoningReplay === true;
  const proposal = proposeReasoningTrajectoryTombstones(
    session.durable.state.messages,
    session.durable.state.reasoningTrajectory,
    required
  );
  if (proposal.changed) {
    await options.emit(session, "context.reasoning_trajectory_tombstoned", "runtime", {
      state: proposal.state,
      newlyTombstoned: proposal.newlyTombstoned
    });
  }
  return projectReasoningSafeHistory(
    history,
    session.durable.state.reasoningTrajectory,
    required
  );
}

async function projectedModelHistory(
  options: EffectRunnerOptions,
  session: RuntimeSession
): Promise<ProjectedModelHistory> {
  const archiveProjection = historyAfterArchive(
    session.durable.state.messages,
    session.durable.state.contextArchive
  );
  const reasoningSafeHistory = await projectedReasoningHistory(
    options,
    session,
    archiveProjection.history
  );
  const history = await projectedToolHistory(
    options,
    session,
    reasoningSafeHistory,
    session.durable.state.contextArchive?.sourceDigest
  );
  return { history, archiveProjection };
}

async function applyProjectedResourceBoundary(
  options: EffectRunnerOptions,
  session: RuntimeSession,
  preparation: TurnPreparationInput,
  available: BudgetAmounts,
  initial: BudgetedModelTurn
): Promise<BudgetedModelTurn> {
  const prepareBoundaryTurn = async (
    stage: ModelTurnBoundaryStage
  ): Promise<BudgetedModelTurn> => {
    const projection = await projectedModelHistory(options, session);
    return await prepareBudgetedModelTurn({
      ...preparation,
      available,
      history: projection.history,
      archive: projection.archiveProjection.archive?.item,
      modelTurnBoundaryStage: stage
    });
  };
  let prepared = initial;
  let stage = projectedModelTurnBoundary(available, prepared.turn.budget);
  if (!stage) return prepared;
  prepared = await prepareBoundaryTurn(stage);
  if (stage === "tool_closure"
    && projectedModelTurnBoundary(available, prepared.turn.budget) === "final") {
    stage = "final";
    prepared = await prepareBoundaryTurn(stage);
  }
  return prepared;
}

async function prepareTerminalContextFallback(
  options: EffectRunnerOptions,
  session: RuntimeSession,
  preparation: TurnPreparationInput
): Promise<{ prepared: BudgetedModelTurn; available: BudgetAmounts } | undefined> {
  const available = availableOrchestratorBudget(session);
  const projection = await projectedModelHistory(options, session);
  try {
    const prepared = await prepareBudgetedModelTurn({
      ...preparation,
      // The ordinary turn has already failed its provider or aggregate input
      // boundary. Drop optional repository context and tool schemas, then use
      // at most one final text-only turn instead of failing without a reply.
      descriptors: [],
      dynamic: [],
      available,
      history: projection.history,
      archive: projection.archiveProjection.archive?.item,
      modelTurnBoundaryStage: "final"
    });
    return { prepared, available };
  } catch (error) {
    if (contextBudgetExhausted(error)) return undefined;
    throw error;
  }
}

async function prepareOrdinaryModelTurn(
  options: EffectRunnerOptions,
  session: RuntimeSession,
  preparation: TurnPreparationInput,
  projection: ProjectedModelHistory,
  available: BudgetAmounts,
  signal: AbortSignal,
  summarizer: ModelSummarizer
): Promise<{ prepared: BudgetedModelTurn; available: BudgetAmounts }> {
  let prepared = await prepareBudgetedModelTurn(preparation);
  ({ prepared, available } = await refreshContextArchive({
    session,
    preparation,
    initial: prepared,
    initialProjection: projection.archiveProjection,
    available,
    signal,
    summarizer,
    emit: options.emit
  }));
  prepared = await applyProjectedResourceBoundary(
    options, session, preparation, available, prepared
  );
  return { prepared, available };
}

async function fitPreparedModelTurn(
  options: EffectRunnerOptions,
  session: RuntimeSession,
  preparation: TurnPreparationInput,
  initial: BudgetedModelTurn,
  initialAvailable: BudgetAmounts,
  usedTerminalFallback: boolean
): Promise<PreparedModelAttempt> {
  let prepared = initial;
  let available = initialAvailable;
  let fittedBudget = fitPreparedBudget(
    prepared.turn.budget,
    available,
    Number.MAX_SAFE_INTEGER
  );
  if (!fittedBudget && !usedTerminalFallback) {
    const fallback = await prepareTerminalContextFallback(options, session, preparation);
    if (fallback) {
      prepared = fallback.prepared;
      available = fallback.available;
      fittedBudget = fitPreparedBudget(
        prepared.turn.budget,
        available,
        Number.MAX_SAFE_INTEGER
      );
    }
  }
  if (!fittedBudget) {
    return { failure: budgetFailure(
      "The hard resource ledger cannot fund another model request after bounded context compaction."
    ) };
  }
  return {
    turn: { ...prepared.turn, budget: fittedBudget },
    plan: prepared.plan
  };
}

export async function prepareModelAttempt(
  options: EffectRunnerOptions,
  repositoryContext: RepositoryContextProvider,
  summarizer: ModelSummarizer,
  session: RuntimeSession,
  turnId: number,
  signal: AbortSignal,
  hookContext: readonly ContextItem[]
): Promise<PreparedModelAttempt> {
  const modelDescriptors = options.runtime.tools.modelDescriptors?.()
    ?? options.runtime.tools.descriptors();
  const capabilities = sessionModelToolProjectionCapabilities(session);
  const descriptors = projectHarnessToolDescriptors(
    session,
    withReadBatchDescriptor(projectModelToolDescriptors(
      modelDescriptors.filter((item) =>
        isToolAllowed(item, session.durable.mode) && profileAllowsTool(session, item)),
      capabilities
    ))
  );
  const query = [...session.durable.state.messages].reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const dynamic = await repositoryContext.collect(
    session.identity.workspacePath,
    query,
    signal,
    {
      workspaceStateVersion:
        session.durable.state.mutationFrontier.currentStateDigest
    }
  );
  let available = availableOrchestratorBudget(session);
  if (!session.durable.frozenCustomization) {
    throw Object.assign(new Error(
      `Session '${session.identity.sessionId}' is missing its schema 1 customization bundle.`
    ), { code: "unsupported_schema_version" });
  }
  const projected = await projectedModelHistory(options, session);
  const preparation: TurnPreparationInput = {
    session,
    turnId,
    descriptors,
    capabilities,
    dynamic,
    hookContext,
    ledger: evidenceLedger(session),
    turnOnly: progressCheckpoints(session),
    available,
    defaultOutputReserveTokens: options.outputReserveTokens,
    history: projected.history,
    archive: projected.archiveProjection.archive?.item
  };
  let prepared: BudgetedModelTurn;
  let usedTerminalFallback = false;
  try {
    ({ prepared, available } = await prepareOrdinaryModelTurn(
      options, session, preparation, projected, available, signal, summarizer
    ));
  } catch (error) {
    if (!contextBudgetExhausted(error)) throw error;
    const fallback = await prepareTerminalContextFallback(options, session, preparation);
    if (!fallback) return contextBudgetFailure();
    prepared = fallback.prepared;
    available = fallback.available;
    usedTerminalFallback = true;
  }
  return await fitPreparedModelTurn(
    options, session, preparation, prepared, available, usedTerminalFallback
  );
}
