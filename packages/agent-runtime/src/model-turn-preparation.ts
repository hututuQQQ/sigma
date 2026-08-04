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
  sessionModelToolProjectionCapabilities,
  stableSessionModelToolProjectionCapabilities
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
    archiveSourceDigest
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

async function repositoryTurnContext(
  repositoryContext: RepositoryContextProvider,
  session: RuntimeSession,
  signal: AbortSignal
) {
  const query = [...session.durable.state.messages].reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const dynamic = await repositoryContext.collect(
    session.identity.workspacePath,
    query,
    signal,
    {
      workspaceStateVersion: session.durable.state.mutationFrontier.currentStateDigest,
      focusPaths: session.durable.state.mutationFrontier.changedPaths
    }
  );
  return {
    dynamic,
    capabilities: {
      ...sessionModelToolProjectionCapabilities(session),
      ...repositoryContext.toolCapabilities(session.identity.workspacePath)
    }
  };
}

async function applyProjectedResourceBoundary(
  options: EffectRunnerOptions,
  session: RuntimeSession,
  preparation: TurnPreparationInput,
  available: BudgetAmounts,
  initial: BudgetedModelTurn
): Promise<BudgetedModelTurn> {
  if (preparation.modelTurnBoundaryStage === "final") return initial;
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

export async function prepareModelAttempt(
  options: EffectRunnerOptions,
  repositoryContext: RepositoryContextProvider,
  summarizer: ModelSummarizer,
  session: RuntimeSession,
  turnId: number,
  signal: AbortSignal,
  hookContext: readonly ContextItem[],
  modelTurnBoundaryStage?: ModelTurnBoundaryStage
): Promise<PreparedModelAttempt> {
  const modelDescriptors = options.runtime.tools.modelDescriptors?.()
    ?? options.runtime.tools.descriptors();
  const { dynamic } = modelTurnBoundaryStage === "final"
    ? { dynamic: [] as ContextItem[] }
    : await repositoryTurnContext(repositoryContext, session, signal);
  const capabilities = stableSessionModelToolProjectionCapabilities(session);
  const descriptors = withReadBatchDescriptor(projectModelToolDescriptors(
    modelDescriptors.filter((item) =>
      isToolAllowed(item, session.durable.mode) && profileAllowsTool(session, item)),
    capabilities
  ));
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
    archive: projected.archiveProjection.archive?.item,
    ...(modelTurnBoundaryStage ? { modelTurnBoundaryStage } : {})
  };
  let prepared: BudgetedModelTurn;
  try {
    prepared = await prepareBudgetedModelTurn(preparation);
    ({ prepared, available } = await refreshContextArchive({
      session,
      preparation,
      initial: prepared,
      initialProjection: projected.archiveProjection,
      available,
      signal,
      summarizer,
      emit: options.emit
    }));
    prepared = await applyProjectedResourceBoundary(
      options, session, preparation, available, prepared
    );
  } catch (error) {
    if (!contextBudgetExhausted(error)) throw error;
    return contextBudgetFailure();
  }
  const fittedBudget = fitPreparedBudget(
    prepared.turn.budget,
    available,
    Number.MAX_SAFE_INTEGER
  );
  if (!fittedBudget) {
    return {
      failure: budgetFailure(
        "The hard resource ledger cannot fund another model request after bounded context compaction."
      )
    };
  }
  return {
    turn: { ...prepared.turn, budget: fittedBudget },
    plan: prepared.plan
  };
}
