import type { ContextItem, ModelMessage, RunOutcome } from "agent-protocol";
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
import { deadlineForecast, type DeadlineForecast } from "./convergence-policy.js";
import { sessionSkillProjectionCapabilities } from "./effect-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import {
  budgetFailure,
  fitPreparedBudget,
  prepareBudgetedModelTurn,
  type PreparedModelTurn,
  type TurnPreparationInput
} from "./model-budget-convergence.js";
import { availableOrchestratorBudget } from "./assurance-budget.js";
import { evidenceLedger } from "./model-evidence-ledger.js";
import type { ModelSummarizer } from "./model-summarizer.js";
import { profileAllowsTool } from "./profile-policy.js";
import { progressCheckpoints } from "./progress-checkpoint.js";
import type { RuntimeSession } from "./types.js";

export interface PreparedModelAttempt {
  turn?: PreparedModelTurn;
  plan?: ContextPlan;
  forecast?: DeadlineForecast;
  failure?: RunOutcome;
}

interface ProjectedModelHistory {
  history: ModelMessage[];
  archiveProjection: ReturnType<typeof historyAfterArchive>;
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
  const descriptors = modelDescriptors.filter((item) =>
    isToolAllowed(item, session.durable.mode) && profileAllowsTool(session, item));
  const query = [...session.durable.state.messages].reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const dynamic = await repositoryContext.collect(
    session.identity.workspacePath, query, signal
  );
  const forecast = deadlineForecast(session);
  let available = availableOrchestratorBudget(session);
  const capabilities = sessionSkillProjectionCapabilities({
    frozenCustomization: session.durable.frozenCustomization,
    liveSkillDescriptors: options.runtime.skills?.descriptors,
    loadedSkills: session.durable.state.frozenSkills,
    profileSkillNames: session.services.profile?.profile.skills
  });
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
  let prepared = await prepareBudgetedModelTurn(preparation);
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
    plan: prepared.plan,
    forecast
  };
}
